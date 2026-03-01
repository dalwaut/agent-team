"""OpenClaw Access Manifest — Manages the credential whitelist per OC instance.

The manifest is the single source of truth for what vault credentials each
OpenClaw container is allowed to receive. The broker checks the manifest
before every credential injection or fetch.

All operations go through Supabase (oc_access_manifest table) with full
audit logging to oc_credential_log.
"""

import httpx
from datetime import datetime, timezone
from typing import Optional

import config


class ManifestError(Exception):
    """Raised when a Supabase operation fails (not a logic error like limit reached)."""
    def __init__(self, message: str, status_code: int = None, body: str = None):
        self.status_code = status_code
        self.body = body
        super().__init__(message)


def _headers() -> dict:
    """Supabase REST headers with service key."""
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _rest_url(table: str) -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Instance Management ──────────────────────────────────────

async def get_instance(slug: str) -> Optional[dict]:
    """Fetch an OC instance by slug."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _rest_url("oc_instances"),
            params={"slug": f"eq.{slug}", "select": "*"},
            headers=_headers(),
        )
        if resp.status_code == 200:
            rows = resp.json()
            return rows[0] if rows else None
    return None


async def get_instance_by_id(instance_id: str) -> Optional[dict]:
    """Fetch an OC instance by UUID."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _rest_url("oc_instances"),
            params={"id": f"eq.{instance_id}", "select": "*"},
            headers=_headers(),
        )
        if resp.status_code == 200:
            rows = resp.json()
            return rows[0] if rows else None
    return None


async def list_instances(status: str = None) -> list[dict]:
    """List all OC instances, optionally filtered by status."""
    params = {"select": "*", "order": "created_at.desc"}
    if status:
        params["status"] = f"eq.{status}"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _rest_url("oc_instances"),
            params=params,
            headers=_headers(),
        )
        return resp.json() if resp.status_code == 200 else []


async def create_instance(
    slug: str,
    display_name: str = "ClawBot",
    owner_id: str = None,
    tier: str = "internal",
    autonomy_level: int = 3,
    instance_config: dict = None,
) -> Optional[dict]:
    """Register a new OC instance."""
    body = {
        "slug": slug,
        "display_name": display_name,
        "tier": tier,
        "autonomy_level": autonomy_level,
        "config": instance_config or {},
        "status": "provisioning",
    }
    if owner_id:
        body["owner_id"] = owner_id

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _rest_url("oc_instances"),
            json=body,
            headers=_headers(),
        )
        if resp.status_code == 201:
            rows = resp.json()
            return rows[0] if rows else None
    return None


async def update_instance_status(slug: str, status: str) -> bool:
    """Update instance status."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _rest_url("oc_instances"),
            params={"slug": f"eq.{slug}"},
            json={"status": status},
            headers=_headers(),
        )
        return resp.status_code == 200


async def update_instance_config(slug: str, new_config: dict) -> bool:
    """Merge new keys into the instance's config JSONB column."""
    # Fetch current config first, then merge
    instance = await get_instance(slug)
    if not instance:
        return False

    current = instance.get("config") or {}
    current.update(new_config)

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _rest_url("oc_instances"),
            params={"slug": f"eq.{slug}"},
            json={"config": current},
            headers=_headers(),
        )
        return resp.status_code == 200


# ── Access Manifest (Credential Whitelist) ────────────────────

async def get_active_grants(instance_id: str) -> list[dict]:
    """Get all active (non-revoked, non-expired) credential grants for an instance."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _rest_url("oc_access_manifest"),
            params={
                "instance_id": f"eq.{instance_id}",
                "revoked_at": "is.null",
                "or": f"(expires_at.is.null,expires_at.gt.{now})",
                "select": "*",
                "order": "granted_at.asc",
            },
            headers=_headers(),
        )
        if resp.status_code == 200:
            result = resp.json()
            return result if isinstance(result, list) else []
        return []


async def get_all_grants(instance_id: str) -> list[dict]:
    """Get full grant history for an instance (including revoked)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _rest_url("oc_access_manifest"),
            params={
                "instance_id": f"eq.{instance_id}",
                "select": "*",
                "order": "granted_at.desc",
            },
            headers=_headers(),
        )
        return resp.json() if resp.status_code == 200 else []


