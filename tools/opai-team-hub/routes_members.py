"""OPAI Team Hub — Member Management routes (permissions, app sharing, space access)."""

from typing import Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import config
from auth import get_current_user, AuthUser

router = APIRouter(prefix="/api")


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


async def _check_membership(client: httpx.AsyncClient, headers: dict,
                            ws_id: str, user_id: str, require_admin: bool = False):
    """Return role or raise."""
    resp = await client.get(
        _sb_url("team_membership"), headers=headers,
        params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user_id}"},
    )
    if resp.status_code >= 400 or not resp.json():
        raise HTTPException(status_code=404, detail="Not a member of this workspace")
    role = resp.json()[0]["role"]
    if require_admin and role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Admin or owner role required")
    return role


# ── Pydantic models ──────────────────────────────────────────

class UpdatePermissions(BaseModel):
    can_manage_statuses: Optional[bool] = None
    can_manage_priorities: Optional[bool] = None
    can_manage_tags: Optional[bool] = None
    can_manage_members: Optional[bool] = None
    can_manage_fields: Optional[bool] = None
    can_manage_automations: Optional[bool] = None


class UpdateAppSharing(BaseModel):
    app_name: str
    enabled: bool
    access_level: str = "full"
    config: dict = {}


# ══════════════════════════════════════════════════════════════
# Detailed Members
# ══════════════════════════════════════════════════════════════


@router.get("/workspaces/{ws_id}/members/detailed")
async def get_detailed_members(ws_id: str, user: AuthUser = Depends(get_current_user)):
    """List members with their space access, permissions, and app sharing."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=15.0) as client:
        await _check_membership(client, headers, ws_id, user.id)

        # 1. Get all members of this workspace
        members_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={
                "workspace_id": f"eq.{ws_id}",
                "select": "user_id,role,created_at",
            },
        )
        if members_resp.status_code >= 400:
            raise HTTPException(status_code=members_resp.status_code, detail=members_resp.text)
        memberships = members_resp.json()

        if not memberships:
            return {"members": []}

        user_ids = [m["user_id"] for m in memberships]

        # 2. Get profile info for all members
        profiles: Dict[str, dict] = {}
        try:
            profiles_resp = await client.get(
                _sb_url("profiles"), headers=headers,
                params={
                    "id": f"in.({','.join(user_ids)})",
                    "select": "id,display_name,email,avatar_url",
                },
            )
            if profiles_resp.status_code < 400:
                profiles = {p["id"]: p for p in profiles_resp.json()}
        except Exception:
            pass

        # Fallback: get emails from auth.users for anyone missing from profiles
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
                                # Use email prefix as display name fallback
                                email = au.get("email", "")
                                profiles[uid]["display_name"] = email.split("@")[0] if email else ""
            except Exception:
                pass

        # 3. Get all workspaces (spaces) visible to the current user
        # This lets us show which spaces each member also belongs to
        spaces_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={
                "select": "id,name",
                "order": "name.asc",
            },
        )
        all_spaces = spaces_resp.json() if spaces_resp.status_code < 400 else []

        # 4. Get all workspace memberships for these users
        space_members_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={
                "user_id": f"in.({','.join(user_ids)})",
                "select": "user_id,workspace_id",
            },
        )
        space_memberships = space_members_resp.json() if space_members_resp.status_code < 400 else []
        # Build lookup: user_id -> set of workspace_ids
        user_spaces: Dict[str, set] = {}
        for sm in space_memberships:
            user_spaces.setdefault(sm["user_id"], set()).add(sm["workspace_id"])

        # 5. Get permissions for all members (table may not exist yet)
        user_perms: Dict[str, dict] = {}
        try:
            perms_resp = await client.get(
                _sb_url("team_member_permissions"), headers=headers,
                params={
                    "workspace_id": f"eq.{ws_id}",
                    "user_id": f"in.({','.join(user_ids)})",
                },
            )
            perms_list = perms_resp.json() if perms_resp.status_code < 400 else []
            for p in perms_list:
                user_perms[p["user_id"]] = {
                    "can_manage_statuses": p.get("can_manage_statuses", False),
                    "can_manage_priorities": p.get("can_manage_priorities", False),
                    "can_manage_tags": p.get("can_manage_tags", False),
                    "can_manage_members": p.get("can_manage_members", False),
                    "can_manage_fields": p.get("can_manage_fields", False),
                    "can_manage_automations": p.get("can_manage_automations", False),
                }
        except Exception:
            pass  # Table may not exist yet

        # 6. Get app sharing for all members (table may not exist yet)
        user_apps: Dict[str, dict] = {}
        try:
            sharing_resp = await client.get(
                _sb_url("team_app_sharing"), headers=headers,
                params={
                    "workspace_id": f"eq.{ws_id}",
                    "user_id": f"in.({','.join(user_ids)})",
                },
            )
            sharing_list = sharing_resp.json() if sharing_resp.status_code < 400 else []
            for s in sharing_list:
                user_apps.setdefault(s["user_id"], {})[s["app_name"]] = {
                    "access_level": s["access_level"],
                    "config": s.get("config", {}),
                }
        except Exception:
            pass  # Table may not exist yet

        # 7. Assemble result
        default_perms = {
            "can_manage_statuses": False,
            "can_manage_priorities": False,
            "can_manage_tags": False,
            "can_manage_members": False,
            "can_manage_fields": False,
            "can_manage_automations": False,
        }

        result = []
        for m in memberships:
            uid = m["user_id"]
            profile = profiles.get(uid, {})
            member_space_ids = user_spaces.get(uid, set())
            spaces_with_access = [
                {"id": sp["id"], "name": sp["name"], "has_access": sp["id"] in member_space_ids}
                for sp in all_spaces
            ]
            result.append({
                "user_id": uid,
                "display_name": profile.get("display_name", ""),
                "email": profile.get("email", ""),
                "avatar_url": profile.get("avatar_url", ""),
                "role": m["role"],
                "joined_at": m.get("created_at"),
                "spaces": spaces_with_access,
                "permissions": user_perms.get(uid, default_perms),
                "app_sharing": user_apps.get(uid, {}),
            })

        # Sort: owner first, then admin, then others
        role_order = {"owner": 0, "admin": 1, "member": 2, "viewer": 3}
        result.sort(key=lambda x: (role_order.get(x["role"], 9), x.get("display_name", "")))

        return {"members": result, "spaces": all_spaces}


# ══════════════════════════════════════════════════════════════
# Permissions
# ══════════════════════════════════════════════════════════════


@router.put("/workspaces/{ws_id}/members/{target_user_id}/permissions")
async def update_member_permissions(ws_id: str, target_user_id: str, body: UpdatePermissions,
                                    user: AuthUser = Depends(get_current_user)):
    """Update granular permissions for a member."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _check_membership(client, headers, ws_id, user.id, require_admin=True)
        await _check_membership(client, headers, ws_id, target_user_id)

        update = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
        if not update:
            return {"ok": True}

        # Upsert permissions
        upsert_headers = {**headers, "Prefer": "return=representation,resolution=merge-duplicates"}
        resp = await client.post(
            _sb_url("team_member_permissions"),
            headers=upsert_headers,
            params={"on_conflict": "workspace_id,user_id"},
            json={"workspace_id": ws_id, "user_id": target_user_id, **update},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0] if resp.json() else {"ok": True}


