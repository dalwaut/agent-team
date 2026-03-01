"""OP WordPress — Automation routes (schedules, logs, backups, connector, scheduler settings)."""

import httpx
from fastapi import APIRouter, Depends, HTTPException, Header, Query
from fastapi.responses import FileResponse
from pathlib import Path
from pydantic import BaseModel
from typing import Optional

import config
from auth import get_current_user, AuthUser, decode_token, _enrich_user

router = APIRouter(prefix="/api")


def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Request Models ────────────────────────────────────────

class CreateSchedule(BaseModel):
    site_id: str
    name: str
    task_type: str
    cron_expression: str
    timezone: str = "America/Chicago"
    task_config: dict = {}
    enabled: bool = True
    auto_rollback: bool = True
    pre_backup: bool = True


class UpdateSchedule(BaseModel):
    name: Optional[str] = None
    task_type: Optional[str] = None
    cron_expression: Optional[str] = None
    timezone: Optional[str] = None
    task_config: Optional[dict] = None
    enabled: Optional[bool] = None
    auto_rollback: Optional[bool] = None
    pre_backup: Optional[bool] = None


class CreateBackup(BaseModel):
    backup_type: str = "full"


# ── Schedule CRUD ─────────────────────────────────────────

@router.get("/schedules")
async def list_schedules(site_id: str = None, user: AuthUser = Depends(get_current_user)):
    """List schedules, optionally filtered by site_id."""
    params = "?select=*,wp_sites(name,url)&order=created_at.desc"
    if site_id:
        params += f"&site_id=eq.{site_id}"
    if not user.is_admin:
        params += f"&user_id=eq.{user.id}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{_sb_url('wp_schedules')}{params}", headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch schedules")
        return resp.json()


@router.post("/schedules")
async def create_schedule(body: CreateSchedule, user: AuthUser = Depends(get_current_user)):
    """Create a new schedule."""
    from services.scheduler import _compute_next_run

    # Validate cron
    try:
        from croniter import croniter
        croniter(body.cron_expression)
    except (ValueError, KeyError):
        raise HTTPException(400, "Invalid cron expression")

    next_run = _compute_next_run(body.cron_expression, body.timezone)

    row = {
        "site_id": body.site_id,
        "user_id": user.id,
        "name": body.name,
        "task_type": body.task_type,
        "cron_expression": body.cron_expression,
        "timezone": body.timezone,
        "task_config": body.task_config,
        "enabled": body.enabled,
        "auto_rollback": body.auto_rollback,
        "pre_backup": body.pre_backup,
        "next_run_at": next_run,
    }

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_sb_url("wp_schedules"), headers=_sb_headers(), json=row)
        if resp.status_code not in (200, 201):
            raise HTTPException(500, f"Failed to create schedule: {resp.text}")
        return resp.json()[0]


@router.put("/schedules/{schedule_id}")
async def update_schedule(schedule_id: str, body: UpdateSchedule,
                          user: AuthUser = Depends(get_current_user)):
    """Update a schedule."""
    update = {k: v for k, v in body.dict().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")

    # Recompute next_run if cron or timezone changed
    if "cron_expression" in update or "timezone" in update:
        from services.scheduler import _compute_next_run
        # Need current values for missing fields
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{_sb_url('wp_schedules')}?id=eq.{schedule_id}&select=cron_expression,timezone",
                headers=_sb_headers(),
            )
            if resp.status_code == 200 and resp.json():
                current = resp.json()[0]
                cron = update.get("cron_expression", current["cron_expression"])
                tz = update.get("timezone", current["timezone"])
                update["next_run_at"] = _compute_next_run(cron, tz)

    update["updated_at"] = "now()"

    url = f"{_sb_url('wp_schedules')}?id=eq.{schedule_id}"
    if not user.is_admin:
        url += f"&user_id=eq.{user.id}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(url, headers=_sb_headers(), json=update)
        if resp.status_code not in (200, 204):
            raise HTTPException(500, f"Failed to update schedule: {resp.text}")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, "Schedule not found")
        return rows[0]


