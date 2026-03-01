"""2nd Brain — Library Sync API routes (admin-only).

POST /api/library-sync       — trigger sync (with dry_run option)
GET  /api/library-sync/status — check running/last result
GET  /api/library-sync/manifest — list discovered files without syncing
"""
from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

sys.path.insert(0, str(Path(__file__).parent.parent))
from library_sync_engine import discover_files, run_sync, SyncResult

log = logging.getLogger("brain.routes.library_sync")
router = APIRouter()

# ── In-memory sync state ────────────────────────────────────────────────────

_sync_running = False
_sync_last_result: Optional[dict] = None
_sync_started_at: Optional[str] = None


def _require_admin(user: AuthUser):
    if getattr(user, "role", None) != "admin":
        raise HTTPException(403, "Admin only")


# ── Request models ──────────────────────────────────────────────────────────

class SyncRequest(BaseModel):
    dry_run: bool = False


# ── Routes ──────────────────────────────────────────────────────────────────

@router.post("/api/library-sync")
async def trigger_sync(
    body: SyncRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Trigger a library sync. Runs in background unless dry_run=True."""
    _require_admin(user)
    global _sync_running, _sync_last_result, _sync_started_at

    if _sync_running:
        raise HTTPException(409, "Sync already in progress")

    if body.dry_run:
        # Dry run is fast — run inline
        result = await run_sync(dry_run=True)
        return {"status": "dry_run", "result": result.to_dict()}

    # Real sync — run in background
    _sync_running = True
    _sync_started_at = datetime.now(timezone.utc).isoformat()
    _sync_last_result = None

    async def _run():
        global _sync_running, _sync_last_result
        try:
            result = await run_sync(dry_run=False)
            _sync_last_result = {
                "status": "completed",
                "started_at": _sync_started_at,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                **result.to_dict(),
            }
        except Exception as e:
            log.error("[library_sync] Sync failed: %s", e)
            _sync_last_result = {
                "status": "failed",
                "started_at": _sync_started_at,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "error": str(e),
            }
        finally:
            _sync_running = False

    asyncio.create_task(_run())
    return {"status": "started", "started_at": _sync_started_at}


@router.get("/api/library-sync/status")
async def sync_status(user: AuthUser = Depends(get_current_user)):
    """Check if a sync is running and the last result."""
    _require_admin(user)
    return {
        "running": _sync_running,
        "started_at": _sync_started_at,
        "last_result": _sync_last_result,
    }


@router.get("/api/library-sync/manifest")
async def sync_manifest(user: AuthUser = Depends(get_current_user)):
    """List all files that would be synced, without actually syncing."""
    _require_admin(user)
    files = discover_files()
    manifest = [
        {
            "path": f["path"],
            "extension": f["extension"],
            "dir": f["dir"],
            "base_tags": f["base_tags"],
            "content_length": len(f["content"]),
            "hash": f["hash"],
        }
        for f in files
    ]
    return {"count": len(manifest), "files": manifest}
