"""Executor — triggers squad/agent runs via run_squad.sh, tracks history."""

import asyncio
import json
import os
import subprocess
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional

import config

# ── Run State ─────────────────────────────────────────

_active_runs: dict[str, dict] = {}
_run_history: list[dict] = []
_MAX_HISTORY = 100
_triggered_set: set[str] = set()  # Cycle guard for following triggers

SQUAD_SCRIPT = config.WORKSPACE_ROOT / "scripts" / "run_squad.sh"


def _now_iso():
    return datetime.now().isoformat(timespec="seconds")


def _today():
    return datetime.now().strftime("%Y-%m-%d")


# ── Trigger Runs ──────────────────────────────────────

async def run_squad(squad_name: str, user=None) -> dict:
    """Trigger a squad run asynchronously. Returns run metadata."""
    run_id = f"run-{squad_name}-{int(time.time())}"

    if run_id in _active_runs:
        raise ValueError("A run with this ID already exists")

    # Check if squad exists
    from services.squad_manager import get_squad
    squad = get_squad(squad_name, user)
    if not squad:
        raise ValueError(f"Squad '{squad_name}' not found")

    # Determine working directory and script
    if user and not user.is_admin:
        # Sandbox users — run in their sandbox
        cwd = Path(user.sandbox_path) if user.sandbox_path else config.WORKSPACE_ROOT
    else:
        cwd = config.WORKSPACE_ROOT

    run_meta = {
        "id": run_id,
        "type": "squad",
        "squad": squad_name,
        "agents": [a["id"] for a in squad["agents"]],
        "status": "running",
        "started_at": _now_iso(),
        "finished_at": None,
        "duration_seconds": None,
        "output": "",
        "error": None,
        "triggered_by": user.display_name if user else "system",
    }

    _active_runs[run_id] = run_meta

    # Launch async
    asyncio.create_task(_execute_squad(run_id, squad_name, cwd))
    return run_meta


async def run_agent(agent_name: str, user=None) -> dict:
    """Trigger a single agent run."""
    run_id = f"run-{agent_name}-{int(time.time())}"

    from services.agent_manager import get_agent
    agent = get_agent(agent_name, user)
    if not agent:
        raise ValueError(f"Agent '{agent_name}' not found")

    if user and not user.is_admin:
        cwd = Path(user.sandbox_path) if user.sandbox_path else config.WORKSPACE_ROOT
    else:
        cwd = config.WORKSPACE_ROOT

    run_meta = {
        "id": run_id,
        "type": "agent",
        "squad": None,
        "agents": [agent_name],
        "status": "running",
        "started_at": _now_iso(),
        "finished_at": None,
        "duration_seconds": None,
        "output": "",
        "error": None,
        "triggered_by": user.display_name if user else "system",
    }

    _active_runs[run_id] = run_meta
    asyncio.create_task(_execute_agent(run_id, agent_name, cwd))
    return run_meta


async def _execute_squad(run_id: str, squad_name: str, cwd: Path):
    """Execute run_squad.sh in a subprocess."""
    start = time.time()
    run = _active_runs.get(run_id)
    if not run:
        return

    try:
        script = str(SQUAD_SCRIPT)
        if not SQUAD_SCRIPT.is_file():
            raise FileNotFoundError(f"Squad script not found: {script}")

        proc = await asyncio.create_subprocess_exec(
            "bash", script, "-s", squad_name,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "OPAI_ROOT": str(config.WORKSPACE_ROOT)},
        )

        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=600)
        output = stdout.decode("utf-8", errors="replace") if stdout else ""

        run["output"] = output[-5000:]  # Keep last 5000 chars
        run["status"] = "completed" if proc.returncode == 0 else "failed"
        if proc.returncode != 0:
            run["error"] = f"Exit code {proc.returncode}"

    except asyncio.TimeoutError:
        run["status"] = "timeout"
        run["error"] = "Run exceeded 10 minute timeout"
    except Exception as e:
        run["status"] = "failed"
        run["error"] = str(e)
    finally:
        run["finished_at"] = _now_iso()
        run["duration_seconds"] = round(time.time() - start, 1)
        # Move from active to history
        _active_runs.pop(run_id, None)
        _run_history.insert(0, run)
        if len(_run_history) > _MAX_HISTORY:
            _run_history.pop()
        # Check following triggers
        success = run.get("status") == "completed"
        asyncio.create_task(_check_following_triggers(squad_name, "squad", success))


