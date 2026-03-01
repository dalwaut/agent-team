"""OPAI Engine — Resource monitoring.

Rewrite of orchestrator.js resource check logic.
Tracks CPU/memory and determines if the system can accept new jobs.
"""

import asyncio
import logging

import psutil

import config

logger = logging.getLogger("opai-engine.resource-monitor")

# Shared state — accessible by scheduler and auto-executor
_resource_state: dict = {
    "cpu": 0.0,
    "memory": 0.0,
    "can_execute": True,
    "timestamp": 0,
}


def get_resource_state() -> dict:
    """Get current resource state (read by other modules)."""
    return _resource_state


class ResourceMonitor:
    """Tracks system resources every 30 seconds."""

    def __init__(self):
        self.max_cpu = 80
        self.max_memory = 85

    async def loop(self):
        """Main loop — checks resources every 30 seconds."""
        logger.info("Resource monitor started")
        await asyncio.sleep(5)

        # Load limits from config
        orch = config.load_orchestrator_config()
        res = orch.get("resources", {})
        self.max_cpu = res.get("max_cpu_percent", 80)
        self.max_memory = res.get("max_memory_percent", 85)

        while True:
            try:
                import time
                cpu = psutil.cpu_percent(interval=1)
                mem = psutil.virtual_memory().percent

                _resource_state["cpu"] = cpu
                _resource_state["memory"] = mem
                _resource_state["can_execute"] = cpu < self.max_cpu and mem < self.max_memory
                _resource_state["timestamp"] = time.time()

                if not _resource_state["can_execute"]:
                    logger.warning(
                        "Resources constrained: CPU=%.1f%% (max %d), MEM=%.1f%% (max %d)",
                        cpu, self.max_cpu, mem, self.max_memory,
                    )
            except Exception as e:
                logger.error("Resource monitor error: %s", e)

            await asyncio.sleep(30)
