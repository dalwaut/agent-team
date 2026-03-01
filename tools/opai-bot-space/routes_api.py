"""OPAI Bot Space — REST API routes."""

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from auth import AuthUser, get_current_user, require_admin

import config

log = logging.getLogger("bot-space.api")
router = APIRouter()


# ── Supabase helpers ───────────────────────────────────────────────────────────

def _headers(service_key: str = None) -> dict:
    key = service_key or config.SUPABASE_SERVICE_KEY
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
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
        if prefer == "return=minimal":
            return {}
        return r.json()


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


# ── Auth Config ────────────────────────────────────────────────────────────────

@router.get("/api/auth/config")
def auth_config():
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── Catalog ────────────────────────────────────────────────────────────────────

@router.get("/api/bots")
async def list_bots(user: AuthUser = Depends(get_current_user)):
    """List all bots + user's installation status for each."""
    bots = await _sb_get(
        "bot_space_catalog",
        "is_active=eq.true&order=is_admin_only.desc,name.asc&select=*",
    )

    # Filter admin-only bots for non-admins
    if not user.is_admin:
        bots = [b for b in bots if not b.get("is_admin_only")]

    # Fetch user's installations
    installs = await _sb_get(
        "bot_space_installations",
        f"user_id=eq.{user.id}&select=agent_slug,status,id,next_run_at,last_run_at,last_run_status,cron_expr",
    )
    install_map = {i["agent_slug"]: i for i in installs}

    for bot in bots:
        bot["installation"] = install_map.get(bot["slug"])
        # Parse setup_schema if stored as string
        if isinstance(bot.get("setup_schema"), str):
            try:
                bot["setup_schema"] = json.loads(bot["setup_schema"])
            except Exception:
                bot["setup_schema"] = {}

    return bots


