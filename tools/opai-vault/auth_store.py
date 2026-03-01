"""OPAI Vault — Auth store for web UI authentication.

Manages data/auth.json: PIN hash, WebAuthn credentials, session secret.
"""

import json
import os
import secrets
from pathlib import Path
from typing import Optional

import bcrypt

import config


def _load() -> dict:
    if not config.AUTH_FILE.exists():
        return {}
    try:
        return json.loads(config.AUTH_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _save(data: dict):
    config.AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.AUTH_FILE.write_text(json.dumps(data, indent=2))


# ── PIN ──────────────────────────────────────────────────

def is_pin_configured() -> bool:
    return "pin_hash" in _load()


def set_pin(pin: str):
    data = _load()
    data["pin_hash"] = bcrypt.hashpw(pin.encode(), bcrypt.gensalt(rounds=12)).decode()
    _save(data)


def verify_pin(pin: str) -> bool:
    data = _load()
    stored = data.get("pin_hash")
    if not stored:
        return False
    return bcrypt.checkpw(pin.encode(), stored.encode())


# ── Rate limiting ────────────────────────────────────────

def get_failed_attempts() -> dict:
    data = _load()
    return data.get("rate_limit", {"count": 0, "locked_until": 0})


def record_failed_attempt():
    data = _load()
    rl = data.get("rate_limit", {"count": 0, "locked_until": 0})
    rl["count"] = rl.get("count", 0) + 1
    if rl["count"] >= config.PIN_MAX_ATTEMPTS:
        import time
        rl["locked_until"] = time.time() + config.PIN_LOCKOUT_SECONDS
    data["rate_limit"] = rl
    _save(data)


def reset_failed_attempts():
    data = _load()
    data["rate_limit"] = {"count": 0, "locked_until": 0}
    _save(data)


def is_locked_out() -> tuple[bool, int]:
    import time
    rl = get_failed_attempts()
    locked_until = rl.get("locked_until", 0)
    if locked_until > time.time():
        return True, int(locked_until - time.time())
    if locked_until > 0:
        reset_failed_attempts()
    return False, 0


# ── WebAuthn Credentials ────────────────────────────────

def get_webauthn_credentials() -> list[dict]:
    data = _load()
    return data.get("webauthn_credentials", [])


def add_webauthn_credential(cred: dict):
    data = _load()
    creds = data.get("webauthn_credentials", [])
    creds.append(cred)
    data["webauthn_credentials"] = creds
    _save(data)


def is_webauthn_configured() -> bool:
    return len(get_webauthn_credentials()) > 0


# ── Session Secret ──────────────────────────────────────

def get_session_secret() -> str:
    data = _load()
    secret = data.get("session_secret")
    if not secret:
        secret = secrets.token_hex(32)
        data["session_secret"] = secret
        _save(data)
    return secret


# ── Age Key Check ───────────────────────────────────────

def is_age_key_present() -> bool:
    return config.VAULT_KEY_FILE.exists()


# ── Revoked Sessions ───────────────────────────────────

def revoke_session(jti: str):
    data = _load()
    revoked = data.get("revoked_sessions", [])
    revoked.append(jti)
    # Keep only last 100 revoked JTIs
    if len(revoked) > 100:
        revoked = revoked[-100:]
    data["revoked_sessions"] = revoked
    _save(data)


def is_session_revoked(jti: str) -> bool:
    data = _load()
    return jti in data.get("revoked_sessions", [])
