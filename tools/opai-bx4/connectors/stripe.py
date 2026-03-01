"""Bx4 — Stripe connector.

Supports three account types:
  internal   — OPAI's own Stripe account (STRIPE_SECRET_KEY from env, admin-only)
  additional — Admin-added external Stripe accounts (client businesses)
  user       — User-provided key for their own business (stored in credentials_ref)

Keys are stored in bx4_financial_accounts.credentials_ref.
Deduplication: external_id (Stripe balance_transaction ID) + company_id unique index.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta

import httpx

log = logging.getLogger("bx4.connectors.stripe")

STRIPE_API_BASE = "https://api.stripe.com/v1"


# ── Key Validation ─────────────────────────────────────────────────────────────

async def validate_stripe_key(api_key: str) -> dict:
    """Test a Stripe API key and return account info.

    Returns:
        {valid: bool, account_name: str, account_id: str, error: str | None}
    """
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                f"{STRIPE_API_BASE}/account",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if r.status_code == 401:
                return {"valid": False, "error": "Invalid API key — authentication failed"}
            if r.status_code == 403:
                return {"valid": False, "error": "Key exists but lacks required permissions (needs read access to balance_transactions)"}
            r.raise_for_status()
            data = r.json()
            return {
                "valid": True,
                "account_name": data.get("settings", {}).get("dashboard", {}).get("display_name")
                    or data.get("business_profile", {}).get("name")
                    or data.get("email", "Stripe Account"),
                "account_id": data.get("id", ""),
                "error": None,
            }
    except httpx.TimeoutException:
        return {"valid": False, "error": "Connection timed out — check your network"}
    except Exception as exc:
        return {"valid": False, "error": str(exc)}


async def get_stripe_balance(api_key: str) -> dict:
    """Fetch current Stripe balance (available + pending)."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                f"{STRIPE_API_BASE}/balance",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            r.raise_for_status()
            data = r.json()
            available = sum(b.get("amount", 0) for b in data.get("available", [])) / 100.0
            pending   = sum(b.get("amount", 0) for b in data.get("pending", [])) / 100.0
            return {"available": available, "pending": pending, "error": None}
    except Exception as exc:
        return {"available": 0, "pending": 0, "error": str(exc)}


# ── Transaction Sync ───────────────────────────────────────────────────────────

