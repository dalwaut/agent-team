"""Bx4 — CSV/spreadsheet P&L import connector."""

from __future__ import annotations

import csv
import io
import logging
from datetime import datetime

import httpx

log = logging.getLogger("bx4.connectors.csv_import")

# Common column name mappings (lowercase)
_DATE_COLUMNS = {"date", "transaction_date", "txn_date", "posted", "posted_date"}
_DESCRIPTION_COLUMNS = {"description", "memo", "name", "payee", "details", "note"}
_AMOUNT_COLUMNS = {"amount", "total", "value", "net", "sum"}
_CATEGORY_COLUMNS = {"category", "type", "account", "classification", "class"}


def _detect_columns(header: list[str]) -> dict[str, int | None]:
    """Auto-detect column indices from header row."""
    mapping: dict[str, int | None] = {
        "date": None,
        "description": None,
        "amount": None,
        "category": None,
    }
    lower_header = [h.strip().lower().replace(" ", "_") for h in header]

    for i, col in enumerate(lower_header):
        if col in _DATE_COLUMNS and mapping["date"] is None:
            mapping["date"] = i
        elif col in _DESCRIPTION_COLUMNS and mapping["description"] is None:
            mapping["description"] = i
        elif col in _AMOUNT_COLUMNS and mapping["amount"] is None:
            mapping["amount"] = i
        elif col in _CATEGORY_COLUMNS and mapping["category"] is None:
            mapping["category"] = i

    return mapping


def _parse_amount(value: str) -> float:
    """Parse a currency string to float. Handles $, commas, parens for negatives."""
    cleaned = value.strip().replace("$", "").replace(",", "").strip()
    if not cleaned:
        return 0.0
    # Handle parenthetical negatives: (500.00) -> -500.00
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = "-" + cleaned[1:-1]
    return float(cleaned)


def _parse_date(value: str) -> str:
    """Parse a date string to ISO format (YYYY-MM-DD)."""
    value = value.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%Y/%m/%d", "%m-%d-%Y"):
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # Return as-is if no format matches
    return value


def parse_pl_csv(content: bytes, filename: str) -> dict:
    """Parse CSV bytes into structured transaction data.

    Auto-detects columns (date, description, amount, category).
    Returns {rows: [...], period_start, period_end, summary: {revenue, expenses, net}}.

    For XLSX files, attempts openpyxl import; falls back to CSV parser with error message.
    """
    # Handle XLSX
    if filename.lower().endswith((".xlsx", ".xls")):
        try:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
            ws = wb.active
            csv_rows: list[list[str]] = []
            for row in ws.iter_rows(values_only=True):
                csv_rows.append([str(cell) if cell is not None else "" for cell in row])
            wb.close()
        except ImportError:
            log.warning("openpyxl not installed; cannot parse XLSX. Attempting CSV fallback.")
            csv_rows = list(csv.reader(io.StringIO(content.decode("utf-8", errors="replace"))))
        except Exception as exc:
            log.error("Failed to parse XLSX: %s", exc)
            return {"rows": [], "period_start": "", "period_end": "", "summary": {"revenue": 0, "expenses": 0, "net": 0}, "error": str(exc)}
    else:
        text = content.decode("utf-8", errors="replace")
        csv_rows = list(csv.reader(io.StringIO(text)))

    if len(csv_rows) < 2:
        return {"rows": [], "period_start": "", "period_end": "", "summary": {"revenue": 0, "expenses": 0, "net": 0}}

    header = csv_rows[0]
    col_map = _detect_columns(header)

    rows: list[dict] = []
    dates: list[str] = []

    for raw_row in csv_rows[1:]:
        if not any(cell.strip() for cell in raw_row):
            continue  # skip empty rows

        row: dict = {}

        # Date
        if col_map["date"] is not None and col_map["date"] < len(raw_row):
            row["date"] = _parse_date(raw_row[col_map["date"]])
            dates.append(row["date"])
        else:
            row["date"] = ""

        # Description
        if col_map["description"] is not None and col_map["description"] < len(raw_row):
            row["description"] = raw_row[col_map["description"]].strip()
        else:
            row["description"] = ""

        # Amount
        if col_map["amount"] is not None and col_map["amount"] < len(raw_row):
            try:
                row["amount"] = _parse_amount(raw_row[col_map["amount"]])
            except (ValueError, TypeError):
                continue  # skip unparseable rows
        else:
            continue  # skip rows without amount

        # Category
        if col_map["category"] is not None and col_map["category"] < len(raw_row):
            row["category"] = raw_row[col_map["category"]].strip()
        else:
            row["category"] = ""

        rows.append(row)

    # Compute summary
    revenue = sum(r["amount"] for r in rows if r["amount"] > 0)
    expenses = sum(r["amount"] for r in rows if r["amount"] < 0)
    net = revenue + expenses

    period_start = min(dates) if dates else ""
    period_end = max(dates) if dates else ""

    return {
        "rows": rows,
        "period_start": period_start,
        "period_end": period_end,
        "summary": {
            "revenue": round(revenue, 2),
            "expenses": round(expenses, 2),
            "net": round(net, 2),
        },
    }


async def import_transactions(
    company_id: str, account_id: str, rows: list[dict],
    supabase_url: str, service_key: str,
) -> int:
    """Bulk insert parsed transaction rows to bx4_transactions.

    Returns count of successfully inserted rows.
    """
    if not rows:
        return 0

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    # Build payloads
    payloads = []
    for row in rows:
        payloads.append({
            "company_id": company_id,
            "account_id": account_id,
            "date": row.get("date", ""),
            "description": row.get("description", ""),
            "amount": row.get("amount", 0),
            "category": row.get("category", ""),
            "source": "csv_import",
        })

    # Bulk insert in batches of 100
    inserted = 0
    batch_size = 100
    url = f"{supabase_url}/rest/v1/bx4_transactions"

    for i in range(0, len(payloads), batch_size):
        batch = payloads[i:i + batch_size]
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(url, headers=headers, json=batch)
                r.raise_for_status()
                inserted += len(batch)
        except Exception as exc:
            log.error("Failed to insert transaction batch %d: %s", i, exc)

    return inserted
