"""OPAI Engine — Worker management endpoints.

Provides API for listing, controlling, and monitoring workers.
Includes guardrails: approval gates, file access validation, rate limit info.

IMPORTANT: All fixed-path routes (/workers/health, /workers/guardrails,
/workers/approvals, /workers/roster) MUST be defined BEFORE the parameterized
/workers/{worker_id} route, or FastAPI will match them as worker IDs.
"""

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from auth import require_admin
from background.notifier import mark_telegram_restart
from services import guardrails

router = APIRouter(prefix="/api")

# WorkerManager instance set by app.py during startup
_manager = None


def set_manager(mgr):
    global _manager
    _manager = mgr


def _get_manager():
    if _manager is None:
        raise HTTPException(503, "Worker manager not initialized")
    return _manager


# ── List ───────────────────────────────────────────────────

@router.get("/workers")
def list_workers():
    """List all workers with status."""
    mgr = _get_manager()
    return mgr.get_status()


# ══════════════════════════════════════════════════════════
# Fixed-path routes (MUST come before {worker_id} param)
# ══════════════════════════════════════════════════════════

@router.get("/workers/health")
async def worker_health():
    """Run health checks on all long-running/hybrid workers."""
    mgr = _get_manager()
    results = await mgr.health_check_all()
    overall = "healthy" if all(r.get("healthy") for r in results.values()) else "degraded"
    return {"status": overall, "workers": results}


@router.get("/workers/guardrails")
def guardrails_summary():
    """Summary of all guardrails across workers."""
    mgr = _get_manager()
    return guardrails.get_guardrails_summary(mgr.workers)


@router.get("/workers/approvals")
def list_approvals():
    """List all pending approval requests."""
    return guardrails.get_pending_approvals()


@router.get("/workers/approvals/{request_id}")
def get_approval(request_id: str):
    """Get a specific approval request."""
    result = guardrails.get_approval(request_id)
    if not result:
        raise HTTPException(404, f"Approval request not found: {request_id}")
    return result


class ApprovalAction(BaseModel):
    reason: str = ""


@router.post(
    "/workers/approvals/{request_id}/approve",
)
def approve_request(request_id: str):
    """Approve a pending approval request."""
    result = guardrails.approve_request(request_id)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


@router.post(
    "/workers/approvals/{request_id}/deny",
)
def deny_request(request_id: str, req: ApprovalAction):
    """Deny a pending approval request."""
    result = guardrails.deny_request(request_id, reason=req.reason)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


# ── Workforce Roster ──────────────────────────────────────

# Workspace root — resolve relative to this file's location in tools/opai-engine/routes/
_WORKSPACE = Path(__file__).resolve().parent.parent.parent.parent

_SWARM_CAPABILITIES = [
    {
        "id": "worker_mail",
        "name": "Worker Mail",
        "description": "SQLite-backed inter-worker messaging with Team Hub mirror. Workers exchange context, findings, and instructions asynchronously.",
        "status": "live",
    },
    {
        "id": "pre_task_priming",
        "name": "Pre-Task Context Priming",
        "description": "Before a worker runs, the fleet coordinator injects operational journal + recent worker mail into context for situational awareness.",
        "status": "live",
    },
    {
        "id": "hierarchical_delegation",
        "name": "Hierarchical Delegation",
        "description": "Project Lead decomposes complex tasks into sub-tasks and dispatches them to specialized sub-workers via DISPATCH: output protocol.",
        "status": "live",
    },
    {
        "id": "auto_review_pipeline",
        "name": "Auto-Review Pipeline",
        "description": "Builder workers automatically trigger reviewer workers on completion, chaining build→review without human intervention.",
        "status": "live",
    },
    {
        "id": "self_improvement_loop",
        "name": "Self-Improvement Loop",
        "description": "Workers propose new tasks via PROPOSE_TASK: output. Proposals enter a human-gated queue before being added to the registry.",
        "status": "live",
    },
]


