"""OPAI Engine — Feedback endpoints.

Migrated from TCP routes_api.py feedback section.
"""

from fastapi import APIRouter, Depends, Body, HTTPException

import services.task_processor as tp
from auth import require_admin

router = APIRouter(prefix="/api")


@router.get("/feedback")
def list_feedback():
    """Parse feedback files and return items with summary."""
    items = tp.parse_feedback_files()
    registry = tp.read_registry()
    summary = tp.get_feedback_summary(items, registry)
    return {"items": items, "summary": summary}


@router.post("/feedback/action", dependencies=[Depends(require_admin)])
def feedback_action(data: dict = Body(...)):
    """Execute a feedback action."""
    feedback_id = data.get("feedback_id")
    action = data.get("action")
    if not feedback_id or not action:
        raise HTTPException(400, "feedback_id and action required")

    result = tp.feedback_action(
        feedback_id=feedback_id,
        action=action,
        agent_id=data.get("agent_id"),
        squad=data.get("squad"),
        severity=data.get("severity"),
        context=data.get("context"),
    )
    if not result.get("success"):
        raise HTTPException(400, result.get("error", "Feedback action failed"))
    return result
