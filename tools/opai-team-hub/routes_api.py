"""OPAI Team Hub — Core REST API routes."""

import asyncio
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import config
from auth import get_current_user, require_admin, AuthUser
from audit import log_audit
from routes_comments import _parse_mentions

router = APIRouter(prefix="/api")


# ── Supabase helpers ─────────────────────────────────────────

def _sb_headers_service():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


async def _log_activity(client: httpx.AsyncClient, workspace_id: str, action: str,
                        actor_id: str, item_id: str = None, details: dict = None):
    await client.post(
        _sb_url("team_activity"),
        headers=_sb_headers_service(),
        json={
            "workspace_id": workspace_id,
            "action": action,
            "actor_id": actor_id,
            "item_id": item_id,
            "details": details or {},
        },
    )


async def _notify(client: httpx.AsyncClient, user_id: str, notify_type: str,
                  title: str, body: str, item_id: str = None,
                  workspace_id: str = None, skip_user_id: str = None):
    """Create a notification for a user (skip if user == skip_user_id)."""
    if user_id == skip_user_id:
        return
    payload = {
        "user_id": user_id,
        "type": notify_type,
        "title": title,
        "body": body,
    }
    if item_id:
        payload["item_id"] = item_id
    if workspace_id:
        payload["workspace_id"] = workspace_id
    await client.post(
        _sb_url("team_notifications"),
        headers=_sb_headers_service(),
        json=payload,
    )


async def _get_item_assignees(client: httpx.AsyncClient, item_id: str) -> list[str]:
    """Return list of assignee_id for an item."""
    resp = await client.get(
        _sb_url("team_assignments"),
        headers=_sb_headers_service(),
        params={"item_id": f"eq.{item_id}", "select": "assignee_id"},
    )
    if resp.status_code >= 400:
        return []
    return [a["assignee_id"] for a in resp.json()]


async def _spawn_recurring_task(client: httpx.AsyncClient, headers: dict, item: dict, actor_id: str):
    """If the item has recurrence, create the next occurrence with carried-forward data."""
    recurrence = item.get("recurrence")
    if not recurrence or not isinstance(recurrence, dict):
        return
    freq = recurrence.get("frequency")
    if not freq:
        return

    interval = recurrence.get("interval", 1)
    carry_desc = recurrence.get("carry_description", True)
    carry_comments = recurrence.get("carry_comments", False)

    # Calculate next due date
    base_date = item.get("due_date")
    if base_date:
        from dateutil.relativedelta import relativedelta
        try:
            base = datetime.fromisoformat(base_date[:10])
        except Exception:
            base = datetime.now(timezone.utc)
    else:
        base = datetime.now(timezone.utc)

    if freq == "daily":
        next_due = base + timedelta(days=interval)
    elif freq == "weekly":
        next_due = base + timedelta(weeks=interval)
    elif freq == "monthly":
        try:
            from dateutil.relativedelta import relativedelta
            next_due = base + relativedelta(months=interval)
        except ImportError:
            next_due = base + timedelta(days=30 * interval)
    elif freq == "yearly":
        try:
            from dateutil.relativedelta import relativedelta
            next_due = base + relativedelta(years=interval)
        except ImportError:
            next_due = base + timedelta(days=365 * interval)
    else:
        return

    next_due_str = next_due.strftime("%Y-%m-%d")
    # Update the recurrence with the new next_due for tracking
    new_recurrence = {**recurrence, "next_due": next_due_str}

    new_item = {
        "workspace_id": item.get("workspace_id"),
        "list_id": item.get("list_id"),
        "folder_id": item.get("folder_id"),
        "type": item.get("type", "task"),
        "title": item.get("title"),
        "status": "open",
        "priority": item.get("priority", "none"),
        "due_date": next_due_str,
        "created_by": actor_id,
        "source": "recurrence",
        "recurrence": new_recurrence,
        "links": item.get("links") or [],
    }
    if carry_desc:
        new_item["description"] = item.get("description", "")

    resp = await client.post(
        _sb_url("team_items"),
        headers=headers,
        json=new_item,
    )
    if resp.status_code >= 400:
        return

    new_id = resp.json()[0]["id"]

    # Carry forward assignments
    assign_resp = await client.get(
        _sb_url("team_assignments"),
        headers=headers,
        params={"item_id": f"eq.{item['id']}", "select": "assignee_id"},
    )
    if assign_resp.status_code < 400:
        for a in assign_resp.json():
            await client.post(
                _sb_url("team_assignments"),
                headers=headers,
                json={"item_id": new_id, "assignee_id": a["assignee_id"]},
            )

    # Carry forward tags
    tag_resp = await client.get(
        _sb_url("team_item_tags"),
        headers=headers,
        params={"item_id": f"eq.{item['id']}", "select": "tag_id"},
    )
    if tag_resp.status_code < 400:
        for t in tag_resp.json():
            await client.post(
                _sb_url("team_item_tags"),
                headers=headers,
                json={"item_id": new_id, "tag_id": t["tag_id"]},
            )

    # Carry forward comments if requested
    if carry_comments:
        comment_resp = await client.get(
            _sb_url("team_comments"),
            headers=headers,
            params={"item_id": f"eq.{item['id']}", "select": "author_id,content,is_agent_report", "order": "created_at.asc"},
        )
        if comment_resp.status_code < 400:
            for c in comment_resp.json():
                await client.post(
                    _sb_url("team_comments"),
                    headers=headers,
                    json={"item_id": new_id, "author_id": c["author_id"], "content": c["content"], "is_agent_report": c.get("is_agent_report", False)},
                )

    await _log_activity(client, item.get("workspace_id"), "recurring_task_spawned", actor_id, new_id,
                        {"source_item_id": item["id"], "frequency": freq})


# ── Auth Config ──────────────────────────────────────────────

@router.get("/auth/config")
def auth_config():
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── Request models ───────────────────────────────────────────

class CreateWorkspace(BaseModel):
    name: str
    icon: str = "📁"
    hub_id: Optional[str] = None


class UpdateWorkspace(BaseModel):
    name: Optional[str] = None
    icon: Optional[str] = None


class CreateItem(BaseModel):
    type: str = "task"
    title: str
    description: str = ""
    priority: str = "medium"
    due_date: Optional[str] = None
    start_date: Optional[str] = None
    follow_up_date: Optional[str] = None
    time_estimate: Optional[int] = None
    source: str = "web"
    parent_id: Optional[str] = None


class UpdateItem(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    due_date: Optional[str] = None
    start_date: Optional[str] = None
    follow_up_date: Optional[str] = None
    time_estimate: Optional[int] = None
    list_id: Optional[str] = None
    folder_id: Optional[str] = None
    links: Optional[list] = None
    recurrence: Optional[dict] = None


class BatchOperation(BaseModel):
    item_ids: List[str]
    action: str  # "delete", "update", "assign"
    update: Optional[dict] = None  # For "update": fields to set (status, priority, list_id, etc.)
    assignee_id: Optional[str] = None  # For "assign"


class AssignItem(BaseModel):
    assignee_type: str = "user"
    assignee_id: str


class InviteMember(BaseModel):
    email: str
    role: str = "member"


class UpdateMemberRole(BaseModel):
    role: str  # "admin", "member", "viewer"


class CreateTag(BaseModel):
    name: str
    color: str = "#6366f1"


class UpdateTag(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None


class AddTag(BaseModel):
    tag_id: str


class MarkRead(BaseModel):
    notification_ids: list[str] = []


class UpdateDiscordSettings(BaseModel):
    discord_server_id: Optional[str] = None
    discord_channel_id: Optional[str] = None
    bot_prompt: Optional[str] = None


class ReorderWorkspaces(BaseModel):
    workspace_ids: list[str]


# ── Workspaces ───────────────────────────────────────────────

def _slugify(name: str) -> str:
    import re
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    return slug or 'workspace'


@router.get("/workspaces")
async def list_workspaces(user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Get workspace IDs user is a member of
        mem_resp = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "workspace_id,role,orderindex"},
        )
        if mem_resp.status_code >= 400:
            raise HTTPException(status_code=mem_resp.status_code, detail=mem_resp.text)

        memberships = mem_resp.json()
        ws_ids = [m["workspace_id"] for m in memberships] if memberships else []
        role_map = {m["workspace_id"]: m["role"] for m in memberships}
        order_map = {m["workspace_id"]: m.get("orderindex", 0) or 0 for m in memberships}

        # Also get hub workspaces user can see via hub membership
        hub_resp = await client.get(
            _sb_url("team_hub_membership"),
            headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "hub_id,role"},
        )
        hub_memberships = hub_resp.json() if hub_resp.status_code < 400 else []
        hub_ids = [h["hub_id"] for h in hub_memberships]
        hub_role_map = {h["hub_id"]: h["role"] for h in hub_memberships}

        # Get hub workspaces not already in user's direct membership
        hub_ws_ids = []
        if hub_ids:
            hub_ws_resp = await client.get(
                _sb_url("team_workspaces"),
                headers=headers,
                params={
                    "hub_id": f"in.({','.join(hub_ids)})",
                    "select": "id",
                },
            )
            if hub_ws_resp.status_code < 400:
                hub_ws_ids = [w["id"] for w in hub_ws_resp.json() if w["id"] not in ws_ids]
                for wid in hub_ws_ids:
                    if wid not in role_map:
                        role_map[wid] = "member"
                        order_map[wid] = 999

        all_ids = list(set(ws_ids + hub_ws_ids))
        if not all_ids:
            return {"workspaces": [], "hubs": []}

        ws_resp = await client.get(
            _sb_url("team_workspaces"),
            headers=headers,
            params={
                "id": f"in.({','.join(all_ids)})",
                "select": "id,name,slug,icon,owner_id,is_personal,color,description,hub_id,created_at",
            },
        )
        if ws_resp.status_code >= 400:
            raise HTTPException(status_code=ws_resp.status_code, detail=ws_resp.text)

        workspaces = ws_resp.json()
        for ws in workspaces:
            ws["my_role"] = role_map.get(ws["id"], "member")
            ws["orderindex"] = order_map.get(ws["id"], 0)
            # If workspace is in a hub, include hub role
            if ws.get("hub_id") and ws["hub_id"] in hub_role_map:
                ws["hub_role"] = hub_role_map[ws["hub_id"]]

        # Sort: by orderindex first, then personal spaces, then name
        workspaces.sort(key=lambda w: (w["orderindex"], not w.get("is_personal", False), w["name"].lower()))

        # Include hub info
        hubs = []
        if hub_ids:
            hubs_resp = await client.get(
                _sb_url("team_hubs"),
                headers=headers,
                params={"id": f"in.({','.join(hub_ids)})", "select": "id,name,slug,icon,color"},
            )
            if hubs_resp.status_code < 400:
                hubs = hubs_resp.json()
                for h in hubs:
                    h["my_role"] = hub_role_map.get(h["id"], "member")

        return {"workspaces": workspaces, "hubs": hubs}


