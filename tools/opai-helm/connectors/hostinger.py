"""HELM — Hostinger API connector.

Handles domain availability checking, pricing, and DNS zone management.

DNS API (confirmed working):
  GET/PUT/DELETE /api/dns/v1/zones/{domain}
  Used for automatic subdomain creation on boutabyte.cloud (sandbox staging)

Domain availability: /api/domains/v1/availability
Billing catalog:     /api/billing/v1/catalog
WordPress/shared hosting: NOT possible via API (hPanel UI only)

API docs: https://developers.hostinger.com
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

log = logging.getLogger("helm.connectors.hostinger")

_BASE_URL = "https://developers.hostinger.com"

# Default prices by TLD if catalog fetch fails
_DEFAULT_PRICES: dict[str, float] = {
    "com":  9.99,
    "net":  9.99,
    "org":  9.99,
    "co":   29.99,
    "io":   39.99,
    "app":  19.99,
    "dev":  14.99,
}
_DEFAULT_PRICE = 14.99

# Cached catalog data (in-process cache, refreshed on restart)
_catalog_cache: Optional[list[dict]] = None


def _api_key() -> str:
    return os.getenv("HOSTINGER_API_KEY", "")


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
    }


async def check_availability(name: str, tlds: list[str]) -> list[dict]:
    """Check domain availability across one or more TLDs via Hostinger API.

    Args:
        name: Domain name without TLD (e.g. "boutacare")
        tlds: List of TLDs without leading dot (e.g. ["com", "net"])

    Returns:
        List of dicts with: domain, available, price, currency, source
    """
    api_key = _api_key()
    if not api_key:
        log.warning("HOSTINGER_API_KEY not set — falling back to RDAP for availability")
        return await _check_via_rdap_multi(name, tlds)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{_BASE_URL}/api/domains/v1/availability",
                headers=_headers(),
                json={"domain": name, "tlds": tlds},
            )

        if resp.status_code == 200:
            data = resp.json()
            results = []
            for item in data:
                fqdn = item.get("domain", "")
                # Extract TLD from domain (e.g. "boutacare.co" → "co")
                tld = fqdn.rsplit(".", 1)[-1] if "." in fqdn else ""
                if not fqdn:
                    fqdn = f"{name}.{tld}"
                available = item.get("is_available", None)
                # Price from catalog item
                price = await _price_for_tld(tld)
                results.append({
                    "domain": fqdn,
                    "available": available,
                    "price": price if available else 0.0,
                    "currency": "USD",
                    "source": "hostinger",
                })
            return results

        log.warning(
            "Hostinger availability API returned %s — falling back to RDAP",
            resp.status_code,
        )
    except Exception as exc:
        log.warning("Hostinger availability check failed: %s — falling back to RDAP", exc)

    return await _check_via_rdap_multi(name, tlds)


async def get_domain_price(tld: str) -> float:
    """Return the first-year domain price for a TLD from Hostinger catalog."""
    return await _price_for_tld(tld.lstrip("."))


async def _price_for_tld(tld: str) -> float:
    """Look up first-year domain price from Hostinger billing catalog (cents → dollars)."""
    catalog = await _get_catalog()
    if catalog:
        tld_lower = tld.lower()
        # Catalog entry id format: "hostingercom-domain-com"
        # Match exactly to avoid substring collisions (e.g. "co" in "com.co")
        target_id = f"hostingercom-domain-{tld_lower}"
        for entry in catalog:
            if entry.get("id") == target_id:
                for price_obj in entry.get("prices", []):
                    # Use 1-year first_period_price (intro/promo rate)
                    if price_obj.get("period") == 1 and price_obj.get("period_unit") == "year":
                        first = price_obj.get("first_period_price", 0)
                        if first and first > 0:
                            return round(first / 100, 2)
    return _DEFAULT_PRICES.get(tld.lower(), _DEFAULT_PRICE)


async def _get_catalog() -> Optional[list[dict]]:
    """Fetch and cache the Hostinger billing catalog.

    Catalog structure: list of category objects, each with:
      {id, name, category, prices: [{id, name, price, first_period_price, period, period_unit, currency}]}
    Prices are in cents.
    """
    global _catalog_cache
    if _catalog_cache is not None:
        return _catalog_cache

    api_key = _api_key()
    if not api_key:
        return None

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{_BASE_URL}/api/billing/v1/catalog",
                headers=_headers(),
            )
        if resp.status_code == 200:
            _catalog_cache = resp.json()  # list of category objects
            log.info("Hostinger catalog loaded: %d categories", len(_catalog_cache))
            return _catalog_cache
    except Exception as exc:
        log.warning("Hostinger catalog fetch failed: %s", exc)

    return None


# ── DNS Zone Management ───────────────────────────────────────────────────────
# boutabyte.cloud is managed via Hostinger DNS API.
# Used for sandbox staging: auto-create {slug}.boutabyte.cloud → BB VPS IP

_BB_VPS_IP = "72.60.115.74"
_SANDBOX_ZONE = "boutabyte.cloud"


async def get_dns_zone(domain: str) -> list[dict]:
    """Return the current DNS records for a zone (e.g. 'boutabyte.cloud')."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_BASE_URL}/api/dns/v1/zones/{domain}",
            headers=_headers(),
        )
    resp.raise_for_status()
    data = resp.json()
    return data.get("zone", [])


