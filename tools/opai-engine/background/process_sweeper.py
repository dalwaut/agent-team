"""OPAI Engine — Stale process sweeper.

Periodically scans for orphaned OPAI-related processes (zombie claude sessions,
rogue caddy runs, detached bash shells) and terminates them safely.

Safety guarantees — never kills:
  - Processes with a TTY (active terminal sessions)
  - Processes whose parent chain includes a TTY
  - Systemd service main PIDs
  - Engine-managed workers (worker_manager._managed_procs / task_processes)
  - PID 1, kernel threads, the engine process itself
"""

import asyncio
import logging
import os
import signal
import time

import psutil

import config
from audit import log_audit

logger = logging.getLogger("opai-engine.process-sweeper")

# Process names we consider OPAI-related
OPAI_PROCESS_NAMES = {"claude", "claude-code", "python3", "python", "node", "bash", "caddy"}

# Command-line keywords that mark a process as OPAI-related
OPAI_CMD_KEYWORDS = {"opai", "claude", "/workspace/synced/opai", "caddy run"}

# PIDs that must never be killed
ALWAYS_PROTECTED = {1, os.getpid()}


def _get_sweeper_config() -> dict:
    """Load process_sweeper config from orchestrator.json."""
    orch = config.load_orchestrator_config()
    return orch.get("process_sweeper", {})


def _get_systemd_main_pids() -> set[int]:
    """Fetch MainPID for all OPAI systemd services."""
    pids = set()
    for svc in config.SYSTEMD_SERVICES:
        try:
            result = os.popen(
                f"systemctl --user show {svc} --property=MainPID --value 2>/dev/null"
            ).read().strip()
            if result and result != "0":
                pids.add(int(result))
        except (ValueError, OSError):
            pass
    return pids


def _get_managed_pids(worker_manager=None) -> set[int]:
    """Collect PIDs from the worker manager's tracked processes."""
    pids = set()
    if worker_manager is None:
        return pids
    # Engine-managed long-running procs
    for proc in getattr(worker_manager, "_managed_procs", {}).values():
        try:
            if hasattr(proc, "pid") and proc.pid:
                pids.add(proc.pid)
        except Exception:
            pass
    # Active task worker procs
    for proc in getattr(worker_manager, "task_processes", {}).values():
        try:
            if hasattr(proc, "pid") and proc.pid:
                pids.add(proc.pid)
        except Exception:
            pass
    return pids


def _has_tty_ancestor(proc: psutil.Process) -> bool:
    """Check if process or any ancestor has a TTY."""
    try:
        if proc.terminal():
            return True
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False

    visited = {proc.pid}
    current = proc
    for _ in range(20):  # depth limit
        try:
            parent = current.parent()
            if parent is None or parent.pid in visited or parent.pid <= 1:
                break
            visited.add(parent.pid)
            if parent.terminal():
                return True
            current = parent
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            break
    return False


def _is_opai_related(proc: psutil.Process) -> bool:
    """Check if a process is OPAI-related by name or cmdline."""
    try:
        name = proc.name().lower()
        if name in OPAI_PROCESS_NAMES:
            cmdline = " ".join(proc.cmdline()).lower()
            return any(kw in cmdline for kw in OPAI_CMD_KEYWORDS)
        return False
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def _is_stale(proc: psutil.Process, min_age: float) -> bool:
    """Determine if a process is stale (orphaned/zombie and old enough)."""
    try:
        status = proc.status()
        ppid = proc.ppid()
        age = time.time() - proc.create_time()

        if age < min_age:
            return False

        # Zombie
        if status == psutil.STATUS_ZOMBIE:
            return True

        # Orphaned (adopted by init/systemd)
        if ppid == 1:
            return True

        # Parent dead
        try:
            parent = psutil.Process(ppid)
            if not parent.is_running():
                return True
        except psutil.NoSuchProcess:
            return True

        return False
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


