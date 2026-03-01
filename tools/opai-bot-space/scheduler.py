"""OPAI Bot Space — Background cron dispatcher.

Runs a 60-second tick loop. On each tick:
- Queries installations WHERE status='active' AND next_run_at <= now()
- For each due installation, checks user credit balance
- Dispatches the agent's HTTP endpoint or skips if insufficient credits
- Updates installation, run record, and credit ledger in Supabase
"""

import asyncio
import logging
import os
from datetime import datetime, timezone

import httpx
from croniter import croniter

import config
from audit import log_audit

log = logging.getLogger("bot-space.scheduler")

# ── Runtime scheduler state ──────────────────────────────────

_scheduler_tick: int = config.SCHEDULER_TICK
_scheduler_paused: bool = False


def get_scheduler_settings() -> dict:
    return {"tick_seconds": _scheduler_tick, "paused": _scheduler_paused}


def set_scheduler_settings(*, tick_seconds: int | None = None, paused: bool | None = None) -> dict:
    global _scheduler_tick, _scheduler_paused
    if tick_seconds is not None:
        _scheduler_tick = max(10, min(3600, tick_seconds))
    if paused is not None:
        _scheduler_paused = paused
    return get_scheduler_settings()


def _sb_headers(service_key: str) -> dict:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


async def scheduler_loop():
    """Main scheduler coroutine — started in app lifespan."""
    log.info("[SCHEDULER] Starting — tick every %ds", _scheduler_tick)
    while True:
        try:
            if not _scheduler_paused:
                await _tick()
        except asyncio.CancelledError:
            log.info("[SCHEDULER] Cancelled — shutting down")
            return
        except Exception as exc:
            log.error("[SCHEDULER] Tick error: %s", exc, exc_info=True)
        await asyncio.sleep(_scheduler_tick)


async def _tick():
    """Single scheduler tick — process all due installations."""
    sb_url = config.SUPABASE_URL
    svc_key = config.SUPABASE_SERVICE_KEY
    if not sb_url or not svc_key:
        return

    headers = _sb_headers(svc_key)
    now_iso = datetime.now(timezone.utc).isoformat()

    from urllib.parse import quote

    async with httpx.AsyncClient(timeout=30) as client:
        # Fetch due installations (URL-encode timestamp so + isn't treated as space)
        resp = await client.get(
            f"{sb_url}/rest/v1/bot_space_installations"
            f"?status=eq.active&next_run_at=lte.{quote(now_iso, safe='')}"
            f"&select=id,user_id,agent_slug,cron_expr,credits_spent_total,config",
            headers=headers,
        )
        if resp.status_code != 200:
            log.warning("[SCHEDULER] Failed to fetch due installations: %s", resp.text[:200])
            return

        installations = resp.json()
        if not installations:
            return

        log.info("[SCHEDULER] %d due installation(s)", len(installations))

        for inst in installations:
            try:
                await _process_installation(client, headers, sb_url, inst)
            except Exception as exc:
                log.error("[SCHEDULER] Error processing installation %s: %s", inst.get("id"), exc)


