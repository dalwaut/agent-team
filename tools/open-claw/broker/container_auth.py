"""Container authentication — per-instance callback tokens.

Each OC container gets a unique callback token at provisioning time. When the
container calls back to the broker (e.g. for LLM proxy), it authenticates with:

    Authorization: Bearer oc_<slug>_<random>

This module provides:
- generate_callback_token(slug) — create a new token, store in DB
- require_container_auth — FastAPI dependency that validates the token
"""

import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request

import config
import manifest


def generate_callback_token(slug: str) -> str:
    """Generate a cryptographically random callback token for an instance.

    Format: oc_<slug>_<32-char hex>
    The token is stored as a SHA-256 hash in the instance config.
    Returns the plaintext token (only shown once at provisioning).
    """
    random_part = secrets.token_hex(16)
    token = f"oc_{slug}_{random_part}"
    return token


def hash_token(token: str) -> str:
    """SHA-256 hash a token for storage."""
    return hashlib.sha256(token.encode()).hexdigest()


async def require_container_auth(request: Request) -> dict:
    """FastAPI dependency: validate a container callback token.

    Expects: Authorization: Bearer oc_<slug>_<hex>

    Returns dict with instance info: {slug, instance_id, tier, autonomy_level}
    """
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer oc_"):
        raise HTTPException(status_code=401, detail="Missing or invalid container token")

    token = auth_header.removeprefix("Bearer ").strip()

    # Extract slug from token format: oc_<slug>_<hex>
    parts = token.split("_", 2)
    if len(parts) < 3 or parts[0] != "oc":
        raise HTTPException(status_code=401, detail="Malformed container token")

    # slug may contain hyphens, so we need to find the last _ before the hex part
    # Format: oc_<slug>_<32-char hex>
    # The hex part is always 32 chars, so split from the right
    token_without_prefix = token[3:]  # remove "oc_"
    if len(token_without_prefix) < 33:  # at least 1 char slug + _ + 32 hex
        raise HTTPException(status_code=401, detail="Malformed container token")

    hex_part = token_without_prefix[-32:]
    slug = token_without_prefix[:-33]  # everything before _<32hex>

    if not slug:
        raise HTTPException(status_code=401, detail="Malformed container token")

    # Look up instance
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=401, detail="Unknown instance")

    if instance["status"] not in ("running", "provisioning"):
        raise HTTPException(status_code=403, detail=f"Instance is {instance['status']}")

    # Verify token hash matches stored hash
    stored_hash = (instance.get("config") or {}).get("callback_token_hash")
    if not stored_hash:
        raise HTTPException(status_code=401, detail="Instance has no callback token configured")

    if hash_token(token) != stored_hash:
        raise HTTPException(status_code=401, detail="Invalid container token")

    return {
        "slug": slug,
        "instance_id": instance["id"],
        "tier": instance.get("tier", "internal"),
        "autonomy_level": instance.get("autonomy_level", 3),
    }
