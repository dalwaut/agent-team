"""Bx4 — Financial API routes."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config
from core.budget_filter import compute_health_score
from connectors.csv_import import parse_pl_csv, import_transactions
from connectors.stripe import sync_stripe, validate_stripe_key, get_stripe_balance
from wings.financial import (
    get_snapshot, analyze as financial_analyze,
    compute_cashflow, forecast_cashflow, revenue_breakdown,
    expense_audit, scenario_model,
)

log = logging.getLogger("bx4.routes.financial")
router = APIRouter()


# ── Supabase helpers ──────────────────────────────────────────────────────────

def _headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, payload: dict, prefer: str = "return=representation") -> dict | list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(url, headers={**_headers(), "Prefer": prefer}, json=payload)
        r.raise_for_status()
        return {} if prefer == "return=minimal" else r.json()


async def _sb_patch(path: str, filter_str: str, payload: dict) -> None:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{filter_str}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.patch(url, headers={**_headers(), "Prefer": "return=minimal"}, json=payload)
        r.raise_for_status()


# ── Access check (inline) ────────────────────────────────────────────────────

async def _check_access(user: AuthUser, company_id: str) -> bool:
    if user.is_admin:
        return True
    rows = await _sb_get(
        "bx4_company_access",
        f"company_id=eq.{company_id}&user_id=eq.{user.id}&select=id",
    )
    return bool(rows)


# ── Request models ────────────────────────────────────────────────────────────

class SnapshotCreate(BaseModel):
    period: str
    revenue: float
    expenses: float
    net: Optional[float] = None
    cash_on_hand: Optional[float] = None
    burn_rate: Optional[float] = None
    runway_months: Optional[float] = None
    revenue_growth_rate: Optional[float] = None
    gross_margin: Optional[float] = None


class TransactionCreate(BaseModel):
    date: str
    description: str
    amount: float
    category: Optional[str] = ""
    account_id: Optional[str] = None


class AccountCreate(BaseModel):
    provider: str
    display_name: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/financial/snapshot")
async def get_latest_snapshot(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Get the latest financial snapshot."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    if not snap:
        return {"snapshot": None}

    if snap.get("health_score") is None:
        score, grade = compute_health_score(snap)
        snap["health_score"] = score
        snap["health_grade"] = grade

    return {"snapshot": snap}


@router.post("/api/companies/{company_id}/financial/snapshot")
async def create_snapshot(
    company_id: str, body: SnapshotCreate,
    user: AuthUser = Depends(get_current_user),
):
    """Create or update a financial snapshot (manual entry)."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    payload = body.model_dump()
    payload["company_id"] = company_id

    # Compute net if not provided
    if payload.get("net") is None:
        payload["net"] = payload["revenue"] + payload["expenses"]

    # Compute health score
    score, grade = compute_health_score(payload)
    payload["health_score"] = score
    payload["health_grade"] = grade

    result = await _sb_post("bx4_financial_snapshots", payload)
    snap = result[0] if isinstance(result, list) else result
    return {"snapshot": snap}


@router.get("/api/companies/{company_id}/financial/transactions")
async def list_transactions(
    company_id: str,
    offset: int = 0,
    limit: int = 50,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    user: AuthUser = Depends(get_current_user),
):
    """List transactions with pagination and date filters."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    params = f"company_id=eq.{company_id}&order=date.desc&offset={offset}&limit={limit}&select=*"
    if date_from:
        params += f"&date=gte.{date_from}"
    if date_to:
        params += f"&date=lte.{date_to}"

    return await _sb_get("bx4_transactions", params)


@router.post("/api/companies/{company_id}/financial/transactions")
async def add_transaction(
    company_id: str, body: TransactionCreate,
    user: AuthUser = Depends(get_current_user),
):
    """Add a single transaction."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    payload = {
        "company_id": company_id,
        "date": body.date,
        "description": body.description,
        "amount": body.amount,
        "category": body.category or "",
        "source": "manual",
    }
    if body.account_id:
        payload["account_id"] = body.account_id

    result = await _sb_post("bx4_transactions", payload)
    return result[0] if isinstance(result, list) else result


