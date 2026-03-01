"""OPAI Engine — Feedback loop.

Placeholder for feedback processor/actor spawning.
The actual spawning is handled by the scheduler (feedback_process and feedback_act cron entries).
This module exists for future direct integration if needed.
"""

import asyncio
import logging

logger = logging.getLogger("opai-engine.feedback-loop")


async def feedback_loop():
    """Feedback loop — currently handled by scheduler cron entries.

    The scheduler dispatches feedback_process and feedback_act on their
    cron schedules. This async task is a no-op placeholder that can be
    extended for event-driven feedback processing in the future.
    """
    logger.info("Feedback loop started (delegated to scheduler)")
    # Nothing to do — scheduler handles feedback_process and feedback_act
    # This task just sleeps forever to maintain the interface
    while True:
        await asyncio.sleep(3600)
