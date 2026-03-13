"""OPAI Engine — Action Items API (v3.5).

Aggregates actionable items from multiple sources into one prioritized view:
  1. Team Hub "awaiting-human" items (HITL decisions)
  2. Team Hub "blocked" items (agents stuck)
  3. Team Hub "review" items (completed work needing approval)
  4. Pending worker approvals from guardrails
  5. Stalled/failed workers from heartbeat state
  6. Unactioned suggestions from updater

Also provides an action endpoint to approve/run/dismiss items,
and a dispatch endpoint to spawn local workers/agents.
"""

import json
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

import config
from auth import require_admin

logger = logging.getLogger("opai-engine.action-items")

router = APIRouter(prefix="/api/action-items", tags=["action-items"])

# ── Team Hub Client ───────────────────────────────────────


async def _th_get(endpoint: str, params: dict | None = None) -> dict | list:
    """GET from Team Hub internal API. Returns parsed JSON or empty dict on failure."""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(f"{config.TEAMHUB_INTERNAL}/{endpoint}", params=params)
            if r.status_code < 400:
                return r.json()
            logger.warning("Team Hub GET %s: %d %s", endpoint, r.status_code, r.text[:200])
    except Exception as e:
        logger.warning("Team Hub unreachable (%s): %s", endpoint, e)
    return {}


async def _th_post(endpoint: str, params: dict) -> dict:
    """POST to Team Hub internal API."""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.post(f"{config.TEAMHUB_INTERNAL}/{endpoint}", params=params)
            if r.status_code < 400:
                return r.json()
            logger.warning("Team Hub POST %s: %d %s", endpoint, r.status_code, r.text[:200])
    except Exception as e:
        logger.warning("Team Hub unreachable (%s): %s", endpoint, e)
    return {}


async def _th_patch(endpoint: str, params: dict) -> dict:
    """PATCH to Team Hub internal API."""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.patch(f"{config.TEAMHUB_INTERNAL}/{endpoint}", params=params)
            if r.status_code < 400:
                return r.json()
            logger.warning("Team Hub PATCH %s: %d %s", endpoint, r.status_code, r.text[:200])
    except Exception as e:
        logger.warning("Team Hub unreachable (%s): %s", endpoint, e)
    return {}


# ── Priority Scoring ──────────────────────────────────────


def _score_item(item_type: str, priority: str, created_at: str, is_critical: bool = False) -> int:
    """Calculate priority score for an action item."""
    base_scores = {
        "hitl_decision": 80,
        "blocked_agent": 75,
        "pending_approval": 70,
        "stalled_worker": 75 if is_critical else 50,
        "review_needed": 65,
        "suggestion": 30,
    }
    score = base_scores.get(item_type, 40)

    if priority in ("high", "critical"):
        score += 10
    if priority == "critical":
        score += 5

    # Age bonus
    if created_at:
        try:
            created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            age_min = (datetime.now(timezone.utc) - created).total_seconds() / 60
            if age_min > 60:
                score += 15
            elif age_min > 30:
                score += 10
            elif age_min > 15:
                score += 5
        except (ValueError, TypeError):
            pass

    return min(score, 100)


def _age_minutes(created_at: str) -> int:
    if not created_at:
        return 0
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        return int((datetime.now(timezone.utc) - created).total_seconds() / 60)
    except (ValueError, TypeError):
        return 0


# ── Aggregation ───────────────────────────────────────────


