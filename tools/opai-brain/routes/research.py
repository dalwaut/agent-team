"""2nd Brain — Research session routes (Phase 2)."""
from __future__ import annotations

import asyncio
import logging
import sys
import uuid
from datetime import timezone, datetime
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

sys.path.insert(0, str(Path(__file__).parent.parent))
from claude_cli import call_claude

import config

log = logging.getLogger("brain.routes.research")
router = APIRouter()


def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers=_svc_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, body) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else rows


async def _sb_patch(path: str, params: str, body: dict) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.patch(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else {}


class ResearchCreate(BaseModel):
    query: str
    scope: Optional[str] = None  # Optional focus area hint


# ── Background researcher ──────────────────────────────────────────────────────

async def _run_research(session_id: str, user_id: str, query: str, scope: Optional[str]):
    """Background task: call Claude, synthesize a research note, create brain_node."""
    try:
        # Mark as running
        await _sb_patch(
            "brain_research",
            f"id=eq.{session_id}",
            {"status": "running"},
        )

        scope_line = f"\nFocus area: {scope}" if scope else ""
        prompt = (
            f"You are a research assistant creating a structured knowledge note.\n"
            f"Research topic: {query}{scope_line}\n\n"
            f"Write a comprehensive, well-structured research note in Markdown. Include:\n"
            f"1. An executive summary (2–3 sentences)\n"
            f"2. Key concepts and definitions\n"
            f"3. Core findings or facts (bullet points)\n"
            f"4. Practical implications or applications\n"
            f"5. Related topics worth exploring\n"
            f"6. Open questions\n\n"
            f"Use clear headings (## for sections). Be thorough but concise. "
            f"Mark speculative claims with '(speculative)'. "
            f"Do not include a sources section — focus on synthesized knowledge.\n\n"
            f"Return only the Markdown note, no preamble."
        )

        content = await call_claude(prompt, model=config.CLAUDE_MODEL, timeout=180)

        # Create brain_node with the result
        now = datetime.now(timezone.utc).isoformat()
        node = await _sb_post("brain_nodes", {
            "user_id": user_id,
            "type": "note",
            "title": f"Research: {query[:80]}",
            "content": content,
            "metadata": {"source": "brain_researcher", "research_id": session_id},
        })
        node_id = node.get("id")

        # Tag it
        if node_id:
            try:
                await _sb_post("brain_tags", [
                    {"node_id": node_id, "tag": "research"},
                    {"node_id": node_id, "tag": query.split()[0].lower()[:20] if query else "research"},
                ])
            except Exception:
                pass

        # Mark session done
        await _sb_patch(
            "brain_research",
            f"id=eq.{session_id}",
            {"status": "done", "result_node": node_id},
        )
        log.info("[research] Session %s done → node %s", session_id, node_id)

    except Exception as e:
        error_msg = str(e)[:500]
        log.error("[research] Session %s failed: %s", session_id, error_msg)
        try:
            await _sb_patch(
                "brain_research",
                f"id=eq.{session_id}",
                {"status": "failed", "error_message": error_msg},
            )
        except Exception:
            pass


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/api/research")
async def list_research(
    limit: int = 20,
    user: AuthUser = Depends(get_current_user),
):
    """List all research sessions for the current user."""
    rows = await _sb_get(
        "brain_research",
        f"user_id=eq.{user.id}&order=created_at.desc&limit={limit}&select=*",
    )
    return {"sessions": rows, "total": len(rows)}


@router.post("/api/research")
async def create_research(
    body: ResearchCreate,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
):
    """Create a new research session. Runs synthesis in background."""
    if not body.query.strip():
        raise HTTPException(400, "Query is required")

    # Tier gate: Research requires pro, ultimate, or admin
    if not user.is_admin and user.marketplace_tier not in ("pro", "ultimate"):
        raise HTTPException(403, "Research requires a Pro or Ultimate plan")

    # Quota check for non-admins (20 sessions/month)
    if not user.is_admin:
        from routes.tier import get_research_usage_this_month
        used = await get_research_usage_this_month(user.id)
        if used >= 20:
            raise HTTPException(429, "Monthly research quota (20) reached")

    session = await _sb_post("brain_research", {
        "user_id": user.id,
        "query": body.query.strip(),
        "status": "pending",
    })
    session_id = session.get("id")
    if not session_id:
        raise HTTPException(500, "Failed to create session")

    background_tasks.add_task(_run_research, session_id, user.id, body.query.strip(), body.scope)
    return session


@router.get("/api/research/{session_id}")
async def get_research(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Get a research session by ID (poll for status)."""
    rows = await _sb_get(
        "brain_research",
        f"id=eq.{session_id}&user_id=eq.{user.id}&select=*",
    )
    if not rows:
        raise HTTPException(404, "Session not found")
    session = rows[0]

    # If done, attach the result node
    if session.get("result_node"):
        node_rows = await _sb_get(
            "brain_nodes",
            f"id=eq.{session['result_node']}&select=id,title,type",
        )
        session["node"] = node_rows[0] if node_rows else None

    return session


@router.delete("/api/research/{session_id}")
async def delete_research(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Delete a research session (does not delete the result node)."""
    rows = await _sb_get(
        "brain_research",
        f"id=eq.{session_id}&user_id=eq.{user.id}&select=id",
    )
    if not rows:
        raise HTTPException(404, "Session not found")

    url = f"{config.SUPABASE_URL}/rest/v1/brain_research?id=eq.{session_id}&user_id=eq.{user.id}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.delete(url, headers={**_svc_headers(), "Prefer": "return=minimal"})
        r.raise_for_status()
    return {"deleted": session_id}
