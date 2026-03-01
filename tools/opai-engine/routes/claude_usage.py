"""OPAI Engine — Claude usage endpoints.

Migrated from opai-monitor. Session collector now lives in engine services/.
"""

from fastapi import APIRouter, Depends, HTTPException, Query

from services import session_collector

router = APIRouter(prefix="/api")


@router.get("/claude/usage")
def claude_usage():
    """Live Claude usage stats — optimized for 5s polling."""
    return session_collector.get_live_usage()


@router.get("/claude/dashboard")
def claude_dashboard():
    """Aggregated Claude usage dashboard."""
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
    """Claude Code installation status."""
    return session_collector.get_claude_status()


@router.get("/claude/document")
def claude_document(path: str = Query(..., description="Absolute path to document")):
    """Read a Claude settings document."""
    from pathlib import Path as P
    allowed_prefixes = [
        str(P.home() / ".claude/"),
        "/workspace/synced/opai/CLAUDE.md",
    ]
    resolved = str(P(path).resolve())
    if not any(resolved == p or resolved.startswith(p) for p in allowed_prefixes):
        raise HTTPException(403, "Access denied: path not in allowed Claude config locations")
    fp = P(resolved)
    if not fp.is_file():
        raise HTTPException(404, "File not found")
    try:
        content = fp.read_text(errors="replace")
    except Exception as e:
        raise HTTPException(500, f"Failed to read file: {e}")
    return {"path": resolved, "filename": fp.name, "content": content}


@router.get("/claude/plan-usage")
def claude_plan_usage():
    """Live plan usage from Anthropic OAuth API."""
    return session_collector.get_plan_usage()
