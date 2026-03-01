"""WP Automation Scheduler — checks for due schedules and executes them."""

import asyncio
import logging
import secrets
import time
from datetime import datetime, timezone

import httpx
from croniter import croniter
import pytz

import config

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from audit import log_audit

log = logging.getLogger("opai-wordpress.scheduler")

# ── Runtime scheduler state ──────────────────────────────────

_scheduler_tick: int = config.SCHEDULER_INTERVAL
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


# Track running executions to prevent overlap per site
_running_sites: set[str] = set()


def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


def _connector_headers(site: dict):
    """Build headers for calling the OPAI Connector on a WP site."""
    return {
        "X-OPAI-Key": site.get("connector_secret", ""),
        "Content-Type": "application/json",
    }


def _connector_url(site: dict, path: str):
    """Build full connector endpoint URL."""
    url = site.get("url", "").rstrip("/")
    return f"{url}/wp-json/opai/v1{path}"


async def _call_connector(site: dict, method: str, path: str, json_body=None, timeout=60):
    """Call an OPAI Connector endpoint on a WP site. Returns (ok, data_or_error)."""
    url = _connector_url(site, path)
    headers = _connector_headers(site)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if method == "GET":
                resp = await client.get(url, headers=headers)
            else:
                resp = await client.post(url, headers=headers, json=json_body or {})

            if resp.status_code < 300:
                return True, resp.json()
            else:
                return False, f"HTTP {resp.status_code}: {resp.text[:500]}"
    except Exception as e:
        return False, str(e)


async def _health_check(site: dict) -> tuple[bool, list[dict]]:
    """3-pronged health check. Returns (healthy, steps)."""
    steps = []

    # 1. Connector /health
    ok, data = await _call_connector(site, "GET", "/health", timeout=config.HEALTH_CHECK_TIMEOUT)
    steps.append({
        "name": "connector_health",
        "status": "pass" if ok and isinstance(data, dict) and data.get("status") == "healthy" else "fail",
        "detail": data if ok else str(data),
    })
    connector_ok = ok and isinstance(data, dict) and data.get("status") == "healthy"

    # 2. HTTP GET homepage
    homepage_ok = False
    try:
        async with httpx.AsyncClient(timeout=config.HEALTH_CHECK_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(site.get("url", ""))
            homepage_ok = resp.status_code < 400
            steps.append({
                "name": "homepage_http",
                "status": "pass" if homepage_ok else "fail",
                "detail": f"HTTP {resp.status_code}",
            })
    except Exception as e:
        steps.append({"name": "homepage_http", "status": "fail", "detail": str(e)})

    # 3. WP REST API
    rest_ok = False
    try:
        api_base = site.get("api_base", "/wp-json")
        rest_url = site.get("url", "").rstrip("/") + api_base
        async with httpx.AsyncClient(timeout=config.HEALTH_CHECK_TIMEOUT) as client:
            resp = await client.get(rest_url)
            rest_ok = resp.status_code < 400
            steps.append({
                "name": "wp_rest_api",
                "status": "pass" if rest_ok else "fail",
                "detail": f"HTTP {resp.status_code}",
            })
    except Exception as e:
        steps.append({"name": "wp_rest_api", "status": "fail", "detail": str(e)})

    # Healthy if at least 2 of 3 pass
    healthy = sum([connector_ok, homepage_ok, rest_ok]) >= 2
    return healthy, steps


async def _fetch_site(site_id: str) -> dict | None:
    """Fetch a single site row from Supabase."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*",
            headers=_sb_headers(),
        )
        if resp.status_code == 200:
            rows = resp.json()
            return rows[0] if rows else None
    return None


async def _create_log(schedule_id, site_id, task_type, trigger="schedule"):
    """Create an execution log entry. Returns log ID."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _sb_url("wp_execution_logs"),
            headers=_sb_headers(),
            json={
                "schedule_id": schedule_id,
                "site_id": site_id,
                "task_type": task_type,
                "status": "running",
                "trigger": trigger,
                "steps": [],
            },
        )
        if resp.status_code in (200, 201):
            rows = resp.json()
            return rows[0]["id"] if rows else None
    return None


