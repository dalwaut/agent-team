"""Bx4 — Operations routes: goal decomposition."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config
from wings.operations import decompose_goal
from wings.financial import get_snapshot

log = logging.getLogger("bx4.routes.operations")
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


# ── Goal Decomposition ────────────────────────────────────────────────────────

@router.post("/api/companies/{company_id}/goals/{goal_id}/decompose")
async def decompose_goal_endpoint(
    company_id: str,
    goal_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Decompose a goal into milestones using AI, push each to Team Hub."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Fetch the goal
    goal_rows = await _sb_get(
        "bx4_company_goals",
        f"id=eq.{goal_id}&company_id=eq.{company_id}&select=*",
    )
    if not goal_rows:
        raise HTTPException(404, "Goal not found")
    goal = goal_rows[0]

    company = await _get_company(company_id)
    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)

    result = await decompose_goal(
        goal=goal,
        company=company,
        snapshot=snap or {},
        supabase_url=config.SUPABASE_URL,
        service_key=config.SUPABASE_SERVICE_KEY,
    )
    return result


@router.get("/api/companies/{company_id}/goals/{goal_id}/milestones")
async def list_milestones(
    company_id: str,
    goal_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Return milestones (sub-goals) for a given parent goal."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        "bx4_company_goals",
        f"company_id=eq.{company_id}&parent_goal_id=eq.{goal_id}&order=order_index.asc&select=*",
    )
    return {"milestones": rows}
