"""Marq — App CRUD routes."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from slugify import slugify

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user, require_admin

from core.supabase import _sb_get, _sb_post, _sb_patch, _sb_delete, _sb_rpc

log = logging.getLogger("marq.routes.apps")
router = APIRouter()

ADMIN_ROOT = Path("/workspace/synced/opai")
DEFAULT_START = "Projects"


# -- Access check --

async def check_access(user: AuthUser, app_id: str) -> bool:
    """Check if user has access to an app (via mrq_app_access or admin)."""
    if user.is_admin:
        return True
    rows = await _sb_get(
        f"mrq_app_access?app_id=eq.{app_id}&user_id=eq.{user.id}&select=id"
    )
    return bool(rows)


# -- Request models --

class AppCreate(BaseModel):
    name: str
    platform: str = "both"
    bundle_id_ios: Optional[str] = None
    package_name_android: Optional[str] = None
    project_path: Optional[str] = None
    doc_folder: Optional[str] = None
    privacy_policy_url: Optional[str] = None
    support_url: Optional[str] = None


class AppUpdate(BaseModel):
    name: Optional[str] = None
    platform: Optional[str] = None
    bundle_id_ios: Optional[str] = None
    package_name_android: Optional[str] = None
    current_version: Optional[str] = None
    project_path: Optional[str] = None
    doc_folder: Optional[str] = None
    privacy_policy_url: Optional[str] = None
    support_url: Optional[str] = None
    status: Optional[str] = None
    icon_storage_key: Optional[str] = None


# -- Endpoints --

@router.get("/api/apps")
async def list_apps(user: AuthUser = Depends(get_current_user)):
    """List apps the current user has access to."""
    if user.is_admin:
        return await _sb_get("mrq_apps?order=name.asc&select=*")

    access_rows = await _sb_get(
        f"mrq_app_access?user_id=eq.{user.id}&select=app_id"
    )
    if not access_rows:
        return []

    ids = ",".join(r["app_id"] for r in access_rows)
    return await _sb_get(f"mrq_apps?id=in.({ids})&order=name.asc&select=*")


@router.get("/api/apps/{app_id}")
async def get_app(app_id: str, user: AuthUser = Depends(get_current_user)):
    """Get a single app with latest submission info."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
    if not rows:
        raise HTTPException(404, "App not found")

    app = rows[0]

    # Attach latest submission per store
    subs = await _sb_get(
        f"mrq_submissions?app_id=eq.{app_id}&order=created_at.desc&limit=5&select=*"
    )
    app["recent_submissions"] = subs

    return app


@router.post("/api/apps")
async def create_app(body: AppCreate, user: AuthUser = Depends(get_current_user)):
    """Create a new app. Auto-generates slug from name."""
    slug = slugify(body.name)

    payload = {
        "name": body.name,
        "slug": slug,
        "platform": body.platform,
        "owner_id": user.id,
    }
    if body.bundle_id_ios:
        payload["bundle_id_ios"] = body.bundle_id_ios
    if body.package_name_android:
        payload["package_name_android"] = body.package_name_android
    if body.project_path:
        payload["project_path"] = body.project_path
    if body.doc_folder:
        payload["doc_folder"] = body.doc_folder
    if body.privacy_policy_url:
        payload["privacy_policy_url"] = body.privacy_policy_url
    if body.support_url:
        payload["support_url"] = body.support_url

    result = await _sb_post("mrq_apps", payload)
    app = result[0] if isinstance(result, list) else result
    app_id = app.get("id")

    if app_id:
        # Auto-create owner access
        await _sb_post("mrq_app_access", {
            "app_id": app_id,
            "user_id": user.id,
            "role": "owner",
            "granted_by": user.id,
        })
        # Seed default schedule
        try:
            await _sb_rpc("mrq_seed_default_schedule", {"p_app_id": app_id})
        except Exception:
            log.warning("Failed to seed schedule for app %s", app_id)

    return app


@router.patch("/api/apps/{app_id}")
async def update_app(app_id: str, body: AppUpdate, user: AuthUser = Depends(get_current_user)):
    """Update an app."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    payload = body.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(400, "No fields to update")

    result = await _sb_patch(f"mrq_apps?id=eq.{app_id}", payload)
    return result[0] if isinstance(result, list) and result else result


@router.delete("/api/apps/{app_id}")
async def delete_app(app_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete an app (owner only)."""
    if not user.is_admin:
        access = await _sb_get(
            f"mrq_app_access?app_id=eq.{app_id}&user_id=eq.{user.id}&role=eq.owner&select=id"
        )
        if not access:
            raise HTTPException(403, "Only owners can delete apps")

    await _sb_delete(f"mrq_apps?id=eq.{app_id}")
    return {"ok": True}


