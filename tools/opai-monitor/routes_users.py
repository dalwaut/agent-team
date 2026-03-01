"""OPAI Monitor — User Management & Network Lockdown API."""

import asyncio
import json
import os
import subprocess
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from typing import Optional

import shutil
from auth import require_admin, get_current_user, AuthUser, clear_profile_cache
import config

router = APIRouter(prefix="/api")

# ── Supabase Admin Client ────────────────────────────────

SUPABASE_URL = config.SUPABASE_URL
SUPABASE_SERVICE_KEY = config.SUPABASE_SERVICE_KEY

_supa_headers = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}


def _supa_rest_headers(*, prefer: str = "return=representation"):
    """Headers for Supabase PostgREST calls."""
    return {**_supa_headers, "Prefer": prefer}


# ── Request Models ───────────────────────────────────────

class InviteRequest(BaseModel):
    email: str
    display_name: str = ""
    role: str = "user"
    preface_prompt: str = ""
    allowed_apps: list[str] = []
    tailscale_invite: str = ""
    custom_message: str = ""
    marketplace_tier: str = "free"
    provision_n8n: bool = False


class UpdateUserRequest(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None
    preface_prompt: Optional[str] = None
    allowed_apps: Optional[list[str]] = None
    allowed_agents: Optional[list[str]] = None
    sandbox_path: Optional[str] = None
    display_name: Optional[str] = None
    marketplace_tier: Optional[str] = None
    ai_locked: Optional[bool] = None


class SettingUpdate(BaseModel):
    value: dict


class NetworkAction(BaseModel):
    pin: str


# ── Users ────────────────────────────────────────────────

@router.get("/users", dependencies=[Depends(require_admin)])
async def list_users():
    """List all user profiles."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/profiles?select=*&order=created_at.desc",
            headers=_supa_rest_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(502, f"Supabase error: {resp.text}")
        return {"users": resp.json()}


@router.get("/users/{user_id}", dependencies=[Depends(require_admin)])
async def get_user(user_id: str):
    """Get a single user profile."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*",
            headers=_supa_rest_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(502, f"Supabase error: {resp.text}")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, "User not found")
        return rows[0]


@router.post("/users/invite", dependencies=[Depends(require_admin)])
async def invite_user(req: InviteRequest, admin: AuthUser = Depends(require_admin)):
    """Invite a new user via Supabase email invite."""
    if not SUPABASE_SERVICE_KEY:
        raise HTTPException(500, "SUPABASE_SERVICE_KEY not configured")

    async with httpx.AsyncClient(timeout=15) as client:
        # Send Supabase invite (uses service role key)
        resp = await client.post(
            f"{SUPABASE_URL}/auth/v1/invite",
            headers=_supa_headers,
            json={
                "email": req.email,
                "data": {
                    "display_name": req.display_name or req.email.split("@")[0],
                    "role": req.role,
                    "invited_by": admin.id,
                    "tailscale_invite": req.tailscale_invite,
                    "custom_message": req.custom_message,
                },
            },
        )

        if resp.status_code not in (200, 201):
            detail = resp.json().get("msg", resp.text) if resp.headers.get("content-type", "").startswith("application/json") else resp.text
            raise HTTPException(502, f"Supabase invite failed: {detail}")

        invite_data = resp.json()
        new_user_id = invite_data.get("id")

        # Update profile with preface prompt, allowed apps, and marketplace tier
        if new_user_id and (req.preface_prompt or req.allowed_apps or req.marketplace_tier != "free"):
            update = {}
            if req.preface_prompt:
                update["preface_prompt"] = req.preface_prompt
            if req.allowed_apps:
                update["allowed_apps"] = req.allowed_apps
            if req.marketplace_tier != "free":
                update["marketplace_tier"] = req.marketplace_tier

            await client.patch(
                f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{new_user_id}",
                headers=_supa_rest_headers(),
                json=update,
            )

    result = {"success": True, "user_id": new_user_id, "email": req.email}

    # Optionally provision n8n account
    if new_user_id and req.provision_n8n:
        try:
            n8n_resp = await httpx.AsyncClient(timeout=15).post(
                "http://127.0.0.1:8092/api/n8n/provision",
                headers={
                    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                    "Content-Type": "application/json",
                },
                json={"user_id": new_user_id},
            )
            if n8n_resp.status_code < 400:
                result["n8n"] = n8n_resp.json()
        except Exception:
            result["n8n_error"] = "n8n provisioning failed (marketplace service may be down)"

    return result


