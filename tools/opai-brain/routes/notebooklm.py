"""2nd Brain — NotebookLM deliverables routes (Phase 5).

Generate deliverables (audio, reports, quizzes, etc.) from brain nodes
via NotebookLM. Flow: select nodes → ephemeral notebook → add as sources →
generate artifact → poll → download.
"""
from __future__ import annotations

import asyncio
import logging
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

sys.path.insert(0, str(Path(__file__).parent.parent))
import config

log = logging.getLogger("brain.routes.notebooklm")
router = APIRouter()

# In-memory task tracker for generation jobs
_generation_tasks: dict[str, dict] = {}


# ── Supabase helpers ─────────────────────────────────────────────────────────

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


# ── Models ────────────────────────────────────────────────────────────────────

class AskNodesRequest(BaseModel):
    node_ids: list[str]
    question: str

class GenerateFromNodesRequest(BaseModel):
    node_ids: list[str]
    artifact_type: str  # audio, report, study_guide, quiz, flashcards, slide_deck, mind_map
    instructions: Optional[str] = None


# ── Background worker ─────────────────────────────────────────────────────────

async def _generate_from_nodes(
    task_id: str, node_ids: list[str], artifact_type: str,
    instructions: str, user_id: str,
):
    """Background: create ephemeral notebook, add nodes as sources, generate artifact."""
    try:
        from nlm import (
            is_available, get_client, ensure_notebook,
            add_source_text, generate_audio, generate_report,
            generate_slide_deck, generate_quiz, generate_flashcards,
            generate_mind_map, NotebookLMError,
        )
    except ImportError:
        _generation_tasks[task_id]["status"] = "failed"
        _generation_tasks[task_id]["error"] = "notebooklm-py not installed"
        return

    if not is_available():
        _generation_tasks[task_id]["status"] = "failed"
        _generation_tasks[task_id]["error"] = "NotebookLM not configured"
        return

    _generation_tasks[task_id]["status"] = "running"

    try:
        # Fetch node contents
        nodes = []
        for nid in node_ids[:10]:  # Cap at 10 nodes
            rows = await _sb_get("brain_nodes", f"id=eq.{nid}&select=id,title,content")
            if rows:
                nodes.append(rows[0])

        if not nodes:
            _generation_tasks[task_id]["status"] = "failed"
            _generation_tasks[task_id]["error"] = "No valid nodes found"
            return

        _generation_tasks[task_id]["status"] = "uploading_sources"

        client = await get_client()
        async with client:
            # Create ephemeral notebook
            titles = ", ".join(n.get("title", "Untitled")[:30] for n in nodes[:3])
            nb_title = f"Brain: {titles}"[:80]
            nb_id = await ensure_notebook(client, nb_title)

            # Add nodes as text sources
            for node in nodes:
                content = node.get("content", "")
                if content.strip():
                    title = node.get("title", "Untitled")
                    await add_source_text(client, nb_id, title, content[:50000])
                    await asyncio.sleep(1)

            _generation_tasks[task_id]["status"] = "generating"
            _generation_tasks[task_id]["notebook_id"] = nb_id

            # Generate the artifact
            if artifact_type == "audio":
                result = await generate_audio(
                    client, nb_id,
                    instructions=instructions or "Create an engaging overview of these knowledge notes.",
                    timeout=300,
                )
            elif artifact_type in ("report", "study_guide"):
                result = await generate_report(client, nb_id, format="study_guide", timeout=120)
            elif artifact_type == "slide_deck":
                result = await generate_slide_deck(client, nb_id, timeout=120)
            elif artifact_type == "quiz":
                result = await generate_quiz(client, nb_id)
            elif artifact_type == "flashcards":
                result = await generate_flashcards(client, nb_id)
            elif artifact_type == "mind_map":
                result = await generate_mind_map(client, nb_id)
            else:
                _generation_tasks[task_id]["status"] = "failed"
                _generation_tasks[task_id]["error"] = f"Unknown artifact type: {artifact_type}"
                return

            _generation_tasks[task_id]["status"] = "completed"
            _generation_tasks[task_id]["result"] = result
            _generation_tasks[task_id]["completed_at"] = datetime.now(timezone.utc).isoformat()

    except NotebookLMError as e:
        _generation_tasks[task_id]["status"] = "failed"
        _generation_tasks[task_id]["error"] = str(e)
        log.error("[NLM] Generation failed for task %s: %s", task_id[:8], e)
    except Exception as e:
        _generation_tasks[task_id]["status"] = "failed"
        _generation_tasks[task_id]["error"] = str(e)
        log.error("[NLM] Unexpected error for task %s: %s", task_id[:8], e)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/api/notebooklm/ask")
