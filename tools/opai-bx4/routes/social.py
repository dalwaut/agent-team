"""Bx4 — Social API routes."""

from __future__ import annotations

import logging
import sys
from datetime import date as date_type
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config
from wings.social import sync_ga_snapshot, get_trend, aggregate_health
from connectors.google_analytics import validate_ga_credentials

log = logging.getLogger("bx4.routes.social")
router = APIRouter()


# -- Supabase helpers ----------------------------------------------------------

def _headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{(chr(63) + params) if params else chr(0)}"
    url = url.rstrip(chr(0))
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

class SocialAccountCreate(BaseModel):
    platform: str
    handle: str
    property_id: Optional[str] = None


class SnapshotCreate(BaseModel):
    account_id: str
    date: Optional[str] = None
    followers: int
    engagement_rate: float
    posts_count: int
    impressions: Optional[int] = None
    reach: Optional[int] = None


# -- Endpoints ----------------------------------------------------------------

@router.get("/api/companies/{company_id}/social/accounts")
async def list_social_accounts(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """List social accounts for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    return await _sb_get(
        "bx4_social_accounts",
        f"company_id=eq.{company_id}&order=captured_at.desc&select=*",
    )


@router.post("/api/companies/{company_id}/social/accounts")
async def add_social_account(
    company_id: str, body: SocialAccountCreate,
    user: AuthUser = Depends(get_current_user),
):
    """Add a social account to a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    payload: dict = {
        "company_id": company_id,
        "platform": body.platform,
        "handle": body.handle,
    }
    if body.property_id:
        payload["property_id"] = body.property_id

    result = await _sb_post("bx4_social_accounts", payload)
    return result[0] if isinstance(result, list) else result


@router.delete("/api/companies/{company_id}/social/accounts/{account_id}")
async def remove_social_account(
    company_id: str, account_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Remove a social account."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    await _sb_delete(
        "bx4_social_accounts",
        f"id=eq.{account_id}&company_id=eq.{company_id}",
    )
    return {"deleted": True}


@router.get("/api/companies/{company_id}/social/snapshots/latest")
async def latest_snapshots(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Get the latest snapshot per platform (joined with accounts)."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Fetch all snapshots ordered newest first
    rows = await _sb_get(
        "bx4_social_snapshots",
        f"company_id=eq.{company_id}&order=captured_at.desc&select=*",
    )

    # Deduplicate: keep latest per account_id
    seen: dict = {}
    for row in rows:
        aid = row.get("social_account_id")
        if aid and aid not in seen:
            seen[aid] = row

    return list(seen.values())


@router.post("/api/companies/{company_id}/social/snapshots")
async def add_social_snapshot(
    company_id: str, body: SnapshotCreate,
    user: AuthUser = Depends(get_current_user),
):
    """Manually add a social snapshot."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Verify account belongs to company
    accounts = await _sb_get(
        "bx4_social_accounts",
        f"id=eq.{body.account_id}&company_id=eq.{company_id}&select=platform",
    )
    if not accounts:
        raise HTTPException(404, "Social account not found")

    platform = accounts[0].get("platform", "unknown")
    snapshot_date = body.date or str(date_type.today())

    payload: dict = {
        "company_id": company_id,
        "social_account_id": body.account_id,
        "platform": platform,
        "captured_at": snapshot_date + "T00:00:00Z",
        "followers": body.followers,
        "engagement_rate": body.engagement_rate,
        "posts_count": body.posts_count,
    }
    if body.impressions is not None:
        payload["impressions"] = body.impressions
    if body.reach is not None:
        payload["reach"] = body.reach

    result = await _sb_post("bx4_social_snapshots", payload)
    return result[0] if isinstance(result, list) else result


@router.get("/api/companies/{company_id}/social/snapshots/trend")
async def snapshot_trend(
    company_id: str,
    account_id: str = Query(...),
    days: int = Query(30),
    user: AuthUser = Depends(get_current_user),
):
    """Get historical trend data for a social account."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    try:
        trend = await get_trend(account_id, company_id, days, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
        return {"account_id": account_id, "days": days, "trend": trend}
    except Exception as exc:
        log.error("Failed to fetch trend for account %s: %s", account_id, exc)
        raise HTTPException(500, "Failed to fetch trend data")


@router.post("/api/companies/{company_id}/social/accounts/{account_id}/sync")
async def sync_social_account(
    company_id: str, account_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Trigger GA4 sync for a social account if property_id is set."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    accounts = await _sb_get(
        "bx4_social_accounts",
        f"id=eq.{account_id}&company_id=eq.{company_id}&select=*",
    )
    if not accounts:
        raise HTTPException(404, "Social account not found")

    account = accounts[0]

    if not account.get("property_id"):
        raise HTTPException(400, "No GA4 property_id set on this account. Add a property_id first.")

    if not account.get("credentials_ref"):
        raise HTTPException(400, "No credentials configured for GA4. Add service account JSON first.")

    # Validate credentials before syncing
    try:
        validation = await validate_ga_credentials(account["credentials_ref"], account["property_id"])
        if not validation.get("valid"):
            raise HTTPException(400, f"GA4 credentials invalid: {validation.get('error')}")
    except HTTPException:
        raise
    except Exception as exc:
        log.error("GA4 credential validation error: %s", exc)
        raise HTTPException(500, "Failed to validate GA4 credentials")

    try:
        result = await sync_ga_snapshot(account, company_id)
        return result
    except Exception as exc:
        log.error("GA4 sync failed for account %s: %s", account_id, exc)
        raise HTTPException(500, f"GA4 sync failed: {str(exc)}")


@router.get("/api/companies/{company_id}/social/health")
async def social_health(
    company_id: str, user: AuthUser = Depends(get_current_user),
):
    """Aggregate social health score across all connected platforms."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    try:
        health = await aggregate_health(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
        return health
    except Exception as exc:
        log.error("Failed to compute social health for company %s: %s", company_id, exc)
        raise HTTPException(500, "Failed to compute social health")
