"""HELM — Action log and HITL queue routes."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

from core.supabase import _sb_get, _sb_patch, _sb_post

log = logging.getLogger("helm.routes.actions")
router = APIRouter()


# -- Access check --

async def _check_access(user: AuthUser, business_id: str) -> bool:
    if user.is_admin:
        return True
    rows = await _sb_get(
        f"helm_business_access?business_id=eq.{business_id}&user_id=eq.{user.id}&select=id"
    )
    return bool(rows)


# -- Request models --

class HITLReview(BaseModel):
    reviewer_notes: Optional[str] = None
    reason: Optional[str] = None  # rejection reason alias


# -- Endpoints --

@router.get("/api/businesses/{business_id}/actions")
async def list_actions(
    business_id: str,
    action_type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    user: AuthUser = Depends(get_current_user),
):
    """Paginated list of business actions with optional filters."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    query = f"helm_business_actions?business_id=eq.{business_id}"
    if action_type:
        query += f"&action_type=eq.{action_type}"
    if status:
        query += f"&status=eq.{status}"
    if date_from:
        query += f"&created_at=gte.{date_from}"
    if date_to:
        query += f"&created_at=lte.{date_to}"

    query += f"&order=created_at.desc&limit={limit}&offset={offset}&select=*"

    return await _sb_get(query)


@router.get("/api/businesses/{business_id}/actions/{action_id}")
async def get_action(
    business_id: str,
    action_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Get full action detail with payload."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        f"helm_business_actions?id=eq.{action_id}&business_id=eq.{business_id}&select=*"
    )
    if not rows:
        raise HTTPException(404, "Action not found")

    return rows[0]


