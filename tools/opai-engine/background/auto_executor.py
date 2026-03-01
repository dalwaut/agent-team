"""OPAI Engine — Auto-executor loop.

Replaces the dual auto-executor that existed in both Orchestrator and TCP.
Now a single loop running every 30 seconds inside the engine.
"""

import asyncio
import logging

import services.task_processor as tp

logger = logging.getLogger("opai-engine.auto-executor")


async def auto_executor_loop():
    """Run auto_execute_cycle every 30 seconds."""
    logger.info("Auto-executor started")
    await asyncio.sleep(15)  # Stagger after scheduler

    while True:
        await asyncio.sleep(30)
        try:
            tp.auto_execute_cycle()
        except Exception as e:
            logger.error("auto_execute_cycle error: %s", e)

        # Also check for timed-out tasks
        try:
            tp.check_task_timeouts()
        except Exception as e:
            logger.error("check_task_timeouts error: %s", e)
