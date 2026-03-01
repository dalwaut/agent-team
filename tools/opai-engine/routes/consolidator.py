"""OPAI Engine — Consolidator API endpoints.

Provides access to consolidation results, tacit knowledge, and manual triggers.
"""

from fastapi import APIRouter, Depends, HTTPException

import config
from auth import require_admin

router = APIRouter(prefix="/api/consolidator")

# Consolidator + heartbeat instances set by app.py during startup
_consolidator = None
_heartbeat = None


def set_consolidator(consolidator, heartbeat=None):
    global _consolidator, _heartbeat
    _consolidator = consolidator
    _heartbeat = heartbeat


def _get_consolidator():
    if _consolidator is None:
        raise HTTPException(503, "Consolidator not initialized")
    return _consolidator


@router.get("/latest")
def get_latest():
    """Return the most recent consolidation run summary."""
    return _get_consolidator().get_latest()


@router.get("/history")
def get_history():
    """Return last 30 extraction summaries."""
    return _get_consolidator().get_history()


@router.get("/tacit-knowledge")
def get_tacit_knowledge():
    """Return current tacit knowledge file content."""
    tk_file = config.TACIT_KNOWLEDGE_FILE
    if not tk_file.is_file():
        return {"content": None, "message": "Tacit knowledge file not yet created"}
    return {
        "content": tk_file.read_text(),
        "size": tk_file.stat().st_size,
        "path": str(tk_file),
    }


@router.post("/trigger", dependencies=[Depends(require_admin)])
async def trigger_consolidation():
    """Force an immediate consolidation run (admin only)."""
    consolidator = _get_consolidator()
    if _heartbeat is None:
        raise HTTPException(503, "Heartbeat not initialized")
    result = await consolidator.trigger(_heartbeat)
    return result
