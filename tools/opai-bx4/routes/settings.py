"""Bx4 — Settings, goals, KPIs, competitors, and alerts routes."""

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
from core.alerts import get_active_alerts
from wings.operations import detect_anomalies

log = logging.getLogger("bx4.routes.settings")
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

async def _check_access(user: AuthUser, company_id: str) -> bool:
    if user.is_admin:
        return True
    rows = await _sb_get(
        "bx4_company_access",
        f"company_id=eq.{company_id}&user_id=eq.{user.id}&select=id",
    )
    return bool(rows)


# ── Request models ────────────────────────────────────────────────────────────

class SettingUpdate(BaseModel):
    value: str


class GoalCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    target_date: Optional[str] = None
    status: str = "active"


class GoalUpdate(BaseModel):
    title: Optional[str] = None
    status: Optional[str] = None
    progress_pct: Optional[int] = None
    description: Optional[str] = None


class KPICreate(BaseModel):
    name: str
    target_value: float
    current_value: float = 0
    unit: Optional[str] = ""
    frequency: str = "monthly"


class KPIUpdate(BaseModel):
    current_value: Optional[float] = None
    target_value: Optional[float] = None
    name: Optional[str] = None
    is_active: Optional[bool] = None


class CompetitorCreate(BaseModel):
    name: str
    website: Optional[str] = ""
    notes: Optional[str] = ""


class KPIHistoryRecord(BaseModel):
    value: float


# ── Settings endpoints ────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/settings")
async def get_settings(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Get all settings for a company + global defaults."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    company_settings = await _sb_get(
        "bx4_settings",
        f"company_id=eq.{company_id}&select=*",
    )
    global_settings = await _sb_get(
        "bx4_settings",
        "company_id=is.null&select=*",
    )

    # Merge: company settings override global
    settings_map: dict[str, dict] = {}
    for s in global_settings:
        settings_map[s["key"]] = s
    for s in company_settings:
        settings_map[s["key"]] = s

    return list(settings_map.values())


