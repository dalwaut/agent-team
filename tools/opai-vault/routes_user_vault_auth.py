"""OPAI Vault — Per-user vault PIN authentication.

Endpoints (all under /vault/api/user/pin):
    GET  /status  — PIN configured? locked?
    POST /setup   — First-time PIN setup (4-6 digits)
    POST /verify  — Verify PIN, issue session cookie
    POST /lock    — Clear session cookie

All endpoints require a valid Supabase JWT (Depends(get_current_user)).
On PIN verify/setup, an HttpOnly cookie 'user_vault_session' is set
containing a short-lived JWT with the user_id.
"""

import sys
import os
import re
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from auth import get_current_user, AuthUser

import config
import httpx
import bcrypt
import jwt as pyjwt


router = APIRouter(prefix="/vault/api/user/pin", tags=["user-vault-auth"])

# Session cookie config
UV_COOKIE_NAME = "user_vault_session"
UV_SESSION_TTL = 1800  # 30 minutes
UV_JWT_SECRET = None  # Lazy-loaded from system vault


def _get_jwt_secret() -> str:
    """Get or generate a JWT secret for user vault sessions."""
    global UV_JWT_SECRET
    if UV_JWT_SECRET:
        return UV_JWT_SECRET
    # Use the vault's own session secret (from auth_store) for signing
    import auth_store
    UV_JWT_SECRET = auth_store.get_session_secret()
    return UV_JWT_SECRET


def _set_session_cookie(response: Response, user_id: str):
    """Issue an HttpOnly session cookie with a short-lived JWT."""
    secret = _get_jwt_secret()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "scope": "user_vault",
        "iat": now,
        "exp": now + timedelta(seconds=UV_SESSION_TTL),
    }
    token = pyjwt.encode(payload, secret, algorithm="HS256")
    response.set_cookie(
        key=UV_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=True,
        samesite="strict",
        path="/vault/",
        max_age=UV_SESSION_TTL,
    )


def validate_session_cookie(token: str) -> Optional[str]:
    """Validate user vault session cookie. Returns user_id or None."""
    if not token:
        return None
    secret = _get_jwt_secret()
    try:
        payload = pyjwt.decode(token, secret, algorithms=["HS256"])
        if payload.get("scope") != "user_vault":
            return None
        return payload.get("sub")
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
        return None


# ── Supabase helpers ──────────────────────────────────

