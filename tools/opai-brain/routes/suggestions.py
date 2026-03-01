"""2nd Brain — Smart Suggestions engine.

Generates AI-powered similarity suggestions between brain nodes using
Claude Haiku for fast, cheap semantic matching. Caches results in
brain_suggestions table with 24h TTL.
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import timezone, datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

sys.path.insert(0, str(Path(__file__).parent.parent))
from claude_cli import call_claude
from routes.tier import get_tier_features

import config

log = logging.getLogger("brain.routes.suggestions")
router = APIRouter()

HAIKU_MODEL = "claude-haiku-4-5-20251001"
CACHE_TTL_HOURS = 24


# ── Supabase helpers (same pattern as research.py) ────────────────────────────

def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers=_svc_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, body) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else rows


async def _sb_patch(path: str, params: str, body: dict) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.patch(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else {}


async def _sb_upsert(path: str, body) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    headers = {**_svc_headers(), "Prefer": "return=representation,resolution=merge-duplicates"}
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url, headers=headers, json=body)
        r.raise_for_status()
        rows = r.json()
        return rows if isinstance(rows, list) else [rows] if rows else []


# ── Request models ────────────────────────────────────────────────────────────

class SuggestRequest(BaseModel):
    node_id: Optional[str] = None
    text: Optional[str] = None
    context: Optional[str] = None


class SuggestActionRequest(BaseModel):
    suggestion_id: str


# ── Core suggestion logic ─────────────────────────────────────────────────────

async def _generate_suggestions(user_id: str, source_id: str, source_title: str, source_content: str):
    """Call Claude Haiku to find semantically related nodes."""
    # Fetch up to 30 candidate nodes (title + first 200 chars)
    candidates = await _sb_get(
        "brain_nodes",
        f"user_id=eq.{user_id}&id=neq.{source_id}&type=neq.inbox"
        f"&select=id,title,content&limit=30&order=updated_at.desc",
    )
    if not candidates:
        return []

    # Build candidate list for the prompt
    candidate_lines = []
    for c in candidates:
        snippet = (c.get("content") or "")[:200].replace("\n", " ")
        candidate_lines.append(f'- id:"{c["id"]}" title:"{c.get("title","Untitled")}" snippet:"{snippet}"')

    source_snippet = (source_content or "")[:500].replace("\n", " ")
    candidates_block = "\n".join(candidate_lines)

    prompt = (
        "You are a knowledge graph assistant. Given a source note, rate the semantic relevance "
        "of each candidate note on a 0.0-1.0 scale. Only return candidates with score >= 0.3.\n\n"
        f"Source note:\nTitle: {source_title}\nContent: {source_snippet}\n\n"
        f"Candidates:\n{candidates_block}\n\n"
        "Return ONLY a JSON array (no markdown fences, no explanation). Each element:\n"
        '{"id":"<uuid>","score":0.85,"reason":"5 words max"}\n\n'
        "If no candidates are relevant, return an empty array: []"
    )

    try:
        raw = await call_claude(prompt, model=HAIKU_MODEL, timeout=60)
        # Extract JSON from response (handle possible markdown fences)
        text = raw.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
        results = json.loads(text)
        if not isinstance(results, list):
            return []
        return results
    except Exception as e:
        log.error("[suggestions] Claude parse error: %s", e)
        return []


async def _upsert_suggestions(user_id: str, source_id: str, results: list):
    """Upsert suggestion results into brain_suggestions, skipping accepted/dismissed."""
    if not results:
        return

    # Get existing accepted/dismissed so we don't overwrite them
    existing = await _sb_get(
        "brain_suggestions",
        f"source_id=eq.{source_id}&status=in.(accepted,dismissed)&select=target_id",
    )
    skip_ids = {e["target_id"] for e in existing}

    rows = []
    for r in results:
        tid = r.get("id")
        if not tid or tid in skip_ids:
            continue
        score = max(0.0, min(1.0, float(r.get("score", 0))))
        if score < 0.3:
            continue
        rows.append({
            "user_id": user_id,
            "source_id": source_id,
            "target_id": tid,
            "score": round(score, 2),
            "reason": (r.get("reason") or "")[:100],
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

    if rows:
        await _sb_upsert("brain_suggestions", rows)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/api/suggestions")
async def generate_suggestions(
    body: SuggestRequest,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
):
    """Generate suggestions for a node (by ID) or for raw text."""
    # Tier gate: same as AI editor
    features = get_tier_features(user.marketplace_tier, user.is_admin)
    if not features.get("ai_editor"):
        raise HTTPException(403, "Smart suggestions require a Pro or Ultimate plan")

    if body.node_id:
        # Fetch source node
        rows = await _sb_get(
            "brain_nodes",
            f"id=eq.{body.node_id}&user_id=eq.{user.id}&select=id,title,content",
        )
        if not rows:
            raise HTTPException(404, "Node not found")
        node = rows[0]

        # Check cache freshness
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=CACHE_TTL_HOURS)).isoformat()
        cached = await _sb_get(
            "brain_suggestions",
            f"source_id=eq.{body.node_id}&status=eq.pending&created_at=gte.{cutoff}"
            f"&select=id,target_id,score,reason,status,created_at&order=score.desc",
        )
        if cached:
            # Enrich with target titles
            target_ids = [s["target_id"] for s in cached]
            targets = await _sb_get(
                "brain_nodes",
                f"id=in.({','.join(target_ids)})&select=id,title,type",
            )
            target_map = {t["id"]: t for t in targets}
            for s in cached:
                t = target_map.get(s["target_id"], {})
                s["target_title"] = t.get("title", "Untitled")
                s["target_type"] = t.get("type", "note")
            return {"suggestions": cached, "cached": True}

        # Generate fresh
        results = await _generate_suggestions(
            user.id, body.node_id, node.get("title", ""), node.get("content", "")
        )
        await _upsert_suggestions(user.id, body.node_id, results)

        # Fetch and return the newly created suggestions
        fresh = await _sb_get(
            "brain_suggestions",
            f"source_id=eq.{body.node_id}&status=eq.pending"
            f"&select=id,target_id,score,reason,status,created_at&order=score.desc",
        )
        target_ids = [s["target_id"] for s in fresh]
        if target_ids:
            targets = await _sb_get(
                "brain_nodes",
                f"id=in.({','.join(target_ids)})&select=id,title,type",
            )
            target_map = {t["id"]: t for t in targets}
            for s in fresh:
                t = target_map.get(s["target_id"], {})
                s["target_title"] = t.get("title", "Untitled")
                s["target_type"] = t.get("type", "note")

        return {"suggestions": fresh, "cached": False}

    elif body.text:
        # Text-based suggestions (for inbox items / research)
        title = (body.context or body.text[:60]).strip()
        results = await _generate_suggestions(user.id, "", title, body.text)
        # Return inline (no caching for text-based)
        enriched = []
        if results:
            target_ids = [r["id"] for r in results if r.get("id")]
            if target_ids:
                targets = await _sb_get(
                    "brain_nodes",
                    f"id=in.({','.join(target_ids)})&select=id,title,type",
                )
                target_map = {t["id"]: t for t in targets}
                for r in results:
                    t = target_map.get(r.get("id"), {})
                    if t:
                        enriched.append({
                            "target_id": r["id"],
                            "target_title": t.get("title", "Untitled"),
                            "target_type": t.get("type", "note"),
                            "score": r.get("score", 0),
                            "reason": r.get("reason", ""),
                        })
        return {"suggestions": enriched, "cached": False}

    else:
        raise HTTPException(400, "Provide node_id or text")


@router.get("/api/suggestions/for/{node_id}")
async def get_suggestions_for_node(
    node_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Get cached suggestions for a specific node."""
    rows = await _sb_get(
        "brain_suggestions",
        f"source_id=eq.{node_id}&user_id=eq.{user.id}&status=eq.pending"
        f"&select=id,target_id,score,reason,status,created_at&order=score.desc",
    )
    if rows:
        target_ids = [s["target_id"] for s in rows]
        targets = await _sb_get(
            "brain_nodes",
            f"id=in.({','.join(target_ids)})&select=id,title,type",
        )
        target_map = {t["id"]: t for t in targets}
        for s in rows:
            t = target_map.get(s["target_id"], {})
            s["target_title"] = t.get("title", "Untitled")
            s["target_type"] = t.get("type", "note")

    return {"suggestions": rows}


