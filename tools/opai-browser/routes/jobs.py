"""Browser job API endpoints."""

import sys
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional

# Shared auth
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import require_admin, AuthUser

from job_queue import queue

router = APIRouter(prefix="/api/jobs")


class JobSubmit(BaseModel):
    task: str
    session: str = "default"
    vision_ok: bool = False
    max_turns: int = None
    timeout_sec: int = None
    caller: str = None


@router.post("")
async def submit_job(body: JobSubmit, user: AuthUser = Depends(require_admin)):
    """Submit a new browser automation job."""
    if not body.task.strip():
        raise HTTPException(status_code=400, detail="Task cannot be empty")

    job = queue.submit(
        task=body.task,
        session=body.session,
        vision_ok=body.vision_ok,
        max_turns=body.max_turns,
        timeout_sec=body.timeout_sec,
        caller=body.caller or f"user:{user.id}",
    )
    return {"job": job.to_dict()}


@router.get("")
async def list_jobs(limit: int = 50, user: AuthUser = Depends(require_admin)):
    """List recent browser jobs."""
    return {"jobs": queue.list_jobs(limit=limit)}


@router.get("/{job_id}")
async def get_job(job_id: str, user: AuthUser = Depends(require_admin)):
    """Get a specific job's status and result."""
    job = queue.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    return {"job": job.to_dict()}


@router.delete("/{job_id}")
async def cancel_job(job_id: str, user: AuthUser = Depends(require_admin)):
    """Cancel a running or queued job."""
    success = queue.cancel(job_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found or not cancellable")
    return {"status": "cancelled", "job_id": job_id}