async def _gather_teamhub_items() -> list[dict]:
    """Fetch Team Hub items with actionable statuses (parallel queries)."""
    import asyncio

    ws_id = config.WORKERS_WORKSPACE_ID
    queries = [
        ("awaiting-human", "hitl_decision"),
        ("blocked", "blocked_agent"),
        ("review", "review_needed"),
    ]

    # Fire all three Team Hub queries in parallel
    async def _fetch_status(status, item_type):
        return (status, item_type, await _th_get("list-items", {
            "workspace_id": ws_id,
            "status": status,
            "limit": "50",
        }))

    results = await asyncio.gather(*[_fetch_status(s, t) for s, t in queries])

    items = []
    for status, item_type, data in results:
        for th_item in (data.get("items") or []):
            priority = th_item.get("priority", "medium")
            created = th_item.get("created_at", "")
            items.append({
                "id": f"th:{th_item['id']}",
                "type": item_type,
                "title": th_item.get("title", ""),
                "priority": priority,
                "priority_score": _score_item(item_type, priority, created),
                "created_at": created,
                "age_minutes": _age_minutes(created),
                "source": th_item.get("source", ""),
                "assignee": (th_item.get("assignments", [{}]) or [{}])[0].get("assignee_id", "") if th_item.get("assignments") else "",
                "actions": _actions_for_type(item_type),
                "teamhub_item_id": th_item["id"],
                "content_preview": (th_item.get("description") or "")[:200],
                "status": status,
                "list_name": th_item.get("list_name", ""),
            })

    return items


def _actions_for_type(item_type: str) -> list[str]:
    return {
        "hitl_decision": ["approve", "run", "dismiss", "reject"],
        "blocked_agent": ["unblock", "reassign", "dismiss"],
        "review_needed": ["approve", "reject", "dismiss"],
        "pending_approval": ["approve", "deny"],
        "stalled_worker": ["restart", "dismiss"],
        "suggestion": ["accept", "dismiss"],
    }.get(item_type, ["dismiss"])


def _gather_guardrails_items() -> list[dict]:
    """Get pending approval requests from guardrails."""
    items = []
    try:
        from services.guardrails import get_pending_approvals
        for req in get_pending_approvals():
            created = req.get("created_at", "")
            items.append({
                "id": f"appr:{req['request_id']}",
                "type": "pending_approval",
                "title": f"Worker {req.get('worker_id', '?')}: {req.get('action', '?')}",
                "priority": "high",
                "priority_score": _score_item("pending_approval", "high", created),
                "created_at": created,
                "age_minutes": _age_minutes(created),
                "source": "guardrails",
                "assignee": req.get("worker_id", ""),
                "actions": ["approve", "deny"],
                "teamhub_item_id": None,
                "content_preview": req.get("params_summary", "")[:200],
                "status": "pending",
                "request_id": req["request_id"],
            })
    except Exception as e:
        logger.debug("Guardrails fetch: %s", e)
    return items


def _gather_heartbeat_items() -> list[dict]:
    """Get stalled/failed workers from heartbeat state."""
    items = []
    try:
        if not config.HEARTBEAT_STATE_FILE.is_file():
            return items
        state = json.loads(config.HEARTBEAT_STATE_FILE.read_text())
        snapshot = state.get("last_snapshot", {})
        work_items = snapshot.get("work_items", {})
        for wid, hb_item in (work_items.items() if isinstance(work_items, dict) else []):
            status = hb_item.get("status", "")
            if status not in ("unhealthy", "failed", "stalled"):
                continue
            name = hb_item.get("name", wid)
            items.append({
                "id": f"hb:{wid}",
                "type": "stalled_worker",
                "title": f"{name} — {status}",
                "priority": "high" if status == "failed" else "normal",
                "priority_score": _score_item("stalled_worker", "high" if status == "failed" else "normal", "", is_critical=status == "failed"),
                "created_at": hb_item.get("last_seen", ""),
                "age_minutes": _age_minutes(hb_item.get("last_seen", "")),
                "source": "heartbeat",
                "assignee": "",
                "actions": ["restart", "dismiss"],
                "teamhub_item_id": None,
                "content_preview": hb_item.get("error", "")[:200],
                "status": status,
                "worker_id": hb_item.get("id", ""),
            })
    except Exception as e:
        logger.debug("Heartbeat fetch: %s", e)
    return items


