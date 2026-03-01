"""OPAI Team Hub — ClickUp API proxy routes."""

from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import config
from auth import get_current_user, AuthUser

router = APIRouter(prefix="/api/clickup")

TIMEOUT = 15.0


def _cu_headers():
    return {"Authorization": config.CLICKUP_API_KEY}


# ── Spaces ────────────────────────────────────────────────────

@router.get("/spaces")
async def list_spaces(user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            f"{config.CLICKUP_BASE}/team/{config.CLICKUP_TEAM_ID}/space",
            headers=_cu_headers(),
            params={"archived": "false"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        spaces = data.get("spaces", [])
        return {"spaces": [
            {"id": s["id"], "name": s["name"], "color": s.get("color", "#595d66"),
             "statuses": [st.get("status", "") for st in s.get("statuses", [])]}
            for s in spaces
        ]}


# ── Folders + Lists ───────────────────────────────────────────

@router.get("/spaces/{space_id}/hierarchy")
async def space_hierarchy(space_id: str, user: AuthUser = Depends(get_current_user)):
    """Get folders and folderless lists for a space."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        folders_resp = await client.get(
            f"{config.CLICKUP_BASE}/space/{space_id}/folder",
            headers=_cu_headers(),
        )
        lists_resp = await client.get(
            f"{config.CLICKUP_BASE}/space/{space_id}/list",
            headers=_cu_headers(),
        )

        folders = []
        if folders_resp.status_code < 400:
            for f in folders_resp.json().get("folders", []):
                folders.append({
                    "id": f["id"],
                    "name": f["name"],
                    "lists": [{"id": lst["id"], "name": lst["name"],
                               "task_count": lst.get("task_count", 0)}
                              for lst in f.get("lists", [])],
                })

        folderless = []
        if lists_resp.status_code < 400:
            for lst in lists_resp.json().get("lists", []):
                folderless.append({
                    "id": lst["id"],
                    "name": lst["name"],
                    "task_count": lst.get("task_count", 0),
                })

        return {"folders": folders, "folderless_lists": folderless}


# ── Tasks ─────────────────────────────────────────────────────

@router.get("/lists/{list_id}/tasks")
async def list_tasks(
    list_id: str,
    include_closed: bool = False,
    page: int = 0,
    user: AuthUser = Depends(get_current_user),
):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            f"{config.CLICKUP_BASE}/list/{list_id}/task",
            headers=_cu_headers(),
            params={
                "include_closed": str(include_closed).lower(),
                "subtasks": "true",
                "page": str(page),
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        data = resp.json()
        tasks = []
        for t in data.get("tasks", []):
            status_obj = t.get("status", {})
            status = status_obj.get("status", "open") if isinstance(status_obj, dict) else str(status_obj)
            priority_obj = t.get("priority")
            priority = priority_obj.get("priority", "normal") if isinstance(priority_obj, dict) else None

            tasks.append({
                "id": t["id"],
                "name": t.get("name", ""),
                "status": status,
                "status_color": status_obj.get("color", "") if isinstance(status_obj, dict) else "",
                "priority": priority,
                "assignees": [
                    {"username": a.get("username", ""), "email": a.get("email", ""),
                     "initials": a.get("initials", "")}
                    for a in t.get("assignees", [])
                ],
                "tags": [tg.get("name", "") if isinstance(tg, dict) else str(tg)
                         for tg in t.get("tags", [])],
                "due_date": t.get("due_date"),
                "url": t.get("url", ""),
                "date_created": t.get("date_created"),
                "date_updated": t.get("date_updated"),
            })

        return {"tasks": tasks, "last_page": data.get("last_page", True)}


@router.get("/tasks/{task_id}")
async def get_task(task_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            f"{config.CLICKUP_BASE}/task/{task_id}",
            headers=_cu_headers(),
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        t = resp.json()

        status_obj = t.get("status", {})
        status = status_obj.get("status", "open") if isinstance(status_obj, dict) else str(status_obj)
        priority_obj = t.get("priority")
        priority = priority_obj.get("priority", "normal") if isinstance(priority_obj, dict) else None

        # Fetch comments
        comments_resp = await client.get(
            f"{config.CLICKUP_BASE}/task/{task_id}/comment",
            headers=_cu_headers(),
        )
        comments = []
        if comments_resp.status_code < 400:
            for c in comments_resp.json().get("comments", []):
                text_parts = []
                for part in c.get("comment", []):
                    text_parts.append(part.get("text", ""))
                text = "".join(text_parts)
                if not text.strip():
                    text = c.get("comment_text", "")

                user_info = c.get("user", {})
                comments.append({
                    "id": c.get("id", ""),
                    "author": user_info.get("username", "Unknown"),
                    "author_email": user_info.get("email", ""),
                    "author_initials": user_info.get("initials", ""),
                    "text": text,
                    "date": c.get("date", ""),
                })

        return {
            "id": t["id"],
            "name": t.get("name", ""),
            "description": t.get("description", ""),
            "status": status,
            "status_color": status_obj.get("color", "") if isinstance(status_obj, dict) else "",
            "priority": priority,
            "assignees": [
                {"username": a.get("username", ""), "email": a.get("email", ""),
                 "initials": a.get("initials", "")}
                for a in t.get("assignees", [])
            ],
            "creator": {
                "username": t.get("creator", {}).get("username", ""),
                "email": t.get("creator", {}).get("email", ""),
            },
            "tags": [tg.get("name", "") if isinstance(tg, dict) else str(tg)
                     for tg in t.get("tags", [])],
            "due_date": t.get("due_date"),
            "start_date": t.get("start_date"),
            "url": t.get("url", ""),
            "list": {"id": t.get("list", {}).get("id", ""),
                     "name": t.get("list", {}).get("name", "")},
            "folder": {"id": t.get("folder", {}).get("id", ""),
                       "name": t.get("folder", {}).get("name", "")},
            "space": {"id": t.get("space", {}).get("id", "")},
            "custom_fields": [
                {"name": cf.get("name", ""), "type": cf.get("type", ""),
                 "value": cf.get("value")}
                for cf in t.get("custom_fields", []) if cf.get("value") is not None
            ],
            "comments": comments,
            "date_created": t.get("date_created"),
            "date_updated": t.get("date_updated"),
        }


class PostComment(BaseModel):
    comment_text: str
    notify_all: bool = False


@router.post("/tasks/{task_id}/comment")
async def post_comment(task_id: str, req: PostComment, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{config.CLICKUP_BASE}/task/{task_id}/comment",
            headers={**_cu_headers(), "Content-Type": "application/json"},
            json={
                "comment_text": req.comment_text,
                "notify_all": req.notify_all,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


# ── Update Task ───────────────────────────────────────────────

class UpdateClickUpTask(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[int] = None  # 1=urgent, 2=high, 3=normal, 4=low
    due_date: Optional[int] = None  # ms timestamp


@router.put("/tasks/{task_id}")
async def update_task(task_id: str, req: UpdateClickUpTask, user: AuthUser = Depends(get_current_user)):
    body = {k: v for k, v in req.model_dump().items() if v is not None}
    if not body:
        return {"ok": True}

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.put(
            f"{config.CLICKUP_BASE}/task/{task_id}",
            headers={**_cu_headers(), "Content-Type": "application/json"},
            json=body,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


# ── Members ───────────────────────────────────────────────────

@router.get("/members")
async def list_members(user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            f"{config.CLICKUP_BASE}/team/{config.CLICKUP_TEAM_ID}",
            headers=_cu_headers(),
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        team = resp.json().get("team", {})
        members = team.get("members", [])
        return {"members": [
            {"id": m.get("user", {}).get("id", ""),
             "username": m.get("user", {}).get("username", ""),
             "email": m.get("user", {}).get("email", ""),
             "initials": m.get("user", {}).get("initials", ""),
             "role": m.get("user", {}).get("role", 0)}
            for m in members
        ]}
