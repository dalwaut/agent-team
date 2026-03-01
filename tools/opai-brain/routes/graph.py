"""2nd Brain — Graph route (nodes + links for visualization).

Graph positions are stored in brain_nodes.metadata as {graph_x, graph_y}.
Group is derived from metadata.sync_dir or "manual:<type>".
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config

log = logging.getLogger("brain.routes.graph")
router = APIRouter()


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


async def _sb_patch(path: str, params: str, body: dict) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.patch(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else {}


def _derive_group(meta: dict, node_type: str) -> str:
    """Derive a group name from metadata or node type."""
    sync_dir = meta.get("sync_dir", "")
    if sync_dir:
        # Use the top-level directory as the group name
        parts = sync_dir.strip("/").split("/")
        return parts[0] if parts else f"manual:{node_type}"
    return f"manual:{node_type}"


# ── Models ────────────────────────────────────────────────────────────────────

class PositionUpdate(BaseModel):
    x: float
    y: float


class BulkPositionItem(BaseModel):
    id: str
    x: float
    y: float


class BulkPositionUpdate(BaseModel):
    positions: List[BulkPositionItem]


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/api/graph")
async def get_graph(user: AuthUser = Depends(get_current_user)):
    """Return all nodes and links for the force-directed graph."""
    nodes = await _sb_get(
        "brain_nodes",
        f"user_id=eq.{user.id}&type=neq.inbox&select=id,type,title,metadata,updated_at&order=updated_at.desc&limit=500",
    )
    links = await _sb_get(
        "brain_links",
        f"user_id=eq.{user.id}&select=id,source_id,target_id,label,link_type,strength,created_by",
    )

    # Extract graph positions + group from metadata
    positioned = 0
    for n in nodes:
        meta = n.get("metadata") or {}
        if "graph_x" in meta and "graph_y" in meta:
            n["x"] = float(meta["graph_x"])
            n["y"] = float(meta["graph_y"])
            positioned += 1
        else:
            n["x"] = None
            n["y"] = None
        n["group"] = _derive_group(meta, n.get("type", "note"))

    # Format for D3 — source/target as IDs
    formatted_links = [
        {
            "id": lk["id"],
            "source": lk["source_id"],
            "target": lk["target_id"],
            "label": lk.get("label", ""),
            "type": lk.get("link_type", "related"),
            "strength": lk.get("strength", 1.0),
            "created_by": lk.get("created_by", "user"),
        }
        for lk in links
    ]

    return {
        "nodes": nodes,
        "links": formatted_links,
        "total": len(nodes),
        "positioned": positioned,
    }


@router.patch("/api/graph/nodes/{node_id}/position")
async def update_graph_position(
    node_id: str,
    body: PositionUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Persist graph x/y into brain_nodes.metadata (merged, not replaced)."""
    rows = await _sb_get("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}&select=id,metadata")
    if not rows:
        raise HTTPException(404, "Node not found")

    existing_meta = rows[0].get("metadata") or {}
    merged_meta = {**existing_meta, "graph_x": body.x, "graph_y": body.y}

    await _sb_patch("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}", {"metadata": merged_meta})
    return {"id": node_id, "x": body.x, "y": body.y}


@router.post("/api/graph/save-all-positions")
async def save_all_positions(
    body: BulkPositionUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Bulk-save graph positions for all nodes (Lock All)."""
    updated = 0
    for item in body.positions:
        try:
            rows = await _sb_get("brain_nodes", f"id=eq.{item.id}&user_id=eq.{user.id}&select=id,metadata")
            if not rows:
                continue
            existing_meta = rows[0].get("metadata") or {}
            merged_meta = {**existing_meta, "graph_x": item.x, "graph_y": item.y}
            await _sb_patch("brain_nodes", f"id=eq.{item.id}&user_id=eq.{user.id}", {"metadata": merged_meta})
            updated += 1
        except Exception as e:
            log.warning("save-all-positions: failed to update %s: %s", item.id, e)
    return {"updated": updated}


@router.post("/api/graph/reset-positions")
async def reset_positions(user: AuthUser = Depends(get_current_user)):
    """Clear all graph positions from metadata."""
    nodes = await _sb_get(
        "brain_nodes",
        f"user_id=eq.{user.id}&type=neq.inbox&select=id,metadata&limit=500",
    )
    cleared = 0
    for n in nodes:
        meta = n.get("metadata") or {}
        if "graph_x" not in meta and "graph_y" not in meta:
            continue
        cleaned = {k: v for k, v in meta.items() if k not in ("graph_x", "graph_y")}
        try:
            await _sb_patch("brain_nodes", f"id=eq.{n['id']}&user_id=eq.{user.id}", {"metadata": cleaned})
            cleared += 1
        except Exception as e:
            log.warning("reset-positions: failed to clear %s: %s", n["id"], e)
    return {"cleared": cleared}
