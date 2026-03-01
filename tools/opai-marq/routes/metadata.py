"""Marq — Metadata management routes. Phase 2: CRUD. Phase 3: AI generation."""

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
from routes.apps import check_access

log = logging.getLogger("marq.routes.metadata")
router = APIRouter()


class MetadataCreate(BaseModel):
    version: str
    locale: str = "en-US"
    store: str = "apple"
    app_name: Optional[str] = None
    subtitle: Optional[str] = None
    short_description: Optional[str] = None
    full_description: Optional[str] = None
    keywords: Optional[str] = None
    whats_new: Optional[str] = None
    privacy_policy_url: Optional[str] = None
    support_url: Optional[str] = None


class MetadataUpdate(BaseModel):
    version: Optional[str] = None
    locale: Optional[str] = None
    store: Optional[str] = None
    app_name: Optional[str] = None
    subtitle: Optional[str] = None
    short_description: Optional[str] = None
    full_description: Optional[str] = None
    keywords: Optional[str] = None
    whats_new: Optional[str] = None
    privacy_policy_url: Optional[str] = None
    support_url: Optional[str] = None
    status: Optional[str] = None


@router.get("/api/apps/{app_id}/metadata")
async def list_metadata(app_id: str, user: AuthUser = Depends(get_current_user)):
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")
    return await _sb_get(
        f"mrq_metadata?app_id=eq.{app_id}&order=created_at.desc&select=*"
    )


@router.post("/api/apps/{app_id}/metadata")
async def create_metadata(app_id: str, body: MetadataCreate, user: AuthUser = Depends(get_current_user)):
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    payload = body.model_dump(exclude_none=True)
    store = payload.get("store", "apple")
    locale = payload.get("locale", "en-US")
    version = payload.get("version", "1.0.0")

    # Check for existing row with same (app_id, version, locale, store)
    existing = await _sb_get(
        f"mrq_metadata?app_id=eq.{app_id}&version=eq.{version}&locale=eq.{locale}&store=eq.{store}&select=id"
    )
    if existing:
        # Update the existing row instead of inserting a duplicate
        meta_id = existing[0]["id"]
        result = await _sb_patch(f"mrq_metadata?id=eq.{meta_id}", payload)
        return result[0] if isinstance(result, list) and result else result

    payload["app_id"] = app_id
    result = await _sb_post("mrq_metadata", payload)
    return result[0] if isinstance(result, list) else result


@router.patch("/api/metadata/{metadata_id}")
async def update_metadata(metadata_id: str, body: MetadataUpdate, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get(f"mrq_metadata?id=eq.{metadata_id}&select=app_id")
    if not rows:
        raise HTTPException(404, "Metadata not found")
    if not await check_access(user, rows[0]["app_id"]):
        raise HTTPException(403, "Access denied")

    payload = body.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(400, "No fields to update")

    result = await _sb_patch(f"mrq_metadata?id=eq.{metadata_id}", payload)
    return result[0] if isinstance(result, list) and result else result


@router.delete("/api/metadata/{metadata_id}")
async def delete_metadata(metadata_id: str, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get(f"mrq_metadata?id=eq.{metadata_id}&select=app_id")
    if not rows:
        raise HTTPException(404, "Metadata not found")
    if not await check_access(user, rows[0]["app_id"]):
        raise HTTPException(403, "Access denied")

    await _sb_delete(f"mrq_metadata?id=eq.{metadata_id}")
    return {"ok": True}


@router.post("/api/apps/{app_id}/generate-metadata")
async def generate_metadata_from_docs(
    app_id: str,
    store: str = "apple",
    locale: str = "en-US",
    doc_folder: str = None,
    user: AuthUser = Depends(get_current_user),
):
    """Generate store listing metadata from project docs using AI.

    Returns a draft metadata dict (not saved — user reviews and saves manually).
    """
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
    if not apps:
        raise HTTPException(404, "App not found")

    app = apps[0]

    from core.metadata_builder import generate_metadata
    draft = await generate_metadata(app, store=store, locale=locale, doc_folder_override=doc_folder)

    if draft.get("_error"):
        return {"ok": False, "error": draft["_error"], "draft": draft}

    return {"ok": True, "draft": draft}
