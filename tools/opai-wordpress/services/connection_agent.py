"""Background connection retry agent.

Detects sites with failed/missing connections, cycles through strategies,
logs attempts to wp_connection_log, and reports to HITL after every 5 failures.
Runs alongside background_checker and scheduler_loop.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

import config

log = logging.getLogger("opai-wordpress.connection-agent")

OPAI_ROOT = Path(__file__).parent.parent.parent.parent  # /workspace/synced/opai
FEEDBACK_FILE = OPAI_ROOT / "notes" / "Improvements" / "Feedback-WordPress.md"
IMPROVEMENTS_LOG = OPAI_ROOT / "notes" / "Improvements" / "FEEDBACK-IMPROVEMENTS-LOG.md"


def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


async def _get_capabilities(site_id: str) -> dict:
    """Read current capabilities for a site."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=capabilities",
            headers=_sb_headers(),
        )
        if resp.status_code == 200:
            rows = resp.json()
            if rows:
                return rows[0].get("capabilities") or {}
    return {}


async def _update_capabilities(site_id: str, caps: dict):
    """Merge new capabilities into the site's capabilities JSONB."""
    current = await _get_capabilities(site_id)
    current.update(caps)
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}",
            headers=_sb_headers(),
            json={"capabilities": current},
        )


async def _get_sites_needing_attention() -> list[dict]:
    """Query wp_sites for sites that need connection retry."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{_sb_url('wp_sites')}?select=*",
            headers=_sb_headers(),
        )
        if resp.status_code != 200:
            log.error("Failed to fetch sites: %s", resp.text)
            return []

        sites = resp.json()

    candidates = []
    now = time.time()

    for site in sites:
        caps = site.get("capabilities") or {}
        status = site.get("status", "")

        # Active retry cycle
        if caps.get("retry_active"):
            candidates.append(site)
            continue

        # Offline sites
        if status in ("offline", "degraded"):
            candidates.append(site)
            continue

        # Connector not installed but we have credentials to try
        if not site.get("connector_installed"):
            has_creds = site.get("admin_password") or caps.get("has_file_manager")
            if has_creds:
                candidates.append(site)
                continue

        # Suspiciously stale — last_check > 2 hours, 0 updates
        last_check = site.get("last_check")
        if last_check:
            try:
                from datetime import datetime as dt
                check_time = dt.fromisoformat(last_check.replace("Z", "+00:00"))
                age_seconds = now - check_time.timestamp()
                if (age_seconds > 7200
                        and site.get("plugins_updates", 0) == 0
                        and site.get("themes_updates", 0) == 0
                        and not site.get("core_update")):
                    candidates.append(site)
                    continue
            except (ValueError, TypeError):
                pass

    return candidates


async def _log_attempt(
    site_id: str,
    attempt_num: int,
    strategy: str,
    success: bool,
    error: str | None,
    response_code: int | None,
    duration_ms: int,
):
    """Write an attempt record to wp_connection_log."""
    row = {
        "site_id": site_id,
        "attempt_number": attempt_num,
        "strategy": strategy,
        "success": success,
        "error_detail": error,
        "response_code": response_code,
        "duration_ms": duration_ms,
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _sb_url("wp_connection_log"),
            headers=_sb_headers(),
            json=row,
        )
        if resp.status_code not in (200, 201):
            log.warning("Failed to log connection attempt: %s", resp.text[:200])


async def _try_deploy_strategy(site: dict, strategy_name: str) -> tuple[bool, str | None, int | None]:
    """Try a single deploy strategy. Returns (success, error, status_code)."""
    from services.deployer import deploy_connector
    try:
        result = await deploy_connector(site)
        if result.success:
            return True, None, None
        return False, result.message, None
    except Exception as e:
        return False, str(e), None


async def _try_data_strategy(site: dict, strategy_name: str) -> tuple[bool, str | None, int | None]:
    """Try a single data strategy. Returns (success, error, status_code)."""
    from services.update_checker import check_site_updates
    try:
        updates = await check_site_updates(site)
        method = updates.get("_data_method")
        if method:
            return True, None, None
        return False, "All data strategies failed", None
    except Exception as e:
        return False, str(e), None


def _report_to_hitl(site: dict, retry_count: int, strategies_tried: list[str]):
    """Write a HITL feedback entry after every 5 failures."""
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    site_name = site.get("name", "Unknown")
    site_id = site.get("id", "?")
    caps = site.get("capabilities") or {}
    slug = site_name.lower().replace(" ", "_").replace("-", "_")
    entry_id = f"conn_retry_{slug}_{int(time.time())}"

    strategies_str = ", ".join(strategies_tried) if strategies_tried else "none"
    last_error = caps.get("last_failure_log", "unknown")

    entry = (
        f"\n## HIGH\n"
        f'- **[connectivity]** Site "{site_name}" — {retry_count} connection attempts failed.\n'
        f"  Strategies tried: {strategies_str}.\n"
        f'  Last error: "{last_error}".\n'
        f"  Site ID: {site_id}\n"
        f"  _({entry_id}, {now_str})_\n"
    )

    # Write to Feedback-WordPress.md
    try:
        FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(FEEDBACK_FILE, "a") as f:
            f.write(entry)
        log.info("HITL report written for %s (attempt %d)", site_name, retry_count)
    except Exception as e:
        log.error("Failed to write HITL report: %s", e)

    # Append to improvements log
    try:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        log_line = (
            f"| {date_str} | {entry_id} | wordpress | HIGH | connectivity "
            f"| Filed — {retry_count} attempts failed for {site_name} |\n"
        )
        with open(IMPROVEMENTS_LOG, "a") as f:
            f.write(log_line)
    except Exception as e:
        log.error("Failed to append to improvements log: %s", e)


def _report_resolution(site: dict, method: str):
    """Write a resolution entry when a fix is found after failures."""
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    site_name = site.get("name", "Unknown")
    slug = site_name.lower().replace(" ", "_").replace("-", "_")
    entry_id = f"conn_resolved_{slug}_{int(time.time())}"

    entry = (
        f"\n## RESOLVED\n"
        f'- **[connectivity]** Site "{site_name}" — connection restored via `{method}`.\n'
        f"  _({entry_id}, {now_str})_\n"
    )

    try:
        with open(FEEDBACK_FILE, "a") as f:
            f.write(entry)
        log.info("Resolution report written for %s via %s", site_name, method)
    except Exception as e:
        log.error("Failed to write resolution report: %s", e)


async def _broadcast_resolution(site_name: str, method: str):
    """Broadcast system_update via Supabase Realtime."""
    try:
        url = f"{config.SUPABASE_URL}/realtime/v1/api/broadcast"
        payload = {
            "messages": [{
                "topic": "realtime:system_updates",
                "event": "broadcast",
                "payload": {
                    "type": "system_update",
                    "tool": "wordpress",
                    "message": f"Connection restored for {site_name} via {method}",
                },
            }]
        }
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                url,
                headers={"apikey": config.SUPABASE_ANON_KEY, "Content-Type": "application/json"},
                json=payload,
            )
    except Exception as e:
        log.warning("Failed to broadcast resolution: %s", e)


async def _run_retry_cycle(site: dict):
    """Run one retry attempt for a site — tries one strategy per cycle."""
    site_id = site["id"]
    site_name = site.get("name", "Unknown")
    caps = await _get_capabilities(site_id)

    retry_count = caps.get("retry_count", 0)
    strategies_tried = caps.get("strategies_tried", [])
    had_previous_failures = retry_count > 0

    # Define the full strategy chain
    all_strategies = [
        ("deploy:rest_api", _try_deploy_strategy),
        ("deploy:admin_upload", _try_deploy_strategy),
        ("deploy:file_manager", _try_deploy_strategy),
        ("data:connector_refresh", _try_data_strategy),
        ("data:connector_cached", _try_data_strategy),
        ("data:rest_api", _try_data_strategy),
    ]

    # Pick next strategy to try (round-robin through the chain)
    strategy_index = retry_count % len(all_strategies)
    strategy_name, strategy_fn = all_strategies[strategy_index]

    log.info("Retry cycle for %s: attempt %d, strategy %s",
             site_name, retry_count + 1, strategy_name)

    start_ms = int(time.time() * 1000)
    success, error, status_code = await strategy_fn(site, strategy_name)
    duration_ms = int(time.time() * 1000) - start_ms

    # Log attempt to Supabase
    await _log_attempt(
        site_id, retry_count + 1, strategy_name,
        success, error, status_code, duration_ms,
    )

    if success:
        log.info("Connection restored for %s via %s", site_name, strategy_name)

        # Clear retry state, pin method
        await _update_capabilities(site_id, {
            "retry_active": False,
            "retry_count": 0,
            "retry_started": None,
            "last_retry": None,
            "last_hitl_at_count": None,
            "strategies_tried": None,
        })

        # Report resolution if there were prior failures
        if had_previous_failures:
            _report_resolution(site, strategy_name)
            await _broadcast_resolution(site_name, strategy_name)

        return

    # Failure — update retry state
    retry_count += 1
    if strategy_name not in strategies_tried:
        strategies_tried.append(strategy_name)

    now_str = datetime.now(timezone.utc).isoformat()
    update = {
        "retry_active": True,
        "retry_count": retry_count,
        "last_retry": now_str,
        "strategies_tried": strategies_tried,
    }
    if not caps.get("retry_started"):
        update["retry_started"] = now_str

    # HITL report every 5 failures
    last_hitl = caps.get("last_hitl_at_count", 0)
    if retry_count >= 5 and retry_count - last_hitl >= config.CONNECTION_AGENT_BATCH_SIZE:
        # Refresh site data for HITL report
        site["capabilities"] = {**caps, **update}
        _report_to_hitl(site, retry_count, strategies_tried)
        update["last_hitl_at_count"] = retry_count

    await _update_capabilities(site_id, update)
    log.info("Retry failed for %s: attempt %d, strategy %s — %s",
             site_name, retry_count, strategy_name, error or "unknown error")


async def connection_agent_loop():
    """Main background loop — runs every CONNECTION_AGENT_INTERVAL seconds."""
    log.info("Connection agent started (interval=%ds, batch=%d)",
             config.CONNECTION_AGENT_INTERVAL, config.CONNECTION_AGENT_BATCH_SIZE)

    # Initial delay to let other services start
    await asyncio.sleep(30)

    while True:
        try:
            sites = await _get_sites_needing_attention()
            if sites:
                log.info("Connection agent: %d site(s) need attention", len(sites))
                for site in sites:
                    try:
                        await _run_retry_cycle(site)
                    except Exception as e:
                        log.error("Retry cycle failed for %s: %s",
                                  site.get("name", "?"), e)
            else:
                log.debug("Connection agent: all sites healthy")
        except Exception as e:
            log.error("Connection agent loop error: %s", e)

        await asyncio.sleep(config.CONNECTION_AGENT_INTERVAL)
