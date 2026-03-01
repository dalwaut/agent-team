"""OPAI Engine — Fleet Coordinator routes (v3.5).

Exposes fleet status, dispatch history, manual dispatch, and workspace stats.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/api/fleet", tags=["fleet"])

# Set by app.py at startup
_coordinator = None


def set_coordinator(coordinator):
    global _coordinator
    _coordinator = coordinator


class DispatchRequest(BaseModel):
    task_id: str
    worker_id: Optional[str] = None


@router.get("/status")
def fleet_status():
    """Active dispatches, queue depth, stats."""
    if not _coordinator:
        return {"error": "Fleet coordinator not initialized"}
    return _coordinator.get_status()


@router.get("/history")
def fleet_history(limit: int = 50):
    """Recent dispatch history (last 50)."""
    if not _coordinator:
        return {"history": [], "error": "Fleet coordinator not initialized"}
    return {"history": _coordinator.get_history(limit=limit)}


@router.post("/dispatch")
async def fleet_dispatch(req: DispatchRequest):
    """Manual dispatch: {task_id, worker_id?}."""
    if not _coordinator:
        return {"success": False, "error": "Fleet coordinator not initialized"}
    return await _coordinator.manual_dispatch(req.task_id, req.worker_id)


@router.post("/cancel/{dispatch_id}")
async def fleet_cancel(dispatch_id: str):
    """Cancel an active dispatch."""
    if not _coordinator:
        return {"success": False, "error": "Fleet coordinator not initialized"}
    return await _coordinator.cancel_dispatch(dispatch_id)


@router.get("/workspaces")
def fleet_workspaces():
    """Workspace stats (disk, active, history)."""
    from services.workspace_manager import get_workspace_stats
    return get_workspace_stats()