def _gather_nfs_items() -> list[dict]:
    """Get stale NFS tasks and unhealthy NFS workers."""
    items = []
    try:
        from app import nfs_dispatcher
        status = nfs_dispatcher.get_status()

        # Stale NFS tasks
        for task in status.get("active_nfs_tasks", []):
            if not task.get("stale"):
                continue
            created = task.get("dispatched_at", "")
            items.append({
                "id": f"nfs:{task.get('worker_slug', '')}:{task.get('task_id', '')}",
                "type": "stalled_worker",
                "title": f"NFS stale: {task.get('worker_slug', '?')} — {task.get('title', '')[:40]}",
                "priority": "high",
                "priority_score": _score_item("stalled_worker", "high", created, is_critical=True),
                "created_at": created,
                "age_minutes": _age_minutes(created),
                "source": "nfs-dispatcher",
                "assignee": task.get("worker_slug", ""),
                "actions": ["dismiss"],
                "teamhub_item_id": task.get("teamhub_item_id"),
                "content_preview": f"Task {task.get('task_id', '')} dispatched to {task.get('worker_slug', '')} but stale",
                "status": "stale",
            })

        # Unhealthy NFS workers
        for slug, health in status.get("worker_health", {}).items():
            if health.get("status") not in ("stale", "offline", "error"):
                continue
            items.append({
                "id": f"nfs-worker:{slug}",
                "type": "stalled_worker",
                "title": f"NFS worker {slug} — {health.get('status', 'unknown')}",
                "priority": "normal",
                "priority_score": _score_item("stalled_worker", "normal", health.get("last_seen", "")),
                "created_at": health.get("last_seen", ""),
                "age_minutes": _age_minutes(health.get("last_seen", "")),
                "source": "nfs-dispatcher",
                "assignee": "",
                "actions": ["dismiss"],
                "teamhub_item_id": None,
                "content_preview": f"Worker {slug} heartbeat status: {health.get('status', 'unknown')}",
                "status": health.get("status", "unknown"),
            })
    except Exception as e:
        logger.debug("NFS items fetch: %s", e)
    return items


def _gather_suggestion_items() -> list[dict]:
    """Get unactioned suggestions from updater."""
    items = []
    try:
        if not config.UPDATER_SUGGESTIONS_FILE.is_file():
            return items
        data = json.loads(config.UPDATER_SUGGESTIONS_FILE.read_text())
        for sug in (data.get("suggestions") or []):
            if sug.get("status") != "pending":
                continue
            # Skip informational notices (report categories, auto-detected agents/squads)
            if sug.get("kind") == "notice":
                continue
            # Skip removed_tool suggestions (tools already deleted)
            if sug.get("type") == "removed_tool":
                continue
            items.append({
                "id": f"sug:{sug.get('id', '')}",
                "type": "suggestion",
                "title": sug.get("title", sug.get("description", "")[:60]),
                "priority": "low",
                "priority_score": _score_item("suggestion", "low", sug.get("created_at", "")),
                "created_at": sug.get("created_at", ""),
                "age_minutes": _age_minutes(sug.get("created_at", "")),
                "source": "updater",
                "assignee": "",
                "actions": ["accept", "dismiss"],
                "teamhub_item_id": None,
                "content_preview": (sug.get("description") or "")[:200],
                "status": "pending",
                "suggestion_id": sug.get("id", ""),
            })
    except Exception as e:
        logger.debug("Suggestions fetch: %s", e)
    return items


# ── Endpoints ─────────────────────────────────────────────


@router.get("", dependencies=[Depends(require_admin)])
async def get_action_items(max_age_days: Optional[int] = None):
    """Get all action items from all sources, priority-sorted.

    Optional query params:
        max_age_days: filter out suggestions older than N days (HITL/blocked/stalled always shown)
    """
    # Team Hub items (async) + sync sources
    th_items = await _gather_teamhub_items()
    gr_items = _gather_guardrails_items()
    hb_items = _gather_heartbeat_items()
    nfs_items = _gather_nfs_items()
    sg_items = _gather_suggestion_items()

    all_items = th_items + gr_items + hb_items + nfs_items + sg_items

    # Age filter — only applies to suggestions; critical items always show
    if max_age_days is not None and max_age_days > 0:
        cutoff_minutes = max_age_days * 24 * 60
        all_items = [
            i for i in all_items
            if i["type"] != "suggestion" or i.get("age_minutes", 0) <= cutoff_minutes
        ]

    all_items.sort(key=lambda i: i.get("priority_score", 0), reverse=True)

    by_type = {}
    for item in all_items:
        t = item["type"]
        by_type[t] = by_type.get(t, 0) + 1

    return {
        "action_items": all_items,
        "summary": {
            "total": len(all_items),
            "by_type": by_type,
        },
    }


