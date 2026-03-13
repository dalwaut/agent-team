"""2nd Brain — Node CRUD routes."""
from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config

log = logging.getLogger("brain.routes.nodes")
router = APIRouter()


# ── Supabase helpers ──────────────────────────────────────────────────────────

def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_svc_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, body: dict) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else rows


async def _sb_patch(path: str, params: str, body: dict) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    async with httpx.AsyncClient(timeout=10) as c:
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

class NodeCreate(BaseModel):
    type: str = "note"
    title: str = ""
    content: str = ""
    metadata: dict = {}
    tags: list[str] = []


class NodeUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    type: Optional[str] = None
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/api/nodes")
async def list_nodes(
    type: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    limit: int = Query(100, le=500),
    offset: int = Query(0),
    user: AuthUser = Depends(get_current_user),
):
    """List nodes for the current user, optionally filtered by type or tag."""
    params = f"user_id=eq.{user.id}&order=updated_at.desc&limit={limit}&offset={offset}&select=id,type,title,content,metadata,created_at,updated_at"
    if type:
        params += f"&type=eq.{type}"

    nodes = await _sb_get("brain_nodes", params)

    # Attach tags for each node
    if nodes:
        node_ids = ",".join(n["id"] for n in nodes)
        tags_rows = await _sb_get("brain_tags", f"node_id=in.({node_ids})")
        tags_map: dict[str, list[str]] = {}
        for t in tags_rows:
            tags_map.setdefault(t["node_id"], []).append(t["tag"])
        for n in nodes:
            n["tags"] = tags_map.get(n["id"], [])

    if tag:
        nodes = [n for n in nodes if tag in n.get("tags", [])]

    return {"nodes": nodes, "total": len(nodes)}


@router.get("/api/nodes/{node_id}")
async def get_node(node_id: str, user: AuthUser = Depends(get_current_user)):
    """Get a single node by ID."""
    rows = await _sb_get(
        "brain_nodes",
        f"id=eq.{node_id}&user_id=eq.{user.id}&select=*",
    )
    if not rows:
        raise HTTPException(404, "Node not found")
    node = rows[0]
    tags_rows = await _sb_get("brain_tags", f"node_id=eq.{node_id}")
    node["tags"] = [t["tag"] for t in tags_rows]
    return node


@router.get("/api/nodes/{node_id}/original")
async def get_node_original(node_id: str, user: AuthUser = Depends(get_current_user)):
    """Read the original source file from disk using metadata.sync_source_path."""
    rows = await _sb_get(
        "brain_nodes",
        f"id=eq.{node_id}&user_id=eq.{user.id}&select=id,metadata",
    )
    if not rows:
        raise HTTPException(404, "Node not found")

    meta = rows[0].get("metadata") or {}
    source_path = meta.get("sync_source_path", "")
    if not source_path:
        raise HTTPException(404, "No source file linked to this node")

    # Resolve against workspace root
    workspace_root = Path(__file__).parent.parent.parent.parent
    full_path = (workspace_root / source_path).resolve()

    # Safety: ensure resolved path is under workspace
    if not str(full_path).startswith(str(workspace_root.resolve())):
        raise HTTPException(403, "Path traversal not allowed")

    if not full_path.exists():
        raise HTTPException(404, f"Source file not found: {source_path}")

    try:
        content = full_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(500, f"Failed to read file: {e}")

    return {
        "source_path": source_path,
        "filename": full_path.name,
        "content": content,
        "size": len(content),
    }


@router.post("/api/nodes")
async def create_node(body: NodeCreate, user: AuthUser = Depends(get_current_user)):
    """Create a new node."""
    row = await _sb_post("brain_nodes", {
        "user_id": user.id,
        "type": body.type,
        "title": body.title,
        "content": body.content,
        "metadata": body.metadata,
    })

    node_id = row.get("id")
    if body.tags and node_id:
        tag_rows = [{"node_id": node_id, "tag": t} for t in body.tags]
        try:
            await _sb_post("brain_tags", tag_rows)
        except Exception:
            pass

    row["tags"] = body.tags or []
    return row


@router.patch("/api/nodes/{node_id}")
async def update_node(
    node_id: str,
    body: NodeUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update a node. Only provided fields are changed."""
    # Verify ownership + capture old content for snapshot
    existing = await _sb_get("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}&select=id,content,metadata")
    if not existing:
        raise HTTPException(404, "Node not found")

    old_content: Optional[str] = existing[0].get("content") if existing else None

    patch: dict = {}
    if body.title is not None:
        patch["title"] = body.title
    if body.content is not None:
        patch["content"] = body.content
    if body.type is not None:
        patch["type"] = body.type
    if body.metadata is not None:
        # Merge incoming metadata with existing — never replace whole object
        # (preserves canvas_x/y when block editor sends {blocks:[...]}, etc.)
        existing_meta = existing[0].get("metadata") or {} if existing else {}
        patch["metadata"] = {**existing_meta, **body.metadata}

    row: dict = {}
    if patch:
        row = await _sb_patch("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}", patch)

    # Write snapshot of old content (fire-and-forget — never fail the save)
    if body.content is not None and old_content is not None and old_content.strip():
        try:
            from routes.snapshots import write_snapshot
            asyncio.create_task(write_snapshot(node_id, old_content))
        except Exception:
            pass

    if body.tags is not None:
        # Replace all tags: delete then insert
        await _sb_delete("brain_tags", f"node_id=eq.{node_id}")
        if body.tags:
            tag_rows = [{"node_id": node_id, "tag": t} for t in body.tags]
            try:
                await _sb_post("brain_tags", tag_rows)
            except Exception:
                pass
        row["tags"] = body.tags
    else:
        tags_rows = await _sb_get("brain_tags", f"node_id=eq.{node_id}")
        row["tags"] = [t["tag"] for t in tags_rows]

    return row


@router.delete("/api/nodes/{node_id}")
async def delete_node(node_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete a node and its tags."""
    existing = await _sb_get("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}&select=id")
    if not existing:
        raise HTTPException(404, "Node not found")
    await _sb_delete("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}")
    return {"deleted": node_id}
