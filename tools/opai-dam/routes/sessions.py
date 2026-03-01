"""DAM Bot — Session management routes."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import jwt
from fastapi import APIRouter, HTTPException, Request

from core.supabase import sb_get, sb_post, sb_patch, sb_delete

import config

log = logging.getLogger("dam.routes.sessions")
router = APIRouter(prefix="/api/sessions")


def _get_user_id(request: Request) -> str | None:
    """Extract user_id from Authorization header JWT."""
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
        try:
            payload = jwt.decode(token, config.SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated")
            return payload.get("sub")
        except Exception:
            pass
    return None


@router.get("")
async def list_sessions(request: Request, status: str | None = None, limit: int = 50):
    """List sessions for the current user."""
    query = f"dam_sessions?select=id,title,status,autonomy_level,model_preference,source,tags,created_at,updated_at&order=created_at.desc&limit={limit}"
    if status:
        query += f"&status=eq.{status}"
    rows = await sb_get(query)
    return {"sessions": rows}


@router.get("/{session_id}")
async def get_session(session_id: str):
    """Get full session details."""
    rows = await sb_get(f"dam_sessions?id=eq.{session_id}&select=*")
    if not rows:
        raise HTTPException(404, "Session not found")
    return rows[0]


@router.post("")
async def create_session(request: Request):
    """Create a new DAM session."""
    body = await request.json()
    title = body.get("title", "").strip()
    goal = body.get("goal", "").strip()

    if not title or not goal:
        raise HTTPException(400, "title and goal are required")

    user_id = _get_user_id(request) or body.get("user_id")
    if not user_id:
        # Fallback: use first admin user
        admins = await sb_get("profiles?role=eq.admin&select=id&limit=1")
        user_id = admins[0]["id"] if admins else None
    if not user_id:
        raise HTTPException(400, "Could not determine user_id")

    model_preference = body.get("model_preference", "auto")
    if model_preference not in ("auto", "haiku", "sonnet", "opus"):
        model_preference = "auto"

    row = await sb_post("dam_sessions", {
        "user_id": user_id,
        "title": title,
        "goal": goal,
        "status": "draft",
        "autonomy_level": body.get("autonomy_level", config.DEFAULT_AUTONOMY),
        "model_preference": model_preference,
        "context": body.get("context", {}),
        "source": body.get("source", "portal"),
        "source_ref": body.get("source_ref"),
        "tags": body.get("tags", []),
    })
    session = row[0] if isinstance(row, list) else row
    return session


@router.patch("/{session_id}")
async def update_session(session_id: str, request: Request):
    """Update session fields."""
    body = await request.json()
    allowed = {"title", "goal", "status", "autonomy_level", "model_preference", "context", "tags"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No valid fields to update")

    result = await sb_patch(f"dam_sessions?id=eq.{session_id}", updates)
    return result[0] if isinstance(result, list) and result else {"ok": True}


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    """Delete a session and all related data (cascades)."""
    await sb_delete(f"dam_sessions?id=eq.{session_id}")
    return {"ok": True}


@router.post("/{session_id}/cancel")
async def cancel_session(session_id: str):
    """Cancel a running/paused session."""
    result = await sb_patch(f"dam_sessions?id=eq.{session_id}", {"status": "cancelled"})
    return {"ok": True, "status": "cancelled"}
