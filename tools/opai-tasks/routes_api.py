"""OPAI Task Control Panel — REST API endpoints."""

import json
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Body, Request
from fastapi.responses import StreamingResponse

import config
import services
from monitor import services as monitor_services
from auth import require_admin, AuthUser

router = APIRouter(prefix="/api")


# ── Auth ──────────────────────────────────────────────────
# All tasks endpoints require admin role via Supabase JWT.
# Legacy bearer token auth kept as fallback.

def require_auth(authorization: str | None = Header(None)):
    """Legacy bearer token auth for backward compat."""
    if not config.AUTH_TOKEN:
        return
    if not authorization:
        raise HTTPException(401, "Authorization header required")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not services.verify_auth(token):
        raise HTTPException(403, "Invalid token")


# ── Auth Config ───────────────────────────────────────────

@router.get("/auth/config")
def auth_config():
    """Return Supabase config for frontend auth.js initialization."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── Tasks ─────────────────────────────────────────────────

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
    registry = services.read_registry()
    tasks = list(registry.get("tasks", {}).values())

    # Apply filters
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

    # Sort
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
    """Get summary counts."""
    registry = services.read_registry()
    return services.get_summary(registry)


@router.get("/tasks/{task_id}")
def get_task(task_id: str):
    """Get a single task."""
    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    return task


@router.post("/tasks", dependencies=[Depends(require_admin)])
def create_task(data: dict = Body(...)):
    """Create a new task."""
    # Validate agent config if provided
    ac = data.get("agentConfig")
    if ac and ac.get("agentId"):
        validation = services.validate_agent_config(
            ac["agentId"], ac.get("agentType", "agent"))
        if not validation["valid"]:
            raise HTTPException(400, validation["error"])

    registry = services.read_registry()
    task_id = services.generate_task_id(registry)

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

    # Auto-route if no assignee and no agentConfig specified
    if not task["assignee"] and not task["agentConfig"]:
        task = services.auto_route_task(task)

    # Apply bypass approval rules: Discord, feedback, and trusted email senders
    # skip the approval gate and enter directly as "scheduled" + execute mode.
    if services.should_bypass_approval(task):
        task["status"] = "scheduled"
        task.setdefault("routing", {})
        task["routing"]["mode"] = "execute"
        task["approvedAt"] = now
        task["approvedBy"] = "system:auto"
        if source == "discord":
            task["bypassReason"] = "discord-admin"
        elif source == "feedback":
            task["bypassReason"] = "feedback-system"
        else:
            task["bypassReason"] = "trusted-email"

    registry["tasks"][task_id] = task
    services.write_registry(registry)
    return {"success": True, "task": task}


@router.patch("/tasks/{task_id}", dependencies=[Depends(require_admin)])
def update_task(task_id: str, data: dict = Body(...)):
    """Update task fields."""
    # Validate agent config if being updated
    ac = data.get("agentConfig")
    if ac and ac.get("agentId"):
        validation = services.validate_agent_config(
            ac["agentId"], ac.get("agentType", "agent"))
        if not validation["valid"]:
            raise HTTPException(400, validation["error"])

    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")

    allowed = {"status", "priority", "assignee", "project", "client", "deadline", "description", "title", "agentConfig", "attachments", "routing", "approvedAt", "approvedBy", "bypassReason", "notes"}
    for key in allowed:
        if key in data:
            task[key] = data[key]

    task["updatedAt"] = datetime.now(timezone.utc).isoformat()

    if data.get("status") == "completed" and not task.get("completedAt"):
        task["completedAt"] = task["updatedAt"]

    # When scheduling an agent task, set routing mode so auto-executor can pick it up
    if (data.get("status") == "scheduled"
            and task.get("assignee") == "agent"
            and task.get("agentConfig", {}).get("agentId")):
        task.setdefault("routing", {})
        task["routing"]["mode"] = "execute"
        task["routing"]["type"] = task["routing"].get("type") or "agent-assigned"

    services.write_registry(registry)
    return {"success": True, "task": task}


@router.delete("/tasks/{task_id}", dependencies=[Depends(require_admin)])
def delete_task(task_id: str):
    """Remove a task from registry."""
    registry = services.read_registry()
    if task_id not in registry.get("tasks", {}):
        raise HTTPException(404, f"Task {task_id} not found")
    del registry["tasks"][task_id]
    services.write_registry(registry)
    return {"success": True, "task_id": task_id}


@router.post("/tasks/{task_id}/auto-route", dependencies=[Depends(require_admin)])
def auto_route_task(task_id: str):
    """Auto-classify and assign the best agent/squad for a task."""
    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    task = services.auto_route_task(task)
    services.write_registry(registry)
    return {"success": True, "task": task}


@router.post("/tasks/{task_id}/complete", dependencies=[Depends(require_admin)])
def complete_task(task_id: str):
    """Mark a task completed."""
    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    now = datetime.now(timezone.utc).isoformat()
    task["status"] = "completed"
    task["updatedAt"] = now
    task["completedAt"] = now
    services.write_registry(registry)
    return {"success": True, "task_id": task_id}


@router.post("/tasks/{task_id}/cancel", dependencies=[Depends(require_admin)])
def cancel_task(task_id: str, data: dict = Body(default={})):
    """Mark a task cancelled with optional reason."""
    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    task["status"] = "cancelled"
    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    reason = data.get("reason", "").strip() if data else ""
    if reason:
        task["cancellationReason"] = reason
    services.write_registry(registry)
    return {"success": True, "task_id": task_id}


@router.post("/tasks/{task_id}/reject", dependencies=[Depends(require_admin)])
def reject_task(task_id: str, data: dict = Body(default={})):
    """Legacy alias — redirects to cancel."""
    return cancel_task(task_id, data)


@router.post("/tasks/{task_id}/approve", dependencies=[Depends(require_admin)])
def approve_task(task_id: str, data: dict = Body(default={})):
    """Mark a task scheduled — human authorization to proceed.

    Sets status to 'scheduled' and routing.mode to 'execute'.
    The auto-executor will pick it up on the next cycle.
    """
    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    now = datetime.now(timezone.utc).isoformat()
    task["status"] = "scheduled"
    task["updatedAt"] = now
    task["approvedAt"] = now
    task["approvedBy"] = "human"
    task.setdefault("routing", {})
    task["routing"]["mode"] = "execute"
    notes = data.get("notes", "").strip() if data else ""
    if notes:
        task["notes"] = (task.get("notes") or "") + f"\n\n[Approved] {notes}"
    services.write_registry(registry)
    return {"success": True, "task_id": task_id, "status": "scheduled"}


@router.post("/tasks/{task_id}/resubmit", dependencies=[Depends(require_admin)])
def resubmit_task(task_id: str):
    """Re-submit a task back into the pending queue."""
    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")
    task["status"] = "pending"
    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    # Clear any rejection reason and completion timestamp
    task.pop("rejectionReason", None)
    task.pop("completedAt", None)
    services.write_registry(registry)
    return {"success": True, "task_id": task_id}


@router.post("/tasks/batch", dependencies=[Depends(require_admin)])
def batch_tasks(data: dict = Body(...)):
    """Batch operations on tasks."""
    action = data.get("action")
    ids = data.get("ids", [])
    fields = data.get("fields", {})

    if not action or not ids:
        raise HTTPException(400, "action and ids required")

    registry = services.read_registry()
    now = datetime.now(timezone.utc).isoformat()
    updated = []

    for task_id in ids:
        task = registry.get("tasks", {}).get(task_id)
        if not task:
            continue

        if action == "complete":
            task["status"] = "completed"
            task["updatedAt"] = now
            task["completedAt"] = now
        elif action == "reject":
            task["status"] = "cancelled"
            task["updatedAt"] = now
            reason = fields.get("reason", "").strip() if fields else ""
            if reason:
                task["cancellationReason"] = reason
        elif action == "delete":
            del registry["tasks"][task_id]
        elif action == "update":
            allowed = {"status", "priority", "assignee", "project", "client", "deadline"}
            for key in allowed:
                if key in fields:
                    task[key] = fields[key]
            if "routing_mode" in fields:
                task.setdefault("routing", {})["mode"] = fields["routing_mode"]
            task["updatedAt"] = now
        elif action == "auto-assign":
            services.auto_route_task(task)
            task["updatedAt"] = now

        updated.append(task_id)

    services.write_registry(registry)
    return {"success": True, "updated": updated, "count": len(updated)}


# ── Squad Execution (proxy to monitor) ────────────────────

@router.post("/tasks/{task_id}/run", dependencies=[Depends(require_admin)])
def run_task(task_id: str, data: dict = Body(default={})):
    """Trigger squad for task via monitor services (direct call)."""
    squad = data.get("squad")
    result = monitor_services.run_task_squad(task_id, squad)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


@router.post("/tasks/{task_id}/delegate", dependencies=[Depends(require_admin)])
def delegate_task(task_id: str, data: dict = Body(default={})):
    """Delegate task to a person or agent."""
    assignee = data.get("assignee", "").strip()

    # If assignee is "agent" or empty, delegate via monitor services (direct call)
    if not assignee or assignee == "agent":
        result = monitor_services.delegate_task(task_id)
        if not result["success"]:
            raise HTTPException(400, result["error"])
        return result

    # Person delegation
    result = services.delegate_to_person(
        task_id=task_id,
        assignee=assignee,
        send_email=data.get("sendEmail", False),
        email_to=data.get("emailTo", ""),
        from_account=data.get("fromAccount", ""),
        message=data.get("message", ""),
    )
    if not result["success"]:
        raise HTTPException(404, result["error"])
    return result


# ── Feedback ──────────────────────────────────────────────

@router.get("/feedback")
def list_feedback():
    """Return parsed feedback items with summary stats."""
    items = services.parse_feedback_files()
    registry = services.read_registry()
    summary = services.get_feedback_summary(items, registry)
    return {"items": items, "summary": summary}


@router.post("/feedback/action", dependencies=[Depends(require_admin)])
def feedback_action(data: dict = Body(...)):
    """Execute an action on a feedback item."""
    feedback_id = data.get("feedbackId", "").strip()
    action = data.get("action", "").strip()
    agent_id = data.get("agentId", "").strip() or None
    agent_type = data.get("agentType", "agent").strip()
    extra_data = data.get("extraData") or {}

    if not feedback_id or not action:
        raise HTTPException(400, "feedbackId and action required")

    result = services.feedback_action(feedback_id, action, agent_id,
                                       agent_type=agent_type,
                                       extra_data=extra_data)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


# ── Settings ──────────────────────────────────────────────

@router.get("/settings")
def get_settings():
    """Read task processor settings."""
    return services.get_settings()


@router.post("/settings", dependencies=[Depends(require_admin)])
def update_settings(data: dict = Body(...)):
    """Update task processor settings."""
    result = services.update_settings(data)
    if not result["success"]:
        raise HTTPException(400, result.get("error", "Update failed"))
    return result


@router.get("/token-usage")
def get_token_usage():
    """Get today's token usage and budget status."""
    settings = services.get_settings()
    used = services.get_today_token_usage()
    budget = settings.get("daily_token_budget", 5000000)
    enabled = settings.get("daily_token_budget_enabled", True)
    return {
        "used": used,
        "budget": budget,
        "enabled": enabled,
        "remaining": max(0, budget - used) if enabled else None,
        "exhausted": enabled and used >= budget,
    }


