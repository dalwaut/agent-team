"""OPAI Team Hub — Hub CRUD, member management, and settings routes."""

import re
import time
from typing import Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import config
from auth import get_current_user, AuthUser
from audit import log_audit

router = APIRouter(prefix="/api")

TIMEOUT = 10.0


# ── Supabase helpers ─────────────────────────────────────────

def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


def _slugify(name: str) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    return slug or 'hub'


# ── Auth helpers ─────────────────────────────────────────────

async def _require_hub_member(client: httpx.AsyncClient, hub_id: str, user_id: str) -> dict:
    """Verify user is a member of the hub. Returns the membership row."""
    resp = await client.get(
        _sb_url("team_hub_membership"), headers=_sb_headers(),
        params={"hub_id": f"eq.{hub_id}", "user_id": f"eq.{user_id}"},
    )
    rows = resp.json() if resp.status_code < 400 else []
    if not rows:
        raise HTTPException(status_code=404, detail="Not a member of this hub")
    return rows[0]


async def _require_hub_admin(client: httpx.AsyncClient, hub_id: str, user_id: str) -> dict:
    """Verify user is an admin of the hub. Returns the membership row."""
    membership = await _require_hub_member(client, hub_id, user_id)
    if membership["role"] != "admin":
        raise HTTPException(status_code=403, detail="Hub admin role required")
    return membership


async def _get_hub_permission(client: httpx.AsyncClient, hub_id: str, user_id: str) -> dict:
    """Fetch hub-level permissions for a user. Returns defaults if no row exists."""
    defaults = {
        "can_edit_titles": False,
        "can_change_status": False,
        "can_change_priority": False,
        "can_create_items": True,
        "can_comment": True,
        "can_assign": False,
        "can_create_statuses": False,
        "can_delete_statuses": False,
        "can_create_tags": False,
        "can_delete_tags": False,
        "can_delete_items": False,
        "can_manage_members": False,
        "can_create_spaces": False,
        "can_delete_spaces": False,
        "can_manage_automations": False,
        "can_manage_fields": False,
    }
    resp = await client.get(
        _sb_url("team_hub_permissions"), headers=_sb_headers(),
        params={"hub_id": f"eq.{hub_id}", "user_id": f"eq.{user_id}"},
    )
    rows = resp.json() if resp.status_code < 400 else []
    if rows:
        for key in defaults:
            if key in rows[0]:
                defaults[key] = rows[0][key]
    return defaults


async def _check_hub_permission(client: httpx.AsyncClient, hub_id: str,
                                user_id: str, permission: str) -> bool:
    """Check if user has a specific hub-level permission. Admins always pass."""
    mem_resp = await client.get(
        _sb_url("team_hub_membership"), headers=_sb_headers(),
        params={"hub_id": f"eq.{hub_id}", "user_id": f"eq.{user_id}"},
    )
    rows = mem_resp.json() if mem_resp.status_code < 400 else []
    if not rows:
        raise HTTPException(status_code=404, detail="Not a member of this hub")
    if rows[0]["role"] == "admin":
        return True
    perms = await _get_hub_permission(client, hub_id, user_id)
    return perms.get(permission, False)


# ── Pydantic models ──────────────────────────────────────────

class CreateHub(BaseModel):
    name: str
    slug: Optional[str] = None
    description: Optional[str] = ""
    icon: Optional[str] = ""
    color: Optional[str] = "#4f46e5"


