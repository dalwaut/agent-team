"""OPAI Engine — Task CRUD endpoints.

Bridge to TCP's routes_api.py task endpoints during migration.
The full task CRUD, actions, execution, HITL, archive, email, plans,
settings, evolve, and reference data endpoints are imported from TCP.

After cutover, this file will own all endpoints directly.
"""

import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Body, Request
from fastapi.responses import StreamingResponse

import config
import services.task_processor as tp
from auth import require_admin, AuthUser

router = APIRouter(prefix="/api")


# ── Tasks CRUD ────────────────────────────────────────────

@router.get("/tasks")
def list_tasks(
    status: str | None = None,
    priority: str | None = None,
    assignee: str | None = None,
    project: str | None = None,
    source: str | None = None,
    search: str | None = None,
    sort: str = "createdAt",
    dir: str = "desc",
):
    """List tasks with optional filters."""
    registry = tp.read_registry()
    tasks = list(registry.get("tasks", {}).values())

    if status:
        tasks = [t for t in tasks if t.get("status") == status]
    if priority:
        tasks = [t for t in tasks if t.get("priority") == priority]
    if assignee:
        tasks = [t for t in tasks if t.get("assignee") == assignee]
    if project:
        tasks = [t for t in tasks if t.get("project") == project]
    if source:
        tasks = [t for t in tasks if t.get("source") == source]
    if search:
        q = search.lower()
        tasks = [t for t in tasks if q in (t.get("title", "") + " " + (t.get("description") or "")).lower()]

    priority_order = {"critical": 0, "high": 1, "normal": 2, "low": 3}
    reverse = dir == "desc"
    if sort == "priority":
        tasks.sort(key=lambda t: priority_order.get(t.get("priority", "normal"), 2), reverse=reverse)
    elif sort == "deadline":
        tasks.sort(key=lambda t: t.get("deadline") or "9999-99-99", reverse=reverse)
    else:
        tasks.sort(key=lambda t: t.get(sort) or "", reverse=reverse)

    return {"tasks": tasks, "total": len(tasks)}


@router.get("/tasks/summary")
def task_summary():
    registry = tp.read_registry()
    return tp.get_summary(registry)


@router.get("/tasks/{task_id}")
def get_task(task_id: str):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    return task


@router.post("/tasks", dependencies=[Depends(require_admin)])
def create_task(data: dict = Body(...)):
    ac = data.get("agentConfig")
    if ac and ac.get("agentId"):
        validation = tp.validate_agent_config(ac["agentId"], ac.get("agentType", "agent"))
        if not validation["valid"]:
            raise HTTPException(400, validation["error"])

    registry = tp.read_registry()
    task_id = tp.generate_task_id(registry)

    now = datetime.now(timezone.utc).isoformat()
    source = data.get("source", "manual")
    task = {
        "id": task_id,
        "title": data.get("title", "Untitled"),
        "description": data.get("description", ""),
        "source": source,
        "sourceRef": data.get("sourceRef") or {},
        "project": data.get("project") or None,
        "client": data.get("client") or None,
        "assignee": data.get("assignee") or None,
        "status": "pending",
        "priority": data.get("priority", "normal"),
        "deadline": data.get("deadline") or None,
        "routing": {"type": "manual", "squads": [], "mode": "propose"},
        "queueId": None,
        "createdAt": now,
        "updatedAt": None,
        "completedAt": None,
        "agentConfig": ac or None,
        "attachments": data.get("attachments") or [],
    }

    if not task["assignee"] and not task["agentConfig"]:
        task = tp.auto_route_task(task)

    if tp.should_bypass_approval(task):
        task["status"] = "scheduled"
        task.setdefault("routing", {})
        task["routing"]["mode"] = "execute"
        task["approvedAt"] = now
        task["approvedBy"] = "system:auto"
        # Derive bypass reason from command gate trust (v3.2+)
        intent = task.get("commandIntent") or {}
        task["bypassReason"] = f"{source}-{intent.get('trust_level', 'command')}"

    registry["tasks"][task_id] = task
    tp.write_registry(registry)
    return {"success": True, "task": task}


