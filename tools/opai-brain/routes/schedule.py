"""2nd Brain — Agent scheduler config routes (admin-only)."""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config

log = logging.getLogger("brain.routes.schedule")
router = APIRouter()

VALID_AGENTS = {"curator", "linker", "library_sync"}


def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_svc_headers())
        r.raise_for_status()
        return r.json()


async def _sb_patch(path: str, params: str, body: dict) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.patch(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else {}


def _require_admin(user: AuthUser):
    if getattr(user, "role", None) != "admin":
        raise HTTPException(403, "Admin only")


class SchedulePatch(BaseModel):
    curator_enabled: Optional[bool] = None
    curator_cron: Optional[str] = None
    linker_enabled: Optional[bool] = None
    linker_cron: Optional[str] = None


@router.get("/api/admin/schedule")
async def get_schedule(user: AuthUser = Depends(get_current_user)):
    """Get scheduler config for both agents (admin only)."""
    _require_admin(user)
    rows = await _sb_get("brain_schedule", "select=*&order=agent.asc")
    config_map = {r["agent"]: r for r in rows}
    return {
        "curator": config_map.get("curator", {}),
        "linker": config_map.get("linker", {}),
    }


@router.patch("/api/admin/schedule")
async def update_schedule(body: SchedulePatch, user: AuthUser = Depends(get_current_user)):
    """Update scheduler config (admin only)."""
    _require_admin(user)
    updates = {}
    if body.curator_enabled is not None:
        updates.setdefault("curator", {})["enabled"] = body.curator_enabled
    if body.curator_cron is not None:
        updates.setdefault("curator", {})["cron_expr"] = body.curator_cron
    if body.linker_enabled is not None:
        updates.setdefault("linker", {})["enabled"] = body.linker_enabled
    if body.linker_cron is not None:
        updates.setdefault("linker", {})["cron_expr"] = body.linker_cron

    results = {}
    for agent, patch in updates.items():
        r = await _sb_patch("brain_schedule", f"agent=eq.{agent}", patch)
        results[agent] = r
    return results


@router.post("/api/admin/schedule/run/{agent}")
async def run_agent_now(agent: str, user: AuthUser = Depends(get_current_user)):
    """Trigger an agent run immediately (admin only)."""
    _require_admin(user)
    if agent not in VALID_AGENTS:
        raise HTTPException(400, f"Unknown agent: {agent}. Valid: {VALID_AGENTS}")
    # Import here to avoid circular at startup
    try:
        from scheduler import trigger_agent
        import asyncio
        asyncio.create_task(trigger_agent(agent))
        return {"triggered": agent}
    except Exception as e:
        raise HTTPException(500, f"Failed to trigger agent: {e}")


# ── Scheduler Settings (heartbeat control) ─────────────────────────────────

@router.get("/api/scheduler/settings")
async def get_scheduler_settings_endpoint(user: AuthUser = Depends(get_current_user)):
    _require_admin(user)
    from scheduler import get_scheduler_settings
    return get_scheduler_settings()


class _SchedulerSettingsBody(BaseModel):
    tick_seconds: Optional[int] = None
    paused: Optional[bool] = None


@router.put("/api/scheduler/settings")
async def update_scheduler_settings_endpoint(body: _SchedulerSettingsBody, user: AuthUser = Depends(get_current_user)):
    _require_admin(user)
    from scheduler import set_scheduler_settings
    return set_scheduler_settings(tick_seconds=body.tick_seconds, paused=body.paused)
