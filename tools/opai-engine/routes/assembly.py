"""OPAI Engine — Assembly Line API routes (v3.7).

Exposes assembly pipeline management: start, resume, abort, gate approval, status.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional

from auth import require_admin

router = APIRouter(prefix="/api/assembly", tags=["assembly"])


# Set by app.py at startup
_pipeline = None


def set_pipeline(pipeline):
    global _pipeline
    _pipeline = pipeline


class StartRequest(BaseModel):
    input_type: str  # idea | prd | spec | task_id | project_id
    input_text: str
    input_ref: Optional[str] = None
    auto_ship: bool = False
    max_review_iterations: Optional[int] = None


class GateAction(BaseModel):
    action: str  # approve | reject


@router.post("/start", dependencies=[Depends(require_admin)])
async def assembly_start(req: StartRequest):
    """Start a new assembly run."""
    if not _pipeline:
        return {"success": False, "error": "Assembly pipeline not initialized"}

    if req.input_type not in ("idea", "prd", "spec", "task_id", "project_id"):
        return {"success": False, "error": f"Invalid input_type: {req.input_type}"}

    return _pipeline.create_run(
        input_type=req.input_type,
        input_text=req.input_text,
        input_ref=req.input_ref,
        auto_ship=req.auto_ship,
        max_review_iterations=req.max_review_iterations,
    )


@router.post("/resume/{run_id}", dependencies=[Depends(require_admin)])
async def assembly_resume(run_id: str):
    """Resume a paused run (re-enters the advance loop)."""
    if not _pipeline:
        return {"success": False, "error": "Assembly pipeline not initialized"}

    run = _pipeline.get_run(run_id)
    if not run:
        return {"success": False, "error": "Run not found"}

    if run.get("status") != "running":
        return {"success": False, "error": f"Run is {run.get('status')}, not resumable"}

    import asyncio
    task = asyncio.create_task(_pipeline._advance(run_id))
    _pipeline._active_tasks[run_id] = task
    return {"success": True, "run_id": run_id, "phase": run.get("current_phase")}


@router.post("/abort/{run_id}", dependencies=[Depends(require_admin)])
async def assembly_abort(run_id: str):
    """Abort a run."""
    if not _pipeline:
        return {"success": False, "error": "Assembly pipeline not initialized"}
    return _pipeline.abort_run(run_id)


@router.post("/gate/{run_id}/{gate}", dependencies=[Depends(require_admin)])
async def assembly_gate(run_id: str, gate: str, req: GateAction):
    """Approve or reject a gate (plan or ship)."""
    if not _pipeline:
        return {"success": False, "error": "Assembly pipeline not initialized"}

    if gate not in ("plan", "ship"):
        return {"success": False, "error": f"Unknown gate: {gate}"}

    if req.action == "approve":
        return _pipeline.approve_gate(run_id, gate)
    elif req.action == "reject":
        return _pipeline.reject_gate(run_id, gate)
    else:
        return {"success": False, "error": f"Unknown action: {req.action}"}


@router.get("/runs", dependencies=[Depends(require_admin)])
def assembly_runs(status: Optional[str] = None, limit: int = 50):
    """List assembly runs, optionally filtered by status."""
    if not _pipeline:
        return {"runs": [], "error": "Assembly pipeline not initialized"}
    return {"runs": _pipeline.get_runs(status=status, limit=limit)}


@router.get("/runs/{run_id}", dependencies=[Depends(require_admin)])
def assembly_run_detail(run_id: str):
    """Get detailed info for a specific run."""
    if not _pipeline:
        return {"error": "Assembly pipeline not initialized"}
    run = _pipeline.get_run(run_id)
    if not run:
        return {"error": "Run not found"}
    return run


@router.get("/stats", dependencies=[Depends(require_admin)])
def assembly_stats():
    """Pipeline statistics."""
    if not _pipeline:
        return {"error": "Assembly pipeline not initialized"}
    return _pipeline.get_stats()
