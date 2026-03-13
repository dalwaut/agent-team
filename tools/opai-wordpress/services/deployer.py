"""Multi-strategy connector deployment engine.

Tries multiple methods to deploy the OPAI Connector plugin, pins the
working method per-site in the `capabilities` JSONB column, and presents
a uniform interface regardless of host limitations.

Strategy chain (tried in order, pinned on success):
  0. Self-Update — POST ZIP to connector's own /connector/self-update endpoint
  1. REST API   — deactivate old, delete, upload via admin form, activate, setup
  2. Admin Upload — wp-admin login, nonce, POST ZIP, activate, setup
  3. File Manager — use WP File Manager plugin's AJAX API to upload
  4. Manual      — return download URL + instructions
"""

import io
import logging
import re
import zipfile
from dataclasses import dataclass, field
from typing import Optional

import httpx

import config

log = logging.getLogger("opai-wordpress.deployer")

# Must match Version in opai-connector.php
OPAI_CONNECTOR_VERSION_STR = "1.6.0"


@dataclass
class DeployResult:
    success: bool
    method: str  # "self_update", "rest_api", "admin_upload", "file_manager", "manual"
    message: str
    connector_key: Optional[str] = None
    download_url: Optional[str] = None
    details: dict = field(default_factory=dict)


def _wp_auth_header(site: dict) -> dict:
    import base64
    cred = base64.b64encode(
        f"{site['username']}:{site['app_password']}".encode()
    ).decode()
    return {"Authorization": f"Basic {cred}"}


def _wp_api(site: dict, path: str) -> str:
    base = site["url"].rstrip("/")
    api_base = site.get("api_base", "/wp-json")
    return f"{base}{api_base}{path}"


def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


def _build_connector_zip() -> bytes:
    plugin_dir = config.TOOL_DIR / "wp-plugin" / "opai-connector"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in plugin_dir.rglob("*"):
            if file_path.is_file() and "__pycache__" not in str(file_path):
                arcname = "opai-connector/" + str(file_path.relative_to(plugin_dir))
                zf.write(file_path, arcname)
    return buf.getvalue()


