"""OPAI Monitor — REST API endpoints."""

import subprocess
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query

from . import collectors
from . import services
from . import log_reader
from . import session_collector
from . import config
from auth import require_admin, AuthUser

router = APIRouter(prefix="/api/monitor")

# Updater agent reference — set by TCP app.py during lifespan init
_updater = None


# ── Auth ──────────────────────────────────────────────────
# All monitor endpoints require admin role via Supabase JWT.
# Legacy bearer token auth kept as fallback for backward compat.

def require_auth(authorization: str | None = Header(None)):
    """Legacy bearer token auth for backward compat."""
    if not config.AUTH_TOKEN:
        return  # Dev mode
    if not authorization:
        raise HTTPException(401, "Authorization header required")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not services.verify_auth(token):
        raise HTTPException(403, "Invalid token")


# ── Health Summary ────────────────────────────────────────

# HTTP services to probe (name → port)
_HEALTH_SERVICES = {
    "chat": 8888,
    "tasks": 8081,
    "terminal": 8082,
    "messenger": 8083,
    "users": 8084,
    "dev": 8085,
    "files": 8086,
    "forum": 8087,
    "agents": 8088,
    "portal": 8090,
    "docs": 8091,
    "marketplace": 8092,
    "email-agent": 8093,
    "team-hub": 8089,
    "billing": 8094,
    "forumbot": 8095,
    "wordpress": 8096,
    "prd": 8097,
    "orchestra": 8098,
    "bot-space": 8099,
    "bx4": 8100,
    "brain": 8101,
    "helm": 8102,
    "marq": 8103,
    "dam": 8104,
}

# systemd-only services (no HTTP endpoint)
_SYSTEMD_ONLY = ["opai-discord-bot", "opai-orchestrator", "opai-email.timer"]


@router.get("/health/summary")
async def health_summary():
    """Aggregated health check across all OPAI services. No auth required."""
    results = {}
    overall = "healthy"

    async with httpx.AsyncClient(timeout=2.0) as client:
        for name, port in _HEALTH_SERVICES.items():
            try:
                resp = await client.get(f"http://127.0.0.1:{port}/health")
                data = resp.json()
                results[name] = {
                    "status": "healthy",
                    "uptime_seconds": data.get("uptime_seconds"),
                    "memory_mb": data.get("memory_mb"),
                }
            except Exception:
                results[name] = {"status": "unreachable"}
                overall = "degraded"

    # systemd-only services
    for unit in _SYSTEMD_ONLY:
        svc_name = unit if "." in unit else f"{unit}.service"
        try:
            result = subprocess.run(
                ["systemctl", "--user", "is-active", svc_name],
                capture_output=True, text=True, timeout=3,
            )
            active = result.stdout.strip() == "active"
            results[unit] = {"status": "healthy" if active else "inactive"}
            if not active:
                overall = "degraded"
        except Exception:
            results[unit] = {"status": "unknown"}

    return {"status": overall, "services": results}


# ── System ────────────────────────────────────────────────

@router.get("/system/stats")
def system_stats():
    """CPU, RAM, disk stats. No auth — same as /health/summary (non-sensitive metrics)."""
    return collectors.get_system_stats()


@router.get("/system/services")
def system_services():
    return collectors.get_service_statuses()


@router.post("/system/start-all", dependencies=[Depends(require_admin)])
def start_all_services():
    return services.start_all_services()


@router.post("/system/services/{name}/{action}", dependencies=[Depends(require_admin)])
def control_service(name: str, action: str):
    result = services.control_service(name, action)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


# ── Agents ────────────────────────────────────────────────

@router.get("/agents")
def list_agents():
    return collectors.get_running_agents()


@router.get("/agents/{pid}")
def get_agent_detail(pid: int):
    detail = collectors.get_agent_detail(pid)
    if not detail:
        raise HTTPException(404, "Agent not found or not a claude process")
    return detail


@router.post("/agents/{pid}/kill", dependencies=[Depends(require_admin)])
def kill_agent(pid: int):
    result = services.kill_agent(pid)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


@router.post("/agents/kill-all", dependencies=[Depends(require_admin)])
def kill_all_agents():
    return services.kill_all_agents()


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


# ── Tasks ─────────────────────────────────────────────────

@router.get("/tasks/queue")
def task_queue():
    return collectors.get_task_queue()


@router.get("/tasks/registry/summary")
def task_registry_summary():
    return collectors.get_task_registry_summary()


@router.post("/tasks/queue/process", dependencies=[Depends(require_admin)])
def process_queue():
    result = services.process_queue()
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Queue processing failed"))
    return result


