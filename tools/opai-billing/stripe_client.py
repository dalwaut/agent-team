"""OPAI Billing — Stripe + Supabase client helpers."""

import httpx
import config


def _bb_headers():
    """Headers for BB2.0 Supabase (auth + billing)."""
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _bb_rest(path: str) -> str:
    """BB2.0 Supabase REST URL."""
    return f"{config.SUPABASE_URL}/rest/v1/{path}"


def _opai_headers():
    """Headers for OPAI Supabase (operational data)."""
    return {
        "apikey": config.OPAI_SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.OPAI_SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _opai_rest(path: str) -> str:
    """OPAI Supabase REST URL."""
    return f"{config.OPAI_SUPABASE_URL}/rest/v1/{path}"


async def bb_query(table: str, params: str = "", method: str = "GET", body=None):
    """Query BB2.0 Supabase REST API."""
    url = _bb_rest(f"{table}?{params}" if params else table)
    async with httpx.AsyncClient(timeout=15) as client:
        if method == "GET":
            resp = await client.get(url, headers=_bb_headers())
        elif method == "POST":
            resp = await client.post(url, headers=_bb_headers(), json=body)
        elif method == "PATCH":
            resp = await client.patch(url, headers=_bb_headers(), json=body)
        elif method == "DELETE":
            resp = await client.delete(url, headers=_bb_headers())
        else:
            raise ValueError(f"Unsupported method: {method}")
        resp.raise_for_status()
        if resp.status_code == 204:
            return []
        return resp.json()


async def bb_rpc(fn_name: str, body: dict):
    """Call BB2.0 Supabase RPC function."""
    url = f"{config.SUPABASE_URL}/rest/v1/rpc/{fn_name}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, headers=_bb_headers(), json=body)
        resp.raise_for_status()
        return resp.json()


async def bb_admin_create_user(email: str, password: str = None, metadata: dict = None):
    """Create a user via BB2.0 Supabase Auth admin API."""
    url = f"{config.SUPABASE_URL}/auth/v1/admin/users"
    body = {
        "email": email,
        "email_confirm": True,
    }
    if password:
        body["password"] = password
    if metadata:
        body["user_metadata"] = metadata
    headers = {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        return resp.json()


async def bb_admin_generate_link(email: str, link_type: str = "magiclink", metadata: dict = None):
    """Generate an auth link (invite, magiclink, etc.) via BB2.0 admin API."""
    url = f"{config.SUPABASE_URL}/auth/v1/admin/generate_link"
    body = {
        "type": link_type,
        "email": email,
    }
    if metadata:
        body["data"] = metadata
    headers = {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        return resp.json()
