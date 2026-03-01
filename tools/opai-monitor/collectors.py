"""OPAI Monitor — Read-only data collectors."""

import glob
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

import psutil

import config


# ── System Stats ──────────────────────────────────────────

def get_system_stats() -> dict:
    """CPU, RAM, disk, load averages, network, uptime.

    Disk stats report the /workspace NVMe as primary (where OPAI data lives)
    and the system root / as secondary.
    """
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk_workspace = psutil.disk_usage("/workspace")
    disk_system = psutil.disk_usage("/")
    net = psutil.net_io_counters()
    boot = psutil.boot_time()

    return {
        "cpu_percent": psutil.cpu_percent(interval=0),
        "cpu_count": psutil.cpu_count(),
        "cpu_freq": psutil.cpu_freq()._asdict() if psutil.cpu_freq() else None,
        "load_avg": list(os.getloadavg()),
        "memory": {
            "total": mem.total,
            "used": mem.used,
            "available": mem.available,
            "percent": mem.percent,
        },
        "swap": {
            "total": swap.total,
            "used": swap.used,
            "free": swap.free,
            "percent": swap.percent,
        },
        "disk": {
            "mount": "/workspace",
            "label": "NVMe",
            "total": disk_workspace.total,
            "used": disk_workspace.used,
            "free": disk_workspace.free,
            "percent": disk_workspace.percent,
        },
        "disk_system": {
            "mount": "/",
            "label": "System",
            "total": disk_system.total,
            "used": disk_system.used,
            "free": disk_system.free,
            "percent": disk_system.percent,
        },
        "network": {
            "bytes_sent": net.bytes_sent,
            "bytes_recv": net.bytes_recv,
        },
        "process_count": len(psutil.pids()),
        "uptime_seconds": int(time.time() - boot),
        "timestamp": datetime.now().isoformat(),
    }


# ── Agent Detection ───────────────────────────────────────