async def create_subdomain(slug: str, ip: str = _BB_VPS_IP, zone: str = _SANDBOX_ZONE) -> str:
    """Create an A record for {slug}.{zone} pointing to {ip}.

    Returns the fully-qualified subdomain on success.
    Raises on failure.

    Uses PUT /api/dns/v1/zones/{zone} with the full zone array (Hostinger
    replaces the entire zone, so we read first then write).
    """
    api_key = _api_key()
    if not api_key:
        raise RuntimeError("HOSTINGER_API_KEY not set — cannot create DNS record")

    fqdn = f"{slug}.{zone}"

    # Read current zone
    current_records = await get_dns_zone(zone)

    # Check if record already exists
    for rec in current_records:
        if rec.get("name") == slug and rec.get("type") == "A":
            log.info("DNS record %s already exists", fqdn)
            return fqdn

    # Append new A record
    new_record = {
        "name": slug,
        "records": [{"value": ip, "disabled": False}],
        "ttl": 14400,
        "type": "A",
    }
    updated_zone = current_records + [new_record]

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.put(
            f"{_BASE_URL}/api/dns/v1/zones/{zone}",
            headers=_headers(),
            json={"zone": updated_zone},
        )
    resp.raise_for_status()
    log.info("DNS A record created: %s → %s", fqdn, ip)
    return fqdn


async def delete_subdomain(slug: str, zone: str = _SANDBOX_ZONE) -> None:
    """Remove an A record for {slug}.{zone}."""
    api_key = _api_key()
    if not api_key:
        raise RuntimeError("HOSTINGER_API_KEY not set")

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            f"{_BASE_URL}/api/dns/v1/zones/{zone}",
            headers=_headers(),
            json={"filters": [{"name": slug, "type": "A"}]},
        )
    resp.raise_for_status()
    log.info("DNS A record deleted: %s.%s", slug, zone)


async def _check_via_rdap_multi(name: str, tlds: list[str]) -> list[dict]:
    """Fallback: check availability via ICANN RDAP for multiple TLDs."""
    results = []
    for tld in tlds:
        fqdn = f"{name}.{tld}"
        price = _DEFAULT_PRICES.get(tld, _DEFAULT_PRICE)
        try:
            async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
                resp = await client.get(f"https://rdap.org/domain/{fqdn}")

            if resp.status_code == 404:
                available = True
            elif resp.status_code == 200:
                available = False
            else:
                available = None

            results.append({
                "domain": fqdn,
                "available": available,
                "price": price if available else 0.0,
                "currency": "USD",
                "source": "rdap",
            })
        except Exception as exc:
            log.error("RDAP check failed for %s: %s", fqdn, exc)
            results.append({
                "domain": fqdn,
                "available": None,
                "price": price,
                "currency": "USD",
                "source": "rdap",
            })
    return results
