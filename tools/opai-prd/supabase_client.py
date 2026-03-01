"""OPAI PRD Pipeline — Supabase REST client helpers.

All server-side operations use the service key (bypasses RLS).
Only the /submit endpoint uses the user's JWT for attribution.
"""

import logging
import os
from typing import Optional

import httpx

log = logging.getLogger("opai-prd.supabase")

SUPABASE_URL        = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

TABLE = "prd_ideas"
BASE  = f"{SUPABASE_URL}/rest/v1/{TABLE}"


def _headers(extra: dict | None = None) -> dict:
    h = {
        "apikey":        SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
    }
    if extra:
        h.update(extra)
    return h


async def get_ideas(status_filter: Optional[str] = None) -> list:
    """Fetch all ideas, ordered newest first. Optionally filter by status."""
    params: dict = {"order": "submitted_at.desc", "limit": "500"}
    if status_filter:
        params["status"] = f"eq.{status_filter}"
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(BASE, params=params, headers=_headers())
        r.raise_for_status()
        return r.json()


async def get_idea(idea_id: str) -> Optional[dict]:
    """Fetch a single idea by id. Returns None if not found."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            BASE,
            params={"id": f"eq.{idea_id}", "limit": "1"},
            headers=_headers(),
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None


async def create_idea(idea: dict) -> dict:
    """Insert a new idea row. Returns the inserted row."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(BASE, json=idea, headers=_headers())
        r.raise_for_status()
        data = r.json()
        return data[0] if isinstance(data, list) else data


async def update_idea(idea_id: str, updates: dict) -> dict:
    """Patch an idea row by id. Returns the updated row."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.patch(
            BASE,
            params={"id": f"eq.{idea_id}"},
            json=updates,
            headers=_headers(),
        )
        r.raise_for_status()
        data = r.json()
        return data[0] if isinstance(data, list) else data


async def delete_idea(idea_id: str) -> bool:
    """Delete an idea by id. Returns True on success."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.delete(BASE, params={"id": f"eq.{idea_id}"}, headers=_headers())
        return r.status_code in (200, 204)


async def count_by_status() -> dict:
    """Return a count dict: {status: count} for all ideas."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            BASE,
            params={"select": "status"},
            headers={**_headers(), "Prefer": ""},
        )
        r.raise_for_status()
        rows = r.json()
    counts: dict = {}
    for row in rows:
        s = row.get("status", "unknown")
        counts[s] = counts.get(s, 0) + 1
    return counts
