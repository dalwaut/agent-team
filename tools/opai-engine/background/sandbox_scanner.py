"""OPAI Engine — User sandbox scanner.

Rewrite of orchestrator.js scanUserSandboxes().
Scans /workspace/users/ for pending tasks and executes them.
"""

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path

import config

logger = logging.getLogger("opai-engine.sandbox-scanner")


async def scan_user_sandboxes(sandbox_config: dict):
    """Scan user sandboxes for pending tasks and execute them."""
    scan_root = Path(sandbox_config.get("scan_root", "/workspace/users"))
    max_user_jobs = sandbox_config.get("max_user_jobs_parallel", 2)
    timeout_sec = sandbox_config.get("timeout_seconds", 300)

    if not scan_root.is_dir():
        return

    try:
        user_dirs = [d for d in scan_root.iterdir()
                     if d.is_dir() and not d.is_symlink()]
    except (OSError, PermissionError):
        logger.error("Failed to read sandbox root: %s", scan_root)
        return

    tasks_picked = 0

    for user_dir in user_dirs:
        queue_file = user_dir / "tasks" / "queue.json"
        if not queue_file.is_file():
            continue

        try:
            queue = json.loads(queue_file.read_text())
        except (json.JSONDecodeError, OSError):
            continue

        tasks = queue.get("tasks", [])
        pending = [t for t in tasks if t.get("status") == "pending"]

        for task in pending:
            if tasks_picked >= max_user_jobs:
                break

            task_id = task.get("id", "unknown")
            logger.info("Picking up user task: %s from %s", task_id, user_dir.name)

            # Mark as running
            task["status"] = "running"
            task["updated_at"] = datetime.now().isoformat()
            queue_file.write_text(json.dumps(queue, indent=2))

            # Create entry in central registry
            try:
                registry = json.loads(config.REGISTRY_JSON.read_text()) if config.REGISTRY_JSON.is_file() else {"tasks": {}}
                registry["tasks"][task_id] = {
                    "id": task_id,
                    "title": task.get("title", ""),
                    "description": task.get("description", ""),
                    "status": "running",
                    "source": "user-sandbox",
                    "sourceRef": {
                        "user_id": task.get("source_user"),
                        "user_name": task.get("source_name"),
                        "sandbox_dir": str(user_dir),
                    },
                    "createdAt": task.get("created_at"),
                    "updatedAt": datetime.now().isoformat(),
                }
                registry["lastUpdated"] = datetime.now().isoformat()
                config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2))
            except Exception:
                pass

            # Execute in sandbox
            asyncio.create_task(_run_sandbox_task(
                task_id, user_dir, queue_file, timeout_sec
            ))
            tasks_picked += 1

    if tasks_picked > 0:
        logger.info("Sandbox scan: picked up %d user task(s)", tasks_picked)


async def _run_sandbox_task(task_id: str, sandbox_dir: Path,
                            queue_file: Path, timeout: int):
    """Execute a task inside a user sandbox."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "timeout", str(timeout), "claude", "-p", task_id,
            "--output-format", "text",
            cwd=str(sandbox_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        output = stdout.decode("utf-8", errors="replace")
        code = proc.returncode
    except Exception as e:
        output = str(e)
        code = 1

    # Write report
    report_dir = sandbox_dir / "reports" / "latest"
    try:
        report_dir.mkdir(parents=True, exist_ok=True)
        (report_dir / f"task-{task_id}.md").write_text(output or "(no output)")
    except OSError:
        pass

    # Update user queue
    try:
        queue = json.loads(queue_file.read_text())
        for t in queue.get("tasks", []):
            if t.get("id") == task_id:
                t["status"] = "completed" if code == 0 else "failed"
                t["updated_at"] = datetime.now().isoformat()
                t["exit_code"] = code
                break
        queue_file.write_text(json.dumps(queue, indent=2))
    except Exception:
        pass

    # Update central registry
    try:
        registry = json.loads(config.REGISTRY_JSON.read_text()) if config.REGISTRY_JSON.is_file() else {"tasks": {}}
        if task_id in registry.get("tasks", {}):
            registry["tasks"][task_id]["status"] = "completed" if code == 0 else "failed"
            registry["tasks"][task_id]["updatedAt"] = datetime.now().isoformat()
            config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2))
    except Exception:
        pass

    status = "completed" if code == 0 else "failed"
    logger.info("User task %s %s", task_id, status)
