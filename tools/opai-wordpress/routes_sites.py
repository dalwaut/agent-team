"""OP WordPress — Site CRUD routes."""

import base64
import io
import logging
import re as _re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

import config
from auth import get_current_user, require_admin, AuthUser

log = logging.getLogger("opai-wordpress.sites")

router = APIRouter(prefix="/api")


def _sb_headers_service():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_headers_user(token: str):
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Request Models ────────────────────────────────────────

class ConnectSite(BaseModel):
    name: str
    url: str
    username: str
    app_password: str
    admin_password: Optional[str] = None
    api_base: str = "/wp-json"
    connector_secret: Optional[str] = None
    is_woocommerce: bool = False
    woo_key: Optional[str] = None
    woo_secret: Optional[str] = None


class UpdateSite(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    username: Optional[str] = None
    app_password: Optional[str] = None
    admin_password: Optional[str] = None
    api_base: Optional[str] = None
    is_woocommerce: Optional[bool] = None
    woo_key: Optional[str] = None
    woo_secret: Optional[str] = None
    connector_secret: Optional[str] = None
    backup_folder: Optional[str] = None


# ── Auth Config ───────────────────────────────────────────

@router.get("/auth/config")
def auth_config():
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── Site CRUD ─────────────────────────────────────────────

@router.post("/sites")
async def connect_site(body: ConnectSite, user: AuthUser = Depends(get_current_user)):
    """Connect a new WordPress site. Validates connection first."""
    from services.site_manager import SiteCredentials, test_connection

    # Ensure URL has scheme
    url = body.url.strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    # Build temp credentials to test
    test_row = {
        "id": "test",
        "name": body.name,
        "url": url,
        "api_base": body.api_base,
        "username": body.username,
        "app_password": body.app_password,
    }
    creds = SiteCredentials(test_row)
    result = test_connection(creds)

    if not result["success"]:
        raise HTTPException(400, f"Connection failed: {result.get('error', 'Unknown error')}")

    # Save to Supabase
    row = {
        "user_id": user.id,
        "name": body.name,
        "url": url,
        "api_base": body.api_base,
        "username": body.username,
        "app_password": body.app_password,
        "is_woocommerce": body.is_woocommerce,
        "woo_key": body.woo_key,
        "woo_secret": body.woo_secret,
        "status": "healthy",
    }
    if body.admin_password:
        row["admin_password"] = body.admin_password
    if body.connector_secret:
        row["connector_secret"] = body.connector_secret
        row["connector_installed"] = True

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            _sb_url("wp_sites"),
            headers=_sb_headers_service(),
            json=row,
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(500, f"Failed to save site: {resp.text}")

        sites = resp.json()
        return sites[0] if sites else row


@router.get("/sites")
async def list_sites(user: AuthUser = Depends(get_current_user)):
    """List user's connected WordPress sites."""
    async with httpx.AsyncClient(timeout=30) as client:
        params = "?select=*&order=name.asc"
        if not user.is_admin:
            params += f"&user_id=eq.{user.id}"
        resp = await client.get(
            f"{_sb_url('wp_sites')}{params}",
            headers=_sb_headers_service(),
        )
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch sites")
        return resp.json()


@router.get("/sites/{site_id}")
async def get_site(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Get a single site's details."""
    async with httpx.AsyncClient(timeout=30) as client:
        url = f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.get(url, headers=_sb_headers_service())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch site")
        sites = resp.json()
        if not sites:
            raise HTTPException(404, "Site not found")
        return sites[0]


@router.get("/sites/{site_id}/credentials")
async def get_credentials(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Get WP login credentials for auto-login."""
    site = await get_site(site_id, user)
    return {
        "username": site["username"],
        "app_password": site["app_password"],
        "admin_password": site.get("admin_password"),
    }


@router.put("/sites/{site_id}")
async def update_site(site_id: str, body: UpdateSite,
                      user: AuthUser = Depends(get_current_user)):
    """Update a site's configuration."""
    update = {k: v for k, v in body.dict().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")

    # When a connector key is manually provided, mark connector as installed
    if update.get("connector_secret"):
        update["connector_installed"] = True

    update["updated_at"] = "now()"

    async with httpx.AsyncClient(timeout=30) as client:
        url = f"{_sb_url('wp_sites')}?id=eq.{site_id}"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.patch(url, headers=_sb_headers_service(), json=update)
        if resp.status_code not in (200, 204):
            raise HTTPException(500, f"Failed to update site: {resp.text}")
        sites = resp.json()
        if not sites:
            raise HTTPException(404, "Site not found")
        return sites[0]


@router.delete("/sites/{site_id}")
async def delete_site(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Remove a connected site."""
    from services.site_manager import remove_site

    async with httpx.AsyncClient(timeout=30) as client:
        url = f"{_sb_url('wp_sites')}?id=eq.{site_id}"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.delete(url, headers=_sb_headers_service())
        if resp.status_code not in (200, 204):
            raise HTTPException(500, "Failed to delete site")

    remove_site(site_id)
    return {"ok": True}


@router.post("/sites/{site_id}/test")
async def test_site(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Test connection to a site."""
    site = await get_site(site_id, user)

    from services.site_manager import SiteCredentials, test_connection
    creds = SiteCredentials(site)
    result = test_connection(creds)

    # Update status
    new_status = "healthy" if result["success"] else "offline"
    async with httpx.AsyncClient(timeout=30) as client:
        await client.patch(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}",
            headers=_sb_headers_service(),
            json={"status": new_status, "last_check": "now()"},
        )

    return result


@router.post("/sites/{site_id}/refresh")
async def refresh_site(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Force refresh site info (version, theme, plugin counts).

    Strategy:
      1. If OPAI Connector is installed, use /opai/v1/health (fast, accurate).
      2. Fallback: WP REST API for plugins/themes lists + root endpoint for version.
      3. Last resort: wp-agent orchestrator.
    """
    site = await get_site(site_id, user)
    update = {"last_check": "now()", "status": "healthy"}
    info = {}
    got_data = False

    rest_headers = _wp_auth_header(site)

    # ── Strategy 1: Connector health endpoint ──────────────
    if site.get("connector_installed"):
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(
                    _wp_api(site, "/opai/v1/health"),
                    headers=rest_headers,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    got_data = True
                    info["connector_health"] = data
                    if data.get("wp_version"):
                        update["wp_version"] = data["wp_version"]
                    if data.get("total_plugins") is not None:
                        update["plugins_total"] = data["total_plugins"]
                    elif data.get("active_plugins") is not None:
                        update["plugins_total"] = data["active_plugins"]
                    if data.get("active_theme"):
                        update["theme"] = data["active_theme"]
                    if data.get("php_version"):
                        update["php_version"] = data["php_version"]
                    if data.get("status"):
                        update["status"] = data["status"]
                    log.info("Refresh via connector health for %s: wp=%s, plugins=%s, theme=%s",
                             site.get("name"), data.get("wp_version"),
                             data.get("total_plugins"), data.get("active_theme"))
                else:
                    log.warning("Connector health returned %d for %s",
                                resp.status_code, site.get("name"))
        except Exception as e:
            log.warning("Connector health failed for %s: %s", site.get("name"), e)

    # ── Strategy 2: Direct WP REST API ─────────────────────
    if not got_data:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                # Get WP version from root endpoint (no auth needed usually)
                try:
                    root_resp = await client.get(
                        _wp_api(site, "/"),
                        headers=rest_headers,
                    )
                    if root_resp.status_code == 200:
                        root_data = root_resp.json()
                        # WP root endpoint has name, description, url, and sometimes version
                        if root_data.get("description"):
                            info["site_description"] = root_data["description"]
                except Exception:
                    pass

                # Get plugins list for count + detect File Manager
                try:
                    plugins_resp = await client.get(
                        _wp_api(site, "/wp/v2/plugins?context=edit&per_page=100"),
                        headers=rest_headers,
                    )
                    if plugins_resp.status_code == 200:
                        plugins = plugins_resp.json()
                        if isinstance(plugins, list):
                            update["plugins_total"] = len(plugins)
                            got_data = True
                            info["plugins"] = plugins

                            # Detect File Manager plugin
                            has_fm = any(
                                "file-manager" in p.get("plugin", "").lower()
                                or "filemanager" in p.get("plugin", "").lower()
                                for p in plugins if isinstance(p, dict)
                            )
                            caps_update = {"has_file_manager": has_fm}

                            # Detect connector in plugin list
                            has_connector = any(
                                "opai-connector" in p.get("plugin", "")
                                for p in plugins if isinstance(p, dict)
                            )
                            if has_connector and not site.get("connector_installed"):
                                caps_update["connector_detected"] = True

                            from services.deployer import _update_capabilities
                            await _update_capabilities(site["id"], caps_update)
                except Exception:
                    pass

                # Get active theme
                try:
                    themes_resp = await client.get(
                        _wp_api(site, "/wp/v2/themes?status=active"),
                        headers=rest_headers,
                    )
                    if themes_resp.status_code == 200:
                        themes = themes_resp.json()
                        if isinstance(themes, list) and themes:
                            t = themes[0]
                            name = t.get("name", {})
                            if isinstance(name, dict):
                                name = name.get("raw", name.get("rendered", ""))
                            update["theme"] = str(name)
                            got_data = True
                except Exception:
                    pass

                # Get WP version from settings if available
                try:
                    settings_resp = await client.get(
                        _wp_api(site, "/wp/v2/settings"),
                        headers=rest_headers,
                    )
                    if settings_resp.status_code == 200:
                        pass  # Settings doesn't expose version directly
                except Exception:
                    pass

        except Exception as e:
            log.warning("REST API refresh failed for %s: %s", site.get("name"), e)

    # ── Strategy 3: wp-agent fallback ──────────────────────
    if not got_data:
        try:
            from services.site_manager import SiteCredentials, get_site_info
            creds = SiteCredentials(site)
            agent_info = get_site_info(creds)
            info.update(agent_info)

            if agent_info.get("active_theme"):
                theme = agent_info["active_theme"]
                if isinstance(theme, dict):
                    update["theme"] = theme.get("name", {}).get("raw", "") if isinstance(theme.get("name"), dict) else theme.get("name", "")
                elif isinstance(theme, list) and theme:
                    t = theme[0]
                    update["theme"] = t.get("name", {}).get("raw", "") if isinstance(t.get("name"), dict) else t.get("name", "")

            if agent_info.get("plugins_total") is not None:
                update["plugins_total"] = agent_info["plugins_total"]

            if agent_info.get("site_info") and isinstance(agent_info["site_info"], dict):
                si = agent_info["site_info"]
                if si.get("version"):
                    update["wp_version"] = si["version"]
        except Exception as e:
            log.warning("wp-agent refresh failed for %s: %s", site.get("name"), e)

    async with httpx.AsyncClient(timeout=30) as client:
        await client.patch(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}",
            headers=_sb_headers_service(),
            json=update,
        )

    return {"ok": True, "info": info, "updated_fields": {k: v for k, v in update.items() if k != "last_check"}}


# ── Connector Plugin Management ──────────────────────────────

def _wp_auth_header(site: dict) -> dict:
    """Build WP REST API Basic Auth headers."""
    cred = base64.b64encode(
        f"{site['username']}:{site['app_password']}".encode()
    ).decode()
    return {"Authorization": f"Basic {cred}"}


def _wp_api(site: dict, path: str) -> str:
    """Build full WP REST API URL."""
    base_url = site["url"].rstrip("/")
    api_base = site.get("api_base", "/wp-json")
    return f"{base_url}{api_base}{path}"


def _build_connector_zip() -> bytes:
    """Build a ZIP of the OPAI Connector plugin from source files."""
    plugin_dir = config.TOOL_DIR / "wp-plugin" / "opai-connector"
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in plugin_dir.rglob("*"):
            if file_path.is_file() and "__pycache__" not in str(file_path):
                arcname = "opai-connector/" + str(file_path.relative_to(plugin_dir))
                zf.write(file_path, arcname)

    return buf.getvalue()


@router.get("/connector/download")
async def download_connector(user: AuthUser = Depends(get_current_user)):
    """Download the OPAI Connector plugin as a ZIP file."""
    from fastapi.responses import Response
    zip_data = _build_connector_zip()
    return Response(
        content=zip_data,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=opai-connector.zip"},
    )


@router.post("/sites/{site_id}/connector/install")
async def install_connector(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Install the OPAI Connector plugin on a site using multi-strategy deployer.

    Tries: REST API (existing plugin) -> Admin Upload -> File Manager -> Manual fallback.
    Pins the working method in capabilities.deploy_method for future use.
    """
    from services.deployer import deploy_connector

    site = await get_site(site_id, user)
    result = await deploy_connector(site)

    if result.success:
        return {
            "status": "installed",
            "method": result.method,
            "message": result.message,
            "connector_key_stored": result.connector_key is not None,
        }
    else:
        return {
            "status": "manual_required",
            "method": result.method,
            "message": result.message,
            "download_url": result.download_url,
        }


@router.get("/sites/{site_id}/connector/status")
async def connector_status(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Check if the OPAI Connector plugin is installed and reachable."""
    site = await get_site(site_id, user)
    rest_headers = _wp_auth_header(site)

    caps = site.get("capabilities") or {}
    result = {
        "installed": site.get("connector_installed", False),
        "has_key": bool(site.get("connector_secret")),
        "has_admin_password": bool(site.get("admin_password")),
        "reachable": False,
        "version": None,
        "capabilities": {
            "deploy_method": caps.get("deploy_method"),
            "data_method": caps.get("data_method"),
            "has_file_manager": caps.get("has_file_manager"),
            "admin_accessible": caps.get("admin_accessible"),
        },
        "push_status": caps.get("push_status"),
        "push_reason": caps.get("push_reason"),
        "push_version_needed": caps.get("push_version_needed"),
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            # Use Basic Auth only for health check — avoids 403 from stale X-OPAI-Key
            resp = await client.get(
                _wp_api(site, "/opai/v1/health"),
                headers=rest_headers,
            )
            if resp.status_code == 200:
                data = resp.json()
                result["reachable"] = True
                result["version"] = data.get("connector_version")
                result["wp_version"] = data.get("wp_version")
                result["status"] = data.get("status")
                result["total_plugins"] = data.get("total_plugins")
                result["active_theme"] = data.get("active_theme")

                # Auto-update site record with fresh info from connector
                site_update = {}
                if data.get("wp_version") and not site.get("wp_version"):
                    site_update["wp_version"] = data["wp_version"]
                if data.get("total_plugins") and not site.get("plugins_total"):
                    site_update["plugins_total"] = data["total_plugins"]
                if data.get("active_theme") and not site.get("theme"):
                    site_update["theme"] = data["active_theme"]
                if site_update:
                    await client.patch(
                        f"{_sb_url('wp_sites')}?id=eq.{site_id}",
                        headers=_sb_headers_service(),
                        json=site_update,
                    )

                # Auto-configure: get/sync the connector key if missing or stale
                if not result["installed"] or not site.get("connector_secret"):
                    await _sync_connector_key(site, client, rest_headers)
                    result["installed"] = True
                    result["has_key"] = True
    except Exception:
        pass

    return result


async def _sync_connector_key(site: dict, client: httpx.AsyncClient, rest_headers: dict):
    """Call /setup to get the connector key (returns existing, doesn't regenerate) and store it."""
    try:
        setup_resp = await client.post(
            _wp_api(site, "/opai/v1/setup"),
            headers={**rest_headers, "Content-Type": "application/json"},
        )
        update_data = {"connector_installed": True, "updated_at": "now()"}
        if setup_resp.status_code == 200:
            key = setup_resp.json().get("connector_key")
            if key:
                update_data["connector_secret"] = key
        await client.patch(
            f"{_sb_url('wp_sites')}?id=eq.{site['id']}",
            headers=_sb_headers_service(),
            json=update_data,
        )
        log.info("Synced connector key for %s", site.get("name"))
    except Exception as e:
        log.warning("Sync connector key failed for %s: %s", site.get("name"), e)


@router.post("/connector/push-all")
async def push_connector_all(user: AuthUser = Depends(get_current_user)):
    """Push the latest OPAI Connector ZIP to all connected sites.

    Uses each site's pinned connection method (rest_api / admin_upload / file_manager).
    Sites without a pinned method try the full chain. Manual-only sites are flagged.
    Admin-only endpoint.
    """
    if not user.is_admin:
        from fastapi import HTTPException
        raise HTTPException(403, "Admin only")

    from services.deployer import push_update_connector, OPAI_CONNECTOR_VERSION_STR
    from services.task_logger import log_push_op
    import time as _time

    started_at = datetime.now(timezone.utc).isoformat()
    _start_mono = _time.monotonic()

    # Fetch all sites
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{_sb_url('wp_sites')}?select=*&order=name.asc",
            headers=_sb_headers_service(),
        )
        sites = resp.json() if resp.status_code == 200 else []

    results = []
    for site in sites:
        caps = site.get("capabilities") or {}
        site_result = {
            "site_id": site["id"],
            "name": site.get("name", site.get("url", "?")),
            "deploy_method": caps.get("deploy_method") or "auto",
        }
        try:
            result = await push_update_connector(site)
            site_result["status"] = "pushed" if result.success else "manual_required"
            site_result["method"] = result.method
            site_result["message"] = result.message
            if not result.success:
                refreshed_caps = site.get("capabilities") or {}
                site_result["push_reason"] = refreshed_caps.get("push_reason", "upload_failed")
        except Exception as e:
            log.error("Push failed for %s: %s", site.get("name"), e)
            site_result["status"] = "error"
            site_result["method"] = "unknown"
            site_result["message"] = str(e)
            site_result["push_reason"] = "error"

        results.append(site_result)

    pushed = sum(1 for r in results if r["status"] == "pushed")
    manual = sum(1 for r in results if r["status"] == "manual_required")
    errors = sum(1 for r in results if r["status"] == "error")

    completed_at = datetime.now(timezone.utc).isoformat()
    duration_ms = int((_time.monotonic() - _start_mono) * 1000)

    # Log run to task registry + audit log
    logged = log_push_op(
        plugin_version=OPAI_CONNECTOR_VERSION_STR,
        results=results,
        started_at=started_at,
        completed_at=completed_at,
        duration_ms=duration_ms,
    )

    return {
        "total": len(results),
        "pushed": pushed,
        "manual_required": manual,
        "errors": errors,
        "plugin_version": OPAI_CONNECTOR_VERSION_STR,
        "results": results,
        "task_id": logged.get("task_id"),
        "audit_id": logged.get("audit_id"),
    }


# ── OP Plugins (internal plugin library) ─────────────────────────

# Central directory for all OP-managed plugins
_OP_PLUGINS_DIR = Path(config.BASE_DIR) / "Projects" / "Plugins" / "OPPlugins"

OP_PLUGINS_REGISTRY = {
    "opai-connector": {
        "name": "OPAI Connector",
        "description": "Full-site management, backups, and remote control.",
        "folder": "opai-connector",
        "main_file": "opai-connector.php",
    },
    "wp-backup-onezip": {
        "name": "WE OneZip Backup",
        "description": "Full-site backup to a single ZIP file.",
        "folder": "wp-backup-onezip",
        "main_file": "wp-backup-onezip.php",
    },
}


def _parse_plugin_header(php_path: Path) -> dict:
    """Extract Version and Author from a WP plugin's main PHP file header."""
    info = {"version": None, "author": None}
    try:
        text = php_path.read_text(errors="replace")[:2000]
        m = _re.search(r"Version:\s*(.+)", text)
        if m:
            info["version"] = m.group(1).strip()
        m = _re.search(r"Author:\s*(.+)", text)
        if m:
            info["author"] = m.group(1).strip()
    except Exception:
        pass
    return info


@router.get("/op-plugins")
async def list_op_plugins(user: AuthUser = Depends(get_current_user)):
    """List available internal OP plugins with version/author from PHP headers."""
    plugins = []
    for slug, meta in OP_PLUGINS_REGISTRY.items():
        plugin_dir = _OP_PLUGINS_DIR / meta["folder"]
        main_php = plugin_dir / meta["main_file"]
        header = _parse_plugin_header(main_php)
        plugins.append({
            "slug": slug,
            "name": meta["name"],
            "description": meta["description"],
            "version": header["version"],
            "author": header["author"],
        })
    return plugins


class OPPluginInstall(BaseModel):
    slug: str


@router.post("/sites/{site_id}/op-plugins/install")
async def install_op_plugin(site_id: str, body: OPPluginInstall,
                            user: AuthUser = Depends(get_current_user)):
    """Build a ZIP from an OP plugin source and deploy it to the target site."""
    if body.slug not in OP_PLUGINS_REGISTRY:
        raise HTTPException(400, f"Unknown OP plugin: {body.slug}")

    meta = OP_PLUGINS_REGISTRY[body.slug]
    plugin_dir = _OP_PLUGINS_DIR / meta["folder"]
    if not plugin_dir.is_dir():
        raise HTTPException(500, f"Plugin source not found: {meta['folder']}")

    # Build ZIP
    folder_name = meta["folder"]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in plugin_dir.rglob("*"):
            if file_path.is_file() and "__pycache__" not in str(file_path):
                arcname = folder_name + "/" + str(file_path.relative_to(plugin_dir))
                zf.write(file_path, arcname)
    zip_data = buf.getvalue()
    log.info("Built OP plugin ZIP '%s': %d bytes", body.slug, len(zip_data))

    # Deploy via generic deployer
    from services.deployer import deploy_plugin_zip
    site = await get_site(site_id, user)
    result = await deploy_plugin_zip(site, zip_data, folder_name)

    if result.success:
        return {
            "status": "installed",
            "method": result.method,
            "message": result.message,
        }
    else:
        raise HTTPException(500, result.message)
