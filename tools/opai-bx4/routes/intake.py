"""Bx4 — Onboarding Q&A intake routes."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config
from core.intake import (
    FOUNDATION_QUESTIONS,
    get_next_question,
    save_answer,
    get_company_brief,
)

log = logging.getLogger("bx4.routes.intake")
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


# ── Access check ──────────────────────────────────────────────────────────────

async def _check_access(user: AuthUser, company_id: str) -> bool:
    if user.is_admin:
        return True
    rows = await _sb_get(
        "bx4_company_access",
        f"company_id=eq.{company_id}&user_id=eq.{user.id}&select=id",
    )
    return bool(rows)


# ── Request models ────────────────────────────────────────────────────────────

class AnswerRequest(BaseModel):
    question: str
    answer: str
    phase: str = "foundation"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/intake/next")
async def next_question(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Get the next unanswered onboarding question."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    q = await get_next_question(
        company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )
    if q is None:
        return {"completed": True, "question": None}
    return {"completed": False, "question": q}


@router.post("/api/companies/{company_id}/intake/answer")
async def submit_answer(
    company_id: str, body: AnswerRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Submit an answer to an onboarding question."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    await save_answer(
        company_id, body.question, body.answer, body.phase,
        config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )

    # Return next question
    q = await get_next_question(
        company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )
    if q is None:
        return {"saved": True, "completed": True, "next_question": None}
    return {"saved": True, "completed": False, "next_question": q}


@router.get("/api/companies/{company_id}/intake/status")
async def intake_status(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Get onboarding completion status."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Count answered questions
    answered = await _sb_get(
        "bx4_onboarding_log",
        f"company_id=eq.{company_id}&select=question",
    )
    answered_count = len(answered)
    total_count = len(FOUNDATION_QUESTIONS)

    return {
        "completed": answered_count >= total_count,
        "answered_count": answered_count,
        "total_count": total_count,
        "phase": "foundation",
    }


@router.get("/api/companies/{company_id}/intake/brief")
async def company_brief(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Get the compiled company brief text from all onboarding answers."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    brief = await get_company_brief(
        company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )
    return {"brief": brief}
