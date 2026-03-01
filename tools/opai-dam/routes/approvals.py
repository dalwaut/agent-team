"""DAM Bot — Approval queue routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from core.supabase import sb_get
from core.approval_gate import resolve_approval

log = logging.getLogger("dam.routes.approvals")
router = APIRouter(prefix="/api/approvals")


@router.get("")
async def list_pending_approvals(session_id: str | None = None):
    """List pending approvals, optionally filtered by session."""
    query = "dam_approvals?status=eq.pending&select=*&order=created_at.desc"
    if session_id:
        query += f"&session_id=eq.{session_id}"
    rows = await sb_get(query)
    return {"approvals": rows}


@router.get("/all")
async def list_all_approvals(session_id: str | None = None, limit: int = 50):
    """List all approvals (any status)."""
    query = f"dam_approvals?select=*&order=created_at.desc&limit={limit}"
    if session_id:
        query += f"&session_id=eq.{session_id}"
    rows = await sb_get(query)
    return {"approvals": rows}


@router.post("/{approval_id}/approve")
async def approve(approval_id: str, request: Request):
    """Approve a pending approval."""
    body = await request.json() if await request.body() else {}
    user_id = body.get("user_id", "system")
    result = await resolve_approval(approval_id, approved=True, user_id=user_id)
    return result


@router.post("/{approval_id}/reject")
async def reject(approval_id: str, request: Request):
    """Reject a pending approval."""
    body = await request.json() if await request.body() else {}
    user_id = body.get("user_id", "system")
    result = await resolve_approval(approval_id, approved=False, user_id=user_id)
    return result
