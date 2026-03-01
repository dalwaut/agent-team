"""Bx4 — Market API routes."""

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
from wings.market import (
    analyze as market_analyze,
    fetch_news,
    competitor_research,
    draft_swot,
    positioning_map,
)

log = logging.getLogger("bx4.routes.market")
router = APIRouter()


# -- Supabase helpers ----------------------------------------------------------

def _headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def _sb_get(path: str, params: str = "") -> list:
    if params:
        url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    else:
        url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, payload: dict, prefer: str = "return=representation") -> dict | list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(url, headers={**_headers(), "Prefer": prefer}, json=payload)
        r.raise_for_status()
        return {} if prefer == "return=minimal" else r.json()


async def _sb_patch(path: str, filter_str: str, payload: dict) -> None:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{filter_str}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.patch(url, headers={**_headers(), "Prefer": "return=minimal"}, json=payload)
        r.raise_for_status()


async def _sb_delete(path: str, filter_str: str) -> None:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{filter_str}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.delete(url, headers={**_headers(), "Prefer": "return=minimal"})
        r.raise_for_status()


# -- Access check -------------------------------------------------------------

async def _check_access(user: AuthUser, company_id: str) -> bool:
    if user.is_admin:
        return True
    rows = await _sb_get(
        "bx4_company_access",
        f"company_id=eq.{company_id}&user_id=eq.{user.id}&select=id",
    )
    return bool(rows)


# -- Request models -----------------------------------------------------------

class CompetitorCreate(BaseModel):
    name: str
    website: Optional[str] = None
    notes: Optional[str] = None


class CompetitorUpdate(BaseModel):
    name: Optional[str] = None
    website: Optional[str] = None
    notes: Optional[str] = None


# -- Endpoints ----------------------------------------------------------------

@router.get("/api/companies/{company_id}/market/analysis/latest")
async def get_latest_market_analysis(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Get the most recent market analysis for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        "bx4_market_analyses",
        f"company_id=eq.{company_id}&order=generated_at.desc&limit=1&select=*",
    )
    if not rows:
        return {"analysis": None}
    return {"analysis": rows[0]}


