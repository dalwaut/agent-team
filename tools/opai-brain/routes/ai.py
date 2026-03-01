"""2nd Brain — AI co-editor routes (Phase 2)."""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

sys.path.insert(0, str(Path(__file__).parent.parent))
from claude_cli import call_claude

import config

log = logging.getLogger("brain.routes.ai")
router = APIRouter()

_ACTIONS = {"expand", "summarize", "rewrite", "extract_tasks", "find_related"}


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


class AIActionRequest(BaseModel):
    action: str
    selection: Optional[str] = None  # highlighted text; falls back to full content


@router.post("/api/nodes/{node_id}/ai")
async def ai_action(
    node_id: str,
    body: AIActionRequest,
    user: AuthUser = Depends(get_current_user),
):
    """
    Run an AI co-editor action on a node.
    action: expand | summarize | rewrite | extract_tasks | find_related
    """
    if body.action not in _ACTIONS:
        raise HTTPException(400, f"Unknown action '{body.action}'. Must be one of: {', '.join(_ACTIONS)}")

    # Tier gate: AI co-editor requires pro, ultimate, or admin
    if not user.is_admin and user.marketplace_tier not in ("pro", "ultimate"):
        raise HTTPException(403, "AI co-editor requires a Pro or Ultimate plan")

    # Fetch node
    rows = await _sb_get("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}&select=id,title,content,type")
    if not rows:
        raise HTTPException(404, "Node not found")
    node = rows[0]

    target = body.selection or node.get("content", "")
    if not target.strip():
        raise HTTPException(400, "No content to act on")

    if body.action == "expand":
        prompt = (
            f"You are an expert writing assistant helping expand ideas in a knowledge base.\n\n"
            f"Note title: {node.get('title', 'Untitled')}\n\n"
            f"Expand the following text with more depth, examples, and detail. "
            f"Preserve the tone. Return only the expanded text in Markdown, no preamble.\n\n"
            f"---\n{target}\n---"
        )

    elif body.action == "summarize":
        prompt = (
            f"Summarize the following note concisely in 2–4 bullet points. "
            f"Return only the bullet points in Markdown, no preamble.\n\n"
            f"---\n{target}\n---"
        )

    elif body.action == "rewrite":
        prompt = (
            f"Rewrite the following text to be clearer, more concise, and better structured. "
            f"Preserve the original meaning and tone. Return only the rewritten text in Markdown, no preamble.\n\n"
            f"---\n{target}\n---"
        )

    elif body.action == "extract_tasks":
        prompt = (
            f"Extract all action items, to-dos, and tasks from the following text. "
            f"Return them as a Markdown checklist (e.g., `- [ ] Task`). "
            f"If no tasks are found, return `- [ ] No clear action items found.`\n\n"
            f"---\n{target}\n---"
        )

    elif body.action == "find_related":
        # Fetch titles of other nodes for context
        other_rows = await _sb_get(
            "brain_nodes",
            f"user_id=eq.{user.id}&id=neq.{node_id}&select=id,title,type&limit=50&order=updated_at.desc",
        )
        if not other_rows:
            return {"action": "find_related", "result": "", "related_ids": [], "related_nodes": []}

        node_list = "\n".join(
            f"- id:{r['id']} | {r.get('type','note')} | {r.get('title','Untitled')}"
            for r in other_rows
        )
        prompt = (
            f"You have a knowledge base. Identify which notes are most semantically related "
            f"to the given note. Return up to 5 IDs in JSON array format like [\"id1\",\"id2\"].\n\n"
            f"CURRENT NOTE:\nTitle: {node.get('title','Untitled')}\n{target[:1200]}\n\n"
            f"OTHER NOTES (id | type | title):\n{node_list}\n\n"
            f"Return only the JSON array of related IDs, nothing else."
        )

    try:
        result_text = await call_claude(prompt, model=config.CLAUDE_MODEL, timeout=60)
    except RuntimeError as e:
        log.error("[ai] claude_cli error: %s", e)
        raise HTTPException(503, "AI action failed — Claude CLI unavailable")

    if body.action == "find_related":
        import json as _json
        try:
            related_ids = _json.loads(result_text)
            if not isinstance(related_ids, list):
                related_ids = []
        except Exception:
            related_ids = []
        # Filter to valid IDs in our list
        valid_ids = {r["id"] for r in other_rows}
        related_ids = [rid for rid in related_ids if rid in valid_ids]
        related_nodes = [r for r in other_rows if r["id"] in related_ids]
        return {"action": "find_related", "result": result_text, "related_ids": related_ids, "related_nodes": related_nodes}

    return {"action": body.action, "result": result_text}
