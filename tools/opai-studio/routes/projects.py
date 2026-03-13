"""OPAI Studio â Project routes."""
from __future__ import annotations
import logging
import sys
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

from core.supabase import sb_get, sb_post, sb_patch, sb_delete

log = logging.getLogger("studio.routes.projects")
router = APIRouter()


class ProjectCreate(BaseModel):
    name: str = "Untitled Project"
    description: str = ""

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None


@router.get("/api/projects")
async def list_projects(
    limit: int = Query(20, le=100),
    offset: int = Query(0, ge=0),
    user: AuthUser = Depends(get_current_user),
):
    rows = await sb_get(
        f"studio_projects?user_id=eq.{user.id}&order=updated_at.desc&limit={limit}&offset={offset}"
    )
    return rows


@router.post("/api/projects")
async def create_project(body: ProjectCreate, user: AuthUser = Depends(get_current_user)):
    row = await sb_post("studio_projects", {
        "user_id": user.id,
        "name": body.name,
        "description": body.description,
    })
    return row


@router.get("/api/projects/{project_id}")
async def get_project(project_id: str, user: AuthUser = Depends(get_current_user)):
    rows = await sb_get(f"studio_projects?id=eq.{project_id}&user_id=eq.{user.id}")
    if not rows:
        raise HTTPException(404, "Project not found")
    return rows[0]


@router.patch("/api/projects/{project_id}")
async def update_project(project_id: str, body: ProjectUpdate, user: AuthUser = Depends(get_current_user)):
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    if not data:
        raise HTTPException(400, "No fields to update")
    row = await sb_patch(f"studio_projects?id=eq.{project_id}&user_id=eq.{user.id}", data)
    return row


@router.delete("/api/projects/{project_id}")
async def delete_project(project_id: str, user: AuthUser = Depends(get_current_user)):
    await sb_delete(f"studio_projects?id=eq.{project_id}&user_id=eq.{user.id}")
    return {"ok": True}


@router.get("/api/projects/{project_id}/images")
async def list_project_images(
    project_id: str,
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    user: AuthUser = Depends(get_current_user),
):
    # Verify project ownership
    projects = await sb_get(f"studio_projects?id=eq.{project_id}&user_id=eq.{user.id}&select=id")
    if not projects:
        raise HTTPException(404, "Project not found")
    rows = await sb_get(
        f"studio_images?project_id=eq.{project_id}&select=id,name,width,height,preset_id,thumbnail_key,source_type,version_count,updated_at&order=updated_at.desc&limit={limit}&offset={offset}"
    )
    return rows