# ══════════════════════════════════════════════════════════════
# App Sharing
# ══════════════════════════════════════════════════════════════


@router.put("/workspaces/{ws_id}/members/{target_user_id}/app-sharing")
async def update_app_sharing(ws_id: str, target_user_id: str, body: UpdateAppSharing,
                             user: AuthUser = Depends(get_current_user)):
    """Add or remove app sharing for a member."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _check_membership(client, headers, ws_id, user.id, require_admin=True)
        await _check_membership(client, headers, ws_id, target_user_id)

        if body.enabled:
            # Upsert app sharing
            upsert_headers = {**headers, "Prefer": "return=representation,resolution=merge-duplicates"}
            resp = await client.post(
                _sb_url("team_app_sharing"),
                headers=upsert_headers,
                params={"on_conflict": "workspace_id,user_id,app_name"},
                json={
                    "workspace_id": ws_id,
                    "user_id": target_user_id,
                    "app_name": body.app_name,
                    "access_level": body.access_level,
                    "config": body.config,
                    "shared_by": user.id,
                },
            )
            if resp.status_code >= 400:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            return resp.json()[0] if resp.json() else {"ok": True}
        else:
            # Remove app sharing
            resp = await client.delete(
                _sb_url("team_app_sharing"),
                headers=headers,
                params={
                    "workspace_id": f"eq.{ws_id}",
                    "user_id": f"eq.{target_user_id}",
                    "app_name": f"eq.{body.app_name}",
                },
            )
            if resp.status_code >= 400:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            return {"ok": True, "removed": True}


# ══════════════════════════════════════════════════════════════
# Space (Workspace) Bulk Operations
# ══════════════════════════════════════════════════════════════


@router.post("/workspaces/{ws_id}/members/{target_user_id}/share-all-spaces")
async def share_all_spaces(ws_id: str, target_user_id: str,
                           user: AuthUser = Depends(get_current_user)):
    """Add member to all workspaces (spaces) the admin owns/manages."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=15.0) as client:
        await _check_membership(client, headers, ws_id, user.id, require_admin=True)

        # Get all workspaces the admin is a member of
        admin_ws_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "workspace_id"},
        )
        admin_workspaces = [r["workspace_id"] for r in (admin_ws_resp.json() if admin_ws_resp.status_code < 400 else [])]

        added = 0
        upsert_headers = {**headers, "Prefer": "return=representation,resolution=merge-duplicates"}
        for ws in admin_workspaces:
            resp = await client.post(
                _sb_url("team_membership"),
                headers=upsert_headers,
                params={"on_conflict": "workspace_id,user_id"},
                json={"workspace_id": ws, "user_id": target_user_id, "role": "member"},
            )
            if resp.status_code < 400:
                added += 1

        return {"added": added, "total_spaces": len(admin_workspaces)}