@router.patch("/tasks/{task_id}", dependencies=[Depends(require_admin)])
def update_task(task_id: str, data: dict = Body(...)):
    ac = data.get("agentConfig")
    if ac and ac.get("agentId"):
        validation = tp.validate_agent_config(ac["agentId"], ac.get("agentType", "agent"))
        if not validation["valid"]:
            raise HTTPException(400, validation["error"])

    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")

    allowed = {"status", "priority", "assignee", "project", "client", "deadline",
               "description", "title", "agentConfig", "attachments", "routing",
               "approvedAt", "approvedBy", "bypassReason", "notes"}
    for key in allowed:
        if key in data:
            task[key] = data[key]

    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    if data.get("status") == "completed" and not task.get("completedAt"):
        task["completedAt"] = task["updatedAt"]

    if (data.get("status") == "scheduled"
            and task.get("assignee") == "agent"
            and task.get("agentConfig", {}).get("agentId")):
        task.setdefault("routing", {})
        task["routing"]["mode"] = "execute"
        task["routing"]["type"] = task["routing"].get("type") or "agent-assigned"

    registry["tasks"][task_id] = task
    tp.write_registry(registry)
    return {"success": True, "task": task}


@router.delete("/tasks/{task_id}", dependencies=[Depends(require_admin)])
def delete_task(task_id: str):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).pop(task_id, None)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    tp.write_registry(registry)
    return {"success": True, "task_id": task_id}


# ── Task Actions ──────────────────────────────────────────

@router.post("/tasks/{task_id}/complete", dependencies=[Depends(require_admin)])
def complete_task(task_id: str):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    now = datetime.now(timezone.utc).isoformat()
    task["status"] = "completed"
    task["updatedAt"] = now
    task["completedAt"] = now
    tp.write_registry(registry)
    return {"success": True, "task_id": task_id}


@router.post("/tasks/{task_id}/cancel", dependencies=[Depends(require_admin)])
def cancel_task(task_id: str, data: dict = Body(default={})):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    task["status"] = "cancelled"
    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    task["cancelReason"] = data.get("reason", "")
    tp.write_registry(registry)

    # Record in approval tracker (v3.3)
    try:
        from services.approval_tracker import record_event
        record_event(
            event_type="task_cancelled",
            source=task.get("source", ""),
            trust_level=(task.get("commandIntent") or {}).get("trust_level", ""),
            action="task_execute",
            outcome="cancelled",
            task_id=task_id,
        )
    except Exception:
        pass

    return {"success": True, "task_id": task_id}


@router.post("/tasks/{task_id}/approve", dependencies=[Depends(require_admin)])
def approve_task(task_id: str, user: AuthUser = Depends(require_admin)):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    now = datetime.now(timezone.utc).isoformat()
    task["status"] = "scheduled"
    task["updatedAt"] = now
    task["approvedAt"] = now
    task["approvedBy"] = user.email
    task.setdefault("routing", {})["mode"] = "execute"
    tp.write_registry(registry)

    # Record in approval tracker (v3.3)
    try:
        from services.approval_tracker import record_event
        wait_sec = None
        created_at = task.get("createdAt")
        if created_at:
            try:
                created_ts = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
                wait_sec = round(time.time() - created_ts, 1)
            except (ValueError, TypeError):
                pass
        record_event(
            event_type="task_manually_approved",
            source=task.get("source", ""),
            trust_level=(task.get("commandIntent") or {}).get("trust_level", ""),
            action="task_execute",
            approved_by=user.email,
            wait_time_sec=wait_sec,
            outcome="approved",
            task_id=task_id,
        )
    except Exception:
        pass

    return {"success": True, "task_id": task_id}


@router.post("/tasks/{task_id}/resubmit", dependencies=[Depends(require_admin)])
def resubmit_task(task_id: str):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    task["status"] = "pending"
    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    tp.write_registry(registry)
    return {"success": True, "task_id": task_id}


@router.post("/tasks/{task_id}/auto-route", dependencies=[Depends(require_admin)])
def auto_route(task_id: str):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    task = tp.auto_route_task(task)
    registry["tasks"][task_id] = task
    tp.write_registry(registry)
    return {"success": True, "task": task}


