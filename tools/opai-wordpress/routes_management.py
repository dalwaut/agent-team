"""OP WordPress — Users, comments, settings, menus, taxonomies, plugins, themes routes."""

import base64

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import List, Optional

import config
from auth import get_current_user, AuthUser

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
    async with httpx.AsyncClient(timeout=10) as client:
        url = f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.get(url, headers=_sb_headers_service())
        sites = resp.json() if resp.status_code == 200 else []
        if not sites:
            raise HTTPException(404, "Site not found")
        return sites[0]


def _exec(site: dict, agent: str, action: str, **kwargs) -> dict:
    from services.site_manager import SiteCredentials, execute
    return execute(SiteCredentials(site), agent, action, **kwargs)


def _wp_auth_header(site: dict) -> dict:
    """Build WP REST API auth headers for direct httpx calls."""
    cred = base64.b64encode(
        f"{site['username']}:{site['app_password']}".encode()
    ).decode()
    return {
        "Authorization": f"Basic {cred}",
        "Content-Type": "application/json",
    }


def _wp_api(site: dict, path: str) -> str:
    """Build full WP REST API URL."""
    base = site["url"].rstrip("/")
    api_base = site.get("api_base", "/wp-json")
    return f"{base}{api_base}{path}"


# ── Request Models ───────────────────────────────────────

class CreateUser(BaseModel):
    username: str
    email: str
    password: str
    first_name: str = ""
    last_name: str = ""
    roles: List[str] = ["subscriber"]


class UpdateUser(BaseModel):
    email: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    name: Optional[str] = None
    roles: Optional[List[str]] = None
    password: Optional[str] = None
    nickname: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None