@router.delete("/schedules/{schedule_id}")
async def delete_schedule(schedule_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete a schedule."""
    url = f"{_sb_url('wp_schedules')}?id=eq.{schedule_id}"
    if not user.is_admin:
        url += f"&user_id=eq.{user.id}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.delete(url, headers=_sb_headers())
        if resp.status_code not in (200, 204):
            raise HTTPException(500, "Failed to delete schedule")
    return {"ok": True}


@router.post("/schedules/{schedule_id}/toggle")
async def toggle_schedule(schedule_id: str, user: AuthUser = Depends(get_current_user)):
    """Toggle a schedule enabled/disabled."""
    # Fetch current state
    async with httpx.AsyncClient(timeout=10) as client:
        url = f"{_sb_url('wp_schedules')}?id=eq.{schedule_id}&select=enabled"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.get(url, headers=_sb_headers())
        if resp.status_code != 200 or not resp.json():
            raise HTTPException(404, "Schedule not found")
        current = resp.json()[0]

    new_enabled = not current["enabled"]
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{_sb_url('wp_schedules')}?id=eq.{schedule_id}",
            headers=_sb_headers(),
            json={"enabled": new_enabled, "updated_at": "now()"},
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(500, "Failed to toggle schedule")
        return resp.json()[0]


@router.post("/schedules/{schedule_id}/run")
async def run_schedule_now(schedule_id: str, user: AuthUser = Depends(get_current_user)):
    """Trigger a schedule to run immediately."""
    from services.scheduler import run_schedule_now as trigger

    result = await trigger(schedule_id)
    if not result.get("ok"):
        raise HTTPException(404, result.get("error", "Failed to trigger"))
    return result


# ── Execution Logs ────────────────────────────────────────

@router.get("/sites/{site_id}/logs")
async def list_logs(site_id: str, page: int = 0, limit: int = 20,
                    status: str = None, task_type: str = None,
                    user: AuthUser = Depends(get_current_user)):
    """Get paginated execution logs for a site. Optional status and task_type filters."""
    offset = page * limit
    params = (
        f"?site_id=eq.{site_id}&select=*,wp_schedules(name)"
        f"&order=started_at.desc&offset={offset}&limit={limit}"
    )
    if status:
        params += f"&status=eq.{status}"
    if task_type:
        params += f"&task_type=eq.{task_type}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{_sb_url('wp_execution_logs')}{params}", headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch logs")

        # Get total count (respecting filters)
        count_params = f"?site_id=eq.{site_id}&select=id"
        if status:
            count_params += f"&status=eq.{status}"
        if task_type:
            count_params += f"&task_type=eq.{task_type}"
        count_resp = await client.get(
            f"{_sb_url('wp_execution_logs')}{count_params}",
            headers={**_sb_headers(), "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"},
        )
        total = int(count_resp.headers.get("content-range", "0/0").split("/")[-1] or 0)

        return {"logs": resp.json(), "total": total, "page": page, "limit": limit}


@router.get("/logs/{log_id}")
async def get_log(log_id: str, user: AuthUser = Depends(get_current_user)):
    """Get a single execution log with full step details."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_execution_logs')}?id=eq.{log_id}&select=*,wp_schedules(name)",
            headers=_sb_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch log")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, "Log not found")
        return rows[0]


# ── Backups ───────────────────────────────────────────────

@router.get("/sites/{site_id}/backups")
async def list_backups(site_id: str, user: AuthUser = Depends(get_current_user)):
    """List backups for a site."""
    params = f"?site_id=eq.{site_id}&select=*&order=created_at.desc&limit=50"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{_sb_url('wp_backups')}{params}", headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch backups")
        return resp.json()