@router.get("/api/bots/{slug}")
async def get_bot(slug: str, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get("bot_space_catalog", f"slug=eq.{slug}&select=*")
    if not rows:
        raise HTTPException(404, "Bot not found")
    bot = rows[0]
    if bot.get("is_admin_only") and not user.is_admin:
        raise HTTPException(403, "Admin only")
    if isinstance(bot.get("setup_schema"), str):
        try:
            bot["setup_schema"] = json.loads(bot["setup_schema"])
        except Exception:
            bot["setup_schema"] = {}
    return bot


class UnlockRequest(BaseModel):
    pass


@router.post("/api/bots/{slug}/unlock")
async def unlock_bot(slug: str, user: AuthUser = Depends(get_current_user)):
    """Deduct unlock_credits from user balance, create pending_setup installation."""
    rows = await _sb_get("bot_space_catalog", f"slug=eq.{slug}&select=unlock_credits,is_admin_only,is_active")
    if not rows:
        raise HTTPException(404, "Bot not found")
    bot = rows[0]
    if not bot["is_active"]:
        raise HTTPException(400, "Bot is not active")
    if bot["is_admin_only"] and not user.is_admin:
        raise HTTPException(403, "Admin only")

    unlock_cost = bot["unlock_credits"]

    # Check existing installation
    existing = await _sb_get(
        "bot_space_installations",
        f"user_id=eq.{user.id}&agent_slug=eq.{slug}&select=id,status",
    )
    if existing:
        raise HTTPException(409, "Already unlocked")

    # Check & deduct credits
    if unlock_cost > 0:
        profile = await _sb_get("profiles", f"id=eq.{user.id}&select=agent_credits")
        if not profile:
            raise HTTPException(500, "Profile not found")
        balance = profile[0].get("agent_credits", 0)
        if balance < unlock_cost:
            raise HTTPException(402, f"Insufficient credits (have {balance}, need {unlock_cost})")

        await _sb_patch("profiles", f"id=eq.{user.id}", {"agent_credits": balance - unlock_cost})
        await _sb_post("bot_space_credit_transactions", {
            "user_id": user.id,
            "amount": -unlock_cost,
            "type": "unlock",
            "description": f"Unlock: {slug}",
            "related_agent_slug": slug,
        }, prefer="return=minimal")

    # Create installation
    inst = await _sb_post("bot_space_installations", {
        "user_id": user.id,
        "agent_slug": slug,
        "status": "pending_setup",
        "config": {},
    })

    return {"installation": inst[0] if isinstance(inst, list) else inst}


class TestRequest(BaseModel):
    config: dict = {}


@router.post("/api/bots/{slug}/test")
async def test_bot(slug: str, body: TestRequest, user: AuthUser = Depends(get_current_user)):
    """Live connectivity test — no credit charge, no persistence."""
    from tester import run_test

    try:
        result = await asyncio.wait_for(run_test(slug, body.config), timeout=15.0)
    except asyncio.TimeoutError:
        result = {
            "success": False,
            "message": "Test timed out after 15 seconds.",
            "preview": None,
        }
    return result


# ── Installations ──────────────────────────────────────────────────────────────

class InstallationCreate(BaseModel):
    agent_slug: str
    cron_expr: str
    config: dict = {}


class InstallationUpdate(BaseModel):
    cron_expr: Optional[str] = None
    config: Optional[dict] = None


@router.get("/api/installations")
async def list_installations(user: AuthUser = Depends(get_current_user)):
    return await _sb_get(
        "bot_space_installations",
        f"user_id=eq.{user.id}&select=*&order=created_at.desc",
    )


@router.post("/api/installations")
async def create_installation(body: InstallationCreate, user: AuthUser = Depends(get_current_user)):
    """Complete setup wizard — create or activate an installation."""
    from croniter import croniter

    # Validate cron
    if not croniter.is_valid(body.cron_expr):
        raise HTTPException(400, "Invalid cron expression")

    # Check installation exists (from unlock) or create new (admin bots)
    existing = await _sb_get(
        "bot_space_installations",
        f"user_id=eq.{user.id}&agent_slug=eq.{body.agent_slug}&select=id",
    )

    next_run = croniter(body.cron_expr, datetime.now(timezone.utc)).get_next(datetime)
    next_run_iso = next_run.replace(tzinfo=timezone.utc).isoformat()

    if existing:
        inst_id = existing[0]["id"]
        await _sb_patch(
            "bot_space_installations",
            f"id=eq.{inst_id}",
            {
                "status": "active",
                "cron_expr": body.cron_expr,
                "next_run_at": next_run_iso,
                "config": body.config,
            },
        )
        rows = await _sb_get("bot_space_installations", f"id=eq.{inst_id}&select=*")
        return rows[0] if rows else {}
    else:
        inst = await _sb_post("bot_space_installations", {
            "user_id": user.id,
            "agent_slug": body.agent_slug,
            "status": "active",
            "cron_expr": body.cron_expr,
            "next_run_at": next_run_iso,
            "config": body.config,
        })
        return inst[0] if isinstance(inst, list) else inst


@router.get("/api/installations/{inst_id}")
async def get_installation(inst_id: str, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get("bot_space_installations", f"id=eq.{inst_id}&user_id=eq.{user.id}&select=*")
    if not rows:
        raise HTTPException(404, "Installation not found")
    return rows[0]


@router.patch("/api/installations/{inst_id}")
async def update_installation(inst_id: str, body: InstallationUpdate, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get("bot_space_installations", f"id=eq.{inst_id}&user_id=eq.{user.id}&select=id,cron_expr")
    if not rows:
        raise HTTPException(404, "Installation not found")

    update: dict = {}
    if body.config is not None:
        update["config"] = body.config
    if body.cron_expr is not None:
        from croniter import croniter
        if not croniter.is_valid(body.cron_expr):
            raise HTTPException(400, "Invalid cron expression")
        next_run = croniter(body.cron_expr, datetime.now(timezone.utc)).get_next(datetime)
        update["cron_expr"] = body.cron_expr
        update["next_run_at"] = next_run.replace(tzinfo=timezone.utc).isoformat()

    if update:
        await _sb_patch("bot_space_installations", f"id=eq.{inst_id}&user_id=eq.{user.id}", update)

    updated = await _sb_get("bot_space_installations", f"id=eq.{inst_id}&select=*")
    return updated[0] if updated else {}


@router.post("/api/installations/{inst_id}/pause")
async def pause_installation(inst_id: str, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get("bot_space_installations", f"id=eq.{inst_id}&user_id=eq.{user.id}&select=id")
    if not rows:
        raise HTTPException(404, "Not found")
    await _sb_patch("bot_space_installations", f"id=eq.{inst_id}&user_id=eq.{user.id}", {"status": "paused"})
    return {"status": "paused"}


@router.post("/api/installations/{inst_id}/resume")
async def resume_installation(inst_id: str, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get("bot_space_installations", f"id=eq.{inst_id}&user_id=eq.{user.id}&select=id,cron_expr")
    if not rows:
        raise HTTPException(404, "Not found")
    cron_expr = rows[0].get("cron_expr", "0 * * * *")
    from croniter import croniter
    next_run = croniter(cron_expr, datetime.now(timezone.utc)).get_next(datetime)
    await _sb_patch(
        "bot_space_installations",
        f"id=eq.{inst_id}&user_id=eq.{user.id}",
        {"status": "active", "next_run_at": next_run.replace(tzinfo=timezone.utc).isoformat()},
    )
    return {"status": "active"}


@router.delete("/api/installations/{inst_id}")
async def delete_installation(inst_id: str, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get("bot_space_installations", f"id=eq.{inst_id}&user_id=eq.{user.id}&select=id")
    if not rows:
        raise HTTPException(404, "Not found")
    await _sb_delete("bot_space_installations", f"id=eq.{inst_id}&user_id=eq.{user.id}")
    return {"deleted": True}


# ── Credits ────────────────────────────────────────────────────────────────────

@router.get("/api/credits")
async def get_credits(user: AuthUser = Depends(get_current_user)):
    profile = await _sb_get("profiles", f"id=eq.{user.id}&select=agent_credits")
    balance = profile[0].get("agent_credits", 0) if profile else 0
    transactions = await _sb_get(
        "bot_space_credit_transactions",
        f"user_id=eq.{user.id}&order=created_at.desc&limit=20&select=*",
    )
    return {"balance": balance, "transactions": transactions}


class PurchaseRequest(BaseModel):
    amount: int  # credits to purchase


@router.post("/api/credits/purchase")
async def purchase_credits(body: PurchaseRequest, user: AuthUser = Depends(get_current_user)):
    """Stub — future Stripe integration."""
    raise HTTPException(501, "Credit purchase via Stripe coming soon. Contact admin to grant credits.")


class GrantRequest(BaseModel):
    user_id: str
    amount: int
    description: str = ""


@router.post("/api/admin/credits/grant")
async def grant_credits(body: GrantRequest, user: AuthUser = Depends(require_admin)):
    """Admin: grant credits to a user."""
    if body.amount <= 0:
        raise HTTPException(400, "Amount must be positive")

    profile = await _sb_get("profiles", f"id=eq.{body.user_id}&select=agent_credits")
    if not profile:
        raise HTTPException(404, "User not found")

    current = profile[0].get("agent_credits", 0)
    await _sb_patch("profiles", f"id=eq.{body.user_id}", {"agent_credits": current + body.amount})
    await _sb_post("bot_space_credit_transactions", {
        "user_id": body.user_id,
        "amount": body.amount,
        "type": "grant",
        "description": body.description or f"Admin grant: {body.amount} credits",
    }, prefer="return=minimal")

    return {"new_balance": current + body.amount}


# ── Runs ───────────────────────────────────────────────────────────────────────

@router.get("/api/runs")
async def list_runs(user: AuthUser = Depends(get_current_user)):
    return await _sb_get(
        "bot_space_runs",
        f"user_id=eq.{user.id}&order=created_at.desc&limit=50&select=*",
    )


# ── Admin ──────────────────────────────────────────────────────────────────────

@router.get("/api/admin/bots")
async def admin_list_bots(user: AuthUser = Depends(require_admin)):
    return await _sb_get("bot_space_catalog", "order=name.asc&select=*")


class BotCreate(BaseModel):
    slug: str
    name: str
    tagline: str
    description: str = ""
    icon: str = "🤖"
    category: str = "productivity"
    tags: list = []
    unlock_credits: int = 0
    run_credits: int = 1
    cron_options: list = []
    setup_schema: dict = {}
    dashboard_url: str = ""
    features: list = []
    is_admin_only: bool = False


@router.post("/api/admin/bots")
async def admin_create_bot(body: BotCreate, user: AuthUser = Depends(require_admin)):
    payload = body.model_dump()
    payload["setup_schema"] = json.dumps(payload["setup_schema"])
    result = await _sb_post("bot_space_catalog", payload)
    return result[0] if isinstance(result, list) else result


class BotUpdate(BaseModel):
    name: Optional[str] = None
    tagline: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    category: Optional[str] = None
    is_active: Optional[bool] = None
    unlock_credits: Optional[int] = None
    run_credits: Optional[int] = None


@router.patch("/api/admin/bots/{slug}")
async def admin_update_bot(slug: str, body: BotUpdate, user: AuthUser = Depends(require_admin)):
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")
    await _sb_patch("bot_space_catalog", f"slug=eq.{slug}", update)
    rows = await _sb_get("bot_space_catalog", f"slug=eq.{slug}&select=*")
    return rows[0] if rows else {}


@router.get("/api/admin/installations")
async def admin_list_installations(user: AuthUser = Depends(require_admin)):
    return await _sb_get(
        "bot_space_installations",
        "order=created_at.desc&limit=100&select=*",
    )


@router.get("/api/admin/runs")
async def admin_list_runs(user: AuthUser = Depends(require_admin)):
    return await _sb_get(
        "bot_space_runs",
        "order=created_at.desc&limit=100&select=*",
    )


# ── Scheduler Settings (heartbeat control) ─────────────────────────────────

@router.get("/api/scheduler/settings")
async def get_scheduler_settings_endpoint(user: AuthUser = Depends(require_admin)):
    from scheduler import get_scheduler_settings
    return get_scheduler_settings()


class _SchedulerSettingsBody(BaseModel):
    tick_seconds: Optional[int] = None
    paused: Optional[bool] = None


@router.put("/api/scheduler/settings")
async def update_scheduler_settings_endpoint(body: _SchedulerSettingsBody, user: AuthUser = Depends(require_admin)):
    from scheduler import set_scheduler_settings
    return set_scheduler_settings(tick_seconds=body.tick_seconds, paused=body.paused)
