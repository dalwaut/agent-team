"""Background update scanner — checks WP sites for available updates.

Uses a multi-strategy approach with per-site method pinning:
  1. OPAI Connector with forced refresh (most accurate)
  2. OPAI Connector with cached transients (avoids PHP fatals)
  3. WP REST API fallback (reads stale transients — least accurate)

The working method is pinned in the `capabilities.data_method` JSONB field
on the `wp_sites` table. On subsequent checks, the pinned method is tried
first. If it fails, the pin is cleared and the full chain is retried.
"""

import asyncio
import base64
import logging
import time
from typing import Optional

import httpx

import config

log = logging.getLogger("opai-wordpress.update-checker")

# In-memory cache of update info per site
_update_cache: dict[str, dict] = {}
CACHE_TTL = 300  # 5 minutes


def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


def _wp_auth_header(site: dict) -> dict:
    """Build WP REST API auth headers with Basic Auth."""
    cred = base64.b64encode(
        f"{site['username']}:{site['app_password']}".encode()
    ).decode()
    return {"Authorization": f"Basic {cred}"}


def _wp_api(site: dict, path: str) -> str:
    """Build full WP REST API URL."""
    base = site["url"].rstrip("/")
    api_base = site.get("api_base", "/wp-json")
    return f"{base}{api_base}{path}"


