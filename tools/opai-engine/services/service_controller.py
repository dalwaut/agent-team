"""OPAI Engine — Service control + agent management.

Migrated from opai-monitor/services.py. Handles systemctl operations,
agent process management, squad execution, and task delegation.
"""

import json
import subprocess
import time

import psutil

import config


def verify_auth(token: str | None) -> bool:
    """Check bearer token if AUTH_TOKEN is set."""
    if not config.AUTH_TOKEN:
        return True
    return token == config.AUTH_TOKEN


def kill_agent(pid: int) -> dict:
    """Kill a specific agent process by PID."""
    try:
        proc = psutil.Process(pid)
        cmdline = " ".join(proc.cmdline())
        if not any(cn in cmdline for cn in config.CLAUDE_PROCESS_NAMES):
            if proc.name() not in config.CLAUDE_PROCESS_NAMES:
                return {"success": False, "error": "PID is not a claude process"}

        proc.terminate()
        try:
            proc.wait(timeout=5)
        except psutil.TimeoutExpired:
            proc.kill()

        return {"success": True, "pid": pid, "action": "killed"}
    except psutil.NoSuchProcess:
        return {"success": False, "error": f"Process {pid} not found"}
    except psutil.AccessDenied:
        return {"success": False, "error": f"Permission denied for PID {pid}"}