async def sync_stripe(
    company_id: str,
    account_id: str,
    stripe_api_key: str,
    supabase_url: str,
    service_key: str,
    days: int = 90,
) -> dict:
    """Sync Stripe balance transactions.

    Fetches the last `days` days of charge transactions, converts to
    bx4_transactions format, and upserts (skipping already-imported by external_id).

    Returns {synced_count, skipped_count, revenue_total, period, error}.
    """
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    since_ts = int(since.timestamp())

    stripe_headers = {"Authorization": f"Bearer {stripe_api_key}"}

    # ── Fetch from Stripe ────────────────────────────────────────────────────
    all_txns: list[dict] = []
    has_more = True
    starting_after: str | None = None

    try:
        async with httpx.AsyncClient(timeout=30) as c:
            while has_more:
                params: dict = {
                    "created[gte]": str(since_ts),
                    "limit": "100",
                }
                if starting_after:
                    params["starting_after"] = starting_after

                r = await c.get(
                    f"{STRIPE_API_BASE}/balance_transactions",
                    headers=stripe_headers,
                    params=params,
                )
                if r.status_code == 401:
                    return {"synced_count": 0, "skipped_count": 0, "revenue_total": 0,
                            "period": "", "error": "Invalid API key"}
                r.raise_for_status()
                data = r.json()

                txns = data.get("data", [])
                all_txns.extend(txns)
                has_more = data.get("has_more", False)
                if txns:
                    starting_after = txns[-1]["id"]
    except Exception as exc:
        log.error("Stripe fetch error for account %s: %s", account_id, exc)
        return {"synced_count": 0, "skipped_count": 0, "revenue_total": 0,
                "period": "", "error": str(exc)}

    if not all_txns:
        _update_last_sync(account_id, now.isoformat(), supabase_url, service_key)
        return {"synced_count": 0, "skipped_count": 0, "revenue_total": 0.0,
                "period": f"{since.strftime('%Y-%m-%d')} to {now.strftime('%Y-%m-%d')}",
                "error": None}

    # ── Fetch existing external_ids to deduplicate ───────────────────────────
    sb_headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    existing_ids: set[str] = set()
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{supabase_url}/rest/v1/bx4_transactions",
                headers=sb_headers,
                params={
                    "company_id": f"eq.{company_id}",
                    "source": "eq.stripe",
                    "select": "external_id",
                    "external_id": "not.is.null",
                },
            )
            if r.status_code == 200:
                for row in r.json():
                    if row.get("external_id"):
                        existing_ids.add(row["external_id"])
    except Exception as exc:
        log.warning("Could not fetch existing IDs (dedup skipped): %s", exc)

    # ── Build rows ───────────────────────────────────────────────────────────
    rows: list[dict] = []
    skipped = 0
    revenue_total = 0.0

    for txn in all_txns:
        ext_id = txn.get("id", "")
        if ext_id and ext_id in existing_ids:
            skipped += 1
            continue

        # Positive txn types = money in; negative = refunds/payouts out
        txn_type = txn.get("type", "")
        net_amount = txn.get("net", 0) / 100.0   # after Stripe fees

        # Classify revenue vs expense
        if txn_type in ("charge", "payment", "adjustment") and net_amount > 0:
            category = "revenue"
        elif txn_type in ("refund", "dispute"):
            category = "refund"
            net_amount = -abs(net_amount)  # ensure negative
        elif txn_type in ("payout", "transfer"):
            continue  # skip payouts — they're internal Stripe movements, not business income
        else:
            category = "stripe_other"

        created = datetime.fromtimestamp(txn.get("created", 0), tz=timezone.utc)
        desc = (txn.get("description") or "").strip() or f"Stripe {txn_type} {ext_id[:8]}"

        rows.append({
            "company_id": company_id,
            "account_id": account_id,
            "date": created.strftime("%Y-%m-%d"),
            "description": desc,
            "amount": round(net_amount, 2),
            "category": category,
            "subcategory": txn_type,
            "source": "stripe",
            "external_id": ext_id,
        })
        if net_amount > 0:
            revenue_total += net_amount

    # ── Upsert to Supabase ───────────────────────────────────────────────────
    inserted = 0
    if rows:
        async with httpx.AsyncClient(timeout=30) as c:
            batch_size = 100
            for i in range(0, len(rows), batch_size):
                batch = rows[i:i + batch_size]
                try:
                    r = await c.post(
                        f"{supabase_url}/rest/v1/bx4_transactions",
                        headers={**sb_headers, "Prefer": "return=minimal,resolution=ignore-duplicates"},
                        json=batch,
                    )
                    r.raise_for_status()
                    inserted += len(batch)
                except Exception as exc:
                    log.error("Batch insert error at offset %d: %s", i, exc)

    # ── Update last_sync_at ──────────────────────────────────────────────────
    _update_last_sync(account_id, now.isoformat(), supabase_url, service_key)

    return {
        "synced_count": inserted,
        "skipped_count": skipped,
        "revenue_total": round(revenue_total, 2),
        "period": f"{since.strftime('%Y-%m-%d')} to {now.strftime('%Y-%m-%d')}",
        "error": None,
    }


def _update_last_sync(account_id: str, now_iso: str, supabase_url: str, service_key: str) -> None:
    """Fire-and-forget update of last_sync_at (sync, not async — called from sync context)."""
    import requests  # stdlib-free alternative: use a background task instead
    try:
        requests.patch(
            f"{supabase_url}/rest/v1/bx4_financial_accounts?id=eq.{account_id}",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={"last_sync_at": now_iso, "status": "active"},
            timeout=5,
        )
    except Exception:
        pass