class UpdateSettings(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    timezone_string: Optional[str] = None
    language: Optional[str] = None
    date_format: Optional[str] = None
    time_format: Optional[str] = None
    posts_per_page: Optional[int] = None
    default_comment_status: Optional[str] = None


class UpdateMedia(BaseModel):
    title: Optional[str] = None
    alt_text: Optional[str] = None
    caption: Optional[str] = None
    description: Optional[str] = None


# ── WP Users ─────────────────────────────────────────────

@router.get("/sites/{site_id}/users")
async def list_users(site_id: str, page: int = 1, per_page: int = 20,
                     search: str = None,
                     user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    # Use direct WP REST API for richer user data (roles, email)
    params = f"?context=edit&page={page}&per_page={per_page}"
    if search:
        params += f"&search={search}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            _wp_api(site, f"/wp/v2/users{params}"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code != 200:
            # Fallback to agent
            return _exec(site, "users", "list", page=page, per_page=per_page)
        return {"status": "success", "data": resp.json()}


@router.get("/sites/{site_id}/users/{wp_user_id}")
async def get_wp_user(site_id: str, wp_user_id: int,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            _wp_api(site, f"/wp/v2/users/{wp_user_id}?context=edit"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code != 200:
            return _exec(site, "users", "get", user_id=wp_user_id)
        return {"status": "success", "data": resp.json()}


@router.post("/sites/{site_id}/users")
async def create_wp_user(site_id: str, body: CreateUser,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    payload = {k: v for k, v in body.dict().items() if v is not None and v != "" and v != []}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _wp_api(site, "/wp/v2/users"),
            headers=_wp_auth_header(site),
            json=payload,
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(resp.status_code, f"Failed to create user: {resp.text}")
        return {"status": "success", "data": resp.json()}


@router.put("/sites/{site_id}/users/{wp_user_id}")
async def update_wp_user(site_id: str, wp_user_id: int, body: UpdateUser,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    payload = {k: v for k, v in body.dict().items() if v is not None}
    if not payload:
        raise HTTPException(400, "No fields to update")
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _wp_api(site, f"/wp/v2/users/{wp_user_id}"),
            headers=_wp_auth_header(site),
            json=payload,
        )
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, f"Failed to update user: {resp.text}")
        return {"status": "success", "data": resp.json()}


@router.delete("/sites/{site_id}/users/{wp_user_id}")
async def delete_wp_user(site_id: str, wp_user_id: int, reassign: int = 1,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            _wp_api(site, f"/wp/v2/users/{wp_user_id}?force=true&reassign={reassign}"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(resp.status_code, f"Failed to delete user: {resp.text}")
        return {"status": "success"}


# ── Comments ──────────────────────────────────────────────

@router.get("/sites/{site_id}/comments")
async def list_comments(site_id: str, page: int = 1, per_page: int = 20,
                        status: str = None, post: int = None,
                        user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    params = f"?context=edit&page={page}&per_page={per_page}"
    if status:
        params += f"&status={status}"
    if post:
        params += f"&post={post}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            _wp_api(site, f"/wp/v2/comments{params}"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code != 200:
            return _exec(site, "comments", "list", page=page, per_page=per_page)
        return {"status": "success", "data": resp.json()}


@router.post("/sites/{site_id}/comments/{comment_id}/approve")
async def approve_comment(site_id: str, comment_id: int,
                          user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _wp_api(site, f"/wp/v2/comments/{comment_id}"),
            headers=_wp_auth_header(site),
            json={"status": "approved"},
        )
        if resp.status_code != 200:
            return _exec(site, "comments", "approve", comment_id=comment_id)
        return {"status": "success", "data": resp.json()}


@router.post("/sites/{site_id}/comments/{comment_id}/unapprove")
async def unapprove_comment(site_id: str, comment_id: int,
                             user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _wp_api(site, f"/wp/v2/comments/{comment_id}"),
            headers=_wp_auth_header(site),
            json={"status": "hold"},
        )
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, f"Failed: {resp.text}")
        return {"status": "success", "data": resp.json()}


@router.post("/sites/{site_id}/comments/{comment_id}/spam")
async def spam_comment(site_id: str, comment_id: int,
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _wp_api(site, f"/wp/v2/comments/{comment_id}"),
            headers=_wp_auth_header(site),
            json={"status": "spam"},
        )
        if resp.status_code != 200:
            return _exec(site, "comments", "spam", comment_id=comment_id)
        return {"status": "success", "data": resp.json()}


@router.post("/sites/{site_id}/comments/{comment_id}/trash")
async def trash_comment(site_id: str, comment_id: int,
                        user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _wp_api(site, f"/wp/v2/comments/{comment_id}"),
            headers=_wp_auth_header(site),
            json={"status": "trash"},
        )
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, f"Failed: {resp.text}")
        return {"status": "success", "data": resp.json()}


@router.post("/sites/{site_id}/comments/{comment_id}/delete")
async def delete_comment_action(site_id: str, comment_id: int,
                                user: AuthUser = Depends(get_current_user)):
    """Permanently delete a comment (called from frontend action buttons)."""
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            _wp_api(site, f"/wp/v2/comments/{comment_id}?force=true"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(resp.status_code, f"Failed to delete: {resp.text}")
        return {"status": "success"}


@router.delete("/sites/{site_id}/comments/{comment_id}")
async def delete_comment(site_id: str, comment_id: int, force: bool = False,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            _wp_api(site, f"/wp/v2/comments/{comment_id}?force={'true' if force else 'false'}"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code not in (200, 204):
            return _exec(site, "comments", "delete", comment_id=comment_id)
        return {"status": "success"}


# ── Settings ──────────────────────────────────────────────

@router.get("/sites/{site_id}/settings")
async def get_settings(site_id: str,
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            _wp_api(site, "/wp/v2/settings"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code != 200:
            return _exec(site, "settings", "get")
        return {"status": "success", "data": resp.json()}


@router.put("/sites/{site_id}/settings")
async def update_settings(site_id: str, body: UpdateSettings,
                          user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    payload = {k: v for k, v in body.dict().items() if v is not None}
    if not payload:
        raise HTTPException(400, "No fields to update")
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _wp_api(site, "/wp/v2/settings"),
            headers=_wp_auth_header(site),
            json=payload,
        )
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, f"Failed: {resp.text}")
        return {"status": "success", "data": resp.json()}


@router.get("/sites/{site_id}/site-info")
async def get_site_info(site_id: str,
                        user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "settings", "get-site-info")


# ── Plugins ───────────────────────────────────────────────

@router.get("/sites/{site_id}/plugins")
async def list_plugins(site_id: str, status: str = None,
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    # WP REST API /wp/v2/plugins requires application-passwords or cookie auth
    params = "?context=edit"
    if status:
        params += f"&status={status}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            _wp_api(site, f"/wp/v2/plugins{params}"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code == 200:
            return {"status": "success", "data": resp.json()}
    # Fallback to agent
    kwargs = {}
    if status:
        kwargs["status"] = status
    return _exec(site, "plugins", "list", **kwargs)


@router.post("/sites/{site_id}/plugins/{plugin_slug:path}/activate")
async def activate_plugin(site_id: str, plugin_slug: str,
                          user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.put(
            _wp_api(site, f"/wp/v2/plugins/{plugin_slug}"),
            headers=_wp_auth_header(site),
            json={"status": "active"},
        )
        if resp.status_code == 200:
            return {"status": "success", "data": resp.json()}
    return _exec(site, "plugins", "activate", plugin=plugin_slug)


@router.post("/sites/{site_id}/plugins/{plugin_slug:path}/deactivate")
async def deactivate_plugin(site_id: str, plugin_slug: str,
                            user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.put(
            _wp_api(site, f"/wp/v2/plugins/{plugin_slug}"),
            headers=_wp_auth_header(site),
            json={"status": "inactive"},
        )
        if resp.status_code == 200:
            return {"status": "success", "data": resp.json()}
    return _exec(site, "plugins", "deactivate", plugin=plugin_slug)


@router.delete("/sites/{site_id}/plugins/{plugin_slug:path}")
async def delete_plugin(site_id: str, plugin_slug: str,
                        user: AuthUser = Depends(get_current_user)):
    """Delete a plugin. Must be deactivated first."""
    site = await _get_site(site_id, user)
    # First ensure deactivated
    async with httpx.AsyncClient(timeout=15) as client:
        await client.put(
            _wp_api(site, f"/wp/v2/plugins/{plugin_slug}"),
            headers=_wp_auth_header(site),
            json={"status": "inactive"},
        )
        # Then delete
        resp = await client.delete(
            _wp_api(site, f"/wp/v2/plugins/{plugin_slug}"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(resp.status_code, f"Failed to delete plugin: {resp.text}")
        return {"status": "success"}


class InstallPlugin(BaseModel):
    slug: str


@router.post("/sites/{site_id}/plugins/install")
async def install_plugin(site_id: str, body: InstallPlugin,
                         user: AuthUser = Depends(get_current_user)):
    """Install a plugin from the WordPress.org directory by slug."""
    site = await _get_site(site_id, user)
    slug = body.slug
    if not slug:
        raise HTTPException(400, "Plugin slug required")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            _wp_api(site, "/wp/v2/plugins"),
            headers=_wp_auth_header(site),
            json={"slug": slug, "status": "inactive"},
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(resp.status_code, f"Failed to install: {resp.text}")
        return {"status": "success", "data": resp.json()}


# ── Themes ────────────────────────────────────────────────

@router.get("/sites/{site_id}/themes")
async def list_themes(site_id: str,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            _wp_api(site, "/wp/v2/themes"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code == 200:
            return {"status": "success", "data": resp.json()}
    return _exec(site, "plugins", "list-themes")


@router.get("/sites/{site_id}/themes/active")
async def active_theme(site_id: str,
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "plugins", "get-active-theme")


@router.post("/sites/{site_id}/themes/{theme_slug}/activate")
async def activate_theme(site_id: str, theme_slug: str,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.put(
            _wp_api(site, f"/wp/v2/themes/{theme_slug}"),
            headers=_wp_auth_header(site),
            json={"status": "active"},
        )
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, f"Failed to activate theme: {resp.text}")
        return {"status": "success", "data": resp.json()}


@router.delete("/sites/{site_id}/themes/{theme_slug}")
async def delete_theme(site_id: str, theme_slug: str,
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    # WP REST API has no DELETE /themes endpoint — use the OPAI connector plugin.
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _wp_api(site, f"/opai/v1/themes/{theme_slug}/delete"),
            headers=_wp_auth_header(site),
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(resp.status_code, f"Failed to delete theme: {resp.text}")
        return {"status": "success"}


@router.post("/sites/{site_id}/themes/upload")
async def upload_theme(site_id: str,
                       file: UploadFile = File(...),
                       user: AuthUser = Depends(get_current_user)):
    """Upload a theme ZIP to the WordPress site via the OPAI connector plugin."""
    site = await _get_site(site_id, user)

    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(400, "File must be a .zip archive")

    contents = await file.read()

    # Try OPAI connector plugin endpoint first (preferred — no auth cookies needed)
    connector_url = _wp_api(site, "/opai/v1/themes/upload")
    auth_headers = {k: v for k, v in _wp_auth_header(site).items() if k != "Content-Type"}

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            connector_url,
            headers=auth_headers,
            files={"file": (file.filename, contents, "application/zip")},
        )
        if resp.status_code == 200:
            data = resp.json()
            return {"status": "success", "theme_name": data.get("theme_name", file.filename)}

        # Fallback: WP REST API media/plugin upload (WP 5.5+)
        wp_headers = {k: v for k, v in _wp_auth_header(site).items() if k != "Content-Type"}
        wp_headers["Content-Disposition"] = f'attachment; filename="{file.filename}"'
        wp_headers["Content-Type"] = "application/zip"

        resp2 = await client.post(
            _wp_api(site, "/wp/v2/themes"),
            headers=wp_headers,
            content=contents,
        )
        if resp2.status_code in (200, 201):
            data2 = resp2.json()
            name = data2.get("name", {})
            theme_name = name.get("raw") or name if isinstance(name, str) else file.filename
            return {"status": "success", "theme_name": theme_name}

        raise HTTPException(502, f"Theme upload failed. Ensure the OPAI Connector plugin is installed on {site['name']}.")


# ── Media (update) ────────────────────────────────────────

@router.put("/sites/{site_id}/media/{media_id}")
async def update_media(site_id: str, media_id: int, body: UpdateMedia,
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    payload = {}
    if body.title is not None:
        payload["title"] = body.title
    if body.alt_text is not None:
        payload["alt_text"] = body.alt_text
    if body.caption is not None:
        payload["caption"] = body.caption
    if body.description is not None:
        payload["description"] = body.description
    if not payload:
        raise HTTPException(400, "No fields to update")
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _wp_api(site, f"/wp/v2/media/{media_id}"),
            headers=_wp_auth_header(site),
            json=payload,
        )
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, f"Failed: {resp.text}")
        return {"status": "success", "data": resp.json()}


# ── Taxonomies ────────────────────────────────────────────

@router.get("/sites/{site_id}/categories")
async def list_categories(site_id: str, page: int = 1, per_page: int = 100,
                          search: str = None,
                          user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {"page": page, "per_page": per_page}
    if search:
        kwargs["search"] = search
    return _exec(site, "taxonomy", "list-categories", **kwargs)


@router.get("/sites/{site_id}/tags")
async def list_tags(site_id: str, page: int = 1, per_page: int = 100,
                    search: str = None,
                    user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {"page": page, "per_page": per_page}
    if search:
        kwargs["search"] = search
    return _exec(site, "taxonomy", "list-tags", **kwargs)


# ── Menus ─────────────────────────────────────────────────

@router.get("/sites/{site_id}/menus")
async def list_menus(site_id: str,
                     user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "menus", "list")


@router.get("/sites/{site_id}/menus/{menu_id}")
async def get_menu(site_id: str, menu_id: int,
                   user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "menus", "get", menu_id=menu_id)


@router.get("/sites/{site_id}/menus/{menu_id}/items")
async def list_menu_items(site_id: str, menu_id: int,
                          user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "menus", "list-items", menus=menu_id)
