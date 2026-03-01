"""OPAI Forum — REST API endpoints."""

import mimetypes
import uuid
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from pydantic import BaseModel

import config
from auth import get_current_user, require_admin, AuthUser

router = APIRouter(prefix="/api")


# ── Supabase helpers ─────────────────────────────────────────

def _sb_headers_service():
    """Build Supabase REST headers using the service role key."""
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"



# ── Request models ───────────────────────────────────────────

class CreatePostRequest(BaseModel):
    title: str
    content: str
    category_id: str
    content_format: str = "markdown"
    image_url: str | None = None
    image_name: str | None = None
    code_snippet: str | None = None
    code_language: str | None = None
    tags: list[str] = []
    poll: dict | None = None  # {question, options: [str], allow_multiple, closes_at}


class UpdatePostRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    content_format: str | None = None
    image_url: str | None = None
    image_name: str | None = None
    code_snippet: str | None = None
    code_language: str | None = None
    tags: list[str] | None = None


class CreateCommentRequest(BaseModel):
    content: str
    content_format: str = "markdown"
    parent_id: str | None = None


class UpdateCommentRequest(BaseModel):
    content: str
    content_format: str | None = None


class VoteRequest(BaseModel):
    value: int  # 1 or -1


class ReactionRequest(BaseModel):
    emoji: str


class PollVoteRequest(BaseModel):
    option_id: str


class PinLockRequest(BaseModel):
    value: bool


class CreateCategoryRequest(BaseModel):
    name: str
    slug: str
    description: str | None = None
    icon: str | None = None
    sort_order: int = 0


class UpdateCategoryRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    sort_order: int | None = None


# ── Categories ───────────────────────────────────────────────