@router.put("/users/{user_id}", dependencies=[Depends(require_admin)])
async def update_user(user_id: str, req: UpdateUserRequest):
    """Update user profile fields."""
    update = {}
    if req.role is not None:
        update["role"] = req.role
    if req.is_active is not None:
        update["is_active"] = req.is_active
    if req.preface_prompt is not None:
        update["preface_prompt"] = req.preface_prompt
    if req.allowed_apps is not None:
        update["allowed_apps"] = req.allowed_apps
    if req.allowed_agents is not None:
        update["allowed_agents"] = req.allowed_agents
    if req.sandbox_path is not None:
        update["sandbox_path"] = req.sandbox_path
    if req.display_name is not None:
        update["display_name"] = req.display_name
    if req.marketplace_tier is not None:
        update["marketplace_tier"] = req.marketplace_tier
    if req.ai_locked is not None:
        update["ai_locked"] = req.ai_locked
        if not req.ai_locked:
            update["ai_locked_at"] = None
            update["ai_locked_reason"] = None

    if not update:
        raise HTTPException(400, "No fields to update")

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
            headers=_supa_rest_headers(),
            json=update,
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(502, f"Supabase update failed: {resp.text}")
        rows = resp.json() if resp.status_code == 200 else []

    return {"success": True, "user": rows[0] if rows else None}


@router.delete("/users/{user_id}", dependencies=[Depends(require_admin)])
async def deactivate_user(user_id: str):
    """Deactivate a user (set is_active=false)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
            headers=_supa_rest_headers(),
            json={"is_active": False},
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(502, f"Supabase error: {resp.text}")

    return {"success": True, "user_id": user_id}


# ── Unlock AI ─────────────────────────────────────────────

@router.post("/users/{user_id}/unlock-ai", dependencies=[Depends(require_admin)])
async def unlock_user_ai(user_id: str):
    """Remove AI lock from a user."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
            headers=_supa_rest_headers(),
            json={
                "ai_locked": False,
                "ai_locked_at": None,
                "ai_locked_reason": None,
            },
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(502, f"Supabase error: {resp.text}")

    clear_profile_cache(user_id)
    return {"success": True, "user_id": user_id}


# ── Hard Delete ───────────────────────────────────────────

@router.delete("/users/{user_id}/hard-delete", dependencies=[Depends(require_admin)])
async def hard_delete_user(user_id: str, admin: AuthUser = Depends(require_admin)):
    """Permanently delete a user: profile, auth, sandbox, n8n unlink."""
    # Prevent admin self-deletion
    if user_id == admin.id:
        raise HTTPException(400, "Cannot delete your own admin account")

    async with httpx.AsyncClient(timeout=15) as client:
        # 1. Fetch profile for cleanup info
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*",
            headers=_supa_rest_headers(),
        )
        if resp.status_code != 200 or not resp.json():
            raise HTTPException(404, "User not found")
        profile = resp.json()[0]

        # 2. Unlink n8n if provisioned
        if profile.get("n8n_provisioned"):
            try:
                await client.post(
                    "http://127.0.0.1:8092/api/n8n/link",
                    headers={**_supa_headers, "Content-Type": "application/json"},
                    json={"user_id": user_id, "n8n_email": ""},
                )
            except Exception:
                pass  # Best effort

        # 3. Clear BB fields if linked
        if profile.get("bb_user_id"):
            try:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
                    headers=_supa_rest_headers(prefer="return=minimal"),
                    json={"bb_user_id": None, "bb_email": None, "bb_tier": None},
                )
            except Exception:
                pass

        # 4. Remove sandbox directory
        sandbox_path = profile.get("sandbox_path", "")
        if sandbox_path and os.path.isdir(sandbox_path):
            try:
                shutil.rmtree(sandbox_path)
            except Exception as e:
                print(f"[WARN] Failed to remove sandbox {sandbox_path}: {e}")

        # 5. Delete profile row
        resp = await client.delete(
            f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
            headers=_supa_rest_headers(prefer="return=minimal"),
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(502, f"Profile delete failed: {resp.text}")

        # 6. Delete auth user
        resp = await client.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=_supa_headers,
        )
        if resp.status_code not in (200, 204):
            print(f"[WARN] Auth user delete returned {resp.status_code}: {resp.text}")

    clear_profile_cache(user_id)
    return {"success": True, "user_id": user_id, "message": "User permanently deleted"}


