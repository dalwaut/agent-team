"""OP WordPress — Envato Theme Manager routes.

Manages Envato API keys (per-user, stored in Supabase wp_envato_keys),
pulls latest Avada ZIP from ThemeForest, and deploys the stored ZIP to
connected WordPress sites.

Key storage: wp_envato_keys (Supabase) — scoped to user_id.
Cache state: data/avada.json — server-wide (cached_version, zip_stored).
"""

import base64
import json
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import config
from auth import get_current_user, AuthUser

log = logging.getLogger("opai-wordpress.avada")

router = APIRouter(prefix="/api/avada")

# ── Server-side cache (version + ZIP presence, not per-user) ─────────

AVADA_CACHE = config.DATA_DIR / "avada.json"
AVADA_ZIP   = config.DATA_DIR / "avada-latest.zip"
AVADA_ITEM_ID = 2833226  # ThemeForest item ID for Avada


def _load_cache() -> dict:
    if AVADA_CACHE.exists():
        try:
            return json.loads(AVADA_CACHE.read_text())
        except Exception:
            pass
    return {"cached_version": None}


def _save_cache(data: dict):
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    AVADA_CACHE.write_text(json.dumps(data, indent=2))


# ── Supabase helpers ──────────────────────────────────────────────────

def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


async def _fetch_keys(user: AuthUser, client: httpx.AsyncClient) -> list:
    """Fetch Envato keys for the current user (admins see all)."""
    url = f"{_sb_url('wp_envato_keys')}?select=*&order=created_at.asc"
    if not user.is_admin:
        url += f"&user_id=eq.{user.id}"
    resp = await client.get(url, headers=_sb_headers())
    return resp.json() if resp.status_code == 200 else []


async def _get_site(site_id: str, user: AuthUser) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        url = f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.get(url, headers=_sb_headers())
        sites = resp.json() if resp.status_code == 200 else []
        if not sites:
            raise HTTPException(404, "Site not found")
        return sites[0]


def _wp_auth_header(site: dict) -> dict:
    cred = base64.b64encode(
        f"{site['username']}:{site['app_password']}".encode()
    ).decode()
    return {
        "Authorization": f"Basic {cred}",
        "Content-Type": "application/json",
    }


def _wp_api(site: dict, path: str) -> str:
    base = site["url"].rstrip("/")
    api_base = site.get("api_base", "/wp-json")
    return f"{base}{api_base}{path}"


# ── Models ────────────────────────────────────────────────────────────

class AddKeyBody(BaseModel):
    label: str
    token: str


class DeployBody(BaseModel):
    site_id: str


# ── Routes ────────────────────────────────────────────────────────────

@router.get("/config")
async def get_config(user: AuthUser = Depends(get_current_user)):
    """Return Envato config: user's keys (masked) + server cache state."""
    cache = _load_cache()

    async with httpx.AsyncClient(timeout=10) as client:
        keys_raw = await _fetch_keys(user, client)

    masked_keys = []
    for k in keys_raw:
        token = k.get("token", "")
        masked = token[:6] + "..." + token[-4:] if len(token) > 12 else "****"
        masked_keys.append({
            "id": k["id"],
            "label": k["label"],
            "masked": masked,
            "created_at": k.get("created_at"),
        })

    return {
        "keys": masked_keys,
        "cached_version": cache.get("cached_version"),
        "zip_stored": AVADA_ZIP.exists(),
    }


@router.post("/config/keys")
async def add_key(body: AddKeyBody, user: AuthUser = Depends(get_current_user)):
    """Add an Envato Personal Token (stored per user in Supabase)."""
    if len(body.token) < 20:
        raise HTTPException(400, "Token too short — paste your full Envato Personal Token")

    row = {
        "user_id": user.id,
        "label": body.label,
        "token": body.token,
    }

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_sb_url("wp_envato_keys"), headers=_sb_headers(), json=row)
        if resp.status_code not in (200, 201):
            raise HTTPException(500, f"Failed to save key: {resp.text}")

    return {"status": "success"}