@router.post("/workspaces/{ws_id}/members/{target_user_id}/remove-all-spaces")
async def remove_all_spaces(ws_id: str, target_user_id: str,
                            user: AuthUser = Depends(get_current_user)):
    """Remove member from all workspaces (spaces) except the current one."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=15.0) as client:
        await _check_membership(client, headers, ws_id, user.id, require_admin=True)

        # Get all workspaces the target user is a member of
        target_ws_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={
                "user_id": f"eq.{target_user_id}",
                "workspace_id": f"neq.{ws_id}",
                "select": "workspace_id",
            },
        )
        target_workspaces = [r["workspace_id"] for r in (target_ws_resp.json() if target_ws_resp.status_code < 400 else [])]

        removed = 0
        for ws in target_workspaces:
            resp = await client.delete(
                _sb_url("team_membership"),
                headers=headers,
                params={"workspace_id": f"eq.{ws}", "user_id": f"eq.{target_user_id}"},
            )
            if resp.status_code < 400:
                removed += 1

        return {"removed": removed, "total_spaces": len(target_workspaces)}


@router.get("/workspaces/{ws_id}/members/{target_user_id}/spaces")
async def get_member_spaces(ws_id: str, target_user_id: str,
                            user: AuthUser = Depends(get_current_user)):
    """Get which workspaces (spaces) a member has access to."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _check_membership(client, headers, ws_id, user.id)

        # All workspaces
        spaces_resp = await client.get(
            _sb_url("team_workspaces"), headers=headers,
            params={"select": "id,name", "order": "name.asc"},
        )
        all_spaces = spaces_resp.json() if spaces_resp.status_code < 400 else []

        # Member's workspace memberships
        sm_resp = await client.get(
            _sb_url("team_membership"), headers=headers,
            params={"user_id": f"eq.{target_user_id}", "select": "workspace_id"},
        )
        member_ws_ids = {s["workspace_id"] for s in (sm_resp.json() if sm_resp.status_code < 400 else [])}

        return {
            "spaces": [
                {"id": sp["id"], "name": sp["name"], "has_access": sp["id"] in member_ws_ids}
                for sp in all_spaces
            ]
        }


# ══════════════════════════════════════════════════════════════
# Toggle Individual Space (Workspace) Access
# ══════════════════════════════════════════════════════════════


@router.put("/workspaces/{ws_id}/members/{target_user_id}/spaces/{space_id}")
async def toggle_space_access(ws_id: str, target_user_id: str, space_id: str,
                              user: AuthUser = Depends(get_current_user)):
    """Add member to a specific workspace (space)."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _check_membership(client, headers, ws_id, user.id, require_admin=True)
        upsert_headers = {**headers, "Prefer": "return=representation,resolution=merge-duplicates"}
        resp = await client.post(
            _sb_url("team_membership"),
            headers=upsert_headers,
            params={"on_conflict": "workspace_id,user_id"},
            json={"workspace_id": space_id, "user_id": target_user_id, "role": "member"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True, "added": True}


@router.delete("/workspaces/{ws_id}/members/{target_user_id}/spaces/{space_id}")
async def remove_space_access(ws_id: str, target_user_id: str, space_id: str,
                              user: AuthUser = Depends(get_current_user)):
    """Remove member from a specific workspace (space)."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _check_membership(client, headers, ws_id, user.id, require_admin=True)
        resp = await client.delete(
            _sb_url("team_membership"),
            headers=headers,
            params={"workspace_id": f"eq.{space_id}", "user_id": f"eq.{target_user_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True, "removed": True}