# ── Sandbox Provisioning ──────────────────────────────────

class ProfileSetupRequest(BaseModel):
    expertise_level: Optional[str] = None
    primary_use_case: Optional[str] = None
    tools: Optional[list[str]] = None
    focus_areas: Optional[list[str]] = None
    onboarding_completed: Optional[bool] = None


@router.post("/users/{user_id}/provision-sandbox")
async def provision_sandbox(user_id: str, user: AuthUser = Depends(get_current_user)):
    """Trigger sandbox provisioning for a user.

    Can be called by admin or by the user themselves during onboarding.
    Runs provision-sandbox.sh in the background.
    """
    # Self-service: user can only provision their own sandbox
    if not user.is_admin and user.id != user_id:
        raise HTTPException(403, "Can only provision your own sandbox")

    # Get user profile to extract name, email, role
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*",
            headers=_supa_rest_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(502, f"Supabase error: {resp.text}")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, "User not found")

    profile = rows[0]
    display_name = profile.get("display_name", profile.get("email", "").split("@")[0])
    email = profile.get("email", "")
    role = profile.get("role", "user")

    # Check if already provisioned
    if profile.get("sandbox_provisioned"):
        sandbox_path = profile.get("sandbox_path", "")
        return {"status": "already_provisioned", "sandbox_path": sandbox_path}

    # Build profile JSON from saved profile data
    profile_json = json.dumps({
        "expertise_level": profile.get("expertise_level", "beginner"),
        "primary_use_case": profile.get("primary_use_case", "general"),
        "tools": profile.get("notification_preferences", {}).get("tools", []),
        "focus_areas": profile.get("notification_preferences", {}).get("focus_areas", []),
    })

    # Run provision script in background
    script_path = str(config.OPAI_ROOT / "scripts" / "provision-sandbox.sh")
    try:
        proc = subprocess.Popen(
            [
                script_path,
                "--user-id", user_id,
                "--name", display_name,
                "--email", email,
                "--role", role,
                "--profile-json", profile_json,
            ],
            cwd=str(config.OPAI_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env={
                **os.environ,
                "SUPABASE_URL": SUPABASE_URL,
                "SUPABASE_SERVICE_KEY": SUPABASE_SERVICE_KEY,
            },
        )
    except Exception as e:
        raise HTTPException(500, f"Failed to start provisioning: {e}")

    # Build expected sandbox path (capitalized display name, matching provision script)
    sandbox_path = f"/workspace/users/{display_name.title()}"

    return {
        "status": "provisioning",
        "sandbox_path": sandbox_path,
        "pid": proc.pid,
    }


@router.get("/users/{user_id}/sandbox-status")
async def sandbox_status(user_id: str, user: AuthUser = Depends(get_current_user)):
    """Check sandbox provisioning status for a user."""
    if not user.is_admin and user.id != user_id:
        raise HTTPException(403, "Can only check your own sandbox status")

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=sandbox_provisioned,sandbox_path,sandbox_provisioned_at",
            headers=_supa_rest_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(502, f"Supabase error: {resp.text}")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, "User not found")

    profile = rows[0]
    return {
        "provisioned": profile.get("sandbox_provisioned", False),
        "sandbox_path": profile.get("sandbox_path"),
        "provisioned_at": profile.get("sandbox_provisioned_at"),
    }


