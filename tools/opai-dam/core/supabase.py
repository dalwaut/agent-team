"""DAM Bot — Supabase REST API helpers (async httpx)."""

import httpx
import config


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
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=_headers(token),
        )
        r.raise_for_status()
        return r.json()


async def sb_post(path, data, token=None):
    headers = _headers(token)
    headers["Prefer"] = "return=representation"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=headers,
            json=data,
        )
        if not r.is_success:
            import logging
            logging.getLogger("dam.supabase").error(
                "POST %s -> %d: %s", path, r.status_code, r.text[:300],
            )
        r.raise_for_status()
        return r.json()


async def sb_patch(path, data, token=None):
    headers = _headers(token)
    headers["Prefer"] = "return=representation"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.patch(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=headers,
            json=data,
        )
        r.raise_for_status()
        return r.json()


async def sb_delete(path, token=None):
    headers = _headers(token)
    headers["Prefer"] = "return=minimal"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.delete(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=headers,
        )
        r.raise_for_status()


async def sb_rpc(fn_name, params=None, token=None):
    headers = _headers(token)
    headers["Prefer"] = "return=representation"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            f"{config.SUPABASE_URL}/rest/v1/rpc/{fn_name}",
            headers=headers,
            json=params or {},
        )
        r.raise_for_status()
        return r.json()