async def _process_installation(
    client: httpx.AsyncClient,
    headers: dict,
    sb_url: str,
    inst: dict,
):
    inst_id = inst["id"]
    user_id = inst["user_id"]
    agent_slug = inst["agent_slug"]
    cron_expr = inst.get("cron_expr", "0 * * * *")

    log.info("[SCHEDULER] Processing %s for user %s (inst %s)", agent_slug, user_id[:8], inst_id[:8])

    # Fetch catalog entry for run_credits
    cat_resp = await client.get(
        f"{sb_url}/rest/v1/bot_space_catalog?slug=eq.{agent_slug}&select=run_credits",
        headers=headers,
    )
    run_credits = 0
    if cat_resp.status_code == 200:
        rows = cat_resp.json()
        if rows:
            run_credits = rows[0].get("run_credits", 0)

    # Fetch user credit balance
    profile_resp = await client.get(
        f"{sb_url}/rest/v1/profiles?id=eq.{user_id}&select=agent_credits",
        headers=headers,
    )
    user_credits = 0
    if profile_resp.status_code == 200:
        rows = profile_resp.json()
        if rows:
            user_credits = rows[0].get("agent_credits", 0)

    # Create run record
    run_payload = {
        "installation_id": inst_id,
        "user_id": user_id,
        "agent_slug": agent_slug,
        "credits_charged": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    if run_credits > 0 and user_credits < run_credits:
        # Insufficient credits — log and skip, do NOT advance next_run_at
        run_payload["status"] = "skipped_credits"
        run_payload["result_summary"] = (
            f"Skipped: insufficient credits (balance={user_credits}, required={run_credits})"
        )
        await client.post(
            f"{sb_url}/rest/v1/bot_space_runs",
            headers={**headers, "Prefer": "return=minimal"},
            json=run_payload,
        )
        log.info("[SCHEDULER] Skipped %s — not enough credits (%d/%d)", agent_slug, user_credits, run_credits)
        return

    # Mark as running
    run_payload["status"] = "running"
    run_resp = await client.post(
        f"{sb_url}/rest/v1/bot_space_runs",
        headers={**headers, "Prefer": "return=representation"},
        json=run_payload,
    )
    run_id = None
    if run_resp.status_code in (200, 201):
        rows = run_resp.json()
        if rows:
            run_id = rows[0].get("id")

    # Compute next_run_at
    cron = croniter(cron_expr, datetime.now(timezone.utc))
    next_run = cron.get_next(datetime).replace(tzinfo=timezone.utc).isoformat()

    # Update installation: next_run_at and last_run_at
    await client.patch(
        f"{sb_url}/rest/v1/bot_space_installations?id=eq.{inst_id}",
        headers={**headers, "Prefer": "return=minimal"},
        json={
            "next_run_at": next_run,
            "last_run_at": datetime.now(timezone.utc).isoformat(),
            "last_run_status": "running",
        },
    )

    # Dispatch the agent
    result_summary, error_message, final_status = await _dispatch(agent_slug, inst.get("config", {}))

    completed_at = datetime.now(timezone.utc).isoformat()

    # Deduct credits if run succeeded or failed (charge regardless — agent ran)
    if run_credits > 0:
        await client.patch(
            f"{sb_url}/rest/v1/profiles?id=eq.{user_id}",
            headers={**headers, "Prefer": "return=minimal"},
            json={"agent_credits": user_credits - run_credits},
        )
        await client.post(
            f"{sb_url}/rest/v1/bot_space_credit_transactions",
            headers={**headers, "Prefer": "return=minimal"},
            json={
                "user_id": user_id,
                "amount": -run_credits,
                "type": "run",
                "description": f"Run: {agent_slug}",
                "related_agent_slug": agent_slug,
                "related_run_id": run_id,
            },
        )
        # Update installation credits_spent_total
        await client.patch(
            f"{sb_url}/rest/v1/bot_space_installations?id=eq.{inst_id}",
            headers={**headers, "Prefer": "return=minimal"},
            json={
                "credits_spent_total": inst.get("credits_spent_total", 0) + run_credits,
                "last_run_status": final_status,
            },
        )
    else:
        await client.patch(
            f"{sb_url}/rest/v1/bot_space_installations?id=eq.{inst_id}",
            headers={**headers, "Prefer": "return=minimal"},
            json={"last_run_status": final_status},
        )

    # Update run record
    if run_id:
        await client.patch(
            f"{sb_url}/rest/v1/bot_space_runs?id=eq.{run_id}",
            headers={**headers, "Prefer": "return=minimal"},
            json={
                "status": final_status,
                "credits_charged": run_credits if run_credits > 0 else 0,
                "completed_at": completed_at,
                "result_summary": result_summary,
                "error_message": error_message,
            },
        )

    log.info("[SCHEDULER] Completed %s — %s", agent_slug, final_status)

    try:
        log_audit(
            tier="execution",
            service="opai-bot-space",
            event="bot-run",
            status=final_status,
            summary=f"Bot {agent_slug} run for user {user_id[:8]} — {final_status}",
            details={"agent_slug": agent_slug, "user_id": user_id, "credits_charged": run_credits if run_credits > 0 else 0},
        )
    except Exception:
        pass


async def _dispatch(slug: str, inst_config: dict) -> tuple[str, str, str]:
    """
    Dispatch a bot run. Returns (result_summary, error_message, status).
    status is one of: 'completed', 'failed'
    """
    from bot_registry import DISPATCH_MAP

    dispatch = DISPATCH_MAP.get(slug)
    if not dispatch:
        return "No dispatch handler configured for this bot.", "", "completed"

    method, url = dispatch
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            if method == "POST":
                resp = await client.post(url)
            else:
                resp = await client.get(url)

            if resp.status_code < 400:
                return f"Dispatched to {url} — HTTP {resp.status_code}", "", "completed"
            else:
                return "", f"HTTP {resp.status_code}: {resp.text[:300]}", "failed"

    except httpx.ConnectError:
        return "", f"Could not connect to {url} — service may be down", "failed"
    except Exception as exc:
        return "", str(exc)[:300], "failed"