async def ask_nodes(
    body: AskNodesRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Q&A against selected brain nodes via NotebookLM."""
    try:
        from nlm import (
            is_available, get_client, ensure_notebook,
            add_source_text, ask_notebook, NotebookLMRateLimitError,
        )
    except ImportError:
        raise HTTPException(503, "notebooklm-py not installed")

    if not is_available():
        raise HTTPException(503, "NotebookLM not configured")

    # Tier gate
    if not user.is_admin and user.marketplace_tier not in ("pro", "ultimate"):
        raise HTTPException(403, "NotebookLM features require a Pro or Ultimate plan")

    # Fetch nodes
    nodes = []
    for nid in body.node_ids[:10]:
        rows = await _sb_get("brain_nodes", f"id=eq.{nid}&user_id=eq.{user.id}&select=id,title,content")
        if rows:
            nodes.append(rows[0])

    if not nodes:
        raise HTTPException(404, "No valid nodes found")

    try:
        client = await get_client()
        async with client:
            # Create ephemeral notebook for this Q&A
            nb_id = await ensure_notebook(client, f"Brain Q&A: {body.question[:40]}")

            # Add node contents as sources
            for node in nodes:
                content = node.get("content", "")
                if content.strip():
                    await add_source_text(client, nb_id, node.get("title", "Note"), content[:50000])
                    await asyncio.sleep(1)

            # Ask
            result = await ask_notebook(client, nb_id, body.question)

        return {
            "answer": result.get("answer", ""),
            "source_nodes": len(nodes),
            "notebook_id": nb_id,
        }

    except NotebookLMRateLimitError as e:
        raise HTTPException(429, str(e))
    except Exception as e:
        raise HTTPException(500, f"Q&A failed: {e}")


@router.post("/api/notebooklm/generate")
async def generate_from_nodes(
    body: GenerateFromNodesRequest,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
):
    """Start generating a deliverable from brain nodes. Returns task_id for polling."""
    # Tier gate
    if not user.is_admin and user.marketplace_tier not in ("pro", "ultimate"):
        raise HTTPException(403, "NotebookLM features require a Pro or Ultimate plan")

    valid_types = {"audio", "report", "study_guide", "quiz", "flashcards", "slide_deck", "mind_map"}
    if body.artifact_type not in valid_types:
        raise HTTPException(400, f"Invalid artifact_type. Valid: {', '.join(sorted(valid_types))}")

    task_id = str(uuid.uuid4())
    _generation_tasks[task_id] = {
        "task_id": task_id,
        "artifact_type": body.artifact_type,
        "node_ids": body.node_ids,
        "status": "queued",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "user_id": user.id,
    }

    background_tasks.add_task(
        _generate_from_nodes, task_id, body.node_ids,
        body.artifact_type, body.instructions or "", user.id,
    )

    return {"task_id": task_id, "status": "queued"}


@router.get("/api/notebooklm/generate/{task_id}")
async def poll_generation(
    task_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Poll generation status."""
    task = _generation_tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    if task.get("user_id") != user.id and not user.is_admin:
        raise HTTPException(403, "Not your task")

    return {
        "task_id": task_id,
        "status": task.get("status"),
        "artifact_type": task.get("artifact_type"),
        "error": task.get("error"),
        "result": task.get("result") if task.get("status") == "completed" else None,
        "created_at": task.get("created_at"),
        "completed_at": task.get("completed_at"),
    }
