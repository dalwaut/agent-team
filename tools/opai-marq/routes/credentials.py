"""Marq — Store credential vault routes."""

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
from routes.apps import check_access

log = logging.getLogger("marq.routes.credentials")
router = APIRouter()


class CredentialCreate(BaseModel):
    store: str  # apple / google
    credential_type: str  # api_key / service_account / p8_key
    credential_data: dict  # The actual secret data to encrypt
    issuer_id: Optional[str] = None
    key_id: Optional[str] = None


@router.get("/api/apps/{app_id}/credentials")
async def list_credentials(app_id: str, user: AuthUser = Depends(get_current_user)):
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")
    return await _sb_get(
        f"mrq_store_credentials?app_id=eq.{app_id}&select=id,app_id,store,credential_type,issuer_id,key_id,is_active,last_verified_at,created_at"
    )


@router.post("/api/apps/{app_id}/credentials")
async def create_credential(app_id: str, body: CredentialCreate, user: AuthUser = Depends(get_current_user)):
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    # Encrypt and store
    vault_key = store_credential(app_id, body.store, body.credential_data)

    payload = {
        "app_id": app_id,
        "store": body.store,
        "credential_type": body.credential_type,
        "vault_key": vault_key,
    }
    if body.issuer_id:
        payload["issuer_id"] = body.issuer_id
    if body.key_id:
        payload["key_id"] = body.key_id

    result = await _sb_post("mrq_store_credentials", payload)
    cred = result[0] if isinstance(result, list) else result

    # Don't return vault_key to client
    cred.pop("vault_key", None)
    return cred


@router.delete("/api/credentials/{cred_id}")
async def remove_credential(cred_id: str, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get(f"mrq_store_credentials?id=eq.{cred_id}&select=app_id,vault_key")
    if not rows:
        raise HTTPException(404, "Credential not found")
    if not await check_access(user, rows[0]["app_id"]):
        raise HTTPException(403, "Access denied")

    # Delete encrypted file
    delete_credential(rows[0]["vault_key"])
    # Delete DB record
    await _sb_delete(f"mrq_store_credentials?id=eq.{cred_id}")
    return {"ok": True}
