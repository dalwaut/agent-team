"""HELM — Background asyncio scheduler for automated business jobs."""

from __future__ import annotations

import asyncio
import importlib
import logging
from datetime import datetime, timezone

from croniter import croniter

import config
from core.supabase import _sb_get, _sb_patch, _sb_post

log = logging.getLogger("helm.scheduler")

# ── Runtime scheduler state ──────────────────────────────────

_scheduler_tick: int = config.SCHEDULER_TICK
_scheduler_paused: bool = False


def get_scheduler_settings() -> dict:
    return {"tick_seconds": _scheduler_tick, "paused": _scheduler_paused}


def set_scheduler_settings(*, tick_seconds: int | None = None, paused: bool | None = None) -> dict:
    global _scheduler_tick, _scheduler_paused
    if tick_seconds is not None:
        _scheduler_tick = max(10, min(3600, tick_seconds))
    if paused is not None:
        _scheduler_paused = paused
    return get_scheduler_settings()


# Map job_type to module path and function
JOB_DISPATCH = {
    "content_generate": "jobs.content_generate",
    "report_weekly": "jobs.report_weekly",
    "stripe_sync": "jobs.stripe_sync",
    "site_health_check": "jobs.site_health_check",
    "hitl_expiry": "jobs.hitl_expiry",
    "social_stats_sync": "jobs.social_stats_sync",
}

# Human-readable labels for action log display
JOB_LABELS = {
    "content_generate": "Content Generation",
    "report_weekly": "Weekly Report",
    "stripe_sync": "Stripe Sync",
    "site_health_check": "Site Health Check",
    "hitl_expiry": "HITL Expiry Check",
    "social_stats_sync": "Social Stats Sync",
}


async def _run_job(job: dict) -> None:
    """Execute a single scheduled job."""
    job_type = job.get("job_type", "")
    business_id = job.get("business_id", "")
    job_id = job.get("id", "")
    job_config = job.get("config") or {}

    module_path = JOB_DISPATCH.get(job_type)
    if not module_path:
        log.warning("Unknown job type: %s (job %s)", job_type, job_id)
        return

    log.info("Running job %s (%s) for business %s", job_type, job_id, business_id)

    label = JOB_LABELS.get(job_type, job_type.replace("_", " ").title())

    try:
        mod = importlib.import_module(module_path)
        await mod.run(business_id, job_config)

        # Log success — short human-readable summary
        await _sb_post("helm_business_actions", {
            "business_id": business_id,
            "action_type": f"scheduled_{job_type}",
            "summary": f"{label} ran successfully",
            "status": "success",
            "actor": "scheduler",
        })
        log.info("Job %s completed for business %s", job_type, business_id)

    except Exception as exc:
        log.error("Job %s failed for business %s: %s", job_type, business_id, exc)
        # Log failure — short summary, full error in detail
        try:
            await _sb_post("helm_business_actions", {
                "business_id": business_id,
                "action_type": f"scheduled_{job_type}",
                "summary": f"{label} failed",
                "detail": str(exc)[:1000],
                "status": "failed",
                "actor": "scheduler",
            })
        except Exception:
            log.error("Failed to log job failure for %s", job_id)

    # Update next_run_at using croniter
    try:
        cron_expr = job.get("cron_expr", "0 */6 * * *")
        now = datetime.now(timezone.utc)
        cron = croniter(cron_expr, now)
        next_run = cron.get_next(datetime)

        await _sb_patch(
            f"helm_business_schedule?id=eq.{job_id}",
            {
                "last_run_at": now.isoformat(),
                "next_run_at": next_run.isoformat(),
            },
        )
    except Exception as exc:
        log.error("Failed to update schedule for job %s: %s", job_id, exc)


async def scheduler_loop() -> None:
    """Async infinite loop -- runs on each tick, checks for due jobs."""
    log.info("Scheduler started (tick=%ds)", _scheduler_tick)

    while True:
        try:
            await asyncio.sleep(_scheduler_tick)

            if _scheduler_paused:
                continue

            if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
                continue

            # Use Z suffix (not +00:00) — the '+' in +00:00 is treated as a space in URL query strings
            now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'

            # Fetch due jobs
            due_jobs = await _sb_get(
                f"helm_business_schedule?enabled=eq.true&next_run_at=lte.{now}"
                f"&order=next_run_at.asc&select=*"
            )

            if due_jobs:
                log.info("Found %d due job(s)", len(due_jobs))

            for job in due_jobs:
                try:
                    await _run_job(job)
                except Exception as exc:
                    log.error("Scheduler error for job %s: %s", job.get("id"), exc)

        except asyncio.CancelledError:
            log.info("Scheduler cancelled")
            raise
        except Exception as exc:
            log.error("Scheduler loop error: %s", exc)
            await asyncio.sleep(30)  # Back off on error