@router.post("/tasks/batch", dependencies=[Depends(require_admin)])
def batch_tasks(data: dict = Body(...)):
    action = data.get("action")
    task_ids = data.get("task_ids", [])
    if not task_ids:
        raise HTTPException(400, "task_ids required")

    registry = tp.read_registry()
    results = []
    now = datetime.now(timezone.utc).isoformat()

    for tid in task_ids:
        task = registry.get("tasks", {}).get(tid)
        if not task:
            results.append({"task_id": tid, "success": False, "error": "not found"})
            continue

        if action == "complete":
            task["status"] = "completed"
            task["updatedAt"] = now
            task["completedAt"] = now
        elif action == "delete":
            registry["tasks"].pop(tid, None)
        elif action == "auto-assign":
            task = tp.auto_route_task(task)
            registry["tasks"][tid] = task
        elif action == "update":
            updates = data.get("updates", {})
            for k, v in updates.items():
                if k in {"status", "priority", "assignee", "project"}:
                    task[k] = v
            task["updatedAt"] = now
        else:
            results.append({"task_id": tid, "success": False, "error": f"unknown action: {action}"})
            continue

        results.append({"task_id": tid, "success": True})

    tp.write_registry(registry)
    return {"success": True, "results": results}


# ── Execution ─────────────────────────────────────────────

@router.post("/tasks/{task_id}/run", dependencies=[Depends(require_admin)])
def run_task(task_id: str, data: dict = Body(default={})):
    squad = data.get("squad")
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")

    ac = task.get("agentConfig") or {}
    agent_id = ac.get("agentId")
    agent_type = ac.get("agentType", "agent")

    if agent_id:
        result = tp.run_agent_task_threaded(task_id, agent_id, agent_type)
    elif squad or (task.get("routing", {}).get("squads") or []):
        from services.service_controller import run_task_squad
        result = run_task_squad(task_id, squad)
    else:
        raise HTTPException(400, "No agent or squad configured for this task")
    return result


@router.post("/tasks/{task_id}/run-agent", dependencies=[Depends(require_admin)])
def run_agent(task_id: str, data: dict = Body(...)):
    agent_id = data.get("agent_id")
    agent_type = data.get("agent_type", "agent")
    instructions = data.get("instructions")
    if not agent_id:
        raise HTTPException(400, "agent_id required")
    result = tp.run_agent_task_threaded(task_id, agent_id, agent_type, custom_instructions=instructions)
    return result


@router.post("/tasks/{task_id}/delegate", dependencies=[Depends(require_admin)])
def delegate_task(task_id: str, data: dict = Body(default={})):
    person = data.get("person")
    if person:
        result = tp.delegate_to_person(task_id, person, send_email=data.get("send_email", False))
    else:
        from services.service_controller import delegate_task as svc_delegate
        result = svc_delegate(task_id)
    if not result.get("success"):
        raise HTTPException(400, result.get("error", "Delegation failed"))
    return result


# ── HITL ──────────────────────────────────────────────────

@router.get("/hitl")
def list_hitl():
    return tp.list_hitl()


@router.get("/hitl/{filename}")
def read_hitl(filename: str):
    content = tp.read_hitl(filename)
    if content is None:
        raise HTTPException(404, "Briefing not found")
    return {"filename": filename, "content": content}


@router.post("/hitl/{filename}/respond", dependencies=[Depends(require_admin)])
def respond_hitl(filename: str, data: dict = Body(...)):
    action = data.get("action")
    if not action:
        raise HTTPException(400, "action required")
    # HITL response logic varies by action — delegate to processor
    task_id = filename.replace(".md", "")
    if action == "run":
        squad = data.get("squad")
        return run_task(task_id, {"squad": squad})
    elif action == "approve":
        return approve_task(task_id)
    elif action == "dismiss":
        tp.archive_hitl(filename)
        return {"success": True, "action": "dismissed"}
    elif action == "reject":
        return cancel_task(task_id, {"reason": data.get("reason", "Rejected via HITL")})
    else:
        raise HTTPException(400, f"Unknown HITL action: {action}")


@router.post("/hitl/{filename}/archive", dependencies=[Depends(require_admin)])
def archive_hitl(filename: str):
    if tp.archive_hitl(filename):
        return {"success": True}
    raise HTTPException(404, "Briefing not found")


# ── Archive ───────────────────────────────────────────────

@router.get("/archive")
def list_archive():
    return tp.read_archive()


@router.post("/archive", dependencies=[Depends(require_admin)])
def archive_tasks_endpoint(data: dict = Body(...)):
    task_ids = data.get("task_ids", [])
    if not task_ids:
        raise HTTPException(400, "task_ids required")
    return tp.archive_tasks(task_ids)


@router.post("/archive/restore", dependencies=[Depends(require_admin)])
def restore_tasks_endpoint(data: dict = Body(...)):
    task_ids = data.get("task_ids", [])
    return tp.restore_tasks(task_ids)


