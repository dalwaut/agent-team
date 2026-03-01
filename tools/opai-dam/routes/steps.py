"""DAM Bot — Step routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from core.supabase import sb_get
from core.pipeline import run_pipeline, resume_pipeline

log = logging.getLogger("dam.routes.steps")
router = APIRouter(prefix="/api/steps")


@router.get("/{session_id}")
async def list_steps(session_id: str):
    """List all steps for a session's active plan."""
    plans = await sb_get(
        f"dam_plans?session_id=eq.{session_id}&is_active=eq.true&select=id"
    )
    if not plans:
        raise HTTPException(404, "No active plan")

    plan_id = plans[0]["id"]
    steps = await sb_get(
        f"dam_steps?plan_id=eq.{plan_id}&select=*&order=ordinal.asc"
    )
    return {"steps": steps}


@router.get("/detail/{step_id}")
async def get_step(step_id: str):
    """Get a single step with full details."""
    rows = await sb_get(f"dam_steps?id=eq.{step_id}&select=*")
    if not rows:
        raise HTTPException(404, "Step not found")
    return rows[0]


@router.post("/{session_id}/execute")
async def execute_pipeline(session_id: str):
    """Start or resume pipeline execution for a session."""
    sessions = await sb_get(f"dam_sessions?id=eq.{session_id}&select=status")
    if not sessions:
        raise HTTPException(404, "Session not found")

    status = sessions[0]["status"]

    if status == "paused":
        result = await resume_pipeline(session_id)
    elif status in ("draft", "planning", "failed"):
        result = await run_pipeline(session_id)
    elif status == "executing":
        raise HTTPException(409, "Pipeline is already executing")
    elif status == "completed":
        raise HTTPException(409, "Session already completed")
    else:
        raise HTTPException(400, f"Cannot execute from status: {status}")

    return result
