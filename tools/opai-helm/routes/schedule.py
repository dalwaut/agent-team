"""HELM — Schedule management routes."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

from core.supabase import _sb_get, _sb_post, _sb_patch, _sb_delete

log = logging.getLogger("helm.routes.schedule")
router = APIRouter()

# ── Default schedule definitions ─────────────────────────────────────────────

DEFAULT_SCHEDULES = [
    {
        "job_type":  "content_generate",
        "cron_expr": "0 6 * * *",      # Daily 6am UTC
        "enabled":   True,
    },
    {
        "job_type":  "report_weekly",
        "cron_expr": "0 7 * * 1",      # Monday 7am UTC
        "enabled":   True,
    },
    {
        "job_type":  "site_health_check",
        "cron_expr": "*/30 * * * *",   # Every 30 minutes
        "enabled":   True,
    },
    {
        "job_type":  "hitl_expiry",
        "cron_expr": "*/15 * * * *",   # Every 15 minutes
        "enabled":   True,
    },
    {
        "job_type":  "stripe_sync",
        "cron_expr": "0 */6 * * *",    # Every 6 hours
        "enabled":   False,            # Off until Stripe wired
    },
    {
        "job_type":  "social_stats_sync",
        "cron_expr": "0 2 * * *",      # Daily 2am UTC
        "enabled":   False,            # Off until social connectors wired
    },
]

# Preset frequency options surfaced in the UI
FREQUENCY_PRESETS = [
    {"label": "Every 15 minutes", "cron": "*/15 * * * *"},
    {"label": "Every 30 minutes", "cron": "*/30 * * * *"},
    {"label": "Every hour",        "cron": "0 * * * *"},
    {"label": "Every 2 hours",     "cron": "0 */2 * * *"},
    {"label": "Every 6 hours",     "cron": "0 */6 * * *"},
    {"label": "Daily at 2am",      "cron": "0 2 * * *"},
    {"label": "Daily at 6am",      "cron": "0 6 * * *"},
    {"label": "Daily at 9am",      "cron": "0 9 * * *"},
    {"label": "Weekly Mon 7am",    "cron": "0 7 * * 1"},
]


async def _check_access(user: AuthUser, business_id: str) -> bool:
    """Check if user has access to this business (owner, editor, or admin)."""
    if getattr(user, "role", "") == "admin":
        return True
    rows = await _sb_get(
        f"helm_business_access?business_id=eq.{business_id}&user_id=eq.{user.id}&select=role"
    )
    return bool(rows)


async def seed_schedules(business_id: str) -> list:
    """Idempotently create default schedule rows for a business.

    Skips job_types that already have a row. Returns list of created rows.
    """
    from croniter import croniter

    existing = await _sb_get(
        f"helm_business_schedule?business_id=eq.{business_id}&select=job_type"
    )
    existing_types = {r["job_type"] for r in (existing or [])}

    now = datetime.now(timezone.utc)
    created = []

    for sched in DEFAULT_SCHEDULES:
        if sched["job_type"] in existing_types:
            continue

        # Calculate first next_run_at
        cron = croniter(sched["cron_expr"], now)
        next_run = cron.get_next(datetime)

        row = await _sb_post("helm_business_schedule", {
            "business_id": business_id,
            "job_type":    sched["job_type"],
            "cron_expr":   sched["cron_expr"],
            "enabled":     sched["enabled"],
            "next_run_at": next_run.isoformat(),
        }, upsert=True, on_conflict="business_id,job_type")
        created.append(row)
        log.info("Seeded schedule %s for business %s", sched["job_type"], business_id)

    return created


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/api/businesses/{business_id}/schedules")
async def list_schedules(
    business_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """List schedules, auto-seeding defaults if none exist."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        f"helm_business_schedule?business_id=eq.{business_id}"
        f"&order=job_type.asc&select=*"
    )

    if not rows:
        await seed_schedules(business_id)
        rows = await _sb_get(
            f"helm_business_schedule?business_id=eq.{business_id}"
            f"&order=job_type.asc&select=*"
        )

    return rows or []


