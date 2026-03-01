"""Marq — Polling schedule configuration routes."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

from core.supabase import _sb_get, _sb_patch
from routes.apps import check_access

log = logging.getLogger("marq.routes.schedule")
router = APIRouter()


class ScheduleUpdate(BaseModel):
    enabled: Optional[bool] = None
    interval_minutes: Optional[int] = None


@router.get("/api/apps/{app_id}/schedule")
async def get_schedule(app_id: str, user: AuthUser = Depends(get_current_user)):
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")
    return await _sb_get(
        f"mrq_schedule?app_id=eq.{app_id}&order=job_type&select=*"
    )


@router.patch("/api/schedule/{schedule_id}")
async def update_schedule(schedule_id: str, body: ScheduleUpdate, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get(f"mrq_schedule?id=eq.{schedule_id}&select=app_id")
    if not rows:
        raise HTTPException(404, "Schedule not found")
    if not await check_access(user, rows[0]["app_id"]):
        raise HTTPException(403, "Access denied")

    payload = body.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(400, "No fields to update")

    result = await _sb_patch(f"mrq_schedule?id=eq.{schedule_id}", payload)
    return result[0] if isinstance(result, list) and result else result
