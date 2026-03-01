"""HELM — Health check + scheduler settings routes."""

import resource
import sys
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config

router = APIRouter()

_start_time = time.time()


@router.get("/health")
@router.get("/api/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "helm",
        "version": config.VERSION,
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


# ── Scheduler Settings (heartbeat control) ─────────────────────────────────

@router.get("/api/scheduler/settings")
async def get_scheduler_settings_endpoint(user: AuthUser = Depends(get_current_user)):
    if getattr(user, "role", "") != "admin":
        raise HTTPException(403, "Admin only")
    from core.scheduler import get_scheduler_settings
    return get_scheduler_settings()


class _SchedulerSettingsBody(BaseModel):
    tick_seconds: Optional[int] = None
    paused: Optional[bool] = None


@router.put("/api/scheduler/settings")
async def update_scheduler_settings_endpoint(body: _SchedulerSettingsBody, user: AuthUser = Depends(get_current_user)):
    if getattr(user, "role", "") != "admin":
        raise HTTPException(403, "Admin only")
    from core.scheduler import set_scheduler_settings
    return set_scheduler_settings(tick_seconds=body.tick_seconds, paused=body.paused)