@router.post("/api/companies/{company_id}/financial/upload-pl")
async def upload_pl(
    company_id: str,
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    """Upload a P&L CSV/XLSX file. Parses, stores document record, imports transactions."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    content = await file.read()
    filename = file.filename or "upload.csv"

    # Parse the file
    parsed = parse_pl_csv(content, filename)
    if parsed.get("error"):
        raise HTTPException(400, f"Parse error: {parsed['error']}")

    rows = parsed.get("rows", [])
    if not rows:
        raise HTTPException(400, "No transactions found in file")

    # Store document record
    doc_payload = {
        "company_id": company_id,
        "filename": filename,
        "period_start": parsed.get("period_start", ""),
        "period_end": parsed.get("period_end", ""),
        "row_count": len(rows),
        "summary": parsed.get("summary", {}),
    }
    doc_result = await _sb_post("bx4_pl_documents", doc_payload)
    doc = doc_result[0] if isinstance(doc_result, list) else doc_result

    # Import transactions (use a default account_id or None)
    # Try to find or create a manual account
    accounts = await _sb_get(
        "bx4_financial_accounts",
        f"company_id=eq.{company_id}&provider=eq.manual&select=id",
    )
    if accounts:
        account_id = accounts[0]["id"]
    else:
        acc_result = await _sb_post("bx4_financial_accounts", {
            "company_id": company_id,
            "provider": "manual",
            "display_name": "Manual / CSV Import",
            "is_active": True,
        })
        acc = acc_result[0] if isinstance(acc_result, list) else acc_result
        account_id = acc.get("id", "")

    inserted = await import_transactions(
        company_id, account_id, rows,
        config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )

    return {
        "document": doc,
        "imported_count": inserted,
        "summary": parsed.get("summary", {}),
    }


@router.post("/api/companies/{company_id}/financial/analyze")
async def trigger_financial_analysis(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Trigger financial wing analysis. Returns recommendations."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Fetch company
    companies = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    if not companies:
        raise HTTPException(404, "Company not found")
    company = companies[0]

    # Fetch latest snapshot
    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    if not snap:
        raise HTTPException(400, "No financial snapshot available. Upload data first.")

    # Get active goal
    goals = await _sb_get(
        "bx4_company_goals",
        f"company_id=eq.{company_id}&status=eq.active&order=created_at.desc&limit=1&select=title",
    )
    goal = goals[0]["title"] if goals else None

    result = await financial_analyze(company, snap, goal)
    return result


@router.get("/api/companies/{company_id}/financial/accounts")
async def list_accounts(company_id: str, user: AuthUser = Depends(get_current_user)):
    """List financial accounts for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    return await _sb_get(
        "bx4_financial_accounts",
        f"company_id=eq.{company_id}&order=created_at.desc&select=*",
    )


@router.post("/api/companies/{company_id}/financial/accounts")
async def add_account(
    company_id: str, body: AccountCreate,
    user: AuthUser = Depends(get_current_user),
):
    """Add a financial account (provider, display_name)."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    result = await _sb_post("bx4_financial_accounts", {
        "company_id": company_id,
        "provider": body.provider,
        "display_name": body.display_name,
        "is_active": True,
    })
    return result[0] if isinstance(result, list) else result


@router.get("/api/companies/{company_id}/financial/health-score")
async def get_health_score(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Compute and return the current health score."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    if not snap:
        return {"health_score": None, "health_grade": None, "message": "No snapshot data available"}

    score, grade = compute_health_score(snap)
    return {"health_score": score, "health_grade": grade, "snapshot_period": snap.get("period")}


@router.delete("/api/companies/{company_id}/financial/accounts/{account_id}")
async def delete_account(
    company_id: str, account_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Disconnect / delete a financial account and its credentials."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Prevent deleting internal accounts by non-admins
    accounts = await _sb_get(
        "bx4_financial_accounts",
        f"id=eq.{account_id}&company_id=eq.{company_id}&select=is_internal",
    )
    if not accounts:
        raise HTTPException(404, "Account not found")
    if accounts[0].get("is_internal") and not user.is_admin:
        raise HTTPException(403, "Only admins can disconnect the internal Stripe account")

    url = f"{config.SUPABASE_URL}/rest/v1/bx4_financial_accounts?id=eq.{account_id}&company_id=eq.{company_id}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.delete(url, headers={**_headers(), "Prefer": "return=minimal"})
        r.raise_for_status()
    return {"deleted": True}


# ── Stripe: validate key ───────────────────────────────────────────────────────

class StripeValidateBody(BaseModel):
    api_key: str


@router.post("/api/companies/{company_id}/financial/stripe/validate-key")
async def stripe_validate(
    company_id: str, body: StripeValidateBody,
    user: AuthUser = Depends(get_current_user),
):
    """Validate a Stripe API key without saving it."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")
    return await validate_stripe_key(body.api_key.strip())


# ── Stripe: setup internal account (admin — uses env key) ────────────────────

