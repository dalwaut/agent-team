"""DAM Bot — Skill Manager (Phase 3 stub with basic CRUD)."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from core.supabase import sb_get, sb_post, sb_patch

log = logging.getLogger("dam.skills")


async def list_skills(verified_only: bool = False) -> list:
    """List all skills, optionally filtered to verified only."""
    query = "dam_skills?select=*&order=usage_count.desc"
    if verified_only:
        query += "&is_verified=eq.true"
    return await sb_get(query)


async def get_skill(skill_id: str) -> dict | None:
    rows = await sb_get(f"dam_skills?id=eq.{skill_id}&select=*")
    return rows[0] if rows else None


async def search_skills(query: str) -> list:
    """Search skills by name or tags."""
    return await sb_get(
        f"dam_skills?or=(name.ilike.*{query}*,description.ilike.*{query}*)&select=*&limit=20"
    )


async def record_skill_run(skill_id: str, session_id: str | None, step_id: str | None,
                            status: str, duration_ms: int, result: dict | None = None) -> dict:
    """Record a skill execution."""
    row = await sb_post("dam_skill_runs", {
        "skill_id": skill_id,
        "session_id": session_id,
        "step_id": step_id,
        "status": status,
        "duration_ms": duration_ms,
        "result": result,
    })

    # Update usage stats on the skill
    skill = await get_skill(skill_id)
    if skill:
        new_count = skill["usage_count"] + 1
        successes = int(skill["success_rate"] * skill["usage_count"])
        if status == "completed":
            successes += 1
        new_rate = successes / new_count if new_count > 0 else 0

        await sb_patch(f"dam_skills?id=eq.{skill_id}", {
            "usage_count": new_count,
            "success_rate": round(new_rate, 4),
        })

    return row[0] if isinstance(row, list) else row