async def sweep_stale_processes(worker_manager=None) -> dict:
    """Scan and kill stale OPAI-related processes.

    Returns dict with counts: scanned, found, killed, failed, skipped.
    """
    cfg = _get_sweeper_config()
    if not cfg.get("enabled", True):
        return {"scanned": 0, "found": 0, "killed": 0, "failed": 0, "skipped": 0, "status": "disabled"}

    min_age = cfg.get("min_age_seconds", 600)
    max_kills = cfg.get("max_kills_per_cycle", 10)
    sigterm_wait = cfg.get("sigterm_wait_seconds", 5)
    dry_run = cfg.get("dry_run", False)
    notify = cfg.get("notify_on_kill", True)

    # Build protected PID set
    protected = set(ALWAYS_PROTECTED)
    protected.update(_get_systemd_main_pids())
    protected.update(_get_managed_pids(worker_manager))

    scanned = 0
    stale_procs = []

    my_uid = os.getuid()

    for proc in psutil.process_iter(["pid", "name", "ppid", "status", "uids"]):
        try:
            # Only our own user's processes
            if proc.info["uids"] and proc.info["uids"].real != my_uid:
                continue

            scanned += 1

            if proc.pid in protected:
                continue

            if not _is_opai_related(proc):
                continue

            if _has_tty_ancestor(proc):
                continue

            if not _is_stale(proc, min_age):
                continue

            stale_procs.append(proc)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    killed = 0
    failed = 0
    skipped = 0

    for proc in stale_procs[:max_kills]:
        try:
            pid = proc.pid
            name = proc.name()
            cmdline_short = " ".join(proc.cmdline()[:4])
            age_min = (time.time() - proc.create_time()) / 60

            if dry_run:
                logger.info(
                    "[DRY RUN] Would kill PID %d (%s) age=%.0fm cmd=%s",
                    pid, name, age_min, cmdline_short,
                )
                skipped += 1
                continue

            # Audit before kill
            log_audit(
                tier="system",
                service="opai-engine",
                event="process-sweep",
                status="executing",
                summary=f"Killing stale process PID {pid} ({name})",
                details={
                    "pid": pid,
                    "name": name,
                    "cmdline": cmdline_short,
                    "age_minutes": round(age_min, 1),
                    "ppid": proc.ppid(),
                },
            )

            # SIGTERM first
            os.kill(pid, signal.SIGTERM)
            logger.info("Sent SIGTERM to PID %d (%s, age=%.0fm)", pid, name, age_min)

            # Wait for graceful exit
            try:
                proc.wait(timeout=sigterm_wait)
                killed += 1
                logger.info("PID %d exited after SIGTERM", pid)
            except psutil.TimeoutExpired:
                # SIGKILL fallback
                os.kill(pid, signal.SIGKILL)
                logger.warning("Sent SIGKILL to PID %d (SIGTERM timed out)", pid)
                try:
                    proc.wait(timeout=3)
                except psutil.TimeoutExpired:
                    pass
                killed += 1

        except psutil.NoSuchProcess:
            # Already gone
            killed += 1
        except (ProcessLookupError, PermissionError, OSError) as e:
            logger.error("Failed to kill PID %d: %s", proc.pid, e)
            failed += 1

    if len(stale_procs) > max_kills:
        skipped += len(stale_procs) - max_kills

    result = {
        "scanned": scanned,
        "found": len(stale_procs),
        "killed": killed,
        "failed": failed,
        "skipped": skipped,
        "status": "dry_run" if dry_run else "completed",
    }

    if stale_procs and not dry_run and notify:
        log_audit(
            tier="system",
            service="opai-engine",
            event="process-sweep-summary",
            status="completed",
            summary=f"Sweep complete: {killed} killed, {failed} failed, {skipped} skipped of {len(stale_procs)} stale",
            details=result,
        )

    return result


async def process_sweeper_loop(worker_manager=None):
    """Background loop — sweeps stale processes periodically."""
    logger.info("Process sweeper started")
    await asyncio.sleep(45)  # Let other services initialize

    while True:
        try:
            cfg = _get_sweeper_config()
            if not cfg.get("enabled", True):
                await asyncio.sleep(300)
                continue

            result = await sweep_stale_processes(worker_manager)
            level = logging.INFO if result["found"] == 0 else logging.WARNING
            logger.log(
                level,
                "Sweep: scanned=%d stale=%d killed=%d failed=%d",
                result["scanned"], result["found"], result["killed"], result["failed"],
            )
        except Exception as e:
            logger.error("Process sweeper error: %s", e)

        interval = _get_sweeper_config().get("interval_seconds", 300)
        await asyncio.sleep(interval)