# ── HITL Briefings ────────────────────────────────────────

@router.get("/hitl")
def list_hitl():
    """List HITL briefing files."""
    return {"items": services.list_hitl()}


@router.get("/hitl/{filename}")
def read_hitl(filename: str):
    """Read a HITL briefing."""
    content = services.read_hitl(filename)
    if content is None:
        raise HTTPException(404, "Briefing not found")
    return {"filename": filename, "content": content}


@router.post("/hitl/{filename}/archive", dependencies=[Depends(require_admin)])
def archive_hitl(filename: str):
    """Archive a HITL briefing."""
    if not services.archive_hitl(filename):
        raise HTTPException(404, "Briefing not found")
    return {"success": True, "filename": filename}


@router.post("/hitl/{filename}/respond", dependencies=[Depends(require_admin)])
def respond_hitl(filename: str, data: dict = Body(...)):
    """Respond to a HITL briefing.

    Body:
      action: "run" | "approve" | "queue" | "dismiss" | "reject" | "reassign"
      squad: optional squad override (for approve)
      notes: optional human notes to attach to the task
      context: optional context text to append (for add-context)
      assignee: for reassign action
    """
    task_id = filename.replace(".md", "")
    action = data.get("action", "approve")
    notes = data.get("notes", "")

    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)

    now = datetime.now(timezone.utc).isoformat()
    result = {"success": True, "task_id": task_id, "action": action}

    # Dismiss doesn't need a task — just archive the orphan briefing
    if action == "dismiss":
        if task:
            task["status"] = "cancelled"
            task["updatedAt"] = now
            if notes:
                task["rejectionReason"] = notes
                task["notes"] = (task.get("notes") or "") + f"\n\n[Dismissed] {notes}"
            services.write_registry(registry)
        services.archive_hitl(filename)
        result["archived"] = True
        return result

    # All other actions need a valid task
    if not task:
        # Try to archive the orphan briefing so it doesn't keep showing up
        services.archive_hitl(filename)
        raise HTTPException(404, f"Task {task_id} not found in registry (briefing archived)")

    if action == "run":
        # Launch feedback fixer directly (for feedback-sourced tasks)
        # or run the recommended squad (for other tasks)
        if notes:
            task["notes"] = (task.get("notes") or "") + f"\n\n[HITL Run] {notes}"
        if task.get("routing"):
            task["routing"]["mode"] = "execute"
        task["assignee"] = "agent"
        task["updatedAt"] = now
        services.write_registry(registry)

        routing = task.get("routing") or {}
        if routing.get("type") == "feedback-fix" and task.get("source") == "feedback":
            fb_ref = task.get("sourceRef") or {}
            fb_item = {
                "feedbackId": fb_ref.get("feedbackId", ""),
                "tool": fb_ref.get("tool", ""),
                "severity": fb_ref.get("severity", "LOW"),
                "category": fb_ref.get("category", ""),
                "description": task.get("description", ""),
                "file": fb_ref.get("file", ""),
            }
            services._run_feedback_fix_threaded(task_id, fb_item)
            result["launched"] = True
        else:
            squad = data.get("squad") or (routing.get("squads") or ["review"])[0]
            result["squad"] = squad
            squad_result = monitor_services.run_task_squad(task_id, squad)
            if squad_result["success"]:
                result["squad_result"] = squad_result
            else:
                result["squad_error"] = squad_result.get("error", "Squad run failed")

        services.archive_hitl(filename)
        result["archived"] = True

    elif action == "approve":
        # Legacy approve — same as run but specifically with a squad
        if task.get("routing"):
            task["routing"]["mode"] = "execute"
        task["assignee"] = "agent"
        task["status"] = "running"
        task["updatedAt"] = now
        if notes:
            task["notes"] = (task.get("notes") or "") + f"\n\n[HITL Approval] {notes}"
        services.write_registry(registry)

        squad = data.get("squad") or (task.get("routing", {}).get("squads") or ["review"])[0]
        result["squad"] = squad
        squad_result = monitor_services.run_task_squad(task_id, squad)
        if squad_result["success"]:
            result["squad_result"] = squad_result
        else:
            result["squad_error"] = squad_result.get("error", "Squad run failed")

        services.archive_hitl(filename)
        result["archived"] = True

    elif action == "queue":
        # Queue for auto-execute cycle pickup (within 30s)
        if task.get("routing"):
            task["routing"]["mode"] = "queued"
        task["assignee"] = "agent"
        task["status"] = "pending"
        task["updatedAt"] = now
        if notes:
            task["notes"] = (task.get("notes") or "") + f"\n\n[HITL Queued] {notes}"
        services.write_registry(registry)
        services.archive_hitl(filename)
        result["archived"] = True
        result["queued"] = True

    elif action == "reject":
        task["status"] = "cancelled"
        task["updatedAt"] = now
        if notes:
            task["cancellationReason"] = notes
            task["notes"] = (task.get("notes") or "") + f"\n\n[HITL Rejected] {notes}"
        services.write_registry(registry)
        services.archive_hitl(filename)
        result["archived"] = True

    elif action == "reassign":
        new_assignee = data.get("assignee", "human")
        task["assignee"] = new_assignee
        task["updatedAt"] = now
        if notes:
            task["notes"] = (task.get("notes") or "") + f"\n\n[HITL Reassigned to {new_assignee}] {notes}"
        if new_assignee == "agent":
            if task.get("routing"):
                task["routing"]["mode"] = "execute"
        services.write_registry(registry)
        services.archive_hitl(filename)
        result["archived"] = True
        result["new_assignee"] = new_assignee

    else:
        raise HTTPException(400, f"Unknown action: {action}")

    return result