@router.post("/api/businesses/{business_id}/schedules/seed")
async def seed_business_schedules(
    business_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Idempotently seed default schedules for this business."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    created = await seed_schedules(business_id)
    return {"seeded": len(created)}


class ScheduleUpdate(BaseModel):
    enabled:   Optional[bool] = None
    cron_expr: Optional[str]  = None


@router.patch("/api/businesses/{business_id}/schedules/{job_type}")
async def update_schedule(
    business_id: str,
    job_type: str,
    body: ScheduleUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update a schedule's enabled state and/or cron expression."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        f"helm_business_schedule?business_id=eq.{business_id}&job_type=eq.{job_type}&select=id"
    )
    if not rows:
        raise HTTPException(404, f"Schedule '{job_type}' not found — seed first")

    schedule_id = rows[0]["id"]
    update: dict = {}

    if body.enabled is not None:
        update["enabled"] = body.enabled

    if body.cron_expr is not None:
        # Validate cron expression
        try:
            from croniter import croniter
            now = datetime.now(timezone.utc)
            cron = croniter(body.cron_expr, now)
            next_run = cron.get_next(datetime)
            update["cron_expr"] = body.cron_expr
            update["next_run_at"] = next_run.isoformat()
        except Exception:
            raise HTTPException(400, f"Invalid cron expression: {body.cron_expr!r}")

    if not update:
        raise HTTPException(400, "No fields to update")

    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await _sb_patch(
        f"helm_business_schedule?id=eq.{schedule_id}",
        update,
    )
    return result[0] if isinstance(result, list) and result else update


@router.get("/api/businesses/{business_id}/schedules/social-post")
async def get_social_post_schedule(
    business_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Get the social_post schedule row for this business (or a default empty config)."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        f"helm_business_schedule?business_id=eq.{business_id}&job_type=eq.social_post&select=*"
    )
    if rows:
        return rows[0]
    return {"id": None, "business_id": business_id, "job_type": "social_post", "config": {"platforms": []}, "enabled": False}


class SocialPostScheduleUpdate(BaseModel):
    config: dict


@router.put("/api/businesses/{business_id}/schedules/social-post")
async def upsert_social_post_schedule(
    business_id: str,
    body: SocialPostScheduleUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Upsert the social_post schedule config for this business.

    The config.platforms list determines which accounts get posts and at what frequency.
    """
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    platforms = body.config.get("platforms") or []

    # Determine if any platform is enabled and pick the most frequent cron for next_run_at
    any_enabled = any(p.get("enabled", True) for p in platforms)
    cron_expr = "0 9 * * *"  # Default
    if platforms:
        # Use the first enabled platform's cron, or the first platform's cron
        for p in platforms:
            if p.get("enabled", True) and p.get("cron_expr"):
                cron_expr = p["cron_expr"]
                break
        if cron_expr == "0 9 * * *" and platforms[0].get("cron_expr"):
            cron_expr = platforms[0]["cron_expr"]

    now = datetime.now(timezone.utc)
    try:
        from croniter import croniter
        cron_obj = croniter(cron_expr, now)
        next_run = cron_obj.get_next(datetime)
        next_run_iso = next_run.isoformat()
    except Exception:
        next_run_iso = now.isoformat()

    existing = await _sb_get(
        f"helm_business_schedule?business_id=eq.{business_id}&job_type=eq.social_post&select=id"
    )

    update_data = {
        "config": body.config,
        "cron_expr": cron_expr,
        "enabled": any_enabled and bool(platforms),
        "next_run_at": next_run_iso,
        "updated_at": now.isoformat(),
    }

    if existing:
        result = await _sb_patch(
            f"helm_business_schedule?id=eq.{existing[0]['id']}",
            update_data,
        )
        return result[0] if isinstance(result, list) and result else update_data
    else:
        row = await _sb_post("helm_business_schedule", {
            "business_id": business_id,
            "job_type": "social_post",
            **update_data,
        }, upsert=True, on_conflict="business_id,job_type")
        return row


@router.delete("/api/businesses/{business_id}/schedules/{job_type}")
async def delete_schedule(
    business_id: str,
    job_type: str,
    user: AuthUser = Depends(get_current_user),
):
    """Delete a schedule row (only allowed for custom/social schedules)."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    # Prevent deleting core system schedules
    PROTECTED = {"content_generate", "report_weekly", "site_health_check", "hitl_expiry"}
    if job_type in PROTECTED:
        raise HTTPException(400, f"Cannot delete protected schedule: {job_type}")

    await _sb_delete(
        f"helm_business_schedule?business_id=eq.{business_id}&job_type=eq.{job_type}"
    )
    return {"deleted": job_type}


@router.get("/api/schedule/frequency-presets")
async def get_frequency_presets():
    """Return the list of UI-friendly frequency presets."""
    return FREQUENCY_PRESETS
