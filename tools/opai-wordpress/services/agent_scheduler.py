"""WP Agent Scheduler — runs due agents on their configured schedule."""

import asyncio
import logging
from datetime import datetime, timezone
from urllib.parse import quote

import httpx

import config

log = logging.getLogger("opai-wordpress.agent-scheduler")

# Per-agent lock to prevent overlap
_running_agents: set[str] = set()


def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


async def agent_scheduler_loop():
    """Background loop — checks for due agents every AGENT_SCHEDULER_INTERVAL seconds."""
    log.info("Agent scheduler started (interval=%ds)", config.AGENT_SCHEDULER_INTERVAL)
    await asyncio.sleep(10)  # Startup delay

    while True:
        try:
            now_iso = quote(datetime.now(timezone.utc).isoformat())
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{_sb_url('wp_agents')}?enabled=eq.true"
                    f"&next_run_at=lte.{now_iso}"
                    f"&status=neq.running"
                    f"&select=*",
                    headers=_sb_headers(),
                )
                if resp.status_code != 200:
                    log.error("Failed to fetch due agents: %s", resp.text)
                    await asyncio.sleep(config.AGENT_SCHEDULER_INTERVAL)
                    continue
                agents = resp.json()

            if agents:
                log.info("Found %d due agent(s)", len(agents))
                tasks = [asyncio.create_task(_execute_agent(a)) for a in agents]
                await asyncio.gather(*tasks, return_exceptions=True)

        except Exception as e:
            log.error("Agent scheduler loop error: %s", e)

        await asyncio.sleep(config.AGENT_SCHEDULER_INTERVAL)


async def _execute_agent(agent: dict):
    """Execute a single due agent."""
    agent_id = agent["id"]
    site_id = agent["site_id"]
    user_id = agent["user_id"]
    template = agent["template_id"]

    if agent_id in _running_agents:
        return
    _running_agents.add(agent_id)

    try:
        # Fetch site
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*",
                headers=_sb_headers(),
            )
            if resp.status_code != 200 or not resp.json():
                log.error("Site %s not found for agent %s", site_id, agent_id)
                return
            site = resp.json()[0]

        # Mark running
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_agents')}?id=eq.{agent_id}",
                headers=_sb_headers(),
                json={"status": "running"},
            )

        # Execute by template type
        if template == "broken-link-scanner":
            from services.broken_link_scanner import run_scan
            await run_scan(site, agent, user_id)
        elif template == "performance-auditor":
            from services.performance_auditor import run_audit
            await run_audit(site, agent, user_id)
        else:
            log.warning("Unknown agent template: %s", template)

        # Compute next run
        cron = agent.get("cron_expression")
        next_run = None
        if cron:
            from services.scheduler import _compute_next_run
            next_run = _compute_next_run(cron, "America/Chicago")

        # Update agent timestamps
        update = {"status": "idle", "last_run_at": "now()"}
        if next_run:
            update["next_run_at"] = next_run

        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_agents')}?id=eq.{agent_id}",
                headers=_sb_headers(),
                json=update,
            )

        log.info("Agent %s (%s) completed for site %s", agent_id, template, site.get("name"))

    except Exception as e:
        log.error("Agent %s execution error: %s", agent_id, e, exc_info=True)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.patch(
                    f"{_sb_url('wp_agents')}?id=eq.{agent_id}",
                    headers=_sb_headers(),
                    json={"status": "failed", "last_run_at": "now()"},
                )
        except Exception:
            pass
    finally:
        _running_agents.discard(agent_id)
