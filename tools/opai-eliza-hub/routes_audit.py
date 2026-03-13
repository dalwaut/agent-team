"""Eliza Hub — Audit & interaction log routes.

View interaction history, audit events, flag interactions,
and export data.
"""
import csv
import io
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

import config

try:
    from auth import get_user_from_request
except ImportError:
    async def get_user_from_request(request):
        return type("U", (), {"id": config.ADMIN_USER_ID})()

log = logging.getLogger("eliza-hub.audit")
router = APIRouter(prefix="/api/audit", tags=["audit"])


async def supabase_request(method: str, path: str, body=None, params=None):
    headers = {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.request(method, url, json=body, headers=headers, params=params)
        if resp.status_code >= 400:
            log.error(f"Supabase {method} {path}: {resp.status_code} — {resp.text}")
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        try:
            return resp.json()
        except Exception:
            return {"status": "ok"}


# ── Interactions ───────────────────────────────────────────

@router.get("/interactions")
async def list_interactions(
    request: Request,
    agent_id: Optional[str] = None,
    direction: Optional[str] = None,
    channel: Optional[str] = None,
    info_class: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = Query(50, le=500),
    offset: int = 0,
):
    user = await get_user_from_request(request)
    params = {
        "select": "*",
        "owner_id": f"eq.{user.id}",
        "order": "created_at.desc",
        "limit": str(limit),
        "offset": str(offset),
    }
    if agent_id:
        params["agent_id"] = f"eq.{agent_id}"
    if direction:
        params["direction"] = f"eq.{direction}"
    if channel:
        params["channel"] = f"eq.{channel}"
    if info_class:
        params["info_class"] = f"eq.{info_class}"
    if date_from:
        params["created_at"] = f"gte.{date_from}"
    if date_to:
        params["created_at"] = f"lte.{date_to}"

    interactions = await supabase_request("GET", "eliza_interactions", params=params)
    return {"interactions": interactions, "count": len(interactions)}


@router.get("/interactions/{interaction_id}")
async def get_interaction(request: Request, interaction_id: str):
    user = await get_user_from_request(request)
    params = {
        "id": f"eq.{interaction_id}",
        "owner_id": f"eq.{user.id}",
        "select": "*",
    }
    items = await supabase_request("GET", "eliza_interactions", params=params)
    if not items:
        raise HTTPException(404, "Interaction not found")
    return items[0]


# ── Audit log ──────────────────────────────────────────────

@router.get("/events")
async def list_audit_events(
    request: Request,
    agent_id: Optional[str] = None,
    severity: Optional[str] = None,
    action: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = Query(50, le=500),
    offset: int = 0,
):
    user = await get_user_from_request(request)
    params = {
        "select": "*",
        "owner_id": f"eq.{user.id}",
        "order": "created_at.desc",
        "limit": str(limit),
        "offset": str(offset),
    }
    if agent_id:
        params["agent_id"] = f"eq.{agent_id}"
    if severity:
        params["severity"] = f"eq.{severity}"
    if action:
        params["action"] = f"ilike.%{action}%"
    if date_from:
        params["created_at"] = f"gte.{date_from}"
    if date_to:
        params["created_at"] = f"lte.{date_to}"

    events = await supabase_request("GET", "eliza_audit_log", params=params)
    return {"events": events, "count": len(events)}


# ── Flag interaction ───────────────────────────────────────

@router.post("/interactions/{interaction_id}/flag")
async def flag_interaction(request: Request, interaction_id: str):
    """Flag an interaction for review."""
    user = await get_user_from_request(request)
    body = await request.json()

    # Get the interaction to find agent_id
    params = {"id": f"eq.{interaction_id}", "owner_id": f"eq.{user.id}", "select": "*"}
    items = await supabase_request("GET", "eliza_interactions", params=params)
    if not items:
        raise HTTPException(404, "Interaction not found")

    interaction = items[0]

    # Create audit event for flagging
    await supabase_request("POST", "eliza_audit_log", body={
        "agent_id": interaction.get("agent_id"),
        "owner_id": user.id,
        "action": "interaction_flagged",
        "details": {
            "interaction_id": interaction_id,
            "reason": body.get("reason", "Manual review"),
            "flagged_by": user.id,
        },
        "severity": "warn",
    })

    # Update interaction metadata to mark as flagged
    await supabase_request("PATCH", "eliza_interactions", body={
        "metadata": {**interaction.get("metadata", {}), "flagged": True, "flag_reason": body.get("reason", "")},
    }, params={"id": f"eq.{interaction_id}"})

    return {"success": True}


# ── Stats ──────────────────────────────────────────────────

@router.get("/stats")
async def audit_stats(request: Request, agent_id: Optional[str] = None):
    """Get aggregate stats for interactions and audit events."""
    user = await get_user_from_request(request)

    # Count interactions by classification
    interaction_params = {
        "select": "info_class",
        "owner_id": f"eq.{user.id}",
    }
    if agent_id:
        interaction_params["agent_id"] = f"eq.{agent_id}"
    interactions = await supabase_request("GET", "eliza_interactions", params=interaction_params)

    class_counts = {}
    for i in interactions:
        cls = i.get("info_class", "unknown")
        class_counts[cls] = class_counts.get(cls, 0) + 1

    # Count audit events by severity
    event_params = {
        "select": "severity",
        "owner_id": f"eq.{user.id}",
    }
    if agent_id:
        event_params["agent_id"] = f"eq.{agent_id}"
    events = await supabase_request("GET", "eliza_audit_log", params=event_params)

    severity_counts = {}
    for e in events:
        sev = e.get("severity", "info")
        severity_counts[sev] = severity_counts.get(sev, 0) + 1

    return {
        "total_interactions": len(interactions),
        "by_classification": class_counts,
        "total_events": len(events),
        "by_severity": severity_counts,
    }


# ── CSV Export ─────────────────────────────────────────────

@router.get("/export/interactions")
async def export_interactions(
    request: Request,
    agent_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    """Export interactions as CSV."""
    user = await get_user_from_request(request)
    params = {
        "select": "*",
        "owner_id": f"eq.{user.id}",
        "order": "created_at.desc",
        "limit": "5000",
    }
    if agent_id:
        params["agent_id"] = f"eq.{agent_id}"
    if date_from:
        params["created_at"] = f"gte.{date_from}"
    if date_to:
        params["created_at"] = f"lte.{date_to}"

    interactions = await supabase_request("GET", "eliza_interactions", params=params)

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=[
        "created_at", "agent_id", "direction", "channel", "info_class",
        "content", "tokens_used", "latency_ms",
    ])
    writer.writeheader()
    for row in interactions:
        writer.writerow({k: row.get(k, "") for k in writer.fieldnames})

    output.seek(0)
    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=eliza_interactions.csv"},
    )