async def _update_capabilities(site_id: str, caps: dict):
    """Merge new capabilities into the site's capabilities JSONB."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=capabilities",
            headers=_sb_headers(),
        )
        current = {}
        if resp.status_code == 200:
            rows = resp.json()
            if rows:
                current = rows[0].get("capabilities") or {}

        current.update(caps)
        await client.patch(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}",
            headers=_sb_headers(),
            json={"capabilities": current},
        )


# ── Strategy: Connector with refresh ─────────────────────────────

async def _try_connector_refresh(client: httpx.AsyncClient, site: dict, updates: dict) -> bool:
    """Call /opai/v1/updates/check with forced refresh. Returns True on success."""
    if not site.get("connector_installed"):
        return False

    headers = _wp_auth_header(site)
    url = _wp_api(site, "/opai/v1/updates/check")
    log.info("Checking updates via connector+refresh for %s: %s", site.get("name"), url)

    try:
        resp = await client.get(url, headers=headers)
        log.info("Connector+refresh response for %s: status=%d, content_type=%s",
                 site.get("name"), resp.status_code,
                 resp.headers.get("content-type", "?"))

        if resp.status_code == 200:
            content_type = resp.headers.get("content-type", "")
            if "text/html" in content_type or resp.text.strip().startswith("<"):
                log.warning("Connector+refresh returned HTML for %s — likely PHP fatal during refresh",
                            site.get("name"))
                return False
            try:
                data = resp.json()
            except Exception:
                log.error("Invalid JSON from connector+refresh for %s", site.get("name"))
                return False

            _map_connector_response(data, updates, site)
            return True

        if resp.status_code in (401, 403):
            log.error("Connector auth failed for %s (HTTP %d)", site.get("name"), resp.status_code)
        elif resp.status_code == 500:
            log.warning("Connector 500 on refresh for %s", site.get("name"))
        else:
            log.warning("Connector+refresh returned %d for %s", resp.status_code, site.get("name"))

    except httpx.ConnectError as e:
        log.error("Cannot connect to %s connector: %s", site.get("name"), e)
    except httpx.TimeoutException as e:
        log.error("Timeout connecting to %s connector: %s", site.get("name"), e)
    except Exception as e:
        log.warning("Connector+refresh failed for %s: %s", site.get("name"), e)

    return False


# ── Strategy: Connector cached (no refresh) ──────────────────────

async def _try_connector_cached(client: httpx.AsyncClient, site: dict, updates: dict) -> bool:
    """Call /opai/v1/updates/check?refresh=0. Returns True on success."""
    if not site.get("connector_installed"):
        return False

    headers = _wp_auth_header(site)
    url = _wp_api(site, "/opai/v1/updates/check") + "?refresh=0"
    log.info("Checking updates via connector+cached for %s: %s", site.get("name"), url)

    try:
        resp = await client.get(url, headers=headers)

        if resp.status_code == 200:
            content_type = resp.headers.get("content-type", "")
            if "text/html" in content_type or resp.text.strip().startswith("<"):
                log.warning("Connector+cached returned HTML for %s", site.get("name"))
                return False
            try:
                data = resp.json()
            except Exception:
                log.error("Invalid JSON from connector+cached for %s", site.get("name"))
                return False

            _map_connector_response(data, updates, site)
            return True

        log.warning("Connector+cached returned %d for %s", resp.status_code, site.get("name"))

    except Exception as e:
        log.warning("Connector+cached failed for %s: %s", site.get("name"), e)

    return False


# ── Strategy: WP REST API fallback ───────────────────────────────

async def _try_rest_api(client: httpx.AsyncClient, site: dict, updates: dict) -> bool:
    """Read plugins/themes via WP REST API. Returns True if we got any data."""
    log.info("Using WP REST API fallback for %s", site.get("name"))
    headers = _wp_auth_header(site)
    got_data = False

    # Plugins
    try:
        resp = await client.get(
            _wp_api(site, "/wp/v2/plugins?context=edit&per_page=100"),
            headers=headers,
        )
        if resp.status_code == 200:
            for plugin in resp.json():
                if isinstance(plugin, dict) and plugin.get("update"):
                    updates["plugins"].append({
                        "plugin": plugin.get("plugin", ""),
                        "name": plugin.get("name", ""),
                        "version": plugin.get("version", ""),
                        "new_version": plugin["update"].get("version", ""),
                    })
            log.info("REST API plugin check for %s: %d updates found",
                     site.get("name"), len(updates["plugins"]))
            got_data = True
        else:
            log.warning("REST API plugins returned %d for %s",
                        resp.status_code, site.get("name"))
    except Exception as e:
        log.warning("Plugin update check failed for %s: %s", site.get("name"), e)

    # Themes
    try:
        resp = await client.get(
            _wp_api(site, "/wp/v2/themes?context=edit&per_page=100"),
            headers=headers,
        )
        if resp.status_code == 200:
            for theme in resp.json():
                if isinstance(theme, dict) and theme.get("update"):
                    name = theme.get("name", {})
                    if isinstance(name, dict):
                        name = name.get("raw", "")
                    updates["themes"].append({
                        "stylesheet": theme.get("stylesheet", ""),
                        "name": name,
                        "version": theme.get("version", ""),
                        "new_version": theme["update"].get("version", ""),
                    })
            log.info("REST API theme check for %s: %d updates found",
                     site.get("name"), len(updates["themes"]))
            got_data = True
        else:
            log.warning("REST API themes returned %d for %s",
                        resp.status_code, site.get("name"))
    except Exception as e:
        log.warning("Theme update check failed for %s: %s", site.get("name"), e)

    # Core version check
    try:
        current_wp_version = site.get("wp_version", "")
        resp = await client.get(
            "https://api.wordpress.org/core/version-check/1.7/",
            timeout=10,
        )
        if resp.status_code == 200:
            wp_data = resp.json()
            offers = wp_data.get("offers", [])
            if offers:
                latest = offers[0].get("version", "")
                if latest and current_wp_version and latest != current_wp_version:
                    updates["core_update"] = True
                    updates["core_current"] = current_wp_version
                    updates["core_latest"] = latest
    except Exception as e:
        log.warning("Core update check failed for %s: %s", site.get("name"), e)

    return got_data


# ── Shared response mapper ───────────────────────────────────────

def _map_connector_response(data: dict, updates: dict, site: dict):
    """Map connector JSON response into our standard updates dict."""
    if data.get("refresh_warnings"):
        log.warning("Connector refresh warnings for %s: %s",
                     site.get("name"), data["refresh_warnings"])

    for p in data.get("plugins", []):
        updates["plugins"].append({
            "plugin": p.get("file", ""),
            "slug": p.get("slug", ""),
            "name": p.get("name", ""),
            "version": p.get("version", ""),
            "new_version": p.get("new_version", ""),
        })

    for t in data.get("themes", []):
        updates["themes"].append({
            "stylesheet": t.get("slug", ""),
            "name": t.get("name", ""),
            "version": t.get("version", ""),
            "new_version": t.get("new_version", ""),
        })

    core = data.get("core", {})
    if core.get("available"):
        updates["core_update"] = True
        updates["core_current"] = core.get("current", site.get("wp_version", ""))
        updates["core_latest"] = core.get("new_version", "")

    # Auto-populate wp_version from core data
    if core.get("current") and not site.get("wp_version"):
        updates["_wp_version"] = core["current"]

    log.info("Connector update check for %s: %d plugins, %d themes, core=%s",
             site.get("name"), len(updates["plugins"]),
             len(updates["themes"]), updates["core_update"])


# ── Main check function ──────────────────────────────────────────

async def check_site_updates(site: dict) -> dict:
    """Check a single site for available updates using the strategy chain.

    Strategy chain (pinned method tried first):
      1. connector+refresh — forces WP to refresh transients
      2. connector+cached  — reads existing transients (avoids PHP fatals)
      3. REST API fallback  — /wp/v2/plugins + /wp/v2/themes (stale transients)
    """
    updates = {"plugins": [], "themes": [], "core_update": False}

    caps = site.get("capabilities") or {}
    pinned = caps.get("data_method")

    # Strategy lookup: name -> (function, needs_connector)
    strategies = [
        ("connector_refresh", _try_connector_refresh),
        ("connector_cached", _try_connector_cached),
        ("rest_api", _try_rest_api),
    ]
    strategy_map = {name: fn for name, fn in strategies}

    success_method = None

    async with httpx.AsyncClient(timeout=60) as client:

        # Try pinned method first
        if pinned and pinned in strategy_map:
            log.info("Trying pinned data method '%s' for %s", pinned, site.get("name"))
            if await strategy_map[pinned](client, site, updates):
                success_method = pinned
            else:
                log.info("Pinned method '%s' failed for %s — trying full chain",
                         pinned, site.get("name"))
                await _update_capabilities(site["id"], {"data_method": None})

        # If pinned to rest_api but it found 0 plugin+theme updates and the
        # site has the connector, the REST API transients are likely stale.
        # Clear the pin and retry the connector chain for better data.
        if (
            success_method == "rest_api"
            and site.get("connector_installed")
            and not updates["plugins"]
            and not updates["themes"]
        ):
            log.info("REST API returned 0 updates for %s but connector is installed — retrying connector",
                     site.get("name"))
            success_method = None
            updates = {"plugins": [], "themes": [], "core_update": updates.get("core_update", False)}
            await _update_capabilities(site["id"], {"data_method": None})

        # Try full chain if pinned didn't work
        if not success_method:
            for method_name, strategy_fn in strategies:
                if await strategy_fn(client, site, updates):
                    success_method = method_name
                    break

    # Pin successful method
    if success_method and success_method != pinned:
        await _update_capabilities(site["id"], {"data_method": success_method})

    updates["plugins_count"] = len(updates["plugins"])
    updates["themes_count"] = len(updates["themes"])
    updates["_data_method"] = success_method

    _update_cache[site["id"]] = {
        "data": updates,
        "checked_at": time.time(),
    }

    return updates


async def update_site_record(site_id: str, updates: dict):
    """Update the wp_sites table with update counts."""
    patch = {
        "plugins_updates": updates.get("plugins_count", 0),
        "themes_updates": updates.get("themes_count", 0),
        "core_update": updates.get("core_update", False),
        "last_check": "now()",
    }
    # Auto-populate wp_version if the connector gave us one
    if updates.get("_wp_version"):
        patch["wp_version"] = updates["_wp_version"]

    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{_sb_url('wp_sites')}?id=eq.{site_id}",
            headers=_sb_headers(),
            json=patch,
        )


async def check_all_sites():
    """Check all connected sites for updates."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_sites')}?select=*",
            headers=_sb_headers(),
        )
        if resp.status_code != 200:
            log.error("Failed to fetch sites: %s", resp.text)
            return

        sites = resp.json()

    for site in sites:
        try:
            updates = await check_site_updates(site)
            await update_site_record(site["id"], updates)
            log.info("Checked updates for %s: %d plugins, %d themes (method: %s)",
                     site.get("name"), updates["plugins_count"],
                     updates["themes_count"], updates.get("_data_method", "?"))
        except Exception as e:
            log.error("Update check failed for %s: %s", site.get("name"), e)


def get_cached_updates(site_id: str) -> Optional[dict]:
    """Get cached update info for a site (expires after CACHE_TTL seconds)."""
    entry = _update_cache.get(site_id)
    if entry and (time.time() - entry["checked_at"]) < CACHE_TTL:
        return entry["data"]
    return None


async def background_checker():
    """Background loop that checks all sites periodically."""
    while True:
        try:
            await check_all_sites()
        except Exception as e:
            log.error("Background update check failed: %s", e)
        await asyncio.sleep(config.UPDATE_CHECK_INTERVAL)
