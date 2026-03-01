"""HELM — Supabase REST API helpers (async httpx)."""

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


async def _sb_get(path, token=None):
    """GET from Supabase REST. path includes table + query string."""
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=_headers(token),
        )
        r.raise_for_status()
        return r.json()


async def _sb_post(path, data, token=None, upsert=False, on_conflict=None):
    """POST to Supabase REST. Returns created row(s).

    upsert=True: uses Prefer: resolution=merge-duplicates so retries never 409.
    on_conflict: comma-separated column name(s) for the upsert conflict target
                 (appended as ?on_conflict=col — required for tables without a
                  single PK or where Supabase needs a hint).
    """
    headers = _headers(token)
    if upsert:
        headers["Prefer"] = "resolution=merge-duplicates,return=representation"
    else:
        headers["Prefer"] = "return=representation"

    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    if upsert and on_conflict:
        url += f"?on_conflict={on_conflict}"

    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url, headers=headers, json=data)
        if not r.is_success:
            import logging
            logging.getLogger("helm.supabase").error(
                "POST %s → %d: %s | payload keys: %s",
                path, r.status_code, r.text[:300],
                list(data.keys()) if isinstance(data, dict) else type(data),
            )
        r.raise_for_status()
        return r.json()


async def _sb_patch(path, data, token=None):
    """PATCH Supabase REST. path should include filters (e.g. table?id=eq.xxx)."""
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


async def _sb_delete(path, token=None):
    """DELETE from Supabase REST. path should include filters."""
    headers = _headers(token)
    headers["Prefer"] = "return=minimal"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.delete(
            f"{config.SUPABASE_URL}/rest/v1/{path}",
            headers=headers,
        )
        r.raise_for_status()


async def _sb_rpc(fn_name, params=None, token=None):
    """Call a Postgres function via Supabase RPC."""
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
