"""OPAI Engine — Worker management endpoints.

Provides API for listing, controlling, and monitoring workers.
Includes guardrails: approval gates, file access validation, rate limit info.

IMPORTANT: All fixed-path routes (/workers/health, /workers/guardrails,
/workers/approvals) MUST be defined BEFORE the parameterized /workers/{worker_id}
route, or FastAPI will match them as worker IDs.
"""

import asyncio

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from auth import require_admin
from services import guardrails

router = APIRouter(prefix="/api")

# WorkerManager instance set by app.py during startup
_manager = None


def set_manager(mgr):
    global _manager
    _manager = mgr


def _get_manager():
    if _manager is None:
        raise HTTPException(503, "Worker manager not initialized")
    return _manager


# ── List ───────────────────────────────────────────────────

@router.get("/workers")
def list_workers():
    """List all workers with status."""
    mgr = _get_manager()
    return mgr.get_status()


# ══════════════════════════════════════════════════════════
# Fixed-path routes (MUST come before {worker_id} param)
# ══════════════════════════════════════════════════════════

@router.get("/workers/health")
async def worker_health():
    """Run health checks on all long-running/hybrid workers."""
    mgr = _get_manager()
    results = await mgr.health_check_all()
    overall = "healthy" if all(r.get("healthy") for r in results.values()) else "degraded"
    return {"status": overall, "workers": results}


@router.get("/workers/guardrails")
def guardrails_summary():
    """Summary of all guardrails across workers."""
    mgr = _get_manager()
    return guardrails.get_guardrails_summary(mgr.workers)


@router.get("/workers/approvals")
def list_approvals():
    """List all pending approval requests."""
    return guardrails.get_pending_approvals()


@router.get("/workers/approvals/{request_id}")
def get_approval(request_id: str):
    """Get a specific approval request."""
    result = guardrails.get_approval(request_id)
    if not result:
        raise HTTPException(404, f"Approval request not found: {request_id}")
    return result


class ApprovalAction(BaseModel):
    reason: str = ""


@router.post(
    "/workers/approvals/{request_id}/approve",
    dependencies=[Depends(require_admin)],
)
def approve_request(request_id: str):
    """Approve a pending approval request."""
    result = guardrails.approve_request(request_id)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


@router.post(
    "/workers/approvals/{request_id}/deny",
    dependencies=[Depends(require_admin)],
)
def deny_request(request_id: str, req: ApprovalAction):
    """Deny a pending approval request."""
    result = guardrails.deny_request(request_id, reason=req.reason)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


# ══════════════════════════════════════════════════════════
# Parameterized routes (AFTER fixed paths)
# ══════════════════════════════════════════════════════════

@router.get("/workers/{worker_id}")
def get_worker(worker_id: str):
    """Get detailed info for a worker."""
    mgr = _get_manager()
    detail = mgr.get_worker_detail(worker_id)
    if not detail:
        raise HTTPException(404, f"Worker not found: {worker_id}")
    return detail


# ── Lifecycle Control ──────────────────────────────────────

@router.post("/workers/{worker_id}/start", dependencies=[Depends(require_admin)])
def start_worker(worker_id: str):
    """Start a long-running or hybrid worker."""
    mgr = _get_manager()
    result = mgr.start_worker(worker_id)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Failed to start"))
    return result


@router.post("/workers/{worker_id}/stop", dependencies=[Depends(require_admin)])
def stop_worker(worker_id: str):
    """Stop a running worker."""
    mgr = _get_manager()
    result = mgr.stop_worker(worker_id)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Failed to stop"))
    return result


@router.post("/workers/{worker_id}/restart", dependencies=[Depends(require_admin)])
def restart_worker(worker_id: str):
    """Restart a worker."""
    mgr = _get_manager()
    result = mgr.restart_worker(worker_id)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Failed to restart"))
    return result


# ── Task Workers ───────────────────────────────────────────

class RunTaskRequest(BaseModel):
    context: dict = {}


@router.post("/workers/{worker_id}/run", dependencies=[Depends(require_admin)])
async def run_task_worker(worker_id: str, req: RunTaskRequest, bg: BackgroundTasks):
    """Run a task worker (one-shot). Returns immediately, runs in background."""
    mgr = _get_manager()
    w = mgr.workers.get(worker_id)
    if not w:
        raise HTTPException(404, f"Worker not found: {worker_id}")
    if w.get("type") != "task":
        raise HTTPException(400, f"Worker {worker_id} is not a task worker (type={w.get('type')})")

    bg.add_task(_run_task_async, mgr, worker_id, req.context or None)
    return {"status": "started", "worker_id": worker_id}


async def _run_task_async(mgr, worker_id: str, context: dict = None):
    """Background wrapper for task worker execution."""
    await mgr.run_task_worker(worker_id, context)


# ── File Access Check ──────────────────────────────────────

class FileAccessRequest(BaseModel):
    path: str
    operation: str = "read"


@router.post("/workers/{worker_id}/check-access")
def check_file_access(worker_id: str, req: FileAccessRequest):
    """Check if a worker is allowed to access a file path."""
    mgr = _get_manager()
    w = mgr.workers.get(worker_id)
    if not w:
        raise HTTPException(404, f"Worker not found: {worker_id}")
    return guardrails.validate_file_access(worker_id, w, req.path, req.operation)


# ── Logs ───────────────────────────────────────────────────

@router.get("/workers/{worker_id}/logs")
def get_worker_logs(worker_id: str, lines: int = 50):
    """Get recent logs for a worker."""
    mgr = _get_manager()
    if worker_id not in mgr.workers:
        raise HTTPException(404, f"Worker not found: {worker_id}")
    logs = mgr.get_worker_logs(worker_id, min(lines, 500))
    return {"worker_id": worker_id, "lines": logs}
