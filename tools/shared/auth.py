"""OPAI Shared Auth — Supabase JWT validation for all FastAPI services.

Usage in any OPAI FastAPI service:

    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
    from auth import get_current_user, require_admin, AuthUser

    @router.get("/protected")
    async def protected(user: AuthUser = Depends(get_current_user)):
        return {"hello": user.email}

    @router.get("/admin-only")
    async def admin_only(user: AuthUser = Depends(require_admin)):
        return {"admin": user.email}
"""

import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from jose import jwt, JWTError, jwk
from jose.utils import base64url_decode
from fastapi import Depends, HTTPException, Header, WebSocket


# ── Configuration ──────────────────────────────────────────

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWKS_URL = os.getenv(
    "SUPABASE_JWKS_URL",
    f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else "",
)

# Allow disabling auth for local dev (set OPAI_AUTH_DISABLED=1)
AUTH_DISABLED = os.getenv("OPAI_AUTH_DISABLED", "").strip() in ("1", "true", "yes")


# ── JWKS Cache ─────────────────────────────────────────────

_jwks_cache: dict = {}
_jwks_cache_expiry: float = 0
JWKS_CACHE_TTL = 3600  # 1 hour


async def _fetch_jwks() -> dict:
    """Fetch JWKS from Supabase and cache for 1 hour."""
    global _jwks_cache, _jwks_cache_expiry

    if _jwks_cache and time.time() < _jwks_cache_expiry:
        return _jwks_cache

    if not SUPABASE_JWKS_URL:
        return {}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(SUPABASE_JWKS_URL)
            resp.raise_for_status()
            _jwks_cache = resp.json()
            _jwks_cache_expiry = time.time() + JWKS_CACHE_TTL
            return _jwks_cache
    except Exception:
        # Return stale cache if available
        return _jwks_cache


def _get_signing_key(jwks: dict, token: str) -> tuple[Optional[str], Optional[str]]:
    """Extract the signing key and algorithm from JWKS that matches the token's kid.

    Returns (pem_key, algorithm) or (None, None).
    """
    try:
        unverified_header = jwt.get_unverified_header(token)
    except JWTError:
        return None, None

    kid = unverified_header.get("kid")
    if not kid:
        return None, None

    for key_data in jwks.get("keys", []):
        if key_data.get("kid") == kid:
            alg = key_data.get("alg", unverified_header.get("alg", "RS256"))
            pem = jwk.construct(key_data, algorithm=alg).to_pem().decode("utf-8")
            return pem, alg
    return None, None


# ── AuthUser ───────────────────────────────────────────────

@dataclass
class AuthUser:
    """Authenticated user extracted from JWT."""
    id: str           # Supabase auth.users UUID
    email: str
    role: str          # 'admin' or 'user'
    display_name: str
    is_active: bool = True
    preface_prompt: str = ""
    allowed_apps: list = None
    allowed_agents: list = None
    sandbox_path: str = ""
    onboarding_completed: bool = False
    ai_locked: bool = False
    marketplace_tier: str = ""   # 'starter' | 'pro' | 'ultimate' | ''

    def __post_init__(self):
        if self.allowed_apps is None:
            self.allowed_apps = []
        if self.allowed_agents is None:
            self.allowed_agents = []

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def has_app_access(self, app_name: str) -> bool:
        """Check if user has access to a specific app."""
        if self.is_admin:
            return True
        if not self.allowed_apps:
            return False
        return app_name in self.allowed_apps


# ── Token Decoding ─────────────────────────────────────────

async def decode_token(token: str) -> AuthUser:
    """Validate and decode a Supabase JWT.

    Tries JWKS first (RS256), falls back to JWT_SECRET (HS256).
    """
    payload = None

    # Strategy 1: JWKS (RS256, ES256, etc.)
    if SUPABASE_JWKS_URL:
        jwks = await _fetch_jwks()
        signing_key, key_alg = _get_signing_key(jwks, token)
        if signing_key and key_alg:
            try:
                payload = jwt.decode(
                    token,
                    signing_key,
                    algorithms=[key_alg],
                    audience="authenticated",
                    options={"verify_exp": True},
                )
            except JWTError:
                pass

    # Strategy 2: JWT Secret (HS256) — Supabase default
    if payload is None and SUPABASE_JWT_SECRET:
        try:
            payload = jwt.decode(
                token,
                SUPABASE_JWT_SECRET,
                algorithms=["HS256"],
                audience="authenticated",
                options={"verify_exp": True},
            )
        except JWTError:
            pass

    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Extract user info from JWT claims
    user_id = payload.get("sub", "")
    email = payload.get("email", "")

    # Role from app_metadata (set during signup or by admin)
    app_metadata = payload.get("app_metadata", {})
    role = app_metadata.get("role", "user")

    # Display name from user_metadata
    user_metadata = payload.get("user_metadata", {})
    display_name = user_metadata.get("display_name", email.split("@")[0] if email else "")

    return AuthUser(
        id=user_id,
        email=email,
        role=role,
        display_name=display_name,
    )