@router.post("/api/companies/{company_id}/financial/stripe/setup-internal")
async def stripe_setup_internal(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Auto-connect the internal OPAI Stripe account (admin only).

    Uses STRIPE_SECRET_KEY from .env — no key entry required.
    Only one internal account allowed per company.
    """
    if not user.is_admin:
        raise HTTPException(403, "Admin only")

    if not config.STRIPE_SECRET_KEY:
        raise HTTPException(400, "STRIPE_SECRET_KEY not configured in environment")

    # Check if internal account already exists
    existing = await _sb_get(
        "bx4_financial_accounts",
        f"company_id=eq.{company_id}&provider=eq.stripe&is_internal=eq.true&select=id",
    )
    if existing:
        return {"account": existing[0], "message": "Internal Stripe account already connected"}

    # Validate the key first
    info = await validate_stripe_key(config.STRIPE_SECRET_KEY)
    if not info.get("valid"):
        raise HTTPException(400, f"Internal Stripe key invalid: {info.get('error')}")

    result = await _sb_post("bx4_financial_accounts", {
        "company_id": company_id,
        "provider": "stripe",
        "display_name": f"OPAI Internal — {info.get('account_name', 'Stripe')}",
        "account_label": "internal",
        "is_internal": True,
        "is_enabled": True,
        "status": "active",
        "credentials_ref": "__internal__",   # sentinel — key loaded from env at sync time
    })
    account = result[0] if isinstance(result, list) else result
    return {"account": account, "message": "Internal Stripe account connected"}


# ── Stripe: connect external account ─────────────────────────────────────────

class StripeConnectBody(BaseModel):
    api_key: str
    display_name: Optional[str] = None


@router.post("/api/companies/{company_id}/financial/stripe/connect")
async def stripe_connect(
    company_id: str, body: StripeConnectBody,
    user: AuthUser = Depends(get_current_user),
):
    """Connect a Stripe account using a user-provided API key.

    Validates the key, fetches account info, stores credentials_ref.
    Users must supply their own Stripe restricted key — Bx4 does not provide one.
    """
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    api_key = body.api_key.strip()
    if not api_key.startswith(("sk_", "rk_")):
        raise HTTPException(400, "Invalid key format — must be a Stripe secret (sk_) or restricted key (rk_)")

    info = await validate_stripe_key(api_key)
    if not info.get("valid"):
        raise HTTPException(400, f"Stripe key validation failed: {info.get('error')}")

    display_name = (body.display_name or "").strip() or info.get("account_name", "Stripe Account")

    result = await _sb_post("bx4_financial_accounts", {
        "company_id": company_id,
        "provider": "stripe",
        "display_name": display_name,
        "account_label": info.get("account_id", ""),
        "is_internal": False,
        "is_enabled": True,
        "status": "active",
        "credentials_ref": api_key,    # stored as-is; encrypted at rest in Supabase
    })
    account = result[0] if isinstance(result, list) else result
    # Don't return the key in the response
    account.pop("credentials_ref", None)
    return {"account": account, "stripe_account": info.get("account_name")}


# ── Stripe: sync account ───────────────────────────────────────────────────────

@router.post("/api/companies/{company_id}/financial/accounts/{account_id}/sync")
async def sync_account(
    company_id: str, account_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Trigger a sync for a connected financial account."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    accounts = await _sb_get(
        "bx4_financial_accounts",
        f"id=eq.{account_id}&company_id=eq.{company_id}&select=*",
    )
    if not accounts:
        raise HTTPException(404, "Account not found")

    acct = accounts[0]
    if acct.get("provider") != "stripe":
        raise HTTPException(400, f"Sync not yet supported for provider: {acct['provider']}")

    if not acct.get("is_enabled"):
        raise HTTPException(400, "Account is disabled")

    # Resolve API key
    if acct.get("credentials_ref") == "__internal__":
        if not user.is_admin:
            raise HTTPException(403, "Internal account sync requires admin")
        if not config.STRIPE_SECRET_KEY:
            raise HTTPException(400, "STRIPE_SECRET_KEY not set in environment")
        api_key = config.STRIPE_SECRET_KEY
    else:
        api_key = acct.get("credentials_ref", "")
        if not api_key:
            raise HTTPException(400, "No API key stored for this account — reconnect it")

    result = await sync_stripe(
        company_id=company_id,
        account_id=account_id,
        stripe_api_key=api_key,
        supabase_url=config.SUPABASE_URL,
        service_key=config.SUPABASE_SERVICE_KEY,
    )
    return result


# ── Stripe: balance ────────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/financial/accounts/{account_id}/balance")
async def get_account_balance(
    company_id: str, account_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Get live Stripe balance for a connected account."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    accounts = await _sb_get(
        "bx4_financial_accounts",
        f"id=eq.{account_id}&company_id=eq.{company_id}&select=credentials_ref,is_internal,provider",
    )
    if not accounts:
        raise HTTPException(404, "Account not found")

    acct = accounts[0]
    if acct.get("provider") != "stripe":
        raise HTTPException(400, "Balance only available for Stripe accounts")

    if acct.get("credentials_ref") == "__internal__":
        if not user.is_admin:
            raise HTTPException(403, "Admin only for internal account")
        api_key = config.STRIPE_SECRET_KEY
    else:
        api_key = acct.get("credentials_ref", "")

    return await get_stripe_balance(api_key)


# ── Cash Flow ─────────────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/financial/cashflow")
async def get_cashflow(
    company_id: str,
    days: int = 90,
    user: AuthUser = Depends(get_current_user),
):
    """Get cash flow data: 90-day actuals + 3 forecast bands (conservative/baseline/optimistic)."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    actuals = await compute_cashflow(
        company_id, days, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY
    )
    forecasts = forecast_cashflow(actuals)
    return {"actuals": actuals, "forecasts": forecasts, "days": days}