@router.post("/bulk-dismiss", dependencies=[Depends(require_admin)])
async def bulk_dismiss(data: dict = Body(...)):
    """Bulk dismiss suggestions by IDs, types, kinds, or age.

    Body (all optional, combined with OR):
        ids: list[str] — specific suggestion IDs to dismiss
        types: list[str] — dismiss by suggestion type (e.g. "removed_tool")
        kinds: list[str] — dismiss by suggestion kind (e.g. "notice")
        max_age_days: int — dismiss suggestions older than N days
    """
    ids = set(data.get("ids") or [])
    types = set(data.get("types") or [])
    kinds = set(data.get("kinds") or [])
    max_age_days = data.get("max_age_days")

    if not ids and not types and not kinds and not max_age_days:
        raise HTTPException(status_code=400, detail="At least one filter required: ids, types, kinds, or max_age_days")

    try:
        if not config.UPDATER_SUGGESTIONS_FILE.is_file():
            return {"success": True, "dismissed": 0}

        suggestions = json.loads(config.UPDATER_SUGGESTIONS_FILE.read_text())
        now = datetime.now(timezone.utc).isoformat()
        dismissed_count = 0

        for sug in suggestions.get("suggestions", []):
            if sug.get("status") != "pending":
                continue

            should_dismiss = False
            if ids and sug.get("id") in ids:
                should_dismiss = True
            if types and sug.get("type") in types:
                should_dismiss = True
            if kinds and sug.get("kind") in kinds:
                should_dismiss = True
            if max_age_days and max_age_days > 0:
                age = _age_minutes(sug.get("created_at", ""))
                if age > max_age_days * 24 * 60:
                    should_dismiss = True

            if should_dismiss:
                sug["status"] = "dismissed"
                sug["dismissed_at"] = now
                dismissed_count += 1

        config.UPDATER_SUGGESTIONS_FILE.write_text(
            json.dumps(suggestions, indent=2, default=str)
        )

        return {"success": True, "dismissed": dismissed_count}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{item_id}", dependencies=[Depends(require_admin)])
async def get_action_item_detail(item_id: str):
    """Get detailed info for a single action item."""
    prefix, _, raw_id = item_id.partition(":")
    if not raw_id:
        raise HTTPException(status_code=400, detail="Invalid item ID format (expected prefix:id)")

    if prefix == "th":
        data = await _th_get("get-item", {"item_id": raw_id})
        if not data or "id" not in data:
            raise HTTPException(status_code=404, detail="Team Hub item not found")
        return data

    if prefix == "appr":
        from services.guardrails import get_approval
        appr = get_approval(raw_id)
        if not appr:
            raise HTTPException(status_code=404, detail="Approval request not found")
        return appr

    if prefix == "hb":
        try:
            state = json.loads(config.HEARTBEAT_STATE_FILE.read_text())
            work_items = state.get("last_snapshot", {}).get("work_items", {})
            if isinstance(work_items, dict) and raw_id in work_items:
                return {**work_items[raw_id], "id": raw_id}
        except Exception:
            pass
        raise HTTPException(status_code=404, detail="Heartbeat item not found")

    if prefix == "sug":
        try:
            data = json.loads(config.UPDATER_SUGGESTIONS_FILE.read_text())
            for sug in data.get("suggestions", []):
                if sug.get("id") == raw_id:
                    return sug
        except Exception:
            pass
        raise HTTPException(status_code=404, detail="Suggestion not found")

    raise HTTPException(status_code=400, detail=f"Unknown item prefix: {prefix}")