# ── Email ─────────────────────────────────────────────────

@router.post("/tasks/{task_id}/email", dependencies=[Depends(require_admin)])
def email_task(task_id: str, data: dict = Body(...)):
    """Send task details via email."""
    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")

    to = data.get("to")
    if not to:
        raise HTTPException(400, "Recipient email (to) required")

    result = services.send_task_email(
        task, to,
        subject=data.get("subject"),
        body=data.get("body"),
        from_account=data.get("from_account", ""),
    )
    if not result["success"]:
        raise HTTPException(500, result["error"])
    return result


# ── Agent Execution ───────────────────────────────────────

@router.post("/tasks/{task_id}/run-agent", dependencies=[Depends(require_admin)])
def run_agent(task_id: str, data: dict = Body(...)):
    """Run a specific agent on a task with optional custom instructions."""
    agent_id = data.get("agent_id")
    if not agent_id:
        raise HTTPException(400, "agent_id required")

    agent_type = data.get("agent_type", "agent")
    instructions = data.get("instructions", "")

    result = services.run_agent_task(
        task_id=task_id,
        agent_id=agent_id,
        agent_type=agent_type,
        instructions=instructions,
    )
    if not result["success"]:
        status = 404 if "not found" in result.get("error", "") else 500
        raise HTTPException(status, result["error"])
    return result


