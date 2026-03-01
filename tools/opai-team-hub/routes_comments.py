"""OPAI Team Hub — Comments and activity routes."""

from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import config
from auth import get_current_user, AuthUser

router = APIRouter(prefix="/api")


def _sb_headers_service():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


class CreateComment(BaseModel):
    content: str
    is_agent_report: bool = False


class UpdateComment(BaseModel):
    content: str


@router.get("/items/{item_id}/comments")
async def list_comments(
    item_id: str,
    limit: int = Query(default=50, le=200),
    user: AuthUser = Depends(get_current_user),
):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Verify user can access this item
        item_resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}", "select": "workspace_id"},
        )
        if item_resp.status_code >= 400 or not item_resp.json():
            raise HTTPException(status_code=404, detail="Item not found")

        ws_id = item_resp.json()[0]["workspace_id"]
        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Item not found")

        resp = await client.get(
            _sb_url("team_comments"),
            headers=headers,
            params={
                "item_id": f"eq.{item_id}",
                "order": "created_at.asc",
                "limit": str(limit),
                "select": "id,author_id,content,is_agent_report,created_at,updated_at",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        comments = resp.json()

        # Enrich with author info
        if comments:
            author_ids = list({c["author_id"] for c in comments})
            profiles_resp = await client.get(
                _sb_url("profiles"),
                headers=headers,
                params={
                    "id": f"in.({','.join(author_ids)})",
                    "select": "id,display_name,email",
                },
            )
            if profiles_resp.status_code < 400:
                profile_map = {p["id"]: p for p in profiles_resp.json()}
                for c in comments:
                    p = profile_map.get(c["author_id"], {})
                    c["author_name"] = p.get("display_name", p.get("email", "Unknown"))

        return {"comments": comments}


@router.post("/items/{item_id}/comments")
async def create_comment(item_id: str, req: CreateComment, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        item_resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}", "select": "workspace_id"},
        )
        if item_resp.status_code >= 400 or not item_resp.json():
            raise HTTPException(status_code=404, detail="Item not found")

        ws_id = item_resp.json()[0]["workspace_id"]
        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Item not found")

        resp = await client.post(
            _sb_url("team_comments"),
            headers=headers,
            json={
                "item_id": item_id,
                "author_id": user.id,
                "content": req.content,
                "is_agent_report": req.is_agent_report,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        # Log activity
        await client.post(
            _sb_url("team_activity"),
            headers=headers,
            json={
                "workspace_id": ws_id,
                "item_id": item_id,
                "actor_id": user.id,
                "action": "comment_added",
                "details": {"preview": req.content[:100]},
            },
        )

        return resp.json()[0]


@router.patch("/comments/{comment_id}")
async def update_comment(comment_id: str, req: UpdateComment, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Fetch the comment and verify the user is the author
        comment_resp = await client.get(
            _sb_url("team_comments"),
            headers=headers,
            params={"id": f"eq.{comment_id}", "select": "id,author_id,item_id"},
        )
        if comment_resp.status_code >= 400 or not comment_resp.json():
            raise HTTPException(status_code=404, detail="Comment not found")

        comment = comment_resp.json()[0]
        if comment["author_id"] != user.id:
            raise HTTPException(status_code=403, detail="You can only edit your own comments")

        # Update the comment
        resp = await client.patch(
            _sb_url("team_comments"),
            headers=headers,
            params={"id": f"eq.{comment_id}"},
            json={
                "content": req.content,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        return resp.json()[0]
