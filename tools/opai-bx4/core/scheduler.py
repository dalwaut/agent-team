"""Bx4 — Background asyncio scheduler for automated analyses."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import httpx

import config

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from audit import log_audit

log = logging.getLogger("bx4.scheduler")

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


def _headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def _fetch_active_companies() -> list[dict]:
    """Fetch all active companies from Supabase."""
    url = (
        f"{config.SUPABASE_URL}/rest/v1/bx4_companies"
        f"?is_active=eq.true&select=id,name"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers())
        r.raise_for_status()
        return r.json()


async def _get_last_run(company_id: str, action: str) -> str | None:
    """Get the last run timestamp for a given company+action from bx4_action_log."""
    url = (
        f"{config.SUPABASE_URL}/rest/v1/bx4_action_log"
        f"?company_id=eq.{company_id}&action_type=eq.{action}"
        f"&order=created_at.desc&limit=1&select=created_at"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers())
        r.raise_for_status()
        rows = r.json()
        if rows:
            return rows[0]["created_at"]
        return None


async def _get_schedule(company_id: str) -> dict:
    """Get scheduler settings for a company from bx4_settings.

    Returns dict with keys like 'analysis_interval_hours' (default 24).
    """
    url = (
        f"{config.SUPABASE_URL}/rest/v1/bx4_settings"
        f"?company_id=eq.{company_id}&key=eq.analysis_interval_hours&select=value"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers())
        r.raise_for_status()
        rows = r.json()
        if rows:
            try:
                return {"analysis_interval_hours": int(rows[0]["value"])}
            except (ValueError, TypeError):
                pass
    return {"analysis_interval_hours": 24}


async def _is_analysis_due(company_id: str) -> bool:
    """Check if a full analysis is due for a company."""
    schedule = await _get_schedule(company_id)
    interval_hours = schedule.get("analysis_interval_hours", 24)

    last_run = await _get_last_run(company_id, "full_analysis")
    if last_run is None:
        return True

    try:
        last_dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        elapsed_hours = (now - last_dt).total_seconds() / 3600
        return elapsed_hours >= interval_hours
    except (ValueError, TypeError):
        return True


async def _log_action(company_id: str, action: str, result: str) -> None:
    """Log a scheduler action to bx4_action_log."""
    url = f"{config.SUPABASE_URL}/rest/v1/bx4_action_log"
    payload = {
        "company_id": company_id,
        "actor": "scheduler",
        "action_type": action,
        "summary": result,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(
                url,
                headers={**_headers(), "Prefer": "return=minimal"},
                json=payload,
            )
    except Exception as exc:
        log.warning("Failed to log scheduler action: %s", exc)


async def _trigger_analysis(company: dict) -> None:
    """Trigger a full analysis for a company via internal API."""
    company_id = company["id"]
    log.info("Scheduler: triggering analysis for %s (%s)", company.get("name"), company_id)

    try:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(
                f"http://127.0.0.1:{config.PORT}/api/companies/{company_id}/advisor/analyze",
                headers={
                    "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
                },
            )
            if r.status_code == 200:
                await _log_action(company_id, "full_analysis", "success")
                log.info("Scheduler: analysis completed for %s", company.get("name"))
                try:
                    log_audit(
                        tier="execution",
                        service="opai-bx4",
                        event="scheduled-analysis",
                        status="completed",
                        summary=f"Bx4 analysis completed for {company.get('name')}",
                        details={"company_id": company_id, "company_name": company.get("name")},
                    )
                except Exception:
                    pass
            else:
                await _log_action(company_id, "full_analysis", f"error:{r.status_code}")
                log.warning("Scheduler: analysis failed for %s: %d", company.get("name"), r.status_code)
                try:
                    log_audit(
                        tier="execution",
                        service="opai-bx4",
                        event="scheduled-analysis",
                        status="failed",
                        summary=f"Bx4 analysis failed for {company.get('name')} — HTTP {r.status_code}",
                        details={"company_id": company_id, "company_name": company.get("name"), "http_status": r.status_code},
                    )
                except Exception:
                    pass
    except Exception as exc:
        await _log_action(company_id, "full_analysis", f"error:{exc}")
        log.error("Scheduler: analysis error for %s: %s", company.get("name"), exc)
        try:
            log_audit(
                tier="execution",
                service="opai-bx4",
                event="scheduled-analysis",
                status="failed",
                summary=f"Bx4 analysis error for {company.get('name')}",
                details={"company_id": company_id, "company_name": company.get("name"), "error": str(exc)[:200]},
            )
        except Exception:
            pass


async def scheduler_loop() -> None:
    """Async infinite loop -- runs on each tick, checks for due analyses."""
    log.info("Scheduler started (tick=%ds)", _scheduler_tick)

    while True:
        try:
            await asyncio.sleep(_scheduler_tick)

            if _scheduler_paused:
                continue

            if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
                continue

            companies = await _fetch_active_companies()
            for company in companies:
                try:
                    if await _is_analysis_due(company["id"]):
                        await _trigger_analysis(company)
                except Exception as exc:
                    log.error("Scheduler error for company %s: %s", company.get("id"), exc)

        except asyncio.CancelledError:
            log.info("Scheduler cancelled")
            raise
        except Exception as exc:
            log.error("Scheduler loop error: %s", exc)
            await asyncio.sleep(30)  # Back off on error