# ── Attachments ───────────────────────────────────────

@router.post("/tasks/{task_id}/attachments", dependencies=[Depends(require_admin)])
def add_attachment(task_id: str, data: dict = Body(...)):
    """Add a file attachment to a task."""
    path = data.get("path", "").strip()
    name = data.get("name", "").strip()
    if not path:
        raise HTTPException(400, "path required")

    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")

    if "attachments" not in task:
        task["attachments"] = []

    attachment = {
        "name": name or path.rsplit("/", 1)[-1],
        "path": path,
        "addedAt": datetime.now(timezone.utc).isoformat(),
    }
    task["attachments"].append(attachment)
    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    services.write_registry(registry)
    return {"success": True, "attachment": attachment, "index": len(task["attachments"]) - 1}


@router.delete("/tasks/{task_id}/attachments/{index}", dependencies=[Depends(require_admin)])
def remove_attachment(task_id: str, index: int):
    """Remove an attachment by index."""
    registry = services.read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")

    attachments = task.get("attachments", [])
    if index < 0 or index >= len(attachments):
        raise HTTPException(404, "Attachment index out of range")

    removed = attachments.pop(index)
    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    services.write_registry(registry)
    return {"success": True, "removed": removed}


@router.get("/files/read")
def read_file(path: str):
    """Read file content for the attachment viewer. Restricted to workspace paths."""
    result = services.read_file_safe(path)
    if not result["success"]:
        raise HTTPException(result.get("status", 400), result["error"])
    return result


