"""OPAI Engine — Monitor endpoints (squads, reports, logs, team, tasks queue).

Migrated from opai-monitor/routes_api.py non-health section.
"""

import json

from fastapi import APIRouter, Depends, HTTPException

import config
from services import collectors
from services.service_controller import (
    run_task_squad, delegate_task, get_task_settings, update_task_settings,
    process_queue,
)
from services import log_reader
from auth import require_admin

router = APIRouter(prefix="/api")


# ── Squad ─────────────────────────────────────────────────

@router.get("/squad")
def squad_status():
    return collectors.get_squad_status()


# ── Reports ───────────────────────────────────────────────

@router.get("/reports")
def list_reports(date: str | None = None):
    return {
        "dates": collectors.list_report_dates(),
        "reports": collectors.list_reports(date),
    }


@router.get("/reports/latest")
def latest_reports():
    return collectors.get_latest_reports()


@router.get("/reports/{date}/{filename:path}")
def read_report(date: str, filename: str):
    content = collectors.read_report(date, filename)
    if content is None:
        raise HTTPException(404, "Report not found")
    return {"date": date, "filename": filename, "content": content}


# ── Logs ──────────────────────────────────────────────────

@router.get("/logs")
def recent_logs(limit: int = 100, source: str | None = None):
    return log_reader.get_recent_logs(limit, source)


# ── Tasks (Monitor-side: queue, registry summary, settings) ─

@router.get("/tasks/queue")
def task_queue():
    return collectors.get_task_queue()


@router.get("/tasks/registry/summary")
def task_registry_summary():
    return collectors.get_task_registry_summary()


@router.get("/tasks/registry")
def task_registry():
    """Return full task registry."""
    try:
        if config.REGISTRY_JSON.is_file():
            return json.loads(config.REGISTRY_JSON.read_text())
        return {"tasks": {}}
    except (json.JSONDecodeError, OSError):
        return {"tasks": {}}


@router.post("/tasks/registry/{task_id}/run", dependencies=[Depends(require_admin)])
def run_task(task_id: str, squad: str | None = None):
    result = run_task_squad(task_id, squad)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


@router.post("/tasks/registry/{task_id}/delegate", dependencies=[Depends(require_admin)])
def delegate_task_endpoint(task_id: str):
    result = delegate_task(task_id)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


@router.post("/tasks/registry/{task_id}/complete", dependencies=[Depends(require_admin)])
def complete_task(task_id: str):
    from datetime import datetime, timezone
    try:
        registry = json.loads(config.REGISTRY_JSON.read_text()) if config.REGISTRY_JSON.is_file() else {"tasks": {}}
    except (json.JSONDecodeError, OSError):
        raise HTTPException(500, "Failed to read registry")
    task = registry["tasks"].get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    task["status"] = "completed"
    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    task["completedAt"] = datetime.now(timezone.utc).isoformat()
    config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2))
    return {"success": True, "task_id": task_id}


@router.get("/tasks/settings")
def task_settings():
    return get_task_settings()


@router.post("/tasks/settings", dependencies=[Depends(require_admin)])
def update_task_settings_endpoint(
    auto_execute: bool | None = None,
    max_squad_runs_per_cycle: int | None = None,
    cooldown_minutes: int | None = None,
):
    result = update_task_settings(auto_execute, max_squad_runs_per_cycle, cooldown_minutes)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Failed to update settings"))
    return result


@router.post("/tasks/queue/process", dependencies=[Depends(require_admin)])
def process_queue_endpoint():
    result = process_queue()
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Queue processing failed"))
    return result


# ── Team ──────────────────────────────────────────────────

@router.get("/team")
def team_info():
    team = collectors.get_team()
    if not team:
        raise HTTPException(404, "team.json not found")
    return team
