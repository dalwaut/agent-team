"""OPAI Engine — Worker Guardrails.

Enforces file access control, approval gates, rate limiting,
and action validation for all workers.
"""

import json
import logging
import os
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import config

logger = logging.getLogger("opai-engine.guardrails")

OPAI_ROOT = str(config.OPAI_ROOT)


# ── File Access Validation ─────────────────────────────────

def validate_file_access(
    worker_id: str, worker_config: dict, path: str, operation: str = "read"
) -> dict:
    """Check if a worker is allowed to access a file path.

    Args:
        worker_id: Worker identifier
        worker_config: Worker config from workers.json
        path: Absolute or relative path being accessed
        operation: 'read' or 'write'

    Returns:
        {"allowed": bool, "reason": str}
    """
    permissions = worker_config.get("permissions", {})
    allowed_paths = permissions.get("file_access", [])
    guardrails = worker_config.get("guardrails", {})

    # Normalize path to absolute
    if not os.path.isabs(path):
        path = os.path.join(OPAI_ROOT, path)
    path = os.path.realpath(path)

    # Must be under workspace
    if not path.startswith(OPAI_ROOT) and not path.startswith(str(config.WORKSPACE_ROOT)):
        return {"allowed": False, "reason": "Path outside workspace"}

    # Check read-only constraint
    if guardrails.get("read_only") and operation == "write":
        return {"allowed": False, "reason": "Worker is read-only"}

    # "read-only" in file_access means can read anything, can't write
    if "read-only" in allowed_paths:
        if operation == "read":
            return {"allowed": True, "reason": "Read-only access to all files"}
        return {"allowed": False, "reason": "Worker has read-only file access"}

    # "task-context-path" means access is scoped to the task's context
    if "task-context-path" in allowed_paths:
        # This is resolved at task execution time
        return {"allowed": True, "reason": "Access scoped to task context"}

    # Check specific allowed paths
    for allowed in allowed_paths:
        allowed_abs = os.path.join(OPAI_ROOT, allowed)
        if path.startswith(allowed_abs):
            return {"allowed": True, "reason": f"Within allowed path: {allowed}"}

    # Check guardrails.allowed_paths (more specific override)
    for allowed in guardrails.get("allowed_paths", []):
        allowed_abs = os.path.join(OPAI_ROOT, allowed)
        if path.startswith(allowed_abs):
            return {"allowed": True, "reason": f"Within guardrail path: {allowed}"}

    return {
        "allowed": False,
        "reason": f"Path not in allowed list: {allowed_paths}",
    }


# ── Approval Gates ─────────────────────────────────────────

# Pending approvals: {request_id: {worker_id, action, params, status, created_at}}
_pending_approvals: dict[str, dict] = {}
_approval_counter = 0


def requires_approval(worker_id: str, worker_config: dict, action: str) -> bool:
    """Check if an action requires approval for this worker."""
    guardrails = worker_config.get("guardrails", {})
    requires = guardrails.get("requires_approval", [])
    return action in requires


