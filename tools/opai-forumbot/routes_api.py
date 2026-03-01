"""OPAI Forum Bot — REST API endpoints (admin-only)."""

import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import config
from auth import require_admin, AuthUser
from generator import generate_posts

router = APIRouter(prefix="/api")


# ── Supabase helpers ─────────────────────────────────────────

def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str) -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Request models ───────────────────────────────────────────

class GenerateRequest(BaseModel):
    prompt: str
    post_type: str = "general"
    count: int = 1
    category_id: str | None = None
    tags: list[str] = []


class UpdateDraftRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    tags: list[str] | None = None
    category_id: str | None = None
    post_type: str | None = None
    poll_data: dict | None = None


class CreateScheduleRequest(BaseModel):
    name: str
    cron_expr: str
    post_type: str = "general"
    prompt_template: str
    category_id: str | None = None
    tags: list[str] = []
    auto_publish: bool = False
    conditions: list[dict] = []
    max_drafts: int = 1
    enabled: bool = True


class UpdateScheduleRequest(BaseModel):
    name: str | None = None
    cron_expr: str | None = None
    post_type: str | None = None
    prompt_template: str | None = None
    category_id: str | None = None
    tags: list[str] | None = None
    auto_publish: bool | None = None
    conditions: list[dict] | None = None
    max_drafts: int | None = None
    enabled: bool | None = None


# ── Generate ─────────────────────────────────────────────────

@router.post("/generate")
async def generate(req: GenerateRequest, user: AuthUser = Depends(require_admin)):
    """Generate AI forum post drafts from a prompt."""
    count = max(1, min(5, req.count))

    posts = await generate_posts(
        prompt=req.prompt,
        post_type=req.post_type,
        count=count,
    )

    batch_id = f"manual-{uuid.uuid4().hex[:12]}"
    drafts = []

    async with httpx.AsyncClient(timeout=10) as client:
        for post in posts:
            draft_data = {
                "status": "draft",
                "post_type": req.post_type,
                "title": post["title"],
                "content": post["content"],
                "tags": req.tags if req.tags else post.get("tags", []),
                "category_id": req.category_id,
                "poll_data": post.get("poll"),
                "prompt": req.prompt,
                "batch_id": batch_id,
            }

            resp = await client.post(
                _sb_url("forumbot_drafts"),
                headers=_sb_headers(),
                json=draft_data,
            )
            if resp.status_code >= 400:
                continue

            draft = resp.json()
            draft = draft[0] if isinstance(draft, list) else draft
            drafts.append(draft)

            # Record history
            await client.post(
                _sb_url("forumbot_history"),
                headers=_sb_headers(),
                json={
                    "draft_id": draft["id"],
                    "action": "generated",
                    "actor": f"admin:{user.id}",
                    "details": {"prompt": req.prompt, "batch_id": batch_id},
                },
            )

    return {"drafts": drafts, "batch_id": batch_id}


# ── Drafts CRUD ──────────────────────────────────────────────

