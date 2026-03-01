"""OP WordPress — Update management routes."""

import base64
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional

import config
from auth import get_current_user, AuthUser

log = logging.getLogger("opai-wordpress.updates")

router = APIRouter(prefix="/api")


def _sb_headers_service():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


async def _get_site(site_id: str, user: AuthUser) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        url = f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.get(url, headers=_sb_headers_service())
        sites = resp.json() if resp.status_code == 200 else []
        if not sites:
            raise HTTPException(404, "Site not found")
        return sites[0]


def _wp_auth_header(site: dict) -> dict:
    """Build WP REST API Basic Auth headers."""
    cred = base64.b64encode(
        f"{site['username']}:{site['app_password']}".encode()
    ).decode()
    return {"Authorization": f"Basic {cred}"}


def _wp_api(site: dict, path: str) -> str:
    base_url = site["url"].rstrip("/")
    api_base = site.get("api_base", "/wp-json")
    return f"{base_url}{api_base}{path}"


def _connector_headers(site: dict) -> dict:
    """Headers for connector API calls — Basic Auth only.

    X-OPAI-Key can go stale (setup regenerates), and the connector plugin
    rejects mismatched keys without falling through to Basic Auth.
    Basic Auth with app_password always works for admin users.
    """
    headers = _wp_auth_header(site)
    headers["Content-Type"] = "application/json"
    return headers


# ── Request Models ────────────────────────────────────────

class UpdatePlugins(BaseModel):
    plugins: List[str]  # Plugin slugs to update


class UpdateThemes(BaseModel):
    themes: List[str]  # Theme slugs to update


class BulkUpdate(BaseModel):
    site_ids: List[str]
    update_plugins: bool = True
    update_themes: bool = True


# ── Update Endpoints ──────────────────────────────────────

