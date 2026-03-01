"""Bx4 — AI advisor chat and analysis routes."""

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
from core.advisor import chat as advisor_chat, quick_pulse as advisor_pulse
from core.budget_filter import compute_health_score, filter_and_rank, is_triage
from core.credits import log_credit_usage
from wings.financial import get_snapshot, analyze as financial_analyze
from wings.market import analyze as market_analyze
from wings.social import get_latest_snapshots, analyze as social_analyze
from wings.operations import get_goals, get_kpis, analyze as operations_analyze

log = logging.getLogger("bx4.routes.advisor")
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


async def _sb_post(path: str, payload: dict, prefer: str = "return=minimal") -> dict | list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(url, headers={**_headers(), "Prefer": prefer}, json=payload)
        r.raise_for_status()
        return {} if prefer == "return=minimal" else r.json()


# ── Access check ──────────────────────────────────────────────────────────────

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

class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/api/companies/{company_id}/advisor/chat")
async def advisor_chat_endpoint(
    company_id: str, body: ChatRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Conversational advisor chat. Logs to action log and credits."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    company = await _get_company(company_id)
    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    goal = await _get_active_goal(company_id)

    reply = await advisor_chat(
        company, snap or {}, body.message, body.history, goal,
    )

    # Log action
    await _sb_post("bx4_action_log", {
        "company_id": company_id,
        "user_id": user.id,
        "action": "advisor_chat",
        "result": "success",
    })

    # Log credit usage (non-blocking)
    await log_credit_usage(
        company_id, user.id, "advisor_chat",
        config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )

    triage = is_triage(snap) if snap else False

    return {
        "reply": reply,
        "mode": "triage" if triage else "normal",
    }


@router.post("/api/companies/{company_id}/advisor/pulse")
async def advisor_pulse_endpoint(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Quick daily pulse -- what needs attention today."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    company = await _get_company(company_id)
    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    goal = await _get_active_goal(company_id)

    pulse = await advisor_pulse(company, snap or {}, goal)

    # Store pulse in bx4_briefings so /pulse/latest can retrieve it
    try:
        co_name = company.get("name", "Company")
        await _sb_post("bx4_briefings", {
            "company_id": company_id,
            "type": "pulse",
            "title": f"{co_name} — Today's Pulse",
            "summary": pulse[:200] if pulse else "",
            "content": pulse,
        }, prefer="return=minimal")
    except Exception as _exc:
        log.warning("Failed to store pulse: %s", _exc)

    # Log action
    await _sb_post("bx4_action_log", {
        "company_id": company_id,
        "user_id": user.id,
        "action": "advisor_pulse",
        "result": "success",
    })

    return {"content": pulse, "created_at": None}


@router.post("/api/companies/{company_id}/advisor/analyze")
async def full_analysis(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Full multi-wing analysis. Runs all wings, collects recommendations, filters.

    Returns {recommendations, triage_mode, health_score}.
    """
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    company = await _get_company(company_id)
    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    goal = await _get_active_goal(company_id)

    if not snap:
        snap = {}

    # Compute health score
    if snap:
        score, grade = compute_health_score(snap)
        snap["health_score"] = score
        snap["health_grade"] = grade
    else:
        score, grade = 50, "C"

    all_recs: list[dict] = []

    # Financial wing
    try:
        fin_result = await financial_analyze(company, snap, goal)
        all_recs.extend(fin_result.get("recommendations", []))
    except Exception as exc:
        log.error("Financial wing error: %s", exc)

    # Market wing
    try:
        mkt_result = await market_analyze(company, snap, goal)
        all_recs.extend(mkt_result.get("recommendations", []))
    except Exception as exc:
        log.error("Market wing error: %s", exc)

    # Social wing
    try:
        social_data = await get_latest_snapshots(
            company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
        )
        soc_result = await social_analyze(company, social_data, snap, goal)
        all_recs.extend(soc_result.get("recommendations", []))
    except Exception as exc:
        log.error("Social wing error: %s", exc)

    # Operations wing
    try:
        goals_data = await get_goals(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
        kpis_data = await get_kpis(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
        ops_result = await operations_analyze(company, goals_data, kpis_data, snap, goal)
        all_recs.extend(ops_result.get("recommendations", []))
    except Exception as exc:
        log.error("Operations wing error: %s", exc)

    # Final ranking pass
    ranked = filter_and_rank(all_recs, snap)
    triage = is_triage(snap)

    # Log action
    await _sb_post("bx4_action_log", {
        "company_id": company_id,
        "user_id": user.id,
        "action": "full_analysis",
        "result": f"success: {len(ranked)} recommendations",
    })

    # Log credit usage
    await log_credit_usage(
        company_id, user.id, "full_analysis",
        config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )

    return {
        "recommendations": ranked,
        "triage_mode": triage,
        "health_score": score,
        "health_grade": grade,
    }