@router.get("/drafts")
async def list_drafts(
    status: str | None = None,
    page: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    user: AuthUser = Depends(require_admin),
):
    params = {"select": "*, category:forum_categories!category_id(id, name, slug)", "order": "created_at.desc"}
    if status:
        params["status"] = f"eq.{status}"

    headers = _sb_headers()
    headers["Range"] = f"{page * limit}-{(page + 1) * limit - 1}"
    headers["Prefer"] = "return=representation, count=exact"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(_sb_url("forumbot_drafts"), headers=headers, params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        total = 0
        content_range = resp.headers.get("content-range", "")
        if "/" in content_range:
            try:
                total = int(content_range.split("/")[1])
            except (ValueError, IndexError):
                pass

        return {"drafts": resp.json(), "total": total, "page": page, "limit": limit}


@router.get("/drafts/{draft_id}")
async def get_draft(draft_id: str, user: AuthUser = Depends(require_admin)):
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _sb_url("forumbot_drafts"),
            headers=_sb_headers(),
            params={"id": f"eq.{draft_id}", "select": "*, category:forum_categories!category_id(id, name, slug)"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Draft not found")
        return data[0]


@router.put("/drafts/{draft_id}")
async def update_draft(
    draft_id: str,
    req: UpdateDraftRequest,
    user: AuthUser = Depends(require_admin),
):
    update_data = req.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="Nothing to update")

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _sb_url("forumbot_drafts"),
            headers=_sb_headers(),
            params={"id": f"eq.{draft_id}"},
            json=update_data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Draft not found")
        return data[0]


@router.post("/drafts/{draft_id}/approve")
async def approve_draft(draft_id: str, user: AuthUser = Depends(require_admin)):
    """Publish a draft to the forum."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Fetch draft
        resp = await client.get(
            _sb_url("forumbot_drafts"),
            headers=_sb_headers(),
            params={"id": f"eq.{draft_id}", "select": "*"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Draft not found")

        draft = data[0]
        if draft["status"] == "published":
            raise HTTPException(status_code=400, detail="Already published")
        if draft["status"] == "discarded":
            raise HTTPException(status_code=400, detail="Draft was discarded")

    result = await _publish_draft_to_forum(draft, actor=f"admin:{user.id}")
    return result


@router.delete("/drafts/{draft_id}")
async def discard_draft(draft_id: str, user: AuthUser = Depends(require_admin)):
    """Discard a draft (soft delete)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _sb_url("forumbot_drafts"),
            headers=_sb_headers(),
            params={"id": f"eq.{draft_id}"},
            json={"status": "discarded"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Draft not found")

        # Record history
        await client.post(
            _sb_url("forumbot_history"),
            headers=_sb_headers(),
            json={
                "draft_id": draft_id,
                "action": "discarded",
                "actor": f"admin:{user.id}",
            },
        )

    return {"status": "discarded"}


# ── Publish helper ───────────────────────────────────────────

async def _publish_draft_to_forum(draft: dict, actor: str) -> dict:
    """Create a forum post from a draft and update draft status."""
    author_id = config.FORUM_BOT_AUTHOR_ID
    if not author_id:
        raise HTTPException(status_code=500, detail="FORUM_BOT_AUTHOR_ID not configured")

    post_data = {
        "author_id": author_id,
        "title": draft["title"],
        "content": draft["content"],
        "content_format": draft.get("content_format", "markdown"),
        "tags": draft.get("tags", []),
    }
    if draft.get("category_id"):
        post_data["category_id"] = draft["category_id"]

    async with httpx.AsyncClient(timeout=10) as client:
        # Create forum post
        resp = await client.post(
            _sb_url("forum_posts"),
            headers=_sb_headers(),
            json=post_data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=f"Failed to create forum post: {resp.text}")

        post = resp.json()
        post = post[0] if isinstance(post, list) else post

        # Create poll if present
        if draft.get("poll_data") and draft["poll_data"].get("question"):
            poll_d = draft["poll_data"]
            poll_resp = await client.post(
                _sb_url("forum_polls"),
                headers=_sb_headers(),
                json={
                    "post_id": post["id"],
                    "question": poll_d["question"],
                    "allow_multiple": poll_d.get("allow_multiple", False),
                    "closes_at": poll_d.get("closes_at"),
                },
            )
            if poll_resp.status_code < 400:
                poll = poll_resp.json()
                poll = poll[0] if isinstance(poll, list) else poll
                for i, label in enumerate(poll_d.get("options", [])):
                    await client.post(
                        _sb_url("forum_poll_options"),
                        headers=_sb_headers(),
                        json={"poll_id": poll["id"], "label": label, "sort_order": i},
                    )

        # Update draft status
        now = datetime.now(timezone.utc).isoformat()
        await client.patch(
            _sb_url("forumbot_drafts"),
            headers=_sb_headers(),
            params={"id": f"eq.{draft['id']}"},
            json={
                "status": "published",
                "published_post_id": post["id"],
                "published_at": now,
                "published_by": actor.split(":")[-1] if ":" in actor else actor,
            },
        )

        # Record history
        await client.post(
            _sb_url("forumbot_history"),
            headers=_sb_headers(),
            json={
                "draft_id": draft["id"],
                "post_id": post["id"],
                "action": "published",
                "actor": actor,
                "details": {"title": post.get("title")},
            },
        )

    return {"status": "published", "post_id": post["id"], "draft_id": draft["id"]}


# ── Schedules CRUD ───────────────────────────────────────────

@router.get("/schedules")
async def list_schedules(user: AuthUser = Depends(require_admin)):
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _sb_url("forumbot_schedules"),
            headers=_sb_headers(),
            params={"select": "*", "order": "created_at.desc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@router.post("/schedules")
async def create_schedule(req: CreateScheduleRequest, user: AuthUser = Depends(require_admin)):
    # Validate cron expression
    try:
        from croniter import croniter
        croniter(req.cron_expr)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid cron expression")

    data = req.model_dump()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _sb_url("forumbot_schedules"),
            headers=_sb_headers(),
            json=data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        result = resp.json()
        return result[0] if isinstance(result, list) else result


@router.put("/schedules/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    req: UpdateScheduleRequest,
    user: AuthUser = Depends(require_admin),
):
    update_data = req.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="Nothing to update")

    if "cron_expr" in update_data:
        try:
            from croniter import croniter
            croniter(update_data["cron_expr"])
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid cron expression")

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _sb_url("forumbot_schedules"),
            headers=_sb_headers(),
            params={"id": f"eq.{schedule_id}"},
            json=update_data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Schedule not found")
        return data[0]


@router.delete("/schedules/{schedule_id}")
async def delete_schedule(schedule_id: str, user: AuthUser = Depends(require_admin)):
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.delete(
            _sb_url("forumbot_schedules"),
            headers=_sb_headers(),
            params={"id": f"eq.{schedule_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return {"deleted": True}


@router.post("/schedules/{schedule_id}/run")
async def run_schedule_now(schedule_id: str, user: AuthUser = Depends(require_admin)):
    """Manually trigger a schedule."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _sb_url("forumbot_schedules"),
            headers=_sb_headers(),
            params={"id": f"eq.{schedule_id}", "select": "*"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Schedule not found")

    from scheduler import run_schedule
    result = await run_schedule(data[0])
    return result


# ── Scheduler Settings ────────────────────────────────────────

@router.get("/scheduler/settings")
async def get_scheduler_settings(user: AuthUser = Depends(require_admin)):
    """Get current scheduler tick interval and pause state."""
    from scheduler import get_scheduler_settings as _get
    return _get()


class SchedulerSettingsRequest(BaseModel):
    tick_seconds: int | None = None
    paused: bool | None = None


@router.put("/scheduler/settings")
async def update_scheduler_settings(req: SchedulerSettingsRequest, user: AuthUser = Depends(require_admin)):
    """Update scheduler tick interval (10-3600s) and/or pause state."""
    from scheduler import set_scheduler_settings as _set
    return _set(tick_seconds=req.tick_seconds, paused=req.paused)


# ── History ──────────────────────────────────────────────────

@router.get("/history")
async def list_history(
    page: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    user: AuthUser = Depends(require_admin),
):
    headers = _sb_headers()
    headers["Range"] = f"{page * limit}-{(page + 1) * limit - 1}"
    headers["Prefer"] = "return=representation, count=exact"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _sb_url("forumbot_history"),
            headers=headers,
            params={"select": "*", "order": "created_at.desc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        total = 0
        content_range = resp.headers.get("content-range", "")
        if "/" in content_range:
            try:
                total = int(content_range.split("/")[1])
            except (ValueError, IndexError):
                pass

        return {"history": resp.json(), "total": total, "page": page, "limit": limit}


# ── Stats ────────────────────────────────────────────────────

@router.get("/stats")
async def get_stats(user: AuthUser = Depends(require_admin)):
    """Dashboard statistics."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Pending drafts count
        resp_pending = await client.get(
            _sb_url("forumbot_drafts"),
            headers={**_sb_headers(), "Prefer": "count=exact"},
            params={"status": "eq.draft", "select": "id"},
        )
        pending = 0
        cr = resp_pending.headers.get("content-range", "")
        if "/" in cr:
            try:
                pending = int(cr.split("/")[1])
            except (ValueError, IndexError):
                pass

        # Published today
        today = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")
        resp_today = await client.get(
            _sb_url("forumbot_drafts"),
            headers={**_sb_headers(), "Prefer": "count=exact"},
            params={"status": "eq.published", "published_at": f"gte.{today}", "select": "id"},
        )
        published_today = 0
        cr = resp_today.headers.get("content-range", "")
        if "/" in cr:
            try:
                published_today = int(cr.split("/")[1])
            except (ValueError, IndexError):
                pass

        # Total published
        resp_total = await client.get(
            _sb_url("forumbot_drafts"),
            headers={**_sb_headers(), "Prefer": "count=exact"},
            params={"status": "eq.published", "select": "id"},
        )
        total_published = 0
        cr = resp_total.headers.get("content-range", "")
        if "/" in cr:
            try:
                total_published = int(cr.split("/")[1])
            except (ValueError, IndexError):
                pass

        # Active schedules
        resp_sched = await client.get(
            _sb_url("forumbot_schedules"),
            headers={**_sb_headers(), "Prefer": "count=exact"},
            params={"enabled": "eq.true", "select": "id"},
        )
        active_schedules = 0
        cr = resp_sched.headers.get("content-range", "")
        if "/" in cr:
            try:
                active_schedules = int(cr.split("/")[1])
            except (ValueError, IndexError):
                pass

    return {
        "pending_drafts": pending,
        "published_today": published_today,
        "total_published": total_published,
        "active_schedules": active_schedules,
    }


# ── Categories (passthrough for UI dropdown) ─────────────────

@router.get("/categories")
async def list_categories(user: AuthUser = Depends(require_admin)):
    """List forum categories for the dropdown."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _sb_url("forum_categories"),
            headers=_sb_headers(),
            params={"select": "id,name,slug,icon", "order": "sort_order.asc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()