@router.get("/api/apps/{app_id}/submissions")
async def list_submissions(app_id: str, user: AuthUser = Depends(get_current_user)):
    """List all submissions for an app."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    return await _sb_get(
        f"mrq_submissions?app_id=eq.{app_id}&order=created_at.desc&select=*"
    )


@router.get("/api/apps/{app_id}/audit")
async def list_audit(app_id: str, limit: int = 50, user: AuthUser = Depends(get_current_user)):
    """List audit log for an app."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    return await _sb_get(
        f"mrq_audit_log?app_id=eq.{app_id}&order=created_at.desc&limit={limit}&select=*"
    )


@router.post("/api/apps/{app_id}/setup-teamhub")
async def setup_teamhub_workspace(app_id: str, user: AuthUser = Depends(get_current_user)):
    """Create TeamHub folder structure for an app.

    Creates: Folder "Marq: {name}" with Submissions, Store Issues, Reviews lists.
    """
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
    if not apps:
        raise HTTPException(404, "App not found")

    from core.teamhub import ensure_app_workspace
    result = await ensure_app_workspace(apps[0])

    if not result:
        raise HTTPException(500, "Failed to create TeamHub workspace")

    return {"ok": True, **result}


@router.get("/api/apps/{app_id}/task-relays")
async def list_task_relays(app_id: str, user: AuthUser = Depends(get_current_user)):
    """List all task relay records for an app (rejection → TeamHub task mappings)."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    return await _sb_get(
        f"mrq_tasks_relay?app_id=eq.{app_id}&order=created_at.desc&select=*"
    )


# -- File browser --

def _get_user_root(user: AuthUser) -> Path:
    """Get filesystem root for user. Admin = workspace root, others = sandbox."""
    if user.is_admin:
        return ADMIN_ROOT
    if not user.sandbox_path:
        raise HTTPException(403, "No file access configured for your account")
    root = Path(user.sandbox_path)
    if not root.is_dir():
        raise HTTPException(503, "File storage not available")
    return root


def _resolve_safe(user_root: Path, relative_path: str) -> Path:
    """Resolve relative path within user root. Blocks traversal."""
    clean = relative_path.lstrip("/").lstrip("\\")
    if not clean or clean == ".":
        return user_root
    target = (user_root / clean).resolve()
    root_resolved = user_root.resolve()
    if not (target == root_resolved or str(target).startswith(str(root_resolved) + os.sep)):
        raise HTTPException(403, "Access denied")
    return target


@router.get("/api/browse")
async def browse_files(
    path: str = "",
    mode: str = "dirs",
    user: AuthUser = Depends(get_current_user),
):
    """Browse files/folders within user's root.

    Args:
        path: Relative path within user root (default: starts at Projects/)
        mode: 'dirs' = directories only, 'all' = dirs + files
    """
    root = _get_user_root(user)

    # Default starting path: Projects/
    if not path:
        default_start = root / DEFAULT_START
        if default_start.is_dir():
            path = DEFAULT_START
        else:
            path = ""

    target = _resolve_safe(root, path)
    if not target.is_dir():
        raise HTTPException(404, "Directory not found")

    items = []
    try:
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.name.startswith("."):
                continue
            is_dir = entry.is_dir()
            if mode == "dirs" and not is_dir:
                continue
            try:
                stat = entry.stat()
                rel = str(entry.relative_to(root))
                items.append({
                    "name": entry.name,
                    "path": rel,
                    "is_dir": is_dir,
                    "size": 0 if is_dir else stat.st_size,
                    "modified": stat.st_mtime,
                })
            except (PermissionError, OSError):
                continue
    except PermissionError:
        raise HTTPException(403, "Permission denied")

    # Relative path from root for breadcrumb
    rel_path = str(target.relative_to(root)) if target != root else ""

    # Can go up? Only if not at root
    parent = None
    if rel_path:
        parent_path = str(Path(rel_path).parent)
        parent = "" if parent_path == "." else parent_path

    return {
        "path": rel_path,
        "parent": parent,
        "items": items,
        "total": len(items),
    }