@router.get("/workers/roster")
def workforce_roster():
    """Full workforce roster: agents, squads, workers, templates, swarm capabilities."""
    team_path = _WORKSPACE / "team.json"
    workers_path = _WORKSPACE / "config" / "workers.json"

    # Load team.json
    try:
        team_data = json.loads(team_path.read_text())
    except Exception:
        team_data = {"roles": {}, "squads": {}, "specialist_templates": {"available": []}}

    # Load workers.json
    try:
        workers_data = json.loads(workers_path.read_text())
    except Exception:
        workers_data = {"workers": {}}

    roles = team_data.get("roles", {})
    squads = team_data.get("squads", {})
    templates = team_data.get("specialist_templates", {}).get("available", [])
    raw_workers = workers_data.get("workers", {})

    # Build reverse lookup: agent_id → list of squad memberships + dynamic pools
    agent_squads = {}
    agent_pools = {}
    for squad_id, squad in squads.items():
        for agent_id in squad.get("agents", []):
            agent_squads.setdefault(agent_id, []).append(squad_id)
        for agent_id in squad.get("dynamic_pool", []):
            agent_pools.setdefault(agent_id, []).append(squad_id)

    # Build agents response
    agents_out = {}
    for agent_id, role in roles.items():
        agents_out[agent_id] = {
            "name": role.get("name", agent_id),
            "emoji": role.get("emoji", ""),
            "description": role.get("description", ""),
            "category": role.get("category", ""),
            "run_order": role.get("run_order", "parallel"),
            "prompt_file": role.get("prompt_file", ""),
            "model": role.get("model", ""),
            "max_turns": role.get("max_turns", 0),
            "squads": agent_squads.get(agent_id, []),
            "dynamic_pools": agent_pools.get(agent_id, []),
        }

    # Build squads response
    squads_out = {}
    for squad_id, squad in squads.items():
        squads_out[squad_id] = {
            "description": squad.get("description", ""),
            "agents": squad.get("agents", []),
            "dynamic_pool": squad.get("dynamic_pool", []),
            "agent_count": len(squad.get("agents", [])),
            "pool_count": len(squad.get("dynamic_pool", [])),
        }

    # Build workers response with agent linking
    workers_out = {}
    for worker_id, w in raw_workers.items():
        # Try to match worker to an agent role by normalizing names
        normalized = worker_id.replace("-", "_")
        linked_agent = normalized if normalized in roles else ""
        workers_out[worker_id] = {
            "name": w.get("name", worker_id),
            "type": w.get("type", ""),
            "runtime": w.get("runtime", ""),
            "port": w.get("port"),
            "trigger": w.get("trigger", {}).get("mode", ""),
            "intent": w.get("intent", {}).get("purpose", ""),
            "guardrails": {
                k: v for k, v in w.get("guardrails", {}).items()
                if k in ("read_only", "requires_approval", "max_turns", "timeout_minutes", "model")
            },
            "linked_agent": linked_agent,
        }

    # Build templates response
    templates_out = []
    for filename in templates:
        name = filename.replace("prompt_", "").replace(".txt", "").replace("_", " ").title()
        templates_out.append({
            "id": filename.replace(".txt", ""),
            "name": name,
            "filename": filename,
        })

    return {
        "agents": agents_out,
        "squads": squads_out,
        "workers": workers_out,
        "templates": templates_out,
        "swarm": _SWARM_CAPABILITIES,
        "counts": {
            "agents": len(agents_out),
            "squads": len(squads_out),
            "workers": len(workers_out),
            "templates": len(templates_out),
            "swarm": len(_SWARM_CAPABILITIES),
        },
    }


# ══════════════════════════════════════════════════════════
# Parameterized routes (AFTER fixed paths)
# ══════════════════════════════════════════════════════════

@router.get("/workers/{worker_id}")
def get_worker(worker_id: str):
    """Get detailed info for a worker."""
    mgr = _get_manager()
    detail = mgr.get_worker_detail(worker_id)
    if not detail:
        raise HTTPException(404, f"Worker not found: {worker_id}")
    return detail


# ── Lifecycle Control ──────────────────────────────────────

@router.post("/workers/{worker_id}/start", dependencies=[Depends(require_admin)])
def start_worker(worker_id: str):
    """Start a long-running or hybrid worker."""
    mgr = _get_manager()
    result = mgr.start_worker(worker_id)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Failed to start"))
    return result


@router.post("/workers/{worker_id}/stop", dependencies=[Depends(require_admin)])
def stop_worker(worker_id: str):
    """Stop a running worker."""
    mgr = _get_manager()
    result = mgr.stop_worker(worker_id)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Failed to stop"))
    return result


@router.post("/workers/{worker_id}/restart", dependencies=[Depends(require_admin)])
def restart_worker(worker_id: str):
    """Restart a worker."""
    mgr = _get_manager()
    result = mgr.restart_worker(worker_id)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Failed to restart"))
    return result


@router.post("/workers/{worker_id}/tg-restart")
def telegram_restart_worker(worker_id: str):
    """Restart a worker via Telegram (no JWT — localhost only, Telegram RBAC is the gate).

    Marks the restart as Telegram-initiated so the heartbeat sends a
    recovery notification to Alerts when the worker comes back healthy.
    """
    mgr = _get_manager()
    result = mgr.restart_worker(worker_id)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Failed to restart"))
    # Mark for recovery notification
    mark_telegram_restart(worker_id)
    return result


# ── Task Workers ───────────────────────────────────────────

class RunTaskRequest(BaseModel):
    context: dict = {}


@router.post("/workers/{worker_id}/run", dependencies=[Depends(require_admin)])
async def run_task_worker(worker_id: str, req: RunTaskRequest, bg: BackgroundTasks):
    """Run a task worker (one-shot). Returns immediately, runs in background."""
    mgr = _get_manager()
    w = mgr.workers.get(worker_id)
    if not w:
        raise HTTPException(404, f"Worker not found: {worker_id}")
    if w.get("type") != "task":
        raise HTTPException(400, f"Worker {worker_id} is not a task worker (type={w.get('type')})")

    bg.add_task(_run_task_async, mgr, worker_id, req.context or None)
    return {"status": "started", "worker_id": worker_id}


async def _run_task_async(mgr, worker_id: str, context: dict = None):
    """Background wrapper for task worker execution."""
    await mgr.run_task_worker(worker_id, context)


# ── File Access Check ──────────────────────────────────────

class FileAccessRequest(BaseModel):
    path: str
    operation: str = "read"


@router.post("/workers/{worker_id}/check-access")
def check_file_access(worker_id: str, req: FileAccessRequest):
    """Check if a worker is allowed to access a file path."""
    mgr = _get_manager()
    w = mgr.workers.get(worker_id)
    if not w:
        raise HTTPException(404, f"Worker not found: {worker_id}")
    return guardrails.validate_file_access(worker_id, w, req.path, req.operation)


# ── Logs ───────────────────────────────────────────────────

@router.get("/workers/{worker_id}/logs")
def get_worker_logs(worker_id: str, lines: int = 50):
    """Get recent logs for a worker."""
    mgr = _get_manager()
    if worker_id not in mgr.workers:
        raise HTTPException(404, f"Worker not found: {worker_id}")
    logs = mgr.get_worker_logs(worker_id, min(lines, 500))
    return {"worker_id": worker_id, "lines": logs}
