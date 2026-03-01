"""Bx4 — Credit usage and recommendation management routes."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user, require_admin

import config
from core.credits import get_usage_summary
from core.taskhub import create_task

log = logging.getLogger("bx4.routes.credits")
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


async def _sb_patch(path: str, filter_str: str, payload: dict) -> None:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{filter_str}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.patch(url, headers={**_headers(), "Prefer": "return=minimal"}, json=payload)
        r.raise_for_status()


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

class RecommendationStatusUpdate(BaseModel):
    status: str  # actioned, dismissed, completed


# ── Credit endpoints ──────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/credits")
async def company_credits(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Get credit usage summary for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    return await get_usage_summary(
        company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )


@router.get("/api/credits")
async def all_credits(user: AuthUser = Depends(require_admin)):
    """Admin: get all companies' credit usage this month."""
    # Fetch all active companies
    companies = await _sb_get("bx4_companies", "is_active=eq.true&select=id,name")

    results: list[dict] = []
    for company in companies:
        try:
            summary = await get_usage_summary(
                company["id"], config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
            )
            results.append({
                "company_id": company["id"],
                "company_name": company["name"],
                **summary,
            })
        except Exception as exc:
            log.warning("Failed to get credits for %s: %s", company["id"], exc)

    return results


# ── Recommendation endpoints ──────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/recommendations")
async def list_recommendations(
    company_id: str,
    status: Optional[str] = None,
    wing: Optional[str] = None,
    user: AuthUser = Depends(get_current_user),
):
    """List recommendations with optional status and wing filters."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    params = f"company_id=eq.{company_id}&order=generated_at.desc&select=*"
    if status:
        params += f"&status=eq.{status}"
    if wing:
        params += f"&wing=eq.{wing}"

    return await _sb_get("bx4_recommendations", params)


@router.patch("/api/companies/{company_id}/recommendations/{rec_id}")
async def update_recommendation_status(
    company_id: str, rec_id: str, body: RecommendationStatusUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update recommendation status (actioned, dismissed, completed)."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    valid_statuses = {"pending", "actioned", "dismissed", "completed"}
    if body.status not in valid_statuses:
        raise HTTPException(400, f"Invalid status. Must be one of: {', '.join(valid_statuses)}")

    await _sb_patch(
        "bx4_recommendations",
        f"id=eq.{rec_id}&company_id=eq.{company_id}",
        {"status": body.status},
    )

    rows = await _sb_get("bx4_recommendations", f"id=eq.{rec_id}&select=*")
    return rows[0] if rows else {}


@router.post("/api/companies/{company_id}/recommendations/{rec_id}/push-to-taskhub")
async def push_to_taskhub(
    company_id: str, rec_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Push a recommendation to Team Hub as a task."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Fetch recommendation
    recs = await _sb_get("bx4_recommendations", f"id=eq.{rec_id}&company_id=eq.{company_id}&select=*")
    if not recs:
        raise HTTPException(404, "Recommendation not found")
    rec = recs[0]

    # Fetch company name
    companies = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=name")
    company_name = companies[0]["name"] if companies else "Unknown"

    # Push to Team Hub
    result = await create_task(rec, company_name)
    if result is None:
        raise HTTPException(502, "Failed to push to Team Hub")

    # Update recommendation status
    await _sb_patch(
        "bx4_recommendations",
        f"id=eq.{rec_id}&company_id=eq.{company_id}",
        {"status": "actioned", "taskhub_id": result.get("id")},
    )

    return {"pushed": True, "task_id": result.get("id")}


# ── Billing Activation (admin only) ──────────────────────────────────────────

@router.get("/api/admin/billing/status")
async def get_billing_status(user: AuthUser = Depends(get_current_user)):
    """Return current billing_active setting (global). Admin only."""
    if not user.is_admin:
        raise HTTPException(403, "Admin access required")

    rows = await _sb_get(
        "bx4_settings",
        "company_id=is.null&key=eq.billing_active&select=value",
    )
    active = rows[0]["value"].lower() == "true" if rows else False
    return {"billing_active": active}


@router.post("/api/admin/billing/toggle")
async def toggle_billing(user: AuthUser = Depends(get_current_user)):
    """Toggle billing_active global setting. Admin only."""
    if not user.is_admin:
        raise HTTPException(403, "Admin access required")

    rows = await _sb_get(
        "bx4_settings",
        "company_id=is.null&key=eq.billing_active&select=id,value",
    )
    new_value = "false"
    if rows:
        current = rows[0].get("value", "false").lower()
        new_value = "false" if current == "true" else "true"
        await _sb_patch("bx4_settings", f"id=eq.{rows[0]['id']}", {"value": new_value})
    else:
        # Create global setting
        headers_post = {
            "apikey": config.SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }
        import httpx as _httpx
        async with _httpx.AsyncClient(timeout=10) as c:
            await c.post(
                f"{config.SUPABASE_URL}/rest/v1/bx4_settings",
                headers=headers_post,
                json={"key": "billing_active", "value": "true"},
            )
        new_value = "true"

    return {"billing_active": new_value == "true"}
