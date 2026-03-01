"""Bx4 — Aggregate health, pulse latest, and portfolio routes."""

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
from core.budget_filter import compute_health_score
from wings.financial import get_snapshot

log = logging.getLogger("bx4.routes.health")
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


def _score_to_grade(score: int | float | None) -> str | None:
    if score is None:
        return None
    if score >= 90:
        return "A+"
    if score >= 80:
        return "A"
    if score >= 70:
        return "B"
    if score >= 60:
        return "C+"
    if score >= 50:
        return "C"
    if score >= 40:
        return "D"
    return "F"


# ── Aggregate Health ──────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/health")
async def get_aggregate_health(
    company_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Return overall health score + per-wing breakdown for the dashboard."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    s = snap or {}

    overall_score, overall_grade = compute_health_score(s) if s else (None, None)

    # Financial wing — derived from latest snapshot
    financial: dict = {}
    if s:
        financial = {
            "score": overall_score,
            "grade": overall_grade,
            "stats": {
                "revenue": s.get("revenue"),
                "net": s.get("net"),
                "cash_on_hand": s.get("cash_on_hand"),
                "runway_months": s.get("runway_months"),
                "burn_rate": s.get("burn_rate"),
            },
        }

    # Market wing — latest analysis record
    market_rows = await _sb_get(
        "bx4_market_analyses",
        f"company_id=eq.{company_id}&order=generated_at.desc&limit=1&select=health_score,health_grade",
    )
    market_row = market_rows[0] if market_rows else {}
    market: dict = {
        "score": market_row.get("health_score"),
        "grade": market_row.get("health_grade"),
        "stats": {},
    }

    # Social wing — average platform health score from recent snapshots
    social_snaps = await _sb_get(
        "bx4_social_snapshots",
        f"company_id=eq.{company_id}&order=captured_at.desc&limit=10&select=platform_health_score,platform",
    )
    social_score = None
    if social_snaps:
        scores = [
            sn.get("platform_health_score")
            for sn in social_snaps
            if sn.get("platform_health_score") is not None
        ]
        if scores:
            social_score = round(sum(scores) / len(scores))

    social: dict = {
        "score": social_score,
        "grade": _score_to_grade(social_score),
        "stats": {"platforms": len(social_snaps)},
    }

    return {
        "overall_score": overall_score,
        "overall_grade": overall_grade,
        "triage_mode": bool(s.get("triage_mode")),
        "financial": financial,
        "market": market,
        "social": social,
    }


# ── Pulse Latest ──────────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/pulse/latest")
async def get_pulse_latest(
    company_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Return the latest stored pulse for the dashboard widget."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        "bx4_briefings",
        f"company_id=eq.{company_id}&type=eq.pulse&order=created_at.desc&limit=1&select=*",
    )
    if not rows:
        return None
    pulse = rows[0]
    # Map content field to what dashboard expects
    return {"content": pulse.get("content", ""), "created_at": pulse.get("created_at")}


# ── Portfolio (admin only) ────────────────────────────────────────────────────

@router.get("/api/portfolio")
async def get_portfolio(user: AuthUser = Depends(get_current_user)):
    """Admin-only: all companies with health scores for portfolio view."""
    if not user.is_admin:
        raise HTTPException(403, "Admin access required")

    companies = await _sb_get("bx4_companies", "order=name.asc&select=*")

    result = []
    for co in companies:
        company_id = co.get("id")
        snap = None
        try:
            snap = await get_snapshot(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
        except Exception:
            pass

        score, grade = compute_health_score(snap) if snap else (None, None)
        triage = bool(snap.get("triage_mode")) if snap else False

        result.append({
            "id": company_id,
            "name": co.get("name"),
            "industry": co.get("industry"),
            "stage": co.get("stage"),
            "health_score": score,
            "health_grade": grade,
            "triage_mode": triage,
        })

    return {"companies": result}


# ── Scheduler Settings (heartbeat control) ─────────────────────────────────

@router.get("/api/scheduler/settings")
async def get_scheduler_settings_endpoint(user: AuthUser = Depends(get_current_user)):
    if not user.is_admin:
        raise HTTPException(403, "Admin access required")
    from core.scheduler import get_scheduler_settings
    return get_scheduler_settings()


class _SchedulerSettingsBody(BaseModel):
    tick_seconds: Optional[int] = None
    paused: Optional[bool] = None


@router.put("/api/scheduler/settings")
async def update_scheduler_settings_endpoint(body: _SchedulerSettingsBody, user: AuthUser = Depends(get_current_user)):
    if not user.is_admin:
        raise HTTPException(403, "Admin access required")
    from core.scheduler import set_scheduler_settings
    return set_scheduler_settings(tick_seconds=body.tick_seconds, paused=body.paused)