async def _update_capabilities(site_id: str, caps: dict):
    """Merge new capabilities into the site's capabilities JSONB."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Read current capabilities
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
            json={"capabilities": current, "updated_at": "now()"},
        )


async def _check_existing_plugin(client: httpx.AsyncClient, site: dict) -> Optional[str]:
    """Check if opai-connector is already installed. Returns plugin file path or None."""
    headers = _wp_auth_header(site)
    resp = await client.get(
        _wp_api(site, "/wp/v2/plugins?context=edit&per_page=100"),
        headers=headers,
    )
    if resp.status_code == 200:
        for p in resp.json():
            if "opai-connector" in p.get("plugin", ""):
                return p["plugin"]
    return None


async def _activate_plugin(client: httpx.AsyncClient, site: dict, plugin_file: str) -> bool:
    """Activate a plugin via REST API. Returns True on success."""
    headers = _wp_auth_header(site)
    resp = await client.put(
        _wp_api(site, f"/wp/v2/plugins/{plugin_file}"),
        headers={**headers, "Content-Type": "application/json"},
        json={"status": "active"},
    )
    if resp.status_code in (200, 201):
        log.info("Activated plugin %s", plugin_file)
        return True
    log.warning("Activation failed (%d): %s", resp.status_code, resp.text[:300])
    return False


async def _call_setup(client: httpx.AsyncClient, site: dict) -> Optional[str]:
    """Call /opai/v1/setup to get connector key. Returns key or None."""
    headers = _wp_auth_header(site)
    resp = await client.post(
        _wp_api(site, "/opai/v1/setup"),
        headers={**headers, "Content-Type": "application/json"},
    )
    if resp.status_code == 200:
        data = resp.json()
        key = data.get("connector_key")
        log.info("Connector setup complete, key obtained")
        return key
    log.error("Setup failed (%d): %s", resp.status_code, resp.text[:300])
    return None


async def _finalize_install(site: dict, method: str, connector_key: Optional[str]):
    """Update Supabase with install success and pin deploy method."""
    update_data = {
        "connector_installed": True,
        "updated_at": "now()",
    }
    if connector_key:
        update_data["connector_secret"] = connector_key

    async with httpx.AsyncClient(timeout=15) as client:
        await client.patch(
            f"{_sb_url('wp_sites')}?id=eq.{site['id']}",
            headers=_sb_headers(),
            json=update_data,
        )

    await _update_capabilities(site["id"], {
        "deploy_method": method,
        "last_failure_log": None,
    })


# ── Strategy 1: REST API (check + activate existing) ─────────────

async def _try_rest_api_deploy(client: httpx.AsyncClient, site: dict) -> Optional[DeployResult]:
    """If plugin already exists (uploaded manually or previously), just activate + setup."""
    plugin_file = await _check_existing_plugin(client, site)
    if not plugin_file:
        return None

    log.info("Plugin already installed as %s — activating", plugin_file)
    activated = await _activate_plugin(client, site, plugin_file)
    if not activated:
        return None

    key = await _call_setup(client, site)
    await _finalize_install(site, "rest_api", key)
    return DeployResult(
        success=True,
        method="rest_api",
        message="Connector was already installed — activated and configured.",
        connector_key=key,
    )


# ── Strategy 2: Admin Upload ─────────────────────────────────────

async def _detect_canonical_base(client: httpx.AsyncClient, base: str) -> str:
    """Detect canonical WP base URL by checking wp-admin redirect.

    WordPress redirects wp-admin to the canonical siteurl. If the stored URL
    uses www but WP's siteurl is non-www (or vice versa), the cookies from
    login won't carry over.  Detect this and return the canonical base.
    """
    from urllib.parse import urlparse
    try:
        # Use a fresh client that does NOT follow redirects to see where wp-admin points
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as probe:
            resp = await probe.get(f"{base}/wp-admin/")
            if resp.status_code in (301, 302):
                location = resp.headers.get("location", "")
                parsed = urlparse(location)
                if parsed.scheme and parsed.netloc:
                    canonical = f"{parsed.scheme}://{parsed.netloc}"
                    if canonical.rstrip("/") != base.rstrip("/"):
                        log.info("Canonical URL detected: %s → %s", base, canonical)
                        return canonical.rstrip("/")
    except Exception as e:
        log.debug("Canonical detection failed: %s", e)
    return base


async def _try_admin_upload(client: httpx.AsyncClient, site: dict) -> Optional[DeployResult]:
    """Login to wp-admin, upload ZIP via plugin-install.php."""
    admin_pwd = site.get("admin_password")
    if not admin_pwd:
        log.info("No admin_password — skipping admin upload strategy")
        return None

    base = site["url"].rstrip("/")
    rest_headers = _wp_auth_header(site)
    zip_data = _build_connector_zip()
    log.info("Built connector ZIP: %d bytes", len(zip_data))

    try:
        # Detect canonical URL (handles www/non-www mismatch)
        canonical_base = await _detect_canonical_base(client, base)

        # Login to wp-admin (use canonical URL for cookie domain alignment)
        await client.get(f"{canonical_base}/wp-login.php")
        login_resp = await client.post(
            f"{canonical_base}/wp-login.php",
            data={
                "log": site["username"],
                "pwd": admin_pwd,
                "wp-submit": "Log In",
                "redirect_to": f"{canonical_base}/wp-admin/",
                "testcookie": "1",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

        cookie_names = list(client.cookies.keys())
        has_auth = any("wordpress_logged_in" in c for c in cookie_names)
        log.info("Admin login: cookies=%s, has_auth=%s, canonical=%s", cookie_names, has_auth, canonical_base)

        if not has_auth:
            await _update_capabilities(site["id"], {
                "admin_accessible": False,
                "last_failure_log": "Admin login failed — no auth cookies",
            })
            return None

        # Use canonical_base for all subsequent wp-admin operations
        base = canonical_base

        # GET upload page for nonce
        page_resp = await client.get(f"{base}/wp-admin/plugin-install.php?tab=upload")
        if page_resp.status_code in (508, 503, 502):
            log.warning("Admin page returned %d — host may limit admin access", page_resp.status_code)
            await _update_capabilities(site["id"], {
                "admin_accessible": False,
                "last_failure_log": f"Admin page HTTP {page_resp.status_code}",
            })
            return None
        if page_resp.status_code != 200 or "wp-login" in str(page_resp.url):
            await _update_capabilities(site["id"], {
                "admin_accessible": False,
                "last_failure_log": "Plugin upload page inaccessible",
            })
            return None

        nonce_match = re.search(r'name="_wpnonce"\s+value="([^"]+)"', page_resp.text)
        if not nonce_match:
            nonce_match = re.search(r'id="_wpnonce"\s+value="([^"]+)"', page_resp.text)
        if not nonce_match:
            return None

        nonce = nonce_match.group(1)
        log.info("Got WP upload nonce: %s...", nonce[:8])

        # Try upload_url candidates — some hosts block update.php POST from external IPs.
        upload_urls = [
            f"{base}/wp-admin/update.php?action=upload-plugin",
            f"{base}/wp-admin/plugin-install.php?action=upload-plugin",
        ]

        upload_resp = None
        used_upload_url = None
        async with httpx.AsyncClient(
            timeout=60, follow_redirects=False, cookies=client.cookies,
        ) as upload_client:
            for url_candidate in upload_urls:
                resp_try = await upload_client.post(
                    url_candidate,
                    data={"_wpnonce": nonce, "install-plugin-submit": "Install Now"},
                    files={"pluginzip": ("opai-connector.zip", zip_data, "application/zip")},
                    headers={"Referer": f"{base}/wp-admin/plugin-install.php?tab=upload"},
                )
                log.info("Upload attempt %s: status=%d", url_candidate, resp_try.status_code)
                if resp_try.status_code not in (404, 403, 405):
                    upload_resp = resp_try
                    used_upload_url = url_candidate
                    break

        if upload_resp is None:
            await _update_capabilities(site["id"], {
                "admin_accessible": False,
                "last_failure_log": "All upload URLs returned 404/403 — host may block remote plugin uploads",
            })
            return None

        if upload_resp.status_code in (508, 503, 502):
            await _update_capabilities(site["id"], {
                "admin_accessible": False,
                "last_failure_log": f"Upload returned HTTP {upload_resp.status_code}",
            })
            return None

        # Resolve the response HTML (may be a 200, 301, or 302)
        if upload_resp.status_code in (301, 302):
            location = upload_resp.headers.get("location", "")
            if "wp-login" in location:
                return None
            result_resp = await client.get(location)
            result_html = result_resp.text
        elif upload_resp.status_code == 200:
            result_html = upload_resp.text
        else:
            return None

        result_html_lower = result_html.lower()

        if "fatal error" in result_html_lower or "not permitted" in result_html_lower:
            await _update_capabilities(site["id"], {
                "admin_accessible": False,
                "last_failure_log": "Plugin install returned fatal error",
            })
            return None

        # ── Handle WP "plugin already installed — replace?" confirmation ─────
        # WP 6.9+ shows an <a> link for overwrite; older WP uses a POST form.
        if "overwrite" in result_html_lower or "already installed" in result_html_lower:
            log.info("Got WP overwrite confirmation page for %s — extracting overwrite action", site.get("name"))

            # Strategy A: Extract the overwrite <a> href (WP 6.9+)
            # e.g. href="update.php?action=upload-plugin&package=4721&overwrite=update-plugin&_wpnonce=abc123"
            overwrite_link = re.search(
                r'href=["\']([^"\']*action=upload-plugin[^"\']*overwrite=update-plugin[^"\']*)["\']',
                result_html,
            )
            if not overwrite_link:
                # Also try &amp; encoded version
                overwrite_link = re.search(
                    r'href=["\']([^"\']*overwrite[^"\']+update-plugin[^"\']*)["\']',
                    result_html,
                )

            if overwrite_link:
                # WP 6.9 style: follow the overwrite link via GET
                ow_url = overwrite_link.group(1).replace("&amp;", "&")
                if not ow_url.startswith("http"):
                    ow_url = f"{base}/wp-admin/{ow_url}"
                log.info("Following overwrite link: %s", ow_url[:80])

                async with httpx.AsyncClient(
                    timeout=60, follow_redirects=True, cookies=client.cookies,
                ) as ow_client:
                    ow_resp = await ow_client.get(
                        ow_url,
                        headers={"Referer": f"{base}/wp-admin/update.php"},
                    )
                    log.info("Overwrite GET: status=%d", ow_resp.status_code)
            else:
                # Strategy B: Legacy form POST (older WP)
                pkg_match = re.search(r'name=["\']package["\'][^>]*value=["\']([^"\']+)["\']', result_html)
                if not pkg_match:
                    pkg_match = re.search(r'value=["\']([^"\']*tmp[^"\']+\.zip)["\']', result_html)

                overwrite_nonce_match = re.search(r'name=["\']_wpnonce["\'][^>]*value=["\']([^"\']+)["\']', result_html)
                if not overwrite_nonce_match:
                    overwrite_nonce_match = re.search(r'_wpnonce=([a-f0-9]+)', result_html)

                package_path = pkg_match.group(1) if pkg_match else ""
                overwrite_nonce = overwrite_nonce_match.group(1) if overwrite_nonce_match else nonce

                log.info("Submitting overwrite POST: package=%s, nonce=%s...", package_path[:40] if package_path else "N/A", overwrite_nonce[:8])

                async with httpx.AsyncClient(
                    timeout=60, follow_redirects=True, cookies=client.cookies,
                ) as ow_client:
                    ow_data = {
                        "_wpnonce": overwrite_nonce,
                        "action": "upload-plugin",
                        "overwrite": "update-plugin",
                        "upgrade": "update-plugin",
                    }
                    if package_path:
                        ow_data["package"] = package_path

                    ow_resp = await ow_client.post(
                        used_upload_url or f"{base}/wp-admin/update.php?action=upload-plugin",
                        data=ow_data,
                        headers={"Referer": f"{base}/wp-admin/update.php"},
                    )
                    log.info("Overwrite POST: status=%d", ow_resp.status_code)

        # Verify plugin exists via REST API (use fresh client without wp-admin
        # cookies — cookie-based auth conflicts with Basic Auth on some hosts)
        async with httpx.AsyncClient(timeout=30) as rest_client:
            plugin_file = await _check_existing_plugin(rest_client, site)
            if not plugin_file:
                log.error("Plugin not found after upload")
                return None

            # Activate
            if not await _activate_plugin(rest_client, site, plugin_file):
                return None

            # Setup
            key = await _call_setup(rest_client, site)
        await _update_capabilities(site["id"], {"admin_accessible": True})
        await _finalize_install(site, "admin_upload", key)

        return DeployResult(
            success=True,
            method="admin_upload",
            message="Connector installed via wp-admin upload.",
            connector_key=key,
        )

    except httpx.TimeoutException:
        log.warning("Admin upload timed out for %s", site.get("name"))
        return None
    except Exception as e:
        log.warning("Admin upload failed for %s: %s", site.get("name"), e)
        return None


# ── Strategy 3: File Manager Plugin ──────────────────────────────

async def _try_file_manager_deploy(client: httpx.AsyncClient, site: dict) -> Optional[DeployResult]:
    """Use WP File Manager plugin's elFinder AJAX API to upload the connector."""
    rest_headers = _wp_auth_header(site)

    # Check if File Manager is installed
    resp = await client.get(
        _wp_api(site, "/wp/v2/plugins?context=edit&per_page=100"),
        headers=rest_headers,
    )
    if resp.status_code != 200:
        return None

    has_file_manager = False
    fm_active = False
    for p in resp.json():
        plugin_path = p.get("plugin", "").lower()
        if "file-manager" in plugin_path or "filemanager" in plugin_path:
            has_file_manager = True
            fm_active = p.get("status") == "active"
            break

    if not has_file_manager:
        await _update_capabilities(site["id"], {"has_file_manager": False})
        return None

    await _update_capabilities(site["id"], {"has_file_manager": True})

    if not fm_active:
        log.info("File Manager found but not active — skipping")
        return None

    admin_pwd = site.get("admin_password")
    if not admin_pwd:
        log.info("No admin_password — cannot use File Manager AJAX")
        return None

    base = site["url"].rstrip("/")

    try:
        # Detect canonical URL (handles www/non-www mismatch)
        canonical_base = await _detect_canonical_base(client, base)

        # Login if not already
        cookie_names = list(client.cookies.keys())
        has_auth = any("wordpress_logged_in" in c for c in cookie_names)
        if not has_auth:
            await client.get(f"{canonical_base}/wp-login.php")
            await client.post(
                f"{canonical_base}/wp-login.php",
                data={
                    "log": site["username"],
                    "pwd": admin_pwd,
                    "wp-submit": "Log In",
                    "redirect_to": f"{canonical_base}/wp-admin/",
                    "testcookie": "1",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            cookie_names = list(client.cookies.keys())
            has_auth = any("wordpress_logged_in" in c for c in cookie_names)
            if not has_auth:
                return None

        # Use canonical_base for wp-admin operations
        base = canonical_base

        # Get File Manager page to extract nonce/security token
        fm_page = await client.get(f"{base}/wp-admin/admin.php?page=wp_file_manager")
        if fm_page.status_code != 200:
            return None

        # Extract security nonce for elFinder
        nonce_match = re.search(r'"nonce"\s*:\s*"([^"]+)"', fm_page.text)
        if not nonce_match:
            nonce_match = re.search(r'security\s*[=:]\s*["\']([a-f0-9]+)["\']', fm_page.text)
        if not nonce_match:
            log.warning("Could not extract File Manager nonce")
            return None

        fm_nonce = nonce_match.group(1)

        # Determine plugin directory path (usually wp-content/plugins/)
        zip_data = _build_connector_zip()

        # Upload ZIP via elFinder AJAX (mk + upload)
        upload_resp = await client.post(
            f"{base}/wp-admin/admin-ajax.php",
            data={
                "action": "connector",  # WP File Manager AJAX action
                "cmd": "upload",
                "target": "l1_d3AtY29udGVudC9wbHVnaW5z",  # base64 of "wp-content/plugins" for elFinder
                "security": fm_nonce,
            },
            files={"upload[]": ("opai-connector.zip", zip_data, "application/zip")},
            timeout=60,
        )

        if upload_resp.status_code != 200:
            log.warning("File Manager upload returned %d", upload_resp.status_code)
            return None

        upload_data = upload_resp.json()
        if upload_data.get("error"):
            log.warning("File Manager upload error: %s", upload_data["error"])
            return None

        # Extract ZIP via elFinder
        extract_resp = await client.post(
            f"{base}/wp-admin/admin-ajax.php",
            data={
                "action": "connector",
                "cmd": "extract",
                "target": "l1_d3AtY29udGVudC9wbHVnaW5zL29wYWktY29ubmVjdG9yLnppcA",  # uploaded zip
                "security": fm_nonce,
            },
            timeout=60,
        )

        if extract_resp.status_code != 200:
            log.warning("File Manager extract returned %d", extract_resp.status_code)
            # Even if extract fails, the zip itself might auto-extract or we can
            # still try to activate via REST

        # Try to activate via REST API
        plugin_file = await _check_existing_plugin(client, site)
        if not plugin_file:
            log.warning("Plugin not found after File Manager upload")
            return None

        if not await _activate_plugin(client, site, plugin_file):
            return None

        key = await _call_setup(client, site)
        await _finalize_install(site, "file_manager", key)

        return DeployResult(
            success=True,
            method="file_manager",
            message="Connector installed via WP File Manager.",
            connector_key=key,
        )

    except Exception as e:
        log.warning("File Manager deploy failed for %s: %s", site.get("name"), e)
        return None


# ── Strategy 4: Manual Fallback ──────────────────────────────────

def _manual_fallback(site: dict) -> DeployResult:
    return DeployResult(
        success=False,
        method="manual",
        message=(
            "Automatic installation could not be completed. "
            "Download the plugin ZIP and install manually via WP Admin > Plugins > Add New > Upload."
        ),
        download_url="/wordpress/api/connector/download",
    )


# ── Push-update strategies (force fresh ZIP upload) ──────────────

async def _push_via_rest_api(client: httpx.AsyncClient, site: dict) -> Optional[DeployResult]:
    """Push update for sites whose only working channel is the REST API.

    WP's REST API has no ZIP-upload endpoint for plugins (POST /wp/v2/plugins
    installs from wp.org by slug — unusable here).  The only safe REST-only
    approach is to delete the existing plugin and let the caller fall back to
    admin_upload or file_manager for the actual file transfer.  If neither
    of those are available, this path is not viable and we return None to
    trigger a manual fallback.

    NOTE: This function intentionally returns None so push_update_connector
    falls through to admin_upload / file_manager strategies which can do the
    actual file transfer.  It is kept as a named strategy so pinned=rest_api
    sites still enter the push chain (they will succeed via admin_upload next).
    """
    log.info("REST-only push not viable for %s — falling through to upload strategies", site.get("name"))
    return None


# ── Main Entry Point ─────────────────────────────────────────────

async def deploy_connector(site: dict) -> DeployResult:
    """Deploy the OPAI Connector plugin using the best available method.

    Tries pinned method first (if any), then the full strategy chain.
    On pinned-method failure, clears pin and retries the chain.
    """
    caps = site.get("capabilities") or {}
    pinned = caps.get("deploy_method")

    strategy_map = {
        "rest_api": _try_rest_api_deploy,
        "admin_upload": _try_admin_upload,
        "file_manager": _try_file_manager_deploy,
    }

    # Full ordered chain
    chain = [
        ("rest_api", _try_rest_api_deploy),
        ("admin_upload", _try_admin_upload),
        ("file_manager", _try_file_manager_deploy),
    ]

    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:

        # Try pinned method first
        if pinned and pinned in strategy_map:
            log.info("Trying pinned deploy method '%s' for %s", pinned, site.get("name"))
            result = await strategy_map[pinned](client, site)
            if result and result.success:
                return result
            # Pinned method failed — clear pin and try full chain
            log.info("Pinned method '%s' failed for %s — trying full chain", pinned, site.get("name"))
            await _update_capabilities(site["id"], {"deploy_method": None})

        # Try full chain
        for method_name, strategy_fn in chain:
            log.info("Trying deploy strategy '%s' for %s", method_name, site.get("name"))
            result = await strategy_fn(client, site)
            if result and result.success:
                return result

    # All strategies failed
    return _manual_fallback(site)


async def _try_self_update(client: httpx.AsyncClient, site: dict) -> Optional[DeployResult]:
    """Push update via connector's self-update endpoint (requires connector already installed).

    Uses X-OPAI-Key auth — no wp-admin login needed.
    """
    connector_key = site.get("connector_secret")
    if not connector_key:
        log.info("No connector_secret — skipping self-update for %s", site.get("name"))
        return None

    base = site["url"].rstrip("/")
    url = f"{base}/wp-json/opai/v1/connector/self-update"
    zip_data = _build_connector_zip()

    try:
        resp = await client.post(
            url,
            headers={"X-OPAI-Key": connector_key},
            files={"plugin": ("opai-connector.zip", zip_data, "application/zip")},
            timeout=60,
        )

        if resp.status_code == 200:
            data = resp.json()
            log.info("Self-update succeeded for %s: %s → %s",
                     site.get("name"), data.get("old_version"), data.get("new_version"))
            await _finalize_install(site, "self_update", connector_key)
            return DeployResult(
                success=True,
                method="self_update",
                message=f"Connector updated via self-update ({data.get('old_version')} → {data.get('new_version')}).",
                connector_key=connector_key,
            )

        log.info("Self-update returned %d for %s: %s", resp.status_code, site.get("name"), resp.text[:200])
        return None

    except Exception as e:
        log.info("Self-update failed for %s: %s", site.get("name"), e)
        return None


async def push_update_connector(site: dict) -> DeployResult:
    """Force-push the latest connector ZIP to a site using its pinned connection type.

    Unlike deploy_connector (which activates an existing plugin), this always
    uploads a fresh ZIP so the version is guaranteed to be current.

    Strategy priority:
      1. Pinned method → matching push strategy
      2. Admin upload (most universally capable for re-installs)
      3. File manager
      4. REST API upload (WP 5.5+ required)
      5. Manual fallback
    """
    caps = site.get("capabilities") or {}
    pinned = caps.get("deploy_method")
    site_name = site.get("name", site.get("url", "?"))
    log.info("Pushing connector update to %s (pinned=%s)", site_name, pinned)

    # Map pinned method → push strategy
    push_strategy_map = {
        "self_update": _try_self_update,
        "rest_api": _push_via_rest_api,
        "admin_upload": _try_admin_upload,
        "file_manager": _try_file_manager_deploy,
    }

    # Ordered chain for unrecognized / no pinned method
    # self_update first — works whenever connector is reachable, no wp-admin needed
    push_chain = [
        ("self_update", _try_self_update),
        ("admin_upload", _try_admin_upload),
        ("file_manager", _try_file_manager_deploy),
        ("rest_api", _push_via_rest_api),
    ]

    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        # Try pinned method first
        if pinned and pinned in push_strategy_map:
            result = await push_strategy_map[pinned](client, site)
            if result and result.success:
                await _update_capabilities(site["id"], {"push_status": None})
                return result
            log.info("Pinned push method '%s' failed for %s — trying chain", pinned, site_name)

        # Try full chain
        for method_name, strategy_fn in push_chain:
            if pinned and method_name == pinned:
                continue  # already tried above
            result = await strategy_fn(client, site)
            if result and result.success:
                await _update_capabilities(site["id"], {"push_status": None})
                return result

    # All strategies failed — record reason for UI display
    caps = site.get("capabilities") or {}
    last_failure = caps.get("last_failure_log", "No automated upload method succeeded.")
    has_admin_pwd = bool(site.get("admin_password"))
    has_file_mgr = bool(caps.get("has_file_manager"))

    if not has_admin_pwd and not has_file_mgr:
        push_reason = "no_credentials"
    elif (caps.get("last_failure_log") or "").startswith("All upload URLs returned 404"):
        push_reason = "host_blocks_upload"
    else:
        push_reason = "upload_failed"

    await _update_capabilities(site["id"], {
        "push_status": "manual_required",
        "push_reason": push_reason,
        "push_failure_detail": last_failure,
        "push_version_needed": OPAI_CONNECTOR_VERSION_STR,
    })
    return _manual_fallback(site)


# ── Generic Plugin ZIP Deploy ────────────────────────────────────

async def deploy_plugin_zip(site: dict, zip_data: bytes, plugin_folder_name: str) -> DeployResult:
    """Deploy an arbitrary plugin ZIP to a site using admin upload strategy.

    Reuses the admin login -> nonce -> upload -> activate flow.
    Falls back to manual if admin upload is not possible.
    """
    admin_pwd = site.get("admin_password")
    if not admin_pwd:
        return DeployResult(
            success=False, method="manual",
            message="Admin password required for plugin upload. Set it in site Settings.",
        )

    base = site["url"].rstrip("/")
    zip_filename = f"{plugin_folder_name}.zip"

    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            # Detect canonical URL (handles www/non-www mismatch)
            canonical_base = await _detect_canonical_base(client, base)

            # Login
            await client.get(f"{canonical_base}/wp-login.php")
            await client.post(
                f"{canonical_base}/wp-login.php",
                data={
                    "log": site["username"],
                    "pwd": admin_pwd,
                    "wp-submit": "Log In",
                    "redirect_to": f"{canonical_base}/wp-admin/",
                    "testcookie": "1",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )

            cookie_names = list(client.cookies.keys())
            has_auth = any("wordpress_logged_in" in c for c in cookie_names)
            if not has_auth:
                return DeployResult(
                    success=False, method="admin_upload",
                    message="Admin login failed — check credentials.",
                )

            # Use canonical_base for wp-admin operations
            base = canonical_base

            # Get upload page nonce
            page_resp = await client.get(f"{base}/wp-admin/plugin-install.php?tab=upload")
            if page_resp.status_code != 200 or "wp-login" in str(page_resp.url):
                return DeployResult(
                    success=False, method="admin_upload",
                    message="Plugin upload page inaccessible.",
                )

            nonce_match = re.search(r'name="_wpnonce"\s+value="([^"]+)"', page_resp.text)
            if not nonce_match:
                nonce_match = re.search(r'id="_wpnonce"\s+value="([^"]+)"', page_resp.text)
            if not nonce_match:
                return DeployResult(
                    success=False, method="admin_upload",
                    message="Could not extract upload nonce.",
                )

            nonce = nonce_match.group(1)

            # Upload ZIP
            upload_resp = await client.post(
                f"{base}/wp-admin/update.php?action=upload-plugin",
                data={"_wpnonce": nonce, "install-plugin-submit": "Install Now"},
                files={"pluginzip": (zip_filename, zip_data, "application/zip")},
                headers={"Referer": f"{base}/wp-admin/plugin-install.php?tab=upload"},
            )

            result_html = upload_resp.text
            result_html_lower = result_html.lower()

            # Handle overwrite confirmation
            if "overwrite" in result_html_lower or "already installed" in result_html_lower:
                overwrite_link = re.search(
                    r'href=["\']([^"\']*action=upload-plugin[^"\']*overwrite=update-plugin[^"\']*)["\']',
                    result_html,
                )
                if not overwrite_link:
                    overwrite_link = re.search(
                        r'href=["\']([^"\']*overwrite[^"\']+update-plugin[^"\']*)["\']',
                        result_html,
                    )

                if overwrite_link:
                    ow_url = overwrite_link.group(1).replace("&amp;", "&")
                    if not ow_url.startswith("http"):
                        ow_url = f"{base}/wp-admin/{ow_url}"
                    await client.get(
                        ow_url,
                        headers={"Referer": f"{base}/wp-admin/update.php"},
                    )
                else:
                    log.warning("Could not find overwrite link for %s on %s", plugin_folder_name, site.get("name"))

            # Activate via REST API (use fresh client without admin cookies)
            async with httpx.AsyncClient(timeout=30) as rest_client:
                plugin_file = None
                headers = _wp_auth_header(site)
                resp = await rest_client.get(
                    _wp_api(site, "/wp/v2/plugins?context=edit&per_page=100"),
                    headers=headers,
                )
                if resp.status_code == 200:
                    for p in resp.json():
                        if plugin_folder_name in p.get("plugin", ""):
                            plugin_file = p["plugin"]
                            break

                if not plugin_file:
                    return DeployResult(
                        success=False, method="admin_upload",
                        message="Plugin uploaded but not found in plugin list.",
                    )

                await _activate_plugin(rest_client, site, plugin_file)

            return DeployResult(
                success=True, method="admin_upload",
                message=f"Plugin '{plugin_folder_name}' installed and activated.",
            )

    except httpx.TimeoutException:
        return DeployResult(
            success=False, method="admin_upload",
            message="Upload timed out.",
        )
    except Exception as e:
        log.warning("deploy_plugin_zip failed for %s on %s: %s", plugin_folder_name, site.get("name"), e)
        return DeployResult(
            success=False, method="admin_upload",
            message=f"Install failed: {e}",
        )