@router.post("/{item_id}/act", dependencies=[Depends(require_admin)])
async def act_on_item(item_id: str, data: dict = Body(...)):
    """Take an action on an item. Routes to the appropriate handler."""
    action = data.get("action", "")
    if not action:
        raise HTTPException(status_code=400, detail="Missing 'action' field")

    prefix, _, raw_id = item_id.partition(":")
    if not raw_id:
        raise HTTPException(status_code=400, detail="Invalid item ID format")

    # ── Team Hub items ──
    if prefix == "th":
        return await _act_teamhub(raw_id, action, data)

    # ── Guardrails approvals ──
    if prefix == "appr":
        return _act_guardrails(raw_id, action)

    # ── Heartbeat items (stalled workers) ──
    if prefix == "hb":
        return await _act_heartbeat(raw_id, action)

    # ── Suggestions ──
    if prefix == "sug":
        return _act_suggestion(raw_id, action, data)

    raise HTTPException(status_code=400, detail=f"Unknown item prefix: {prefix}")


async def _act_teamhub(item_id: str, action: str, data: dict) -> dict:
    """Handle actions on Team Hub items."""
    # Always acknowledge escalation timer for any action
    try:
        from background.notifier import acknowledge_hitl
        acknowledge_hitl(item_id)
    except Exception:
        pass

    # "gc" = Picked up in GravityClaw — acknowledge only, don't change status
    if action == "gc":
        await _th_post("add-comment", {
            "item_id": item_id,
            "content": "[GC] Picked up in GravityClaw — handling externally",
            "author_id": config.SYSTEM_USER_ID,
        })
        return {"success": True, "action": "gc", "item_id": item_id}

    # Get current item to determine context-aware status transition
    item = await _th_get("get-item", {"item_id": item_id})
    current_status = (item.get("status", "") if item else "").lower()

    # Context-aware status mapping:
    #   "review" items being approved → work accepted, mark done
    #   "awaiting-human"/"blocked" items being approved → dispatch for execution
    if action == "approve" and current_status == "review":
        new_status = "done"
    else:
        status_map = {
            "approve": "assigned",
            "run": "in-progress",
            "dismiss": "dismissed",
            "reject": "dismissed",
            "unblock": "assigned",
            "reassign": "assigned",
        }
        new_status = status_map.get(action)

    if not new_status:
        raise HTTPException(status_code=400, detail=f"Unknown action: {action}")

    # Update Team Hub status
    result = await _th_patch("update-item", {
        "item_id": item_id,
        "status": new_status,
    })

    # Add comment if reason provided
    reason = data.get("reason", "")
    if reason or action in ("reject", "dismiss"):
        comment = reason or f"Action: {action}"
        await _th_post("add-comment", {
            "item_id": item_id,
            "content": f"[{action.upper()}] {comment}",
            "author_id": config.SYSTEM_USER_ID,
        })

    # If "run" or "approve" (and NOT review-done), trigger fleet dispatch
    if action in ("run", "approve") and new_status != "done":
        await _trigger_dispatch(item_id, data)

    return {"success": True, "action": action, "new_status": new_status, "item_id": item_id}


