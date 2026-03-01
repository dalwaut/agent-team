"""HELM — HITL (Human-in-the-Loop) queue helpers and action logging."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx

import config
from core.supabase import _sb_post, _sb_get

log = logging.getLogger("helm.hitl")


async def create_hitl_item(
    business_id: str,
    action_type: str,
    title: str,
    description: str,
    payload: dict,
    risk_level: str = "medium",
    expires_hours: int | None = None,
    execution_hook: str | None = None,
) -> str:
    """Create a HITL queue item for human review.

    Returns the HITL item ID.
    """
    now = datetime.now(timezone.utc)
    expires_at = None
    if expires_hours:
        expires_at = (now + timedelta(hours=expires_hours)).isoformat()

    item = {
        "business_id": business_id,
        "action_type": action_type,
        "title": title,
        "description": description,
        "execution_payload": payload,
        "risk_level": risk_level,
        "status": "pending",
        "expires_at": expires_at,
        "execution_hook": execution_hook,
    }

    result = await _sb_post("helm_business_hitl_queue", item)
    hitl_id = result[0]["id"] if isinstance(result, list) and result else result.get("id", "")

    # Broadcast via Supabase Realtime
    try:
        await _broadcast_realtime(business_id, {
            "type": "hitl_new",
            "hitl_id": hitl_id,
            "title": title,
            "risk_level": risk_level,
            "action_type": action_type,
        })
    except Exception as exc:
        log.warning("Failed to broadcast HITL realtime event: %s", exc)

    # Post to Discord if configured
    try:
        level = "warn" if risk_level == "high" else "info"
        await broadcast_to_discord(
            business_id,
            f"HITL [{risk_level.upper()}] {title}: {description[:200]}",
            level=level,
        )
    except Exception as exc:
        log.warning("Failed to post HITL to Discord: %s", exc)

    log.info("Created HITL item %s for business %s: %s", hitl_id, business_id, title)
    return hitl_id


async def _broadcast_realtime(business_id: str, payload: dict) -> None:
    """Broadcast event via Supabase Realtime HTTP API."""
    if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
        return

    url = f"{config.SUPABASE_URL}/realtime/v1/api/broadcast"
    headers = {"apikey": config.SUPABASE_SERVICE_KEY, "Content-Type": "application/json"}
    body = {
        "messages": [{
            "topic": f"realtime:helm_{business_id}",
            "event": "broadcast",
            "payload": payload,
        }]
    }

    async with httpx.AsyncClient(timeout=10) as c:
        await c.post(url, headers=headers, json=body)


async def broadcast_to_discord(business_id: str, message: str, level: str = "info") -> None:
    """Post notification to Discord bridge webhook."""
    if not config.DISCORD_BRIDGE_URL:
        return

    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(
                f"{config.DISCORD_BRIDGE_URL}/api/webhook",
                json={
                    "source": "helm",
                    "level": level,
                    "message": message,
                    "business_id": business_id,
                },
            )
    except Exception as exc:
        log.warning("Discord broadcast failed: %s", exc)


async def log_action(
    business_id: str,
    action_type: str,
    summary: str,
    detail: str | None = None,
    status: str = "success",
    tokens_used: int = 0,
    cost_usd: float = 0,
    duration_ms: int = 0,
    resource_type: str | None = None,
    resource_id: str | None = None,
) -> None:
    """Log an action to helm_business_actions AND post to OPAI Task Registry."""
    now = datetime.now(timezone.utc)
    action_id = str(uuid.uuid4())

    action_row = {
        "business_id": business_id,
        "action_type": action_type,
        "summary": summary,
        "status": status,
        "tokens_used": tokens_used,
        "cost_usd": float(cost_usd),
        "duration_ms": int(duration_ms),
        "resource_type": resource_type,
        "actor": "helm",
    }
    if detail is not None:
        action_row["detail"] = detail
    # resource_id must be a valid UUID or omitted
    if resource_id and len(str(resource_id)) == 36:
        action_row["resource_id"] = str(resource_id)

    try:
        await _sb_post("helm_business_actions", action_row)
    except Exception as exc:
        log.error("Failed to log action to Supabase: %s", exc)

    # Post to OPAI Task Registry (TCP integration)
    task_entry = {
        "title": f"HELM: {summary}",
        "type": "helm_action",
        "status": "completed" if status == "success" else "failed",
        "agent": "helm-bot",
        "source": "helm",
        "business_id": business_id,
        "helm_status": status,
        "tags": ["helm", action_type],
    }

    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(
                f"{config.TASKS_URL}/api/tasks",
                json=task_entry,
                headers={"Content-Type": "application/json"},
            )
    except Exception as exc:
        log.warning("Failed to post to Task Registry: %s", exc)
