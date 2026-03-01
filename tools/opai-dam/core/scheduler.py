"""DAM Bot — Scheduler.

Periodically checks for stalled sessions and timed-out approvals.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from core.supabase import sb_get, sb_patch
from core.realtime import broadcast_realtime

import config

log = logging.getLogger("dam.scheduler")

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


async def scheduler_loop():
    """Main scheduler tick — runs every SCHEDULER_TICK seconds."""
    log.info("Scheduler started (tick=%ds)", _scheduler_tick)
    while True:
        try:
            if not _scheduler_paused:
                await _check_stalled_sessions()
                await _check_expired_approvals()
        except Exception as exc:
            log.error("Scheduler tick error: %s", exc)
        await asyncio.sleep(_scheduler_tick)


async def _check_stalled_sessions():
    """Find sessions stuck in 'executing' for too long (>30 min)."""
    cutoff = quote((datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat())
    try:
        stalled = await sb_get(
            f"dam_sessions?status=eq.executing&updated_at=lt.{cutoff}&select=id,title"
        )
        for session in stalled:
            log.warning("Session %s appears stalled: %s", session["id"], session.get("title"))
            await sb_patch(f"dam_sessions?id=eq.{session['id']}", {"status": "failed"})
            await broadcast_realtime(session["id"], {
                "type": "session_stalled",
                "message": "Session timed out after 30 minutes",
            })
    except Exception as exc:
        log.error("Stall check failed: %s", exc)


async def _check_expired_approvals():
    """Auto-reject approvals that have been pending for >24h."""
    cutoff = quote((datetime.now(timezone.utc) - timedelta(hours=24)).isoformat())
    try:
        expired = await sb_get(
            f"dam_approvals?status=eq.pending&created_at=lt.{cutoff}&select=id,session_id"
        )
        for approval in expired:
            await sb_patch(f"dam_approvals?id=eq.{approval['id']}", {
                "status": "expired",
                "decided_at": datetime.now(timezone.utc).isoformat(),
            })
            if approval.get("session_id"):
                await broadcast_realtime(approval["session_id"], {
                    "type": "approval_expired",
                    "approval_id": approval["id"],
                })
    except Exception as exc:
        log.error("Approval expiry check failed: %s", exc)
