"""OPAI Studio — Supabase REST API helpers (async httpx)."""

import logging
import httpx
import config

log = logging.getLogger("studio.supabase")


def _headers(token=None):
    headers = {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def sb_get(path, token=None):
    """GET from Supabase REST. path includes table + query string."""
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=_headers(token),
        )
        r.raise_for_status()
        return r.json()


async def sb_post(path, data, token=None):
    """POST to Supabase REST. Returns created row."""
    headers = _headers(token)
    headers["Prefer"] = "return=representation"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=headers,
            json=data,
        )
        if not r.is_success:
            log.error("POST %s → %d: %s", path, r.status_code, r.text[:300])
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else rows


async def sb_patch(path, data, token=None):
    """PATCH Supabase REST. path should include filters."""
    headers = _headers(token)
    headers["Prefer"] = "return=representation"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.patch(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=headers,
            json=data,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else rows


async def sb_delete(path, token=None):
    """DELETE from Supabase REST. path should include filters."""
    headers = _headers(token)
    headers["Prefer"] = "return=minimal"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.delete(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=headers,
        )
        r.raise_for_status()
