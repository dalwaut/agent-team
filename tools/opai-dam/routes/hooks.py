"""DAM Bot — Hook management routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from core.supabase import sb_get, sb_post, sb_patch

router = APIRouter(prefix="/api/hooks")


@router.get("")
async def list_hooks(hook_point: str | None = None):
    """List hooks, optionally filtered by hook_point."""
    query = "dam_hooks?select=*&order=priority.asc"
    if hook_point:
        query += f"&hook_point=eq.{hook_point}"
    rows = await sb_get(query)
    return {"hooks": rows}


@router.post("")
async def create_hook(request: Request):
    """Create a new hook (admin only)."""
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "name is required")

    row = await sb_post("dam_hooks", {
        "name": name,
        "description": body.get("description", ""),
        "hook_point": body.get("hook_point", "after_step"),
        "handler_type": body.get("handler_type", "python_func"),
        "handler_config": body.get("handler_config", {}),
        "priority": body.get("priority", 100),
        "conditions": body.get("conditions", {}),
        "enabled": body.get("enabled", True),
    })
    return row[0] if isinstance(row, list) else row


@router.patch("/{hook_id}")
async def update_hook(hook_id: str, request: Request):
    """Update a hook."""
    body = await request.json()
    allowed = {"name", "description", "hook_point", "handler_type", "handler_config",
               "priority", "conditions", "enabled"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No valid fields to update")

    result = await sb_patch(f"dam_hooks?id=eq.{hook_id}", updates)
    return result[0] if isinstance(result, list) and result else {"ok": True}
