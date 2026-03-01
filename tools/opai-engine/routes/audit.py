"""OPAI Engine — Audit endpoints.

Migrated from TCP routes_api.py audit section.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

import services.task_processor as tp
from auth import require_admin

router = APIRouter(prefix="/api")


@router.get("/audit")
def list_audit(
    tier: str | None = None,
    service: str | None = None,
    status: str | None = None,
    event: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 100,
    offset: int = 0,
):
    """List audit records with optional filters."""
    records = tp.read_audit()

    if tier:
        records = [r for r in records if r.get("tier") == tier]
    if service:
        records = [r for r in records if r.get("service") == service]
    if status:
        records = [r for r in records if r.get("status") == status]
    if event:
        records = [r for r in records if r.get("event") == event]
    if date_from:
        records = [r for r in records if (r.get("timestamp") or "") >= date_from]
    if date_to:
        records = [r for r in records if (r.get("timestamp") or "") <= date_to]

    total = len(records)
    records = records[offset:offset + limit]
    return {"records": records, "total": total}


@router.get("/audit/summary")
def audit_summary(date_from: str = "", date_to: str = ""):
    """Aggregated audit stats."""
    records = tp.read_audit()
    return tp.get_audit_summary(records, date_from, date_to)


@router.get("/audit/{audit_id}/trace")
def audit_trace(audit_id: str):
    """Extract tool call trace from a session JSONL."""
    records = tp.read_audit()
    record = next((r for r in records if r.get("id") == audit_id), None)
    if not record:
        raise HTTPException(404, f"Audit record {audit_id} not found")

    session_id = tp.find_session_for_audit(record)
    if not session_id:
        return {"trace": [], "session_id": None}

    trace = tp.extract_session_trace(session_id)
    return {"trace": trace, "session_id": session_id}


@router.post("/audit/{audit_id}/analyze", dependencies=[Depends(require_admin)])
async def audit_analyze(audit_id: str):
    """Stream Claude analysis of an audit record via SSE."""
    records = tp.read_audit()
    record = next((r for r in records if r.get("id") == audit_id), None)
    if not record:
        raise HTTPException(404, f"Audit record {audit_id} not found")

    session_id = tp.find_session_for_audit(record)
    trace = tp.extract_session_trace(session_id) if session_id else []

    messages = [
        {"role": "user", "content": f"Analyze this OPAI audit record:\n\n{record}\n\nTool trace:\n{trace}"}
    ]

    return StreamingResponse(
        tp.stream_audit_analysis(record, messages),
        media_type="text/event-stream",
    )
