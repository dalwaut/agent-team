"""Bx4 — Briefings routes."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config
from wings.briefings import (
    generate_briefing,
    store_briefing,
    dispatch_discord,
    dispatch_email,
    mark_dispatched,
)
from wings.financial import get_snapshot

log = logging.getLogger("bx4.routes.briefings")
router = APIRouter()


# ── Supabase helpers ──────────────────────────────────────────────────────────

def _headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers())
        r.raise_for_status()
        return r.json()


async def _check_access(user: AuthUser, company_id: str) -> bool:
    if user.is_admin:
        return True
    rows = await _sb_get(
        "bx4_company_access",
        f"company_id=eq.{company_id}&user_id=eq.{user.id}&select=id",
    )
    return bool(rows)


async def _get_company(company_id: str) -> dict:
    rows = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    if not rows:
        raise HTTPException(404, "Company not found")
    return rows[0]


async def _get_active_goal(company_id: str) -> str | None:
    goals = await _sb_get(
        "bx4_company_goals",
        f"company_id=eq.{company_id}&status=eq.active&order=created_at.desc&limit=1&select=title",
    )
    return goals[0]["title"] if goals else None


# ── Request models ────────────────────────────────────────────────────────────

class BriefingGenerateRequest(BaseModel):
    type: str = "daily"  # daily | weekly


class BriefingDispatchRequest(BaseModel):
    channel: str  # discord | email
    to_email: Optional[str] = None
    guild_id: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/briefings")
async def list_briefings(
    company_id: str,
    limit: int = 20,
    user: AuthUser = Depends(get_current_user),
):
    """List briefings for a company (excludes pulse-type entries)."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        "bx4_briefings",
        f"company_id=eq.{company_id}&type=neq.pulse&order=created_at.desc&limit={limit}&select=*",
    )
    return {"briefings": rows}


@router.post("/api/companies/{company_id}/briefings/generate")
async def generate_briefing_endpoint(
    company_id: str,
    body: BriefingGenerateRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Generate a new daily or weekly briefing and store it."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    if body.type not in ("daily", "weekly"):
        raise HTTPException(400, "type must be 'daily' or 'weekly'")

    company = await _get_company(company_id)
    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    goal = await _get_active_goal(company_id)

    # Fetch recent pending recommendations for context
    recs = await _sb_get(
        "bx4_recommendations",
        f"company_id=eq.{company_id}&status=eq.pending&order=created_at.desc&limit=10&select=*",
    )

    result = await generate_briefing(company, snap or {}, body.type, goal, recs)
    stored = await store_briefing(
        company_id, body.type,
        result["title"], result["summary"], result["content"],
    )
    return stored


@router.post("/api/companies/{company_id}/briefings/{briefing_id}/dispatch")
async def dispatch_briefing_endpoint(
    company_id: str,
    briefing_id: str,
    body: BriefingDispatchRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Dispatch a briefing to Discord or via email."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        "bx4_briefings",
        f"id=eq.{briefing_id}&company_id=eq.{company_id}&select=*",
    )
    if not rows:
        raise HTTPException(404, "Briefing not found")

    briefing = rows[0]
    company = await _get_company(company_id)
    co_name = company.get("name", "Your Company")

    if body.channel == "discord":
        ok = await dispatch_discord(briefing, co_name, body.guild_id)
        if ok:
            await mark_dispatched(briefing_id, "discord")
        return {"dispatched": ok, "channel": "discord"}

    if body.channel == "email":
        if not body.to_email:
            raise HTTPException(400, "to_email required for email dispatch")
        ok = await dispatch_email(briefing, body.to_email, co_name)
        if ok:
            await mark_dispatched(briefing_id, "email")
        return {"dispatched": ok, "channel": "email"}

    raise HTTPException(400, "channel must be 'discord' or 'email'")
