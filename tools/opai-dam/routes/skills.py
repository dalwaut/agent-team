"""DAM Bot — Skills library routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from core.supabase import sb_get, sb_post, sb_patch
from core.skill_manager import list_skills, get_skill, search_skills

router = APIRouter(prefix="/api/skills")


@router.get("")
async def get_skills(verified_only: bool = False, q: str | None = None):
    """List or search skills."""
    if q:
        rows = await search_skills(q)
    else:
        rows = await list_skills(verified_only=verified_only)
    return {"skills": rows}


@router.get("/{skill_id}")
async def get_skill_detail(skill_id: str):
    skill = await get_skill(skill_id)
    if not skill:
        raise HTTPException(404, "Skill not found")
    return skill


@router.post("")
async def create_skill(request: Request):
    """Create a new skill (admin only)."""
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "name is required")

    row = await sb_post("dam_skills", {
        "name": name,
        "description": body.get("description", ""),
        "skill_type": body.get("skill_type", "prompt"),
        "definition": body.get("definition", {}),
        "tags": body.get("tags", []),
        "is_verified": body.get("is_verified", False),
    })
    return row[0] if isinstance(row, list) else row