# ── Revenue Breakdown ─────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/financial/revenue-breakdown")
async def get_revenue_breakdown(
    company_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Revenue breakdown by category and source over the last 90 days."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    return await revenue_breakdown(
        company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY
    )


# ── Expense Audit ─────────────────────────────────────────────────────────────

@router.post("/api/companies/{company_id}/financial/expense-audit")
async def run_expense_audit(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Run an AI expense audit (fat-trim report). Returns savings opportunities."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    companies = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    if not companies:
        raise HTTPException(404, "Company not found")

    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    result = await expense_audit(
        companies[0], snap, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY
    )
    return result


# ── Scenario Modeler ──────────────────────────────────────────────────────────

class ScenarioBody(BaseModel):
    variable: str     # revenue | expenses | headcount | burn_rate
    change_pct: float  # e.g. -20 = 20% drop, +15 = 15% growth


@router.post("/api/companies/{company_id}/financial/scenario")
async def run_scenario(
    company_id: str, body: ScenarioBody,
    user: AuthUser = Depends(get_current_user),
):
    """What-if scenario modeling against the current financial snapshot."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    if not snap:
        raise HTTPException(400, "No snapshot data available")

    result = scenario_model(snap, body.variable, body.change_pct)
    return result


# ── Tax Estimate ──────────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/financial/tax-estimate")
async def get_tax_estimate(
    company_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Quarterly tax liability estimate derived from financial snapshots.

    Uses a simplified 25% effective tax rate on net income.
    For informational purposes only — not accounting advice.
    """
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Fetch last 12 snapshots ordered by period
    snapshots = await _sb_get(
        "bx4_financial_snapshots",
        f"company_id=eq.{company_id}&order=period_end.desc&limit=12&select=*",
    )

    if not snapshots:
        return {"quarters": [], "annual_net": 0, "annual_estimated_tax": 0, "rate": 0.25}

    # Group by quarter (period_end determines quarter)
    from collections import defaultdict
    import datetime as dt

    quarters: dict = defaultdict(lambda: {"net": 0.0, "months": 0})
    for snap in snapshots:
        period_end = snap.get("period_end") or snap.get("generated_at", "")[:10]
        try:
            d = dt.date.fromisoformat(period_end[:10])
            q = f"Q{(d.month - 1) // 3 + 1} {d.year}"
        except Exception:
            q = "Unknown"
        net = float(snap.get("net", 0) or 0)
        quarters[q]["net"] += net
        quarters[q]["months"] += 1

    rate = 0.25
    result_quarters = []
    annual_net = 0.0
    for q_label, q_data in sorted(quarters.items()):
        q_net = q_data["net"]
        taxable = max(0.0, q_net)
        est_tax = round(taxable * rate, 2)
        annual_net += q_net
        result_quarters.append({
            "quarter": q_label,
            "net_income": round(q_net, 2),
            "taxable_income": round(taxable, 2),
            "estimated_tax": est_tax,
        })

    return {
        "quarters": result_quarters,
        "annual_net": round(annual_net, 2),
        "annual_taxable": round(max(0, annual_net), 2),
        "annual_estimated_tax": round(max(0, annual_net) * rate, 2),
        "rate": rate,
        "disclaimer": "Estimated at 25% effective rate. Consult your accountant for accurate figures.",
    }
