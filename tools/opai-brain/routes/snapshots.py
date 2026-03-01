"""2nd Brain — Version snapshots routes."""
from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config

log = logging.getLogger("brain.routes.snapshots")
router = APIRouter()

MAX_SNAPSHOTS = 20


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


async def _sb_delete(path: str, params: str) -> None:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.delete(url, headers={**_svc_headers(), "Prefer": "return=minimal"})
        r.raise_for_status()


async def _verify_node_ownership(node_id: str, user_id: str) -> bool:
    rows = await _sb_get("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user_id}&select=id")
    return bool(rows)


async def write_snapshot(node_id: str, content: str) -> None:
    """Write a snapshot and prune oldest if over limit. Call as fire-and-forget."""
    try:
        await _sb_post("brain_snapshots", {"node_id": node_id, "content": content})
        # Prune: keep only MAX_SNAPSHOTS newest
        rows = await _sb_get(
            "brain_snapshots",
            f"node_id=eq.{node_id}&select=id&order=created_at.desc&limit=1000",
        )
        if len(rows) > MAX_SNAPSHOTS:
            old_ids = [r["id"] for r in rows[MAX_SNAPSHOTS:]]
            for oid in old_ids:
                await _sb_delete("brain_snapshots", f"id=eq.{oid}")
    except Exception as e:
        log.warning("snapshot write failed for %s: %s", node_id, e)


@router.get("/api/nodes/{node_id}/snapshots")
async def list_snapshots(node_id: str, user: AuthUser = Depends(get_current_user)):
    """List snapshots for a node (newest first, max 20)."""
    if not await _verify_node_ownership(node_id, user.id):
        raise HTTPException(404, "Node not found")
    rows = await _sb_get(
        "brain_snapshots",
        f"node_id=eq.{node_id}&select=id,created_at&order=created_at.desc&limit={MAX_SNAPSHOTS}",
    )
    return {"snapshots": rows}


@router.get("/api/nodes/{node_id}/snapshots/{snapshot_id}")
async def get_snapshot(
    node_id: str, snapshot_id: str, user: AuthUser = Depends(get_current_user)
):
    """Get a single snapshot's content."""
    if not await _verify_node_ownership(node_id, user.id):
        raise HTTPException(404, "Node not found")
    rows = await _sb_get(
        "brain_snapshots",
        f"id=eq.{snapshot_id}&node_id=eq.{node_id}&select=id,content,created_at",
    )
    if not rows:
        raise HTTPException(404, "Snapshot not found")
    return rows[0]


@router.delete("/api/nodes/{node_id}/snapshots/{snapshot_id}")
async def delete_snapshot(
    node_id: str, snapshot_id: str, user: AuthUser = Depends(get_current_user)
):
    """Delete a snapshot."""
    if not await _verify_node_ownership(node_id, user.id):
        raise HTTPException(404, "Node not found")
    rows = await _sb_get("brain_snapshots", f"id=eq.{snapshot_id}&node_id=eq.{node_id}&select=id")
    if not rows:
        raise HTTPException(404, "Snapshot not found")
    await _sb_delete("brain_snapshots", f"id=eq.{snapshot_id}&node_id=eq.{node_id}")
    return {"deleted": snapshot_id}
