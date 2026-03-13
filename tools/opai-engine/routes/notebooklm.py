"""OPAI Engine — NotebookLM management routes.

Admin-gated API for managing NotebookLM notebooks, sources, and generating
artifacts. Wraps tools/shared/notebooklm.py for HTTP access.
"""

import logging
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from auth import require_admin

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))

log = logging.getLogger("engine.routes.notebooklm")
router = APIRouter(prefix="/api/notebooklm", tags=["notebooklm"])


# ── Models ────────────────────────────────────────────────────────────────────

class CreateNotebookRequest(BaseModel):
    title: str

class AddSourceRequest(BaseModel):
    source_type: str  # text, url, youtube, file
    title: Optional[str] = None
    content: Optional[str] = None
    url: Optional[str] = None
    path: Optional[str] = None

class AskRequest(BaseModel):
    question: str
    conversation_id: Optional[str] = None

class GenerateRequest(BaseModel):
    artifact_type: str  # audio, report, slide_deck, infographic, quiz, flashcards, mind_map
    instructions: Optional[str] = None
    output_path: Optional[str] = None
    timeout: Optional[int] = 300


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/status", dependencies=[Depends(require_admin)])
async def notebooklm_status():
    """Auth status + usage stats."""
    try:
        from nlm import is_available, get_usage
    except ImportError:
        return {"available": False, "reason": "notebooklm-py not installed"}

    available = is_available()
    usage = get_usage()
    return {
        "available": available,
        "usage": usage,
    }


@router.get("/notebooks", dependencies=[Depends(require_admin)])
async def list_notebooks_route():
    """List all NotebookLM notebooks."""
    try:
        from nlm import is_available, get_client, list_notebooks
    except ImportError:
        raise HTTPException(503, "notebooklm-py not installed")

    if not is_available():
        raise HTTPException(503, "NotebookLM not configured — run: notebooklm login")

    try:
        client = await get_client()
        async with client:
            notebooks = await list_notebooks(client)
        return {"notebooks": notebooks}
    except Exception as e:
        raise HTTPException(500, f"Failed to list notebooks: {e}")


@router.post("/notebooks", dependencies=[Depends(require_admin)])
async def create_notebook_route(body: CreateNotebookRequest):
    """Create a new notebook."""
    try:
        from nlm import is_available, get_client, ensure_notebook
    except ImportError:
        raise HTTPException(503, "notebooklm-py not installed")

    if not is_available():
        raise HTTPException(503, "NotebookLM not configured")

    try:
        client = await get_client()
        async with client:
            nb_id = await ensure_notebook(client, body.title)
        return {"id": nb_id, "title": body.title}
    except Exception as e:
        raise HTTPException(500, f"Failed to create notebook: {e}")


@router.post("/notebooks/{nb_id}/sources", dependencies=[Depends(require_admin)])
async def add_source_route(nb_id: str, body: AddSourceRequest):
    """Add a source to a notebook."""
    try:
        from nlm import (
            is_available, get_client,
            add_source_text, add_source_url, add_source_youtube, add_source_file,
        )
    except ImportError:
        raise HTTPException(503, "notebooklm-py not installed")

    if not is_available():
        raise HTTPException(503, "NotebookLM not configured")

    try:
        client = await get_client()
        async with client:
            if body.source_type == "text":
                if not body.content:
                    raise HTTPException(400, "content required for text source")
                result = await add_source_text(client, nb_id, body.title or "Untitled", body.content)
            elif body.source_type == "url":
                if not body.url:
                    raise HTTPException(400, "url required for url source")
                result = await add_source_url(client, nb_id, body.url)
            elif body.source_type == "youtube":
                if not body.url:
                    raise HTTPException(400, "url required for youtube source")
                result = await add_source_youtube(client, nb_id, body.url)
            elif body.source_type == "file":
                if not body.path:
                    raise HTTPException(400, "path required for file source")
                result = await add_source_file(client, nb_id, body.path)
            else:
                raise HTTPException(400, f"Unknown source_type: {body.source_type}")

        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to add source: {e}")


@router.post("/notebooks/{nb_id}/ask", dependencies=[Depends(require_admin)])
async def ask_notebook_route(nb_id: str, body: AskRequest):
    """Grounded Q&A against notebook sources."""
    try:
        from nlm import is_available, get_client, ask_notebook, NotebookLMRateLimitError
    except ImportError:
        raise HTTPException(503, "notebooklm-py not installed")

    if not is_available():
        raise HTTPException(503, "NotebookLM not configured")

    try:
        client = await get_client()
        async with client:
            result = await ask_notebook(client, nb_id, body.question, body.conversation_id)
        return result
    except NotebookLMRateLimitError as e:
        raise HTTPException(429, str(e))
    except Exception as e:
        raise HTTPException(500, f"Q&A failed: {e}")