@router.get("/sites/{site_id}/updates")
async def get_updates(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Get available updates for a site."""
    site = await _get_site(site_id, user)

    from services.update_checker import get_cached_updates, check_site_updates
    cached = get_cached_updates(site_id)
    if cached:
        return cached

    # No cache — run a fresh check
    updates = await check_site_updates(site)
    return updates


@router.get("/updates/all-sites")
async def all_sites_updates(user: AuthUser = Depends(get_current_user)):
    """Aggregate updates across all connected sites."""
    async with httpx.AsyncClient(timeout=30) as client:
        url = f"{_sb_url('wp_sites')}?select=*"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.get(url, headers=_sb_headers_service())
        sites = resp.json() if resp.status_code == 200 else []

    from services.update_checker import get_cached_updates, check_site_updates

    # Collect per-site update data (use cache or fetch)
    site_updates = {}
    for site in sites:
        cached = get_cached_updates(site["id"])
        if cached:
            site_updates[site["id"]] = cached
        else:
            try:
                updates = await check_site_updates(site)
                site_updates[site["id"]] = updates
            except Exception:
                site_updates[site["id"]] = {"plugins": [], "themes": []}

    # Aggregate plugins by file path
    plugin_map = {}  # file -> {name, slug, new_version, sites: [...]}
    for site in sites:
        for p in site_updates.get(site["id"], {}).get("plugins", []):
            key = p.get("plugin", "")
            if key not in plugin_map:
                plugin_map[key] = {
                    "plugin": key,
                    "slug": p.get("slug", key.split("/")[0] if "/" in key else key),
                    "name": p.get("name", key),
                    "new_version": p.get("new_version", ""),
                    "sites": [],
                }
            plugin_map[key]["sites"].append({
                "site_id": site["id"],
                "site_name": site.get("name", ""),
                "current_version": p.get("version", ""),
            })

    # Aggregate themes by stylesheet
    theme_map = {}
    for site in sites:
        for t in site_updates.get(site["id"], {}).get("themes", []):
            key = t.get("stylesheet", "")
            if key not in theme_map:
                theme_map[key] = {
                    "stylesheet": key,
                    "name": t.get("name", key),
                    "new_version": t.get("new_version", ""),
                    "sites": [],
                }
            theme_map[key]["sites"].append({
                "site_id": site["id"],
                "site_name": site.get("name", ""),
                "current_version": t.get("version", ""),
            })

    # Aggregate core updates
    core_updates = []
    for site in sites:
        su = site_updates.get(site["id"], {})
        if su.get("core_update"):
            core_updates.append({
                "site_id": site["id"],
                "site_name": site.get("name", ""),
                "current_version": su.get("core_current", site.get("wp_version", "?")),
                "latest_version": su.get("core_latest", ""),
            })

    agg_plugins = list(plugin_map.values())
    agg_themes = list(theme_map.values())
    total_plugin_updates = sum(len(p["sites"]) for p in agg_plugins)
    total_theme_updates = sum(len(t["sites"]) for t in agg_themes)

    return {
        "sites": [
            {
                "id": s["id"],
                "name": s.get("name", ""),
                "url": s.get("url", ""),
                "status": s.get("status", "unknown"),
                "wp_version": s.get("wp_version", "?"),
                "plugins_updates": len(site_updates.get(s["id"], {}).get("plugins", [])),
                "themes_updates": len(site_updates.get(s["id"], {}).get("themes", [])),
                "core_update": site_updates.get(s["id"], {}).get("core_update", False),
            }
            for s in sites
        ],
        "aggregated_plugins": agg_plugins,
        "aggregated_themes": agg_themes,
        "core_updates": core_updates,
        "total_plugins": total_plugin_updates,
        "total_themes": total_theme_updates,
        "total_core": len(core_updates),
        "total_updates": total_plugin_updates + total_theme_updates + len(core_updates),
    }


@router.post("/sites/{site_id}/updates/plugins")
async def update_plugins(site_id: str, body: UpdatePlugins,
                         user: AuthUser = Depends(get_current_user)):
    """Update specific plugins on a site via OPAI Connector."""
    site = await _get_site(site_id, user)

    if not site.get("connector_installed"):
        return {
            "status": "connector_required",
            "message": "OPAI Connector not installed. Install it first to apply updates.",
            "results": [],
        }

    from services.scheduler import _create_log, _update_log
    log_id = await _create_log(None, site_id, "update_plugins", trigger="manual")

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            _wp_api(site, "/opai/v1/updates/apply"),
            headers=_connector_headers(site),
            json={"type": "plugins", "items": body.plugins},
        )

        if resp.status_code == 200:
            data = resp.json()
            # Refresh update cache after applying
            from services.update_checker import check_site_updates, update_site_record
            try:
                updates = await check_site_updates(site)
                await update_site_record(site_id, updates)
            except Exception:
                pass
            if log_id:
                await _update_log(log_id, "success", [{"name": "update_plugins", "status": "pass", "detail": {"plugins": body.plugins, "results": data.get("results", [])}}])
            return data
        else:
            log.error("Connector update failed: %s %s", resp.status_code, resp.text[:300])
            if log_id:
                await _update_log(log_id, "failed", [{"name": "update_plugins", "status": "fail", "detail": resp.text[:300]}])
            raise HTTPException(resp.status_code, f"Connector error: {resp.text[:300]}")


@router.post("/sites/{site_id}/updates/themes")
async def update_themes(site_id: str, body: UpdateThemes,
                        user: AuthUser = Depends(get_current_user)):
    """Update specific themes on a site via OPAI Connector."""
    site = await _get_site(site_id, user)

    if not site.get("connector_installed"):
        return {
            "status": "connector_required",
            "message": "OPAI Connector not installed. Install it first to apply updates.",
            "results": [],
        }

    from services.scheduler import _create_log, _update_log
    log_id = await _create_log(None, site_id, "update_themes", trigger="manual")

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            _wp_api(site, "/opai/v1/updates/apply"),
            headers=_connector_headers(site),
            json={"type": "themes", "items": body.themes},
        )

        if resp.status_code == 200:
            from services.update_checker import check_site_updates, update_site_record
            try:
                updates = await check_site_updates(site)
                await update_site_record(site_id, updates)
            except Exception:
                pass
            data = resp.json()
            if log_id:
                await _update_log(log_id, "success", [{"name": "update_themes", "status": "pass", "detail": {"themes": body.themes, "results": data.get("results", [])}}])
            return data
        else:
            if log_id:
                await _update_log(log_id, "failed", [{"name": "update_themes", "status": "fail", "detail": resp.text[:300]}])
            raise HTTPException(resp.status_code, f"Connector error: {resp.text[:300]}")


@router.post("/sites/{site_id}/updates/all")
async def update_all(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Trigger update of all available plugins, themes, and core."""
    site = await _get_site(site_id, user)

    if not site.get("connector_installed"):
        return {
            "status": "connector_required",
            "message": "OPAI Connector not installed. Install it first to apply updates.",
        }

    from services.scheduler import _create_log, _update_log
    log_id = await _create_log(None, site_id, "update_all", trigger="manual")

    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(
            _wp_api(site, "/opai/v1/updates/apply"),
            headers=_connector_headers(site),
            json={"type": "all"},
        )

        if resp.status_code == 200:
            from services.update_checker import check_site_updates, update_site_record
            try:
                updates = await check_site_updates(site)
                await update_site_record(site_id, updates)
            except Exception:
                pass
            data = resp.json()
            if log_id:
                await _update_log(log_id, "success", [{"name": "update_all", "status": "pass", "detail": data}])
            return data
        else:
            if log_id:
                await _update_log(log_id, "failed", [{"name": "update_all", "status": "fail", "detail": resp.text[:300]}])
            raise HTTPException(resp.status_code, f"Connector error: {resp.text[:300]}")


@router.post("/bulk/updates")
async def bulk_updates(body: BulkUpdate, user: AuthUser = Depends(get_current_user)):
    """Bulk update across multiple sites."""
    results = []
    for site_id in body.site_ids:
        try:
            site = await _get_site(site_id, user)
            from services.update_checker import check_site_updates
            updates = await check_site_updates(site)
            results.append({
                "site_id": site_id,
                "name": site.get("name"),
                "plugins_updates": updates.get("plugins_count", 0),
                "themes_updates": updates.get("themes_count", 0),
                "status": "checked",
            })
        except Exception as e:
            results.append({
                "site_id": site_id,
                "status": "error",
                "error": str(e),
            })

    return {"results": results}


@router.post("/sites/{site_id}/updates/check")
async def force_check(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Force an update check on a site."""
    site = await _get_site(site_id, user)

    from services.update_checker import check_site_updates, update_site_record
    updates = await check_site_updates(site)
    await update_site_record(site_id, updates)

    return updates