# ── Archive ───────────────────────────────────────────

@router.get("/archive")
def list_archive(
    search: str | None = None,
    project: str | None = None,
):
    """List archived tasks."""
    archive = services.read_archive()
    tasks = list(archive.get("tasks", {}).values())

    if project:
        tasks = [t for t in tasks if t.get("project") == project]
    if search:
        q = search.lower()
        tasks = [t for t in tasks if q in (t.get("title", "") + " " + (t.get("description") or "")).lower()]

    tasks.sort(key=lambda t: t.get("archivedAt") or "", reverse=True)
    return {"tasks": tasks, "total": len(tasks)}


@router.post("/archive", dependencies=[Depends(require_admin)])
def archive_tasks(data: dict = Body(...)):
    """Archive tasks by IDs."""
    ids = data.get("ids", [])
    if not ids:
        raise HTTPException(400, "ids required")
    return services.archive_tasks(ids)


@router.post("/archive/restore", dependencies=[Depends(require_admin)])
def restore_tasks(data: dict = Body(...)):
    """Restore archived tasks back to active."""
    ids = data.get("ids", [])
    if not ids:
        raise HTTPException(400, "ids required")
    return services.restore_tasks(ids)


@router.delete("/archive", dependencies=[Depends(require_admin)])
def delete_archived(data: dict = Body(...)):
    """Permanently delete archived tasks."""
    ids = data.get("ids", [])
    if not ids:
        raise HTTPException(400, "ids required")
    return services.delete_archived_tasks(ids)