@router.post("/notebooks/{nb_id}/generate", dependencies=[Depends(require_admin)])
async def generate_artifact_route(nb_id: str, body: GenerateRequest):
    """Generate an artifact (audio, report, slides, etc.) from notebook."""
    try:
        from nlm import (
            is_available, get_client, NotebookLMRateLimitError,
            generate_audio, generate_report, generate_study_guide,
            generate_slide_deck, generate_infographic,
            generate_quiz, generate_flashcards, generate_mind_map,
        )
    except ImportError:
        raise HTTPException(503, "notebooklm-py not installed")

    if not is_available():
        raise HTTPException(503, "NotebookLM not configured")

    generators = {
        "audio": lambda c: generate_audio(c, nb_id, instructions=body.instructions or "", output_path=body.output_path, timeout=body.timeout or 600),
        "report": lambda c: generate_report(c, nb_id, instructions=body.instructions or "", timeout=body.timeout or 300),
        "study_guide": lambda c: generate_study_guide(c, nb_id, instructions=body.instructions or "", timeout=body.timeout or 300),
        "slide_deck": lambda c: generate_slide_deck(c, nb_id, instructions=body.instructions or "", timeout=body.timeout or 600),
        "infographic": lambda c: generate_infographic(c, nb_id, instructions=body.instructions or "", timeout=body.timeout or 600),
        "quiz": lambda c: generate_quiz(c, nb_id, timeout=body.timeout or 300),
        "flashcards": lambda c: generate_flashcards(c, nb_id, timeout=body.timeout or 300),
        "mind_map": lambda c: generate_mind_map(c, nb_id),
    }

    if body.artifact_type not in generators:
        raise HTTPException(400, f"Unknown artifact_type: {body.artifact_type}. Valid: {', '.join(generators.keys())}")

    try:
        client = await get_client()
        async with client:
            result = await generators[body.artifact_type](client)
        return result
    except NotebookLMRateLimitError as e:
        raise HTTPException(429, str(e))
    except Exception as e:
        raise HTTPException(500, f"Generation failed: {e}")


class RagQueryRequest(BaseModel):
    question: str
    topic_hint: Optional[str] = None
    conversation_id: Optional[str] = None


@router.get("/rag/notebooks", dependencies=[Depends(require_admin)])
async def rag_notebooks_route():
    """List organized RAG notebooks with their IDs and topic keywords."""
    try:
        from nlm import get_all_rag_notebooks, _TOPIC_MAP
    except ImportError:
        raise HTTPException(503, "notebooklm-py not installed")

    notebooks = get_all_rag_notebooks()
    # Build reverse map: notebook_key → keywords
    key_keywords = {}
    for keyword, nb_key in _TOPIC_MAP.items():
        key_keywords.setdefault(nb_key, []).append(keyword)

    return {
        "notebooks": {
            k: {"id": v, "keywords": key_keywords.get(k, [])}
            for k, v in notebooks.items()
        },
    }


@router.post("/rag/ask", dependencies=[Depends(require_admin)])
async def rag_ask_route(body: RagQueryRequest):
    """Query organized RAG notebooks with smart topic routing.

    Routes the question to the best-matching curated knowledge notebook.
    Use topic_hint to bias routing (e.g., "technical api" or "business helm").
    Returns grounded answer from curated OPAI knowledge — saves Claude tokens.
    """
    try:
        from nlm import is_available, get_client, ask_rag, NotebookLMRateLimitError
    except ImportError:
        raise HTTPException(503, "notebooklm-py not installed")

    if not is_available():
        raise HTTPException(503, "NotebookLM not configured")

    try:
        client = await get_client()
        async with client:
            result = await ask_rag(
                client, body.question,
                topic_hint=body.topic_hint or "",
                conversation_id=body.conversation_id,
            )

        if not result:
            raise HTTPException(
                404,
                "No matching RAG notebook for this topic. "
                "Try adding a topic_hint (e.g., 'technical', 'business', 'agent', 'client').",
            )

        return result
    except NotebookLMRateLimitError as e:
        raise HTTPException(429, str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"RAG query failed: {e}")


@router.get("/usage", dependencies=[Depends(require_admin)])
async def usage_route():
    """Detailed usage breakdown."""
    try:
        from nlm import get_usage
    except ImportError:
        raise HTTPException(503, "notebooklm-py not installed")

    return get_usage()