@router.get("/api/suggestions/pending")
async def get_all_pending(
    user: AuthUser = Depends(get_current_user),
):
    """Get all pending suggestions for the current user (for graph overlay)."""
    rows = await _sb_get(
        "brain_suggestions",
        f"user_id=eq.{user.id}&status=eq.pending"
        f"&select=id,source_id,target_id,score,reason&order=score.desc&limit=100",
    )
    return {"suggestions": rows}


@router.post("/api/suggestions/accept")
async def accept_suggestion(
    body: SuggestActionRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Accept a suggestion — creates a brain_links row and marks as accepted."""
    # Fetch the suggestion
    rows = await _sb_get(
        "brain_suggestions",
        f"id=eq.{body.suggestion_id}&user_id=eq.{user.id}&select=*",
    )
    if not rows:
        raise HTTPException(404, "Suggestion not found")
    sug = rows[0]

    if sug["status"] != "pending":
        raise HTTPException(400, f"Suggestion already {sug['status']}")

    # Create brain_links row
    try:
        await _sb_post("brain_links", {
            "source_id": sug["source_id"],
            "target_id": sug["target_id"],
            "link_type": "suggested",
            "strength": sug["score"],
            "label": sug.get("reason") or "AI suggested",
            "created_by": "suggestion",
        })
    except Exception as e:
        # Link may already exist
        log.warning("[suggestions] Link create failed (may exist): %s", e)

    # Mark suggestion as accepted
    await _sb_patch(
        "brain_suggestions",
        f"id=eq.{body.suggestion_id}",
        {"status": "accepted"},
    )
    return {"accepted": body.suggestion_id}


@router.post("/api/suggestions/dismiss")
async def dismiss_suggestion(
    body: SuggestActionRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Dismiss a suggestion."""
    rows = await _sb_get(
        "brain_suggestions",
        f"id=eq.{body.suggestion_id}&user_id=eq.{user.id}&select=id",
    )
    if not rows:
        raise HTTPException(404, "Suggestion not found")

    await _sb_patch(
        "brain_suggestions",
        f"id=eq.{body.suggestion_id}",
        {"status": "dismissed"},
    )
    return {"dismissed": body.suggestion_id}