@router.delete("/config/keys/{key_id}")
async def delete_key(key_id: str, user: AuthUser = Depends(get_current_user)):
    """Remove an Envato API key (only the owning user or admin can delete)."""
    url = f"{_sb_url('wp_envato_keys')}?id=eq.{key_id}"
    if not user.is_admin:
        url += f"&user_id=eq.{user.id}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.delete(url, headers=_sb_headers())
        if resp.status_code not in (200, 204):
            raise HTTPException(500, "Failed to delete key")
        deleted = resp.json()
        if not deleted:
            raise HTTPException(404, "Key not found")

    return {"status": "success"}


@router.post("/check-version")
async def check_version(user: AuthUser = Depends(get_current_user)):
    """
    Check latest Avada version from ThemeForest via Envato API (auth required).
    Uses the calling user's first stored Envato key.
    Also downloads the ZIP if the version check succeeds.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        keys = await _fetch_keys(user, client)

    if not keys:
        raise HTTPException(400, "No Envato API key configured. Add one in the Envato section first.")

    token = keys[0]["token"]

    # ── Fetch latest version (Bearer auth required) ───────────────────
    version = None
    status_code = None
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            f"https://api.envato.com/v3/market/catalog/item?id={AVADA_ITEM_ID}",
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": "OP-WordPress/1.0",
            },
        )
        status_code = resp.status_code
        if resp.status_code == 200:
            item = resp.json()
            version = (
                item.get("wordpress_theme_metadata", {}).get("version")
                or item.get("attributes", {}).get("current-version")
                or item.get("current_version")
            )

    if not version:
        raise HTTPException(
            502,
            f"Could not fetch Avada version from ThemeForest (HTTP {status_code}). "
            "Check that your Envato token is valid and has 'List purchases' permission."
        )

    cache = _load_cache()
    cache["cached_version"] = version
    downloaded = False

    # ── Download ZIP ──────────────────────────────────────────────────
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        dl_resp = await client.get(
            f"https://api.envato.com/v3/market/buyer/download?item_id={AVADA_ITEM_ID}&shorten_url=true",
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": "OP-WordPress/1.0",
            },
        )
        if dl_resp.status_code == 200:
            dl_data = dl_resp.json()
            download_url = dl_data.get("wordpress_theme") or dl_data.get("all_files")
            if download_url:
                zip_resp = await client.get(download_url)
                if zip_resp.status_code == 200:
                    AVADA_ZIP.write_bytes(zip_resp.content)
                    downloaded = True
        else:
            log.warning("Download request failed: HTTP %d — %s",
                        dl_resp.status_code, dl_resp.text[:200])

    _save_cache(cache)
    return {"status": "success", "version": version, "downloaded": downloaded}


@router.post("/deploy")
async def deploy(body: DeployBody, user: AuthUser = Depends(get_current_user)):
    """Deploy stored Avada ZIP to a connected WordPress site."""
    if not AVADA_ZIP.exists():
        raise HTTPException(400, "No Avada ZIP stored. Pull the theme first.")

    site = await _get_site(body.site_id, user)
    zip_bytes = AVADA_ZIP.read_bytes()

    auth_headers = {k: v for k, v in _wp_auth_header(site).items() if k != "Content-Type"}

    async with httpx.AsyncClient(timeout=120) as client:
        # Try OPAI connector endpoint
        resp = await client.post(
            _wp_api(site, "/opai/v1/themes/upload"),
            headers=auth_headers,
            files={"file": ("avada.zip", zip_bytes, "application/zip")},
        )
        if resp.status_code == 200:
            return {"status": "success", "message": f"Avada deployed to {site['name']}"}

        # Fallback: WP REST API theme upload (WP 5.5+)
        wp_headers = dict(auth_headers)
        wp_headers["Content-Disposition"] = 'attachment; filename="avada.zip"'
        wp_headers["Content-Type"] = "application/zip"
        resp2 = await client.post(
            _wp_api(site, "/wp/v2/themes"),
            headers=wp_headers,
            content=zip_bytes,
        )
        if resp2.status_code in (200, 201):
            return {"status": "success", "message": f"Avada deployed to {site['name']}"}

        raise HTTPException(502, f"Deploy failed on {site['name']}. Ensure OPAI Connector plugin is installed.")
