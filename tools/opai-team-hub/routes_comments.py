"""OPAI Team Hub — Comments, checklists, and activity routes."""

import re
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


# ── Mention parsing ──────────────────────────────────────────

_MENTION_RE = re.compile(r"@\[([^\]]+)\]\(([0-9a-f\-]{36})\)")


async def _parse_mentions(client, content: str, item_id: str, author_id: str):
    """Extract @[Name](user_id) mentions and create notifications."""
    headers = _sb_headers_service()
    matches = _MENTION_RE.findall(content)
    if not matches:
        return
    # Get item title for notification
    item_resp = await client.get(
        _sb_url("team_items"), headers=headers,
        params={"id": f"eq.{item_id}", "select": "title"},
    )
    title = ""
    if item_resp.status_code < 400 and item_resp.json():
        title = item_resp.json()[0].get("title", "")
    for display_name, user_id in matches:
        if user_id == author_id:
            continue  # don't notify self
        await client.post(
            _sb_url("team_notifications"), headers=headers,
            json={
                "user_id": user_id,
                "type": "mention",
                "title": f"Mentioned in: {title}" if title else "You were mentioned",
                "body": content[:200],
                "item_id": item_id,
            },
        )


# ── Comments ─────────────────────────────────────────────────

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

        # Parse @mentions and create notifications
        try:
            await _parse_mentions(client, req.content, item_id, user.id)
        except Exception:
            pass  # non-critical

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


# ── Checklists ───────────────────────────────────────────────

class CreateChecklist(BaseModel):
    name: str = "Checklist"


class CreateChecklistItem(BaseModel):
    text: str
    assignee_id: Optional[str] = None


class UpdateChecklistItem(BaseModel):
    text: Optional[str] = None
    checked: Optional[bool] = None
    assignee_id: Optional[str] = None
    orderindex: Optional[int] = None


async def _verify_item_access(client, item_id: str, user_id: str):
    """Verify user has access to the item. Returns workspace_id."""
    headers = _sb_headers_service()
    item_resp = await client.get(
        _sb_url("team_items"), headers=headers,
        params={"id": f"eq.{item_id}", "select": "workspace_id"},
    )
    if item_resp.status_code >= 400 or not item_resp.json():
        raise HTTPException(status_code=404, detail="Item not found")
    ws_id = item_resp.json()[0]["workspace_id"]
    mem_check = await client.get(
        _sb_url("team_membership"), headers=headers,
        params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user_id}"},
    )
    if not mem_check.json():
        raise HTTPException(status_code=404, detail="Item not found")
    return ws_id