class UpdateHub(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None


class InviteToHub(BaseModel):
    email: str
    role: str = "member"


class UpdateHubMember(BaseModel):
    role: Optional[str] = None
    can_edit_titles: Optional[bool] = None
    can_change_status: Optional[bool] = None
    can_change_priority: Optional[bool] = None
    can_create_items: Optional[bool] = None
    can_comment: Optional[bool] = None
    can_assign: Optional[bool] = None
    can_create_statuses: Optional[bool] = None
    can_delete_statuses: Optional[bool] = None
    can_create_tags: Optional[bool] = None
    can_delete_tags: Optional[bool] = None
    can_delete_items: Optional[bool] = None
    can_manage_members: Optional[bool] = None
    can_create_spaces: Optional[bool] = None
    can_delete_spaces: Optional[bool] = None
    can_manage_automations: Optional[bool] = None
    can_manage_fields: Optional[bool] = None


class CreateHubStatus(BaseModel):
    name: str
    color: str = "#595d66"
    type: str = "active"


class UpdateHubStatus(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    type: Optional[str] = None
    orderindex: Optional[int] = None


class CreateHubTag(BaseModel):
    name: str
    color: str = "#595d66"


class UpdateHubTag(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None


class CreateHubSpace(BaseModel):
    name: str
    icon: str = ""


# ══════════════════════════════════════════════════════════════
# Hub CRUD
# ══════════════════════════════════════════════════════════════


@router.get("/hubs")
async def list_hubs(user: AuthUser = Depends(get_current_user)):
    """List all hubs the current user is a member of."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # Get hub memberships for the user
        mem_resp = await client.get(
            _sb_url("team_hub_membership"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "hub_id,role"},
        )
        if mem_resp.status_code >= 400:
            raise HTTPException(status_code=mem_resp.status_code, detail=mem_resp.text)
        memberships = mem_resp.json()
        if not memberships:
            return {"hubs": []}

        hub_ids = [m["hub_id"] for m in memberships]
        role_map = {m["hub_id"]: m["role"] for m in memberships}

        # Fetch the hub records
        hubs_resp = await client.get(
            _sb_url("team_hubs"), headers=headers,
            params={
                "id": f"in.({','.join(hub_ids)})",
                "order": "name.asc",
            },
        )
        if hubs_resp.status_code >= 400:
            raise HTTPException(status_code=hubs_resp.status_code, detail=hubs_resp.text)
        hubs = hubs_resp.json()

        # Attach the user's role and space count per hub
        space_counts: Dict[str, int] = {}
        spaces_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={
                "hub_id": f"in.({','.join(hub_ids)})",
                "select": "hub_id",
            },
        )
        if spaces_resp.status_code < 400:
            for row in spaces_resp.json():
                hid = row.get("hub_id")
                if hid:
                    space_counts[hid] = space_counts.get(hid, 0) + 1

        for hub in hubs:
            hub["my_role"] = role_map.get(hub["id"], "member")
            hub["space_count"] = space_counts.get(hub["id"], 0)

        return {"hubs": hubs}


@router.post("/hubs")
async def create_hub(req: CreateHub, user: AuthUser = Depends(get_current_user)):
    """Create a new hub. The creator becomes admin."""
    headers = _sb_headers()
    slug = req.slug or _slugify(req.name)
    slug = f"{slug}-{int(time.time()) % 100000}"

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # Create the hub
        hub_resp = await client.post(
            _sb_url("team_hubs"), headers=headers,
            json={
                "name": req.name,
                "slug": slug,
                "description": req.description or "",
                "icon": req.icon or "",
                "color": req.color or "#4f46e5",
                "created_by": user.id,
            },
        )
        if hub_resp.status_code >= 400:
            raise HTTPException(status_code=hub_resp.status_code, detail=hub_resp.text)
        hub = hub_resp.json()[0]

        # Add creator as admin member
        await client.post(
            _sb_url("team_hub_membership"), headers=headers,
            json={
                "hub_id": hub["id"],
                "user_id": user.id,
                "role": "admin",
            },
        )

        # Create default permissions for creator (all true)
        all_perms = {
            "hub_id": hub["id"],
            "user_id": user.id,
            "can_edit_titles": True,
            "can_change_status": True,
            "can_change_priority": True,
            "can_create_items": True,
            "can_comment": True,
            "can_assign": True,
            "can_create_statuses": True,
            "can_delete_statuses": True,
            "can_create_tags": True,
            "can_delete_tags": True,
            "can_delete_items": True,
            "can_manage_members": True,
            "can_create_spaces": True,
            "can_delete_spaces": True,
            "can_manage_automations": True,
            "can_manage_fields": True,
        }
        await client.post(
            _sb_url("team_hub_permissions"), headers=headers,
            json=all_perms,
        )

        log_audit(
            tier="execution", service="opai-team-hub",
            event="hub_created", status="completed",
            summary=f"Hub '{req.name}' created by {user.email}",
        )

        hub["my_role"] = "admin"
        return hub


@router.get("/hubs/{hub_id}")
async def get_hub(hub_id: str, user: AuthUser = Depends(get_current_user)):
    """Get hub detail with spaces and member count."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        membership = await _require_hub_member(client, hub_id, user.id)

        # Fetch hub record
        hub_resp = await client.get(
            _sb_url("team_hubs"), headers=headers,
            params={"id": f"eq.{hub_id}"},
        )
        if hub_resp.status_code >= 400 or not hub_resp.json():
            raise HTTPException(status_code=404, detail="Hub not found")
        hub = hub_resp.json()[0]
        hub["my_role"] = membership["role"]

        # Fetch spaces belonging to this hub
        spaces_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={
                "hub_id": f"eq.{hub_id}",
                "select": "id,name,slug,icon,color,created_at",
                "order": "name.asc",
            },
        )
        hub["spaces"] = spaces_resp.json() if spaces_resp.status_code < 400 else []

        # Member count
        mem_resp = await client.get(
            _sb_url("team_hub_membership"), headers=headers,
            params={"hub_id": f"eq.{hub_id}", "select": "id"},
        )
        hub["member_count"] = len(mem_resp.json()) if mem_resp.status_code < 400 else 0

        # Fetch user's permissions
        hub["permissions"] = await _get_hub_permission(client, hub_id, user.id)

        return hub


@router.patch("/hubs/{hub_id}")
async def update_hub(hub_id: str, req: UpdateHub, user: AuthUser = Depends(get_current_user)):
    """Update hub details. Admin only."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        update = {k: v for k, v in req.model_dump(exclude_unset=True).items() if v is not None}
        if not update:
            raise HTTPException(status_code=400, detail="No fields to update")

        resp = await client.patch(
            _sb_url("team_hubs"), headers=headers,
            params={"id": f"eq.{hub_id}"},
            json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/hubs/{hub_id}")
async def delete_hub(hub_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete a hub. Admin only. Unbinds spaces (sets hub_id=NULL) but does not delete them."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Safety check: unbind all spaces first (set hub_id to NULL)
        await client.patch(
            _sb_url("team_workspaces"), headers=headers,
            params={"hub_id": f"eq.{hub_id}"},
            json={"hub_id": None},
        )

        # Delete hub-level statuses
        await client.delete(
            _sb_url("team_statuses"), headers=headers,
            params={"hub_id": f"eq.{hub_id}", "workspace_id": "is.null"},
        )

        # Delete hub-level tags
        await client.delete(
            _sb_url("team_tags"), headers=headers,
            params={"hub_id": f"eq.{hub_id}", "workspace_id": "is.null"},
        )

        # Delete permissions
        await client.delete(
            _sb_url("team_hub_permissions"), headers=headers,
            params={"hub_id": f"eq.{hub_id}"},
        )

        # Delete memberships
        await client.delete(
            _sb_url("team_hub_membership"), headers=headers,
            params={"hub_id": f"eq.{hub_id}"},
        )

        # Delete the hub itself
        resp = await client.delete(
            _sb_url("team_hubs"), headers=headers,
            params={"id": f"eq.{hub_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        log_audit(
            tier="execution", service="opai-team-hub",
            event="hub_deleted", status="completed",
            summary=f"Hub {hub_id} deleted by {user.email}",
        )

        return {"ok": True}


# ══════════════════════════════════════════════════════════════
# Hub Member Management
# ══════════════════════════════════════════════════════════════


@router.get("/hubs/{hub_id}/members")
async def list_hub_members(hub_id: str, user: AuthUser = Depends(get_current_user)):
    """List all hub members with profiles and permissions."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=15.0) as client:
        await _require_hub_member(client, hub_id, user.id)

        # Get all memberships
        mem_resp = await client.get(
            _sb_url("team_hub_membership"), headers=headers,
            params={
                "hub_id": f"eq.{hub_id}",
                "select": "id,user_id,role,created_at",
            },
        )
        if mem_resp.status_code >= 400:
            raise HTTPException(status_code=mem_resp.status_code, detail=mem_resp.text)
        memberships = mem_resp.json()
        if not memberships:
            return {"members": []}

        user_ids = [m["user_id"] for m in memberships]

        # Fetch profiles
        profiles: Dict[str, dict] = {}
        profiles_resp = await client.get(
            _sb_url("profiles"), headers=headers,
            params={
                "id": f"in.({','.join(user_ids)})",
                "select": "id,display_name,email,avatar_url",
            },
        )
        if profiles_resp.status_code < 400:
            profiles = {p["id"]: p for p in profiles_resp.json()}

        # Fallback: get emails from auth.users for anyone missing
        missing_ids = [uid for uid in user_ids if uid not in profiles or not profiles[uid].get("email")]
        if missing_ids:
            try:
                auth_resp = await client.get(
                    f"{config.SUPABASE_URL}/auth/v1/admin/users",
                    headers={
                        "apikey": config.SUPABASE_ANON_KEY,
                        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
                    },
                )
                if auth_resp.status_code < 400:
                    auth_data = auth_resp.json()
                    auth_users = auth_data.get("users", auth_data) if isinstance(auth_data, dict) else auth_data
                    for au in (auth_users if isinstance(auth_users, list) else []):
                        uid = au.get("id", "")
                        if uid in missing_ids:
                            if uid not in profiles:
                                profiles[uid] = {}
                            if not profiles[uid].get("email"):
                                profiles[uid]["email"] = au.get("email", "")
                            if not profiles[uid].get("display_name"):
                                email = au.get("email", "")
                                profiles[uid]["display_name"] = email.split("@")[0] if email else ""
            except Exception:
                pass

        # Fetch permissions for all members
        perms_map: Dict[str, dict] = {}
        perms_resp = await client.get(
            _sb_url("team_hub_permissions"), headers=headers,
            params={
                "hub_id": f"eq.{hub_id}",
                "user_id": f"in.({','.join(user_ids)})",
            },
        )
        if perms_resp.status_code < 400:
            for p in perms_resp.json():
                perms_map[p["user_id"]] = {
                    k: p.get(k, False) for k in [
                        "can_edit_titles", "can_change_status", "can_change_priority",
                        "can_create_items", "can_comment", "can_assign",
                        "can_create_statuses", "can_delete_statuses",
                        "can_create_tags", "can_delete_tags", "can_delete_items",
                        "can_manage_members", "can_create_spaces", "can_delete_spaces",
                        "can_manage_automations", "can_manage_fields",
                    ]
                }

        default_perms = {
            "can_edit_titles": False, "can_change_status": False,
            "can_change_priority": False, "can_create_items": True,
            "can_comment": True, "can_assign": False,
            "can_create_statuses": False, "can_delete_statuses": False,
            "can_create_tags": False, "can_delete_tags": False,
            "can_delete_items": False, "can_manage_members": False,
            "can_create_spaces": False, "can_delete_spaces": False,
            "can_manage_automations": False, "can_manage_fields": False,
        }

        result = []
        for m in memberships:
            uid = m["user_id"]
            profile = profiles.get(uid, {})
            result.append({
                "membership_id": m["id"],
                "user_id": uid,
                "display_name": profile.get("display_name", ""),
                "email": profile.get("email", ""),
                "avatar_url": profile.get("avatar_url", ""),
                "role": m["role"],
                "joined_at": m.get("created_at"),
                "permissions": perms_map.get(uid, default_perms),
            })

        # Sort: admin first, then members
        role_order = {"admin": 0, "member": 1}
        result.sort(key=lambda x: (role_order.get(x["role"], 9), x.get("display_name", "")))

        return {"members": result}


@router.post("/hubs/{hub_id}/invite")
async def invite_to_hub(hub_id: str, req: InviteToHub, user: AuthUser = Depends(get_current_user)):
    """Invite a user to the hub by email. Admin only."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Look up user by email in profiles
        profile_resp = await client.get(
            _sb_url("profiles"), headers=headers,
            params={"email": f"eq.{req.email}", "select": "id,email,display_name"},
        )
        profiles = profile_resp.json() if profile_resp.status_code < 400 else []

        if not profiles:
            # Fallback: check auth.users
            auth_resp = await client.get(
                f"{config.SUPABASE_URL}/auth/v1/admin/users",
                headers={
                    "apikey": config.SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
                },
            )
            if auth_resp.status_code < 400:
                auth_data = auth_resp.json()
                auth_users = auth_data.get("users", auth_data) if isinstance(auth_data, dict) else auth_data
                found = None
                for au in (auth_users if isinstance(auth_users, list) else []):
                    if au.get("email", "").lower() == req.email.lower():
                        found = au
                        break
                if not found:
                    raise HTTPException(status_code=404, detail=f"No user found with email: {req.email}")
                target_user_id = found["id"]
            else:
                raise HTTPException(status_code=404, detail=f"No user found with email: {req.email}")
        else:
            target_user_id = profiles[0]["id"]

        # Check if already a member
        existing = await client.get(
            _sb_url("team_hub_membership"), headers=headers,
            params={"hub_id": f"eq.{hub_id}", "user_id": f"eq.{target_user_id}"},
        )
        if existing.status_code < 400 and existing.json():
            raise HTTPException(status_code=409, detail="User is already a member of this hub")

        # Validate role
        role = req.role if req.role in ("admin", "member") else "member"

        # Add to hub membership
        mem_resp = await client.post(
            _sb_url("team_hub_membership"), headers=headers,
            json={
                "hub_id": hub_id,
                "user_id": target_user_id,
                "role": role,
            },
        )
        if mem_resp.status_code >= 400:
            raise HTTPException(status_code=mem_resp.status_code, detail=mem_resp.text)

        # Create default permissions
        default_perms = {
            "hub_id": hub_id,
            "user_id": target_user_id,
            "can_edit_titles": role == "admin",
            "can_change_status": True,
            "can_change_priority": True,
            "can_create_items": True,
            "can_comment": True,
            "can_assign": role == "admin",
            "can_create_statuses": role == "admin",
            "can_delete_statuses": role == "admin",
            "can_create_tags": True,
            "can_delete_tags": role == "admin",
            "can_delete_items": role == "admin",
            "can_manage_members": role == "admin",
            "can_create_spaces": role == "admin",
            "can_delete_spaces": role == "admin",
            "can_manage_automations": role == "admin",
            "can_manage_fields": role == "admin",
        }
        await client.post(
            _sb_url("team_hub_permissions"), headers=headers,
            json=default_perms,
        )

        # Also add the user to all existing hub spaces
        spaces_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"hub_id": f"eq.{hub_id}", "select": "id"},
        )
        if spaces_resp.status_code < 400:
            upsert_headers = {**headers, "Prefer": "return=representation,resolution=merge-duplicates"}
            for space in spaces_resp.json():
                await client.post(
                    _sb_url("team_membership"),
                    headers=upsert_headers,
                    params={"on_conflict": "workspace_id,user_id"},
                    json={
                        "workspace_id": space["id"],
                        "user_id": target_user_id,
                        "role": "member",
                    },
                )

        return {
            "ok": True,
            "user_id": target_user_id,
            "hub_id": hub_id,
            "role": role,
        }


@router.patch("/hubs/{hub_id}/members/{target_user_id}")
async def update_hub_member(hub_id: str, target_user_id: str, req: UpdateHubMember,
                            user: AuthUser = Depends(get_current_user)):
    """Change a member's role or permissions. Admin only."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Verify target is a member
        await _require_hub_member(client, hub_id, target_user_id)

        result = {}

        # Update role if provided
        if req.role is not None:
            if req.role not in ("admin", "member"):
                raise HTTPException(status_code=400, detail="Role must be 'admin' or 'member'")
            resp = await client.patch(
                _sb_url("team_hub_membership"), headers=headers,
                params={"hub_id": f"eq.{hub_id}", "user_id": f"eq.{target_user_id}"},
                json={"role": req.role},
            )
            if resp.status_code >= 400:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            result["role"] = req.role

        # Update permissions if any permission fields provided
        perm_fields = [
            "can_edit_titles", "can_change_status", "can_change_priority",
            "can_create_items", "can_comment", "can_assign",
            "can_create_statuses", "can_delete_statuses",
            "can_create_tags", "can_delete_tags", "can_delete_items",
            "can_manage_members", "can_create_spaces", "can_delete_spaces",
            "can_manage_automations", "can_manage_fields",
        ]
        perm_update = {}
        for field in perm_fields:
            val = getattr(req, field, None)
            if val is not None:
                perm_update[field] = val

        if perm_update:
            upsert_headers = {**headers, "Prefer": "return=representation,resolution=merge-duplicates"}
            resp = await client.post(
                _sb_url("team_hub_permissions"),
                headers=upsert_headers,
                params={"on_conflict": "hub_id,user_id"},
                json={"hub_id": hub_id, "user_id": target_user_id, **perm_update},
            )
            if resp.status_code >= 400:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            result["permissions"] = resp.json()[0] if resp.json() else perm_update

        return {"ok": True, **result}


@router.delete("/hubs/{hub_id}/members/{target_user_id}")
async def remove_hub_member(hub_id: str, target_user_id: str,
                            user: AuthUser = Depends(get_current_user)):
    """Remove a member from the hub. Admin only. Cannot remove self if last admin."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Prevent removing the last admin
        if target_user_id == user.id:
            admins_resp = await client.get(
                _sb_url("team_hub_membership"), headers=headers,
                params={"hub_id": f"eq.{hub_id}", "role": "eq.admin", "select": "id"},
            )
            admin_count = len(admins_resp.json()) if admins_resp.status_code < 400 else 0
            if admin_count <= 1:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot remove the last admin. Transfer admin role first.",
                )

        # Remove from hub spaces
        spaces_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"hub_id": f"eq.{hub_id}", "select": "id"},
        )
        if spaces_resp.status_code < 400:
            for space in spaces_resp.json():
                await client.delete(
                    _sb_url("team_membership"), headers=headers,
                    params={
                        "workspace_id": f"eq.{space['id']}",
                        "user_id": f"eq.{target_user_id}",
                    },
                )

        # Remove permissions
        await client.delete(
            _sb_url("team_hub_permissions"), headers=headers,
            params={"hub_id": f"eq.{hub_id}", "user_id": f"eq.{target_user_id}"},
        )

        # Remove membership
        resp = await client.delete(
            _sb_url("team_hub_membership"), headers=headers,
            params={"hub_id": f"eq.{hub_id}", "user_id": f"eq.{target_user_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        return {"ok": True}


# ══════════════════════════════════════════════════════════════
# Hub Settings — Statuses
# ══════════════════════════════════════════════════════════════


@router.get("/hubs/{hub_id}/statuses")
async def list_hub_statuses(hub_id: str, user: AuthUser = Depends(get_current_user)):
    """Get hub-level statuses (workspace_id IS NULL, hub_id matches)."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_member(client, hub_id, user.id)
        resp = await client.get(
            _sb_url("team_statuses"), headers=headers,
            params={
                "hub_id": f"eq.{hub_id}",
                "workspace_id": "is.null",
                "order": "orderindex.asc",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"statuses": resp.json()}


@router.post("/hubs/{hub_id}/statuses")
async def create_hub_status(hub_id: str, req: CreateHubStatus,
                            user: AuthUser = Depends(get_current_user)):
    """Create a hub-level status. Admin only."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Get max orderindex for hub statuses
        existing = await client.get(
            _sb_url("team_statuses"), headers=headers,
            params={
                "hub_id": f"eq.{hub_id}",
                "workspace_id": "is.null",
                "order": "orderindex.desc",
                "limit": "1",
            },
        )
        rows = existing.json() if existing.status_code < 400 else []
        max_order = rows[0]["orderindex"] + 1 if rows else 0

        resp = await client.post(
            _sb_url("team_statuses"), headers=headers,
            json={
                "hub_id": hub_id,
                "name": req.name,
                "color": req.color,
                "type": req.type,
                "orderindex": max_order,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.patch("/hubs/{hub_id}/statuses/{status_id}")
async def update_hub_status(hub_id: str, status_id: str, req: UpdateHubStatus,
                            user: AuthUser = Depends(get_current_user)):
    """Edit a hub-level status. Admin only."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Verify the status belongs to this hub
        st = await client.get(
            _sb_url("team_statuses"), headers=headers,
            params={"id": f"eq.{status_id}", "hub_id": f"eq.{hub_id}"},
        )
        if st.status_code >= 400 or not st.json():
            raise HTTPException(status_code=404, detail="Hub status not found")

        update = {k: v for k, v in req.model_dump(exclude_unset=True).items() if v is not None}
        if not update:
            return st.json()[0]

        resp = await client.patch(
            _sb_url("team_statuses"), headers=headers,
            params={"id": f"eq.{status_id}"},
            json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/hubs/{hub_id}/statuses/{status_id}")
async def delete_hub_status(hub_id: str, status_id: str,
                            user: AuthUser = Depends(get_current_user)):
    """Delete a hub-level status. Admin only."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Verify the status belongs to this hub
        st = await client.get(
            _sb_url("team_statuses"), headers=headers,
            params={"id": f"eq.{status_id}", "hub_id": f"eq.{hub_id}"},
        )
        if st.status_code >= 400 or not st.json():
            raise HTTPException(status_code=404, detail="Hub status not found")

        await client.delete(
            _sb_url("team_statuses"), headers=headers,
            params={"id": f"eq.{status_id}"},
        )
        return {"ok": True}


# ══════════════════════════════════════════════════════════════
# Hub Settings — Tags
# ══════════════════════════════════════════════════════════════


@router.get("/hubs/{hub_id}/tags")
async def list_hub_tags(hub_id: str, user: AuthUser = Depends(get_current_user)):
    """Get hub-level tags."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_member(client, hub_id, user.id)
        resp = await client.get(
            _sb_url("team_tags"), headers=headers,
            params={
                "hub_id": f"eq.{hub_id}",
                "workspace_id": "is.null",
                "order": "name.asc",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"tags": resp.json()}


@router.post("/hubs/{hub_id}/tags")
async def create_hub_tag(hub_id: str, req: CreateHubTag,
                         user: AuthUser = Depends(get_current_user)):
    """Create a hub-level tag. Admin only."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        resp = await client.post(
            _sb_url("team_tags"), headers=headers,
            json={
                "hub_id": hub_id,
                "name": req.name,
                "color": req.color,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.patch("/hubs/{hub_id}/tags/{tag_id}")
async def update_hub_tag(hub_id: str, tag_id: str, req: UpdateHubTag,
                         user: AuthUser = Depends(get_current_user)):
    """Edit a hub-level tag. Admin only."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Verify tag belongs to this hub
        tag = await client.get(
            _sb_url("team_tags"), headers=headers,
            params={"id": f"eq.{tag_id}", "hub_id": f"eq.{hub_id}"},
        )
        if tag.status_code >= 400 or not tag.json():
            raise HTTPException(status_code=404, detail="Hub tag not found")

        update = {k: v for k, v in req.model_dump(exclude_unset=True).items() if v is not None}
        if not update:
            return tag.json()[0]

        resp = await client.patch(
            _sb_url("team_tags"), headers=headers,
            params={"id": f"eq.{tag_id}"},
            json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/hubs/{hub_id}/tags/{tag_id}")
async def delete_hub_tag(hub_id: str, tag_id: str,
                         user: AuthUser = Depends(get_current_user)):
    """Delete a hub-level tag. Admin only."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Verify tag belongs to this hub
        tag = await client.get(
            _sb_url("team_tags"), headers=headers,
            params={"id": f"eq.{tag_id}", "hub_id": f"eq.{hub_id}"},
        )
        if tag.status_code >= 400 or not tag.json():
            raise HTTPException(status_code=404, detail="Hub tag not found")

        await client.delete(
            _sb_url("team_tags"), headers=headers,
            params={"id": f"eq.{tag_id}"},
        )
        return {"ok": True}


# ══════════════════════════════════════════════════════════════
# Hub Space Management
# ══════════════════════════════════════════════════════════════


@router.post("/hubs/{hub_id}/spaces")
async def create_hub_space(hub_id: str, req: CreateHubSpace,
                           user: AuthUser = Depends(get_current_user)):
    """Create a new space within a hub. Requires admin or can_create_spaces permission.
    Auto-adds all hub members to the new space."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=15.0) as client:
        has_perm = await _check_hub_permission(client, hub_id, user.id, "can_create_spaces")
        if not has_perm:
            raise HTTPException(status_code=403, detail="No permission to create spaces in this hub")

        # Create the workspace with hub_id
        slug = _slugify(req.name)
        slug = f"{slug}-{int(time.time()) % 100000}"

        ws_resp = await client.post(
            _sb_url("team_workspaces"), headers=headers,
            json={
                "name": req.name,
                "slug": slug,
                "icon": req.icon or "",
                "owner_id": user.id,
                "hub_id": hub_id,
                "is_personal": False,
            },
        )
        if ws_resp.status_code >= 400:
            raise HTTPException(status_code=ws_resp.status_code, detail=ws_resp.text)
        workspace = ws_resp.json()[0]

        # Auto-add all hub members to this space
        mem_resp = await client.get(
            _sb_url("team_hub_membership"), headers=headers,
            params={"hub_id": f"eq.{hub_id}", "select": "user_id,role"},
        )
        hub_members = mem_resp.json() if mem_resp.status_code < 400 else []

        upsert_headers = {**headers, "Prefer": "return=representation,resolution=merge-duplicates"}
        for member in hub_members:
            ws_role = "owner" if member["user_id"] == user.id else "member"
            await client.post(
                _sb_url("team_membership"),
                headers=upsert_headers,
                params={"on_conflict": "workspace_id,user_id"},
                json={
                    "workspace_id": workspace["id"],
                    "user_id": member["user_id"],
                    "role": ws_role,
                },
            )

        return workspace


@router.delete("/hubs/{hub_id}/spaces/{ws_id}")
async def unbind_hub_space(hub_id: str, ws_id: str,
                           user: AuthUser = Depends(get_current_user)):
    """Unbind a space from a hub (sets hub_id=NULL). Admin only. Does not delete the space."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _require_hub_admin(client, hub_id, user.id)

        # Verify the space belongs to this hub
        ws_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"id": f"eq.{ws_id}", "hub_id": f"eq.{hub_id}"},
        )
        if ws_resp.status_code >= 400 or not ws_resp.json():
            raise HTTPException(status_code=404, detail="Space not found in this hub")

        resp = await client.patch(
            _sb_url("team_workspaces"), headers=headers,
            params={"id": f"eq.{ws_id}"},
            json={"hub_id": None},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        return {"ok": True, "unbound": True}