async def _update_log(log_id: str, status: str, steps: list, rollback_backup_id=None):
    """Update an execution log entry."""
    update = {
        "status": status,
        "steps": steps,
        "finished_at": "now()",
    }
    if rollback_backup_id:
        update["rollback_backup_id"] = rollback_backup_id

    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{_sb_url('wp_execution_logs')}?id=eq.{log_id}",
            headers=_sb_headers(),
            json=update,
        )


async def _record_backup(site_id: str, user_id: str, trigger: str, connector_result: dict):
    """Record a backup in wp_backups table. Returns backup row ID."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _sb_url("wp_backups"),
            headers=_sb_headers(),
            json={
                "site_id": site_id,
                "user_id": user_id,
                "trigger": trigger,
                "status": connector_result.get("status", "completed"),
                "backup_type": connector_result.get("type", "full"),
                "size_bytes": connector_result.get("size_bytes"),
                "storage_path": connector_result.get("storage_path"),
                "metadata": {
                    "backup_id": connector_result.get("backup_id"),
                },
            },
        )
        if resp.status_code in (200, 201):
            rows = resp.json()
            return rows[0]["id"] if rows else None
    return None


async def _download_and_store_backup(site: dict, connector_backup_id: str, backup_row_id: str, expected_size: int = 0):
    """Download a backup archive from the WP connector and save locally."""
    if not connector_backup_id or not backup_row_id:
        return

    backup_folder = site.get("backup_folder") or site.get("name", "default").replace(" ", "_")
    dest_dir = config.BACKUP_STORAGE_DIR / backup_folder
    dest_dir.mkdir(parents=True, exist_ok=True)

    site_name = site.get("name", "site").replace(" ", "_")
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"{site_name}_{date_str}_backup.zip"
    dest_path = dest_dir / filename

    url = _connector_url(site, f"/backup/download/{connector_backup_id}")
    headers = _connector_headers(site)

    try:
        async with httpx.AsyncClient(timeout=600, follow_redirects=True) as client:
            async with client.stream("GET", url, headers=headers) as resp:
                if resp.status_code >= 300:
                    log.error("Backup download failed HTTP %d for %s", resp.status_code, site.get("name"))
                    return

                with open(dest_path, "wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=65536):
                        f.write(chunk)

        file_size = dest_path.stat().st_size

        # Verify download integrity
        if expected_size and file_size < expected_size * 0.95:
            log.error(
                "Backup download truncated for %s: got %d bytes, expected %d bytes (%.0f%%)",
                site.get("name"), file_size, expected_size, file_size / expected_size * 100,
            )
            dest_path.unlink()
            # Mark backup as truncated in DB
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{_sb_url('wp_backups')}?id=eq.{backup_row_id}&select=metadata",
                    headers=_sb_headers(),
                )
                metadata = {}
                if resp.status_code == 200 and resp.json():
                    metadata = resp.json()[0].get("metadata") or {}
                metadata["download_error"] = f"Truncated: {file_size}/{expected_size} bytes"
                await client.patch(
                    f"{_sb_url('wp_backups')}?id=eq.{backup_row_id}",
                    headers=_sb_headers(),
                    json={"metadata": metadata, "status": "download_failed"},
                )
            return

        log.info("Backup downloaded: %s (%d bytes)", dest_path, file_size)

        # Update wp_backups row with local_path in metadata
        async with httpx.AsyncClient(timeout=10) as client:
            # Fetch current metadata
            resp = await client.get(
                f"{_sb_url('wp_backups')}?id=eq.{backup_row_id}&select=metadata",
                headers=_sb_headers(),
            )
            metadata = {}
            if resp.status_code == 200 and resp.json():
                metadata = resp.json()[0].get("metadata") or {}

            metadata["local_path"] = str(dest_path)
            await client.patch(
                f"{_sb_url('wp_backups')}?id=eq.{backup_row_id}",
                headers=_sb_headers(),
                json={"metadata": metadata},
            )

    except Exception as e:
        log.error("Backup download error for %s: %s", site.get("name"), e)
        # Clean up partial file
        if dest_path.exists():
            dest_path.unlink()


def _compute_next_run(cron_expr: str, tz_name: str) -> str:
    """Compute next run time from cron expression in given timezone. Returns ISO string."""
    try:
        tz = pytz.timezone(tz_name)
    except pytz.UnknownTimeZoneError:
        tz = pytz.UTC

    now = datetime.now(tz)
    cron = croniter(cron_expr, now)
    next_dt = cron.get_next(datetime)
    return next_dt.astimezone(timezone.utc).isoformat()


async def execute_schedule(schedule: dict, trigger: str = "schedule"):
    """Execute a single schedule's task pipeline."""
    site_id = schedule["site_id"]
    schedule_id = schedule["id"]
    task_type = schedule["task_type"]
    user_id = schedule["user_id"]

    # Per-site lock
    if site_id in _running_sites:
        log.info("Skipping schedule %s — site %s already has a running task", schedule_id, site_id)
        return
    _running_sites.add(site_id)

    steps = []
    backup_id = None

    try:
        # Fetch full site details
        site = await _fetch_site(site_id)
        if not site:
            log.error("Site %s not found for schedule %s", site_id, schedule_id)
            return

        if not site.get("connector_installed") or not site.get("connector_secret"):
            log.error("Connector not installed on site %s", site.get("name"))
            return

        # Create execution log
        log_id = await _create_log(schedule_id, site_id, task_type, trigger)
        if not log_id:
            log.error("Failed to create execution log for schedule %s", schedule_id)
            return

        # Step 1: Pre-backup (if enabled)
        if schedule.get("pre_backup") and task_type != "backup":
            ok, data = await _call_connector(site, "POST", "/backup/create",
                                             json_body={"type": "full"}, timeout=300)
            step = {
                "name": "pre_backup",
                "status": "pass" if ok else "fail",
                "detail": data if isinstance(data, dict) else str(data),
            }
            steps.append(step)

            if ok and isinstance(data, dict):
                backup_id = await _record_backup(site_id, user_id, "pre_update", data)
                if backup_id:
                    connector_bid = data.get("backup_id")
                    if connector_bid:
                        await _download_and_store_backup(site, connector_bid, backup_id, data.get("size_bytes", 0))

            if not ok:
                log.warning("Pre-backup failed for %s, continuing anyway", site.get("name"))

        # Step 2: Execute task
        task_ok = False
        if task_type == "health_check":
            healthy, health_steps = await _health_check(site)
            task_ok = healthy
            steps.append({
                "name": "health_check",
                "status": "pass" if healthy else "fail",
                "detail": health_steps,
            })
        elif task_type == "backup":
            btype = schedule.get("task_config", {}).get("backup_type", "full")
            ok, data = await _call_connector(site, "POST", "/backup/create",
                                             json_body={"type": btype}, timeout=300)
            task_ok = ok
            steps.append({
                "name": "backup",
                "status": "pass" if ok else "fail",
                "detail": data if isinstance(data, dict) else str(data),
            })
            if ok and isinstance(data, dict):
                sched_backup_id = await _record_backup(site_id, user_id, "scheduled", data)
                if sched_backup_id:
                    connector_bid = data.get("backup_id")
                    if connector_bid:
                        await _download_and_store_backup(site, connector_bid, sched_backup_id, data.get("size_bytes", 0))
        else:
            # Update tasks
            type_map = {
                "update_all": "all",
                "update_plugins": "plugins",
                "update_themes": "themes",
                "update_core": "core",
            }
            update_type = type_map.get(task_type, "all")
            ok, data = await _call_connector(site, "POST", "/updates/apply",
                                             json_body={"type": update_type}, timeout=300)
            task_ok = ok
            steps.append({
                "name": "apply_updates",
                "status": "pass" if ok else "fail",
                "detail": data if isinstance(data, dict) else str(data),
            })

        # Step 3: Post-update health check (for update tasks)
        if task_type not in ("backup", "health_check") and task_ok:
            healthy, health_steps = await _health_check(site)
            steps.append({
                "name": "post_update_health",
                "status": "pass" if healthy else "fail",
                "detail": health_steps,
            })

            # Step 4: Rollback if unhealthy
            if not healthy and schedule.get("auto_rollback") and backup_id:
                # Get backup_id from connector result
                connector_backup_id = None
                for s in steps:
                    if s["name"] == "pre_backup" and isinstance(s.get("detail"), dict):
                        connector_backup_id = s["detail"].get("backup_id")
                        break

                if connector_backup_id:
                    ok, data = await _call_connector(
                        site, "POST", "/backup/restore",
                        json_body={"backup_id": connector_backup_id}, timeout=300,
                    )
                    steps.append({
                        "name": "rollback",
                        "status": "pass" if ok else "fail",
                        "detail": data if isinstance(data, dict) else str(data),
                    })

                    await _update_log(log_id, "rolled_back", steps, rollback_backup_id=backup_id)

                    # Update schedule timestamps
                    next_run = _compute_next_run(schedule["cron_expression"],
                                                 schedule.get("timezone", "UTC"))
                    async with httpx.AsyncClient(timeout=10) as client:
                        await client.patch(
                            f"{_sb_url('wp_schedules')}?id=eq.{schedule_id}",
                            headers=_sb_headers(),
                            json={"last_run_at": "now()", "next_run_at": next_run},
                        )

                    log.warning("Schedule %s rolled back for site %s", schedule_id, site.get("name"))
                    return

            if not healthy:
                await _update_log(log_id, "failed", steps)
                next_run = _compute_next_run(schedule["cron_expression"],
                                             schedule.get("timezone", "UTC"))
                async with httpx.AsyncClient(timeout=10) as client:
                    await client.patch(
                        f"{_sb_url('wp_schedules')}?id=eq.{schedule_id}",
                        headers=_sb_headers(),
                        json={"last_run_at": "now()", "next_run_at": next_run},
                    )
                log.error("Schedule %s failed health check for site %s", schedule_id, site.get("name"))
                return

        # Success
        final_status = "success" if task_ok else "failed"
        await _update_log(log_id, final_status, steps)

        # Update schedule timestamps
        next_run = _compute_next_run(schedule["cron_expression"],
                                     schedule.get("timezone", "UTC"))
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_schedules')}?id=eq.{schedule_id}",
                headers=_sb_headers(),
                json={"last_run_at": "now()", "next_run_at": next_run},
            )

        log.info("Schedule %s completed with status=%s for site %s",
                 schedule_id, final_status, site.get("name"))

        try:
            log_audit(
                tier="execution",
                service="opai-wordpress",
                event="scheduled-task",
                status="completed" if task_ok else "failed",
                summary=f"WP {task_type} for {site.get('name', site_id)} — {final_status}",
                details={"schedule_id": schedule_id, "site_id": site_id, "task_type": task_type, "final_status": final_status},
            )
        except Exception:
            pass

    except Exception as e:
        log.error("Schedule %s execution error: %s", schedule_id, e)
    finally:
        _running_sites.discard(site_id)