# ── Audit ─────────────────────────────────────────────

@router.get("/audit")
def list_audit(
    tier: str | None = None,
    service: str | None = None,
    agent: str | None = None,
    origin: str | None = None,
    task_id: str | None = None,
    event: str | None = None,
    status: str | None = None,
    model: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    sort: str = "timestamp",
    dir: str = "desc",
    page: int = 1,
    limit: int = 50,
):
    """List audit records with filters. Supports tiered audit format."""
    records = services.read_audit()

    if tier:
        records = [r for r in records if r.get("tier") == tier]
    if service:
        records = [r for r in records if r.get("service") == service]
    if event:
        records = [r for r in records if r.get("event") == event]
    if agent:
        # Support both new (details.agentId) and legacy (agentId) format
        records = [r for r in records if r.get("agentId") == agent or (r.get("details") or {}).get("agentId") == agent]
    if origin:
        records = [r for r in records if r.get("origin") == origin]
    if task_id:
        records = [r for r in records if r.get("taskId") == task_id or (r.get("details") or {}).get("taskId") == task_id]
    if status:
        records = [r for r in records if r.get("status") == status]
    if model:
        records = [r for r in records if model in (r.get("model") or (r.get("details") or {}).get("model") or "")]
    if date_from:
        records = [r for r in records if (r.get("timestamp") or r.get("startedAt") or "") >= date_from]
    if date_to:
        records = [r for r in records if (r.get("timestamp") or r.get("startedAt") or "") <= date_to + "T23:59:59Z"]

    # Support sorting by various fields including nested details
    def sort_key(r):
        val = r.get(sort)
        if val is None:
            val = (r.get("details") or {}).get(sort)
        if val is None:
            return 0 if sort in ("tokensTotal", "tokensOutput", "costUsd", "durationMs", "duration_ms") else ""
        return val

    reverse = dir == "desc"
    records.sort(key=sort_key, reverse=reverse)

    total = len(records)
    start = (page - 1) * limit
    records = records[start:start + limit]

    return {"records": records, "total": total, "page": page, "limit": limit}


