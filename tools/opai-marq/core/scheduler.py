"""Marq — Background polling scheduler.

Runs on a configurable tick (default 60s). Queries mrq_schedule for
due jobs and dispatches to registered handlers.

Job types and their handlers:
- google_status_poll  → Check Google Play submission status
- google_review_poll  → Fetch new Google Play reviews
- apple_status_poll   → Check Apple submission status
- apple_review_sync   → Fetch new Apple reviews
- pre_check_rerun     → Re-run pre-checks for active submissions
- credential_verify   → Verify stored credentials are still valid
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone, timedelta

import config
from core.supabase import _sb_get, _sb_patch, _sb_post
from core.vault import load_credential

log = logging.getLogger("marq.scheduler")

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


async def scheduler_loop():
    """Main scheduler loop — checks for due jobs every SCHEDULER_TICK seconds."""
    log.info("Scheduler started (tick=%ds)", _scheduler_tick)
    while True:
        try:
            if not _scheduler_paused:
                await _tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Scheduler tick failed")
        await asyncio.sleep(_scheduler_tick)


async def _tick():
    """Single scheduler tick — find and run due jobs."""
    now = datetime.now(timezone.utc)
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    jobs = await _sb_get(
        f"mrq_schedule?enabled=eq.true&next_run_at=lte.{now_iso}&order=next_run_at.asc&limit=10"
    )
    for job in jobs:
        try:
            await _run_job(job)
        except Exception:
            log.exception("Job %s failed for app %s", job["job_type"], job["app_id"])


async def _run_job(job: dict):
    """Execute a single scheduled job and update next_run_at."""
    job_type = job["job_type"]
    app_id = job["app_id"]
    interval = job.get("interval_minutes", 30)

    log.info("Running job %s for app %s", job_type, app_id)

    handler = JOB_HANDLERS.get(job_type)
    if handler:
        await handler(app_id, job.get("config", {}))
    else:
        log.debug("No handler for job type: %s", job_type)

    # Update timestamps
    now = datetime.now(timezone.utc)
    next_run = now + timedelta(minutes=interval)
    await _sb_patch(
        f"mrq_schedule?id=eq.{job['id']}",
        {
            "last_run_at": now.isoformat(),
            "next_run_at": next_run.isoformat(),
        },
    )


# ══════════════════════════════════════════════════════════════
# Job Handlers
# ══════════════════════════════════════════════════════════════

async def _get_connector(app_id: str, store: str):
    """Load store credentials and create a connector instance."""
    creds = await _sb_get(
        f"mrq_store_credentials?app_id=eq.{app_id}&store=eq.{store}&is_active=eq.true&select=*&limit=1"
    )
    if not creds:
        log.warning("No active credentials for app %s store %s", app_id, store)
        return None

    cred = creds[0]
    try:
        secret_data = load_credential(cred["vault_key"])
    except Exception as e:
        log.error("Failed to load credential %s: %s", cred["vault_key"], e)
        # Mark credential as inactive
        await _sb_patch(f"mrq_store_credentials?id=eq.{cred['id']}", {"is_active": False})
        return None

    if store == "google":
        from connectors.google import GooglePlayConnector
        return GooglePlayConnector(secret_data)
    elif store == "apple":
        from connectors.apple import AppleConnector
        return AppleConnector(
            issuer_id=cred.get("issuer_id", ""),
            key_id=cred.get("key_id", ""),
            private_key=secret_data.get("private_key", ""),
        )
    return None


async def _get_app_with_package(app_id: str) -> dict | None:
    """Get app with package name for connector use."""
    apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
    return apps[0] if apps else None


# ── Google Status Poll ────────────────────────────────────────

async def handle_google_status_poll(app_id: str, job_config: dict):
    """Poll Google Play for submission status changes."""
    app = await _get_app_with_package(app_id)
    if not app or not app.get("package_name_android"):
        return

    connector = await _get_connector(app_id, "google")
    if not connector:
        return

    package = app["package_name_android"]
    track = job_config.get("track", "production")

    try:
        status = await connector.get_track_status(package, track)
    except Exception as e:
        log.error("Google status poll failed for %s: %s", package, e)
        return

    releases = status.get("releases", [])
    if not releases:
        return

    latest = releases[0]
    google_status = latest.get("status", "")

    # Map Google status to Marq
    status_map = {
        "draft": "preparing",
        "inProgress": "in_review",
        "halted": "rejected",
        "completed": "released",
    }
    marq_status = status_map.get(google_status)
    if not marq_status:
        return

    # Find active submission for this app/store
    subs = await _sb_get(
        f"mrq_submissions?app_id=eq.{app_id}&store=eq.google"
        f"&status=neq.released&status=neq.rejected&status=neq.cancelled"
        f"&order=created_at.desc&limit=1&select=*"
    )
    if not subs:
        return

    sub = subs[0]
    old_status = sub.get("status")

    if old_status == marq_status:
        return  # No change

    log.info("Google status change for app %s: %s → %s", app_id, old_status, marq_status)

    # Update submission
    update = {"status": marq_status}
    if marq_status == "released":
        update["released_at"] = datetime.now(timezone.utc).isoformat()
    elif marq_status == "rejected":
        update["reviewed_at"] = datetime.now(timezone.utc).isoformat()

    await _sb_patch(f"mrq_submissions?id=eq.{sub['id']}", update)

    # Create review event
    await _sb_post("mrq_review_events", {
        "app_id": app_id,
        "submission_id": sub["id"],
        "store": "google",
        "event_type": "status_change",
        "old_status": old_status,
        "new_status": marq_status,
        "source": "poll",
        "parsed_summary": f"Google Play: {old_status} → {marq_status}",
        "raw_payload": {"track": track, "release": latest},
    })

    # Handle rejection
    if marq_status == "rejected" and old_status != "rejected":
        asyncio.create_task(_handle_status_rejection(app_id, sub["id"]))


# ── Google Review Poll ────────────────────────────────────────

async def handle_google_review_poll(app_id: str, job_config: dict):
    """Fetch new Google Play reviews."""
    app = await _get_app_with_package(app_id)
    if not app or not app.get("package_name_android"):
        return

    connector = await _get_connector(app_id, "google")
    if not connector:
        return

    package = app["package_name_android"]

    try:
        reviews = await connector.list_reviews(package, max_results=20)
    except Exception as e:
        log.error("Google review poll failed for %s: %s", package, e)
        return

    if not reviews:
        return

    # Check which reviews we've already seen
    for review in reviews:
        review_id = review.get("reviewId")
        if not review_id:
            continue

        existing = await _sb_get(
            f"mrq_review_responses?app_id=eq.{app_id}&store=eq.google&review_id=eq.{review_id}&select=id"
        )
        if existing:
            continue  # Already tracked

        # Extract review data
        user_comment = review.get("comments", [{}])[0].get("userComment", {})
        rating = user_comment.get("starRating", 0)
        text = user_comment.get("text", "")

        await _sb_post("mrq_review_responses", {
            "app_id": app_id,
            "store": "google",
            "review_id": review_id,
            "rating": rating,
            "review_text": text,
            "status": "pending",
        })

    log.info("Processed %d Google reviews for app %s", len(reviews), app_id)


# ── Apple Status Poll ─────────────────────────────────────────

async def handle_apple_status_poll(app_id: str, job_config: dict):
    """Poll Apple App Store Connect for submission status changes."""
    app = await _get_app_with_package(app_id)
    if not app:
        return

    connector = await _get_connector(app_id, "apple")
    if not connector:
        return

    apple_app_id = job_config.get("apple_app_id")
    if not apple_app_id:
        log.warning("No apple_app_id in job config for app %s", app_id)
        return

    try:
        from connectors.apple import AppleConnector
        versions = await connector.list_versions(apple_app_id)
    except Exception as e:
        log.error("Apple status poll failed for app %s: %s", app_id, e)
        return

    if not versions:
        return

    latest = versions[0]
    apple_state = latest.get("appStoreState", "")
    from connectors.apple import AppleConnector
    marq_status = AppleConnector.map_status(apple_state)

    if not marq_status or marq_status == "unknown":
        return

    # Find active submission
    subs = await _sb_get(
        f"mrq_submissions?app_id=eq.{app_id}&store=eq.apple"
        f"&status=neq.released&status=neq.rejected&status=neq.cancelled"
        f"&order=created_at.desc&limit=1&select=*"
    )
    if not subs:
        return

    sub = subs[0]
    old_status = sub.get("status")

    if old_status == marq_status:
        return

    log.info("Apple status change for app %s: %s → %s", app_id, old_status, marq_status)

    update = {"status": marq_status}
    if marq_status == "released":
        update["released_at"] = datetime.now(timezone.utc).isoformat()
    elif marq_status in ("rejected", "approved"):
        update["reviewed_at"] = datetime.now(timezone.utc).isoformat()

    await _sb_patch(f"mrq_submissions?id=eq.{sub['id']}", update)

    await _sb_post("mrq_review_events", {
        "app_id": app_id,
        "submission_id": sub["id"],
        "store": "apple",
        "event_type": "status_change",
        "old_status": old_status,
        "new_status": marq_status,
        "source": "poll",
        "parsed_summary": f"Apple: {apple_state} ({old_status} → {marq_status})",
        "raw_payload": {"version": latest},
    })

    if marq_status == "rejected" and old_status != "rejected":
        asyncio.create_task(_handle_status_rejection(app_id, sub["id"]))


# ── Apple Review Sync ─────────────────────────────────────────

async def handle_apple_review_sync(app_id: str, job_config: dict):
    """Fetch new Apple customer reviews."""
    connector = await _get_connector(app_id, "apple")
    if not connector:
        return

    apple_app_id = job_config.get("apple_app_id")
    if not apple_app_id:
        return

    try:
        reviews = await connector.list_customer_reviews(apple_app_id, limit=20)
    except Exception as e:
        log.error("Apple review sync failed for app %s: %s", app_id, e)
        return

    for review in reviews:
        review_id = review.get("id")
        if not review_id:
            continue

        existing = await _sb_get(
            f"mrq_review_responses?app_id=eq.{app_id}&store=eq.apple&review_id=eq.{review_id}&select=id"
        )
        if existing:
            continue

        rating = review.get("rating", 0)
        text = review.get("body", "")

        await _sb_post("mrq_review_responses", {
            "app_id": app_id,
            "store": "apple",
            "review_id": review_id,
            "rating": rating,
            "review_text": text,
            "status": "pending",
        })

    log.info("Processed %d Apple reviews for app %s", len(reviews), app_id)


# ── Shared: rejection handler ─────────────────────────────────

async def _handle_status_rejection(app_id: str, submission_id: str):
    """Handle a rejection detected by polling — same flow as submissions.py."""
    try:
        from core.teamhub import ensure_app_workspace
        from core.translator import create_rejection_tasks

        apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
        subs = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=*")
        if not apps or not subs:
            return

        app = apps[0]
        submission = subs[0]

        ws = await ensure_app_workspace(app)
        issues_list_id = ws.get("issues_list_id")
        if not issues_list_id:
            return

        relays = await create_rejection_tasks(app, submission, issues_list_id)
        log.info("Poll rejection handler created %d tasks for submission %s", len(relays), submission_id)

        if relays:
            relay_ids = [r.get("teamhub_item_id") for r in relays if r.get("teamhub_item_id")]
            await _sb_patch(f"mrq_submissions?id=eq.{submission_id}", {
                "rejection_details": {
                    **(submission.get("rejection_details") or {}),
                    "teamhub_task_ids": relay_ids,
                    "tasks_created": len(relays),
                },
            })
    except Exception:
        log.exception("Poll rejection handler failed for submission %s", submission_id)


# ══════════════════════════════════════════════════════════════
# Job Handler Registry
# ══════════════════════════════════════════════════════════════

JOB_HANDLERS: dict = {
    "google_status_poll": handle_google_status_poll,
    "google_review_poll": handle_google_review_poll,
    "apple_status_poll": handle_apple_status_poll,
    "apple_review_sync": handle_apple_review_sync,
    # pre_check_rerun and credential_verify — Phase 5/6
}