@router.put("/users/{user_id}/profile-setup")
async def profile_setup(user_id: str, req: ProfileSetupRequest, user: AuthUser = Depends(get_current_user)):
    """Save onboarding profile answers (expertise, use case, completion flag)."""
    if not user.is_admin and user.id != user_id:
        raise HTTPException(403, "Can only update your own profile")

    update = {}
    if req.expertise_level is not None:
        update["expertise_level"] = req.expertise_level
    if req.primary_use_case is not None:
        update["primary_use_case"] = req.primary_use_case
    if req.onboarding_completed is not None:
        update["onboarding_completed"] = req.onboarding_completed
        if req.onboarding_completed:
            update["onboarding_completed_at"] = datetime.utcnow().isoformat()

    # Store tools and focus_areas in notification_preferences JSON column
    extras = {}
    if req.tools is not None:
        extras["tools"] = req.tools
    if req.focus_areas is not None:
        extras["focus_areas"] = req.focus_areas
    if extras:
        # Merge with existing notification_preferences
        async with httpx.AsyncClient(timeout=10) as client:
            existing_resp = await client.get(
                f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=notification_preferences",
                headers=_supa_rest_headers(),
            )
            existing_prefs = {}
            if existing_resp.status_code == 200:
                rows = existing_resp.json()
                if rows and rows[0].get("notification_preferences"):
                    existing_prefs = rows[0]["notification_preferences"]
            existing_prefs.update(extras)
            update["notification_preferences"] = existing_prefs

    if not update:
        raise HTTPException(400, "No fields to update")

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
            headers=_supa_rest_headers(),
            json=update,
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(502, f"Supabase update failed: {resp.text}")

    return {"success": True}


@router.post("/users/drop-all", dependencies=[Depends(require_admin)])
async def drop_all_users():
    """Deactivate all non-admin users and set system kill switch."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Set all non-admin users to inactive
        resp = await client.patch(
            f"{SUPABASE_URL}/rest/v1/profiles?role=neq.admin",
            headers=_supa_rest_headers(prefer="return=minimal"),
            json={"is_active": False},
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(502, f"Supabase error: {resp.text}")

        # Update system setting
        await client.patch(
            f"{SUPABASE_URL}/rest/v1/system_settings?key=eq.users_enabled",
            headers=_supa_rest_headers(prefer="return=minimal"),
            json={"value": {"enabled": False}, "updated_at": datetime.utcnow().isoformat()},
        )

    return {"success": True, "message": "All non-admin users deactivated"}


@router.post("/users/restore-all", dependencies=[Depends(require_admin)])
async def restore_all_users():
    """Re-enable all users and clear kill switch."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{SUPABASE_URL}/rest/v1/profiles?role=neq.admin",
            headers=_supa_rest_headers(prefer="return=minimal"),
            json={"is_active": True},
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(502, f"Supabase error: {resp.text}")

        await client.patch(
            f"{SUPABASE_URL}/rest/v1/system_settings?key=eq.users_enabled",
            headers=_supa_rest_headers(prefer="return=minimal"),
            json={"value": {"enabled": True}, "updated_at": datetime.utcnow().isoformat()},
        )

    return {"success": True, "message": "All users re-enabled"}


# ── System Settings ──────────────────────────────────────

