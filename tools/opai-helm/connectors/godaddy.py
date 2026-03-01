"""HELM — Domain availability connector.

Primary: GoDaddy MCP server (https://api.godaddy.com/v1/domains/mcp)
         Called via the website_builder route using the MCP client when available.
Fallback: ICANN RDAP protocol (free, no auth, authoritative)

GoDaddy API credentials in .env are kept for future purchase/transfer API use.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

log = logging.getLogger("helm.connectors.godaddy")

# Standard domain pricing by TLD
_DEFAULT_PRICES = {
    "com": 14.99,
    "net": 12.99,
    "org": 12.99,
    "co":  29.99,
    "io":  39.99,
    "app": 19.99,
    "dev": 14.99,
}
_DEFAULT_PRICE = 14.99

# GoDaddy MCP endpoint
_MCP_URL = "https://api.godaddy.com/v1/domains/mcp"


async def check_availability(name: str, tld: str) -> dict:
    """Check domain availability.

    Tries GoDaddy MCP first (richer data + pricing), falls back to RDAP.

    Args:
        name: Domain name without TLD (e.g. "boutacare")
        tld:  TLD with or without leading dot (e.g. ".com" or "com")

    Returns:
        {
            "available": bool,
            "domain": "boutacare.com",
            "price": 14.99,
            "currency": "USD",
            "definitive": True,
            "source": "godaddy" | "rdap",
        }
    """
    tld_clean = tld.lstrip(".")
    fqdn = f"{name}.{tld_clean}"
    price = _DEFAULT_PRICES.get(tld_clean, _DEFAULT_PRICE)

    # ── Try GoDaddy MCP ───────────────────────────────────────────────────────
    api_key = os.getenv("GODADDY_API_KEY", "")
    api_secret = os.getenv("GODADDY_API_SECRET", "")
    if api_key and api_secret:
        try:
            result = await _check_via_godaddy(fqdn, api_key, api_secret)
            if result is not None:
                return result
        except Exception as exc:
            log.warning("GoDaddy MCP check failed for %s, falling back to RDAP: %s", fqdn, exc)

    # ── Fallback: ICANN RDAP ──────────────────────────────────────────────────
    return await _check_via_rdap(fqdn, price)


async def _check_via_godaddy(fqdn: str, api_key: str, api_secret: str) -> Optional[dict]:
    """Check availability via GoDaddy REST API with credentials."""
    tld_clean = fqdn.rsplit(".", 1)[-1]
    price = _DEFAULT_PRICES.get(tld_clean, _DEFAULT_PRICE)

    async with httpx.AsyncClient(timeout=8) as client:
        resp = await client.get(
            "https://api.godaddy.com/v1/domains/available",
            headers={
                "Authorization": f"sso-key {api_key}:{api_secret}",
                "Accept": "application/json",
            },
            params={"domain": fqdn, "checkType": "FAST"},
        )

    if resp.status_code in (401, 403):
        log.warning("GoDaddy ACCESS_DENIED for %s — credentials lack API access tier", fqdn)
        return None  # signal to fall back to RDAP

    resp.raise_for_status()
    data = resp.json()

    available = data.get("available", False)
    if available:
        raw_price = data.get("price", 0)
        price = round(raw_price / 1_000_000, 2) if raw_price else price

    return {
        "available": available,
        "domain": fqdn,
        "price": price if available else 0.0,
        "currency": data.get("currency", "USD"),
        "definitive": data.get("definitive", True),
        "source": "godaddy",
    }


async def _check_via_rdap(fqdn: str, price: float) -> dict:
    """Check availability via ICANN RDAP (no auth required)."""
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            resp = await client.get(f"https://rdap.org/domain/{fqdn}")

        if resp.status_code == 404:
            return {"available": True,  "domain": fqdn, "price": price, "currency": "USD", "definitive": True,  "source": "rdap"}
        elif resp.status_code == 200:
            return {"available": False, "domain": fqdn, "price": 0.0,  "currency": "USD", "definitive": True,  "source": "rdap"}
        else:
            return {"available": None,  "domain": fqdn, "price": price, "currency": "USD", "definitive": False, "source": "rdap"}

    except Exception as exc:
        log.error("RDAP check error for %s: %s", fqdn, exc)
        return {"available": None, "domain": fqdn, "price": price, "currency": "USD", "definitive": False, "source": "rdap"}


async def suggest_domains(query: str, tlds: Optional[list[str]] = None) -> list[dict]:
    """Check availability of query across common TLDs as suggestions."""
    if tlds is None:
        tlds = ["com", "net", "co", "io"]

    results = []
    for tld in tlds:
        result = await check_availability(query, tld)
        results.append(result)

    return results


def _split_fqdn(fqdn: str) -> tuple[str, str]:
    parts = fqdn.rsplit(".", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return fqdn, "com"


def get_client():
    """Stub — direct functions used instead of client pattern."""
    return None