@router.get("/tasks/registry")
def task_registry():
    """Return full task registry."""
    import json
    try:
        if config.REGISTRY_JSON.is_file():
            return json.loads(config.REGISTRY_JSON.read_text())
        return {"tasks": {}}
    except (json.JSONDecodeError, OSError):
        return {"tasks": {}}


@router.post("/tasks/registry/{task_id}/run", dependencies=[Depends(require_admin)])
def run_task(task_id: str, squad: str | None = None):
    """Manually trigger a squad run for a specific task."""
    result = services.run_task_squad(task_id, squad)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


@router.post("/tasks/registry/{task_id}/delegate", dependencies=[Depends(require_admin)])
def delegate_task(task_id: str):
    """Delegate a task to agents — auto-route and set assignee."""
    result = services.delegate_task(task_id)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


@router.post("/tasks/registry/{task_id}/complete", dependencies=[Depends(require_admin)])
def complete_task(task_id: str):
    """Mark a task as completed."""
    import json
    from datetime import datetime
    try:
        registry = json.loads(config.REGISTRY_JSON.read_text()) if config.REGISTRY_JSON.is_file() else {"tasks": {}}
    except (json.JSONDecodeError, OSError):
        raise HTTPException(500, "Failed to read registry")
    task = registry["tasks"].get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    task["status"] = "completed"
    task["updatedAt"] = datetime.now().isoformat() + "Z"
    task["completedAt"] = datetime.now().isoformat() + "Z"
    config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2))
    return {"success": True, "task_id": task_id}


@router.get("/tasks/settings")
def task_settings():
    """Get task processor settings (auto_execute toggle, etc.)."""
    return services.get_task_settings()


@router.post("/tasks/settings", dependencies=[Depends(require_admin)])
def update_task_settings(
    auto_execute: bool | None = None,
    max_squad_runs_per_cycle: int | None = None,
    cooldown_minutes: int | None = None,
):
    """Update task processor settings."""
    result = services.update_task_settings(auto_execute, max_squad_runs_per_cycle, cooldown_minutes)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Failed to update settings"))
    return result


# ── Team ──────────────────────────────────────────────────

@router.get("/team")
def team_info():
    team = collectors.get_team()
    if not team:
        raise HTTPException(404, "team.json not found")
    return team


# ── Updater ───────────────────────────────────────────────

@router.get("/updater/suggestions")
def updater_suggestions():
    """Return all suggestions from the updater agent."""
    try:
        import json
        if config.UPDATER_SUGGESTIONS_FILE.is_file():
            return json.loads(config.UPDATER_SUGGESTIONS_FILE.read_text())
        return {"suggestions": []}
    except (json.JSONDecodeError, OSError):
        return {"suggestions": []}


@router.get("/updater/state")
def updater_state():
    """Return updater agent state."""
    try:
        import json
        if config.UPDATER_STATE_FILE.is_file():
            return json.loads(config.UPDATER_STATE_FILE.read_text())
        return {"last_scan": None, "known_components": []}
    except (json.JSONDecodeError, OSError):
        return {"last_scan": None, "known_components": []}


@router.post("/updater/suggestions/{suggestion_id}/archive", dependencies=[Depends(require_admin)])
def archive_suggestion(suggestion_id: str):
    """Archive a suggestion so it won't be re-suggested."""
    if _updater is None:
        raise HTTPException(503, "Updater agent not initialized")
    if _updater.archive_suggestion(suggestion_id):
        return {"success": True}
    raise HTTPException(404, "Suggestion not found or already archived")


