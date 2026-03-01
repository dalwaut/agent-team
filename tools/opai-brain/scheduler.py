"""2nd Brain — Background agent scheduler.

Checks brain_schedule every 60s and runs agents when due.
Uses croniter to evaluate cron expressions.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from audit import log_audit
import httpx

log = logging.getLogger("brain.scheduler")

# ── Runtime scheduler state ──────────────────────────────────
import config as _cfg
_scheduler_tick: int = _cfg.SCHEDULER_TICK
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


# Map agent name → shell script path (relative to workspace root)
_WORKSPACE = Path(__file__).parent.parent.parent
_AGENT_SCRIPTS = {
    "curator":       _WORKSPACE / "scripts" / "run_brain_curator.sh",
    "linker":        _WORKSPACE / "scripts" / "run_brain_linker.sh",
    "library_sync":  _WORKSPACE / "scripts" / "run_brain_library_sync.sh",
}


def _svc_headers() -> dict:
    import config
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def _get_schedule() -> list[dict]:
    import config
    url = f"{config.SUPABASE_URL}/rest/v1/brain_schedule?select=*"
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(url, headers=_svc_headers())
            r.raise_for_status()
            return r.json()
    except Exception as e:
        log.warning("scheduler: failed to fetch schedule: %s", e)
        return []


async def _update_last_run(agent: str) -> None:
    import config
    url = f"{config.SUPABASE_URL}/rest/v1/brain_schedule?agent=eq.{agent}"
    headers = {**_svc_headers(), "Prefer": "return=minimal"}
    now = datetime.now(timezone.utc).isoformat()
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            await c.patch(url, headers=headers, json={"last_run_at": now})
    except Exception as e:
        log.warning("scheduler: failed to update last_run for %s: %s", agent, e)


def _is_due(cron_expr: str, last_run_at: Optional[str]) -> bool:
    """Return True if the agent should run now based on cron + last run time."""
    try:
        from croniter import croniter
        now = datetime.now(timezone.utc)
        cron = croniter(cron_expr, now)
        prev = cron.get_prev(datetime)

        if last_run_at is None:
            return True  # Never run — run now

        last_dt = datetime.fromisoformat(last_run_at.replace("Z", "+00:00"))
        return last_dt < prev
    except Exception as e:
        log.warning("scheduler: _is_due error for cron '%s': %s", cron_expr, e)
        return False


async def trigger_agent(agent: str) -> None:
    """Run the agent script in a subprocess."""
    script = _AGENT_SCRIPTS.get(agent)
    if not script or not script.exists():
        log.warning("scheduler: script not found for agent '%s': %s", agent, script)
        return

    # Unset CLAUDECODE so nested claude CLI spawns are allowed
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    log.info("scheduler: running agent '%s' via %s", agent, script)
    start_ms = int(asyncio.get_event_loop().time() * 1000)
    status = "completed"
    exit_code = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "bash", str(script),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)
        exit_code = proc.returncode
        if proc.returncode == 0:
            log.info("scheduler: agent '%s' completed successfully", agent)
        else:
            status = "failed"
            log.warning(
                "scheduler: agent '%s' exited %d. stderr: %s",
                agent, proc.returncode, stderr.decode()[:500]
            )
    except asyncio.TimeoutError:
        status = "failed"
        log.error("scheduler: agent '%s' timed out (600s)", agent)
    except Exception as e:
        status = "failed"
        log.error("scheduler: agent '%s' failed: %s", agent, e)

    duration_ms = int(asyncio.get_event_loop().time() * 1000) - start_ms
    try:
        log_audit(
            tier="execution",
            service="opai-brain",
            event="agent-run",
            status=status,
            summary=f"Brain agent '{agent}' — {status}",
            duration_ms=duration_ms,
            details={"agent": agent, "exit_code": exit_code},
        )
    except Exception:
        pass

    await _update_last_run(agent)


async def scheduler_loop() -> None:
    """Main scheduler loop — runs on a configurable interval."""
    log.info("scheduler: started (tick=%ds)", _scheduler_tick)
    while True:
        await asyncio.sleep(_scheduler_tick)
        if _scheduler_paused:
            continue
        try:
            rows = await _get_schedule()
            for row in rows:
                agent = row.get("agent")
                if not agent:
                    continue
                if not row.get("enabled"):
                    continue
                cron = row.get("cron_expr") or "0 9 * * *"
                last_run = row.get("last_run_at")
                if _is_due(cron, last_run):
                    log.info("scheduler: '%s' is due — triggering", agent)
                    asyncio.create_task(trigger_agent(agent))
        except Exception as e:
            log.error("scheduler: loop error: %s", e)
