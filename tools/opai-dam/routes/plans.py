"""DAM Bot — Plan management routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from core.planner import create_plan, revise_plan
from core.supabase import sb_get

log = logging.getLogger("dam.routes.plans")
router = APIRouter(prefix="/api/plans")


@router.get("/{session_id}")
async def get_plans(session_id: str):
    """Get all plan versions for a session."""
    rows = await sb_get(
        f"dam_plans?session_id=eq.{session_id}&select=*&order=version.desc"
    )
    return {"plans": rows}


@router.get("/{session_id}/active")
async def get_active_plan(session_id: str):
    """Get the active plan for a session."""
    rows = await sb_get(
        f"dam_plans?session_id=eq.{session_id}&is_active=eq.true&select=*"
    )
    if not rows:
        raise HTTPException(404, "No active plan")
    return rows[0]


@router.post("/{session_id}/generate")
async def generate_plan(session_id: str, request: Request):
    """Generate a new plan for a session using the planner engine."""
    body = await request.json() if await request.body() else {}

    # Load session goal + model preference
    sessions = await sb_get(f"dam_sessions?id=eq.{session_id}&select=goal,context,model_preference")
    if not sessions:
        raise HTTPException(404, "Session not found")

    goal = sessions[0]["goal"]
    context = body.get("context") or sessions[0].get("context")
    model_preference = sessions[0].get("model_preference", "auto")

    plan = await create_plan(session_id, goal, context, model_preference=model_preference)
    return plan


@router.post("/{session_id}/revise")
async def revise_plan_route(session_id: str, request: Request):
    """Revise the active plan based on user feedback."""
    body = await request.json()
    feedback = body.get("feedback", "").strip()
    if not feedback:
        raise HTTPException(400, "feedback is required")

    # Get active plan
    plans = await sb_get(
        f"dam_plans?session_id=eq.{session_id}&is_active=eq.true&select=id"
    )
    if not plans:
        raise HTTPException(404, "No active plan to revise")

    plan = await revise_plan(session_id, plans[0]["id"], feedback)
    return plan
