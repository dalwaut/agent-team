"""OPAI Forum Bot — Background scheduler for automated post generation."""

import asyncio
import json
import logging
import subprocess
import uuid
from datetime import datetime, timezone

import httpx
from croniter import croniter

import config
from generator import generate_posts

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from audit import log_audit

logger = logging.getLogger("forumbot.scheduler")

# ── Runtime scheduler state ──────────────────────────────────

_scheduler_tick: int = config.SCHEDULER_TICK   # seconds between checks
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


# ── Supabase helpers ─────────────────────────────────────────

def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str) -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Condition checkers ───────────────────────────────────────

async def check_condition(condition: dict) -> bool:
    """Check if a schedule condition is met. All conditions must pass (AND)."""
    ctype = condition.get("type", "")
    params = condition.get("params", {})

    if ctype == "git_commits":
        return await _check_git_commits(
            min_commits=params.get("min_commits", 1),
            hours=params.get("hours", 24),
        )
    elif ctype == "weekday":
        return _check_weekday(params.get("days", []))
    elif ctype == "service_restart":
        return await _check_service_restart(
            threshold_seconds=params.get("threshold_seconds", 3600),
        )
    else:
        logger.warning(f"Unknown condition type: {ctype}")
        return True  # Unknown conditions pass by default


async def _check_git_commits(min_commits: int, hours: int) -> bool:
    """Check if there are at least N commits in the last M hours."""
    try:
        result = subprocess.run(
            ["git", "log", f"--since={hours} hours ago", "--oneline"],
            capture_output=True, text=True, timeout=5,
            cwd=str(config.OPAI_ROOT),
        )
        count = len(result.stdout.strip().split("\n")) if result.stdout.strip() else 0
        return count >= min_commits
    except Exception:
        return False


def _check_weekday(days: list) -> bool:
    """Check if today is one of the specified weekdays (0=Mon, 6=Sun)."""
    if not days:
        return True
    return datetime.now(timezone.utc).weekday() in days


async def _check_service_restart(threshold_seconds: int) -> bool:
    """Check if any OPAI service has uptime below threshold (recently restarted)."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get("http://127.0.0.1:8081/api/monitor/health/summary")
            data = resp.json()
            for svc_info in data.get("services", {}).values():
                uptime = svc_info.get("uptime_seconds")
                if uptime is not None and uptime < threshold_seconds:
                    return True
        return False
    except Exception:
        return False


# ── Schedule runner ──────────────────────────────────────────

async def run_schedule(schedule: dict) -> dict:
    """Execute a single schedule: check conditions, generate, insert drafts.

    Returns {success, drafts_created, error?}.
    """
    schedule_id = schedule["id"]

    # Check all conditions (AND logic)
    conditions = schedule.get("conditions") or []
    for cond in conditions:
        if not await check_condition(cond):
            return {
                "success": True,
                "drafts_created": 0,
                "skipped": f"Condition '{cond.get('type')}' not met",
            }

    # Generate posts
    try:
        posts = await generate_posts(
            prompt=schedule["prompt_template"],
            post_type=schedule["post_type"],
            count=schedule.get("max_drafts", 1),
        )
    except Exception as e:
        logger.error(f"Schedule {schedule_id} generation failed: {e}")
        return {"success": False, "drafts_created": 0, "error": str(e)}

    batch_id = f"sched-{schedule_id[:8]}-{uuid.uuid4().hex[:8]}"
    drafts_created = 0

    async with httpx.AsyncClient(timeout=10) as client:
        for post in posts:
            draft_data = {
                "status": "approved" if schedule.get("auto_publish") else "draft",
                "post_type": schedule["post_type"],
                "title": post["title"],
                "content": post["content"],
                "tags": post.get("tags", []),
                "category_id": schedule.get("category_id"),
                "poll_data": post.get("poll"),
                "prompt": schedule["prompt_template"],
                "batch_id": batch_id,
                "schedule_id": schedule_id,
            }

            resp = await client.post(
                _sb_url("forumbot_drafts"),
                headers=_sb_headers(),
                json=draft_data,
            )
            if resp.status_code < 400:
                drafts_created += 1
                draft = resp.json()
                draft = draft[0] if isinstance(draft, list) else draft

                # Record history
                await client.post(
                    _sb_url("forumbot_history"),
                    headers=_sb_headers(),
                    json={
                        "draft_id": draft["id"],
                        "action": "generated",
                        "actor": f"scheduler:{schedule_id}",
                        "details": {"batch_id": batch_id, "schedule_name": schedule["name"]},
                    },
                )

                # Auto-publish if enabled
                if schedule.get("auto_publish"):
                    await _auto_publish_draft(client, draft, schedule_id)

        # Update schedule last_run
        await client.patch(
            _sb_url("forumbot_schedules"),
            headers=_sb_headers(),
            params={"id": f"eq.{schedule_id}"},
            json={
                "last_run_at": datetime.now(timezone.utc).isoformat(),
                "last_result": {"success": True, "drafts_created": drafts_created},
            },
        )

    return {"success": True, "drafts_created": drafts_created}


async def _auto_publish_draft(client: httpx.AsyncClient, draft: dict, schedule_id: str):
    """Publish a draft directly to the forum."""
    from routes_api import _publish_draft_to_forum
    try:
        await _publish_draft_to_forum(
            draft,
            actor=f"scheduler:{schedule_id}",
        )
    except Exception as e:
        logger.error(f"Auto-publish failed for draft {draft['id']}: {e}")


# ── Main loop ────────────────────────────────────────────────

async def scheduler_loop():
    """Background loop that checks schedules on a configurable interval."""
    logger.info(f"Scheduler started (tick={_scheduler_tick}s)")

    while True:
        if not _scheduler_paused:
            try:
                await _tick()
            except Exception as e:
                logger.error(f"Scheduler tick error: {e}")

        await asyncio.sleep(_scheduler_tick)


async def _tick():
    """Single scheduler tick: find due schedules and run them."""
    now = datetime.now(timezone.utc)

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _sb_url("forumbot_schedules"),
            headers=_sb_headers(),
            params={"enabled": "eq.true", "select": "*"},
        )
        if resp.status_code >= 400:
            return

        schedules = resp.json()

    for schedule in schedules:
        try:
            cron = croniter(schedule["cron_expr"], now)
            prev = cron.get_prev(datetime)

            last_run = schedule.get("last_run_at")
            if last_run:
                last_run_dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
                if last_run_dt >= prev:
                    continue  # Already ran for this window

            # Schedule is due
            logger.info(f"Running schedule: {schedule['name']} ({schedule['id']})")

            # Record trigger
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    _sb_url("forumbot_history"),
                    headers=_sb_headers(),
                    json={
                        "action": "schedule_triggered",
                        "actor": f"scheduler:{schedule['id']}",
                        "details": {"schedule_name": schedule["name"], "cron": schedule["cron_expr"]},
                    },
                )

            result = await run_schedule(schedule)
            logger.info(f"Schedule {schedule['name']} result: {result}")

            try:
                log_audit(
                    tier="system",
                    service="opai-forumbot",
                    event="schedule-run",
                    status="completed" if result.get("success") else "failed",
                    summary=f"ForumBot schedule '{schedule['name']}' — {result.get('drafts_created', 0)} drafts",
                    details={"schedule_id": schedule["id"], "schedule_name": schedule["name"], "drafts_created": result.get("drafts_created", 0), "auto_publish": schedule.get("auto_publish", False)},
                )
            except Exception:
                pass

        except Exception as e:
            logger.error(f"Schedule {schedule['id']} error: {e}")
