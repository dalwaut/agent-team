"""2nd Brain — Inbox routes (quick capture)."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config

log = logging.getLogger("brain.routes.inbox")
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
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_svc_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, body) -> dict:
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


class InboxCapture(BaseModel):
    content: str
    title: str = ""


class PromoteBody(BaseModel):
    title: str = ""
    type: str = "note"


@router.get("/api/inbox")
async def list_inbox(user: AuthUser = Depends(get_current_user)):
    """List all inbox items for the current user."""
    rows = await _sb_get(
        "brain_nodes",
        f"user_id=eq.{user.id}&type=eq.inbox&order=created_at.desc&select=id,title,content,metadata,created_at,updated_at",
    )
    return {"items": rows, "count": len(rows)}


@router.post("/api/inbox")
async def capture(body: InboxCapture, user: AuthUser = Depends(get_current_user)):
    """Quick-capture a new inbox item."""
    title = body.title or body.content[:80]
    row = await _sb_post("brain_nodes", {
        "user_id": user.id,
        "type": "inbox",
        "title": title,
        "content": body.content,
        "metadata": {},
    })
    return row


@router.patch("/api/inbox/{node_id}/process")
async def promote_to_note(
    node_id: str,
    body: PromoteBody,
    user: AuthUser = Depends(get_current_user),
):
    """Promote an inbox item to a note (or other type), moving it to the Library."""
    existing = await _sb_get("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}&type=eq.inbox&select=id,content")
    if not existing:
        raise HTTPException(404, "Inbox item not found")

    patch: dict = {"type": body.type}
    if body.title:
        patch["title"] = body.title

    row = await _sb_patch("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}", patch)
    return row


@router.delete("/api/inbox/{node_id}")
async def dismiss_inbox(node_id: str, user: AuthUser = Depends(get_current_user)):
    """Dismiss (delete) an inbox item."""
    existing = await _sb_get("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}&type=eq.inbox&select=id")
    if not existing:
        raise HTTPException(404, "Inbox item not found")
    await _sb_delete("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}")
    return {"deleted": node_id}
