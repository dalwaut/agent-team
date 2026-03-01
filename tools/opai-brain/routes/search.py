"""2nd Brain — Search routes."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, Query

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config

log = logging.getLogger("brain.routes.search")
router = APIRouter()


def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


@router.get("/api/search")
async def search_nodes(
    q: str = Query(..., min_length=1),
    mode: str = Query("full", pattern="^(full|hybrid)$"),
    limit: int = Query(20, le=100),
    user: AuthUser = Depends(get_current_user),
):
    """
    Full-text search over brain_nodes.

    mode=full   — PostgreSQL tsvector full-text search (Phase 1)
    mode=hybrid — full-text + vector similarity (Phase 2, returns full results for now)
    """
    # Use Supabase full-text search via PostgREST
    # fts_vector @@ websearch_to_tsquery('english', q)
    params = (
        f"user_id=eq.{user.id}"
        f"&fts_vector=wfts.{q}"
        f"&select=id,type,title,content,metadata,created_at,updated_at"
        f"&limit={limit}"
        f"&order=updated_at.desc"
    )

    url = f"{config.SUPABASE_URL}/rest/v1/brain_nodes?{params}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_svc_headers())
        if r.status_code != 200:
            log.warning("FTS search failed: %s %s", r.status_code, r.text)
            return {"results": [], "query": q, "mode": mode}
        results = r.json()

    # Attach tags
    if results:
        node_ids = ",".join(n["id"] for n in results)
        tags_url = f"{config.SUPABASE_URL}/rest/v1/brain_tags?node_id=in.({node_ids})"
        async with httpx.AsyncClient(timeout=10) as c:
            tr = await c.get(tags_url, headers=_svc_headers())
            tags_rows = tr.json() if tr.status_code == 200 else []
        tags_map: dict[str, list[str]] = {}
        for t in tags_rows:
            tags_map.setdefault(t["node_id"], []).append(t["tag"])
        for n in results:
            n["tags"] = tags_map.get(n["id"], [])

    return {"results": results, "query": q, "mode": mode, "total": len(results)}