@router.post("/sites/{site_id}/backups")
async def create_backup(site_id: str, body: CreateBackup,
                        user: AuthUser = Depends(get_current_user)):
    """Create a backup using a two-phase server-side approach.

    Phase 1: Stream DB dump from connector → save locally (avoids remote ZIP/timeout)
    Phase 2: Request files-only backup on connector → download to local storage
    Phase 3: Combine DB dump + files ZIP into a single local backup

    Falls back to synchronous single-call if two-phase isn't available.
    """
    import zipfile
    from datetime import datetime, timezone

    # Fetch site
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*",
            headers=_sb_headers(),
        )
        if resp.status_code != 200 or not resp.json():
            raise HTTPException(404, "Site not found")
        site = resp.json()[0]

    if not site.get("connector_installed") or not site.get("connector_secret"):
        raise HTTPException(400, "OPAI Connector not installed on this site")

    from services.scheduler import _call_connector, _record_backup, _download_and_store_backup, _create_log, _update_log, _connector_url, _connector_headers
    import logging
    _log = logging.getLogger("opai-wordpress.automation")

    log_id = await _create_log(None, site_id, "backup", trigger="manual")

    backup_folder = site.get("backup_folder") or site.get("name", "default").replace(" ", "_")
    dest_dir = config.BACKUP_STORAGE_DIR / backup_folder
    dest_dir.mkdir(parents=True, exist_ok=True)
    site_name = site.get("name", "site").replace(" ", "_")
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    local_zip_path = dest_dir / f"{site_name}_{date_str}_backup.zip"

    include_db = body.backup_type in ("full", "database")
    include_files = body.backup_type in ("full", "files")

    steps = []
    db_sql_path = None
    files_zip_path = None

    try:
        # ── Phase 1: Stream DB dump from connector ──
        if include_db:
            db_sql_path = dest_dir / f"_tmp_db_{date_str}.sql"
            db_url = _connector_url(site, "/backup/dump-db")
            db_headers = _connector_headers(site)

            _log.info("Streaming DB dump from %s", site.get("name"))
            try:
                async with httpx.AsyncClient(timeout=600, follow_redirects=True) as client:
                    async with client.stream("GET", db_url, headers=db_headers) as resp:
                        if resp.status_code >= 300:
                            raise Exception(f"DB dump HTTP {resp.status_code}")
                        with open(db_sql_path, "wb") as f:
                            async for chunk in resp.aiter_bytes(chunk_size=524288):
                                f.write(chunk)
                db_size = db_sql_path.stat().st_size
                _log.info("DB dump complete: %d bytes", db_size)
                steps.append({"name": "db_dump", "status": "pass", "detail": f"{db_size} bytes"})
            except Exception as e:
                _log.error("DB dump failed for %s: %s", site.get("name"), e)
                steps.append({"name": "db_dump", "status": "fail", "detail": str(e)})
                if db_sql_path and db_sql_path.exists():
                    db_sql_path.unlink()
                db_sql_path = None
                # Continue without DB if files are requested
                if not include_files:
                    if log_id:
                        await _update_log(log_id, "failed", steps)
                    raise HTTPException(500, f"DB dump failed: {e}")

        # ── Phase 2: Stream files tar from connector (no ZipArchive needed) ──
        if include_files:
            files_zip_path = dest_dir / f"_tmp_files_{date_str}.tar"
            tar_url = _connector_url(site, "/backup/stream-tar")
            tar_headers = _connector_headers(site)

            _log.info("Streaming files tar from %s", site.get("name"))
            try:
                async with httpx.AsyncClient(timeout=1200, follow_redirects=True) as client:
                    async with client.stream("GET", tar_url, headers=tar_headers) as resp:
                        if resp.status_code >= 300:
                            body_preview = ""
                            async for chunk in resp.aiter_bytes(chunk_size=1024):
                                body_preview += chunk.decode("utf-8", errors="replace")
                                if len(body_preview) > 500:
                                    break
                            raise Exception(f"stream-tar HTTP {resp.status_code}: {body_preview[:300]}")
                        with open(files_zip_path, "wb") as f:
                            async for chunk in resp.aiter_bytes(chunk_size=524288):
                                f.write(chunk)
                fsize = files_zip_path.stat().st_size
                _log.info("Files tar downloaded: %d bytes", fsize)
                steps.append({"name": "files_stream", "status": "pass", "detail": f"{fsize} bytes"})
            except Exception as e:
                _log.error("Files stream failed: %s", e)
                steps.append({"name": "files_stream", "status": "fail", "detail": str(e)})
                if files_zip_path and files_zip_path.exists():
                    files_zip_path.unlink()
                files_zip_path = None

        # ── Phase 3: Assemble local backup ZIP ──
        import tarfile

        if not db_sql_path and not files_zip_path:
            if log_id:
                await _update_log(log_id, "failed", steps)
            raise HTTPException(500, "Backup failed: no data retrieved")

        _log.info("Assembling local backup ZIP: %s", local_zip_path)
        with zipfile.ZipFile(str(local_zip_path), "w", zipfile.ZIP_DEFLATED) as zf:
            # Add DB dump
            if db_sql_path and db_sql_path.exists():
                zf.write(str(db_sql_path), "db.sql")

            # Merge files from connector tar (or ZIP for backwards compat)
            if files_zip_path and files_zip_path.exists():
                fname = str(files_zip_path)
                if fname.endswith(".tar") and tarfile.is_tarfile(fname):
                    with tarfile.open(fname, "r") as tf:
                        for member in tf:
                            if not member.isfile():
                                continue
                            f = tf.extractfile(member)
                            if f:
                                zf.writestr(member.name, f.read())
                elif zipfile.is_zipfile(fname):
                    with zipfile.ZipFile(fname, "r") as src:
                        for item in src.infolist():
                            zf.writestr(item, src.read(item.filename))

        final_size = local_zip_path.stat().st_size
        _log.info("Local backup assembled: %s (%d bytes)", local_zip_path, final_size)

        # Clean up temp files
        if db_sql_path and db_sql_path.exists():
            db_sql_path.unlink()
        if files_zip_path and files_zip_path.exists():
            files_zip_path.unlink()

        steps.append({"name": "assemble", "status": "pass", "detail": f"{final_size} bytes"})

    except HTTPException:
        raise
    except Exception as e:
        _log.error("Backup assembly failed: %s", e)
        # Clean up temp files
        for p in [db_sql_path, files_zip_path]:
            if p and p.exists():
                p.unlink()
        if log_id:
            steps.append({"name": "assemble", "status": "fail", "detail": str(e)})
            await _update_log(log_id, "failed", steps)
        raise HTTPException(500, f"Backup assembly failed: {e}")

    # Record in Supabase
    backup_data = {
        "status": "completed",
        "backup_id": f"local_{date_str}",
        "type": body.backup_type,
        "size_bytes": final_size,
    }
    backup_row_id = await _record_backup(site_id, user.id, "manual", backup_data)

    # Update local path in metadata
    if backup_row_id:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_backups')}?id=eq.{backup_row_id}",
                headers=_sb_headers(),
                json={"metadata": {"local_path": str(local_zip_path), "backup_id": backup_data["backup_id"]}},
            )

    # Complete the execution log
    size_mb = round(final_size / 1024 / 1024, 1)
    if log_id:
        await _update_log(log_id, "success", steps)

    return {"ok": True, "backup": backup_data, "backup_row_id": backup_row_id}


