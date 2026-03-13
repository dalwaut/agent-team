"""OPAI Engine — NFS Dispatcher API routes."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_admin

router = APIRouter(prefix="/api/nfs", tags=["nfs"])

_dispatcher = None


def set_dispatcher(dispatcher):
    global _dispatcher
    _dispatcher = dispatcher


class NfsDispatchRequest(BaseModel):
    worker_slug: str
    title: str
    description: str = ""
    priority: str = "normal"
    instructions: str = ""
    teamhub_item_id: str | None = None


@router.get("/status")
def nfs_status():
    """Return NFS dispatcher state."""
    if not _dispatcher:
        return {"error": "NFS dispatcher not initialized"}
    return _dispatcher.get_status()


@router.get("/history")
def nfs_history(limit: int = 50):
    """Return recent NFS collection history."""
    if not _dispatcher:
        return []
    return _dispatcher.get_history(limit)


@router.get("/workers")
def nfs_workers():
    """Return health status of all NFS workers."""
    if not _dispatcher:
        return {}
    return _dispatcher.get_worker_health()


@router.post("/dispatch", dependencies=[Depends(require_admin)])
async def nfs_dispatch(req: NfsDispatchRequest):
    """Dispatch a task to an NFS worker."""
    if not _dispatcher:
        raise HTTPException(503, "NFS dispatcher not initialized")

    task_context = {
        "id": f"nfs-manual-{__import__('time').time_ns() // 1_000_000}",
        "title": req.title,
        "description": req.description,
        "priority": req.priority,
        "instructions": req.instructions,
    }

    result = await _dispatcher.dispatch_to_nfs(
        req.worker_slug,
        req.teamhub_item_id,
        task_context,
    )

    if result.get("success"):
        return result
    raise HTTPException(400, result.get("error", "Dispatch failed"))