@router.get("/categories")
async def list_categories(user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("forum_categories"),
            headers=_sb_headers_service(),
            params={"order": "sort_order.asc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@router.post("/categories")
async def create_category(
    req: CreateCategoryRequest,
    user: AuthUser = Depends(require_admin),
):
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("forum_categories"),
            headers=_sb_headers_service(),
            json=req.model_dump(exclude_none=True),
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@router.put("/categories/{cat_id}")
async def update_category(
    cat_id: str,
    req: UpdateCategoryRequest,
    user: AuthUser = Depends(require_admin),
):
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            _sb_url("forum_categories"),
            headers=_sb_headers_service(),
            params={"id": f"eq.{cat_id}"},
            json=req.model_dump(exclude_none=True),
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        return data[0] if data else {"ok": True}


# ── Posts ────────────────────────────────────────────────────

@router.get("/posts")
async def list_posts(
    category: str | None = None,
    sort: str = "newest",
    page: int = 1,
    limit: int = Query(default=20, le=50),
    search: str | None = None,
    author: str | None = None,
    user: AuthUser = Depends(get_current_user),
):
    params: dict = {
        "select": "*, author:profiles!author_id(id, display_name), category:forum_categories!category_id(id, name, slug, icon)",
        "deleted_at": "is.null",
        "limit": str(limit),
        "offset": str((page - 1) * limit),
    }

    if category:
        params["category_id"] = f"eq.{category}"
    if author:
        params["author_id"] = f"eq.{author}"

    if sort == "top":
        params["order"] = "is_pinned.desc,vote_score.desc,created_at.desc"
    elif sort == "hot":
        params["order"] = "is_pinned.desc,comment_count.desc,created_at.desc"
    else:
        params["order"] = "is_pinned.desc,created_at.desc"

    headers = _sb_headers_service()
    headers["Prefer"] = "count=exact"

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("forum_posts"),
            headers=headers,
            params=params,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        # Get total count from content-range header
        content_range = resp.headers.get("content-range", "")
        total = 0
        if "/" in content_range:
            try:
                total = int(content_range.split("/")[1])
            except (ValueError, IndexError):
                pass

        posts = resp.json()

        # Fetch reaction counts for all posts in batch
        if posts:
            post_ids = [p["id"] for p in posts]
            react_resp = await client.get(
                _sb_url("forum_reactions"),
                headers=_sb_headers_service(),
                params={
                    "select": "post_id,emoji",
                    "post_id": f"in.({','.join(post_ids)})",
                },
            )
            if react_resp.status_code < 400:
                reactions = react_resp.json()
                # Group by post_id
                post_reactions: dict[str, dict[str, int]] = {}
                for r in reactions:
                    pid = r["post_id"]
                    emoji = r["emoji"]
                    post_reactions.setdefault(pid, {})
                    post_reactions[pid][emoji] = post_reactions[pid].get(emoji, 0) + 1
                for p in posts:
                    p["reactions"] = post_reactions.get(p["id"], {})

        return {"posts": posts, "total": total, "page": page, "limit": limit}


@router.get("/posts/{post_id}")
async def get_post(post_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("forum_posts"),
            headers=_sb_headers_service(),
            params={
                "id": f"eq.{post_id}",
                "deleted_at": "is.null",
                "select": "*, author:profiles!author_id(id, display_name), category:forum_categories!category_id(id, name, slug, icon)",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Post not found")

        post = data[0]

        # Increment view count (fire and forget with service key)
        svc_headers = {
            "apikey": config.SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
        }
        await client.patch(
            _sb_url("forum_posts"),
            headers=svc_headers,
            params={"id": f"eq.{post_id}"},
            json={"view_count": post["view_count"] + 1},
        )

        # Fetch reactions
        react_resp = await client.get(
            _sb_url("forum_reactions"),
            headers=_sb_headers_service(),
            params={"post_id": f"eq.{post_id}", "select": "emoji,user_id"},
        )
        if react_resp.status_code < 400:
            reactions_raw = react_resp.json()
            reaction_counts: dict[str, int] = {}
            user_reacted: list[str] = []
            for r in reactions_raw:
                reaction_counts[r["emoji"]] = reaction_counts.get(r["emoji"], 0) + 1
                if r["user_id"] == user.id:
                    user_reacted.append(r["emoji"])
            post["reactions"] = reaction_counts
            post["user_reactions"] = user_reacted

        # Fetch user's vote
        vote_resp = await client.get(
            _sb_url("forum_votes"),
            headers=_sb_headers_service(),
            params={
                "user_id": f"eq.{user.id}",
                "post_id": f"eq.{post_id}",
                "select": "value",
            },
        )
        if vote_resp.status_code < 400:
            votes = vote_resp.json()
            post["user_vote"] = votes[0]["value"] if votes else 0

        # Fetch poll if exists
        poll_resp = await client.get(
            _sb_url("forum_polls"),
            headers=_sb_headers_service(),
            params={
                "post_id": f"eq.{post_id}",
                "select": "*, options:forum_poll_options(id, label, sort_order, vote_count)",
            },
        )
        if poll_resp.status_code < 400:
            polls = poll_resp.json()
            if polls:
                poll = polls[0]
                # Check user's poll votes
                pv_resp = await client.get(
                    _sb_url("forum_poll_votes"),
                    headers=_sb_headers_service(),
                    params={
                        "poll_id": f"eq.{poll['id']}",
                        "user_id": f"eq.{user.id}",
                        "select": "option_id",
                    },
                )
                if pv_resp.status_code < 400:
                    poll["user_votes"] = [v["option_id"] for v in pv_resp.json()]
                post["poll"] = poll

        return post


@router.post("/posts")
async def create_post(req: CreatePostRequest, user: AuthUser = Depends(get_current_user)):
    post_data = {
        "author_id": user.id,
        "category_id": req.category_id,
        "title": req.title,
        "content": req.content,
        "content_format": req.content_format,
        "tags": req.tags,
    }
    if req.image_url:
        post_data["image_url"] = req.image_url
        post_data["image_name"] = req.image_name
    if req.code_snippet:
        post_data["code_snippet"] = req.code_snippet
        post_data["code_language"] = req.code_language

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("forum_posts"),
            headers=_sb_headers_service(),
            json=post_data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        post = resp.json()
        if not post:
            raise HTTPException(status_code=500, detail="Failed to create post")
        post = post[0] if isinstance(post, list) else post

        # Create poll if provided
        if req.poll and req.poll.get("question") and req.poll.get("options"):
            poll_resp = await client.post(
                _sb_url("forum_polls"),
                headers=_sb_headers_service(),
                json={
                    "post_id": post["id"],
                    "question": req.poll["question"],
                    "allow_multiple": req.poll.get("allow_multiple", False),
                    "closes_at": req.poll.get("closes_at"),
                },
            )
            if poll_resp.status_code < 400:
                poll = poll_resp.json()
                poll = poll[0] if isinstance(poll, list) else poll
                # Add options
                for i, label in enumerate(req.poll["options"]):
                    await client.post(
                        _sb_url("forum_poll_options"),
                        headers=_sb_headers_service(),
                        json={
                            "poll_id": poll["id"],
                            "label": label,
                            "sort_order": i,
                        },
                    )

        return post


@router.put("/posts/{post_id}")
async def update_post(
    post_id: str,
    req: UpdatePostRequest,
    user: AuthUser = Depends(get_current_user),
):
    update_data = req.model_dump(exclude_none=True)
    update_data["updated_at"] = datetime.utcnow().isoformat()

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            _sb_url("forum_posts"),
            headers=_sb_headers_service(),
            params={"id": f"eq.{post_id}", "author_id": f"eq.{user.id}"},
            json=update_data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Post not found or not yours")
        return data[0]


@router.delete("/posts/{post_id}")
async def delete_post(post_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            _sb_url("forum_posts"),
            headers=_sb_headers_service(),
            params={"id": f"eq.{post_id}", "author_id": f"eq.{user.id}"},
            json={"deleted_at": datetime.utcnow().isoformat()},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


# ── Comments ─────────────────────────────────────────────────

@router.get("/posts/{post_id}/comments")
async def list_comments(post_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("forum_comments"),
            headers=_sb_headers_service(),
            params={
                "post_id": f"eq.{post_id}",
                "deleted_at": "is.null",
                "order": "created_at.asc",
                "select": "*, author:profiles!author_id(id, display_name)",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        comments = resp.json()

        # Fetch votes for current user on these comments
        if comments:
            comment_ids = [c["id"] for c in comments]
            vote_resp = await client.get(
                _sb_url("forum_votes"),
                headers=_sb_headers_service(),
                params={
                    "user_id": f"eq.{user.id}",
                    "comment_id": f"in.({','.join(comment_ids)})",
                    "select": "comment_id,value",
                },
            )
            user_votes = {}
            if vote_resp.status_code < 400:
                for v in vote_resp.json():
                    user_votes[v["comment_id"]] = v["value"]

            # Fetch reactions
            react_resp = await client.get(
                _sb_url("forum_reactions"),
                headers=_sb_headers_service(),
                params={
                    "comment_id": f"in.({','.join(comment_ids)})",
                    "select": "comment_id,emoji,user_id",
                },
            )
            comment_reactions: dict[str, dict[str, int]] = {}
            comment_user_reactions: dict[str, list[str]] = {}
            if react_resp.status_code < 400:
                for r in react_resp.json():
                    cid = r["comment_id"]
                    comment_reactions.setdefault(cid, {})
                    comment_reactions[cid][r["emoji"]] = comment_reactions[cid].get(r["emoji"], 0) + 1
                    if r["user_id"] == user.id:
                        comment_user_reactions.setdefault(cid, []).append(r["emoji"])

            for c in comments:
                c["user_vote"] = user_votes.get(c["id"], 0)
                c["reactions"] = comment_reactions.get(c["id"], {})
                c["user_reactions"] = comment_user_reactions.get(c["id"], [])

        # Build thread tree
        by_id = {c["id"]: {**c, "children": []} for c in comments}
        roots = []
        for c in comments:
            node = by_id[c["id"]]
            if c["parent_id"] and c["parent_id"] in by_id:
                by_id[c["parent_id"]]["children"].append(node)
            else:
                roots.append(node)

        return roots


@router.post("/posts/{post_id}/comments")
async def create_comment(
    post_id: str,
    req: CreateCommentRequest,
    user: AuthUser = Depends(get_current_user),
):
    comment_data = {
        "post_id": post_id,
        "author_id": user.id,
        "content": req.content,
        "content_format": req.content_format,
    }
    if req.parent_id:
        comment_data["parent_id"] = req.parent_id

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("forum_comments"),
            headers=_sb_headers_service(),
            json=comment_data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        # Update comment count on post (use service key)
        svc_headers = {
            "apikey": config.SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
        }
        # Get current count
        post_resp = await client.get(
            _sb_url("forum_posts"),
            headers=svc_headers,
            params={"id": f"eq.{post_id}", "select": "comment_count"},
        )
        if post_resp.status_code < 400:
            posts = post_resp.json()
            if posts:
                await client.patch(
                    _sb_url("forum_posts"),
                    headers=svc_headers,
                    params={"id": f"eq.{post_id}"},
                    json={"comment_count": posts[0]["comment_count"] + 1},
                )

        data = resp.json()
        return data[0] if isinstance(data, list) else data


@router.put("/comments/{comment_id}")
async def update_comment(
    comment_id: str,
    req: UpdateCommentRequest,
    user: AuthUser = Depends(get_current_user),
):
    update_data = {"content": req.content, "updated_at": datetime.utcnow().isoformat()}
    if req.content_format:
        update_data["content_format"] = req.content_format

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            _sb_url("forum_comments"),
            headers=_sb_headers_service(),
            params={"id": f"eq.{comment_id}", "author_id": f"eq.{user.id}"},
            json=update_data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Comment not found or not yours")
        return data[0]


@router.delete("/comments/{comment_id}")
async def delete_comment(comment_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Get comment to find post_id for count update
        get_resp = await client.get(
            _sb_url("forum_comments"),
            headers=_sb_headers_service(),
            params={"id": f"eq.{comment_id}", "select": "post_id"},
        )

        resp = await client.patch(
            _sb_url("forum_comments"),
            headers=_sb_headers_service(),
            params={"id": f"eq.{comment_id}", "author_id": f"eq.{user.id}"},
            json={"deleted_at": datetime.utcnow().isoformat()},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        # Decrement comment count
        if get_resp.status_code < 400:
            comments = get_resp.json()
            if comments:
                post_id = comments[0]["post_id"]
                svc_headers = {
                    "apikey": config.SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
                    "Content-Type": "application/json",
                }
                post_resp = await client.get(
                    _sb_url("forum_posts"),
                    headers=svc_headers,
                    params={"id": f"eq.{post_id}", "select": "comment_count"},
                )
                if post_resp.status_code < 400:
                    posts = post_resp.json()
                    if posts:
                        new_count = max(0, posts[0]["comment_count"] - 1)
                        await client.patch(
                            _sb_url("forum_posts"),
                            headers=svc_headers,
                            params={"id": f"eq.{post_id}"},
                            json={"comment_count": new_count},
                        )

        return {"ok": True}


# ── Votes ────────────────────────────────────────────────────

async def _handle_vote(target_type: str, target_id: str, value: int, user: AuthUser):
    """Handle upvote/downvote toggle for posts or comments."""
    filter_key = "post_id" if target_type == "post" else "comment_id"
    score_table = "forum_posts" if target_type == "post" else "forum_comments"

    async with httpx.AsyncClient(timeout=10.0) as client:
        # Check existing vote
        resp = await client.get(
            _sb_url("forum_votes"),
            headers=_sb_headers_service(),
            params={
                "user_id": f"eq.{user.id}",
                filter_key: f"eq.{target_id}",
                "select": "id,value",
            },
        )
        existing = resp.json() if resp.status_code < 400 else []

        score_delta = 0
        if existing:
            old_value = existing[0]["value"]
            if old_value == value:
                # Same vote — remove it (toggle off)
                await client.delete(
                    _sb_url("forum_votes"),
                    headers=_sb_headers_service(),
                    params={"id": f"eq.{existing[0]['id']}"},
                )
                score_delta = -old_value
            else:
                # Different vote — update
                await client.patch(
                    _sb_url("forum_votes"),
                    headers=_sb_headers_service(),
                    params={"id": f"eq.{existing[0]['id']}"},
                    json={"value": value},
                )
                score_delta = value - old_value
        else:
            # New vote
            vote_data = {"user_id": user.id, filter_key: target_id, "value": value}
            await client.post(
                _sb_url("forum_votes"),
                headers=_sb_headers_service(),
                json=vote_data,
            )
            score_delta = value

        # Update denormalized score
        if score_delta != 0:
            svc_headers = {
                "apikey": config.SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
            }
            target_resp = await client.get(
                _sb_url(score_table),
                headers=svc_headers,
                params={"id": f"eq.{target_id}", "select": "vote_score"},
            )
            if target_resp.status_code < 400:
                items = target_resp.json()
                if items:
                    new_score = items[0]["vote_score"] + score_delta
                    await client.patch(
                        _sb_url(score_table),
                        headers=svc_headers,
                        params={"id": f"eq.{target_id}"},
                        json={"vote_score": new_score},
                    )

        return {"ok": True, "score_delta": score_delta}


@router.post("/posts/{post_id}/vote")
async def vote_post(post_id: str, req: VoteRequest, user: AuthUser = Depends(get_current_user)):
    if req.value not in (1, -1):
        raise HTTPException(status_code=400, detail="Value must be 1 or -1")
    return await _handle_vote("post", post_id, req.value, user)


@router.post("/comments/{comment_id}/vote")
async def vote_comment(comment_id: str, req: VoteRequest, user: AuthUser = Depends(get_current_user)):
    if req.value not in (1, -1):
        raise HTTPException(status_code=400, detail="Value must be 1 or -1")
    return await _handle_vote("comment", comment_id, req.value, user)


# ── Reactions ────────────────────────────────────────────────

async def _handle_reaction(target_type: str, target_id: str, emoji: str, user: AuthUser):
    """Toggle emoji reaction on post or comment."""
    filter_key = "post_id" if target_type == "post" else "comment_id"

    async with httpx.AsyncClient(timeout=10.0) as client:
        # Check if reaction exists
        resp = await client.get(
            _sb_url("forum_reactions"),
            headers=_sb_headers_service(),
            params={
                "user_id": f"eq.{user.id}",
                filter_key: f"eq.{target_id}",
                "emoji": f"eq.{emoji}",
                "select": "id",
            },
        )
        existing = resp.json() if resp.status_code < 400 else []

        if existing:
            # Remove reaction
            await client.delete(
                _sb_url("forum_reactions"),
                headers=_sb_headers_service(),
                params={"id": f"eq.{existing[0]['id']}"},
            )
            return {"ok": True, "action": "removed"}
        else:
            # Add reaction
            await client.post(
                _sb_url("forum_reactions"),
                headers=_sb_headers_service(),
                json={"user_id": user.id, filter_key: target_id, "emoji": emoji},
            )
            return {"ok": True, "action": "added"}


@router.post("/posts/{post_id}/react")
async def react_post(post_id: str, req: ReactionRequest, user: AuthUser = Depends(get_current_user)):
    return await _handle_reaction("post", post_id, req.emoji, user)


@router.post("/comments/{comment_id}/react")
async def react_comment(comment_id: str, req: ReactionRequest, user: AuthUser = Depends(get_current_user)):
    return await _handle_reaction("comment", comment_id, req.emoji, user)


# ── Polls ────────────────────────────────────────────────────

@router.get("/posts/{post_id}/poll")
async def get_poll(post_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("forum_polls"),
            headers=_sb_headers_service(),
            params={
                "post_id": f"eq.{post_id}",
                "select": "*, options:forum_poll_options(id, label, sort_order, vote_count)",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        polls = resp.json()
        if not polls:
            raise HTTPException(status_code=404, detail="No poll on this post")

        poll = polls[0]
        # Get user votes
        pv_resp = await client.get(
            _sb_url("forum_poll_votes"),
            headers=_sb_headers_service(),
            params={
                "poll_id": f"eq.{poll['id']}",
                "user_id": f"eq.{user.id}",
                "select": "option_id",
            },
        )
        if pv_resp.status_code < 400:
            poll["user_votes"] = [v["option_id"] for v in pv_resp.json()]
        return poll


@router.post("/posts/{post_id}/poll/vote")
async def vote_poll(
    post_id: str,
    req: PollVoteRequest,
    user: AuthUser = Depends(get_current_user),
):
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Get poll
        poll_resp = await client.get(
            _sb_url("forum_polls"),
            headers=_sb_headers_service(),
            params={"post_id": f"eq.{post_id}", "select": "id,allow_multiple,closes_at"},
        )
        if poll_resp.status_code >= 400 or not poll_resp.json():
            raise HTTPException(status_code=404, detail="Poll not found")

        poll = poll_resp.json()[0]

        # Check if poll is closed
        if poll.get("closes_at"):
            closes = datetime.fromisoformat(poll["closes_at"].replace("Z", "+00:00"))
            if datetime.now(closes.tzinfo) > closes:
                raise HTTPException(status_code=400, detail="Poll is closed")

        # Check existing votes
        existing_resp = await client.get(
            _sb_url("forum_poll_votes"),
            headers=_sb_headers_service(),
            params={
                "poll_id": f"eq.{poll['id']}",
                "user_id": f"eq.{user.id}",
                "select": "id,option_id",
            },
        )
        existing = existing_resp.json() if existing_resp.status_code < 400 else []

        svc_headers = {
            "apikey": config.SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
        }

        # Check if already voted for this option (toggle off)
        already_voted = [v for v in existing if v["option_id"] == req.option_id]
        if already_voted:
            # Remove vote
            await client.delete(
                _sb_url("forum_poll_votes"),
                headers=_sb_headers_service(),
                params={"id": f"eq.{already_voted[0]['id']}"},
            )
            # Decrement option vote_count
            opt_resp = await client.get(
                _sb_url("forum_poll_options"),
                headers=svc_headers,
                params={"id": f"eq.{req.option_id}", "select": "vote_count"},
            )
            if opt_resp.status_code < 400 and opt_resp.json():
                new_count = max(0, opt_resp.json()[0]["vote_count"] - 1)
                await client.patch(
                    _sb_url("forum_poll_options"),
                    headers=svc_headers,
                    params={"id": f"eq.{req.option_id}"},
                    json={"vote_count": new_count},
                )
            return {"ok": True, "action": "removed"}

        # If not allow_multiple, remove existing votes first
        if not poll["allow_multiple"] and existing:
            for v in existing:
                await client.delete(
                    _sb_url("forum_poll_votes"),
                    headers=_sb_headers_service(),
                    params={"id": f"eq.{v['id']}"},
                )
                # Decrement old option
                opt_resp = await client.get(
                    _sb_url("forum_poll_options"),
                    headers=svc_headers,
                    params={"id": f"eq.{v['option_id']}", "select": "vote_count"},
                )
                if opt_resp.status_code < 400 and opt_resp.json():
                    new_count = max(0, opt_resp.json()[0]["vote_count"] - 1)
                    await client.patch(
                        _sb_url("forum_poll_options"),
                        headers=svc_headers,
                        params={"id": f"eq.{v['option_id']}"},
                        json={"vote_count": new_count},
                    )

        # Cast vote
        await client.post(
            _sb_url("forum_poll_votes"),
            headers=_sb_headers_service(),
            json={
                "poll_id": poll["id"],
                "option_id": req.option_id,
                "user_id": user.id,
            },
        )

        # Increment option vote_count
        opt_resp = await client.get(
            _sb_url("forum_poll_options"),
            headers=svc_headers,
            params={"id": f"eq.{req.option_id}", "select": "vote_count"},
        )
        if opt_resp.status_code < 400 and opt_resp.json():
            new_count = opt_resp.json()[0]["vote_count"] + 1
            await client.patch(
                _sb_url("forum_poll_options"),
                headers=svc_headers,
                params={"id": f"eq.{req.option_id}"},
                json={"vote_count": new_count},
            )

        return {"ok": True, "action": "voted"}


# ── Upload ───────────────────────────────────────────────────

@router.post("/upload")
async def upload_image(
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    # Validate content type
    content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or ""
    if content_type not in config.ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"File type not allowed: {content_type}")

    data = await file.read()
    if len(data) > config.MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail="File too large (max 5MB)")

    # Save with unique name
    ext = file.filename.rsplit(".", 1)[-1] if file.filename and "." in file.filename else "jpg"
    filename = f"{uuid.uuid4().hex[:12]}.{ext}"
    filepath = config.UPLOADS_DIR / filename

    with open(filepath, "wb") as f:
        f.write(data)

    return {
        "ok": True,
        "url": f"/forum/uploads/{filename}",
        "name": file.filename,
        "size": len(data),
    }


# ── Admin ────────────────────────────────────────────────────

@router.put("/posts/{post_id}/pin")
async def pin_post(post_id: str, req: PinLockRequest, user: AuthUser = Depends(require_admin)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        svc_headers = {
            "apikey": config.SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }
        resp = await client.patch(
            _sb_url("forum_posts"),
            headers=svc_headers,
            params={"id": f"eq.{post_id}"},
            json={"is_pinned": req.value},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True, "is_pinned": req.value}


@router.put("/posts/{post_id}/lock")
async def lock_post(post_id: str, req: PinLockRequest, user: AuthUser = Depends(require_admin)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        svc_headers = {
            "apikey": config.SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }
        resp = await client.patch(
            _sb_url("forum_posts"),
            headers=svc_headers,
            params={"id": f"eq.{post_id}"},
            json={"is_locked": req.value},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True, "is_locked": req.value}


@router.delete("/posts/{post_id}/admin")
async def admin_delete_post(post_id: str, user: AuthUser = Depends(require_admin)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        svc_headers = {
            "apikey": config.SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
        }
        resp = await client.delete(
            _sb_url("forum_posts"),
            headers=svc_headers,
            params={"id": f"eq.{post_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}