@router.get("/sites/{site_id}/backups/progress")
async def backup_progress(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Poll the connector's backup progress (reads latest progress file)."""
    site = await _fetch_site_by_id(site_id)
    if not site:
        raise HTTPException(404, "Site not found")

    if not site.get("connector_installed") or not site.get("connector_secret"):
        return {"phase": "no_connector"}

    from services.scheduler import _call_connector
    ok, data = await _call_connector(site, "GET", "/backup/status/latest", timeout=10)
    if ok and isinstance(data, dict):
        return data
    return {"phase": "unknown"}


@router.delete("/backups/{backup_id}")
async def delete_backup(backup_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete a backup record and optionally remove from remote storage."""
    # Fetch backup to verify ownership
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_backups')}?id=eq.{backup_id}&select=*",
            headers=_sb_headers(),
        )
        if resp.status_code != 200 or not resp.json():
            raise HTTPException(404, "Backup not found")
        backup = resp.json()[0]

    # Delete local file if exists
    local_path = backup.get("metadata", {}).get("local_path")
    if local_path:
        p = Path(local_path)
        if p.exists():
            p.unlink()

    # Try to delete from remote storage via connector
    site = await _fetch_site_by_id(backup["site_id"])
    if site and site.get("connector_installed"):
        connector_backup_id = backup.get("metadata", {}).get("backup_id")
        if connector_backup_id:
            from services.scheduler import _call_connector
            await _call_connector(site, "POST", "/backup/delete",
                                  json_body={"backup_id": connector_backup_id}, timeout=30)

    # Delete from Supabase
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.delete(
            f"{_sb_url('wp_backups')}?id=eq.{backup_id}",
            headers=_sb_headers(),
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(500, "Failed to delete backup")

    return {"ok": True}


@router.get("/backups/{backup_id}/download")
async def download_backup(
    backup_id: str,
    token: str = Query(None),
    authorization: str = Header(None),
):
    """Download a backup ZIP. Accepts auth via header or ?token= query param."""
    # Auth: accept Bearer header OR ?token= query param (for native browser downloads)
    auth_value = authorization
    if not auth_value and token:
        auth_value = f"Bearer {token}"
    if not auth_value:
        raise HTTPException(401, "Authentication required")

    scheme, _, tok = auth_value.partition(" ")
    if scheme.lower() != "bearer" or not tok:
        raise HTTPException(401, "Bearer token required")

    user = await decode_token(tok)
    user = await _enrich_user(user)

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_backups')}?id=eq.{backup_id}&select=*",
            headers=_sb_headers(),
        )
        if resp.status_code != 200 or not resp.json():
            raise HTTPException(404, "Backup not found")
        backup = resp.json()[0]

    # Serve local file directly — use the exact filename on disk
    local_path = backup.get("metadata", {}).get("local_path")
    if local_path:
        p = Path(local_path)
        if p.exists():
            return FileResponse(
                p,
                media_type="application/zip",
                filename=p.name,
            )

    site = await _fetch_site_by_id(backup["site_id"])
    if not site:
        raise HTTPException(404, "Site not found")

    connector_backup_id = backup.get("metadata", {}).get("backup_id")
    if not connector_backup_id:
        raise HTTPException(400, "Backup has no connector backup ID — cannot download")

    # Build direct connector download URL
    url = site.get("url", "").rstrip("/")
    download_url = f"{url}/wp-json/opai/v1/backup/download/{connector_backup_id}"

    return {
        "download_url": download_url,
        "backup_id": connector_backup_id,
        "site_name": site.get("name", ""),
        "backup_type": backup.get("backup_type", "full"),
        "created_at": backup.get("created_at"),
    }


@router.get("/sites/{site_id}/logs/stats")
async def log_stats(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Get summary stats for execution logs (counts by status)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_execution_logs')}?site_id=eq.{site_id}&select=status",
            headers=_sb_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch log stats")

        logs = resp.json()
        stats = {"total": len(logs), "success": 0, "failed": 0, "rolled_back": 0, "running": 0}
        for log_entry in logs:
            s = log_entry.get("status", "")
            if s in stats:
                stats[s] += 1
        return stats


@router.post("/backups/{backup_id}/restore")
async def restore_backup(backup_id: str, user: AuthUser = Depends(get_current_user)):
    """Restore from a backup."""
    # Fetch backup record
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_backups')}?id=eq.{backup_id}&select=*",
            headers=_sb_headers(),
        )
        if resp.status_code != 200 or not resp.json():
            raise HTTPException(404, "Backup not found")
        backup = resp.json()[0]

    # Fetch site
    site = await _fetch_site_by_id(backup["site_id"])
    if not site:
        raise HTTPException(404, "Site not found")

    from services.scheduler import _call_connector

    connector_backup_id = backup.get("metadata", {}).get("backup_id")
    if not connector_backup_id:
        raise HTTPException(400, "Backup has no connector backup ID")

    # Update backup status
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{_sb_url('wp_backups')}?id=eq.{backup_id}",
            headers=_sb_headers(),
            json={"status": "restoring", "updated_at": "now()"},
        )

    ok, data = await _call_connector(site, "POST", "/backup/restore",
                                     json_body={"backup_id": connector_backup_id}, timeout=300)

    new_status = "restored" if ok else "failed"
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{_sb_url('wp_backups')}?id=eq.{backup_id}",
            headers=_sb_headers(),
            json={"status": new_status, "updated_at": "now()"},
        )

    if not ok:
        raise HTTPException(500, f"Restore failed: {data}")

    return {"ok": True, "status": "restored"}


# ── Backup Folder Management ─────────────────────────────

@router.get("/backup-folders")
async def list_backup_folders(user: AuthUser = Depends(get_current_user)):
    """List available backup storage subfolders."""
    root = config.BACKUP_STORAGE_DIR
    if not root.exists():
        root.mkdir(parents=True, exist_ok=True)
        return []

    folders = sorted([d.name for d in root.iterdir() if d.is_dir()])
    return folders


class SetBackupFolder(BaseModel):
    backup_folder: str


@router.put("/sites/{site_id}/backup-folder")
async def set_backup_folder(site_id: str, body: SetBackupFolder,
                            user: AuthUser = Depends(get_current_user)):
    """Set the local backup folder for a site."""
    folder_name = body.backup_folder.strip()
    if not folder_name:
        raise HTTPException(400, "Folder name cannot be empty")

    # Create the folder if it doesn't exist
    folder_path = config.BACKUP_STORAGE_DIR / folder_name
    folder_path.mkdir(parents=True, exist_ok=True)

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}",
            headers=_sb_headers(),
            json={"backup_folder": folder_name, "updated_at": "now()"},
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(500, "Failed to update backup folder")

    return {"ok": True, "backup_folder": folder_name}


# ── Connector Status & Setup ─────────────────────────────

@router.get("/sites/{site_id}/connector/status")
async def connector_status(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Check if the OPAI Connector is reachable on a site."""
    site = await _fetch_site_by_id(site_id)
    if not site:
        raise HTTPException(404, "Site not found")

    if not site.get("connector_secret"):
        return {"installed": False, "reachable": False, "message": "No connector secret configured"}

    from services.scheduler import _call_connector
    ok, data = await _call_connector(site, "GET", "/health", timeout=10)

    return {
        "installed": site.get("connector_installed", False),
        "reachable": ok,
        "health": data if ok else None,
        "error": str(data) if not ok else None,
    }


@router.post("/sites/{site_id}/connector/setup")
async def connector_setup(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Generate a connector secret and return setup instructions."""
    from services.scheduler import generate_connector_secret

    secret = generate_connector_secret()

    # Save to wp_sites
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}",
            headers=_sb_headers(),
            json={"connector_secret": secret, "updated_at": "now()"},
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(500, "Failed to save connector secret")

    site = await _fetch_site_by_id(site_id)
    site_url = site["url"] if site else ""

    return {
        "secret": secret,
        "instructions": [
            "1. Download the OPAI Connector plugin from the Plugins page",
            "2. Upload and activate it on your WordPress site",
            f"3. Run: wp option update opai_connector_key {secret}",
            "4. Or add to wp-config.php: define('OPAI_CONNECTOR_KEY', '" + secret + "');",
            "5. Click 'Verify Connection' to confirm",
        ],
        "wp_cli_command": f"wp option update opai_connector_key {secret}",
        "verify_url": f"{site_url}/wp-json/opai/v1/health",
    }


@router.post("/sites/{site_id}/connector/verify")
async def connector_verify(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Verify connector is installed and reachable, then mark site."""
    site = await _fetch_site_by_id(site_id)
    if not site:
        raise HTTPException(404, "Site not found")

    from services.scheduler import _call_connector
    ok, data = await _call_connector(site, "GET", "/health", timeout=10)

    if ok:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_sites')}?id=eq.{site_id}",
                headers=_sb_headers(),
                json={"connector_installed": True, "updated_at": "now()"},
            )

    return {"verified": ok, "health": data if ok else None, "error": str(data) if not ok else None}


# ── Helper ────────────────────────────────────────────────

async def _fetch_site_by_id(site_id: str) -> dict | None:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*",
            headers=_sb_headers(),
        )
        if resp.status_code == 200:
            rows = resp.json()
            return rows[0] if rows else None
    return None


# ── Scheduler Settings (heartbeat control) ─────────────────────────────────

class _SchedulerSettingsBody(BaseModel):
    tick_seconds: Optional[int] = None
    paused: Optional[bool] = None


@router.get("/scheduler/settings")
async def get_scheduler_settings_endpoint(user: AuthUser = Depends(get_current_user)):
    if getattr(user, "role", "") != "admin":
        raise HTTPException(403, "Admin only")
    from services.scheduler import get_scheduler_settings
    return get_scheduler_settings()


@router.put("/scheduler/settings")
async def update_scheduler_settings_endpoint(body: _SchedulerSettingsBody, user: AuthUser = Depends(get_current_user)):
    if getattr(user, "role", "") != "admin":
        raise HTTPException(403, "Admin only")
    from services.scheduler import set_scheduler_settings
    return set_scheduler_settings(tick_seconds=body.tick_seconds, paused=body.paused)