@router.get("/items/{item_id}/checklists")
async def list_checklists(item_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _verify_item_access(client, item_id, user.id)
        cl_resp = await client.get(
            _sb_url("team_checklists"), headers=headers,
            params={"item_id": f"eq.{item_id}", "order": "orderindex.asc",
                    "select": "id,name,orderindex,created_at"},
        )
        if cl_resp.status_code >= 400:
            raise HTTPException(status_code=cl_resp.status_code, detail=cl_resp.text)
        checklists = cl_resp.json()

        # Fetch all items for these checklists
        if checklists:
            cl_ids = [c["id"] for c in checklists]
            items_resp = await client.get(
                _sb_url("team_checklist_items"), headers=headers,
                params={
                    "checklist_id": f"in.({','.join(cl_ids)})",
                    "order": "orderindex.asc",
                    "select": "id,checklist_id,text,checked,assignee_id,orderindex",
                },
            )
            cl_items = items_resp.json() if items_resp.status_code < 400 else []
            items_map = {}
            for ci in cl_items:
                items_map.setdefault(ci["checklist_id"], []).append(ci)
            for cl in checklists:
                cl["items"] = items_map.get(cl["id"], [])
        return {"checklists": checklists}


@router.post("/items/{item_id}/checklists")
async def create_checklist(item_id: str, req: CreateChecklist, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _verify_item_access(client, item_id, user.id)
        # Get max orderindex
        existing = await client.get(
            _sb_url("team_checklists"), headers=headers,
            params={"item_id": f"eq.{item_id}", "order": "orderindex.desc", "limit": "1", "select": "orderindex"},
        )
        max_order = existing.json()[0]["orderindex"] + 1 if existing.status_code < 400 and existing.json() else 0
        resp = await client.post(
            _sb_url("team_checklists"), headers=headers,
            json={"item_id": item_id, "name": req.name, "orderindex": max_order},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        result = resp.json()[0]
        result["items"] = []
        return result


@router.delete("/checklists/{checklist_id}")
async def delete_checklist(checklist_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Get checklist to find item_id
        cl_resp = await client.get(
            _sb_url("team_checklists"), headers=headers,
            params={"id": f"eq.{checklist_id}", "select": "item_id"},
        )
        if cl_resp.status_code >= 400 or not cl_resp.json():
            raise HTTPException(status_code=404, detail="Checklist not found")
        await _verify_item_access(client, cl_resp.json()[0]["item_id"], user.id)
        resp = await client.delete(
            _sb_url("team_checklists"), headers=headers,
            params={"id": f"eq.{checklist_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


@router.post("/checklists/{checklist_id}/items")
async def create_checklist_item(checklist_id: str, req: CreateChecklistItem, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        cl_resp = await client.get(
            _sb_url("team_checklists"), headers=headers,
            params={"id": f"eq.{checklist_id}", "select": "item_id"},
        )
        if cl_resp.status_code >= 400 or not cl_resp.json():
            raise HTTPException(status_code=404, detail="Checklist not found")
        await _verify_item_access(client, cl_resp.json()[0]["item_id"], user.id)
        # Get max orderindex
        existing = await client.get(
            _sb_url("team_checklist_items"), headers=headers,
            params={"checklist_id": f"eq.{checklist_id}", "order": "orderindex.desc", "limit": "1", "select": "orderindex"},
        )
        max_order = existing.json()[0]["orderindex"] + 1 if existing.status_code < 400 and existing.json() else 0
        data = {"checklist_id": checklist_id, "text": req.text, "orderindex": max_order}
        if req.assignee_id:
            data["assignee_id"] = req.assignee_id
        resp = await client.post(
            _sb_url("team_checklist_items"), headers=headers, json=data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.patch("/checklist-items/{ci_id}")
async def update_checklist_item(ci_id: str, req: UpdateChecklistItem, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        ci_resp = await client.get(
            _sb_url("team_checklist_items"), headers=headers,
            params={"id": f"eq.{ci_id}", "select": "checklist_id"},
        )
        if ci_resp.status_code >= 400 or not ci_resp.json():
            raise HTTPException(status_code=404, detail="Checklist item not found")
        cl_resp = await client.get(
            _sb_url("team_checklists"), headers=headers,
            params={"id": f"eq.{ci_resp.json()[0]['checklist_id']}", "select": "item_id"},
        )
        if cl_resp.status_code >= 400 or not cl_resp.json():
            raise HTTPException(status_code=404, detail="Checklist not found")
        await _verify_item_access(client, cl_resp.json()[0]["item_id"], user.id)
        update = {k: v for k, v in req.model_dump().items() if v is not None}
        if not update:
            return ci_resp.json()[0]
        resp = await client.patch(
            _sb_url("team_checklist_items"), headers=headers,
            params={"id": f"eq.{ci_id}"}, json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/checklist-items/{ci_id}")
async def delete_checklist_item(ci_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        ci_resp = await client.get(
            _sb_url("team_checklist_items"), headers=headers,
            params={"id": f"eq.{ci_id}", "select": "checklist_id"},
        )
        if ci_resp.status_code >= 400 or not ci_resp.json():
            raise HTTPException(status_code=404, detail="Checklist item not found")
        cl_resp = await client.get(
            _sb_url("team_checklists"), headers=headers,
            params={"id": f"eq.{ci_resp.json()[0]['checklist_id']}", "select": "item_id"},
        )
        if cl_resp.status_code >= 400 or not cl_resp.json():
            raise HTTPException(status_code=404, detail="Checklist not found")
        await _verify_item_access(client, cl_resp.json()[0]["item_id"], user.id)
        resp = await client.delete(
            _sb_url("team_checklist_items"), headers=headers,
            params={"id": f"eq.{ci_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}
