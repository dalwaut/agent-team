"""OPAI Engine — Stale job sweeper.

Rewrite of orchestrator.js sweepStaleJobs().
Cleans up zombie job entries from the active_jobs state.
"""

import asyncio
import logging
import time

logger = logging.getLogger("opai-engine.stale-sweeper")

# Interactive session types — never kill by age alone
INTERACTIVE_TYPES = {"interactive", "ide_session", "terminal", "claude_session"}
INTERACTIVE_STALE_MS = 20 * 60 * 1000  # 20 min no interaction
BATCH_MAX_AGE_MS = 20 * 60 * 1000  # 20 min max for batch jobs


async def stale_job_sweeper_loop():
    """Sweep stale jobs every 2 minutes."""
    logger.info("Stale job sweeper started")
    await asyncio.sleep(60)

    while True:
        try:
            _sweep()
        except Exception as e:
            logger.error("Stale job sweep error: %s", e)
        await asyncio.sleep(120)


def _sweep():
    """Check active jobs and remove stale ones."""
    from background.scheduler import Scheduler
    # Access the shared scheduler instance from the app
    try:
        from app import scheduler
    except ImportError:
        return

    now_ms = time.time() * 1000
    stale = []

    for job_id, job in list(scheduler.active_jobs.items()):
        start_ms = job.get("startTime", 0) * 1000
        job_type = job.get("type", "")

        if job_type in INTERACTIVE_TYPES:
            last_activity = job.get("lastActivity", job.get("startTime", 0)) * 1000
            if now_ms - last_activity > INTERACTIVE_STALE_MS:
                stale.append(job_id)
        else:
            if now_ms - start_ms > BATCH_MAX_AGE_MS:
                stale.append(job_id)

    if stale:
        for job_id in stale:
            job = scheduler.active_jobs.get(job_id, {})
            age_min = (now_ms - job.get("startTime", 0) * 1000) / 60000
            logger.warning("Sweeping stale job %s (type: %s, age: %.0fm)", job_id, job.get("type"), age_min)
            scheduler.stats["total_jobs_failed"] = scheduler.stats.get("total_jobs_failed", 0) + 1
            scheduler.active_jobs.pop(job_id, None)
        scheduler._save_state()
