"""OPAI Vault — Per-user vault API routes.

All endpoints require a valid Supabase JWT. Each user can only access
their own secrets (enforced by RLS + app-level encryption).

Endpoints:
    GET    /vault/api/user/secrets          — List secret names (no values)
    GET    /vault/api/user/secrets/{name}   — Get decrypted secret value
    PUT    /vault/api/user/secrets/{name}   — Set/update a secret
    DELETE /vault/api/user/secrets/{name}   — Delete a secret
    GET    /vault/api/user/audit            — View own audit log
    GET    /vault/api/user/stats            — Count of secrets, last access
"""

import sys
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from auth import get_current_user, AuthUser

import config
import user_vault_crypto as crypto
from routes_user_vault_auth import validate_session_cookie, UV_COOKIE_NAME

import httpx


router = APIRouter(prefix="/vault/api/user", tags=["user-vault"])


# ── Vault Unlock Gate ─────────────────────────────────

async def require_vault_unlocked(
    request: Request,
    user: AuthUser = Depends(get_current_user),
) -> AuthUser:
    """Require both Supabase JWT + valid user vault session cookie."""
    token = request.cookies.get(UV_COOKIE_NAME)
    cookie_user_id = validate_session_cookie(token)
    if not cookie_user_id or cookie_user_id != user.id:
        raise HTTPException(status_code=403, detail="Vault locked — PIN required")
    return user


# ── Supabase Client Helper ──────────────────────────────

def _sb_headers(user_token: str) -> dict:
    """Headers for Supabase REST API calls using the user's JWT."""
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {user_token}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_service_headers() -> dict:
    """Headers for service-role calls (audit log insert)."""
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


def _extract_token(request: Request) -> str:
    """Extract raw JWT from Authorization header."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:]
    return ""


async def _log_audit(user_id: str, action: str, secret_name: str = None, ip: str = ""):
    """Insert an audit log entry using service role (bypasses RLS for insert)."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(
                f"{config.SUPABASE_URL}/rest/v1/user_vault_audit",
                headers=_sb_service_headers(),
                json={
                    "user_id": user_id,
                    "action": action,
                    "secret_name": secret_name,
                    "ip_address": ip,
                },
            )
    except Exception:
        pass  # Audit failure should not block operations


# ── Models ───────────────────────────────────────────────

class SetSecretRequest(BaseModel):
    value: str
    category: Optional[str] = "general"
    description: Optional[str] = None


# ── Endpoints ────────────────────────────────────────────

@router.get("/secrets")
async def list_user_secrets(
    request: Request,
    user: AuthUser = Depends(require_vault_unlocked),
):
    """List the user's secret names, categories, and metadata (no values)."""
    token = _extract_token(request)
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_secrets"
            f"?user_id=eq.{user.id}&select=name,category,description,created_at,updated_at,last_accessed_at"
            f"&order=name.asc",
            headers=_sb_headers(token),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Failed to list secrets")
        secrets = resp.json()

    ip = request.client.host if request.client else ""
    await _log_audit(user.id, "list", ip=ip)

    return {"secrets": secrets, "count": len(secrets)}


@router.get("/secrets/{name:path}")
async def get_user_secret(
    name: str,
    request: Request,
    user: AuthUser = Depends(require_vault_unlocked),
):
    """Get a decrypted secret value by name."""
    token = _extract_token(request)
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_secrets"
            f"?user_id=eq.{user.id}&name=eq.{name}&select=encrypted_value,category,description",
            headers=_sb_headers(token),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Failed to get secret")
        rows = resp.json()

    if not rows:
        raise HTTPException(status_code=404, detail=f"Secret '{name}' not found")

    encrypted = rows[0]["encrypted_value"]
    try:
        value = crypto.decrypt(user.id, encrypted)
    except Exception:
        raise HTTPException(status_code=500, detail="Decryption failed")

    # Update last_accessed_at
    async with httpx.AsyncClient(timeout=5) as client:
        await client.patch(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_secrets"
            f"?user_id=eq.{user.id}&name=eq.{name}",
            headers=_sb_headers(token),
            json={"last_accessed_at": datetime.now(timezone.utc).isoformat()},
        )

    ip = request.client.host if request.client else ""
    await _log_audit(user.id, "get", secret_name=name, ip=ip)

    return {
        "name": name,
        "value": value,
        "category": rows[0].get("category"),
        "description": rows[0].get("description"),
    }