@router.post("/api/companies/{company_id}/market/analyze")
async def run_market_analysis(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Run a full market analysis using the market wing."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    companies = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    if not companies:
        raise HTTPException(404, "Company not found")
    company = companies[0]

    # Get latest financial snapshot for context
    snapshots = await _sb_get(
        "bx4_financial_snapshots",
        f"company_id=eq.{company_id}&order=generated_at.desc&limit=1&select=*",
    )
    snapshot = snapshots[0] if snapshots else None

    goals = await _sb_get(
        "bx4_company_goals",
        f"company_id=eq.{company_id}&status=eq.active&order=created_at.desc&limit=1&select=title",
    )
    goal = goals[0]["title"] if goals else None

    try:
        result = await market_analyze(company, snapshot, goal)
        return result
    except Exception as exc:
        log.error("Market analysis failed for company %s: %s", company_id, exc)
        raise HTTPException(500, "Market analysis failed")


@router.get("/api/companies/{company_id}/market/competitors")
async def list_competitors(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """List competitors for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    return await _sb_get(
        "bx4_competitors",
        f"company_id=eq.{company_id}&order=name.asc&select=*",
    )


@router.post("/api/companies/{company_id}/market/competitors")
async def add_competitor(
    company_id: str, body: CompetitorCreate,
    user: AuthUser = Depends(get_current_user),
):
    """Add a competitor to a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    payload: dict = {
        "company_id": company_id,
        "name": body.name,
    }
    if body.website:
        payload["website"] = body.website
    if body.notes:
        payload["notes"] = body.notes

    result = await _sb_post("bx4_competitors", payload)
    return result[0] if isinstance(result, list) else result


@router.patch("/api/companies/{company_id}/market/competitors/{comp_id}")
async def update_competitor(
    company_id: str, comp_id: str, body: CompetitorUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update a competitor record."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")

    await _sb_patch("bx4_competitors", f"id=eq.{comp_id}&company_id=eq.{company_id}", update)
    rows = await _sb_get("bx4_competitors", f"id=eq.{comp_id}&select=*")
    return rows[0] if rows else {}


@router.delete("/api/companies/{company_id}/market/competitors/{comp_id}")
async def delete_competitor(
    company_id: str, comp_id: str, user: AuthUser = Depends(get_current_user),
):
    """Delete a competitor."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    await _sb_delete("bx4_competitors", f"id=eq.{comp_id}&company_id=eq.{company_id}")
    return {"deleted": True}


@router.post("/api/companies/{company_id}/market/competitors/{comp_id}/research")
async def research_competitor(
    company_id: str, comp_id: str, user: AuthUser = Depends(get_current_user),
):
    """Run Claude web_search research on a competitor."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    companies = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    if not companies:
        raise HTTPException(404, "Company not found")

    competitors = await _sb_get("bx4_competitors", f"id=eq.{comp_id}&company_id=eq.{company_id}&select=*")
    if not competitors:
        raise HTTPException(404, "Competitor not found")

    try:
        result = await competitor_research(companies[0], competitors[0])
        return result
    except Exception as exc:
        log.error("Competitor research failed for %s: %s", comp_id, exc)
        raise HTTPException(500, "Competitor research failed")


@router.get("/api/companies/{company_id}/market/news")
async def get_market_news(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Return cached market news for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        "bx4_market_news",
        f"company_id=eq.{company_id}&order=created_at.desc&limit=20&select=*",
    )
    return {"news": rows}


@router.post("/api/companies/{company_id}/market/news/refresh")
async def refresh_market_news(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Fetch fresh market news using Claude web_search."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    companies = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    if not companies:
        raise HTTPException(404, "Company not found")

    try:
        items = await fetch_news(companies[0])
        return {"fetched": len(items), "news": items}
    except Exception as exc:
        log.error("News refresh failed for company %s: %s", company_id, exc)
        raise HTTPException(500, "News refresh failed")


@router.get("/api/companies/{company_id}/market/swot/latest")
async def get_latest_swot(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Get the most recent SWOT analysis for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        "bx4_swot_analyses",
        f"company_id=eq.{company_id}&order=created_at.desc&limit=1&select=*",
    )
    if not rows:
        return {"swot": None}
    return {"swot": rows[0]}


@router.post("/api/companies/{company_id}/market/swot")
async def generate_swot(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Auto-draft a SWOT analysis using Claude."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    companies = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    if not companies:
        raise HTTPException(404, "Company not found")
    company = companies[0]

    competitors = await _sb_get(
        "bx4_competitors",
        f"company_id=eq.{company_id}&select=name,website,intel_summary",
    )

    snapshots = await _sb_get(
        "bx4_financial_snapshots",
        f"company_id=eq.{company_id}&order=generated_at.desc&limit=1&select=*",
    )
    snapshot = snapshots[0] if snapshots else None

    try:
        result = await draft_swot(company, competitors, snapshot)
        return result
    except Exception as exc:
        log.error("SWOT generation failed for company %s: %s", company_id, exc)
        raise HTTPException(500, "SWOT generation failed")


@router.get("/api/companies/{company_id}/market/positioning")
async def get_positioning_map(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Generate a 2x2 market positioning map for the company and its competitors."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    companies = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    if not companies:
        raise HTTPException(404, "Company not found")
    company = companies[0]

    competitors = await _sb_get(
        "bx4_competitors",
        f"company_id=eq.{company_id}&select=name,website,intel_summary",
    )

    analyses = await _sb_get(
        "bx4_market_analyses",
        f"company_id=eq.{company_id}&order=generated_at.desc&limit=1&select=content",
    )
    analysis = analyses[0] if analyses else None

    try:
        result = await positioning_map(company, competitors, analysis)
        return result
    except Exception as exc:
        log.error("Positioning map failed for company %s: %s", company_id, exc)
        raise HTTPException(500, "Positioning map generation failed")