async def _execute_agent(run_id: str, agent_name: str, cwd: Path):
    """Execute a single agent via run_agents_seq or direct claude -p."""
    start = time.time()
    run = _active_runs.get(run_id)
    if not run:
        return

    try:
        # Use run_squad.sh with a single-agent squad approach, or run_agents_seq
        seq_script = config.WORKSPACE_ROOT / "scripts" / "run_agents_seq.sh"
        if seq_script.is_file():
            proc = await asyncio.create_subprocess_exec(
                "bash", str(seq_script), "-f", agent_name,
                cwd=str(cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env={**os.environ, "OPAI_ROOT": str(config.WORKSPACE_ROOT)},
            )
        else:
            # Fallback: run_squad.sh won't work for single agent
            # Just mark as not supported
            run["status"] = "failed"
            run["error"] = "Single agent execution not available (no run_agents_seq.sh)"
            run["finished_at"] = _now_iso()
            run["duration_seconds"] = 0
            _active_runs.pop(run_id, None)
            _run_history.insert(0, run)
            return

        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
        output = stdout.decode("utf-8", errors="replace") if stdout else ""

        run["output"] = output[-5000:]
        run["status"] = "completed" if proc.returncode == 0 else "failed"
        if proc.returncode != 0:
            run["error"] = f"Exit code {proc.returncode}"

    except asyncio.TimeoutError:
        run["status"] = "timeout"
        run["error"] = "Run exceeded 5 minute timeout"
    except Exception as e:
        run["status"] = "failed"
        run["error"] = str(e)
    finally:
        run["finished_at"] = _now_iso()
        run["duration_seconds"] = round(time.time() - start, 1)
        _active_runs.pop(run_id, None)
        _run_history.insert(0, run)
        if len(_run_history) > _MAX_HISTORY:
            _run_history.pop()
        # Check following triggers
        success = run.get("status") == "completed"
        asyncio.create_task(_check_following_triggers(agent_name, "agent", success))


async def _check_following_triggers(completed_name: str, completed_type: str, success: bool):
    """Check if any workflows have following triggers that match this completion."""
    from services.workflow_manager import list_workflows

    trigger_key = f"{completed_type}:{completed_name}"
    if trigger_key in _triggered_set:
        return  # Cycle guard
    _triggered_set.add(trigger_key)

    try:
        workflows = list_workflows()
        for wf in workflows:
            triggers = wf.get("triggers", {})
            following = triggers.get("following", [])
            for ft in following:
                if ft.get("follows") != completed_name:
                    continue
                if ft.get("follows_type") != completed_type:
                    continue
                trigger_on = ft.get("trigger_on", "any")
                if trigger_on == "success" and not success:
                    continue
                if trigger_on == "failure" and success:
                    continue
                # Match — execute workflow steps sequentially
                steps = wf.get("steps", [])
                for step in steps:
                    squad_name = step.get("squad")
                    if squad_name:
                        try:
                            await run_squad(squad_name)
                        except Exception:
                            if step.get("on_fail", "stop") == "stop":
                                break
    finally:
        _triggered_set.discard(trigger_key)


def cancel_run(run_id: str) -> bool:
    """Cancel an active run (best-effort)."""
    run = _active_runs.get(run_id)
    if not run:
        return False
    run["status"] = "cancelled"
    run["finished_at"] = _now_iso()
    run["error"] = "Cancelled by user"
    _active_runs.pop(run_id, None)
    _run_history.insert(0, run)
    return True


# ── Queries ───────────────────────────────────────────

def get_active_runs() -> list[dict]:
    """Return all currently running jobs."""
    return list(_active_runs.values())


def get_run_history(limit: int = 50) -> list[dict]:
    """Return recent completed runs."""
    return _run_history[:limit]


def get_run(run_id: str) -> Optional[dict]:
    """Get a specific run by ID."""
    if run_id in _active_runs:
        return _active_runs[run_id]
    for run in _run_history:
        if run["id"] == run_id:
            return run
    return None


# ── Reports ───────────────────────────────────────────

def list_report_dates() -> list[str]:
    """List all report date directories."""
    reports_dir = config.REPORTS_DIR
    if not reports_dir.is_dir():
        return []
    dates = []
    for d in sorted(reports_dir.iterdir(), reverse=True):
        if d.is_dir() and d.name not in ("latest", "HITL", "Archive"):
            dates.append(d.name)
    return dates[:30]


def list_reports(date: str = "latest") -> list[dict]:
    """List reports in a specific date directory or 'latest'."""
    reports_dir = config.REPORTS_DIR / date
    if not reports_dir.is_dir():
        return []

    reports = []
    for f in sorted(reports_dir.iterdir()):
        if f.suffix == ".md" and f.is_file():
            stat = f.stat()
            reports.append({
                "name": f.stem,
                "file": f.name,
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                "date": date,
            })
    return reports


def read_report(date: str, name: str) -> Optional[dict]:
    """Read a specific report's content."""
    # Sanitize
    if ".." in name or "/" in name or "\\" in name:
        return None

    if not name.endswith(".md"):
        name = name + ".md"

    report_path = config.REPORTS_DIR / date / name
    if not report_path.is_file():
        return None

    content = report_path.read_text(encoding="utf-8", errors="replace")
    stat = report_path.stat()

    return {
        "name": report_path.stem,
        "file": report_path.name,
        "date": date,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "content": content,
    }