def _sb_service_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _get_pin_row(user_id: str) -> Optional[dict]:
    """Fetch PIN row from Supabase using service role."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_pins"
            f"?user_id=eq.{user_id}&select=pin_hash,failed_attempts,locked_until",
            headers=_sb_service_headers(),
        )
        if resp.status_code != 200:
            return None
        rows = resp.json()
        return rows[0] if rows else None


async def _upsert_pin(user_id: str, pin_hash: str):
    """Insert or update PIN hash in Supabase."""
    now = datetime.now(timezone.utc).isoformat()
    async with httpx.AsyncClient(timeout=10) as client:
        # Check if exists
        check = await client.get(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_pins"
            f"?user_id=eq.{user_id}&select=user_id",
            headers=_sb_service_headers(),
        )
        existing = check.json() if check.status_code == 200 else []

        if existing:
            await client.patch(
                f"{config.SUPABASE_URL}/rest/v1/user_vault_pins"
                f"?user_id=eq.{user_id}",
                headers=_sb_service_headers(),
                json={
                    "pin_hash": pin_hash,
                    "failed_attempts": 0,
                    "locked_until": None,
                    "updated_at": now,
                },
            )
        else:
            await client.post(
                f"{config.SUPABASE_URL}/rest/v1/user_vault_pins",
                headers=_sb_service_headers(),
                json={
                    "user_id": user_id,
                    "pin_hash": pin_hash,
                    "failed_attempts": 0,
                    "locked_until": None,
                    "created_at": now,
                    "updated_at": now,
                },
            )


async def _record_failed_attempt(user_id: str, current_attempts: int):
    """Increment failed attempts and possibly set lockout."""
    new_attempts = current_attempts + 1
    locked_until = None
    if new_attempts >= config.PIN_MAX_ATTEMPTS:
        locked_until = (
            datetime.now(timezone.utc)
            + timedelta(seconds=config.PIN_LOCKOUT_SECONDS)
        ).isoformat()

    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_pins"
            f"?user_id=eq.{user_id}",
            headers=_sb_service_headers(),
            json={
                "failed_attempts": new_attempts,
                "locked_until": locked_until,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )


async def _reset_failed_attempts(user_id: str):
    """Reset failed attempts after successful login."""
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{config.SUPABASE_URL}/rest/v1/user_vault_pins"
            f"?user_id=eq.{user_id}",
            headers=_sb_service_headers(),
            json={
                "failed_attempts": 0,
                "locked_until": None,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )


# ── Models ────────────────────────────────────────────

class PinRequest(BaseModel):
    pin: str


# ── Endpoints ─────────────────────────────────────────

@router.get("/status")
async def pin_status(user: AuthUser = Depends(get_current_user)):
    """Check if user has PIN configured and lockout status."""
    row = await _get_pin_row(user.id)

    if not row:
        return {"pin_configured": False, "locked": False, "locked_seconds": 0}

    locked = False
    locked_seconds = 0
    if row.get("locked_until"):
        locked_until = datetime.fromisoformat(row["locked_until"].replace("Z", "+00:00"))
        remaining = (locked_until - datetime.now(timezone.utc)).total_seconds()
        if remaining > 0:
            locked = True
            locked_seconds = int(remaining)

    return {
        "pin_configured": True,
        "locked": locked,
        "locked_seconds": locked_seconds,
    }


@router.post("/setup")
async def pin_setup(
    body: PinRequest,
    response: Response,
    user: AuthUser = Depends(get_current_user),
):
    """Set up a new PIN (4-6 digits). Also used to change PIN."""
    pin = body.pin
    if not re.match(r'^\d{4,6}$', pin):
        raise HTTPException(status_code=400, detail="PIN must be 4-6 digits")

    # Hash the PIN
    pin_hash = bcrypt.hashpw(pin.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    await _upsert_pin(user.id, pin_hash)

    # Issue session cookie
    _set_session_cookie(response, user.id)

    return {"status": "ok"}


@router.post("/verify")
async def pin_verify(
    body: PinRequest,
    response: Response,
    user: AuthUser = Depends(get_current_user),
):
    """Verify PIN and issue session cookie."""
    row = await _get_pin_row(user.id)
    if not row:
        raise HTTPException(status_code=404, detail="PIN not configured")

    # Check lockout
    if row.get("locked_until"):
        locked_until = datetime.fromisoformat(row["locked_until"].replace("Z", "+00:00"))
        remaining = (locked_until - datetime.now(timezone.utc)).total_seconds()
        if remaining > 0:
            raise HTTPException(
                status_code=429,
                detail=f"Too many attempts. Wait {int(remaining)}s.",
            )

    # Verify PIN
    if not bcrypt.checkpw(body.pin.encode("utf-8"), row["pin_hash"].encode("utf-8")):
        failed = row.get("failed_attempts", 0)
        await _record_failed_attempt(user.id, failed)
        new_count = failed + 1
        if new_count >= config.PIN_MAX_ATTEMPTS:
            raise HTTPException(
                status_code=429,
                detail=f"Too many attempts. Locked for {config.PIN_LOCKOUT_SECONDS}s.",
            )
        raise HTTPException(status_code=401, detail="Invalid PIN")

    # Success — reset attempts and issue session
    await _reset_failed_attempts(user.id)
    _set_session_cookie(response, user.id)

    return {"status": "ok"}


@router.post("/lock")
async def pin_lock(
    response: Response,
    user: AuthUser = Depends(get_current_user),
):
    """Lock the vault by clearing the session cookie."""
    response.delete_cookie(
        key=UV_COOKIE_NAME,
        path="/vault/",
        secure=True,
        httponly=True,
        samesite="strict",
    )
    return {"status": "locked"}
