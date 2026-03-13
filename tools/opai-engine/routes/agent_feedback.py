"""OPAI Engine — Agent Feedback Loop endpoints.

Stores and retrieves learned insights from agent runs so future runs
start with accumulated knowledge instead of cold. Separate from
routes/feedback.py which handles UI user feedback.
"""

from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request

import config
from auth import require_admin

router = APIRouter(prefix="/api")


async def _admin_or_local(
    request: Request,
    authorization: str | None = Header(None),
):
    """Allow admin auth OR unauthenticated localhost requests (for post_squad_hook)."""
    client = request.client
    if client and client.host in ("127.0.0.1", "::1"):
        return  # local caller — trusted
    # Not local — require full admin auth
    from auth import get_current_user
    user = await get_current_user(authorization)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

# ── Supabase helpers ────────────────────────────────────────────

_TABLE = "engine_agent_feedback"


def _sb_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(path: str = "") -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{_TABLE}{path}"


async def _sb_get(params: dict) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(_sb_url(), headers=_sb_headers(), params=params)
        resp.raise_for_status()
        return resp.json()


async def _sb_post(data: dict) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_sb_url(), headers=_sb_headers(), json=data)
        resp.raise_for_status()
        result = resp.json()
        return result[0] if isinstance(result, list) else result


async def _sb_patch(row_id: str, data: dict) -> dict:
    params = {"id": f"eq.{row_id}"}
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _sb_url(), headers=_sb_headers(), params=params, json=data,
        )
        resp.raise_for_status()
        result = resp.json()
        return result[0] if isinstance(result, list) and result else {}


# ── Endpoints ───────────────────────────────────────────────────


@router.get("/agent-feedback")
async def list_agent_feedback(
    role: Optional[str] = Query(None),
    domain: Optional[str] = Query(None),
    type: Optional[str] = Query(None, alias="type"),
    active: Optional[bool] = Query(None),
    limit: int = Query(50, le=200),
):
    """List feedback items, filterable by role/domain/type/active."""
    params: dict = {
        "order": "confidence.desc,created_at.desc",
        "limit": str(limit),
    }
    if role:
        params["agent_role"] = f"eq.{role}"
    if domain:
        params["domain"] = f"eq.{domain}"
    if type:
        params["feedback_type"] = f"eq.{type}"
    if active is not None:
        params["active"] = f"eq.{str(active).lower()}"

    try:
        items = await _sb_get(params)
        return {"items": items, "count": len(items)}
    except Exception as e:
        raise HTTPException(502, f"Supabase query failed: {e}")


@router.post("/agent-feedback", dependencies=[Depends(_admin_or_local)])
async def create_agent_feedback(data: dict = Body(...)):
    """Create a new feedback item."""
    required = {"agent_role", "feedback_type", "content"}
    missing = required - set(data.keys())
    if missing:
        raise HTTPException(400, f"Missing fields: {', '.join(missing)}")

    allowed_types = {"retrieval_hint", "missing_context", "correction"}
    if data["feedback_type"] not in allowed_types:
        raise HTTPException(400, f"feedback_type must be one of: {allowed_types}")

    row = {
        "agent_role": data["agent_role"],
        "domain": data.get("domain"),
        "feedback_type": data["feedback_type"],
        "content": data["content"],
        "source_run": data.get("source_run"),
        "confidence": data.get("confidence", 0.5),
    }

    try:
        result = await _sb_post(row)
        return {"success": True, "item": result}
    except Exception as e:
        raise HTTPException(502, f"Supabase insert failed: {e}")


@router.patch("/agent-feedback/{item_id}/reinforce", dependencies=[Depends(_admin_or_local)])
async def reinforce_feedback(item_id: str):
    """Increment success_count and boost confidence (capped at 1.0)."""
    try:
        # Fetch current values
        items = await _sb_get({"id": f"eq.{item_id}", "limit": "1"})
        if not items:
            raise HTTPException(404, "Feedback item not found")

        current = items[0]
        new_success = current.get("success_count", 0) + 1
        new_confidence = min(1.0, current.get("confidence", 0.5) + 0.05)

        result = await _sb_patch(item_id, {
            "success_count": new_success,
            "confidence": round(new_confidence, 3),
            "use_count": current.get("use_count", 0) + 1,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        return {"success": True, "item": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Supabase update failed: {e}")


@router.patch("/agent-feedback/{item_id}/deactivate", dependencies=[Depends(_admin_or_local)])
async def deactivate_feedback(item_id: str):
    """Set active=false on a feedback item."""
    try:
        result = await _sb_patch(item_id, {
            "active": False,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        return {"success": True, "item": result}
    except Exception as e:
        raise HTTPException(502, f"Supabase update failed: {e}")


@router.get("/agent-feedback/stats")
async def feedback_stats():
    """Summary stats: total, by type, avg confidence."""
    try:
        all_items = await _sb_get({"active": "eq.true", "limit": "1000"})

        by_type: dict[str, int] = {}
        total_confidence = 0.0
        for item in all_items:
            ft = item.get("feedback_type", "unknown")
            by_type[ft] = by_type.get(ft, 0) + 1
            total_confidence += item.get("confidence", 0)

        total = len(all_items)
        return {
            "total_active": total,
            "by_type": by_type,
            "avg_confidence": round(total_confidence / total, 3) if total else 0,
        }
    except Exception as e:
        raise HTTPException(502, f"Supabase query failed: {e}")


@router.get("/agent-feedback/gaps")
async def feedback_gaps():
    """All active missing_context items — knowledge gaps to fill."""
    try:
        items = await _sb_get({
            "feedback_type": "eq.missing_context",
            "active": "eq.true",
            "order": "confidence.desc,created_at.desc",
            "limit": "100",
        })
        return {"gaps": items, "count": len(items)}
    except Exception as e:
        raise HTTPException(502, f"Supabase query failed: {e}")