@router.post("/updater/suggestions/{suggestion_id}/task", dependencies=[Depends(require_admin)])
def create_task_from_suggestion(suggestion_id: str):
    """Create a task in registry.json from a suggestion."""
    import json
    from datetime import datetime

    if _updater is None:
        raise HTTPException(503, "Updater agent not initialized")
    suggestion = _updater.get_suggestion(suggestion_id)
    if not suggestion:
        raise HTTPException(404, "Suggestion not found")

    # Load or init registry
    try:
        registry = json.loads(config.REGISTRY_JSON.read_text()) if config.REGISTRY_JSON.is_file() else {"tasks": {}}
    except (json.JSONDecodeError, OSError):
        registry = {"tasks": {}}

    # Generate task ID (t-YYYYMMDD-NNN)
    date_str = datetime.now().strftime("%Y%m%d")
    existing = [k for k in registry["tasks"] if k.startswith(f"t-{date_str}-")]
    next_num = len(existing) + 1
    task_id = f"t-{date_str}-{next_num:03d}"

    # Build description with suggested actions
    desc = suggestion.get("description", "")
    actions = suggestion.get("suggested_actions", [])
    if actions:
        desc += "\n\nSuggested actions:\n" + "\n".join(f"- {a}" for a in actions)

    registry["tasks"][task_id] = {
        "id": task_id,
        "title": suggestion.get("title", suggestion_id),
        "description": desc,
        "source": "monitor-updater",
        "sourceRef": {"suggestion_id": suggestion_id, "kind": suggestion.get("kind", "update")},
        "project": None,
        "assignee": None,
        "status": "pending",
        "priority": "normal",
        "deadline": None,
        "routing": {"type": "auto", "squads": [], "mode": "execute"},
        "queueId": None,
        "createdAt": datetime.now().isoformat() + "Z",
        "updatedAt": None,
        "completedAt": None,
    }

    config.REGISTRY_JSON.parent.mkdir(parents=True, exist_ok=True)
    config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2))
    _updater.mark_tasked(suggestion_id, task_id)

    # Write HITL briefing so the task is actionable
    squad_map = {
        "new_tool": "workspace",
        "orphan_prompt": "hygiene",
        "removed_tool": "hygiene",
        "removed_agent": "hygiene",
        "config_modified": "workspace",
    }
    kind = suggestion.get("kind", "update")
    recommended_squad = squad_map.get(kind, "review")

    task_data = registry["tasks"][task_id]
    actions = suggestion.get("suggested_actions", [])
    actions_md = "\n".join(f"- {a}" for a in actions) if actions else "- Review and address as needed"

    briefing = f"""# Task: {task_id}

**Title:** {task_data['title']}
**Priority:** {task_data['priority']}
**Created:** {task_data['createdAt']}
**Source:** UPD System Changes — {suggestion_id}

## Description
{suggestion.get('description', 'No description provided.')}

## Suggested Actions
{actions_md}

## Routing
- **Recommended Squad:** {recommended_squad}
- **Mode:** execute

## Delegation
This task was created from monitor system change detection.
Review and assign to an agent squad or handle manually.
"""

    config.REPORTS_HITL.mkdir(parents=True, exist_ok=True)
    (config.REPORTS_HITL / f"{task_id}.md").write_text(briefing)

    return {"success": True, "task_id": task_id}


# ── Claude Usage ─────────────────────────────────────────

@router.get("/claude/usage")
def claude_usage():
    """Live Claude usage stats — optimized for 5s polling. Today + lifetime + concurrency."""
    return session_collector.get_live_usage()


@router.get("/claude/dashboard")
def claude_dashboard():
    """Aggregated Claude usage dashboard — token counts, trends, heatmap."""
    return session_collector.get_usage_dashboard()


@router.get("/claude/sessions")
def claude_sessions(limit: int = 50, offset: int = 0):
    """List session metadata with pagination."""
    index = session_collector.build_session_index()
    total = len(index)
    return {
        "sessions": index[offset:offset + limit],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/claude/sessions/{session_id}")
def claude_session_detail(session_id: str):
    """Detailed token breakdown for one session."""
    detail = session_collector.get_session_detail(session_id)
    if not detail:
        raise HTTPException(404, "Session not found")
    return detail


@router.get("/claude/concurrency")
def claude_concurrency():
    """Current active claude sessions vs max limit."""
    return session_collector.get_concurrency_snapshot()


@router.get("/claude/status")
def claude_status():
    """Claude Code installation status: version, model, MCP servers, memory, settings."""
    return session_collector.get_claude_status()


@router.get("/claude/document")
def claude_document(path: str = Query(..., description="Absolute path to document")):
    """Read a Claude settings document (CLAUDE.md, MEMORY.md, settings.json, etc.)."""
    # Whitelist: only allow known Claude config locations
    allowed_prefixes = [
        str(Path.home() / ".claude/"),
        "/workspace/synced/opai/CLAUDE.md",
    ]
    resolved = str(Path(path).resolve())
    if not any(resolved == p or resolved.startswith(p) for p in allowed_prefixes):
        raise HTTPException(403, "Access denied: path not in allowed Claude config locations")
    fp = Path(resolved)
    if not fp.is_file():
        raise HTTPException(404, "File not found")
    try:
        content = fp.read_text(errors="replace")
    except Exception as e:
        raise HTTPException(500, f"Failed to read file: {e}")
    return {"path": resolved, "filename": fp.name, "content": content}


@router.get("/claude/plan-usage")
def claude_plan_usage():
    """Live plan usage from Anthropic OAuth API: session %, weekly %, Sonnet %, extra usage."""
    return session_collector.get_plan_usage()