@router.put("/api/companies/{company_id}/settings/{key}")
async def update_setting(
    company_id: str, key: str, body: SettingUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update a setting value for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Check if setting exists
    existing = await _sb_get(
        "bx4_settings",
        f"company_id=eq.{company_id}&key=eq.{key}&select=id",
    )
    if existing:
        await _sb_patch(
            "bx4_settings",
            f"company_id=eq.{company_id}&key=eq.{key}",
            {"value": body.value},
        )
    else:
        await _sb_post("bx4_settings", {
            "company_id": company_id,
            "key": key,
            "value": body.value,
        }, prefer="return=minimal")

    return {"key": key, "value": body.value}


# ── Goals endpoints ───────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/goals")
async def list_goals(company_id: str, user: AuthUser = Depends(get_current_user)):
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")
    return await _sb_get(
        "bx4_company_goals",
        f"company_id=eq.{company_id}&order=created_at.desc&select=*",
    )


@router.post("/api/companies/{company_id}/goals")
async def create_goal(
    company_id: str, body: GoalCreate,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    payload = body.model_dump()
    payload["company_id"] = company_id
    result = await _sb_post("bx4_company_goals", payload)
    return result[0] if isinstance(result, list) else result


@router.patch("/api/companies/{company_id}/goals/{goal_id}")
async def update_goal(
    company_id: str, goal_id: str, body: GoalUpdate,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")

    await _sb_patch("bx4_company_goals", f"id=eq.{goal_id}&company_id=eq.{company_id}", update)

    rows = await _sb_get("bx4_company_goals", f"id=eq.{goal_id}&select=*")
    return rows[0] if rows else {}


# ── KPIs endpoints ────────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/kpis")
async def list_kpis(company_id: str, user: AuthUser = Depends(get_current_user)):
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")
    return await _sb_get(
        "bx4_kpis",
        f"company_id=eq.{company_id}&order=created_at.desc&select=*",
    )


@router.post("/api/companies/{company_id}/kpis")
async def create_kpi(
    company_id: str, body: KPICreate,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    payload = body.model_dump()
    payload["company_id"] = company_id
    payload["is_active"] = True
    result = await _sb_post("bx4_kpis", payload)
    return result[0] if isinstance(result, list) else result


@router.patch("/api/companies/{company_id}/kpis/{kpi_id}")
async def update_kpi(
    company_id: str, kpi_id: str, body: KPIUpdate,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")

    await _sb_patch("bx4_kpis", f"id=eq.{kpi_id}&company_id=eq.{company_id}", update)

    rows = await _sb_get("bx4_kpis", f"id=eq.{kpi_id}&select=*")
    return rows[0] if rows else {}


# ── KPI History + Anomaly Detection ──────────────────────────────────────────

@router.post("/api/companies/{company_id}/kpis/{kpi_id}/history")
async def record_kpi_history(
    company_id: str, kpi_id: str, body: KPIHistoryRecord,
    user: AuthUser = Depends(get_current_user),
):
    """Log a KPI value reading to bx4_kpi_history."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    # Verify KPI belongs to this company
    kpi_rows = await _sb_get("bx4_kpis", f"id=eq.{kpi_id}&company_id=eq.{company_id}&select=id")
    if not kpi_rows:
        raise HTTPException(404, "KPI not found")

    result = await _sb_post("bx4_kpi_history", {
        "kpi_id": kpi_id,
        "company_id": company_id,
        "value": body.value,
    }, prefer="return=representation")
    return result[0] if isinstance(result, list) else result


@router.post("/api/companies/{company_id}/kpis/detect-anomalies")
async def run_anomaly_detection(
    company_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Run Z-score anomaly detection on all active KPIs for the company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    result = await detect_anomalies(
        company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )
    return result


# ── Competitors endpoints ─────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/competitors")
async def list_competitors(company_id: str, user: AuthUser = Depends(get_current_user)):
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")
    return await _sb_get(
        "bx4_competitors",
        f"company_id=eq.{company_id}&order=name.asc&select=*",
    )


@router.post("/api/companies/{company_id}/competitors")
async def add_competitor(
    company_id: str, body: CompetitorCreate,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    payload = body.model_dump()
    payload["company_id"] = company_id
    result = await _sb_post("bx4_competitors", payload)
    return result[0] if isinstance(result, list) else result


@router.delete("/api/companies/{company_id}/competitors/{competitor_id}")
async def remove_competitor(
    company_id: str, competitor_id: str,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")
    await _sb_delete("bx4_competitors", f"id=eq.{competitor_id}&company_id=eq.{company_id}")
    return {"deleted": True}


# ── Alerts endpoint ───────────────────────────────────────────────────────────

@router.get("/api/companies/{company_id}/alerts")
async def list_alerts(company_id: str, user: AuthUser = Depends(get_current_user)):
    """List active (fired) alerts for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")
    return await get_active_alerts(company_id, config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)


# ── Notifications endpoints ───────────────────────────────────────────────────

_NOTIF_KEYS = ["notify_discord", "notify_email", "notify_email_address", "discord_guild_id"]


class NotificationsUpdate(BaseModel):
    notify_discord: Optional[bool] = None
    notify_email: Optional[bool] = None
    notify_email_address: Optional[str] = None
    discord_guild_id: Optional[str] = None


async def _get_setting_value(company_id: str, key: str) -> Optional[str]:
    rows = await _sb_get("bx4_settings", f"company_id=eq.{company_id}&key=eq.{key}&select=value")
    return rows[0]["value"] if rows else None


async def _upsert_setting(company_id: str, key: str, value: str) -> None:
    existing = await _sb_get("bx4_settings", f"company_id=eq.{company_id}&key=eq.{key}&select=id")
    if existing:
        await _sb_patch("bx4_settings", f"company_id=eq.{company_id}&key=eq.{key}", {"value": value})
    else:
        await _sb_post("bx4_settings", {"company_id": company_id, "key": key, "value": value}, prefer="return=minimal")


@router.get("/api/companies/{company_id}/settings/notifications")
async def get_notification_settings(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Get notification channel settings for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get("bx4_settings", f"company_id=eq.{company_id}&key=in.({','.join(_NOTIF_KEYS)})&select=key,value")
    result = {r["key"]: r["value"] for r in rows}
    return {
        "notify_discord": result.get("notify_discord", "false").lower() == "true",
        "notify_email": result.get("notify_email", "false").lower() == "true",
        "notify_email_address": result.get("notify_email_address", ""),
        "discord_guild_id": result.get("discord_guild_id", ""),
    }


@router.put("/api/companies/{company_id}/settings/notifications")
async def update_notification_settings(
    company_id: str, body: NotificationsUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update notification channel settings for a company."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    if body.notify_discord is not None:
        await _upsert_setting(company_id, "notify_discord", str(body.notify_discord).lower())
    if body.notify_email is not None:
        await _upsert_setting(company_id, "notify_email", str(body.notify_email).lower())
    if body.notify_email_address is not None:
        await _upsert_setting(company_id, "notify_email_address", body.notify_email_address)
    if body.discord_guild_id is not None:
        await _upsert_setting(company_id, "discord_guild_id", body.discord_guild_id)

    return {"saved": True}


@router.post("/api/companies/{company_id}/settings/notifications/test")
async def test_notification(company_id: str, user: AuthUser = Depends(get_current_user)):
    """Send a test notification via configured channels."""
    if not await _check_access(user, company_id):
        raise HTTPException(403, "Access denied")

    companies = await _sb_get("bx4_companies", f"id=eq.{company_id}&select=name")
    company_name = companies[0]["name"] if companies else "Your Company"

    sent = []
    errors = []

    notify_discord = (await _get_setting_value(company_id, "notify_discord") or "false").lower() == "true"
    notify_email   = (await _get_setting_value(company_id, "notify_email") or "false").lower() == "true"
    guild_id       = await _get_setting_value(company_id, "discord_guild_id") or ""
    email_addr     = await _get_setting_value(company_id, "notify_email_address") or ""

    if notify_discord and guild_id:
        try:
            async with httpx.AsyncClient(timeout=8) as c:
                await c.post(
                    f"{config.DISCORD_BRIDGE_URL}/api/send",
                    json={"guild_id": guild_id, "message": f"[Bx4] Test notification from {company_name} — notifications are working!"},
                )
            sent.append("discord")
        except Exception as exc:
            errors.append(f"discord: {exc}")

    if notify_email and email_addr:
        try:
            async with httpx.AsyncClient(timeout=8) as c:
                await c.post(
                    f"{config.EMAIL_AGENT_URL}/api/send",
                    json={"to": email_addr, "subject": f"[Bx4] Test Alert — {company_name}", "body": "This is a test notification from Bx4. Your alert notifications are configured correctly."},
                )
            sent.append("email")
        except Exception as exc:
            errors.append(f"email: {exc}")

    if not notify_discord and not notify_email:
        raise HTTPException(400, "No notification channels are enabled. Enable Discord or Email in Notifications settings first.")

    return {"sent": sent, "errors": errors}
