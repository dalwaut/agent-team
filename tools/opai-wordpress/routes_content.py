"""OP WordPress — Content management routes (posts, pages, media)."""

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

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


# ── Request Models ────────────────────────────────────────

class CreatePost(BaseModel):
    title: str
    content: str = ""
    status: str = "draft"
    excerpt: Optional[str] = None
    categories: Optional[list] = None
    tags: Optional[list] = None
    featured_media: Optional[int] = None


class UpdatePost(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    status: Optional[str] = None
    excerpt: Optional[str] = None
    categories: Optional[list] = None
    tags: Optional[list] = None
    featured_media: Optional[int] = None


class CreatePage(BaseModel):
    title: str
    content: str = ""
    status: str = "draft"
    parent: Optional[int] = None
    menu_order: int = 0
    template: Optional[str] = None


class UpdatePage(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    status: Optional[str] = None
    parent: Optional[int] = None
    menu_order: Optional[int] = None
    template: Optional[str] = None


# ── Posts ─────────────────────────────────────────────────

@router.get("/sites/{site_id}/posts")
async def list_posts(site_id: str,
                     page: int = 1, per_page: int = 20,
                     search: str = None, status: str = None,
                     user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {"page": page, "per_page": per_page}
    if search:
        kwargs["search"] = search
    if status:
        kwargs["status"] = status
    return _exec(site, "posts", "list", **kwargs)


@router.get("/sites/{site_id}/posts/{post_id}")
async def get_post(site_id: str, post_id: int,
                   user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "posts", "get", post_id=post_id)


@router.post("/sites/{site_id}/posts")
async def create_post(site_id: str, body: CreatePost,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {k: v for k, v in body.dict().items() if v is not None}
    return _exec(site, "posts", "create", **kwargs)


@router.put("/sites/{site_id}/posts/{post_id}")
async def update_post(site_id: str, post_id: int, body: UpdatePost,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {k: v for k, v in body.dict().items() if v is not None}
    return _exec(site, "posts", "update", post_id=post_id, **kwargs)


@router.delete("/sites/{site_id}/posts/{post_id}")
async def delete_post(site_id: str, post_id: int, force: bool = False,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "posts", "delete", post_id=post_id, force=force)


# ── Pages ─────────────────────────────────────────────────

@router.get("/sites/{site_id}/pages")
async def list_pages(site_id: str,
                     page: int = 1, per_page: int = 20,
                     search: str = None, status: str = None,
                     user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {"page": page, "per_page": per_page}
    if search:
        kwargs["search"] = search
    if status:
        kwargs["status"] = status
    return _exec(site, "pages", "list", **kwargs)


@router.get("/sites/{site_id}/pages/{page_id}")
async def get_page(site_id: str, page_id: int,
                   user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "pages", "get", page_id=page_id)


@router.post("/sites/{site_id}/pages")
async def create_page(site_id: str, body: CreatePage,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {k: v for k, v in body.dict().items() if v is not None}
    return _exec(site, "pages", "create", **kwargs)


@router.put("/sites/{site_id}/pages/{page_id}")
async def update_page(site_id: str, page_id: int, body: UpdatePage,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {k: v for k, v in body.dict().items() if v is not None}
    return _exec(site, "pages", "update", page_id=page_id, **kwargs)


@router.delete("/sites/{site_id}/pages/{page_id}")
async def delete_page(site_id: str, page_id: int, force: bool = False,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "pages", "delete", page_id=page_id, force=force)


@router.get("/sites/{site_id}/pages/hierarchy")
async def page_hierarchy(site_id: str,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "pages", "get-hierarchy")


# ── Media ─────────────────────────────────────────────────

@router.get("/sites/{site_id}/media")
async def list_media(site_id: str,
                     page: int = 1, per_page: int = 20,
                     search: str = None, media_type: str = None,
                     user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {"page": page, "per_page": per_page}
    if search:
        kwargs["search"] = search
    if media_type:
        kwargs["media_type"] = media_type
    return _exec(site, "media", "list", **kwargs)


@router.get("/sites/{site_id}/media/{media_id}")
async def get_media(site_id: str, media_id: int,
                    user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "media", "get", media_id=media_id)


@router.delete("/sites/{site_id}/media/{media_id}")
async def delete_media(site_id: str, media_id: int, force: bool = True,
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    return _exec(site, "media", "delete", media_id=media_id, force=force)


# ── Search ────────────────────────────────────────────────

@router.get("/sites/{site_id}/search")
async def search_content(site_id: str, q: str,
                         type: str = None, page: int = 1, per_page: int = 10,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    kwargs = {"query": q, "page": page, "per_page": per_page}
    if type:
        kwargs["type"] = type
    return _exec(site, "search", "search", **kwargs)
