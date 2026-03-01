"""Bx4 — Company management API routes."""

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
from core.alerts import get_active_alerts
from core.budget_filter import compute_health_score

log = logging.getLogger("bx4.routes.companies")
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


# ── Access check ──────────────────────────────────────────────────────────────

async def _check_access(user: AuthUser, company_id: str, min_role: str = "viewer") -> dict | None:
    """Check if user has access to a company. Returns access record or None.

    Admins always have access. min_role: viewer, editor, owner.
    """
    if user.is_admin:
        return {"role": "admin", "company_id": company_id, "user_id": user.id}

    rows = await _sb_get(
        "bx4_company_access",
        f"company_id=eq.{company_id}&user_id=eq.{user.id}&select=*",
    )
    if not rows:
        return None

    access = rows[0]
    role = access.get("role", "viewer")

    role_hierarchy = {"viewer": 0, "editor": 1, "owner": 2, "admin": 3}
    if role_hierarchy.get(role, 0) < role_hierarchy.get(min_role, 0):
        return None

    return access


# ── Request models ────────────────────────────────────────────────────────────

class CompanyCreate(BaseModel):
    name: str
    industry: Optional[str] = None
    stage: Optional[str] = None
    headcount: Optional[int] = None
    revenue_model: Optional[str] = None
    geo_market: Optional[str] = None


class CompanyUpdate(BaseModel):
    name: Optional[str] = None
    industry: Optional[str] = None
    stage: Optional[str] = None
    headcount: Optional[int] = None
    revenue_model: Optional[str] = None
    geo_market: Optional[str] = None


class AccessGrant(BaseModel):
    user_id: str
    role: str = "editor"  # viewer, editor, owner


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/companies")
async def list_companies(user: AuthUser = Depends(get_current_user)):
    """List companies the user has access to."""
    if user.is_admin:
        return await _sb_get("bx4_companies", "is_active=eq.true&order=name.asc&select=*")

    # Join through access table
    access_rows = await _sb_get(
        "bx4_company_access",
        f"user_id=eq.{user.id}&select=company_id",
    )
    if not access_rows:
        return []

    company_ids = [r["company_id"] for r in access_rows]
    # Supabase IN filter
    ids_filter = ",".join(company_ids)
    return await _sb_get(
        "bx4_companies",
        f"id=in.({ids_filter})&is_active=eq.true&order=name.asc&select=*",
    )


@router.post("/api/companies")
async def create_company(body: CompanyCreate, user: AuthUser = Depends(require_admin)):
    """Create a new company (admin only). Auto-creates owner access for admin."""
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    payload["is_active"] = True

    result = await _sb_post("bx4_companies", payload)
    company = result[0] if isinstance(result, list) else result
    company_id = company.get("id")

    # Auto-create owner access for the creating admin
    if company_id:
        await _sb_post("bx4_company_access", {
            "company_id": company_id,
            "user_id": user.id,
            "role": "owner",
        }, prefer="return=minimal")

    return company


@router.get("/api/companies/{company_id}")
async def get_company(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Get company profile with latest snapshot, active goal, and active alerts."""
    access = await _check_access(user, company_id)
    if not access:
        raise HTTPException(403, "Access denied")

    rows = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    if not rows:
        raise HTTPException(404, "Company not found")
    company = rows[0]

    # Latest snapshot
    snapshots = await _sb_get(
        "bx4_financial_snapshots",
        f"company_id=eq.{company_id}&order=generated_at.desc&limit=1&select=*",
    )
    snapshot = snapshots[0] if snapshots else None

    # Compute health score if snapshot exists
    if snapshot and (snapshot.get("health_score") is None):
        score, grade = compute_health_score(snapshot)
        snapshot["health_score"] = score
        snapshot["health_grade"] = grade

    # Active goal
    goals = await _sb_get(
        "bx4_company_goals",
        f"company_id=eq.{company_id}&status=eq.active&order=created_at.desc&limit=1&select=*",
    )
    active_goal = goals[0] if goals else None

    # Active alerts
    alerts = await get_active_alerts(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)

    company["snapshot"] = snapshot
    company["active_goal"] = active_goal
    company["active_alerts"] = alerts

    return company


@router.patch("/api/companies/{company_id}")
async def update_company(
    company_id: str, body: CompanyUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update company profile. Requires editor+ access."""
    access = await _check_access(user, company_id, min_role="editor")
    if not access:
        raise HTTPException(403, "Access denied")

    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")

    await _sb_patch("bx4_companies", f"id=eq.{company_id}", update)

    rows = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=*")
    return rows[0] if rows else {}


@router.delete("/api/companies/{company_id}")
async def delete_company(company_id: str, user: AuthUser = Depends(require_admin)):
    """Soft delete company (set is_active=false). Admin only."""
    await _sb_patch("bx4_companies", f"id=eq.{company_id}", {"is_active": False})
    return {"deleted": True}


# ── Access management ─────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/access")
async def list_access(company_id: str, user: AuthUser = Depends(get_current_user)):
    """List access records for a company."""
    access = await _check_access(user, company_id)
    if not access:
        raise HTTPException(403, "Access denied")

    return await _sb_get(
        "bx4_company_access",
        f"company_id=eq.{company_id}&select=*",
    )


@router.post("/api/companies/{company_id}/access")
async def grant_access(
    company_id: str, body: AccessGrant,
    user: AuthUser = Depends(get_current_user),
):
    """Grant access to a user. Requires owner+ or admin."""
    access = await _check_access(user, company_id, min_role="owner")
    if not access:
        raise HTTPException(403, "Owner or admin access required")

    if body.role not in ("viewer", "editor", "owner"):
        raise HTTPException(400, "Invalid role. Must be viewer, editor, or owner.")

    # Check if access already exists
    existing = await _sb_get(
        "bx4_company_access",
        f"company_id=eq.{company_id}&user_id=eq.{body.user_id}&select=id",
    )
    if existing:
        # Update existing access
        await _sb_patch(
            "bx4_company_access",
            f"company_id=eq.{company_id}&user_id=eq.{body.user_id}",
            {"role": body.role},
        )
        return {"updated": True, "role": body.role}

    result = await _sb_post("bx4_company_access", {
        "company_id": company_id,
        "user_id": body.user_id,
        "role": body.role,
    })
    return result[0] if isinstance(result, list) else result


@router.delete("/api/companies/{company_id}/access/{target_user_id}")
async def revoke_access(
    company_id: str, target_user_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Revoke a user's access to a company. Requires owner+ or admin."""
    access = await _check_access(user, company_id, min_role="owner")
    if not access:
        raise HTTPException(403, "Owner or admin access required")

    await _sb_delete(
        "bx4_company_access",
        f"company_id=eq.{company_id}&user_id=eq.{target_user_id}",
    )
    return {"revoked": True}
