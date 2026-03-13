"""OPAI Engine — Service health monitoring.

Rewrite of orchestrator.js service health check + auto-restart logic.
Runs every 5 minutes, checks systemd service status, restarts if needed.
"""

import asyncio
import logging
import subprocess

import config
from audit import log_audit

logger = logging.getLogger("opai-engine.service-monitor")


async def check_service(service_name: str) -> bool:
    """Check if a systemd user service is active."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "--user", "is-active", f"opai-{service_name}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        status = stdout.decode().strip()
        return status in ("active", "waiting")
    except (asyncio.TimeoutError, FileNotFoundError, OSError):
        return False


async def restart_service(service_name: str) -> bool:
    """Restart a systemd user service (sweeps stale processes first)."""
    # Sweep stale processes before restart — clears port-blocking orphans
    try:
        from background.process_sweeper import sweep_stale_processes
        result = await sweep_stale_processes()
        if result.get("killed", 0) > 0:
            logger.info("Pre-restart sweep killed %d stale processes", result["killed"])
    except Exception as e:
        logger.warning("Pre-restart sweep failed: %s", e)
    try:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "--user", "restart", f"opai-{service_name}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.communicate(), timeout=15)
        success = proc.returncode == 0
        if success:
            logger.info("Service %s restarted successfully", service_name)
            log_audit(
                tier="health",
                service="opai-engine",
                event="service-restart",
                status="completed",
                summary=f"Auto-restarted {service_name}",
                details={"service": service_name},
            )
        else:
            logger.error("Failed to restart %s", service_name)
        return success
    except (asyncio.TimeoutError, FileNotFoundError, OSError) as e:
        logger.error("Restart error for %s: %s", service_name, e)
        return False


async def check_all_services():
    """Check all monitored services and restart if needed."""
    orch_config = config.load_orchestrator_config()
    services = orch_config.get("services", {})

    for svc_name, svc_config in services.items():
        if not svc_config.get("enabled", True):
            continue
        if svc_config.get("type") == "internal":
            continue

        is_active = await check_service(svc_name)
        if not is_active and svc_config.get("restart_on_failure", False):
            logger.warning("Service %s is down, attempting restart", svc_name)
            await restart_service(svc_name)


async def service_monitor_loop():
    """Main loop — checks services every 5 minutes."""
    logger.info("Service monitor started")
    await asyncio.sleep(30)  # Initial delay

    while True:
        try:
            await check_all_services()
        except Exception as e:
            logger.error("Service monitor error: %s", e)
        await asyncio.sleep(300)  # 5 minutes