# ── Profile Enrichment ─────────────────────────────────────

# Cache profiles briefly to avoid DB call on every request
_profile_cache: dict[str, tuple[float, dict]] = {}
PROFILE_CACHE_TTL = 60  # 1 minute


async def _fetch_profile(user_id: str) -> Optional[dict]:
    """Fetch user profile from Supabase to get is_active, preface_prompt, etc."""
    if user_id in _profile_cache:
        cached_time, cached_data = _profile_cache[user_id]
        if time.time() - cached_time < PROFILE_CACHE_TTL:
            return cached_data

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return None

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=is_active,preface_prompt,allowed_apps,allowed_agents,sandbox_path,onboarding_completed,ai_locked,marketplace_tier",
                headers={
                    "apikey": SUPABASE_SERVICE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                },
            )
            if resp.status_code == 200:
                rows = resp.json()
                if rows:
                    _profile_cache[user_id] = (time.time(), rows[0])
                    return rows[0]
    except Exception:
        pass

    return None


async def _enrich_user(user: AuthUser) -> AuthUser:
    """Enrich AuthUser with profile data (is_active, preface_prompt, etc.)."""
    profile = await _fetch_profile(user.id)
    if profile:
        user.is_active = profile.get("is_active", True)
        user.preface_prompt = profile.get("preface_prompt", "") or ""
        user.allowed_apps = profile.get("allowed_apps", []) or []
        user.allowed_agents = profile.get("allowed_agents", []) or []
        user.sandbox_path = profile.get("sandbox_path", "") or ""
        user.onboarding_completed = profile.get("onboarding_completed", False)
        user.ai_locked = profile.get("ai_locked", False) or False
        user.marketplace_tier = profile.get("marketplace_tier", "") or ""
    return user


def clear_profile_cache(user_id: str = None):
    """Clear cached profile data. If user_id given, clear just that user."""
    if user_id:
        _profile_cache.pop(user_id, None)
    else:
        _profile_cache.clear()


# ── FastAPI Dependencies ───────────────────────────────────

async def get_current_user(authorization: str | None = Header(None)) -> AuthUser:
    """FastAPI dependency: require a valid Supabase JWT.

    Returns AuthUser or raises 401. Enriches with profile data.
    """
    if AUTH_DISABLED:
        return AuthUser(id="dev-user", email="dev@local", role="admin", display_name="Dev")

    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Bearer token required")

    # Fast-path: Supabase service key → admin (service-to-service calls)
    if SUPABASE_SERVICE_KEY and token == SUPABASE_SERVICE_KEY:
        return AuthUser(id="service-role", email="service@opai", role="admin", display_name="Service")

    user = await decode_token(token)

    # Enrich with profile data (is_active, preface_prompt, etc.)
    user = await _enrich_user(user)

    # Block inactive users
    if not user.is_active and not user.is_admin:
        raise HTTPException(status_code=403, detail="Account is disabled")

    # Block AI-locked users (admins bypass)
    if user.ai_locked and not user.is_admin:
        raise HTTPException(status_code=403, detail="AI access locked — contact admin")

    return user


async def require_admin(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    """FastAPI dependency: require admin role.

    Returns AuthUser or raises 403.
    """
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# ── WebSocket Auth ─────────────────────────────────────────

async def authenticate_websocket(websocket: WebSocket, timeout: float = 10.0) -> AuthUser:
    """Authenticate a WebSocket connection.

    Expects the first message to be: {"type": "auth", "token": "..."}
    Returns AuthUser or closes the connection with code 4001.
    """
    if AUTH_DISABLED:
        return AuthUser(id="dev-user", email="dev@local", role="admin", display_name="Dev")

    import asyncio

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=timeout)
    except asyncio.TimeoutError:
        await websocket.close(code=4001, reason="Auth timeout")
        raise HTTPException(status_code=401, detail="Auth timeout")

    import json
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        await websocket.close(code=4001, reason="Invalid auth message")
        raise HTTPException(status_code=401, detail="Invalid auth message")

    if data.get("type") != "auth" or not data.get("token"):
        await websocket.close(code=4001, reason="First message must be auth")
        raise HTTPException(status_code=401, detail="First message must be auth")

    try:
        user = await decode_token(data["token"])
    except HTTPException:
        await websocket.close(code=4001, reason="Invalid token")
        raise

    return user