async def _trigger_dispatch(teamhub_item_id: str, data: dict):
    """Trigger fleet dispatch for a Team Hub item.

    Creates a registry task if needed, then dispatches via fleet coordinator
    or auto_execute_cycle. Works with or without explicit worker_id.
    """
    try:
        # Get item details for dispatch context
        item = await _th_get("get-item", {"item_id": teamhub_item_id})
        if not item:
            return

        worker_id = data.get("worker_id")  # Optional: specific worker
        title = item.get("title", "")
        description = item.get("description", "")

        # 1. Check if there's already a linked registry task (by teamhub_item_id)
        import services.task_processor as tp
        registry = tp.read_registry()
        linked_task = None
        for tid, task in registry.get("tasks", {}).items():
            meta = task.get("metadata", {})
            if meta.get("teamhub_item_id") == teamhub_item_id:
                linked_task = task
                break

        # 2. If a linked task exists, approve it (set to scheduled)
        if linked_task:
            linked_task["status"] = "scheduled"
            linked_task["updatedAt"] = datetime.now(timezone.utc).isoformat()
            linked_task.setdefault("routing", {})["mode"] = "execute"
            tp.write_registry(registry)
            logger.info("Approved linked registry task %s for TH item %s",
                        linked_task.get("id"), teamhub_item_id)
            return

        # 3. No linked task — create one in the registry
        tid = tp.generate_task_id(registry)
        now = datetime.now(timezone.utc).isoformat()

        if worker_id:
            routing = {"type": "agent-assigned", "mode": "execute", "agentType": worker_id}
        else:
            routing = {"type": "default", "mode": "execute"}

        registry.setdefault("tasks", {})[tid] = {
            "id": tid,
            "title": title,
            "description": description[:2000] if description else "",
            "source": "action-items",
            "priority": item.get("priority", "normal"),
            "assignee": "agent",
            "status": "scheduled",
            "routing": routing,
            "createdAt": now,
            "updatedAt": now,
            "completedAt": None,
            "metadata": {"teamhub_item_id": teamhub_item_id},
            "agentConfig": {
                "agentType": "claude-direct",
                "agentName": worker_id or "auto",
                "instructions": description[:2000] if description else title,
            },
        }
        tp.write_registry(registry)
        logger.info("Created registry task %s for TH item %s (worker: %s)",
                     tid, teamhub_item_id, worker_id or "auto-route")

        # 4. Dispatch via fleet coordinator (auto-routes when worker_id is None)
        from routes.fleet import _coordinator
        if _coordinator:
            result = await _coordinator.manual_dispatch(tid, worker_id)
            logger.info("Fleet dispatch result: %s", result)
        else:
            logger.warning("Fleet coordinator not available — task %s awaiting manual pickup", tid)

    except Exception as e:
        logger.warning("Dispatch trigger failed: %s", e)


def _act_guardrails(request_id: str, action: str) -> dict:
    """Handle guardrails approval/denial."""
    from services.guardrails import approve_request, deny_request
    if action == "approve":
        result = approve_request(request_id)
    elif action == "deny":
        result = deny_request(request_id)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown guardrails action: {action}")
    return {"success": True, "action": action, "request_id": request_id}


async def _act_heartbeat(worker_id: str, action: str) -> dict:
    """Handle actions on stalled/failed workers."""
    if action == "restart":
        try:
            from background.worker_manager import WorkerManager
            # We need to access the global worker manager — it's set up in app.py
            # Use the workers route's reference
            from routes.workers import _manager
            if _manager:
                result = _manager.restart_worker(worker_id)
                return {"success": True, "action": "restart", "worker_id": worker_id, "result": str(result)}
        except Exception as e:
            return {"success": False, "error": str(e)}
    elif action == "dismiss":
        return {"success": True, "action": "dismiss", "worker_id": worker_id}
    raise HTTPException(status_code=400, detail=f"Unknown heartbeat action: {action}")