def kill_all_agents() -> dict:
    """Emergency stop — kill all claude agent processes."""
    killed = []
    errors = []

    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            info = proc.info
            name = info.get("name", "")
            cmdline = " ".join(info.get("cmdline") or [])

            is_claude = (
                name in config.CLAUDE_PROCESS_NAMES
                or any(cn in cmdline for cn in config.CLAUDE_PROCESS_NAMES)
            )
            if not is_claude:
                continue

            pid = info["pid"]
            proc.terminate()
            killed.append(pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
            errors.append(str(e))

    time.sleep(3)
    for pid in killed:
        try:
            p = psutil.Process(pid)
            if p.is_running():
                p.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    return {
        "success": True,
        "killed": killed,
        "count": len(killed),
        "errors": errors,
    }


def control_service(name: str, action: str) -> dict:
    """Start/stop/restart a systemd user service."""
    if action not in ("start", "stop", "restart"):
        return {"success": False, "error": f"Invalid action: {action}"}

    allowed = config.SYSTEMD_SERVICES + [f"{t}.timer" for t in config.SYSTEMD_TIMERS]
    if name not in allowed:
        return {"success": False, "error": f"Unknown service: {name}"}

    unit = name if "." in name else f"{name}.service"
    try:
        result = subprocess.run(
            ["systemctl", "--user", action, unit],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0:
            return {"success": True, "service": name, "action": action}
        return {
            "success": False,
            "error": result.stderr.strip() or f"Exit code {result.returncode}",
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Command timed out"}
    except FileNotFoundError:
        return {"success": False, "error": "systemctl not found"}


def start_all_services() -> dict:
    """Start all enabled services that are not currently running."""
    all_units = config.SYSTEMD_SERVICES + [f"{t}.timer" for t in config.SYSTEMD_TIMERS]
    started = []
    already_running = []
    errors = []

    for unit in all_units:
        svc_name = unit if "." in unit else f"{unit}.service"
        try:
            active_check = subprocess.run(
                ["systemctl", "--user", "is-active", svc_name],
                capture_output=True, text=True, timeout=5,
            )
            is_active = active_check.stdout.strip() == "active"

            if is_active:
                already_running.append(unit)
                continue

            result = subprocess.run(
                ["systemctl", "--user", "start", svc_name],
                capture_output=True, text=True, timeout=15,
            )
            if result.returncode == 0:
                started.append(unit)
            else:
                errors.append({"unit": unit, "error": result.stderr.strip()})
        except subprocess.TimeoutExpired:
            errors.append({"unit": unit, "error": "timeout"})
        except FileNotFoundError:
            errors.append({"unit": unit, "error": "systemctl not found"})

    return {
        "success": len(errors) == 0,
        "started": started,
        "already_running": already_running,
        "errors": errors,
    }


def run_task_squad(task_id: str, squad: str | None = None) -> dict:
    """Trigger a squad run for a specific task from the registry."""
    from datetime import datetime

    try:
        registry = json.loads(config.REGISTRY_JSON.read_text()) if config.REGISTRY_JSON.is_file() else {"tasks": {}}
    except (json.JSONDecodeError, OSError):
        return {"success": False, "error": "Failed to read registry"}

    task = registry["tasks"].get(task_id)
    if not task:
        return {"success": False, "error": f"Task {task_id} not found"}

    target_squad = squad or (task.get("routing", {}).get("squads") or [None])[0]
    if not target_squad:
        return {"success": False, "error": f"No squad configured for task {task_id}. Provide a squad parameter."}

    task["status"] = "running"
    task["updatedAt"] = datetime.now().isoformat() + "Z"
    config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2))

    script = config.SCRIPTS_DIR / "run_squad.sh"
    if not script.is_file():
        return {"success": False, "error": "run_squad.sh not found"}

    try:
        proc = subprocess.Popen(
            ["bash", str(script), "-s", target_squad, "--skip-preflight"],
            cwd=str(config.OPAI_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {
            "success": True,
            "task_id": task_id,
            "squad": target_squad,
            "pid": proc.pid,
        }
    except OSError as e:
        return {"success": False, "error": str(e)}


def delegate_task(task_id: str) -> dict:
    """Delegate a registry task to agents — auto-route and set assignee."""
    from datetime import datetime

    try:
        registry = json.loads(config.REGISTRY_JSON.read_text()) if config.REGISTRY_JSON.is_file() else {"tasks": {}}
    except (json.JSONDecodeError, OSError):
        return {"success": False, "error": "Failed to read registry"}

    task = registry["tasks"].get(task_id)
    if not task:
        return {"success": False, "error": f"Task {task_id} not found"}
    if task.get("status") in ("completed", "cancelled"):
        return {"success": False, "error": f"Task {task_id} is already {task['status']}"}

    task["assignee"] = "agent"
    task["status"] = "scheduled"
    task["updatedAt"] = datetime.now().isoformat() + "Z"

    if not task.get("routing") or not task["routing"].get("squads"):
        try:
            wc_script = config.TOOLS_DIR / "work-companion" / "index.js"
            result = subprocess.run(
                ["node", "-e", f"""
                    const wc = require('{wc_script}');
                    const c = wc.classifyTask({json.dumps(task['title'] + ' ' + (task.get('description') or ''))});
                    const r = wc.routeTask(c);
                    console.log(JSON.stringify({{type: c.type, squads: r.squads, mode: r.mode}}));
                """],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                routing = json.loads(result.stdout.strip())
                task["routing"] = routing
        except Exception:
            task["routing"] = task.get("routing") or {"type": "unknown", "squads": ["review"], "mode": "propose"}

    config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2))
    return {"success": True, "task_id": task_id, "routing": task.get("routing")}


def get_task_settings() -> dict:
    """Read task processor settings from orchestrator config."""
    try:
        data = json.loads(config.ORCHESTRATOR_JSON.read_text()) if config.ORCHESTRATOR_JSON.is_file() else {}
    except (json.JSONDecodeError, OSError):
        data = {}
    tp = data.get("task_processor", {})
    return {
        "auto_execute": tp.get("auto_execute", False),
        "max_squad_runs_per_cycle": tp.get("max_squad_runs_per_cycle", 2),
        "cooldown_minutes": tp.get("cooldown_minutes", 30),
    }


def update_task_settings(auto_execute=None, max_squad_runs_per_cycle=None, cooldown_minutes=None) -> dict:
    """Update task processor settings in orchestrator config."""
    try:
        data = json.loads(config.ORCHESTRATOR_JSON.read_text()) if config.ORCHESTRATOR_JSON.is_file() else {}
    except (json.JSONDecodeError, OSError):
        data = {}

    tp = data.setdefault("task_processor", {})
    if auto_execute is not None:
        tp["auto_execute"] = auto_execute
    if max_squad_runs_per_cycle is not None:
        tp["max_squad_runs_per_cycle"] = max_squad_runs_per_cycle
    if cooldown_minutes is not None:
        tp["cooldown_minutes"] = cooldown_minutes

    config.ORCHESTRATOR_JSON.write_text(json.dumps(data, indent=2))
    return {"success": True, "settings": tp}


def process_queue() -> dict:
    """Trigger process_queue.sh."""
    script = config.SCRIPTS_DIR / "process_queue.sh"
    if not script.is_file():
        return {"success": False, "error": "process_queue.sh not found"}

    try:
        result = subprocess.run(
            ["bash", str(script)],
            capture_output=True, text=True, timeout=60,
            cwd=str(config.OPAI_ROOT),
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout[-2000:] if result.stdout else "",
            "stderr": result.stderr[-500:] if result.stderr else "",
            "exit_code": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Script timed out after 60s"}
