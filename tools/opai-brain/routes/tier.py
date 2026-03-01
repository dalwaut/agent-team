"""2nd Brain — Tier/me route (Phase 5).

GET /api/me  → returns current user tier, features enabled, research usage this month.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from datetime import timezone, datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config

log = logging.getLogger("brain.routes.tier")
router = APIRouter()

# ── Tier definitions ───────────────────────────────────────────────────────────
# admin: all features, unlimited
# pro / ultimate: Library + Inbox + AI co-editor + Research (20/mo)
# starter / '': Library + Inbox only

TIER_FEATURES: dict[str, dict] = {
    "admin":    {"ai_editor": True,  "research": True,  "research_quota": -1},
    "ultimate": {"ai_editor": True,  "research": True,  "research_quota": 20},
    "pro":      {"ai_editor": True,  "research": True,  "research_quota": 20},
    "starter":  {"ai_editor": False, "research": False, "research_quota": 0},
    "":         {"ai_editor": False, "research": False, "research_quota": 0},
}


def get_tier_features(tier: str, is_admin: bool) -> dict:
    key = "admin" if is_admin else (tier or "")
    return TIER_FEATURES.get(key, TIER_FEATURES[""])


def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
    }


async def get_research_usage_this_month(user_id: str) -> int:
    """Count research sessions created in the current calendar month."""
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    url = (
        f"{config.SUPABASE_URL}/rest/v1/brain_research"
        f"?user_id=eq.{user_id}&created_at=gte.{month_start}&select=id"
    )
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(url, headers=_svc_headers())
            if r.status_code == 200:
                return len(r.json())
    except Exception:
        pass
    return 0


@router.get("/api/me")
async def get_me(user: AuthUser = Depends(get_current_user)):
    """Return current user info, tier, enabled features, and research quota usage."""
    features = get_tier_features(user.marketplace_tier, user.is_admin)
    research_used = 0
    if features["research"] or user.is_admin:
        research_used = await get_research_usage_this_month(user.id)

    return {
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "role": user.role,
        "marketplace_tier": user.marketplace_tier,
        "features": {
            "ai_editor": features["ai_editor"],
            "research": features["research"],
        },
        "research_quota": features["research_quota"],   # -1 = unlimited
        "research_used": research_used,
    }
