"""2nd Brain — Canvas routes (Phase 3 + Phase 6).

Canvas positions are stored in brain_nodes.metadata as {canvas_x, canvas_y}.
brain_links stores directed edges between nodes.
Phase 6 additions: suggest-label endpoint, PATCH links/{id}.
"""
from __future__ import annotations

import logging
import math
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

sys.path.insert(0, str(Path(__file__).parent.parent))
from claude_cli import call_claude

import config

log = logging.getLogger("brain.routes.canvas")
router = APIRouter()

_GRID_COLS   = 5
_GRID_CELL_W = 220
_GRID_CELL_H = 120
_GRID_ORIGIN = (80, 80)


def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers=_svc_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, body) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else rows


async def _sb_patch(path: str, params: str, body: dict) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.patch(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else {}


async def _sb_delete(path: str, params: str) -> None:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.delete(url, headers={**_svc_headers(), "Prefer": "return=minimal"})
        r.raise_for_status()


# ── Models ────────────────────────────────────────────────────────────────────

class PositionUpdate(BaseModel):
    x: float
    y: float


class LinkCreate(BaseModel):
    source_id: str
    target_id: str
    label: Optional[str] = ""
    link_type: str = "canvas_edge"
    strength: Optional[float] = 1.0


class LinkUpdate(BaseModel):
    label: Optional[str] = None
    strength: Optional[float] = None


class SuggestLabelRequest(BaseModel):
    source_id: str
    target_id: str


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/api/canvas")
async def get_canvas(user: AuthUser = Depends(get_current_user)):
    """Return all non-inbox nodes + links, with canvas positions from metadata."""
    nodes = await _sb_get(
        "brain_nodes",
        f"user_id=eq.{user.id}&type=neq.inbox&select=id,type,title,metadata,updated_at&order=updated_at.desc&limit=500",
    )
    links = await _sb_get(
        "brain_links",
        f"user_id=eq.{user.id}&select=id,source_id,target_id,label,link_type,strength",
    )

    # Extract canvas positions from metadata; count unpositioned
    positioned = 0
    for n in nodes:
        meta = n.get("metadata") or {}
        if "canvas_x" in meta and "canvas_y" in meta:
            n["x"] = float(meta["canvas_x"])
            n["y"] = float(meta["canvas_y"])
            positioned += 1
        else:
            n["x"] = None
            n["y"] = None

    formatted_links = [
        {
            "id": lk["id"],
            "source": lk["source_id"],
            "target": lk["target_id"],
            "label": lk.get("label") or "",
            "type": lk.get("link_type") or "related",
            "strength": lk.get("strength") or 1.0,
        }
        for lk in links
    ]

    return {
        "nodes": nodes,
        "links": formatted_links,
        "total": len(nodes),
        "positioned": positioned,
    }


@router.patch("/api/canvas/nodes/{node_id}/position")
async def update_position(
    node_id: str,
    body: PositionUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Persist canvas x/y into brain_nodes.metadata (merged, not replaced)."""
    rows = await _sb_get("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}&select=id,metadata")
    if not rows:
        raise HTTPException(404, "Node not found")

    existing_meta = rows[0].get("metadata") or {}
    merged_meta = {**existing_meta, "canvas_x": body.x, "canvas_y": body.y}

    await _sb_patch("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}", {"metadata": merged_meta})
    return {"id": node_id, "x": body.x, "y": body.y}


@router.post("/api/canvas/auto-layout")
async def auto_layout(user: AuthUser = Depends(get_current_user)):
    """Assign grid positions to ALL nodes (resets canvas layout)."""
    nodes = await _sb_get(
        "brain_nodes",
        f"user_id=eq.{user.id}&type=neq.inbox&select=id,metadata&order=updated_at.desc&limit=500",
    )

    updates = []
    for idx, n in enumerate(nodes):
        col = idx % _GRID_COLS
        row = idx // _GRID_COLS
        x = _GRID_ORIGIN[0] + col * _GRID_CELL_W
        y = _GRID_ORIGIN[1] + row * _GRID_CELL_H
        existing_meta = n.get("metadata") or {}
        updates.append((n["id"], {**existing_meta, "canvas_x": x, "canvas_y": y}))

    # Batch update (sequential — PostgREST has no bulk PATCH with different values)
    for node_id, meta in updates:
        try:
            await _sb_patch("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}", {"metadata": meta})
        except Exception as e:
            log.warning("auto-layout: failed to update %s: %s", node_id, e)

    return {"updated": len(updates)}


@router.get("/api/canvas/links")
async def list_links(user: AuthUser = Depends(get_current_user)):
    """List all links for the user."""
    links = await _sb_get(
        "brain_links",
        f"user_id=eq.{user.id}&select=id,source_id,target_id,label,link_type,strength,created_at",
    )
    return {"links": links, "total": len(links)}


@router.post("/api/canvas/links")
async def create_link(body: LinkCreate, user: AuthUser = Depends(get_current_user)):
    """Create a link between two nodes."""
    if body.source_id == body.target_id:
        raise HTTPException(400, "Cannot link a node to itself")

    # Verify both nodes belong to user
    src = await _sb_get("brain_nodes", f"id=eq.{body.source_id}&user_id=eq.{user.id}&select=id")
    tgt = await _sb_get("brain_nodes", f"id=eq.{body.target_id}&user_id=eq.{user.id}&select=id")
    if not src:
        raise HTTPException(404, "Source node not found")
    if not tgt:
        raise HTTPException(404, "Target node not found")

    # Prevent duplicate edges
    existing = await _sb_get(
        "brain_links",
        f"user_id=eq.{user.id}&source_id=eq.{body.source_id}&target_id=eq.{body.target_id}&select=id",
    )
    if existing:
        return existing[0]

    link = await _sb_post("brain_links", {
        "user_id": user.id,
        "source_id": body.source_id,
        "target_id": body.target_id,
        "label": body.label or "",
        "link_type": body.link_type,
        "strength": 1.0,
        "created_by": "user",
    })
    return link


@router.patch("/api/canvas/links/{link_id}")
async def update_link(
    link_id: str, body: LinkUpdate, user: AuthUser = Depends(get_current_user)
):
    """Partially update a link's label and/or strength."""
    rows = await _sb_get("brain_links", f"id=eq.{link_id}&user_id=eq.{user.id}&select=id")
    if not rows:
        raise HTTPException(404, "Link not found")
    patch: dict = {}
    if body.label is not None:
        patch["label"] = body.label
    if body.strength is not None:
        patch["strength"] = max(0.0, min(1.0, body.strength))
    if not patch:
        return {}
    return await _sb_patch("brain_links", f"id=eq.{link_id}&user_id=eq.{user.id}", patch)


@router.delete("/api/canvas/links/{link_id}")
async def delete_link(link_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete a link."""
    rows = await _sb_get("brain_links", f"id=eq.{link_id}&user_id=eq.{user.id}&select=id")
    if not rows:
        raise HTTPException(404, "Link not found")
    await _sb_delete("brain_links", f"id=eq.{link_id}&user_id=eq.{user.id}")
    return {"deleted": link_id}


@router.post("/api/canvas/suggest-label")
async def suggest_label(body: SuggestLabelRequest, user: AuthUser = Depends(get_current_user)):
    """Use Claude to suggest a relationship label between two nodes (pro/ultimate/admin only)."""
    # Tier check
    tier_row = await _sb_get("profiles", f"id=eq.{user.id}&select=subscription_tier")
    tier = (tier_row[0].get("subscription_tier") or "starter") if tier_row else "starter"
    if tier not in ("pro", "ultimate", "admin"):
        raise HTTPException(403, "AI label suggestions require Pro or Ultimate plan")

    # Fetch both nodes
    src_rows = await _sb_get(
        "brain_nodes",
        f"id=eq.{body.source_id}&user_id=eq.{user.id}&select=title,content",
    )
    tgt_rows = await _sb_get(
        "brain_nodes",
        f"id=eq.{body.target_id}&user_id=eq.{user.id}&select=title,content",
    )
    if not src_rows:
        raise HTTPException(404, "Source node not found")
    if not tgt_rows:
        raise HTTPException(404, "Target node not found")

    src = src_rows[0]
    tgt = tgt_rows[0]

    prompt = (
        f'Node A: "{src["title"]}"\n'
        f'{(src.get("content") or "")[:500]}\n\n'
        f'Node B: "{tgt["title"]}"\n'
        f'{(tgt.get("content") or "")[:500]}\n\n'
        "What is the relationship from Node A to Node B? "
        "Reply with ONLY a concise 1-5 word label (e.g. 'supports', 'leads to', 'example of', 'contradicts'). "
        "No explanation, no punctuation."
    )

    try:
        label = await call_claude(prompt, model="claude-haiku-4-5-20251001", timeout=30)
    except RuntimeError as e:
        log.error("[canvas] claude_cli error: %s", e)
        raise HTTPException(503, "AI label suggestion failed — Claude CLI unavailable")
    return {"suggested_label": label.rstrip(".")}
