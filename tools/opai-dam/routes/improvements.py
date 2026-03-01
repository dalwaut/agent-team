"""DAM Bot — Self-improvement request routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from core.supabase import sb_get, sb_post, sb_patch

router = APIRouter(prefix="/api/improvements")


@router.get("")
async def list_improvements(status: str | None = None, limit: int = 50):
    """List improvement requests."""
    query = f"dam_improvement_requests?select=*&order=created_at.desc&limit={limit}"
    if status:
        query += f"&implementation_status=eq.{status}"
    rows = await sb_get(query)
    return {"improvements": rows}


@router.get("/{improvement_id}")
async def get_improvement(improvement_id: str):
    rows = await sb_get(f"dam_improvement_requests?id=eq.{improvement_id}&select=*")
    if not rows:
        raise HTTPException(404, "Improvement request not found")
    return rows[0]


@router.post("")
async def create_improvement(request: Request):
    """Create a manual improvement request."""
    body = await request.json()
    title = body.get("title", "").strip()
    if not title:
        raise HTTPException(400, "title is required")

    row = await sb_post("dam_improvement_requests", {
        "trigger_type": body.get("trigger_type", "manual"),
        "title": title,
        "description": body.get("description", ""),
        "session_id": body.get("session_id"),
        "step_id": body.get("step_id"),
    })
    return row[0] if isinstance(row, list) else row


@router.patch("/{improvement_id}")
async def update_improvement(improvement_id: str, request: Request):
    """Update improvement status or add review notes."""
    body = await request.json()
    allowed = {"implementation_status", "review_notes", "research_result", "proposed_skill"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No valid fields to update")

    result = await sb_patch(f"dam_improvement_requests?id=eq.{improvement_id}", updates)
    return result[0] if isinstance(result, list) and result else {"ok": True}
