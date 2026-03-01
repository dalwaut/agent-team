"""OpenClaw Vault Bridge — Fetches credentials from the OPAI Vault on behalf of OC instances.

This module is the ONLY code path through which OC containers receive credentials.
It enforces the access manifest: only explicitly granted credentials are fetched.

Security properties:
- OC containers never see the vault URL or know it exists
- The bridge authenticates to the vault using the Supabase service key
- Every fetch is logged in both the vault audit and oc_credential_log
- Credentials are returned as plain key=value pairs for env injection
"""

import httpx
from typing import Optional

import config
import manifest


def _vault_headers() -> dict:
    """Auth headers for vault API (service key = admin access)."""
    return {
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def _fetch_single_credential(
    vault_key: str,
    section: str = "credentials",
    service: str = None,
) -> Optional[str]:
    """Fetch a single credential value from the vault.

    Routes to the appropriate vault endpoint based on section:
    - credentials/shared: GET /vault/api/secrets/{name}?section={section}
    - services: GET /vault/api/service/{service}/secrets then extract key
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if section == "services" and service:
                # Fetch all secrets for the service, extract the specific key
                resp = await client.get(
                    f"{config.VAULT_URL}/vault/api/service/{service}/secrets",
                    headers=_vault_headers(),
                )
                if resp.status_code == 200:
                    secrets = resp.json().get("secrets", {})
                    return secrets.get(vault_key)
            else:
                # Direct secret lookup
                resp = await client.get(
                    f"{config.VAULT_URL}/vault/api/secrets/{vault_key}",
                    params={"section": section},
                    headers=_vault_headers(),
                )
                if resp.status_code == 200:
                    return resp.json().get("value")
    except httpx.ConnectError:
        raise RuntimeError("Vault unreachable — is opai-vault running?")
    except Exception as e:
        raise RuntimeError(f"Vault fetch failed for {vault_key}: {e}")

    return None


async def fetch_instance_credentials(
    instance_id: str,
    instance_slug: str,
    actor_id: str = None,
) -> dict[str, str]:
    """Fetch all granted credentials for an OC instance from the vault.

    This is the primary broker operation. It:
    1. Reads the access manifest for the instance
    2. Fetches each granted credential from the vault
    3. Logs the operation
    4. Returns a dict of {ENV_VAR_NAME: value}

    Only credentials with active, non-revoked, non-expired grants are fetched.
    """
    # Resolve what this instance is allowed to have
    grants = await manifest.resolve_credentials(instance_id)

    if not grants:
        await manifest._log_credential_action(
            instance_id=instance_id,
            instance_slug=instance_slug,
            action="inject",
            vault_keys=[],
            success=True,
            detail="No active grants — empty credential set",
            actor_id=actor_id,
        )
        return {}

    # Fetch each granted credential from the vault
    credentials = {}
    fetched_keys = []
    failed_keys = []

    for grant in grants:
        try:
            value = await _fetch_single_credential(
                vault_key=grant["vault_key"],
                section=grant["section"],
                service=grant.get("service"),
            )
            if value is not None:
                credentials[grant["vault_key"]] = value
                fetched_keys.append(grant["vault_key"])
            else:
                failed_keys.append(grant["vault_key"])
        except Exception:
            failed_keys.append(grant["vault_key"])

    # Log the injection
    all_keys = fetched_keys + failed_keys
    detail = f"Fetched {len(fetched_keys)}/{len(grants)} credentials"
    if failed_keys:
        detail += f" (failed: {', '.join(failed_keys)})"

    await manifest._log_credential_action(
        instance_id=instance_id,
        instance_slug=instance_slug,
        action="inject",
        vault_keys=all_keys,
        success=len(failed_keys) == 0,
        detail=detail,
        actor_id=actor_id,
    )

    return credentials


async def verify_vault_connection() -> dict:
    """Check that the vault is reachable and healthy."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{config.VAULT_URL}/vault/api/health")
            if resp.status_code == 200:
                return {"status": "ok", "vault": resp.json()}
            return {"status": "degraded", "code": resp.status_code}
    except httpx.ConnectError:
        return {"status": "unreachable", "error": "Cannot connect to vault"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


async def validate_vault_key_exists(
    vault_key: str,
    section: str = "credentials",
    service: str = None,
) -> bool:
    """Check if a vault key actually exists before allowing it to be granted.

    This prevents granting access to nonexistent credentials (typos, etc).
    """
    value = await _fetch_single_credential(vault_key, section, service)
    return value is not None