@router.post("/workspaces/reorder")
async def reorder_workspaces(req: ReorderWorkspaces, user: AuthUser = Depends(get_current_user)):
    """Update the display order of workspaces for the current user."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        for idx, ws_id in enumerate(req.workspace_ids):
            await client.patch(
                _sb_url("team_membership"),
                headers=headers,
                params={
                    "user_id": f"eq.{user.id}",
                    "workspace_id": f"eq.{ws_id}",
                },
                json={"orderindex": idx},
            )
    return {"ok": True}


@router.post("/workspaces")
async def create_workspace(req: CreateWorkspace, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    slug = _slugify(req.name)
    # Ensure unique slug
    import time
    slug = f"{slug}-{int(time.time()) % 100000}"

    # If no explicit hub_id, auto-detect from user's hub membership
    hub_id = req.hub_id
    if not hub_id:
        hub_resp = await httpx.AsyncClient(timeout=5.0).get(
            _sb_url("team_hub_membership"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "hub_id", "limit": "1"},
        )
        if hub_resp.status_code < 400 and hub_resp.json():
            hub_id = hub_resp.json()[0]["hub_id"]

    async with httpx.AsyncClient(timeout=10.0) as client:
        ws_payload = {
            "name": req.name,
            "slug": slug,
            "icon": req.icon,
            "owner_id": user.id,
            "is_personal": False,
        }
        if hub_id:
            ws_payload["hub_id"] = hub_id

        ws_resp = await client.post(
            _sb_url("team_workspaces"),
            headers=headers,
            json=ws_payload,
        )
        if ws_resp.status_code >= 400:
            raise HTTPException(status_code=ws_resp.status_code, detail=ws_resp.text)

        workspace = ws_resp.json()[0]

        # Add creator as owner member
        await client.post(
            _sb_url("team_membership"),
            headers=headers,
            json={
                "user_id": user.id,
                "workspace_id": workspace["id"],
                "role": "owner",
            },
        )

        # If hub-bound, add all other hub members to this workspace
        if hub_id:
            hub_mem_resp = await client.get(
                _sb_url("team_hub_membership"), headers=headers,
                params={"hub_id": f"eq.{hub_id}", "user_id": f"neq.{user.id}", "select": "user_id"},
            )
            for hm in (hub_mem_resp.json() if hub_mem_resp.status_code < 400 else []):
                await client.post(
                    _sb_url("team_membership"), headers=headers,
                    json={"user_id": hm["user_id"], "workspace_id": workspace["id"], "role": "member"},
                )

        await _log_activity(client, workspace["id"], "workspace_created", user.id,
                            details={"name": req.name, "hub_id": hub_id})

        return workspace


@router.get("/workspaces/{ws_id}")
async def get_workspace(ws_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Verify membership
        mem_resp = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if mem_resp.status_code >= 400 or not mem_resp.json():
            raise HTTPException(status_code=404, detail="Workspace not found")

        ws_resp = await client.get(
            _sb_url("team_workspaces"),
            headers=headers,
            params={"id": f"eq.{ws_id}"},
        )
        if ws_resp.status_code >= 400:
            raise HTTPException(status_code=ws_resp.status_code, detail=ws_resp.text)
        data = ws_resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Workspace not found")

        ws = data[0]
        ws["my_role"] = mem_resp.json()[0]["role"]
        return ws


@router.patch("/workspaces/{ws_id}")
async def update_workspace(ws_id: str, req: UpdateWorkspace, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        mem_resp = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if mem_resp.status_code >= 400 or not mem_resp.json():
            raise HTTPException(status_code=404, detail="Workspace not found")
        role = mem_resp.json()[0]["role"]
        if role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Admin access required")

        update = {k: v for k, v in req.model_dump().items() if v is not None}
        update["updated_at"] = datetime.now(timezone.utc).isoformat()

        resp = await client.patch(
            _sb_url("team_workspaces"),
            headers=headers,
            params={"id": f"eq.{ws_id}"},
            json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/workspaces/{ws_id}")
async def delete_workspace(ws_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        ws_resp = await client.get(
            _sb_url("team_workspaces"),
            headers=headers,
            params={"id": f"eq.{ws_id}"},
        )
        if ws_resp.status_code >= 400 or not ws_resp.json():
            raise HTTPException(status_code=404, detail="Workspace not found")
        ws = ws_resp.json()[0]
        if ws["owner_id"] != user.id:
            raise HTTPException(status_code=403, detail="Owner access required")

        resp = await client.delete(
            _sb_url("team_workspaces"),
            headers=headers,
            params={"id": f"eq.{ws_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


# ── Members ──────────────────────────────────────────────────

@router.get("/workspaces/{ws_id}/members")
async def list_members(ws_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Verify membership
        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Workspace not found")

        resp = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "select": "id,user_id,role,created_at"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        members = resp.json()
        # Enrich with profile info
        if members:
            user_ids = [m["user_id"] for m in members]
            profiles_resp = await client.get(
                _sb_url("profiles"),
                headers=headers,
                params={
                    "id": f"in.({','.join(user_ids)})",
                    "select": "id,email,display_name,is_active",
                },
            )
            if profiles_resp.status_code < 400:
                profile_map = {p["id"]: p for p in profiles_resp.json()}
                for m in members:
                    p = profile_map.get(m["user_id"], {})
                    m["email"] = p.get("email", "")
                    m["display_name"] = p.get("display_name", "")

        return {"members": members}


@router.post("/workspaces/{ws_id}/invite")
async def invite_member(ws_id: str, req: InviteMember, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Verify caller is admin/owner
        mem_resp = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_resp.json() or mem_resp.json()[0]["role"] not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Admin access required")

        # Find invitee by email
        profile_resp = await client.get(
            _sb_url("profiles"),
            headers=headers,
            params={"email": f"eq.{req.email}", "select": "id"},
        )
        invitee_id = None
        if profile_resp.status_code < 400 and profile_resp.json():
            invitee_id = profile_resp.json()[0]["id"]

            # Check if already a member
            existing = await client.get(
                _sb_url("team_membership"),
                headers=headers,
                params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{invitee_id}"},
            )
            if existing.json():
                raise HTTPException(status_code=400, detail="User is already a member")

        resp = await client.post(
            _sb_url("team_invitations"),
            headers=headers,
            json={
                "workspace_id": ws_id,
                "inviter_id": user.id,
                "invitee_id": invitee_id,
                "invitee_email": req.email,
                "role": req.role,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


class AddMember(BaseModel):
    user_id: str
    role: str = "member"


@router.post("/workspaces/{ws_id}/add-member")
async def add_member(ws_id: str, req: AddMember, user: AuthUser = Depends(get_current_user)):
    """Directly add an existing OPAI user to a workspace."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Verify caller is admin/owner
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_resp.json() or mem_resp.json()[0]["role"] not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Admin access required")

        # Check if already a member
        existing = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{req.user_id}"},
        )
        if existing.json():
            raise HTTPException(status_code=400, detail="User is already a member")

        # Add membership directly
        resp = await client.post(
            _sb_url("team_membership"), headers=headers,
            json={"workspace_id": ws_id, "user_id": req.user_id, "role": req.role},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        await _log_activity(client, ws_id, "member_added", user.id)
        return resp.json()[0]


@router.delete("/workspaces/{ws_id}/members/{member_user_id}")
async def remove_member(ws_id: str, member_user_id: str, user: AuthUser = Depends(get_current_user)):
    """Remove a member from a workspace."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Verify caller is admin/owner
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_resp.json() or mem_resp.json()[0]["role"] not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Admin access required")

        # Don't allow removing yourself
        if member_user_id == user.id:
            raise HTTPException(status_code=400, detail="Cannot remove yourself")

        # Delete the membership
        resp = await client.delete(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{member_user_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        await _log_activity(client, ws_id, "member_removed", user.id)
        return {"ok": True}


@router.patch("/workspaces/{ws_id}/members/{member_user_id}")
async def update_member_role(ws_id: str, member_user_id: str, req: UpdateMemberRole, user: AuthUser = Depends(get_current_user)):
    """Update a member's role in a workspace. Only owners can change roles."""
    if req.role not in ("admin", "member", "viewer"):
        raise HTTPException(status_code=400, detail="Invalid role. Must be admin, member, or viewer")
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Verify caller is owner
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_resp.json() or mem_resp.json()[0]["role"] != "owner":
            raise HTTPException(status_code=403, detail="Only the workspace owner can change roles")

        # Can't change own role
        if member_user_id == user.id:
            raise HTTPException(status_code=400, detail="Cannot change your own role")

        # Verify target is a member
        target_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{member_user_id}"},
        )
        if not target_resp.json():
            raise HTTPException(status_code=404, detail="Member not found")

        resp = await client.patch(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{member_user_id}"},
            json={"role": req.role},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        await _log_activity(client, ws_id, "member_role_changed", user.id,
                            details={"target_user_id": member_user_id, "new_role": req.role})
        return resp.json()[0]


@router.post("/invitations/{inv_id}/accept")
async def accept_invitation(inv_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        inv_resp = await client.get(
            _sb_url("team_invitations"),
            headers=headers,
            params={"id": f"eq.{inv_id}"},
        )
        if inv_resp.status_code >= 400 or not inv_resp.json():
            raise HTTPException(status_code=404, detail="Invitation not found")

        inv = inv_resp.json()[0]
        if inv["invitee_id"] and inv["invitee_id"] != user.id:
            raise HTTPException(status_code=403, detail="Not your invitation")

        # Add membership
        await client.post(
            _sb_url("team_membership"),
            headers=headers,
            json={
                "user_id": user.id,
                "workspace_id": inv["workspace_id"],
                "role": inv["role"],
            },
        )

        # Update invitation status
        await client.patch(
            _sb_url("team_invitations"),
            headers=headers,
            params={"id": f"eq.{inv_id}"},
            json={"status": "accepted", "updated_at": datetime.now(timezone.utc).isoformat()},
        )

        await _log_activity(client, inv["workspace_id"], "member_joined", user.id)

        return {"ok": True}


@router.post("/invitations/{inv_id}/decline")
async def decline_invitation(inv_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            _sb_url("team_invitations"),
            headers=headers,
            params={"id": f"eq.{inv_id}"},
            json={"status": "declined", "updated_at": datetime.now(timezone.utc).isoformat()},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


# ── Items ────────────────────────────────────────────────────

@router.get("/workspaces/{ws_id}/items")
async def list_items(
    ws_id: str,
    type: Optional[str] = None,
    status: Optional[str] = None,
    priority: Optional[str] = None,
    assignee_id: Optional[str] = None,
    page: int = 1,
    limit: int = Query(default=50, le=200),
    user: AuthUser = Depends(get_current_user),
):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Verify membership
        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Workspace not found")

        params: dict = {
            "workspace_id": f"eq.{ws_id}",
            "select": "id,type,title,description,status,priority,due_date,follow_up_date,created_by,source,created_at,updated_at",
            "order": "created_at.desc",
            "offset": str((page - 1) * limit),
            "limit": str(limit),
        }
        if type:
            params["type"] = f"eq.{type}"
        if status:
            params["status"] = f"eq.{status}"
        if priority:
            params["priority"] = f"eq.{priority}"

        resp = await client.get(
            _sb_url("team_items"),
            headers={**headers, "Prefer": "count=exact"},
            params=params,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        total = int(resp.headers.get("content-range", "0/0").split("/")[-1] or 0)
        items = resp.json()

        # Filter by assignee if requested
        if assignee_id and items:
            item_ids = [i["id"] for i in items]
            assign_resp = await client.get(
                _sb_url("team_assignments"),
                headers=headers,
                params={
                    "item_id": f"in.({','.join(item_ids)})",
                    "assignee_id": f"eq.{assignee_id}",
                    "select": "item_id",
                },
            )
            if assign_resp.status_code < 400:
                assigned_ids = {a["item_id"] for a in assign_resp.json()}
                items = [i for i in items if i["id"] in assigned_ids]

        return {"items": items, "total": total, "page": page, "limit": limit}


@router.post("/workspaces/{ws_id}/items")
async def create_item(ws_id: str, req: CreateItem, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Verify membership
        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Workspace not found")

        item_data = {
            "workspace_id": ws_id,
            "type": req.type,
            "title": req.title,
            "description": req.description,
            "priority": req.priority,
            "source": req.source,
            "created_by": user.id,
        }
        if req.due_date:
            item_data["due_date"] = req.due_date
        if req.start_date:
            item_data["start_date"] = req.start_date
        if req.follow_up_date:
            item_data["follow_up_date"] = req.follow_up_date
        if req.time_estimate is not None:
            item_data["time_estimate"] = req.time_estimate
        if req.parent_id:
            item_data["parent_id"] = req.parent_id

        resp = await client.post(
            _sb_url("team_items"),
            headers=headers,
            json=item_data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        item = resp.json()[0]

        # Auto-assign creator so the item appears in their dashboard tiles
        try:
            await client.post(
                _sb_url("team_assignments"), headers=headers,
                json={"item_id": item["id"], "assignee_type": "user",
                      "assignee_id": user.id, "assigned_by": user.id},
            )
        except Exception:
            pass  # non-critical — item still created

        await _log_activity(client, ws_id, "item_created", user.id, item["id"],
                            {"type": req.type, "title": req.title})
        try:
            log_audit(
                tier="system",
                service="opai-team-hub",
                event="task-created",
                status="completed",
                summary=f"Item created: {req.title[:50]}",
                details={"workspace_id": ws_id, "item_id": item["id"], "type": req.type},
            )
        except Exception:
            pass

        # Evaluate automations (item_created trigger)
        try:
            from routes_automations import evaluate_automations
            await evaluate_automations(client, headers, ws_id, None, item, {}, user.id)
        except Exception:
            pass

        return item


@router.get("/items/{item_id}")
async def get_item(item_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}", "select": "*"},
        )
        if resp.status_code >= 400 or not resp.json():
            raise HTTPException(status_code=404, detail="Item not found")

        item = resp.json()[0]

        # Verify membership
        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{item['workspace_id']}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Item not found")

        # Fetch assignments
        assign_resp = await client.get(
            _sb_url("team_assignments"),
            headers=headers,
            params={"item_id": f"eq.{item_id}", "select": "id,assignee_type,assignee_id,assigned_by,created_at"},
        )
        item["assignments"] = assign_resp.json() if assign_resp.status_code < 400 else []

        # Fetch tags
        tags_resp = await client.get(
            _sb_url("team_item_tags"),
            headers=headers,
            params={"item_id": f"eq.{item_id}", "select": "tag_id"},
        )
        tag_ids = [t["tag_id"] for t in tags_resp.json()] if tags_resp.status_code < 400 else []
        if tag_ids:
            tag_detail_resp = await client.get(
                _sb_url("team_tags"),
                headers=headers,
                params={"id": f"in.({','.join(tag_ids)})", "select": "id,name,color"},
            )
            item["tags"] = tag_detail_resp.json() if tag_detail_resp.status_code < 400 else []
        else:
            item["tags"] = []

        # Fetch subtasks
        sub_resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={
                "parent_id": f"eq.{item_id}",
                "select": "id,title,status,priority,due_date,orderindex,custom_id",
                "order": "orderindex.asc,created_at.asc",
            },
        )
        item["subtasks"] = sub_resp.json() if sub_resp.status_code < 400 else []

        return item


@router.patch("/items/{item_id}")
async def update_item(item_id: str, req: UpdateItem, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Fetch item to get workspace_id
        item_resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}", "select": "*"},
        )
        if item_resp.status_code >= 400 or not item_resp.json():
            raise HTTPException(status_code=404, detail="Item not found")
        item = item_resp.json()[0]

        # Verify membership
        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{item['workspace_id']}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Item not found")

        # Allow explicitly nullable fields to pass through as None
        _nullable_fields = {"recurrence", "links", "due_date", "start_date", "follow_up_date"}
        raw = req.model_dump()
        update = {}
        for k, v in raw.items():
            if v is not None:
                update[k] = v
            elif k in _nullable_fields and req.model_fields_set and k in req.model_fields_set:
                update[k] = None
        update["updated_at"] = datetime.now(timezone.utc).isoformat()

        # If list_id changed, sync workspace_id to the new list's workspace so
        # the task does not continue to appear in the old workspace.
        if "list_id" in update and update["list_id"]:
            list_resp = await client.get(
                _sb_url("team_lists"),
                headers=headers,
                params={"id": f"eq.{update['list_id']}", "select": "workspace_id"},
            )
            if list_resp.status_code < 400 and list_resp.json():
                new_ws_id = list_resp.json()[0].get("workspace_id")
                if new_ws_id and new_ws_id != item.get("workspace_id"):
                    update["workspace_id"] = new_ws_id

        resp = await client.patch(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}"},
            json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        await _log_activity(client, item["workspace_id"], "item_updated", user.id, item_id,
                            {"changes": list(update.keys())})

        # Notify assignees of meaningful changes
        _notify_fields = {"status", "priority", "due_date", "title"}
        changed_fields = set(update.keys()) & _notify_fields
        if changed_fields:
            try:
                assignees = await _get_item_assignees(client, item_id)
                parts = []
                if "status" in changed_fields:
                    parts.append(f"Status \u2192 {update['status']}")
                if "priority" in changed_fields:
                    parts.append(f"Priority \u2192 {update['priority']}")
                if "due_date" in changed_fields:
                    parts.append(f"Due date changed")
                if "title" in changed_fields:
                    parts.append(f"Title changed")
                body_text = ", ".join(parts)
                item_title = item.get("title", "")
                for uid in assignees:
                    await _notify(client, uid, "update",
                                  f"Updated: {item_title}" if item_title else "Task updated",
                                  body_text,
                                  item_id=item_id, workspace_id=item["workspace_id"],
                                  skip_user_id=user.id)
            except Exception:
                pass  # non-critical

        if "status" in update:
            try:
                log_audit(
                    tier="system",
                    service="opai-team-hub",
                    event="task-update",
                    status="completed",
                    summary=f"Item {item_id[:8]} status → {update.get('status', 'updated')}",
                    details={"item_id": item_id, "changes": list(update.keys())},
                )
            except Exception:
                pass

        updated_item = resp.json()[0]

        # ── Recurrence: spawn next instance when completed ──
        if "status" in update and update["status"] in ("done", "closed", "Complete"):
            try:
                await _spawn_recurring_task(client, headers, updated_item, user.id)
            except Exception:
                pass  # Non-fatal — don't block the update

        # ── Evaluate automations ──
        try:
            from routes_automations import evaluate_automations
            changes = {k: v for k, v in update.items() if k != "updated_at"}
            await evaluate_automations(client, headers, item["workspace_id"], item, updated_item, changes, user.id)
        except Exception:
            pass

        return updated_item


@router.delete("/items/{item_id}")
async def delete_item(item_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        item_resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}", "select": "workspace_id,created_by,title"},
        )
        if item_resp.status_code >= 400 or not item_resp.json():
            raise HTTPException(status_code=404, detail="Item not found")
        item = item_resp.json()[0]

        # Must be creator or admin
        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{item['workspace_id']}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Item not found")
        role = mem_check.json()[0]["role"]
        if item["created_by"] != user.id and role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Cannot delete this item")

        resp = await client.delete(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        await _log_activity(client, item["workspace_id"], "item_deleted", user.id,
                            details={"title": item["title"]})
        return {"ok": True}


@router.post("/items/batch")
async def batch_items(req: BatchOperation, user: AuthUser = Depends(get_current_user)):
    """Batch operations: delete, update (status/priority/list_id), or assign multiple items."""
    if not req.item_ids:
        raise HTTPException(status_code=400, detail="No item IDs provided")
    if len(req.item_ids) > 200:
        raise HTTPException(status_code=400, detail="Maximum 200 items per batch")
    if req.action not in ("delete", "update", "assign"):
        raise HTTPException(status_code=400, detail="Invalid action")

    headers = _sb_headers_service()
    results = {"succeeded": 0, "failed": 0, "errors": []}

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Fetch all items to verify access
        id_filter = ",".join(req.item_ids)
        items_resp = await client.get(
            _sb_url("team_items"), headers=headers,
            params={"id": f"in.({id_filter})", "select": "id,workspace_id,created_by,title"},
        )
        if items_resp.status_code >= 400:
            raise HTTPException(status_code=500, detail="Failed to fetch items")
        items = {i["id"]: i for i in items_resp.json()}

        # Verify membership for each workspace
        ws_ids = set(i["workspace_id"] for i in items.values())
        user_roles = {}
        for ws_id in ws_ids:
            mem_resp = await client.get(
                _sb_url("team_membership"), headers=headers,
                params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
            )
            if mem_resp.json():
                user_roles[ws_id] = mem_resp.json()[0]["role"]

        for item_id in req.item_ids:
            item = items.get(item_id)
            if not item:
                results["failed"] += 1
                results["errors"].append(f"Item {item_id} not found")
                continue
            ws_role = user_roles.get(item["workspace_id"])
            if not ws_role:
                results["failed"] += 1
                results["errors"].append(f"No access to item {item_id}")
                continue

            try:
                if req.action == "delete":
                    if item["created_by"] != user.id and ws_role not in ("owner", "admin"):
                        results["failed"] += 1
                        results["errors"].append(f"Cannot delete {item_id}")
                        continue
                    resp = await client.delete(
                        _sb_url("team_items"), headers=headers,
                        params={"id": f"eq.{item_id}"},
                    )
                    if resp.status_code >= 400:
                        results["failed"] += 1
                        continue
                    await _log_activity(client, item["workspace_id"], "item_deleted", user.id,
                                        details={"title": item["title"], "batch": True})

                elif req.action == "update":
                    if not req.update:
                        results["failed"] += 1
                        continue
                    allowed = {"status", "priority", "due_date", "follow_up_date", "list_id", "folder_id"}
                    update = {k: v for k, v in req.update.items() if k in allowed and v is not None}
                    if not update:
                        results["failed"] += 1
                        continue
                    update["updated_at"] = datetime.now(timezone.utc).isoformat()
                    resp = await client.patch(
                        _sb_url("team_items"), headers=headers,
                        params={"id": f"eq.{item_id}"}, json=update,
                    )
                    if resp.status_code >= 400:
                        results["failed"] += 1
                        continue
                    await _log_activity(client, item["workspace_id"], "item_updated", user.id, item_id,
                                        {"changes": list(update.keys()), "batch": True})

                elif req.action == "assign":
                    if not req.assignee_id:
                        results["failed"] += 1
                        continue
                    assign_id = str(uuid.uuid4())
                    resp = await client.post(
                        _sb_url("team_assignments"), headers=headers,
                        json={"id": assign_id, "item_id": item_id,
                              "assignee_type": "user", "assignee_id": req.assignee_id,
                              "assigned_by": user.id},
                    )
                    if resp.status_code >= 400 and "duplicate" not in resp.text.lower():
                        results["failed"] += 1
                        continue

                results["succeeded"] += 1
            except Exception:
                results["failed"] += 1

    return results


# ── Assignments ──────────────────────────────────────────────

@router.post("/items/{item_id}/assign")
async def assign_item(item_id: str, req: AssignItem, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        item_resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}", "select": "workspace_id,title"},
        )
        if item_resp.status_code >= 400 or not item_resp.json():
            raise HTTPException(status_code=404, detail="Item not found")
        item_data = item_resp.json()[0]
        ws_id = item_data["workspace_id"]

        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Item not found")

        resp = await client.post(
            _sb_url("team_assignments"),
            headers=headers,
            json={
                "item_id": item_id,
                "assignee_type": req.assignee_type,
                "assignee_id": req.assignee_id,
                "assigned_by": user.id,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        await _log_activity(client, ws_id, "item_assigned", user.id, item_id,
                            {"assignee_type": req.assignee_type, "assignee_id": req.assignee_id})

        # Notify the assignee
        try:
            item_title = item_data.get("title", "")
            await _notify(client, req.assignee_id, "assignment",
                          f"Assigned to: {item_title}" if item_title else "You were assigned a task",
                          "You have been assigned to this task.",
                          item_id=item_id, workspace_id=ws_id, skip_user_id=user.id)
        except Exception:
            pass  # non-critical

        return resp.json()[0]


@router.delete("/items/{item_id}/assign/{assign_id}")
async def unassign_item(item_id: str, assign_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            _sb_url("team_assignments"),
            headers=headers,
            params={"id": f"eq.{assign_id}", "item_id": f"eq.{item_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


# ── Tags ─────────────────────────────────────────────────────

@router.get("/workspaces/{ws_id}/tags")
async def list_tags(ws_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Check if workspace belongs to a hub
        ws_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"id": f"eq.{ws_id}", "select": "hub_id"},
        )
        hub_id = None
        if ws_resp.status_code < 400 and ws_resp.json():
            hub_id = ws_resp.json()[0].get("hub_id")

        if hub_id:
            # Return hub-level tags
            resp = await client.get(
                _sb_url("team_tags"), headers=headers,
                params={"hub_id": f"eq.{hub_id}", "workspace_id": "is.null", "order": "name.asc"},
            )
        else:
            resp = await client.get(
                _sb_url("team_tags"), headers=headers,
                params={"workspace_id": f"eq.{ws_id}", "order": "name.asc"},
            )

        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"tags": resp.json(), "hub_id": hub_id}


@router.post("/workspaces/{ws_id}/tags")
async def create_tag(ws_id: str, req: CreateTag, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Owner-only check
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        rows = mem_resp.json() if mem_resp.status_code < 400 else []
        if not rows:
            raise HTTPException(status_code=404, detail="Not a member of this space")
        if rows[0]["role"] != "owner":
            raise HTTPException(status_code=403, detail="Only the workspace owner can manage tags")
        resp = await client.post(
            _sb_url("team_tags"),
            headers=headers,
            json={"workspace_id": ws_id, "name": req.name, "color": req.color},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.patch("/workspaces/{ws_id}/tags/{tag_id}")
async def update_tag(ws_id: str, tag_id: str, req: UpdateTag, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Owner-only check
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        rows = mem_resp.json() if mem_resp.status_code < 400 else []
        if not rows:
            raise HTTPException(status_code=404, detail="Not a member of this space")
        if rows[0]["role"] != "owner":
            raise HTTPException(status_code=403, detail="Only the workspace owner can manage tags")
        update = {k: v for k, v in req.model_dump().items() if v is not None}
        if not update:
            return {"ok": True}
        resp = await client.patch(
            _sb_url("team_tags"),
            headers=headers,
            params={"id": f"eq.{tag_id}", "workspace_id": f"eq.{ws_id}"},
            json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0] if resp.json() else {"ok": True}


@router.delete("/workspaces/{ws_id}/tags/{tag_id}")
async def delete_workspace_tag(ws_id: str, tag_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Owner-only check
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        rows = mem_resp.json() if mem_resp.status_code < 400 else []
        if not rows:
            raise HTTPException(status_code=404, detail="Not a member of this space")
        if rows[0]["role"] != "owner":
            raise HTTPException(status_code=403, detail="Only the workspace owner can manage tags")
        # Delete tag associations first
        await client.delete(
            _sb_url("team_item_tags"),
            headers=headers,
            params={"tag_id": f"eq.{tag_id}"},
        )
        # Delete the tag itself
        resp = await client.delete(
            _sb_url("team_tags"),
            headers=headers,
            params={"id": f"eq.{tag_id}", "workspace_id": f"eq.{ws_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


@router.post("/items/{item_id}/tags")
async def add_item_tag(item_id: str, req: AddTag, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("team_item_tags"),
            headers=headers,
            json={"item_id": item_id, "tag_id": req.tag_id},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


@router.delete("/items/{item_id}/tags/{tag_id}")
async def remove_item_tag(item_id: str, tag_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            _sb_url("team_item_tags"),
            headers=headers,
            params={"item_id": f"eq.{item_id}", "tag_id": f"eq.{tag_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


# ── Settings Sync (global → all owned workspaces) ────────────

@router.post("/settings/sync")
async def sync_settings(user: AuthUser = Depends(get_current_user)):
    """Sync statuses and tags from hub (if member) or personal workspace to all other owned workspaces."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Check if user belongs to a hub — use hub statuses/tags as canonical source
        hub_resp = await client.get(
            _sb_url("team_hub_membership"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "hub_id,role", "limit": "1"},
        )
        hub_rows = hub_resp.json() if hub_resp.status_code < 400 else []
        hub_id = hub_rows[0]["hub_id"] if hub_rows else None

        if hub_id:
            # Hub mode: canonical from hub-level statuses/tags
            st_resp = await client.get(
                _sb_url("team_statuses"), headers=headers,
                params={"hub_id": f"eq.{hub_id}", "workspace_id": "is.null", "order": "orderindex.asc"},
            )
            canonical_statuses = st_resp.json() if st_resp.status_code < 400 else []
            tg_resp = await client.get(
                _sb_url("team_tags"), headers=headers,
                params={"hub_id": f"eq.{hub_id}", "workspace_id": "is.null", "order": "name.asc"},
            )
            canonical_tags = tg_resp.json() if tg_resp.status_code < 400 else []

            # Target: all hub workspaces (not personal)
            ws_resp = await client.get(
                _sb_url("team_workspaces"), headers=headers,
                params={"hub_id": f"eq.{hub_id}", "is_personal": "eq.false", "select": "id"},
            )
            other_ids = [w["id"] for w in (ws_resp.json() if ws_resp.status_code < 400 else [])]
        else:
            # Legacy mode: sync from personal workspace
            ps_resp = await client.get(
                _sb_url("team_workspaces"), headers=headers,
                params={"owner_id": f"eq.{user.id}", "is_personal": "eq.true", "select": "id"},
            )
            ps_rows = ps_resp.json() if ps_resp.status_code < 400 else []
            if not ps_rows:
                raise HTTPException(status_code=404, detail="Personal workspace not found")
            personal_id = ps_rows[0]["id"]

            mem_resp = await client.get(
                _sb_url("team_membership"), headers=headers,
                params={"user_id": f"eq.{user.id}", "role": "eq.owner", "select": "workspace_id"},
            )
            other_ids = [m["workspace_id"] for m in (mem_resp.json() or [])
                         if m["workspace_id"] != personal_id]

            st_resp = await client.get(
                _sb_url("team_statuses"), headers=headers,
                params={"workspace_id": f"eq.{personal_id}", "order": "orderindex.asc"},
            )
            canonical_statuses = st_resp.json() if st_resp.status_code < 400 else []
            tg_resp = await client.get(
                _sb_url("team_tags"), headers=headers,
                params={"workspace_id": f"eq.{personal_id}", "order": "name.asc"},
            )
            canonical_tags = tg_resp.json() if tg_resp.status_code < 400 else []

        if not other_ids:
            return {"ok": True, "synced": 0}

        for ws_id in other_ids:
            # ── Sync statuses ──
            ws_st = await client.get(
                _sb_url("team_statuses"), headers=headers,
                params={"workspace_id": f"eq.{ws_id}"},
            )
            existing = {s["name"]: s for s in (ws_st.json() if ws_st.status_code < 400 else [])}
            canonical_names = set()

            for cs in canonical_statuses:
                canonical_names.add(cs["name"])
                if cs["name"] in existing:
                    es = existing[cs["name"]]
                    if es["color"] != cs["color"] or es["type"] != cs["type"] or es["orderindex"] != cs["orderindex"]:
                        await client.patch(
                            _sb_url("team_statuses"), headers=headers,
                            params={"id": f"eq.{es['id']}"},
                            json={"color": cs["color"], "type": cs["type"], "orderindex": cs["orderindex"]},
                        )
                else:
                    await client.post(
                        _sb_url("team_statuses"), headers=headers,
                        json={"workspace_id": ws_id, "name": cs["name"], "color": cs["color"],
                              "type": cs["type"], "orderindex": cs["orderindex"]},
                    )

            for name, es in existing.items():
                if name not in canonical_names:
                    await client.delete(
                        _sb_url("team_statuses"), headers=headers,
                        params={"id": f"eq.{es['id']}"},
                    )

            # ── Sync tags ──
            ws_tg = await client.get(
                _sb_url("team_tags"), headers=headers,
                params={"workspace_id": f"eq.{ws_id}"},
            )
            existing_tags = {t["name"]: t for t in (ws_tg.json() if ws_tg.status_code < 400 else [])}
            canonical_tag_names = set()

            for ct in canonical_tags:
                canonical_tag_names.add(ct["name"])
                if ct["name"] in existing_tags:
                    et = existing_tags[ct["name"]]
                    if et["color"] != ct["color"]:
                        await client.patch(
                            _sb_url("team_tags"), headers=headers,
                            params={"id": f"eq.{et['id']}"},
                            json={"color": ct["color"]},
                        )
                else:
                    await client.post(
                        _sb_url("team_tags"), headers=headers,
                        json={"workspace_id": ws_id, "name": ct["name"], "color": ct["color"]},
                    )

            for name, et in existing_tags.items():
                if name not in canonical_tag_names:
                    # Delete associations first, then the tag
                    await client.delete(
                        _sb_url("team_item_tags"), headers=headers,
                        params={"tag_id": f"eq.{et['id']}"},
                    )
                    await client.delete(
                        _sb_url("team_tags"), headers=headers,
                        params={"id": f"eq.{et['id']}"},
                    )

        return {"ok": True, "synced": len(other_ids)}


# ── Activity ─────────────────────────────────────────────────

@router.get("/workspaces/{ws_id}/activity")
async def workspace_activity(
    ws_id: str,
    limit: int = Query(default=50, le=200),
    user: AuthUser = Depends(get_current_user),
):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_activity"),
            headers=headers,
            params={
                "workspace_id": f"eq.{ws_id}",
                "order": "created_at.desc",
                "limit": str(limit),
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"activity": resp.json()}


@router.get("/items/{item_id}/activity")
async def item_activity(item_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_activity"),
            headers=headers,
            params={
                "item_id": f"eq.{item_id}",
                "order": "created_at.desc",
                "limit": "100",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"activity": resp.json()}


# ── Search ───────────────────────────────────────────────────

@router.get("/search")
async def search_items(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=30, le=100),
    user: AuthUser = Depends(get_current_user),
):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Get user's workspace IDs
        mem_resp = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "workspace_id"},
        )
        if mem_resp.status_code >= 400:
            raise HTTPException(status_code=mem_resp.status_code, detail=mem_resp.text)
        ws_ids = [m["workspace_id"] for m in mem_resp.json()]
        if not ws_ids:
            return {"items": [], "total": 0}

        # Search by title/description/custom_id — split query into words so
        # "VEC Quotes" matches tasks containing both words in any order
        select_fields = "id,type,title,status,priority,workspace_id,custom_id,created_at"
        words = q.strip().split()
        if len(words) <= 1:
            or_filter = f"(title.ilike.%{q}%,description.ilike.%{q}%,custom_id.ilike.%{q}%)"
            params = {
                "workspace_id": f"in.({','.join(ws_ids)})",
                "or": or_filter,
                "order": "updated_at.desc,created_at.desc",
                "limit": str(limit),
                "select": select_fields,
            }
        else:
            clauses = ",".join(
                f"or(title.ilike.%{w}%,description.ilike.%{w}%,custom_id.ilike.%{w}%)" for w in words
            )
            params = {
                "workspace_id": f"in.({','.join(ws_ids)})",
                "and": f"({clauses})",
                "order": "updated_at.desc,created_at.desc",
                "limit": str(limit),
                "select": select_fields,
            }
        resp = await client.get(_sb_url("team_items"), headers=headers, params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        items = resp.json()
        return {"items": items, "total": len(items)}


# ── My Work ──────────────────────────────────────────────────

@router.get("/my/items")
async def my_items(
    status: Optional[str] = None,
    limit: int = Query(default=50, le=200),
    user: AuthUser = Depends(get_current_user),
):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Get assignments for user
        assign_resp = await client.get(
            _sb_url("team_assignments"),
            headers=headers,
            params={
                "assignee_type": "eq.user",
                "assignee_id": f"eq.{user.id}",
                "select": "item_id",
            },
        )
        if assign_resp.status_code >= 400:
            return {"items": [], "total": 0}

        item_ids = [a["item_id"] for a in assign_resp.json()]
        if not item_ids:
            return {"items": [], "total": 0}

        params: dict = {
            "id": f"in.({','.join(item_ids)})",
            "order": "updated_at.desc",
            "limit": str(limit),
            "select": "id,type,title,status,priority,workspace_id,due_date,follow_up_date,created_at,updated_at",
        }
        if status:
            params["status"] = f"eq.{status}"

        resp = await client.get(_sb_url("team_items"), headers=headers, params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        items = resp.json()
        return {"items": items, "total": len(items)}


@router.get("/my/notifications")
async def my_notifications(
    unread_only: bool = True,
    limit: int = Query(default=50, le=200),
    user: AuthUser = Depends(get_current_user),
):
    headers = _sb_headers_service()
    params: dict = {
        "user_id": f"eq.{user.id}",
        "order": "created_at.desc",
        "limit": str(limit),
    }
    if unread_only:
        params["read"] = "eq.false"

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(_sb_url("team_notifications"), headers=headers, params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"notifications": resp.json()}


@router.post("/my/notifications/read")
async def mark_notifications_read(req: MarkRead, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        if req.notification_ids:
            params = {"id": f"in.({','.join(req.notification_ids)})", "user_id": f"eq.{user.id}"}
        else:
            params = {"user_id": f"eq.{user.id}", "read": "eq.false"}

        resp = await client.patch(
            _sb_url("team_notifications"),
            headers=headers,
            params=params,
            json={"read": True},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


@router.delete("/my/notifications/{notification_id}")
async def delete_notification(notification_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            _sb_url("team_notifications"),
            headers=headers,
            params={"id": f"eq.{notification_id}", "user_id": f"eq.{user.id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


# ── Home Dashboard ────────────────────────────────────────────

@router.get("/my/home")
async def my_home(user: AuthUser = Depends(get_current_user)):
    """Aggregate data for the home dashboard tiles in a single call."""
    headers = _sb_headers_service()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    week_from_now = (datetime.now(timezone.utc).replace(hour=23, minute=59, second=59)
                     + timedelta(days=7)).strftime("%Y-%m-%d")

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Get user's workspace memberships
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "workspace_id,role"},
        )
        memberships = mem_resp.json() if mem_resp.status_code < 400 else []
        ws_ids = [m["workspace_id"] for m in memberships]
        if not ws_ids:
            return {"top_items": [], "recent_todos": [], "overdue": [],
                    "priorities": [], "mentions": [], "workspace_summary": [],
                    "due_this_week": [], "follow_ups_due": [], "recent_activity": []}

        ws_filter = f"in.({','.join(ws_ids)})"

        # Get user's assigned item IDs
        assign_resp = await client.get(
            _sb_url("team_assignments"), headers=headers,
            params={"assignee_type": "eq.user", "assignee_id": f"eq.{user.id}", "select": "item_id"},
        )
        assigned_ids = [a["item_id"] for a in (assign_resp.json() if assign_resp.status_code < 400 else [])]

        # All items in user's workspaces (for various tiles)
        all_items_resp = await client.get(
            _sb_url("team_items"), headers=headers,
            params={
                "workspace_id": ws_filter,
                "select": "id,type,title,status,priority,due_date,follow_up_date,workspace_id,created_by,created_at,updated_at",
                "order": "updated_at.desc",
                "limit": "200",
            },
        )
        all_items = all_items_resp.json() if all_items_resp.status_code < 400 else []

        assigned_set = set(assigned_ids)
        # Include items assigned to user OR created by user (creator should always see their own items)
        my_items = [i for i in all_items
                     if i["id"] in assigned_set or i.get("created_by") == user.id]

        # Fall back to all workspace items when user has no assignments/created items
        effective_items = my_items if my_items else all_items

        # Priority order for sorting
        pri_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "none": 4}

        # All active (non-done) items from the effective set
        _closed_statuses = {"done", "closed", "archived", "Complete"}
        active_items = [i for i in effective_items if i.get("status") not in _closed_statuses]
        active_items.sort(key=lambda x: (pri_order.get(x.get("priority", "none"), 4), x.get("due_date") or "9999"))

        # top_items: highest-priority items not done (up to 25 for 3x2 tiles)
        top_items = active_items[:25]

        # recent_todos: recent items by updated_at (up to 40 for 3x2 tiles)
        recent_todos = effective_items[:40]

        # priorities: "most important tasks to focus on" — composite urgency score
        # Combines: overdue urgency, due-date proximity, priority level, recency
        def _priority_score(item):
            score = 0
            due = item.get("due_date")
            pri = item.get("priority", "none")
            updated = item.get("updated_at", "")

            # Urgency: due date proximity (biggest weight)
            if due:
                try:
                    days_until = (datetime.strptime(due, "%Y-%m-%d").date()
                                  - datetime.now(timezone.utc).date()).days
                except (ValueError, TypeError):
                    days_until = 999
                if days_until < 0:       # overdue
                    score += 500 + min(abs(days_until), 30) * 10  # more overdue = higher
                elif days_until == 0:    # due today
                    score += 400
                elif days_until <= 3:    # due in 1-3 days
                    score += 300 - days_until * 20
                elif days_until <= 7:    # due this week
                    score += 200 - days_until * 10
                elif days_until <= 14:   # due in 2 weeks
                    score += 100 - days_until * 3
                # else: no due-date urgency boost

            # Priority level weight
            pri_scores = {"critical": 150, "high": 100, "medium": 50, "low": 20, "none": 0}
            score += pri_scores.get(pri, 0)

            # Recency boost: recently updated items get a small bump
            if updated:
                try:
                    days_since = (datetime.now(timezone.utc)
                                  - datetime.fromisoformat(updated.replace("Z", "+00:00"))).days
                    if days_since <= 1:
                        score += 30
                    elif days_since <= 3:
                        score += 15
                    elif days_since <= 7:
                        score += 5
                except (ValueError, TypeError):
                    pass

            return score

        # Score all active items and take the top ones (score > 0 means actionable)
        scored = [(i, _priority_score(i)) for i in active_items]
        scored = [(i, s) for i, s in scored if s > 0]
        scored.sort(key=lambda x: -x[1])
        priorities = [i for i, s in scored[:25]]

        # overdue: ALL items with due_date < today assigned to/created by user, not done
        # Use a separate targeted query to avoid the 200-item limit
        # Sort by most recently overdue first so new tasks aren't buried under old imports
        overdue = []
        try:
            overdue_params = {
                "workspace_id": ws_filter,
                "due_date": f"lt.{today}",
                "status": "not.in.(done,closed,archived,Complete)",
                "select": "id,type,title,status,priority,due_date,follow_up_date,workspace_id,created_by,created_at,updated_at",
                "order": "due_date.desc",
                "limit": "500",
            }
            overdue_resp = await client.get(
                _sb_url("team_items"), headers=headers, params=overdue_params,
            )
            if overdue_resp.status_code < 400:
                all_overdue = overdue_resp.json()
                # Filter to user's assigned or created items (or all if no assignments)
                if assigned_set:
                    overdue = [i for i in all_overdue
                               if i["id"] in assigned_set or i.get("created_by") == user.id]
                else:
                    overdue = all_overdue
        except Exception:
            # Fall back to the limited set
            overdue = [i for i in active_items if i.get("due_date") and i["due_date"] < today]
            overdue.sort(key=lambda x: x.get("due_date", ""), reverse=True)

        # due_this_week: items due within next 7 days
        due_this_week = [i for i in active_items
                         if i.get("due_date") and today <= i["due_date"] <= week_from_now]
        due_this_week.sort(key=lambda x: x.get("due_date", ""))

        # follow_ups_due: items with follow_up_date <= today (or within next 7 days)
        follow_ups_due = [i for i in active_items
                          if i.get("follow_up_date") and i["follow_up_date"] <= week_from_now]
        follow_ups_due.sort(key=lambda x: x.get("follow_up_date", ""))

        # mentions: search ALL comments for @Name patterns (not just first N items)
        display_name = user.user_metadata.get("display_name", "") if hasattr(user, "user_metadata") else ""
        mentions = []
        try:
            if display_name or user.email:
                or_parts = []
                if display_name:
                    or_parts.append(f"content.ilike.%@{display_name}%")
                if user.email:
                    email_prefix = user.email.split("@")[0]
                    or_parts.append(f"content.ilike.%@{email_prefix}%")

                comments_resp = await client.get(
                    _sb_url("team_comments"), headers=headers,
                    params={
                        "or": f"({','.join(or_parts)})",
                        "author_id": f"neq.{user.id}",
                        "order": "created_at.desc",
                        "limit": "100",
                        "select": "id,item_id,content,author_id,created_at",
                    },
                )
                if comments_resp.status_code < 400:
                    ws_item_set = {i["id"] for i in all_items}
                    for c in comments_resp.json():
                        if c.get("item_id") in ws_item_set:
                            mentions.append(c)
                            if len(mentions) >= 30:
                                break
        except Exception:
            pass  # mentions are non-critical — don't crash the whole dashboard

        # workspace_summary
        ws_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"id": ws_filter, "select": "id,name,icon,color"},
        )
        workspaces = ws_resp.json() if ws_resp.status_code < 400 else []
        ws_map = {w["id"]: w for w in workspaces}

        ws_summary = []
        for ws in workspaces:
            ws_items = [i for i in all_items if i.get("workspace_id") == ws["id"]]
            done_count = sum(1 for i in ws_items if i.get("status") in ("done", "closed", "Complete"))
            ws_summary.append({
                "id": ws["id"], "name": ws["name"], "icon": ws.get("icon", ""),
                "color": ws.get("color", "#6c5ce7"),
                "total_items": len(ws_items), "done_count": done_count,
                "active_count": len(ws_items) - done_count,
            })

        # recent_activity
        recent_activity = []
        try:
            activity_resp = await client.get(
                _sb_url("team_activity"), headers=headers,
                params={
                    "workspace_id": ws_filter,
                    "order": "created_at.desc",
                    "limit": "40",
                    "select": "id,action,actor_id,item_id,workspace_id,details,created_at",
                },
            )
            recent_activity = activity_resp.json() if activity_resp.status_code < 400 else []
        except Exception:
            pass  # activity is non-critical

        return {
            "top_items": top_items,
            "recent_todos": recent_todos,
            "overdue": overdue,
            "priorities": priorities,
            "mentions": mentions,
            "workspace_summary": ws_summary,
            "due_this_week": due_this_week,
            "follow_ups_due": follow_ups_due,
            "recent_activity": recent_activity,
        }


# ── All Items (Home List View) ────────────────────────────────

@router.get("/my/all-items")
async def my_all_items(
    user: AuthUser = Depends(get_current_user),
    sort: str = "updated_at",
    direction: str = "desc",
    status: Optional[str] = None,
    priority: Optional[str] = None,
    workspace_id: Optional[str] = None,
    assignee: Optional[str] = None,
    tag: Optional[str] = None,
    show_all: bool = False,
    hide_completed: bool = False,
    limit: int = 200,
):
    """Return all items across user's workspaces for the home list view."""
    headers = _sb_headers_service()

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Get workspace memberships
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "workspace_id"},
        )
        memberships = mem_resp.json() if mem_resp.status_code < 400 else []
        ws_ids = [m["workspace_id"] for m in memberships]
        if not ws_ids:
            return {"items": [], "workspaces": {}}

        # If filtering by specific workspace, narrow down
        if workspace_id and workspace_id in ws_ids:
            ws_filter = f"eq.{workspace_id}"
        else:
            ws_filter = f"in.({','.join(ws_ids)})"

        # Validate sort column
        allowed_sorts = {"updated_at", "created_at", "title", "status", "priority", "due_date"}
        sort_col = sort if sort in allowed_sorts else "updated_at"
        sort_dir = "asc" if direction == "asc" else "desc"

        # Build params
        params = {
            "workspace_id": ws_filter,
            "select": "id,type,title,status,priority,due_date,follow_up_date,workspace_id,list_id,created_at,updated_at",
            "order": f"{sort_col}.{sort_dir}.nullslast",
            "limit": str(min(limit, 500)),
        }
        # Status filter (supports comma-separated multi-values)
        if status:
            status_list = [s.strip() for s in status.split(",") if s.strip()]
            if len(status_list) == 1:
                params["status"] = f"eq.{status_list[0]}"
            elif status_list:
                params["status"] = f"in.({','.join(status_list)})"
        elif hide_completed:
            # Exclude completed statuses by default
            params["status"] = "not.in.(Complete,done,closed)"

        # Priority filter (supports comma-separated multi-values)
        if priority:
            prio_list = [p.strip() for p in priority.split(",") if p.strip()]
            if len(prio_list) == 1:
                params["priority"] = f"eq.{prio_list[0]}"
            elif prio_list:
                params["priority"] = f"in.({','.join(prio_list)})"

        resp = await client.get(_sb_url("team_items"), headers=headers, params=params)
        items = resp.json() if resp.status_code < 400 else []

        # Fetch assignments and tags for these items
        assigns = []
        if items:
            item_ids = [i["id"] for i in items]
            assign_resp = await client.get(
                _sb_url("team_assignments"), headers=headers,
                params={"item_id": f"in.({','.join(item_ids)})",
                        "select": "item_id,assignee_type,assignee_id"},
            )
            assigns = assign_resp.json() if assign_resp.status_code < 400 else []
            assign_map = {}
            for a in assigns:
                assign_map.setdefault(a["item_id"], []).append(a)

            tags_resp = await client.get(
                _sb_url("team_item_tags"), headers=headers,
                params={"item_id": f"in.({','.join(item_ids)})", "select": "item_id,tag_id"},
            )
            item_tag_ids = {}
            all_tag_ids = set()
            for it in (tags_resp.json() if tags_resp.status_code < 400 else []):
                item_tag_ids.setdefault(it["item_id"], []).append(it["tag_id"])
                all_tag_ids.add(it["tag_id"])

            tag_map = {}
            if all_tag_ids:
                tg_resp = await client.get(
                    _sb_url("team_tags"), headers=headers,
                    params={"id": f"in.({','.join(all_tag_ids)})", "select": "id,name,color"},
                )
                for tg in (tg_resp.json() if tg_resp.status_code < 400 else []):
                    tag_map[tg["id"]] = tg

            for item in items:
                item["assignees"] = assign_map.get(item["id"], [])
                item["tags"] = [tag_map[tid] for tid in item_tag_ids.get(item["id"], []) if tid in tag_map]

        # Post-enrichment filters: assignee and tag (require joined data)
        if assignee and items:
            items = [i for i in items
                     if any(a.get("assignee_id") == assignee for a in i.get("assignees", []))]
        if tag and items:
            tag_list = {t.strip().lower() for t in tag.split(",") if t.strip()}
            items = [i for i in items
                     if any(t.get("name", "").lower() in tag_list for t in i.get("tags", []))]

        # "My Tasks" filter: only show items assigned to current user (default)
        if not show_all and not assignee and items:
            my_assigned_ids = {a["item_id"] for a in assigns if a.get("assignee_id") == user.id}
            items = [i for i in items if i["id"] in my_assigned_ids]

        # Fetch all workspace info (not just filtered subset) for dropdown options
        all_ws_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"id": f"in.({','.join(ws_ids)})", "select": "id,name,color"},
        )
        workspaces = {w["id"]: w for w in (all_ws_resp.json() if all_ws_resp.status_code < 400 else [])}

        list_ids = list({i["list_id"] for i in items if i.get("list_id")})
        lists_map = {}
        if list_ids:
            lists_resp = await client.get(
                _sb_url("team_lists"), headers=headers,
                params={"id": f"in.({','.join(list_ids)})", "select": "id,name"},
            )
            for l in (lists_resp.json() if lists_resp.status_code < 400 else []):
                lists_map[l["id"]] = l["name"]

        # Enrich items with workspace/list names
        for item in items:
            ws = workspaces.get(item.get("workspace_id"))
            item["workspace_name"] = ws["name"] if ws else ""
            item["workspace_color"] = ws.get("color", "#6c5ce7") if ws else "#6c5ce7"
            item["list_name"] = lists_map.get(item.get("list_id"), "")

        # Collect all unique tags across items for filter dropdown
        all_tags = {}
        for item in items:
            for tg in item.get("tags", []):
                all_tags[tg["id"]] = tg

        return {"items": items, "workspaces": workspaces, "all_tags": list(all_tags.values())}


# ── Home Layout Persistence ──────────────────────────────────

@router.get("/my/home-layout")
async def get_home_layout(user: AuthUser = Depends(get_current_user)):
    """Get saved home dashboard layout for current user."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_user_prefs"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "home_layout"},
        )
        rows = resp.json() if resp.status_code < 400 else []
        if rows and rows[0].get("home_layout"):
            return rows[0]["home_layout"]
        return None


@router.put("/my/home-layout")
async def save_home_layout(request: Request, user: AuthUser = Depends(get_current_user)):
    """Save home dashboard layout for current user (upsert)."""
    body = await request.json()
    headers = _sb_headers_service()
    headers["Prefer"] = "resolution=merge-duplicates"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("team_user_prefs"), headers=headers,
            json={
                "user_id": user.id,
                "home_layout": body,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


# ── Custom Tile Endpoints ────────────────────────────────────

def _resolve_date(value: str) -> str:
    """Convert relative/named date values to ISO date strings."""
    now = datetime.now(timezone.utc)
    if value == "today":
        return now.strftime("%Y-%m-%d")
    if value == "this_week":
        end = now + timedelta(days=(6 - now.weekday()))
        return end.strftime("%Y-%m-%d")
    if value == "this_month":
        import calendar
        last_day = calendar.monthrange(now.year, now.month)[1]
        return now.replace(day=last_day).strftime("%Y-%m-%d")
    if value.startswith("relative:"):
        days_str = value.split(":")[1].rstrip("d")
        days = int(days_str)
        target = now + timedelta(days=days)
        return target.strftime("%Y-%m-%d")
    return value  # already ISO


@router.post("/my/custom-tile")
async def compute_custom_tile(request: Request, user: AuthUser = Depends(get_current_user)):
    """Compute tile data from custom criteria (conditions, sort, limit)."""
    body = await request.json()
    conditions = body.get("conditions", [])
    sort_field = body.get("sort", "updated_at")
    sort_dir = body.get("sort_dir", "desc")
    limit = min(body.get("limit", 25), 100)

    headers = _sb_headers_service()

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Security boundary: always intersect with user's workspace memberships
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "workspace_id"},
        )
        memberships = mem_resp.json() if mem_resp.status_code < 400 else []
        ws_ids = [m["workspace_id"] for m in memberships]
        if not ws_ids:
            return {"items": [], "total": 0}

        # Build PostgREST query params
        allowed_sorts = {"updated_at", "created_at", "title", "status", "priority", "due_date", "follow_up_date"}
        sort_col = sort_field if sort_field in allowed_sorts else "updated_at"
        safe_dir = "asc" if sort_dir == "asc" else "desc"

        params = {
            "select": "id,type,title,status,priority,due_date,follow_up_date,workspace_id,list_id,created_at,updated_at",
            "order": f"{sort_col}.{safe_dir}.nullslast",
            "limit": str(limit + 50),  # fetch extra for post-filters
        }

        # Track fields that need post-filtering (assignee, tag)
        post_filter_assignee = None
        post_filter_tag = None

        # Apply workspace filter: start with user's memberships, narrow if criteria specifies
        criteria_ws_ids = None
        for cond in conditions:
            field = cond.get("field")
            op = cond.get("op")
            value = cond.get("value")
            if not field or not op:
                continue

            if field == "assignee_id":
                post_filter_assignee = {"op": op, "value": value}
                continue
            if field == "tag":
                post_filter_tag = {"op": op, "value": value}
                continue

            # Resolve date values
            if field in ("due_date", "follow_up_date", "created_at", "updated_at"):
                if isinstance(value, str):
                    value = _resolve_date(value)
                elif isinstance(value, list):
                    value = [_resolve_date(v) for v in value]

            # Workspace ID: intersect with user's memberships
            if field == "workspace_id":
                if op in ("eq", "in"):
                    filter_ids = [value] if isinstance(value, str) else value
                    criteria_ws_ids = [wid for wid in filter_ids if wid in ws_ids]
                    if not criteria_ws_ids:
                        return {"items": [], "total": 0}
                continue  # workspace filter applied separately below

            # Map operators to PostgREST syntax
            pg_op_map = {
                "eq": "eq", "neq": "neq", "lt": "lt", "lte": "lte",
                "gt": "gt", "gte": "gte", "in": "in", "not_in": "not.in",
            }
            pg_op = pg_op_map.get(op)
            if not pg_op:
                continue

            if op in ("in", "not_in") and isinstance(value, list):
                params[field] = f"{pg_op}.({','.join(str(v) for v in value)})"
            else:
                params[field] = f"{pg_op}.{value}"

        # Apply workspace filter
        if criteria_ws_ids:
            if len(criteria_ws_ids) == 1:
                params["workspace_id"] = f"eq.{criteria_ws_ids[0]}"
            else:
                params["workspace_id"] = f"in.({','.join(criteria_ws_ids)})"
        else:
            params["workspace_id"] = f"in.({','.join(ws_ids)})"

        resp = await client.get(_sb_url("team_items"), headers=headers, params=params)
        items = resp.json() if resp.status_code < 400 else []

        # Post-filter: assignee
        if post_filter_assignee and items:
            item_ids = [i["id"] for i in items]
            assign_resp = await client.get(
                _sb_url("team_assignments"), headers=headers,
                params={"item_id": f"in.({','.join(item_ids)})", "select": "item_id,assignee_id"},
            )
            assigns = assign_resp.json() if assign_resp.status_code < 400 else []
            assign_map = {}
            for a in assigns:
                assign_map.setdefault(a["item_id"], []).append(a["assignee_id"])

            pf = post_filter_assignee
            if pf["op"] in ("eq", "in"):
                target_ids = [pf["value"]] if isinstance(pf["value"], str) else pf["value"]
                items = [i for i in items if any(aid in target_ids for aid in assign_map.get(i["id"], []))]
            elif pf["op"] in ("neq", "not_in"):
                target_ids = [pf["value"]] if isinstance(pf["value"], str) else pf["value"]
                items = [i for i in items if not any(aid in target_ids for aid in assign_map.get(i["id"], []))]

        # Post-filter: tag
        if post_filter_tag and items:
            item_ids = [i["id"] for i in items]
            tags_resp = await client.get(
                _sb_url("team_item_tags"), headers=headers,
                params={"item_id": f"in.({','.join(item_ids)})", "select": "item_id,tag_id"},
            )
            item_tag_map = {}
            for it in (tags_resp.json() if tags_resp.status_code < 400 else []):
                item_tag_map.setdefault(it["item_id"], []).append(it["tag_id"])

            # Resolve tag names to IDs if values are names
            pf = post_filter_tag
            tag_values = [pf["value"]] if isinstance(pf["value"], str) else pf["value"]
            # Check if values look like UUIDs or names
            if tag_values and len(tag_values[0]) < 36:
                # Look up tag IDs by name
                or_parts = ",".join(f"name.ilike.{v}" for v in tag_values)
                tg_resp = await client.get(
                    _sb_url("team_tags"), headers=headers,
                    params={"or": f"({or_parts})", "select": "id,name"},
                )
                tag_id_list = [t["id"] for t in (tg_resp.json() if tg_resp.status_code < 400 else [])]
            else:
                tag_id_list = tag_values

            if pf["op"] in ("eq", "in"):
                items = [i for i in items if any(tid in tag_id_list for tid in item_tag_map.get(i["id"], []))]
            elif pf["op"] in ("neq", "not_in"):
                items = [i for i in items if not any(tid in tag_id_list for tid in item_tag_map.get(i["id"], []))]

        total = len(items)
        items = items[:limit]
        return {"items": items, "total": total}


@router.post("/my/custom-tile/ai-generate")
async def ai_generate_custom_tile(request: Request, user: AuthUser = Depends(get_current_user)):
    """Use AI to generate custom tile criteria from natural language description."""
    from claude_api import call_claude

    body = await request.json()
    description = body.get("description", "").strip()
    if not description:
        raise HTTPException(status_code=400, detail="Description is required")

    headers = _sb_headers_service()

    async with httpx.AsyncClient(timeout=10.0) as client:
        # Gather context: workspaces, profiles, tags
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "workspace_id"},
        )
        ws_ids = [m["workspace_id"] for m in (mem_resp.json() if mem_resp.status_code < 400 else [])]

        ws_names = {}
        if ws_ids:
            ws_resp = await client.get(
                _sb_url("team_workspaces"), headers=headers,
                params={"id": f"in.({','.join(ws_ids)})", "select": "id,name"},
            )
            ws_names = {w["id"]: w["name"] for w in (ws_resp.json() if ws_resp.status_code < 400 else [])}

        profiles_resp = await client.get(
            _sb_url("profiles"), headers=headers,
            params={"select": "id,display_name,email", "limit": "50"},
        )
        profiles = profiles_resp.json() if profiles_resp.status_code < 400 else []

        tags_resp = await client.get(
            _sb_url("team_tags"), headers=headers,
            params={"workspace_id": f"in.({','.join(ws_ids)})", "select": "id,name"} if ws_ids else {"select": "id,name", "limit": "0"},
        )
        tags = tags_resp.json() if tags_resp.status_code < 400 else []

    prompt = f"""You are a filter criteria generator for a task management dashboard.

The user wants a custom dashboard tile. Convert their description to a JSON criteria object.

Available fields and operators:
- workspace_id: eq, in (values are UUIDs)
- status: eq, neq, in, not_in (values: Not Started, Working on, Manager Review, Back to You, Stuck, Waiting on Client, Client Review, Approved, Postponed, Quality Review, Complete)
- priority: eq, neq, in, not_in (values: critical, high, medium, low, none)
- assignee_id: eq, in (values are user UUIDs)
- due_date: eq, lt, lte, gt, gte (values: "today", "this_week", "this_month", "relative:Nd" where N is days from now, negative for past e.g. "relative:-3d")
- follow_up_date: eq, lt, lte, gt, gte (same date values)
- type: eq, in (values: task, note, idea, decision, bug)
- tag: eq, in (values are tag names)
- list_id: eq, in (values are UUIDs)

User's workspaces: {json.dumps({v: k for k, v in ws_names.items()})}
Known people: {json.dumps([{"name": p.get("display_name", p.get("email", "")), "id": p["id"]} for p in profiles[:20]])}
Known tags: {json.dumps([t["name"] for t in tags[:30]])}

User description: "{description}"

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{{"title": "Short Tile Title", "criteria": {{"conditions": [...], "sort": "field_name", "sort_dir": "asc|desc", "limit": 25}}}}

Each condition: {{"field": "...", "op": "...", "value": "..." or ["..."]}}
"""

    try:
        result = await call_claude(
            prompt,
            model="claude-haiku-4-5",
            max_tokens=512,
            timeout=30,
            api_key="",
        )
        # Parse JSON from response
        text = result.strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
        parsed = json.loads(text)
        return {
            "title": parsed.get("title", "Custom Tile"),
            "criteria": parsed.get("criteria", {"conditions": [], "sort": "updated_at", "sort_dir": "desc", "limit": 25}),
        }
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="AI returned invalid criteria — try rephrasing")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI generation failed: {str(e)}")


# ── Discord Settings ─────────────────────────────────────────

@router.get("/workspaces/{ws_id}/discord")
async def get_discord_settings(ws_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        mem_check = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Workspace not found")

        ws_resp = await client.get(
            _sb_url("team_workspaces"),
            headers=headers,
            params={"id": f"eq.{ws_id}", "select": "discord_server_id,discord_channel_id,bot_prompt"},
        )
        if ws_resp.status_code >= 400 or not ws_resp.json():
            raise HTTPException(status_code=404, detail="Workspace not found")
        return ws_resp.json()[0]


@router.patch("/workspaces/{ws_id}/discord")
async def update_discord_settings(
    ws_id: str, req: UpdateDiscordSettings, user: AuthUser = Depends(get_current_user)
):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        mem_resp = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_resp.json() or mem_resp.json()[0]["role"] not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Admin access required")

        update = {k: v for k, v in req.model_dump().items() if v is not None}
        update["updated_at"] = datetime.now(timezone.utc).isoformat()

        resp = await client.patch(
            _sb_url("team_workspaces"),
            headers=headers,
            params={"id": f"eq.{ws_id}"},
            json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        await _log_activity(client, ws_id, "discord_settings_updated", user.id,
                            details={"fields": list(update.keys())})
        return resp.json()[0]


@router.get("/workspaces/{ws_id}/discord/members")
async def list_discord_members(ws_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_discord_members"),
            headers=headers,
            params={
                "workspace_id": f"eq.{ws_id}",
                "select": "id,discord_id,user_id,discord_username,joined_at",
                "order": "joined_at.asc",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"members": resp.json()}


# ── Internal API (no auth — for Discord bridge localhost calls) ──

@router.post("/internal/create-item")
async def internal_create_item(
    workspace_slug: str = Query(None),
    workspace_id: str = Query(None),
    workspace_type: str = Query("personal"),
    user_id: str = Query(...),
    type: str = Query("task"),
    title: str = Query(...),
    description: str = Query(""),
    source: str = Query("discord"),
    priority: str = Query("medium"),
    status: str = Query(None),
    due_date: str = Query(None),
    list_id: str = Query(None),
    list_name: str = Query(None),
    assignee_id: str = Query(None),
    parent_id: str = Query(None),
    start_date: str = Query(None),
    time_estimate: int = Query(None),
):
    """Create an item without JWT auth — called by Discord bridge on localhost only."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Find workspace
        if workspace_id:
            ws_resp = await client.get(
                _sb_url("team_workspaces"),
                headers=headers,
                params={"id": f"eq.{workspace_id}"},
            )
        elif workspace_slug:
            ws_resp = await client.get(
                _sb_url("team_workspaces"),
                headers=headers,
                params={"slug": f"eq.{workspace_slug}"},
            )
        elif workspace_type == "personal":
            ws_resp = await client.get(
                _sb_url("team_workspaces"),
                headers=headers,
                params={"owner_id": f"eq.{user_id}", "is_personal": "eq.true"},
            )
        else:
            raise HTTPException(status_code=400, detail="workspace_id, workspace_slug, or workspace_type required")

        if ws_resp.status_code >= 400 or not ws_resp.json():
            raise HTTPException(status_code=404, detail="Workspace not found")

        ws = ws_resp.json()[0]

        # Resolve list_name -> list_id if provided
        resolved_list_id = list_id
        if list_name and not list_id:
            list_resp = await client.get(
                _sb_url("team_lists"), headers=headers,
                params={
                    "workspace_id": f"eq.{ws['id']}",
                    "name": f"ilike.%{list_name}%",
                    "limit": "1",
                },
            )
            if list_resp.status_code < 400 and list_resp.json():
                resolved_list_id = list_resp.json()[0]["id"]

        item_data = {
            "workspace_id": ws["id"],
            "type": type,
            "title": title,
            "description": description,
            "priority": priority,
            "source": source,
            "created_by": user_id,
        }
        if status:
            item_data["status"] = status
        if due_date:
            item_data["due_date"] = due_date
        if resolved_list_id:
            item_data["list_id"] = resolved_list_id
        if parent_id:
            item_data["parent_id"] = parent_id
        if start_date:
            item_data["start_date"] = start_date
        if time_estimate is not None:
            item_data["time_estimate"] = time_estimate

        resp = await client.post(
            _sb_url("team_items"),
            headers=headers,
            json=item_data,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        item = resp.json()[0]

        # Auto-assign if assignee_id provided
        if assignee_id:
            await client.post(
                _sb_url("team_assignments"), headers=headers,
                json={
                    "item_id": item["id"],
                    "assignee_type": "user",
                    "assignee_id": assignee_id,
                    "assigned_by": user_id,
                },
            )

        await _log_activity(client, ws["id"], "item_created", user_id, item["id"],
                            {"type": type, "title": title, "source": source})
        return item


@router.get("/internal/user-items")
async def internal_user_items(
    user_id: str = Query(...),
    status: str = Query("open,in_progress"),
    limit: int = Query(default=10, le=50),
):
    """Get items for a user — called by Discord bridge on localhost only."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Get user's workspace IDs
        mem_resp = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"user_id": f"eq.{user_id}", "select": "workspace_id"},
        )
        ws_ids = [m["workspace_id"] for m in mem_resp.json()] if mem_resp.status_code < 400 else []
        if not ws_ids:
            return {"items": []}

        statuses = status.split(",")
        resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={
                "workspace_id": f"in.({','.join(ws_ids)})",
                "status": f"in.({','.join(statuses)})",
                "order": "updated_at.desc",
                "limit": str(limit),
                "select": "id,type,title,status,priority,workspace_id,due_date,follow_up_date,created_at",
            },
        )
        if resp.status_code >= 400:
            return {"items": []}
        return {"items": resp.json()}


@router.get("/internal/search")
async def internal_search(
    user_id: str = Query(...),
    q: str = Query(..., min_length=1),
    limit: int = Query(default=10, le=50),
):
    """Search items for a user — called by Discord bridge on localhost only."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        mem_resp = await client.get(
            _sb_url("team_membership"),
            headers=headers,
            params={"user_id": f"eq.{user_id}", "select": "workspace_id"},
        )
        ws_ids = [m["workspace_id"] for m in mem_resp.json()] if mem_resp.status_code < 400 else []
        if not ws_ids:
            return {"items": []}

        int_select = "id,type,title,status,priority,workspace_id,custom_id,created_at"
        words = q.strip().split()
        if len(words) <= 1:
            search_params = {
                "workspace_id": f"in.({','.join(ws_ids)})",
                "or": f"(title.ilike.%{q}%,description.ilike.%{q}%,custom_id.ilike.%{q}%)",
                "order": "updated_at.desc,created_at.desc",
                "limit": str(limit),
                "select": int_select,
            }
        else:
            clauses = ",".join(
                f"or(title.ilike.%{w}%,description.ilike.%{w}%,custom_id.ilike.%{w}%)" for w in words
            )
            search_params = {
                "workspace_id": f"in.({','.join(ws_ids)})",
                "and": f"({clauses})",
                "order": "updated_at.desc,created_at.desc",
                "limit": str(limit),
                "select": int_select,
            }
        resp = await client.get(_sb_url("team_items"), headers=headers, params=search_params)
        if resp.status_code >= 400:
            return {"items": []}
        return {"items": resp.json()}


@router.get("/internal/resolve-discord-user")
async def internal_resolve_discord_user(discord_id: str = Query(...)):
    """Resolve Discord user ID to OPAI user ID."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("profiles"),
            headers=headers,
            params={"discord_id": f"eq.{discord_id}", "select": "id,email,display_name"},
        )
        if resp.status_code >= 400 or not resp.json():
            return {"found": False}
        profile = resp.json()[0]
        return {"found": True, "user_id": profile["id"], "email": profile["email"],
                "display_name": profile.get("display_name", "")}


@router.get("/internal/resolve-channel")
async def internal_resolve_channel(channel_id: str = Query(...)):
    """Resolve a Discord channel ID to workspace(s) + bot prompt.
    Returns all workspaces bound to this channel (multi-workspace support)."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_workspaces"),
            headers=headers,
            params={
                "discord_channel_id": f"eq.{channel_id}",
                "select": "id,name,slug,bot_prompt,discord_server_id",
            },
        )
        if resp.status_code >= 400 or not resp.json():
            return {"found": False}
        rows = resp.json()
        # Primary workspace (first match) for backward compat
        ws = rows[0]
        result = {
            "found": True,
            "workspace_id": ws["id"],
            "workspace_name": ws["name"],
            "workspace_slug": ws["slug"],
            "bot_prompt": ws.get("bot_prompt", ""),
            "discord_server_id": ws.get("discord_server_id", ""),
        }
        # All workspaces bound to this channel
        if len(rows) > 1:
            result["workspaces"] = [
                {"workspace_id": r["id"], "workspace_name": r["name"]}
                for r in rows
            ]
        return result


@router.post("/internal/resolve-or-create-discord-member")
async def internal_resolve_or_create_discord_member(
    workspace_id: str = Query(...),
    discord_id: str = Query(...),
    discord_username: str = Query(""),
):
    """Auto-discover a Discord user in a workspace. Creates mapping if new.
    Returns user_id if linked to OPAI profile, or just the discord mapping."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Check existing mapping
        existing = await client.get(
            _sb_url("team_discord_members"),
            headers=headers,
            params={
                "workspace_id": f"eq.{workspace_id}",
                "discord_id": f"eq.{discord_id}",
            },
        )
        if existing.status_code < 400 and existing.json():
            member = existing.json()[0]
            return {"found": True, "user_id": member.get("user_id"),
                    "discord_username": member.get("discord_username", "")}

        # Try to find OPAI user by discord_id in profiles
        profile_resp = await client.get(
            _sb_url("profiles"),
            headers=headers,
            params={"discord_id": f"eq.{discord_id}", "select": "id,display_name"},
        )
        user_id = None
        if profile_resp.status_code < 400 and profile_resp.json():
            user_id = profile_resp.json()[0]["id"]

        # Create the mapping
        await client.post(
            _sb_url("team_discord_members"),
            headers=headers,
            json={
                "workspace_id": workspace_id,
                "discord_id": discord_id,
                "user_id": user_id,
                "discord_username": discord_username,
            },
        )

        # If user_id found, also ensure they're a workspace member
        if user_id:
            mem_check = await client.get(
                _sb_url("team_membership"),
                headers=headers,
                params={"workspace_id": f"eq.{workspace_id}", "user_id": f"eq.{user_id}"},
            )
            if not mem_check.json():
                await client.post(
                    _sb_url("team_membership"),
                    headers=headers,
                    json={"workspace_id": workspace_id, "user_id": user_id, "role": "member"},
                )

        return {"found": True, "user_id": user_id, "discord_username": discord_username,
                "new_member": True}


# ── Internal API — Workspace-scoped (for MCP/Discord AI) ─────

@router.get("/internal/workspace-summary")
async def internal_workspace_summary(workspace_id: str = Query(...)):
    """Workspace overview: name, description, member count, item stats."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        ws_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"id": f"eq.{workspace_id}", "select": "id,name,slug,icon,description,color,created_at"},
        )
        if ws_resp.status_code >= 400 or not ws_resp.json():
            raise HTTPException(status_code=404, detail="Workspace not found")
        ws = ws_resp.json()[0]

        # Member count
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{workspace_id}", "select": "id"},
        )
        member_count = len(mem_resp.json()) if mem_resp.status_code < 400 else 0

        # Item stats by status
        items_resp = await client.get(
            _sb_url("team_items"), headers=headers,
            params={"workspace_id": f"eq.{workspace_id}", "select": "status"},
        )
        items = items_resp.json() if items_resp.status_code < 400 else []
        status_counts = {}
        for item in items:
            s = item.get("status", "open")
            status_counts[s] = status_counts.get(s, 0) + 1

        return {
            "workspace": ws,
            "member_count": member_count,
            "total_items": len(items),
            "status_counts": status_counts,
        }


@router.get("/internal/list-spaces")
async def internal_list_spaces(workspace_id: str = Query(...)):
    """List all spaces (workspaces are spaces in Team Hub) — returns the workspace itself
    plus its folder/list hierarchy summary."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        ws_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"id": f"eq.{workspace_id}", "select": "id,name,slug,icon,color"},
        )
        if ws_resp.status_code >= 400 or not ws_resp.json():
            raise HTTPException(status_code=404, detail="Workspace not found")

        # Count folders and lists
        folders_resp = await client.get(
            _sb_url("team_folders"), headers=headers,
            params={"workspace_id": f"eq.{workspace_id}", "select": "id"},
        )
        lists_resp = await client.get(
            _sb_url("team_lists"), headers=headers,
            params={"workspace_id": f"eq.{workspace_id}", "select": "id"},
        )
        folder_count = len(folders_resp.json()) if folders_resp.status_code < 400 else 0
        list_count = len(lists_resp.json()) if lists_resp.status_code < 400 else 0

        ws = ws_resp.json()[0]
        ws["folder_count"] = folder_count
        ws["list_count"] = list_count
        return {"spaces": [ws]}


@router.get("/internal/list-folders")
async def internal_list_folders(
    workspace_id: str = Query(...),
    space_id: str = Query(None),
):
    """List all folders in a workspace (space_id is alias for workspace_id)."""
    headers = _sb_headers_service()
    ws = space_id or workspace_id
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_folders"), headers=headers,
            params={"workspace_id": f"eq.{ws}", "order": "orderindex.asc,name.asc",
                    "select": "id,name,workspace_id,orderindex,created_at"},
        )
        folders = resp.json() if resp.status_code < 400 else []
        return {"folders": folders}


@router.get("/internal/list-lists")
async def internal_list_lists(
    workspace_id: str = Query(...),
    folder_id: str = Query(None),
):
    """List all lists in a workspace, optionally filtered by folder."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        params = {
            "workspace_id": f"eq.{workspace_id}",
            "order": "orderindex.asc,name.asc",
            "select": "id,name,folder_id,workspace_id,orderindex,created_at",
        }
        if folder_id:
            params["folder_id"] = f"eq.{folder_id}"
        resp = await client.get(_sb_url("team_lists"), headers=headers, params=params)
        lists = resp.json() if resp.status_code < 400 else []
        return {"lists": lists}


@router.get("/internal/list-items")
async def internal_list_items(
    workspace_id: str = Query(...),
    list_id: str = Query(None),
    status: str = Query(None),
    assignee_id: str = Query(None),
    limit: int = Query(default=50, le=200),
):
    """List items in a workspace, optionally filtered by list, status, assignee."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        params = {
            "workspace_id": f"eq.{workspace_id}",
            "order": "updated_at.desc",
            "limit": str(limit),
            "select": "id,type,title,description,status,priority,due_date,follow_up_date,list_id,folder_id,created_by,source,created_at,updated_at",
        }
        if list_id:
            params["list_id"] = f"eq.{list_id}"
        if status:
            statuses = status.split(",")
            if len(statuses) > 1:
                params["status"] = f"in.({','.join(statuses)})"
            else:
                params["status"] = f"eq.{status}"
        resp = await client.get(
            _sb_url("team_items"), headers={**headers, "Prefer": "count=exact"}, params=params,
        )
        items = resp.json() if resp.status_code < 400 else []
        total = int(resp.headers.get("content-range", "0/0").split("/")[-1] or 0)

        # Filter by assignee if requested
        if assignee_id and items:
            item_ids = [i["id"] for i in items]
            assign_resp = await client.get(
                _sb_url("team_assignments"), headers=headers,
                params={"item_id": f"in.({','.join(item_ids)})", "assignee_id": f"eq.{assignee_id}",
                        "select": "item_id"},
            )
            assigned_ids = {a["item_id"] for a in (assign_resp.json() if assign_resp.status_code < 400 else [])}
            items = [i for i in items if i["id"] in assigned_ids]

        return {"items": items, "total": total}


@router.get("/internal/search-items")
async def internal_search_items(
    workspace_id: str = Query(...),
    q: str = Query(..., min_length=1),
    limit: int = Query(default=20, le=100),
):
    """Search items by text within a specific workspace."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        words = q.strip().split()
        if len(words) <= 1:
            search_params = {
                "workspace_id": f"eq.{workspace_id}",
                "or": f"(title.ilike.%{q}%,description.ilike.%{q}%)",
                "order": "updated_at.desc,created_at.desc",
                "limit": str(limit),
                "select": "id,type,title,status,priority,due_date,follow_up_date,list_id,created_at",
            }
        else:
            clauses = ",".join(
                f"or(title.ilike.%{w}%,description.ilike.%{w}%)" for w in words
            )
            search_params = {
                "workspace_id": f"eq.{workspace_id}",
                "and": f"({clauses})",
                "order": "updated_at.desc,created_at.desc",
                "limit": str(limit),
                "select": "id,type,title,status,priority,due_date,follow_up_date,list_id,created_at",
            }
        resp = await client.get(_sb_url("team_items"), headers=headers, params=search_params)
        items = resp.json() if resp.status_code < 400 else []
        return {"items": items, "total": len(items)}


@router.get("/internal/get-item")
async def internal_get_item(item_id: str = Query(...)):
    """Get full item details with comments."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_items"), headers=headers,
            params={"id": f"eq.{item_id}", "select": "*"},
        )
        if resp.status_code >= 400 or not resp.json():
            raise HTTPException(status_code=404, detail="Item not found")
        item = resp.json()[0]

        # Assignments
        assign_resp = await client.get(
            _sb_url("team_assignments"), headers=headers,
            params={"item_id": f"eq.{item_id}", "select": "id,assignee_type,assignee_id,assigned_by,created_at"},
        )
        item["assignments"] = assign_resp.json() if assign_resp.status_code < 400 else []

        # Tags
        tags_resp = await client.get(
            _sb_url("team_item_tags"), headers=headers,
            params={"item_id": f"eq.{item_id}", "select": "tag_id"},
        )
        tag_ids = [t["tag_id"] for t in tags_resp.json()] if tags_resp.status_code < 400 else []
        if tag_ids:
            tag_resp = await client.get(
                _sb_url("team_tags"), headers=headers,
                params={"id": f"in.({','.join(tag_ids)})", "select": "id,name,color"},
            )
            item["tags"] = tag_resp.json() if tag_resp.status_code < 400 else []
        else:
            item["tags"] = []

        # Comments
        comments_resp = await client.get(
            _sb_url("team_comments"), headers=headers,
            params={"item_id": f"eq.{item_id}", "order": "created_at.asc",
                    "select": "id,content,author_id,created_at"},
        )
        item["comments"] = comments_resp.json() if comments_resp.status_code < 400 else []

        return item


@router.get("/internal/search-workspaces")
async def internal_search_workspaces(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=5, le=20),
):
    """Search workspaces by name — called by transcript agent on localhost."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={
                "name": f"ilike.%{q}%",
                "select": "id,name,slug,icon",
                "limit": str(limit),
                "order": "created_at.desc",
            },
        )
        workspaces = resp.json() if resp.status_code < 400 else []
        return {"workspaces": workspaces}


@router.post("/internal/create-workspace")
async def internal_create_workspace(
    name: str = Query(...),
    owner_id: str = Query(...),
    template: str = Query("client"),
):
    """Create a workspace with template structure — called by transcript agent on localhost."""
    headers = _sb_headers_service()
    slug = name.lower().replace(" ", "-").replace("_", "-")
    slug = "".join(c for c in slug if c.isalnum() or c == "-")[:50]

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Create workspace
        ws_resp = await client.post(
            _sb_url("team_workspaces"), headers=headers,
            json={
                "name": name,
                "slug": slug,
                "owner_id": owner_id,
                "is_personal": False,
                "icon": "briefcase",
            },
        )
        if ws_resp.status_code >= 400:
            raise HTTPException(status_code=ws_resp.status_code, detail=ws_resp.text)
        ws = ws_resp.json()[0]

        # Add owner as member
        await client.post(
            _sb_url("team_membership"), headers=headers,
            json={"workspace_id": ws["id"], "user_id": owner_id, "role": "admin"},
        )

        # Apply template folders
        template_folders = {
            "client": ["Meeting Action Items", "Deliverables", "Communications"],
            "project": ["Tasks", "Documentation", "Research"],
        }
        folders = template_folders.get(template, template_folders["client"])
        for folder_name in folders:
            await client.post(
                _sb_url("team_folders"), headers=headers,
                json={"workspace_id": ws["id"], "name": folder_name, "created_by": owner_id},
            )

        # Create default statuses
        default_statuses = [
            {"name": "Open", "color": "#3B82F6", "position": 0, "category": "todo"},
            {"name": "In Progress", "color": "#F59E0B", "position": 1, "category": "active"},
            {"name": "Done", "color": "#10B981", "position": 2, "category": "done"},
        ]
        for s in default_statuses:
            await client.post(
                _sb_url("team_statuses"), headers=headers,
                json={"workspace_id": ws["id"], **s},
            )

        await _log_activity(client, ws["id"], "workspace_created", owner_id,
                            details={"name": name, "template": template, "source": "transcript-agent"})
        return ws


@router.post("/internal/create-space")
async def internal_create_space(
    workspace_id: str = Query(...),
    name: str = Query(...),
):
    """Create a new folder (space-level container) in a workspace."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("team_folders"), headers=headers,
            json={"workspace_id": workspace_id, "name": name, "created_by": "ai-assistant"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.post("/internal/create-folder")
async def internal_create_folder(
    workspace_id: str = Query(...),
    name: str = Query(...),
):
    """Create a new folder in a workspace."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("team_folders"), headers=headers,
            json={"workspace_id": workspace_id, "name": name, "created_by": "ai-assistant"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.post("/internal/create-list")
async def internal_create_list(
    workspace_id: str = Query(...),
    name: str = Query(...),
    folder_id: str = Query(None),
):
    """Create a new list in a workspace (optionally inside a folder)."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        data = {"workspace_id": workspace_id, "name": name, "created_by": "ai-assistant"}
        if folder_id:
            data["folder_id"] = folder_id
        resp = await client.post(_sb_url("team_lists"), headers=headers, json=data)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.patch("/internal/update-item")
async def internal_update_item(
    item_id: str = Query(...),
    title: str = Query(None),
    description: str = Query(None),
    status: str = Query(None),
    priority: str = Query(None),
    due_date: str = Query(None),
    follow_up_date: str = Query(None),
    list_id: str = Query(None),
):
    """Update an item's fields."""
    headers = _sb_headers_service()
    update = {}
    if title is not None:
        update["title"] = title
    if description is not None:
        update["description"] = description
    if status is not None:
        update["status"] = status
    if priority is not None:
        update["priority"] = priority
    if due_date is not None:
        update["due_date"] = due_date if due_date != "none" else None
    if follow_up_date is not None:
        update["follow_up_date"] = follow_up_date if follow_up_date != "none" else None
    if list_id is not None:
        update["list_id"] = list_id if list_id != "none" else None
    if not update:
        raise HTTPException(status_code=400, detail="No fields to update")
    update["updated_at"] = datetime.now(timezone.utc).isoformat()

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            _sb_url("team_items"), headers=headers,
            params={"id": f"eq.{item_id}"}, json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        result = resp.json()
        if not result:
            raise HTTPException(status_code=404, detail="Item not found")
        return result[0]


@router.post("/internal/add-comment")
async def internal_add_comment(
    item_id: str = Query(...),
    content: str = Query(...),
    author_id: str = Query("ai-assistant"),
):
    """Add a comment to an item. Parses @mentions and creates notifications."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("team_comments"), headers=headers,
            json={"item_id": item_id, "content": content, "author_id": author_id},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        # Parse @[Name](uuid) mentions and create notifications
        await _parse_mentions(client, content, item_id, author_id)
        return resp.json()[0]


@router.post("/internal/assign-item")
async def internal_assign_item(
    item_id: str = Query(...),
    assignee_id: str = Query(...),
    assignee_type: str = Query("user"),
    assigned_by: str = Query("discord-bot"),
):
    """Assign a user to an item. Replaces existing assignment if one exists."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Remove existing assignment for this assignee (idempotent)
        await client.delete(
            _sb_url("team_assignments"),
            headers=headers,
            params={"item_id": f"eq.{item_id}", "assignee_id": f"eq.{assignee_id}"},
        )
        # Create new assignment
        resp = await client.post(
            _sb_url("team_assignments"), headers=headers,
            json={
                "item_id": item_id,
                "assignee_type": assignee_type,
                "assignee_id": assignee_id,
                "assigned_by": assigned_by,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.get("/internal/list-members")
async def internal_list_members(
    workspace_id: str = Query(...),
):
    """List all members of a workspace with their profiles."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={
                "workspace_id": f"eq.{workspace_id}",
                "select": "user_id,role,created_at",
            },
        )
        if mem_resp.status_code >= 400:
            return {"members": []}

        memberships = mem_resp.json()
        if not memberships:
            return {"members": []}

        user_ids = [m["user_id"] for m in memberships if m.get("user_id")]
        if not user_ids:
            return {"members": []}

        profiles_resp = await client.get(
            _sb_url("profiles"), headers=headers,
            params={
                "id": f"in.({','.join(user_ids)})",
                "select": "id,email,display_name,discord_id",
            },
        )
        profiles = {p["id"]: p for p in (profiles_resp.json() if profiles_resp.status_code < 400 else [])}

        members = []
        for m in memberships:
            uid = m.get("user_id")
            profile = profiles.get(uid, {})
            members.append({
                "user_id": uid,
                "role": m["role"],
                "display_name": profile.get("display_name", ""),
                "email": profile.get("email", ""),
                "discord_id": profile.get("discord_id", ""),
            })
        return {"members": members}


# ══════════════════════════════════════════════════════════════
# ClickUp Import (SSE streaming migration)
# ══════════════════════════════════════════════════════════════

CLICKUP_BASE = getattr(config, "CLICKUP_BASE", "https://api.clickup.com/api/v2")

# Admin's default key (Dallas-ADMIN) — pre-filled for admin users
CLICKUP_ADMIN_KEY = getattr(config, "CLICKUP_API_KEY", "")
CLICKUP_ADMIN_TEAM_ID = getattr(config, "CLICKUP_TEAM_ID", "")

# Owner user ID for the system admin
ADMIN_USER_ID = "1c93c5fe-d304-40f2-9169-765d0d2b7638"

STATUS_MAP = {
    "to do": "Not Started", "not started": "Not Started", "open": "Not Started",
    "in progress": "Working on", "working on": "Working on",
    "in review": "Manager Review", "review": "Manager Review", "manager review": "Manager Review",
    "back to you": "Back to You", "stuck": "Stuck", "blocked": "Stuck",
    "waiting on client": "Waiting on Client", "client review": "Client Review",
    "approved": "Approved", "postponed": "Postponed",
    "quality review": "Quality Review",
    "complete": "Complete", "closed": "Complete", "done": "Complete", "archived": "Complete",
}
PRIORITY_MAP = {
    "urgent": "critical", "high": "high", "normal": "medium", "low": "low", None: "medium",
}


@router.get("/clickup/admin-key-hint")
async def clickup_admin_key_hint(user: AuthUser = Depends(get_current_user)):
    """Return whether the current user gets the pre-filled admin key."""
    is_admin = user.id == ADMIN_USER_ID
    return {
        "is_admin": is_admin,
        "key_hint": CLICKUP_ADMIN_KEY[:8] + "..." if is_admin and CLICKUP_ADMIN_KEY else "",
        "prefill_key": CLICKUP_ADMIN_KEY if is_admin else "",
    }


@router.post("/clickup/connect")
async def clickup_connect(
    api_key: str = Query(..., description="User's ClickUp API key"),
    user: AuthUser = Depends(get_current_user),
):
    """Validate a ClickUp API key and return teams + spaces hierarchy."""
    cu_h = {"Authorization": api_key}
    async with httpx.AsyncClient(timeout=15.0) as client:
        # First get teams (to discover team_id)
        teams_resp = await client.get(f"{CLICKUP_BASE}/team", headers=cu_h)
        if teams_resp.status_code >= 400:
            raise HTTPException(status_code=401, detail="Invalid ClickUp API key")
        teams = teams_resp.json().get("teams", [])
        if not teams:
            raise HTTPException(status_code=404, detail="No ClickUp teams found for this key")

        # Get spaces for each team with full hierarchy
        result = []
        for team in teams:
            team_id = team["id"]
            team_name = team["name"]

            spaces_resp = await client.get(
                f"{CLICKUP_BASE}/team/{team_id}/space",
                headers=cu_h, params={"archived": "false"},
            )
            spaces = spaces_resp.json().get("spaces", []) if spaces_resp.status_code < 400 else []

            space_list = []
            for space in spaces:
                space_info = {"id": space["id"], "name": space["name"], "folders": [], "lists": []}

                # Folderless lists
                try:
                    fl_resp = await client.get(f"{CLICKUP_BASE}/space/{space['id']}/list", headers=cu_h)
                    for lst in fl_resp.json().get("lists", []):
                        task_count = lst.get("task_count", 0)
                        space_info["lists"].append({"id": lst["id"], "name": lst["name"], "task_count": task_count})
                except Exception:
                    pass

                # Folders with their lists
                try:
                    fd_resp = await client.get(f"{CLICKUP_BASE}/space/{space['id']}/folder", headers=cu_h)
                    for folder in fd_resp.json().get("folders", []):
                        folder_info = {"id": folder["id"], "name": folder["name"], "lists": []}
                        for lst in folder.get("lists", []):
                            task_count = lst.get("task_count", 0)
                            folder_info["lists"].append({"id": lst["id"], "name": lst["name"], "task_count": task_count})
                        space_info["folders"].append(folder_info)
                except Exception:
                    pass

                space_list.append(space_info)

            result.append({"team_id": team_id, "team_name": team_name, "spaces": space_list})

        return {"teams": result}


@router.get("/clickup/import")
async def import_clickup(
    api_key: str = Query(..., description="User's ClickUp API key"),
    space_ids: str = Query("", description="Comma-separated ClickUp space IDs to import"),
    user: AuthUser = Depends(get_current_user),
):
    """Stream ClickUp import progress via SSE. Uses the user's own API key."""
    cu_h = {"Authorization": api_key}
    owner_id = user.id
    selected_space_ids = set(s.strip() for s in space_ids.split(",") if s.strip()) if space_ids else set()

    import re as re_mod

    async def sse_stream():
        stats = {"spaces": 0, "folders": 0, "lists": 0, "tasks": 0, "comments": 0, "tags": 0, "docs": 0, "skipped": 0}
        tag_cache = {}
        user_map = {}
        folder_cache = {}
        list_cache = {}
        cu_folder_id_map = {}   # ClickUp folder ID → Supabase folder UUID
        cu_list_id_map = {}     # ClickUp list ID → Supabase list UUID

        def send_event(data):
            return f"data: {json.dumps(data)}\n\n"

        headers = _sb_headers_service()

        async with httpx.AsyncClient(timeout=15.0) as client:
            # Load user map
            yield send_event({"phase": "init", "message": "Loading user profiles..."})
            profiles = await client.get(_sb_url("profiles"), headers=headers, params={"select": "id,email"})
            for p in (profiles.json() if profiles.status_code < 400 else []):
                if p.get("email"):
                    user_map[p["email"].lower()] = p["id"]
            yield send_event({"phase": "init", "message": f"Loaded {len(user_map)} user profiles"})

            # Get teams
            yield send_event({"phase": "fetching", "message": "Fetching ClickUp teams..."})
            try:
                teams_resp = await client.get(f"{CLICKUP_BASE}/team", headers=cu_h)
                teams_resp.raise_for_status()
                teams = teams_resp.json().get("teams", [])
            except Exception as e:
                yield send_event({"phase": "error", "message": f"Failed to connect: {e}"})
                yield send_event({"phase": "done", "stats": stats})
                return

            # Gather all spaces across teams
            all_spaces = []
            for team in teams:
                try:
                    sp_resp = await client.get(
                        f"{CLICKUP_BASE}/team/{team['id']}/space",
                        headers=cu_h, params={"archived": "false"},
                    )
                    sp_resp.raise_for_status()
                    for sp in sp_resp.json().get("spaces", []):
                        if not selected_space_ids or str(sp["id"]) in selected_space_ids:
                            sp["_team_id"] = team["id"]
                            all_spaces.append(sp)
                except Exception as e:
                    yield send_event({"phase": "error", "message": f"Failed to fetch spaces for team {team['name']}: {e}"})

            total_spaces = len(all_spaces)
            yield send_event({"phase": "fetching", "message": f"Found {total_spaces} space(s) to import", "total_spaces": total_spaces})

            for si, space in enumerate(all_spaces):
                space_name = space["name"]
                yield send_event({"phase": "space", "space_index": si, "total_spaces": total_spaces,
                                  "space_name": space_name, "message": f"Importing space {si+1}/{total_spaces}: {space_name}"})

                # Create workspace
                slug_base = re_mod.sub(r'[^a-z0-9]+', '-', space_name.lower()).strip('-')[:50]
                slug = f"cu-{slug_base}-{int(time.time()) % 100000}"

                existing = await client.get(_sb_url("team_workspaces"), headers=headers,
                                             params={"slug": f"like.cu-{slug_base}%"})
                if existing.status_code < 400 and existing.json():
                    ws_id = existing.json()[0]["id"]
                    yield send_event({"phase": "space", "message": f"Workspace already exists: {space_name}", "ws_id": ws_id})
                else:
                    ws_resp = await client.post(_sb_url("team_workspaces"), headers=headers, json={
                        "name": space_name, "slug": slug, "icon": "", "owner_id": owner_id, "is_personal": False,
                    })
                    if ws_resp.status_code >= 400:
                        yield send_event({"phase": "error", "message": f"Failed to create workspace: {space_name}"})
                        continue
                    ws_id = ws_resp.json()[0]["id"]
                    await client.post(_sb_url("team_membership"), headers=headers, json={
                        "user_id": owner_id, "workspace_id": ws_id, "role": "owner",
                    })
                stats["spaces"] += 1

                # Helper closures capture ws_id via default arg
                async def get_or_create_folder(fname, _ws=ws_id):
                    key = (_ws, fname)
                    if key in folder_cache:
                        return folder_cache[key]
                    f = await client.post(_sb_url("team_folders"), headers=headers, json={
                        "workspace_id": _ws, "name": fname, "created_by": owner_id,
                    })
                    if f.status_code < 400 and f.json():
                        folder_cache[key] = f.json()[0]["id"]
                        stats["folders"] += 1
                        return f.json()[0]["id"]
                    return None

                async def get_or_create_list(lname, fid=None, _ws=ws_id):
                    key = (_ws, fid, lname)
                    if key in list_cache:
                        return list_cache[key]
                    data = {"workspace_id": _ws, "name": lname, "created_by": owner_id}
                    if fid:
                        data["folder_id"] = fid
                    l = await client.post(_sb_url("team_lists"), headers=headers, json=data)
                    if l.status_code < 400 and l.json():
                        list_cache[key] = l.json()[0]["id"]
                        return l.json()[0]["id"]
                    return None

                async def get_or_create_tag(tag_name, color="#6366f1", _ws=ws_id):
                    key = (_ws, tag_name.lower())
                    if key in tag_cache:
                        return tag_cache[key]
                    existing_t = await client.get(_sb_url("team_tags"), headers=headers,
                                                   params={"workspace_id": f"eq.{_ws}", "name": f"eq.{tag_name}"})
                    if existing_t.status_code < 400 and existing_t.json():
                        tag_cache[key] = existing_t.json()[0]["id"]
                        return existing_t.json()[0]["id"]
                    t = await client.post(_sb_url("team_tags"), headers=headers, json={
                        "workspace_id": _ws, "name": tag_name, "color": color,
                    })
                    if t.status_code < 400 and t.json():
                        tag_cache[key] = t.json()[0]["id"]
                        stats["tags"] += 1
                        return t.json()[0]["id"]
                    return None

                async def import_task(task, folder_name, list_name, folder_id, list_id, _ws=ws_id):
                    title = task.get("name", "Untitled")
                    description = task.get("description") or ""
                    meta = []
                    if folder_name:
                        meta.append(f"Folder: {folder_name}")
                    if list_name:
                        meta.append(f"List: {list_name}")
                    meta.append(f"ClickUp ID: {task.get('id', '')}")
                    if task.get("url"):
                        meta.append(f"Original: {task['url']}")
                    if meta:
                        description = description.rstrip() + "\n\n---\n" + "\n".join(meta)

                    cu_status = task.get("status", {})
                    if isinstance(cu_status, dict):
                        cu_status = cu_status.get("status", "open")
                    status = STATUS_MAP.get((cu_status or "").lower().strip(), "open")

                    cu_priority = task.get("priority")
                    if isinstance(cu_priority, dict):
                        cu_priority = cu_priority.get("priority")
                    priority = PRIORITY_MAP.get(cu_priority, "medium")

                    due_ms = task.get("due_date")
                    due_date = None
                    if due_ms:
                        try:
                            due_date = datetime.fromtimestamp(int(due_ms) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
                        except (ValueError, TypeError):
                            pass

                    item_data = {
                        "workspace_id": _ws, "type": "task", "title": title,
                        "description": description, "status": status, "priority": priority,
                        "due_date": due_date, "source": "clickup", "created_by": owner_id,
                    }
                    if list_id:
                        item_data["list_id"] = list_id
                    if folder_id:
                        item_data["folder_id"] = folder_id

                    item_resp = await client.post(_sb_url("team_items"), headers=headers, json=item_data)
                    if item_resp.status_code >= 400:
                        stats["skipped"] += 1
                        return None
                    item_id = item_resp.json()[0]["id"]
                    stats["tasks"] += 1

                    for assignee in task.get("assignees", []):
                        email = (assignee.get("email") or "").lower()
                        opai_id = user_map.get(email)
                        if opai_id:
                            await client.post(_sb_url("team_assignments"), headers=headers, json={
                                "item_id": item_id, "assignee_type": "user",
                                "assignee_id": opai_id, "assigned_by": owner_id,
                            })
                        else:
                            username = assignee.get("username", assignee.get("email", "unknown"))
                            await client.post(_sb_url("team_assignments"), headers=headers, json={
                                "item_id": item_id, "assignee_type": "user",
                                "assignee_id": f"clickup:{username}", "assigned_by": owner_id,
                            })

                    for tag in task.get("tags", []):
                        tag_name = tag.get("name") if isinstance(tag, dict) else str(tag)
                        if tag_name:
                            tag_color = tag.get("tag_fg", "#6366f1") if isinstance(tag, dict) else "#6366f1"
                            tid = await get_or_create_tag(tag_name, tag_color)
                            if tid:
                                await client.post(_sb_url("team_item_tags"), headers=headers, json={"item_id": item_id, "tag_id": tid})

                    return item_id

                async def import_list(cu_list_id, list_name, folder_name=None):
                    folder_id = None
                    if folder_name:
                        folder_id = await get_or_create_folder(folder_name)
                    hub_list_id = await get_or_create_list(list_name, folder_id)
                    stats["lists"] += 1

                    page = 0
                    while True:
                        try:
                            task_resp = await client.get(
                                f"{CLICKUP_BASE}/list/{cu_list_id}/task",
                                headers=cu_h,
                                params={"include_closed": "true", "subtasks": "true", "page": str(page)},
                            )
                            task_resp.raise_for_status()
                            task_data = task_resp.json()
                        except Exception as e:
                            break

                        tasks = task_data.get("tasks", [])
                        if not tasks:
                            break

                        for task in tasks:
                            await import_task(task, folder_name, list_name, folder_id, hub_list_id)
                            await asyncio.sleep(0.1)

                        if task_data.get("last_page", True):
                            break
                        page += 1

                # Import folderless lists
                try:
                    fl_resp = await client.get(f"{CLICKUP_BASE}/space/{space['id']}/list", headers=cu_h)
                    fl_resp.raise_for_status()
                    folderless = fl_resp.json().get("lists", [])
                    for lst in folderless:
                        yield send_event({"phase": "list", "space_name": space_name, "list_name": lst["name"],
                                          "message": f"[{space_name}] List: {lst['name']}"})
                        await import_list(lst["id"], lst["name"])
                        # Track ClickUp list ID → Supabase list UUID
                        lkey = (ws_id, None, lst["name"])
                        if lkey in list_cache:
                            cu_list_id_map[str(lst["id"])] = list_cache[lkey]
                        yield send_event({"phase": "progress", "stats": dict(stats)})
                except Exception as e:
                    yield send_event({"phase": "error", "message": f"Folderless lists error: {e}"})

                # Import folders + their lists
                try:
                    fd_resp = await client.get(f"{CLICKUP_BASE}/space/{space['id']}/folder", headers=cu_h)
                    fd_resp.raise_for_status()
                    folders = fd_resp.json().get("folders", [])
                    for folder in folders:
                        fname = folder["name"]
                        yield send_event({"phase": "folder", "space_name": space_name, "folder_name": fname,
                                          "message": f"[{space_name}] Folder: {fname}"})
                        for lst in folder.get("lists", []):
                            yield send_event({"phase": "list", "list_name": lst["name"], "folder_name": fname,
                                              "message": f"  List: {lst['name']}"})
                            await import_list(lst["id"], lst["name"], fname)
                            # Track ClickUp list ID → Supabase list UUID
                            fkey = (ws_id, fname)
                            hub_folder_id = folder_cache.get(fkey)
                            lkey = (ws_id, hub_folder_id, lst["name"])
                            if lkey in list_cache:
                                cu_list_id_map[str(lst["id"])] = list_cache[lkey]
                            yield send_event({"phase": "progress", "stats": dict(stats)})
                        # Track ClickUp folder ID → Supabase folder UUID (after lists populate folder_cache)
                        fkey = (ws_id, fname)
                        if fkey in folder_cache:
                            cu_folder_id_map[str(folder["id"])] = folder_cache[fkey]
                except Exception as e:
                    yield send_event({"phase": "error", "message": f"Folders error: {e}"})

                # Import ClickUp Docs for this space (v3 API)
                cu_team_id = space.get("_team_id", "")
                if cu_team_id:
                    try:
                        yield send_event({"phase": "docs", "space_name": space_name,
                                          "message": f"[{space_name}] Fetching docs..."})
                        CLICKUP_V3 = "https://api.clickup.com/api/v3"
                        docs_resp = await client.get(
                            f"{CLICKUP_V3}/workspaces/{cu_team_id}/docs",
                            headers=cu_h,
                        )
                        if docs_resp.status_code < 400:
                            cu_docs = docs_resp.json().get("data", docs_resp.json().get("docs", []))
                            if not isinstance(cu_docs, list):
                                cu_docs = []
                            space_doc_count = 0
                            for cu_doc in cu_docs:
                                doc_id_cu = cu_doc.get("id", "")
                                doc_name = cu_doc.get("name") or cu_doc.get("title") or "Untitled Doc"

                                # Determine parent attachment from ClickUp doc metadata
                                doc_folder_id = None
                                doc_list_id = None
                                doc_item_id = None

                                # ClickUp docs can have parent info — map to our hierarchy
                                cu_parent = cu_doc.get("parent", {}) or {}
                                cu_parent_id = str(cu_parent.get("id", ""))
                                cu_parent_type = cu_parent.get("type", "")
                                if cu_parent_type == "folder" and cu_parent_id:
                                    doc_folder_id = cu_folder_id_map.get(cu_parent_id)
                                elif cu_parent_type == "list" and cu_parent_id:
                                    doc_list_id = cu_list_id_map.get(cu_parent_id)

                                # Check if already imported
                                existing_doc = await client.get(
                                    _sb_url("team_docs"), headers=headers,
                                    params={"workspace_id": f"eq.{ws_id}", "source_id": f"eq.{doc_id_cu}"},
                                )
                                if existing_doc.status_code < 400 and existing_doc.json():
                                    continue  # Already imported

                                # Fetch the full doc to get content
                                doc_content = ""
                                doc_pages_data = []
                                try:
                                    full_doc = await client.get(
                                        f"{CLICKUP_V3}/workspaces/{cu_team_id}/docs/{doc_id_cu}",
                                        headers=cu_h,
                                    )
                                    if full_doc.status_code < 400:
                                        fd = full_doc.json().get("data", full_doc.json())
                                        doc_content = fd.get("content", "") or fd.get("description", "") or ""
                                        doc_pages_data = fd.get("pages", [])
                                        if not isinstance(doc_pages_data, list):
                                            doc_pages_data = []
                                except Exception:
                                    pass

                                # Create the doc in Supabase
                                doc_data = {
                                    "workspace_id": ws_id,
                                    "title": doc_name,
                                    "content": doc_content,
                                    "source": "clickup",
                                    "source_id": doc_id_cu,
                                    "created_by": owner_id,
                                }
                                if doc_folder_id:
                                    doc_data["folder_id"] = doc_folder_id
                                if doc_list_id:
                                    doc_data["list_id"] = doc_list_id

                                doc_resp_sb = await client.post(
                                    _sb_url("team_docs"), headers=headers, json=doc_data,
                                )
                                if doc_resp_sb.status_code >= 400:
                                    stats["skipped"] += 1
                                    continue
                                hub_doc_id = doc_resp_sb.json()[0]["id"]
                                stats["docs"] += 1
                                space_doc_count += 1

                                # Import pages if available
                                for pi, page in enumerate(doc_pages_data):
                                    page_id_cu = page.get("id", "")
                                    page_title = page.get("title") or page.get("name") or f"Page {pi+1}"
                                    page_content = page.get("content", "")

                                    # Try fetching individual page content if not inline
                                    if not page_content and page_id_cu:
                                        try:
                                            pg_resp = await client.get(
                                                f"{CLICKUP_V3}/workspaces/{cu_team_id}/docs/{doc_id_cu}/pages/{page_id_cu}",
                                                headers=cu_h,
                                            )
                                            if pg_resp.status_code < 400:
                                                pg_data = pg_resp.json().get("data", pg_resp.json())
                                                page_content = pg_data.get("content", "")
                                        except Exception:
                                            pass

                                    await client.post(
                                        _sb_url("team_doc_pages"), headers=headers,
                                        json={
                                            "doc_id": hub_doc_id,
                                            "title": page_title,
                                            "content": page_content,
                                            "orderindex": pi,
                                            "source_id": page_id_cu,
                                        },
                                    )
                                    await asyncio.sleep(0.05)

                                await asyncio.sleep(0.1)

                            if space_doc_count > 0:
                                yield send_event({"phase": "docs", "space_name": space_name,
                                                  "message": f"[{space_name}] Imported {space_doc_count} doc(s)",
                                                  "stats": dict(stats)})
                            else:
                                yield send_event({"phase": "docs", "space_name": space_name,
                                                  "message": f"[{space_name}] No docs found"})
                        else:
                            yield send_event({"phase": "docs", "space_name": space_name,
                                              "message": f"[{space_name}] Docs API returned {docs_resp.status_code} (may require ClickUp Business+ plan)"})
                    except Exception as e:
                        yield send_event({"phase": "error", "message": f"Docs import error: {e}"})

                yield send_event({"phase": "space_done", "space_name": space_name, "stats": dict(stats)})
                await asyncio.sleep(0.3)

            yield send_event({"phase": "done", "stats": stats, "message": "Import complete!"})

    return StreamingResponse(sse_stream(), media_type="text/event-stream")


# ── AI Chat ───────────────────────────────────────────────────

class AIChatMessage(BaseModel):
    role: str   # "user" | "assistant"
    content: str

class AIChatRequest(BaseModel):
    messages: List[AIChatMessage]
    workspace_id: Optional[str] = None  # optional — focus on a specific workspace

@router.post("/ai/chat")
async def ai_chat(req: AIChatRequest, user: AuthUser = Depends(get_current_user)):
    """AI assistant with full cross-workspace knowledge, personalized to the user."""
    import logging
    from claude_api import call_claude
    log = logging.getLogger("opai.team_hub.ai")

    t0 = time.time()
    headers = _sb_headers_service()

    user_name = getattr(user, "display_name", "") or ""
    if not user_name and hasattr(user, "email") and user.email:
        user_name = user.email.split("@")[0]

    async with httpx.AsyncClient(timeout=10.0) as hc:
        # Step 1: memberships (needed before everything else)
        mem_resp = await hc.get(
            _sb_url("team_membership"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "workspace_id,role"},
        )
        memberships = mem_resp.json() if mem_resp.status_code < 400 else []
        ws_ids = [m["workspace_id"] for m in memberships]
        if not ws_ids:
            raise HTTPException(status_code=404, detail="No workspaces found")

        ws_roles = {m["workspace_id"]: m.get("role", "member") for m in memberships}
        ws_filter = f"in.({','.join(ws_ids)})"
        focused_ws_id = req.workspace_id if req.workspace_id and req.workspace_id in ws_ids else None
        item_ws_filter = f"eq.{focused_ws_id}" if focused_ws_id else ws_filter

        # Step 2: parallel — workspaces + items + assignments
        ws_fut = hc.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"id": ws_filter, "select": "id,name,bot_prompt"},
        )
        items_fut = hc.get(
            _sb_url("team_items"), headers=headers,
            params={"workspace_id": item_ws_filter,
                    "select": "id,title,status,priority,due_date,workspace_id",
                    "order": "updated_at.desc", "limit": "60"},
        )
        assign_fut = hc.get(
            _sb_url("team_assignments"), headers=headers,
            params={"assignee_id": f"eq.{user.id}", "select": "item_id"},
        )
        ws_resp, items_resp, assign_resp = await asyncio.gather(ws_fut, items_fut, assign_fut)

    workspaces = ws_resp.json() if ws_resp.status_code < 400 else []
    ws_map = {w["id"]: w for w in workspaces}
    items = items_resp.json() if items_resp.status_code < 400 else []
    my_item_ids = {a["item_id"] for a in (assign_resp.json() if assign_resp.status_code < 400 else [])}

    t_db = time.time()
    log.info(f"AI chat DB queries: {(t_db - t0)*1000:.0f}ms")

    # ── Build compact context ──────────────────────────────────
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ctx = []
    for ws in workspaces:
        ws_items = [i for i in items if i.get("workspace_id") == ws["id"]]
        if not ws_items:
            continue
        open_items = [i for i in ws_items if i.get("status") not in ("done", "closed", "Complete")]
        overdue = [i for i in open_items if i.get("due_date") and i["due_date"] < today]
        titles = [i["title"] for i in open_items if i.get("title")][:6]
        line = f'{ws["name"]}: {len(open_items)} open'
        if overdue:
            line += f', {len(overdue)} overdue'
        if titles:
            line += " — " + "; ".join(titles)
        ctx.append(line)

    my_open = [i for i in items if i.get("id") in my_item_ids and i.get("status") not in ("done", "closed", "Complete")]
    my_section = ""
    if my_open:
        my_lines = []
        for i in my_open[:10]:
            ws_name = ws_map.get(i.get("workspace_id"), {}).get("name", "")
            due = f' DUE {i["due_date"]}' if i.get("due_date") else ""
            my_lines.append(f'[{i.get("status","open")}] {i["title"]} ({ws_name}){due}')
        my_section = f"\nYour tasks ({len(my_open)}):\n" + "\n".join(my_lines)

    focused_ws = ws_map.get(focused_ws_id)
    focus_note = f"\nCurrently viewing: {focused_ws['name']}" if focused_ws else ""

    system_prompt = (
        f"You are the Team Hub assistant talking to {user_name}. Be concise and direct. "
        f"Address them by name. You see all their workspaces and tasks.\n\n"
        f"Workspaces:\n" + "\n".join(ctx) + my_section + focus_note
    )

    # Build messages
    ai_messages = [
        {"role": m.role, "content": m.content}
        for m in req.messages
        if m.role in ("user", "assistant") and m.content.strip()
    ]
    if not ai_messages or ai_messages[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="Last message must be from user")

    # Flatten for CLI: system + conversation
    prompt = system_prompt + "\n\n"
    for msg in ai_messages[:-1]:
        prompt += f"{'Human' if msg['role'] == 'user' else 'Assistant'}: {msg['content']}\n\n"
    prompt += f"Human: {ai_messages[-1]['content']}"

    t_prompt = time.time()
    log.info(f"AI chat prompt built: {(t_prompt - t_db)*1000:.0f}ms, {len(prompt)} chars")

    try:
        result = await call_claude(
            prompt,
            model="claude-haiku-4-5",
            max_tokens=512,
            timeout=30,
            api_key="",  # force CLI — no API keys for internal tools
        )
        reply = result.get("content", "").strip() or "I wasn't able to generate a response."
        log.info(f"AI chat Claude CLI: {result.get('duration_ms', 0)}ms")
    except Exception as exc:
        log.error(f"AI chat error: {exc}")
        reply = f"Sorry, I encountered an error: {exc}"

    log.info(f"AI chat total: {(time.time() - t0)*1000:.0f}ms")
    return {"reply": reply}


# ── Subtask Reorder ──────────────────────────────────────────

class ReorderSubtasks(BaseModel):
    subtask_ids: list[str]


@router.post("/items/{item_id}/subtasks/reorder")
async def reorder_subtasks(item_id: str, req: ReorderSubtasks, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        item_resp = await client.get(
            _sb_url("team_items"), headers=headers,
            params={"id": f"eq.{item_id}", "select": "workspace_id"},
        )
        if item_resp.status_code >= 400 or not item_resp.json():
            raise HTTPException(status_code=404, detail="Item not found")
        ws_id = item_resp.json()[0]["workspace_id"]
        mem_check = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user.id}"},
        )
        if not mem_check.json():
            raise HTTPException(status_code=404, detail="Item not found")
        for idx, sub_id in enumerate(req.subtask_ids):
            await client.patch(
                _sb_url("team_items"), headers=headers,
                params={"id": f"eq.{sub_id}", "parent_id": f"eq.{item_id}"},
                json={"orderindex": idx},
            )
    return {"ok": True}


# ── Favorites ────────────────────────────────────────────────

class ToggleFavorite(BaseModel):
    target_type: str  # "workspace", "folder", "list", "item"
    target_id: str


class ReorderFavorites(BaseModel):
    favorite_ids: list[str]


@router.get("/my/favorites")
async def list_favorites(user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_favorites"), headers=headers,
            params={"user_id": f"eq.{user.id}", "order": "orderindex.asc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"favorites": resp.json()}


@router.post("/my/favorites")
async def toggle_favorite(req: ToggleFavorite, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        existing = await client.get(
            _sb_url("team_favorites"), headers=headers,
            params={
                "user_id": f"eq.{user.id}",
                "target_type": f"eq.{req.target_type}",
                "target_id": f"eq.{req.target_id}",
            },
        )
        if existing.status_code < 400 and existing.json():
            await client.delete(
                _sb_url("team_favorites"), headers=headers,
                params={"id": f"eq.{existing.json()[0]['id']}"},
            )
            return {"action": "removed"}
        resp = await client.post(
            _sb_url("team_favorites"), headers=headers,
            json={
                "user_id": user.id,
                "target_type": req.target_type,
                "target_id": req.target_id,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"action": "added", "favorite": resp.json()[0]}


@router.post("/my/favorites/reorder")
async def reorder_favorites(req: ReorderFavorites, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        for idx, fav_id in enumerate(req.favorite_ids):
            await client.patch(
                _sb_url("team_favorites"), headers=headers,
                params={"id": f"eq.{fav_id}", "user_id": f"eq.{user.id}"},
                json={"orderindex": idx},
            )
    return {"ok": True}


@router.delete("/my/favorites/{fav_id}")
async def delete_favorite(fav_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            _sb_url("team_favorites"), headers=headers,
            params={"id": f"eq.{fav_id}", "user_id": f"eq.{user.id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


# ── Reminders ────────────────────────────────────────────────

class CreateReminder(BaseModel):
    item_id: str
    remind_at: str
    note: str = ""


@router.get("/my/reminders")
async def list_reminders(user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_reminders"), headers=headers,
            params={"user_id": f"eq.{user.id}", "fired": "eq.false", "order": "remind_at.asc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"reminders": resp.json()}


@router.post("/my/reminders")
async def create_reminder(req: CreateReminder, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("team_reminders"), headers=headers,
            json={
                "user_id": user.id,
                "item_id": req.item_id,
                "remind_at": req.remind_at,
                "note": req.note,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/my/reminders/{reminder_id}")
async def delete_reminder(reminder_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            _sb_url("team_reminders"), headers=headers,
            params={"id": f"eq.{reminder_id}", "user_id": f"eq.{user.id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


@router.post("/internal/fire-reminders")
async def fire_reminders():
    """Fire due reminders — converts them to notifications. Called by Engine heartbeat."""
    headers = _sb_headers_service()
    now = datetime.now(timezone.utc).isoformat()
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            _sb_url("team_reminders"), headers=headers,
            params={"fired": "eq.false", "remind_at": f"lte.{now}", "limit": "100"},
        )
        if resp.status_code >= 400:
            return {"fired": 0}
        reminders = resp.json()
        fired = 0
        for r in reminders:
            item_resp = await client.get(
                _sb_url("team_items"), headers=headers,
                params={"id": f"eq.{r['item_id']}", "select": "title,workspace_id"},
            )
            title = ""
            if item_resp.status_code < 400 and item_resp.json():
                title = item_resp.json()[0].get("title", "")
            await client.post(
                _sb_url("team_notifications"), headers=headers,
                json={
                    "user_id": r["user_id"],
                    "type": "reminder",
                    "title": f"Reminder: {title}" if title else "Reminder",
                    "body": r.get("note") or "You set a reminder for this task",
                    "item_id": r["item_id"],
                },
            )
            await client.patch(
                _sb_url("team_reminders"), headers=headers,
                params={"id": f"eq.{r['id']}"},
                json={"fired": True},
            )
            fired += 1
        return {"fired": fired}


# ══════════════════════════════════════════════════════════════
# Dependencies (Phase 2)
# ══════════════════════════════════════════════════════════════


@router.get("/items/{item_id}/dependencies")
async def get_dependencies(item_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Get deps where this item is source or target
        source_resp = await client.get(
            _sb_url("team_item_dependencies"), headers=headers,
            params={"source_id": f"eq.{item_id}"},
        )
        target_resp = await client.get(
            _sb_url("team_item_dependencies"), headers=headers,
            params={"target_id": f"eq.{item_id}"},
        )
        outgoing = source_resp.json() if source_resp.status_code < 400 else []
        incoming = target_resp.json() if target_resp.status_code < 400 else []

        # Enrich with item titles
        all_ids = set()
        for d in outgoing:
            all_ids.add(d["target_id"])
        for d in incoming:
            all_ids.add(d["source_id"])
        titles = {}
        if all_ids:
            items_resp = await client.get(
                _sb_url("team_items"), headers=headers,
                params={"id": f"in.({','.join(all_ids)})", "select": "id,title,status,custom_id"},
            )
            if items_resp.status_code < 400:
                for it in items_resp.json():
                    titles[it["id"]] = it

        for d in outgoing:
            d["target_item"] = titles.get(d["target_id"], {})
        for d in incoming:
            d["source_item"] = titles.get(d["source_id"], {})

        return {"outgoing": outgoing, "incoming": incoming}


class CreateDependency(BaseModel):
    target_id: str
    type: str = "blocks"


@router.post("/items/{item_id}/dependencies", status_code=201)
async def create_dependency(item_id: str, req: CreateDependency, user: AuthUser = Depends(get_current_user)):
    if req.type not in ("blocks", "blocked_by", "relates_to"):
        raise HTTPException(status_code=400, detail="type must be blocks, blocked_by, or relates_to")
    if item_id == req.target_id:
        raise HTTPException(status_code=400, detail="Cannot create self-dependency")

    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("team_item_dependencies"), headers=headers,
            json={
                "source_id": item_id,
                "target_id": req.target_id,
                "type": req.type,
                "created_by": user.id,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/dependencies/{dep_id}", status_code=204)
async def delete_dependency(dep_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            _sb_url("team_item_dependencies"), headers=headers,
            params={"id": f"eq.{dep_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)


@router.get("/items/{item_id}/blocking-check")
async def blocking_check(item_id: str, user: AuthUser = Depends(get_current_user)):
    """Check if this item is blocked by any unfinished items."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Items that block this one (where this item is the target and type is blocked_by,
        # OR this item is the target and type is blocks from source perspective)
        deps_resp = await client.get(
            _sb_url("team_item_dependencies"), headers=headers,
            params={"target_id": f"eq.{item_id}", "type": "eq.blocks"},
        )
        blocking_deps = deps_resp.json() if deps_resp.status_code < 400 else []
        if not blocking_deps:
            return {"blocked": False, "blockers": []}

        blocker_ids = [d["source_id"] for d in blocking_deps]
        items_resp = await client.get(
            _sb_url("team_items"), headers=headers,
            params={
                "id": f"in.({','.join(blocker_ids)})",
                "select": "id,title,status,custom_id",
                "status": "not.in.(done,closed)",
            },
        )
        blockers = items_resp.json() if items_resp.status_code < 400 else []
        return {"blocked": len(blockers) > 0, "blockers": blockers}


# ══════════════════════════════════════════════════════════════
# Time Tracking (Phase 2)
# ══════════════════════════════════════════════════════════════


@router.get("/items/{item_id}/time-entries")
async def get_time_entries(item_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_time_entries"), headers=headers,
            params={"item_id": f"eq.{item_id}", "order": "created_at.desc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


class CreateTimeEntry(BaseModel):
    duration: int  # minutes
    description: str = ""
    started_at: Optional[str] = None


@router.post("/items/{item_id}/time-entries", status_code=201)
async def create_time_entry(item_id: str, req: CreateTimeEntry, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        entry = {
            "item_id": item_id,
            "user_id": user.id,
            "duration": req.duration,
            "description": req.description,
        }
        if req.started_at:
            entry["started_at"] = req.started_at
        resp = await client.post(
            _sb_url("team_time_entries"), headers=headers,
            json=entry,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/time-entries/{entry_id}", status_code=204)
async def delete_time_entry(entry_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            _sb_url("team_time_entries"), headers=headers,
            params={"id": f"eq.{entry_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)


class UpdateTimeEstimate(BaseModel):
    time_estimate: int


@router.patch("/items/{item_id}/time-estimate")
async def update_time_estimate(item_id: str, req: UpdateTimeEstimate, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            _sb_url("team_items"), headers=headers,
            params={"id": f"eq.{item_id}"},
            json={"time_estimate": req.time_estimate},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]