@router.delete("/archive", dependencies=[Depends(require_admin)])
def delete_archive(data: dict = Body(...)):
    task_ids = data.get("task_ids", [])
    return tp.delete_archived_tasks(task_ids)


# ── Attachments ───────────────────────────────────────────

@router.post("/tasks/{task_id}/attachments", dependencies=[Depends(require_admin)])
def add_attachment(task_id: str, data: dict = Body(...)):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    task.setdefault("attachments", []).append({
        "name": data.get("name", ""),
        "path": data.get("path", ""),
        "addedAt": datetime.now(timezone.utc).isoformat(),
    })
    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    tp.write_registry(registry)
    return {"success": True}


@router.delete("/tasks/{task_id}/attachments/{index}", dependencies=[Depends(require_admin)])
def remove_attachment(task_id: str, index: int):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    atts = task.get("attachments", [])
    if 0 <= index < len(atts):
        atts.pop(index)
        task["updatedAt"] = datetime.now(timezone.utc).isoformat()
        tp.write_registry(registry)
        return {"success": True}
    raise HTTPException(400, "Invalid attachment index")


# ── Files ─────────────────────────────────────────────────

@router.get("/files/read")
def read_file(path: str):
    result = tp.read_file_safe(path)
    if not result.get("success"):
        raise HTTPException(400, result.get("error", "Read failed"))
    return result


# ── Email ─────────────────────────────────────────────────

@router.post("/tasks/{task_id}/email", dependencies=[Depends(require_admin)])
def email_task(task_id: str, data: dict = Body(...)):
    registry = tp.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    return tp.send_task_email(task, data.get("to", ""), data.get("subject"), data.get("body"))


# ── Plans ─────────────────────────────────────────────────

@router.post("/tasks/{task_id}/plan", dependencies=[Depends(require_admin)])
def save_plan(task_id: str, data: dict = Body(...)):
    content = data.get("content", "")
    filename = data.get("filename")
    return tp.save_plan_file(task_id, content, filename)


# ── Executor Status ───────────────────────────────────────

@router.get("/executor/status")
def executor_status():
    return tp.get_executor_status()


# ── Reference Data ────────────────────────────────────────

@router.get("/contacts")
def contacts():
    return tp.get_contacts()


@router.get("/projects")
def projects():
    return tp.get_projects()


@router.get("/agents")
def agents():
    return tp.get_agents()


@router.get("/team/squads")
def squads():
    return tp.get_squads()


@router.get("/queue")
def queue():
    return tp.get_queue()


@router.get("/email-accounts")
def email_accounts():
    return tp.get_email_accounts()


# ── Settings ──────────────────────────────────────────────

@router.get("/settings")
def get_settings():
    return tp.get_settings()


@router.post("/settings", dependencies=[Depends(require_admin)])
def update_settings(data: dict = Body(...)):
    return tp.update_settings(data)


# ── Token Usage ───────────────────────────────────────────

@router.get("/token-usage")
def token_usage():
    return {"today_tokens": tp.get_today_token_usage()}


# ── Heartbeats ────────────────────────────────────────────

@router.get("/heartbeats")
def heartbeats():
    """Aggregate scheduler settings from orchestrator.json."""
    try:
        data = json.loads(config.ORCHESTRATOR_JSON.read_text()) if config.ORCHESTRATOR_JSON.is_file() else {}
    except (json.JSONDecodeError, OSError):
        data = {}
    return data.get("schedules", {})


# ── Evolve ────────────────────────────────────────────────

@router.get("/evolve/settings")
def evolve_settings():
    return tp.get_evolve_settings()


@router.post("/evolve/settings", dependencies=[Depends(require_admin)])
def update_evolve_settings_endpoint(data: dict = Body(...)):
    return tp.update_evolve_settings(data)


@router.post("/evolve/run-dry", dependencies=[Depends(require_admin)])
def evolve_dry_run(data: dict = Body(default={})):
    run_type = data.get("type", "self_assessment")
    return tp.trigger_evolve_dry_run(run_type)


@router.get("/evolve/reports")
def evolve_reports():
    return tp.get_evolve_reports()


@router.post("/evolve/create-tasks", dependencies=[Depends(require_admin)])
def evolve_create_tasks(data: dict = Body(...)):
    steps = data.get("steps", [])
    return tp.create_tasks_from_plan_steps(steps)
