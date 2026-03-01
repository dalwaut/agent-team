"""OPAI Vault — JWT session management for web UI.

Uses vault-specific 256-bit random secret (NOT the Supabase JWT secret).
Tokens stored as HttpOnly cookies. Sliding window: each API call extends TTL.
"""

import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

import jwt

import config
import auth_store


ALGORITHM = "HS256"
COOKIE_NAME = "vault_session"


def create_token() -> tuple[str, str]:
    """Create a new session JWT. Returns (token, jti)."""
    secret = auth_store.get_session_secret()
    jti = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    payload = {
        "sub": "vault_ui",
        "jti": jti,
        "iat": now,
        "exp": now + timedelta(seconds=config.SESSION_TTL),
    }
    token = jwt.encode(payload, secret, algorithm=ALGORITHM)
    return token, jti


def validate_token(token: str) -> Optional[dict]:
    """Validate a session JWT. Returns payload or None."""
    if not token:
        return None
    secret = auth_store.get_session_secret()
    try:
        payload = jwt.decode(token, secret, algorithms=[ALGORITHM])
        if auth_store.is_session_revoked(payload.get("jti", "")):
            return None
        return payload
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None


def refresh_token(token: str) -> Optional[str]:
    """Sliding window: if token is valid, issue a new one with extended expiry."""
    payload = validate_token(token)
    if not payload:
        return None
    secret = auth_store.get_session_secret()
    now = datetime.now(timezone.utc)
    payload["exp"] = now + timedelta(seconds=config.SESSION_TTL)
    payload["iat"] = now
    return jwt.encode(payload, secret, algorithm=ALGORITHM)


def revoke_token(token: str):
    """Revoke a session token by adding its JTI to the revocation list."""
    payload = validate_token(token)
    if payload:
        auth_store.revoke_session(payload["jti"])


def cookie_params() -> dict:
    """Cookie parameters for session token."""
    return {
        "key": COOKIE_NAME,
        "httponly": True,
        "secure": True,
        "samesite": "strict",
        "path": "/vault/",
        "max_age": config.SESSION_TTL,
    }
