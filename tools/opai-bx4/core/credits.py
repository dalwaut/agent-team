"""Bx4 — Credit tracking (logging only, billing inactive)."""

from __future__ import annotations

import logging

import httpx

import config

log = logging.getLogger("bx4.credits")


def _headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def log_credit_usage(
    company_id: str, user_id: str, action: str,
    supabase_url: str, service_key: str,
) -> None:
    """Log a credit usage event. Non-blocking -- catches all exceptions silently.

    Billing is inactive; balance_after is always 0.
    """
    try:
        cost = config.CREDIT_COSTS.get(action, 0)
        url = f"{supabase_url}/rest/v1/bx4_credit_transactions"
        payload = {
            "company_id": company_id,
            "user_id": user_id,
            "action": action,
            "credits_used": cost,
            "balance_after": 0,
        }
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(url, headers=headers, json=payload)
    except Exception:
        pass  # Non-blocking -- never fail the parent operation


async def get_usage_summary(
    company_id: str, supabase_url: str, service_key: str,
) -> dict:
    """Fetch credit transactions for company and return usage summary.

    Returns {total_credits_used, action_breakdown: {action: count}, recent: [last 10]}.
    """
    url = (
        f"{supabase_url}/rest/v1/bx4_credit_transactions"
        f"?company_id=eq.{company_id}&order=created_at.desc&select=*"
    )
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=headers)
        r.raise_for_status()
        rows = r.json()

    total = sum(row.get("credits_used", 0) for row in rows)
    breakdown: dict[str, int] = {}
    for row in rows:
        action = row.get("action", "unknown")
        breakdown[action] = breakdown.get(action, 0) + 1

    return {
        "total_credits_used": total,
        "action_breakdown": breakdown,
        "recent": rows[:10],
    }