@router.get("/audit/{audit_id}/trace")
def audit_trace(audit_id: str):
    """Get the tool call trace for an audit record by reading its session JSONL.

    Pure file read — no AI involved. Reads the session JSONL, extracts
    tool calls (Grep, Glob, Read, Edit, Write) and text outputs.
    """
    records = services.read_audit()
    record = next((r for r in records if r.get("id") == audit_id), None)
    if not record:
        raise HTTPException(404, "Audit record not found")
    session_id = record.get("sessionId") or ""
    # If no stored session ID, try to find by scanning recent JSONLs for task ID
    if not session_id:
        session_id = services.find_session_for_audit(record)
    steps = services.extract_session_trace(session_id)
    return {"auditId": audit_id, "sessionId": session_id, "steps": steps}


@router.post("/audit/{audit_id}/analyze", dependencies=[Depends(require_admin)])
async def audit_analyze(audit_id: str, data: dict = Body(...)):
    """AI analysis of an audit record — streams Claude's response.

    Accepts optional follow-up messages for multi-turn chat.
    Returns SSE stream of text chunks.
    """
    records = services.read_audit()
    record = next((r for r in records if r.get("id") == audit_id), None)
    if not record:
        raise HTTPException(404, "Audit record not found")

    messages = data.get("messages", [])
    return StreamingResponse(
        services.stream_audit_analysis(record, messages),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/audit/summary")
def audit_summary(
    date_from: str | None = None,
    date_to: str | None = None,
):
    """Get aggregated audit stats."""
    records = services.read_audit()
    return services.get_audit_summary(records, date_from=date_from or "", date_to=date_to or "")


# ── Plan Files ────────────────────────────────────────

@router.post("/tasks/{task_id}/plan", dependencies=[Depends(require_admin)])
def save_plan(task_id: str, data: dict = Body(...)):
    """Save a plan file and attach it to the task. Replaces existing plan."""
    content = data.get("content", "").strip()
    if not content:
        raise HTTPException(400, "content required")
    filename = data.get("filename") or None
    result = services.save_plan_file(task_id, content, filename)
    if not result["success"]:
        raise HTTPException(404, result["error"])
    return result


# ── Reference Data ────────────────────────────────────────

@router.get("/contacts")
def list_contacts():
    """Get contacts registry."""
    return services.get_contacts()


@router.get("/projects")
def list_projects():
    """Get project and client folder names."""
    return services.get_projects()


@router.get("/email-accounts")
def list_email_accounts():
    """Get configured email accounts."""
    return {"accounts": services.get_email_accounts()}


@router.get("/agents")
def list_agents():
    """Get agent roles and squad definitions for the agent picker."""
    return services.get_agents()


@router.get("/team/squads")
def team_squads():
    """Get squad definitions."""
    return {"squads": services.get_squads()}


@router.get("/queue")
def task_queue():
    """Read deferred operations queue."""
    return services.get_queue()


# ── Executor Status ──────────────────────────────────────

@router.get("/executor/status")
def executor_status():
    """Get current auto-executor state: running jobs, cycle info."""
    return services.get_executor_status()


# ── Agent Validation ─────────────────────────────────────

@router.post("/agents/validate")
def validate_agent(data: dict = Body(...)):
    """Validate that an agent_id/type exists in team.json."""
    agent_id = data.get("agent_id", "").strip()
    agent_type = data.get("agent_type", "agent").strip()
    if not agent_id:
        raise HTTPException(400, "agent_id required")
    return services.validate_agent_config(agent_id, agent_type)


# ── Auto-Archive ─────────────────────────────────────────

@router.post("/tasks/{task_id}/auto-archive", dependencies=[Depends(require_admin)])
def auto_archive_task(task_id: str):
    """Archive a completed task that has an agent report."""
    result = services.auto_archive_task(task_id)
    if not result["success"]:
        status = 404 if "not found" in result.get("error", "") else 400
        raise HTTPException(status, result["error"])
    return result


# ── Evolve ────────────────────────────────────────────────

@router.get("/evolve/settings")
def get_evolve_settings():
    """Return current evolve loop schedule + on/off state."""
    return services.get_evolve_settings()


@router.post("/evolve/settings", dependencies=[Depends(require_admin)])
async def update_evolve_settings(request: Request):
    """Update evolve loop schedule and enabled state."""
    data = await request.json()
    return services.update_evolve_settings(data)


@router.post("/evolve/run-dry", dependencies=[Depends(require_admin)])
async def run_evolve_dry(request: Request):
    """Trigger a non-blocking dry run. type = 'self_assessment' | 'evolution'"""
    data = await request.json()
    run_type = data.get("type", "self_assessment")
    result = services.trigger_evolve_dry_run(run_type)
    if not result.get("success"):
        raise HTTPException(400, result.get("error", "Failed"))
    return result


@router.get("/evolve/reports")
def get_evolve_reports():
    """Return latest evolve report metadata + parsed plan steps."""
    return services.get_evolve_reports()


@router.post("/evolve/create-tasks", dependencies=[Depends(require_admin)])
async def create_evolve_tasks(request: Request):
    """Create system tasks from selected evolve plan steps."""
    data = await request.json()
    steps = data.get("steps", [])
    if not steps:
        raise HTTPException(400, "steps required")
    return services.create_tasks_from_plan_steps(steps)


# ── Heartbeat Control (scheduler settings proxy) ──────────────────────────

# Service map: tool_key → (port, api_path)
_HEARTBEAT_SERVICES = {
    "forumbot":  (8095, "/api/scheduler/settings"),
    "brain":     (8101, "/api/scheduler/settings"),
    "bot-space": (8099, "/api/scheduler/settings"),
    "bx4":       (8100, "/api/scheduler/settings"),
    "helm":      (8102, "/api/scheduler/settings"),
    "marq":      (8103, "/api/scheduler/settings"),
    "wordpress": (8096, "/api/scheduler/settings"),
    "docs":      (8091, "/api/scheduler/settings"),
    "dam":       (8104, "/api/scheduler/settings"),
}


@router.get("/heartbeats", dependencies=[Depends(require_admin)])
async def get_heartbeats(request: Request):
    """Fan out to all tools' /api/scheduler/settings and return aggregated results."""
    token = request.headers.get("authorization", "")
    results = {}

    async with httpx.AsyncClient(timeout=5) as client:
        for tool, (port, path) in _HEARTBEAT_SERVICES.items():
            try:
                resp = await client.get(
                    f"http://127.0.0.1:{port}{path}",
                    headers={"Authorization": token},
                )
                if resp.status_code == 200:
                    results[tool] = {**resp.json(), "status": "ok"}
                else:
                    results[tool] = {"status": "error", "code": resp.status_code}
            except Exception:
                results[tool] = {"status": "unreachable"}

    return results


@router.put("/heartbeats", dependencies=[Depends(require_admin)])
async def update_heartbeats(request: Request):
    """Accept {tool: {tick_seconds, paused}} map and fan out PUT to each tool."""
    token = request.headers.get("authorization", "")
    data = await request.json()
    results = {}

    async with httpx.AsyncClient(timeout=5) as client:
        for tool, settings in data.items():
            svc = _HEARTBEAT_SERVICES.get(tool)
            if not svc:
                results[tool] = {"status": "unknown_tool"}
                continue
            port, path = svc
            try:
                resp = await client.put(
                    f"http://127.0.0.1:{port}{path}",
                    headers={"Authorization": token, "Content-Type": "application/json"},
                    json=settings,
                )
                if resp.status_code == 200:
                    results[tool] = {**resp.json(), "status": "ok"}
                else:
                    results[tool] = {"status": "error", "code": resp.status_code}
            except Exception:
                results[tool] = {"status": "unreachable"}

    return results