async def grant_credential(
    instance_id: str,
    vault_key: str,
    vault_section: str = "credentials",
    vault_service: str = None,
    scope: str = "inject",
    granted_by: str = None,
    reason: str = None,
    expires_at: str = None,
) -> Optional[dict]:
    """Grant an OC instance access to a specific vault credential.

    This is the core safety operation: only credentials explicitly granted
    here will ever be injected into a container.

    Returns the grant dict on success, None if limit reached, or raises on error.
    """
    # Safety check: enforce max credentials per instance
    active = await get_active_grants(instance_id)
    if len(active) >= config.MAX_CREDENTIALS_PER_INSTANCE:
        return None  # Caller should handle this as a limit error

    body = {
        "instance_id": instance_id,
        "vault_key": vault_key,
        "vault_section": vault_section,
        "scope": scope,
        "reason": reason,
    }
    if vault_service:
        body["vault_service"] = vault_service
    if granted_by:
        body["granted_by"] = granted_by
    if expires_at:
        body["expires_at"] = expires_at

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _rest_url("oc_access_manifest"),
            json=body,
            headers={
                **_headers(),
                # Upsert on unique constraint (instance_id, vault_key, vault_service)
                "Prefer": "return=representation,resolution=merge-duplicates",
            },
        )
        if resp.status_code in (200, 201):
            rows = resp.json()
            grant = rows[0] if isinstance(rows, list) and rows else None
            # Log the grant
            await _log_credential_action(
                instance_id=instance_id,
                instance_slug="",  # caller fills this
                action="grant",
                vault_keys=[vault_key],
                success=True,
                detail=reason,
                actor_id=granted_by,
            )
            return grant

        # Surface the actual Supabase error instead of returning None
        raise ManifestError(
            f"Supabase POST to oc_access_manifest failed: {resp.status_code} — {resp.text}",
            status_code=resp.status_code,
            body=resp.text,
        )


async def revoke_credential(
    instance_id: str,
    vault_key: str,
    vault_service: str = None,
    revoked_by: str = None,
    reason: str = None,
) -> bool:
    """Revoke an OC instance's access to a credential (soft-delete)."""
    now = datetime.now(timezone.utc).isoformat()
    params = {
        "instance_id": f"eq.{instance_id}",
        "vault_key": f"eq.{vault_key}",
        "revoked_at": "is.null",
    }
    if vault_service:
        params["vault_service"] = f"eq.{vault_service}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _rest_url("oc_access_manifest"),
            params=params,
            json={"revoked_at": now},
            headers=_headers(),
        )
        success = resp.status_code == 200
        if success:
            await _log_credential_action(
                instance_id=instance_id,
                instance_slug="",
                action="revoke",
                vault_keys=[vault_key],
                success=True,
                detail=reason or f"Revoked by {revoked_by}",
                actor_id=revoked_by,
            )
        return success


async def revoke_all_credentials(
    instance_id: str,
    revoked_by: str = None,
    reason: str = "Kill switch — all credentials revoked",
) -> int:
    """Revoke ALL active credentials for an instance. This is the kill switch."""
    active = await get_active_grants(instance_id)
    if not active:
        return 0

    now = datetime.now(timezone.utc).isoformat()
    revoked_keys = []

    async with httpx.AsyncClient(timeout=10) as client:
        for grant in active:
            resp = await client.patch(
                _rest_url("oc_access_manifest"),
                params={"id": f"eq.{grant['id']}"},
                json={"revoked_at": now},
                headers=_headers(),
            )
            if resp.status_code == 200:
                revoked_keys.append(grant["vault_key"])

    if revoked_keys:
        await _log_credential_action(
            instance_id=instance_id,
            instance_slug="",
            action="revoke",
            vault_keys=revoked_keys,
            success=True,
            detail=reason,
            actor_id=revoked_by,
        )

    return len(revoked_keys)


# ── Credential Resolution (what the broker actually injects) ──

async def resolve_credentials(instance_id: str) -> list[dict]:
    """Resolve the active credential grants into vault fetch instructions.

    Returns a list of dicts describing what to fetch from the vault:
    [
        {"vault_key": "DISCORD_TOKEN", "section": "credentials", "service": null},
        {"vault_key": "STRIPE_SECRET_KEY", "section": "services", "service": "opai-billing"},
    ]
    """
    grants = await get_active_grants(instance_id)
    return [
        {
            "vault_key": g["vault_key"],
            "section": g["vault_section"],
            "service": g.get("vault_service"),
            "scope": g["scope"],
        }
        for g in grants
    ]


# ── Audit Logging ─────────────────────────────────────────────

async def _log_credential_action(
    instance_id: str,
    instance_slug: str,
    action: str,
    vault_keys: list[str],
    success: bool = True,
    detail: str = None,
    actor_id: str = None,
):
    """Log a credential action to oc_credential_log."""
    body = {
        "instance_id": instance_id,
        "instance_slug": instance_slug or "unknown",
        "action": action,
        "vault_keys": vault_keys,
        "success": success,
        "detail": detail,
    }
    if actor_id:
        body["actor_id"] = actor_id

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(
                _rest_url("oc_credential_log"),
                json=body,
                headers=_headers(),
            )
    except Exception:
        pass  # Don't fail the main operation if audit logging fails


async def get_credential_log(
    instance_id: str = None,
    action: str = None,
    limit: int = 50,
) -> list[dict]:
    """Fetch credential audit log entries."""
    params = {"select": "*", "order": "created_at.desc", "limit": str(limit)}
    if instance_id:
        params["instance_id"] = f"eq.{instance_id}"
    if action:
        params["action"] = f"eq.{action}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _rest_url("oc_credential_log"),
            params=params,
            headers=_headers(),
        )
        return resp.json() if resp.status_code == 200 else []