@router.get("/api/businesses/{business_id}/hitl")
async def list_hitl(
    business_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """List pending HITL items ordered by risk_level priority."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    # Fetch all items (pending + recently resolved for history)
    rows = await _sb_get(
        f"helm_business_hitl_queue?business_id=eq.{business_id}"
        f"&order=created_at.desc&limit=50&select=*"
    )
    if not rows:
        return []

    # Sort pending by risk priority, resolved by date
    pending = [r for r in rows if r.get("status") == "pending"]
    resolved = [r for r in rows if r.get("status") != "pending"]

    priority_map = {"high": 0, "medium": 1, "low": 2}
    pending.sort(key=lambda r: priority_map.get(r.get("risk_level", "medium"), 1))

    return pending + resolved


@router.post("/api/businesses/{business_id}/hitl/{hitl_id}/approve")
async def approve_hitl(
    business_id: str,
    hitl_id: str,
    body: HITLReview = None,
    user: AuthUser = Depends(get_current_user),
):
    """Approve a HITL item. Calls execution_hook if set."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    # Verify item exists and is pending
    rows = await _sb_get(
        f"helm_business_hitl_queue?id=eq.{hitl_id}&business_id=eq.{business_id}&select=*"
    )
    if not rows:
        raise HTTPException(404, "HITL item not found")

    item = rows[0]
    if item.get("status") != "pending":
        raise HTTPException(400, f"Item is already {item.get('status')}")

    from datetime import datetime, timezone
    update = {
        "status": "approved",
        "reviewed_by": user.id,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
    }
    if body and body.reviewer_notes:
        update["reviewer_notes"] = body.reviewer_notes

    await _sb_patch(f"helm_business_hitl_queue?id=eq.{hitl_id}", update)

    # Update the underlying resource status
    action_type = item.get("action_type", "")
    payload = item.get("execution_payload") or {}
    if isinstance(payload, str):
        import json
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}

    from datetime import datetime, timezone
    now_z = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'

    content_id = payload.get("content_id")
    report_id  = payload.get("report_id")

    dispatch_info: dict = {}

    if action_type == "content_review" and content_id:
        try:
            await _sb_patch(
                f"helm_business_content?id=eq.{content_id}&business_id=eq.{business_id}",
                {"status": "approved", "updated_at": now_z},
            )
        except Exception as exc:
            log.warning("Failed to update content status on approve: %s", exc)

        # Dispatch: fetch content details and queue for publishing
        try:
            c_rows = await _sb_get(
                f"helm_business_content?id=eq.{content_id}&business_id=eq.{business_id}&select=*"
            )
            if c_rows:
                c = c_rows[0]
                c_platform = c.get("platform", "website")
                c_type = c.get("content_type", "blog_post")
                c_title = c.get("title", "Content")
                c_body = (c.get("body") or c.get("content") or "")[:500]
                c_sched = c.get("scheduled_at")

                # Check for connected social account
                connected_accounts = []
                if c_platform not in ("website", "blog", "email"):
                    connected_accounts = await _sb_get(
                        f"helm_business_social_accounts?business_id=eq.{business_id}&platform=eq.{c_platform}&active=eq.true&select=id,platform,handle"
                    )

                if c_sched:
                    # Has a scheduled time — move to scheduled status
                    await _sb_patch(
                        f"helm_business_content?id=eq.{content_id}",
                        {"status": "scheduled"},
                    )
                    dispatch_info = {"action": "scheduled", "scheduled_at": c_sched}
                elif connected_accounts:
                    # Auto-queue social post
                    account = connected_accounts[0]
                    await _sb_post("helm_business_social_posts", {
                        "business_id": business_id,
                        "account_id": account["id"],
                        "content_id": content_id,
                        "platform": c_platform,
                        "caption": c_body,
                        "status": "scheduled",
                        "scheduled_at": now_z,
                    })
                    await _sb_patch(
                        f"helm_business_content?id=eq.{content_id}",
                        {"status": "scheduled"},
                    )
                    dispatch_info = {
                        "action": "queued_social",
                        "platform": c_platform,
                        "handle": account.get("handle"),
                    }
                    log.info("Content %s queued for social post on %s", content_id, c_platform)
                else:
                    # No connector — create a HITL publish task
                    platform_label = c_platform.replace("_", " ").title()
                    hitl_desc = (
                        f"Content approved and ready to publish.\n\n"
                        f"**Title:** {c_title}\n"
                        f"**Platform:** {platform_label}\n"
                        f"**Type:** {c_type.replace('_', ' ').title()}\n\n"
                        f"**Content preview:**\n{c_body}{'…' if len(c_body) == 500 else ''}\n\n"
                        f"Please publish this content to {platform_label} and mark the content as published."
                    )
                    await _sb_post("helm_business_hitl_queue", {
                        "business_id": business_id,
                        "action_type": "content_publish",
                        "title": f"Publish: {c_title}",
                        "description": hitl_desc,
                        "status": "pending",
                        "execution_payload": {
                            "content_id": content_id,
                            "platform": c_platform,
                            "content_type": c_type,
                        },
                    })
                    dispatch_info = {
                        "action": "hitl_queued",
                        "platform": c_platform,
                        "message": f"Queued for manual publish to {platform_label}",
                    }
                    log.info("Content %s — no connector for %s, HITL publish task created", content_id, c_platform)
        except Exception as exc:
            log.warning("Content dispatch error (non-fatal): %s", exc)
            dispatch_info = {"action": "error", "message": str(exc)}

    elif action_type == "report_review" and report_id:
        try:
            await _sb_patch(
                f"helm_business_reports?id=eq.{report_id}&business_id=eq.{business_id}",
                {"status": "reviewed"},
            )
        except Exception as exc:
            log.warning("Failed to update report status on approve: %s", exc)

    # Execute hook if set
    execution_hook = item.get("execution_hook")
    if execution_hook:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=30) as c:
                await c.post(execution_hook, json={
                    "hitl_id": hitl_id,
                    "business_id": business_id,
                    "action": "approved",
                    "payload": item.get("payload"),
                })
        except Exception as exc:
            log.warning("Execution hook failed for HITL %s: %s", hitl_id, exc)

    return {"approved": True, "hitl_id": hitl_id, "dispatch": dispatch_info}


@router.post("/api/businesses/{business_id}/hitl/{hitl_id}/reject")
async def reject_hitl(
    business_id: str,
    hitl_id: str,
    body: HITLReview = None,
    user: AuthUser = Depends(get_current_user),
):
    """Reject a HITL item. Saves reviewer_notes."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        f"helm_business_hitl_queue?id=eq.{hitl_id}&business_id=eq.{business_id}&select=*"
    )
    if not rows:
        raise HTTPException(404, "HITL item not found")

    item = rows[0]
    if item.get("status") != "pending":
        raise HTTPException(400, f"Item is already {item.get('status')}")

    from datetime import datetime, timezone
    note = (body.reviewer_notes or body.reason or "") if body else ""
    update = {
        "status": "rejected",
        "reviewed_by": user.id,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
    }
    if note:
        update["reviewer_notes"] = note

    await _sb_patch(f"helm_business_hitl_queue?id=eq.{hitl_id}", update)

    # Update the underlying resource status
    action_type = item.get("action_type", "")
    payload = item.get("execution_payload") or {}
    if isinstance(payload, str):
        import json
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}

    now_z = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
    content_id = payload.get("content_id")
    if action_type == "content_review" and content_id:
        try:
            await _sb_patch(
                f"helm_business_content?id=eq.{content_id}&business_id=eq.{business_id}",
                {"status": "rejected", "updated_at": now_z},
            )
        except Exception as exc:
            log.warning("Failed to update content status on reject: %s", exc)

    return {"rejected": True, "hitl_id": hitl_id}