def _act_suggestion(suggestion_id: str, action: str, data: dict) -> dict:
    """Handle actions on suggestions."""
    try:
        if not config.UPDATER_SUGGESTIONS_FILE.is_file():
            raise HTTPException(status_code=404, detail="No suggestions file")

        suggestions = json.loads(config.UPDATER_SUGGESTIONS_FILE.read_text())
        now = datetime.now(timezone.utc).isoformat()
        for sug in suggestions.get("suggestions", []):
            if sug.get("id") == suggestion_id:
                if action == "accept":
                    sug["status"] = "accepted"
                    sug["accepted_at"] = now
                elif action == "dismiss":
                    sug["status"] = "dismissed"
                    sug["dismissed_at"] = now
                else:
                    raise HTTPException(status_code=400, detail=f"Unknown action: {action}")

                config.UPDATER_SUGGESTIONS_FILE.write_text(
                    json.dumps(suggestions, indent=2, default=str)
                )
                return {"success": True, "action": action, "suggestion_id": suggestion_id}

        raise HTTPException(status_code=404, detail="Suggestion not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Worker Dispatch Endpoint ─────────────────────────────


@router.post("/dispatch", dependencies=[Depends(require_admin)])
async def dispatch_worker(data: dict = Body(...)):
    """Manually dispatch a local worker/agent.

    Body:
        worker_id: str (optional) — registered worker ID; omit for auto-routing
        task_id: str (optional) — existing registry task to dispatch
        title: str (optional) — ad-hoc task title
        description: str (optional) — task details
        teamhub_item_id: str (optional) — link to Team Hub item
    """
    worker_id = data.get("worker_id")  # None = auto-route via fleet coordinator

    task_id = data.get("task_id")
    title = data.get("title", f"Manual dispatch: {worker_id or 'auto'}")
    description = data.get("description", "")
    teamhub_item_id = data.get("teamhub_item_id")

    try:
        from routes.fleet import _coordinator
        if not _coordinator:
            raise HTTPException(status_code=503, detail="Fleet coordinator not initialized")

        # If task_id provided, dispatch that task
        if task_id:
            result = await _coordinator.manual_dispatch(task_id, worker_id)
        else:
            # Create an ad-hoc task in registry, then dispatch
            import services.task_processor as tp
            from datetime import datetime, timezone as tz
            registry = tp.read_registry()
            tid = tp.generate_task_id(registry)
            now = datetime.now(tz.utc).isoformat()

            # For auto-routing, use generic routing so fleet coordinator picks
            if worker_id:
                routing = {"type": "agent-assigned", "mode": "execute", "agentType": worker_id}
                agent_config = {
                    "agentId": worker_id,
                    "agentType": "claude-direct",
                    "agentName": worker_id,
                    "instructions": description,
                }
            else:
                routing = {"type": "default", "mode": "execute"}
                agent_config = {
                    "agentType": "claude-direct",
                    "instructions": description,
                }

            registry.setdefault("tasks", {})[tid] = {
                "id": tid,
                "title": title,
                "description": description,
                "source": "dashboard",
                "priority": data.get("priority", "normal"),
                "assignee": "agent",
                "status": "scheduled",
                "routing": routing,
                "createdAt": now,
                "updatedAt": None,
                "completedAt": None,
                "agentConfig": agent_config,
            }
            tp.write_registry(registry)
            result = await _coordinator.manual_dispatch(tid, worker_id)

        # Update Team Hub item if linked
        dispatched_worker = result.get("worker_id", worker_id or "auto")
        if teamhub_item_id and result.get("success"):
            await _th_patch("update-item", {
                "item_id": teamhub_item_id,
                "status": "in-progress",
            })
            await _th_post("add-comment", {
                "item_id": teamhub_item_id,
                "content": f"Dispatched to worker: {dispatched_worker} (dispatch: {result.get('dispatch_id', '?')})",
                "author_id": "system",
            })

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Dispatch failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/workers/available", dependencies=[Depends(require_admin)])
async def list_available_workers():
    """List workers available for dispatch."""
    try:
        from routes.workers import _manager
        if not _manager:
            return {"workers": []}

        workers = []
        for wid, winfo in _manager.workers.items():
            is_running = wid in _manager.task_processes and (
                _manager.task_processes[wid].returncode is None
            ) if wid in _manager.task_processes else False

            intent = winfo.get("intent", {})
            workers.append({
                "id": wid,
                "name": winfo.get("name", wid),
                "type": winfo.get("type", ""),
                "running": is_running or winfo.get("running", False),
                "description": winfo.get("description", ""),
                "category": winfo.get("category", ""),
                "intent": intent.get("purpose", ""),
            })

        # Add NFS external workers
        try:
            from app import nfs_dispatcher
            for slug, health in nfs_dispatcher.get_worker_health().items():
                workers.append({
                    "id": f"nfs:{slug}",
                    "name": f"NFS: {slug}",
                    "type": "nfs-external",
                    "running": health.get("status") == "healthy",
                    "description": f"NFS worker — {health.get('status', 'unknown')}",
                    "category": "external",
                })
        except Exception:
            pass

        return {"workers": workers}
    except Exception as e:
        logger.debug("Workers list: %s", e)
        return {"workers": []}