@router.get("/system/settings/{key}", dependencies=[Depends(require_admin)])
async def get_setting(key: str):
    """Get a system setting by key."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/system_settings?key=eq.{key}&select=*",
            headers=_supa_rest_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(502, f"Supabase error: {resp.text}")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, f"Setting '{key}' not found")
        return rows[0]


@router.put("/system/settings/{key}", dependencies=[Depends(require_admin)])
async def update_setting(key: str, req: SettingUpdate, admin: AuthUser = Depends(require_admin)):
    """Update a system setting."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{SUPABASE_URL}/rest/v1/system_settings?key=eq.{key}",
            headers=_supa_rest_headers(),
            json={
                "value": req.value,
                "updated_at": datetime.utcnow().isoformat(),
                "updated_by": admin.id,
            },
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(502, f"Supabase error: {resp.text}")

    return {"success": True}


# ── Network Lockdown ─────────────────────────────────────

def _verify_lockdown_pin(pin: str) -> bool:
    """Verify lockdown PIN against configured value."""
    configured = config.LOCKDOWN_PIN
    if not configured:
        return False
    return pin == configured


def _run_cmd(cmd: list[str], timeout: int = 10) -> dict:
    """Run a system command and return result."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {"success": result.returncode == 0, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Command timed out"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/system/network/lockdown", dependencies=[Depends(require_admin)])
async def network_lockdown(req: NetworkAction, admin: AuthUser = Depends(require_admin)):
    """Kill all external network connectivity."""
    if not _verify_lockdown_pin(req.pin):
        raise HTTPException(403, "Invalid lockdown PIN")

    results = {}

    # 1. Kill Tailscale VPN
    results["tailscale"] = _run_cmd(["sudo", "tailscale", "down"])

    # 2. Block outbound traffic via UFW
    results["ufw_deny"] = _run_cmd(["sudo", "ufw", "default", "deny", "outgoing"])

    # 3. Keep loopback working
    results["ufw_loopback"] = _run_cmd(["sudo", "ufw", "allow", "out", "on", "lo"])

    # 4. Allow established connections to finish (prevents breaking current SSH)
    results["ufw_established"] = _run_cmd(["sudo", "ufw", "allow", "out", "to", "127.0.0.0/8"])

    # 5. Kill RustDesk if running
    results["rustdesk"] = _run_cmd(["sudo", "systemctl", "stop", "rustdesk"])

    # Update system setting
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{SUPABASE_URL}/rest/v1/system_settings?key=eq.network_locked",
            headers=_supa_rest_headers(prefer="return=minimal"),
            json={
                "value": {"locked": True, "locked_at": datetime.utcnow().isoformat(), "locked_by": admin.id},
                "updated_at": datetime.utcnow().isoformat(),
                "updated_by": admin.id,
            },
        )

    return {"success": True, "results": results}


@router.post("/system/network/restore", dependencies=[Depends(require_admin)])
async def network_restore(req: NetworkAction, admin: AuthUser = Depends(require_admin)):
    """Restore network connectivity."""
    if not _verify_lockdown_pin(req.pin):
        raise HTTPException(403, "Invalid lockdown PIN")

    results = {}

    # 1. Restore UFW to allow outgoing
    results["ufw_allow"] = _run_cmd(["sudo", "ufw", "default", "allow", "outgoing"])

    # 2. Bring Tailscale back up
    results["tailscale"] = _run_cmd(["sudo", "tailscale", "up"])

    # 3. Restart RustDesk
    results["rustdesk"] = _run_cmd(["sudo", "systemctl", "start", "rustdesk"])

    # Update system setting
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{SUPABASE_URL}/rest/v1/system_settings?key=eq.network_locked",
            headers=_supa_rest_headers(prefer="return=minimal"),
            json={
                "value": {"locked": False},
                "updated_at": datetime.utcnow().isoformat(),
                "updated_by": admin.id,
            },
        )

    return {"success": True, "results": results}


@router.get("/system/network/status", dependencies=[Depends(require_admin)])
async def network_status():
    """Check current network lockdown state."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/system_settings?key=eq.network_locked&select=*",
            headers=_supa_rest_headers(),
        )
        if resp.status_code != 200:
            return {"locked": False, "error": "Could not fetch state"}
        rows = resp.json()
        if not rows:
            return {"locked": False}
        return rows[0].get("value", {"locked": False})