@router.put("/secrets/{name:path}")
async def set_user_secret(
    name: str,
    body: SetSecretRequest,
    request: Request,
    user: AuthUser = Depends(require_vault_unlocked),
):
    """Create or update a secret."""
    encrypted = crypto.encrypt(user.id, body.value)
    now = datetime.now(timezone.utc).isoformat()
    token = _extract_token(request)

    # Upsert: try update first, create if not found
    async with httpx.AsyncClient(timeout=10) as client:
        # Check if exists
        check = await client.get(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_secrets"
            f"?user_id=eq.{user.id}&name=eq.{name}&select=id",
            headers=_sb_headers(token),
        )
        existing = check.json() if check.status_code == 200 else []

        if existing:
            # Update
            resp = await client.patch(
                f"{config.SUPABASE_URL}/rest/v1/user_vault_secrets"
                f"?user_id=eq.{user.id}&name=eq.{name}",
                headers=_sb_headers(token),
                json={
                    "encrypted_value": encrypted,
                    "category": body.category or "general",
                    "description": body.description,
                    "updated_at": now,
                },
            )
            action = "update"
        else:
            # Insert
            resp = await client.post(
                f"{config.SUPABASE_URL}/rest/v1/user_vault_secrets",
                headers=_sb_headers(token),
                json={
                    "user_id": user.id,
                    "name": name,
                    "encrypted_value": encrypted,
                    "category": body.category or "general",
                    "description": body.description,
                    "created_at": now,
                    "updated_at": now,
                },
            )
            action = "set"

        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=resp.status_code, detail="Failed to save secret")

    ip = request.client.host if request.client else ""
    await _log_audit(user.id, action, secret_name=name, ip=ip)

    return {"status": "ok", "name": name, "action": action}


@router.delete("/secrets/{name:path}")
async def delete_user_secret(
    name: str,
    request: Request,
    user: AuthUser = Depends(require_vault_unlocked),
):
    """Delete a secret by name."""
    token = _extract_token(request)
    async with httpx.AsyncClient(timeout=10) as client:
        # Check exists first
        check = await client.get(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_secrets"
            f"?user_id=eq.{user.id}&name=eq.{name}&select=id",
            headers=_sb_headers(token),
        )
        if check.status_code != 200 or not check.json():
            raise HTTPException(status_code=404, detail=f"Secret '{name}' not found")

        resp = await client.delete(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_secrets"
            f"?user_id=eq.{user.id}&name=eq.{name}",
            headers=_sb_headers(token),
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(status_code=resp.status_code, detail="Failed to delete secret")

    ip = request.client.host if request.client else ""
    await _log_audit(user.id, "delete", secret_name=name, ip=ip)

    return {"status": "deleted", "name": name}


@router.get("/audit")
async def get_user_audit(
    request: Request,
    limit: int = 50,
    user: AuthUser = Depends(require_vault_unlocked),
):
    """View the user's own audit log."""
    token = _extract_token(request)
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_audit"
            f"?user_id=eq.{user.id}&select=action,secret_name,ip_address,created_at"
            f"&order=created_at.desc&limit={limit}",
            headers=_sb_headers(token),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Failed to get audit log")

    return {"entries": resp.json()}


@router.get("/stats")
async def get_user_stats(
    request: Request,
    user: AuthUser = Depends(require_vault_unlocked),
):
    """Get count of secrets and last access time."""
    token = _extract_token(request)
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_secrets"
            f"?user_id=eq.{user.id}&select=name,category,last_accessed_at"
            f"&order=last_accessed_at.desc.nullslast",
            headers=_sb_headers(token),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Failed to get stats")
        rows = resp.json()

    categories = {}
    for r in rows:
        cat = r.get("category", "general")
        categories[cat] = categories.get(cat, 0) + 1

    last_access = rows[0]["last_accessed_at"] if rows and rows[0].get("last_accessed_at") else None

    return {
        "total_secrets": len(rows),
        "categories": categories,
        "last_access": last_access,
    }