def request_approval(
    worker_id: str, worker_config: dict, action: str, params: dict = None
) -> dict:
    """Create an approval request for a gated action.

    Returns:
        {"request_id": str, "status": "pending"} or {"status": "not_required"}
    """
    if not requires_approval(worker_id, worker_config, action):
        return {"status": "not_required"}

    global _approval_counter
    _approval_counter += 1
    request_id = f"approval-{worker_id}-{_approval_counter}"

    _pending_approvals[request_id] = {
        "worker_id": worker_id,
        "worker_name": worker_config.get("name", worker_id),
        "action": action,
        "params": params or {},
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    logger.info(
        "Approval requested: %s wants to %s (request=%s)",
        worker_id, action, request_id,
    )

    # Create a HITL task for the approval
    _create_approval_task(request_id, worker_id, worker_config, action, params)

    # Queue Telegram notification to HITL topic
    try:
        from background.notifier import queue_notification
        params_summary = ""
        if params:
            # Build a short summary of params (first 100 chars)
            flat = ", ".join(f"{k}={v}" for k, v in list(params.items())[:3])
            params_summary = flat[:100]
        queue_notification(
            "worker_approval",
            request_id=request_id,
            worker_name=worker_config.get("name", worker_id),
            action=action,
            params_summary=params_summary,
        )
    except Exception:
        pass

    # Record in approval tracker (v3.3)
    try:
        from services.approval_tracker import record_event
        record_event(
            event_type="worker_approval_requested",
            source="worker",
            action=action,
            outcome="pending",
            worker_id=worker_id,
        )
    except Exception:
        pass

    return {"request_id": request_id, "status": "pending"}


def approve_request(request_id: str, approved_by: str = "admin") -> dict:
    """Approve a pending approval request."""
    req = _pending_approvals.get(request_id)
    if not req:
        return {"success": False, "error": "Request not found"}
    if req["status"] != "pending":
        return {"success": False, "error": f"Request already {req['status']}"}

    req["status"] = "approved"
    req["approved_by"] = approved_by
    req["approved_at"] = datetime.now(timezone.utc).isoformat()

    logger.info("Approved: %s (by %s)", request_id, approved_by)

    # Record in approval tracker (v3.3)
    try:
        from services.approval_tracker import record_event
        wait_sec = None
        created_at = req.get("created_at")
        if created_at:
            try:
                created_ts = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
                wait_sec = round(time.time() - created_ts, 1)
            except (ValueError, TypeError):
                pass
        record_event(
            event_type="worker_approval_approved",
            source="worker",
            action=req.get("action", ""),
            approved_by=approved_by,
            wait_time_sec=wait_sec,
            outcome="approved",
            worker_id=req.get("worker_id", ""),
        )
    except Exception:
        pass

    return {"success": True, "request_id": request_id}


def deny_request(request_id: str, denied_by: str = "admin", reason: str = "") -> dict:
    """Deny a pending approval request."""
    req = _pending_approvals.get(request_id)
    if not req:
        return {"success": False, "error": "Request not found"}
    if req["status"] != "pending":
        return {"success": False, "error": f"Request already {req['status']}"}

    req["status"] = "denied"
    req["denied_by"] = denied_by
    req["denied_at"] = datetime.now(timezone.utc).isoformat()
    req["deny_reason"] = reason

    logger.info("Denied: %s (by %s, reason=%s)", request_id, denied_by, reason)

    # Record in approval tracker (v3.3)
    try:
        from services.approval_tracker import record_event
        record_event(
            event_type="worker_approval_denied",
            source="worker",
            action=req.get("action", ""),
            approved_by=denied_by,
            outcome="denied",
            worker_id=req.get("worker_id", ""),
            metadata={"reason": reason},
        )
    except Exception:
        pass

    return {"success": True, "request_id": request_id}


def get_pending_approvals() -> list[dict]:
    """Get all pending approval requests."""
    return [
        {"request_id": rid, **req}
        for rid, req in _pending_approvals.items()
        if req["status"] == "pending"
    ]


def get_approval(request_id: str) -> Optional[dict]:
    """Get a specific approval request."""
    req = _pending_approvals.get(request_id)
    if not req:
        return None
    return {"request_id": request_id, **req}


def is_approved(request_id: str) -> bool:
    """Check if a request has been approved."""
    req = _pending_approvals.get(request_id)
    return req is not None and req["status"] == "approved"


def _create_approval_task(
    request_id: str, worker_id: str, worker_config: dict, action: str, params: dict
):
    """Create a task in the registry for human approval."""
    try:
        import services.task_processor as tp
        registry = tp.read_registry()
        task_id = tp.generate_task_id()
        task = {
            "id": task_id,
            "title": f"[{worker_config.get('name', worker_id)}] Approval needed: {action}",
            "description": (
                f"Worker '{worker_id}' requests approval for action '{action}'.\n\n"
                f"Parameters: {json.dumps(params or {}, indent=2)}\n\n"
                f"Approval ID: {request_id}\n"
                f"To approve: POST /api/workers/approvals/{request_id}/approve\n"
                f"To deny: POST /api/workers/approvals/{request_id}/deny"
            ),
            "status": "pending",
            "priority": "high",
            "source": "worker-approval",
            "assignee": "admin",
            "created": datetime.now(timezone.utc).isoformat(),
            "metadata": {
                "approval_request_id": request_id,
                "worker_id": worker_id,
                "action": action,
            },
        }
        registry["tasks"].append(task)
        tp.write_registry(registry)
        logger.info("Created approval task %s for request %s", task_id, request_id)
    except Exception as e:
        logger.error("Failed to create approval task: %s", e)


# ── Action Enforcement ─────────────────────────────────────

def enforce_action(
    worker_id: str, worker_config: dict, action: str, params: dict = None
) -> dict:
    """Unified enforcement: check rate limit, approval gate, and return verdict.

    Returns:
        {"allowed": True} or {"allowed": False, "reason": str, "approval_id": str?}
    """
    guardrails = worker_config.get("guardrails", {})

    # Rate limit check
    max_per_hour = guardrails.get("max_actions_per_hour", 0)
    if max_per_hour:
        # Import from worker_manager for the shared rate limiter
        # (In practice, the WorkerManager calls this with its rate_limiter)
        pass  # Rate limiting handled by WorkerManager.rate_limiter

    # Approval gate check
    if requires_approval(worker_id, worker_config, action):
        return {
            "allowed": False,
            "reason": "requires_approval",
            "action": action,
            "worker_id": worker_id,
        }

    return {"allowed": True}


# ── Guardrails Summary ─────────────────────────────────────

def get_guardrails_summary(workers: dict) -> dict:
    """Return a summary of all guardrails across workers."""
    summary = {
        "total_workers": len(workers),
        "read_only_workers": [],
        "approval_gated_actions": {},
        "rate_limited_workers": {},
        "prompt_protected": [],
    }

    for wid, w in workers.items():
        guardrails = w.get("guardrails", {})

        if guardrails.get("read_only"):
            summary["read_only_workers"].append(wid)

        requires = guardrails.get("requires_approval", [])
        if requires:
            summary["approval_gated_actions"][wid] = requires

        max_per_hour = guardrails.get("max_actions_per_hour", 0)
        if max_per_hour:
            summary["rate_limited_workers"][wid] = max_per_hour

        if guardrails.get("prompt_protection"):
            summary["prompt_protected"].append(wid)

    summary["pending_approvals"] = len(get_pending_approvals())
    return summary
