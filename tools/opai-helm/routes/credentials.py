"""HELM — Credential management routes (no secret values exposed)."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

from core.supabase import _sb_get, _sb_post, _sb_patch, _sb_delete
from core.vault import store_credential, delete_credential

log = logging.getLogger("helm.routes.credentials")
router = APIRouter()


# -- Access check --

async def _check_access(user: AuthUser, business_id: str) -> bool:
    if user.is_admin:
        return True
    rows = await _sb_get(
        f"helm_business_access?business_id=eq.{business_id}&user_id=eq.{user.id}&select=id"
    )
    return bool(rows)


# -- Request models --

class CredentialCreate(BaseModel):
    service: str
    label: str
    data: dict  # The actual credential data (stored encrypted in vault)


# -- Endpoints --

@router.get("/api/businesses/{business_id}/credentials")
async def list_credentials(
    business_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """List credential refs (no secret values). Shows service, label, status."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        f"helm_business_credential_refs?business_id=eq.{business_id}"
        f"&order=created_at.desc&select=id,business_id,service,label,status,expires_at,created_at"
    )
    return rows


@router.post("/api/businesses/{business_id}/credentials")
async def create_credential(
    business_id: str,
    body: CredentialCreate,
    user: AuthUser = Depends(get_current_user),
):
    """Store new credential: encrypts to vault, saves ref to DB."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    # Store encrypted in vault
    vault_key = store_credential(business_id, body.service, body.data)

    # Save reference in DB (no secrets)
    ref = await _sb_post("helm_business_credential_refs", {
        "business_id": business_id,
        "service": body.service,
        "label": body.label,
        "vault_key": vault_key,
        "is_active": True,
    }, upsert=True, on_conflict="vault_key")

    result = ref[0] if isinstance(ref, list) else ref

    # Return without vault_key
    return {
        "id": result.get("id"),
        "service": result.get("service"),
        "label": result.get("label"),
        "status": result.get("status"),
        "created_at": result.get("created_at"),
    }


@router.delete("/api/businesses/{business_id}/credentials/{cred_id}")
async def remove_credential(
    business_id: str,
    cred_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Remove credential from vault and DB."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    # Get the vault key before deleting
    rows = await _sb_get(
        f"helm_business_credential_refs?id=eq.{cred_id}&business_id=eq.{business_id}&select=vault_key"
    )
    if not rows:
        raise HTTPException(404, "Credential not found")

    vault_key = rows[0].get("vault_key")
    if vault_key:
        delete_credential(vault_key)

    await _sb_delete(
        f"helm_business_credential_refs?id=eq.{cred_id}&business_id=eq.{business_id}"
    )

    return {"deleted": True}


@router.post("/api/businesses/{business_id}/credentials/{cred_id}/verify")
async def verify_credential(
    business_id: str,
    cred_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Verify credential (placeholder -- per-service verification added later)."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        f"helm_business_credential_refs?id=eq.{cred_id}&business_id=eq.{business_id}&select=id"
    )
    if not rows:
        raise HTTPException(404, "Credential not found")

    return {"status": "pending"}