def _read_proc_cmdline(pid: int) -> list[str]:
    """Read /proc/{pid}/cmdline safely."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().decode("utf-8", errors="replace").split("\0")
    except (OSError, PermissionError):
        return []


def _map_temp_files() -> dict[int, str]:
    """Map PIDs to claude temp file names via /proc/fd symlinks."""
    pid_to_name: dict[int, str] = {}
    temp_files = glob.glob(config.CLAUDE_TEMP_PATTERN)

    for tf in temp_files:
        basename = Path(tf).name
        # Extract agent name: claude_prompt_{name}.XXXXXX
        match = re.match(r"claude_prompt_(.+)\.\w{6}$", basename)
        agent_name = match.group(1) if match else basename

        # Find which PID has this file open
        for proc in psutil.process_iter(["pid"]):
            try:
                pid = proc.info["pid"]
                fd_dir = f"/proc/{pid}/fd"
                if not os.path.isdir(fd_dir):
                    continue
                for fd in os.listdir(fd_dir):
                    try:
                        link = os.readlink(os.path.join(fd_dir, fd))
                        if link == tf:
                            pid_to_name[pid] = agent_name
                    except (OSError, PermissionError):
                        continue
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

    return pid_to_name


def get_running_agents() -> list[dict]:
    """Detect running claude agent processes."""
    agents = []
    temp_map = _map_temp_files()

    for proc in psutil.process_iter(["pid", "name", "cmdline", "cpu_percent",
                                      "memory_percent", "create_time", "status"]):
        try:
            info = proc.info
            name = info.get("name", "")
            cmdline = info.get("cmdline") or []
            cmdline_str = " ".join(cmdline)

            # Match actual claude CLI processes — strict filtering
            is_claude = False
            if name in config.CLAUDE_PROCESS_NAMES:
                is_claude = True
            elif cmdline and cmdline[0].endswith("/claude"):
                is_claude = True

            if not is_claude:
                continue

            # Skip Claude Desktop electron/wrapper processes
            if "electron" in cmdline_str or "claude-desktop" in cmdline_str:
                continue

            pid = info["pid"]
            agent_name = temp_map.get(pid, "")

            # Try to extract prompt name from -p flag
            if not agent_name and "-p" in cmdline:
                idx = cmdline.index("-p")
                if idx + 1 < len(cmdline):
                    agent_name = cmdline[idx + 1]

            # Derive name from prompt file in cmdline
            if not agent_name:
                for arg in cmdline:
                    if "prompt_" in arg:
                        match = re.search(r"prompt_(\w+)", arg)
                        if match:
                            agent_name = match.group(1)
                            break

            agents.append({
                "pid": pid,
                "name": agent_name or f"claude-{pid}",
                "cmdline": cmdline_str[:200],
                "cpu_percent": info.get("cpu_percent", 0),
                "memory_percent": round(info.get("memory_percent", 0), 1),
                "status": info.get("status", "unknown"),
                "uptime_seconds": int(time.time() - info.get("create_time", time.time())),
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return agents


def get_agent_detail(pid: int) -> dict | None:
    """Get detailed info for a single claude agent process."""
    try:
        proc = psutil.Process(pid)
        info = proc.as_dict(attrs=[
            "pid", "name", "cmdline", "cpu_percent", "memory_percent",
            "create_time", "status", "cwd", "memory_info", "num_fds",
            "num_threads",
        ])
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None

    cmdline = info.get("cmdline") or []
    cmdline_str = " ".join(cmdline)

    # Verify it's an actual claude CLI process (not Claude Desktop)
    name = info.get("name", "")
    is_claude = (name in config.CLAUDE_PROCESS_NAMES or
                 (cmdline and cmdline[0].endswith("/claude")))
    if not is_claude:
        return None
    if "electron" in cmdline_str or "claude-desktop" in cmdline_str:
        return None

    # Extract agent name (same logic as get_running_agents)
    temp_map = _map_temp_files()
    agent_name = temp_map.get(pid, "")
    if not agent_name and "-p" in cmdline:
        idx = cmdline.index("-p")
        if idx + 1 < len(cmdline):
            agent_name = cmdline[idx + 1]
    if not agent_name:
        for arg in cmdline:
            if "prompt_" in arg:
                match = re.search(r"prompt_(\w+)", arg)
                if match:
                    agent_name = match.group(1)
                    break

    mem_info = info.get("memory_info")
    return {
        "pid": pid,
        "name": agent_name or f"claude-{pid}",
        "cmdline": cmdline_str,
        "cmdline_args": cmdline,
        "cpu_percent": info.get("cpu_percent", 0),
        "memory_percent": round(info.get("memory_percent", 0), 1),
        "memory_rss": mem_info.rss if mem_info else 0,
        "memory_vms": mem_info.vms if mem_info else 0,
        "status": info.get("status", "unknown"),
        "cwd": info.get("cwd", ""),
        "num_fds": info.get("num_fds", 0),
        "num_threads": info.get("num_threads", 0),
        "uptime_seconds": int(time.time() - info.get("create_time", time.time())),
        "started_at": datetime.fromtimestamp(info.get("create_time", 0)).isoformat(),
    }


# ── Squad / Orchestrator Status ───────────────────────────

def get_orchestrator_state() -> dict | None:
    """Read orchestrator-state.json."""
    try:
        return json.loads(config.ORCHESTRATOR_STATE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def get_squad_status() -> dict:
    """Build squad status from orchestrator state + team.json."""
    state = get_orchestrator_state()
    team = get_team()
    result = {
        "orchestrator": state,
        "active_squad": None,
        "available_squads": list(team.get("squads", {}).keys()) if team else [],
    }

    if state and state.get("activeJobs"):
        # Infer active squad from job types
        jobs = state["activeJobs"]
        result["active_jobs"] = [
            {"id": k, **v} for k, v in jobs.items()
        ]

    return result


def get_team() -> dict | None:
    """Read team.json."""
    try:
        return json.loads(config.TEAM_JSON.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


# ── Reports ───────────────────────────────────────────────
# Operational reports live at /workspace/reports/ (agent output, HITL, archive).
# Framework-internal reports at /workspace/synced/opai/reports/ are reference
# copies used by the evolve/updater cycle, not the primary dashboard source.

# Subdirectories inside REPORTS_DIR that are not date-based
_REPORT_SPECIAL_DIRS = {"latest", "Archive", "HITL"}


def _report_entry(f: Path, date: str | None) -> dict:
    """Build a report metadata dict from a file path."""
    stat = f.stat()
    return {
        "date": date,
        "filename": f.name,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


def list_report_dates() -> list[str]:
    """List available report date directories, newest first."""
    dates = []
    if config.REPORTS_DIR.is_dir():
        for entry in sorted(config.REPORTS_DIR.iterdir(), reverse=True):
            if entry.is_dir() and re.match(r"\d{4}-\d{2}-\d{2}", entry.name):
                dates.append(entry.name)
    return dates


def list_reports(date: str | None = None) -> list[dict]:
    """List reports from /workspace/reports/, optionally filtered by date.

    Special virtual dates:
      "latest"  → reports/latest/
      "archive" → reports/Archive/
      "hitl"    → reports/HITL/
    """
    reports = []

    if date:
        # Map virtual names to actual directories
        dir_map = {"latest": config.REPORTS_LATEST,
                   "archive": config.REPORTS_ARCHIVE,
                   "hitl": config.REPORTS_HITL}
        report_dir = dir_map.get(date, config.REPORTS_DIR / date)

        if report_dir.is_dir():
            for f in sorted(report_dir.iterdir()):
                if f.is_file():
                    reports.append(_report_entry(f, date))
    else:
        # Date-based directories
        for entry in sorted(config.REPORTS_DIR.iterdir(), reverse=True):
            if entry.is_dir() and re.match(r"\d{4}-\d{2}-\d{2}", entry.name):
                for f in sorted(entry.iterdir()):
                    if f.is_file():
                        reports.append(_report_entry(f, entry.name))
            elif entry.is_file() and entry.suffix == ".md":
                reports.append(_report_entry(entry, None))

        # Include HITL and Archive if they have files
        for label, special_dir in [("hitl", config.REPORTS_HITL),
                                   ("archive", config.REPORTS_ARCHIVE)]:
            if special_dir.is_dir():
                for f in sorted(special_dir.iterdir()):
                    if f.is_file():
                        reports.append(_report_entry(f, label))

    return reports


def read_report(date: str, filename: str) -> str | None:
    """Read a specific report file.

    Supports date dirs, "latest", "archive", "hitl", and standalone files.
    """
    dir_map = {
        "latest": config.REPORTS_LATEST,
        "archive": config.REPORTS_ARCHIVE,
        "hitl": config.REPORTS_HITL,
    }
    base = dir_map.get(date)
    if base:
        path = base / filename
    else:
        path = config.REPORTS_DIR / date / filename

    # Prevent path traversal
    try:
        path = path.resolve()
        if not str(path).startswith(str(config.REPORTS_DIR.resolve())):
            return None
    except (ValueError, OSError):
        return None
    if path.is_file():
        return path.read_text(errors="replace")
    return None


def get_latest_reports() -> list[dict]:
    """List reports in latest/ directory."""
    reports = []
    if config.REPORTS_LATEST.is_dir():
        for f in sorted(config.REPORTS_LATEST.iterdir()):
            if f.is_file():
                reports.append(_report_entry(f, "latest"))
    return reports


# ── Task Queue ────────────────────────────────────────────

def get_task_queue() -> dict | None:
    """Read tasks/queue.json."""
    try:
        return json.loads(config.QUEUE_JSON.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def get_task_registry_summary() -> dict:
    """Read tasks/registry.json and return summary stats."""
    try:
        data = json.loads(config.REGISTRY_JSON.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"total": 0, "by_status": {}, "by_priority": {}}

    tasks = data if isinstance(data, dict) else {}
    # Registry is a dict of task_id -> task_obj
    by_status: dict[str, int] = {}
    by_priority: dict[str, int] = {}
    total = 0
    for tid, task in tasks.items():
        if not isinstance(task, dict) or tid in ("version", "schema", "meta"):
            continue
        total += 1
        status = task.get("status", "unknown")
        priority = task.get("priority", "unknown")
        by_status[status] = by_status.get(status, 0) + 1
        by_priority[priority] = by_priority.get(priority, 0) + 1

    return {"total": total, "by_status": by_status, "by_priority": by_priority}


def get_service_statuses() -> list[dict]:
    """Query systemd user unit statuses."""
    import subprocess

    services = []
    all_units = config.SYSTEMD_SERVICES + [f"{t}.timer" for t in config.SYSTEMD_TIMERS]

    for unit in all_units:
        svc_name = unit if "." in unit else f"{unit}.service"
        try:
            result = subprocess.run(
                ["systemctl", "--user", "show", svc_name,
                 "--property=ActiveState,SubState,LoadState,MainPID,Description"],
                capture_output=True, text=True, timeout=5,
            )
            props = {}
            for line in result.stdout.strip().split("\n"):
                if "=" in line:
                    k, v = line.split("=", 1)
                    props[k] = v

            services.append({
                "name": unit,
                "active": props.get("ActiveState", "unknown"),
                "sub": props.get("SubState", "unknown"),
                "load": props.get("LoadState", "unknown"),
                "pid": int(props.get("MainPID", 0)),
                "description": props.get("Description", ""),
            })
        except (subprocess.TimeoutExpired, FileNotFoundError):
            services.append({
                "name": unit,
                "active": "error",
                "sub": "timeout",
                "load": "unknown",
                "pid": 0,
                "description": "",
            })

    return services