async def scheduler_loop():
    """Main scheduler loop — runs every SCHEDULER_INTERVAL seconds."""
    log.info("Scheduler started (interval=%ds)", _scheduler_tick)

    # Wait a bit on startup for other services to initialize
    await asyncio.sleep(5)

    while True:
        try:
            if _scheduler_paused:
                await asyncio.sleep(_scheduler_tick)
                continue
            # Query due schedules (use urllib to encode + in timezone offset)
            from urllib.parse import quote
            now_iso = quote(datetime.now(timezone.utc).isoformat())
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{_sb_url('wp_schedules')}?enabled=eq.true&next_run_at=lte.{now_iso}&select=*",
                    headers=_sb_headers(),
                )
                if resp.status_code != 200:
                    log.error("Failed to fetch schedules: %s", resp.text)
                    await asyncio.sleep(config.SCHEDULER_INTERVAL)
                    continue

                schedules = resp.json()

            if schedules:
                log.info("Found %d due schedule(s)", len(schedules))
                # Run each as a concurrent task
                tasks = [asyncio.create_task(execute_schedule(s)) for s in schedules]
                await asyncio.gather(*tasks, return_exceptions=True)

        except Exception as e:
            log.error("Scheduler loop error: %s", e)

        await asyncio.sleep(_scheduler_tick)


async def run_schedule_now(schedule_id: str):
    """Manually trigger a schedule. Returns quickly, runs in background."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_schedules')}?id=eq.{schedule_id}&select=*",
            headers=_sb_headers(),
        )
        if resp.status_code != 200 or not resp.json():
            return {"ok": False, "error": "Schedule not found"}

        schedule = resp.json()[0]

    asyncio.create_task(execute_schedule(schedule, trigger="manual"))
    return {"ok": True, "message": "Schedule triggered"}


def generate_connector_secret():
    """Generate a random connector secret."""
    return secrets.token_urlsafe(36)
