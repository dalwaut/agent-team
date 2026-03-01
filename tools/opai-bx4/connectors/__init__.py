"""Bx4 — Connector registry."""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger("bx4.connectors")

CONNECTORS = {
    "manual": "Manual CSV/Entry",
    "stripe": "Stripe",
    "quickbooks": "QuickBooks",
    "xero": "Xero",
    "paypal": "PayPal",
    "google_analytics": "Google Analytics",
    "meta": "Meta Business Suite",
    "twitter": "X / Twitter",
    "linkedin": "LinkedIn",
    "plaid": "Plaid (Advanced)",
}

CONNECTOR_TIERS = {
    "manual": 0,
    "stripe": 1,
    "google_analytics": 1,
    "quickbooks": 2,
    "xero": 2,
    "paypal": 2,
    "meta": 2,
    "twitter": 2,
    "linkedin": 2,
    "plaid": 3,
}


def _headers(service_key: str) -> dict:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


async def get_connector_status(
    company_id: str, supabase_url: str, service_key: str,
) -> list[dict]:
    """Fetch financial + social accounts and merge with connector registry.

    Returns a full status list with tier, connected, last_sync_at for each connector.
    """
    headers = _headers(service_key)

    # Fetch financial accounts
    fin_url = (
        f"{supabase_url}/rest/v1/bx4_financial_accounts"
        f"?company_id=eq.{company_id}&select=provider,last_sync_at,is_active"
    )
    # Fetch social accounts
    soc_url = (
        f"{supabase_url}/rest/v1/bx4_social_accounts"
        f"?company_id=eq.{company_id}&select=platform,last_sync_at,is_active"
    )

    async with httpx.AsyncClient(timeout=10) as c:
        fin_resp = await c.get(fin_url, headers=headers)
        fin_resp.raise_for_status()
        fin_accounts = fin_resp.json()

        soc_resp = await c.get(soc_url, headers=headers)
        soc_resp.raise_for_status()
        soc_accounts = soc_resp.json()

    # Build connected map
    connected_map: dict[str, dict] = {}
    for acc in fin_accounts:
        provider = acc.get("provider", "")
        if provider and acc.get("is_active", True):
            connected_map[provider] = {
                "last_sync_at": acc.get("last_sync_at"),
                "connected": True,
            }
    for acc in soc_accounts:
        platform = acc.get("platform", "")
        if platform and acc.get("is_active", True):
            connected_map[platform] = {
                "last_sync_at": acc.get("last_sync_at"),
                "connected": True,
            }

    # Merge with registry
    result: list[dict] = []
    for slug, display_name in CONNECTORS.items():
        status = connected_map.get(slug, {})
        result.append({
            "slug": slug,
            "name": display_name,
            "tier": CONNECTOR_TIERS.get(slug, 0),
            "connected": status.get("connected", False),
            "last_sync_at": status.get("last_sync_at"),
        })

    return result
