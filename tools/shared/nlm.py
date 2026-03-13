"""OPAI Shared NLM — Google NotebookLM integration via notebooklm-py.

Pre-analysis layer that offloads heavy research/RAG tasks to Google's free
Gemini-powered NotebookLM, saving ~60-70% of Claude CLI token usage on research.

Named 'nlm' to avoid shadowing the 'notebooklm' package.

Usage in any OPAI FastAPI service:

    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
    from nlm import is_available, get_client, ask_notebook, ensure_notebook

    if is_available():
        async with await get_client() as client:
            nb_id = await ensure_notebook(client, "My Research")
            answer = await ask_notebook(client, nb_id, "What are the key trends?")

Providers:
    1. notebooklm-py (unofficial async Python API, MIT, v0.3.3+)
    2. Claude CLI fallback (when NotebookLM unavailable)

Limits (Plus tier, via Workspace account):
    - 500 queries/day
    - 20 audio overviews/day
    - 300 sources per notebook

API shape (notebooklm-py v0.3.3):
    client = await NotebookLMClient.from_storage(path)
    async with client:
        client.notebooks.list() / .create() / .get()
        client.sources.add_text() / .add_url() / .add_file()
        client.chat.ask()
        client.artifacts.generate_audio() / .generate_report() / .generate_study_guide()
        client.artifacts.generate_slide_deck() / .generate_quiz() / .generate_flashcards()
        client.artifacts.generate_mind_map() / .generate_infographic()
        client.artifacts.wait_for_completion() / .download_audio() / .download_report()
        client.research.start() / .poll() / .import_sources()
"""

import asyncio
import json
import logging
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("opai.notebooklm")

# ── Usage Tracking ────────────────────────────────────────────────────────────

DAILY_QUERY_LIMIT = 500
DAILY_AUDIO_LIMIT = 20
_USAGE_FILE = Path(__file__).parent.parent / "opai-engine" / "data" / "notebooklm-usage.json"


def _load_usage() -> dict:
    """Load usage tracker. Resets daily."""
    try:
        if _USAGE_FILE.exists():
            data = json.loads(_USAGE_FILE.read_text())
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            if data.get("date") != today:
                return {"date": today, "queries_used": 0, "audio_used": 0, "calls": []}
            return data
    except Exception:
        pass
    return {"date": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "queries_used": 0, "audio_used": 0, "calls": []}


def _save_usage(data: dict):
    """Save usage tracker."""
    try:
        _USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _USAGE_FILE.write_text(json.dumps(data, indent=2))
    except Exception as e:
        log.warning("[NotebookLM] Failed to save usage tracker: %s", e)


def _track_usage(action: str, notebook_id: str = ""):
    """Track a single API call."""
    usage = _load_usage()
    if action == "audio":
        usage["audio_used"] += 1
    else:
        usage["queries_used"] += 1
    usage["calls"].append({
        "action": action,
        "notebook_id": notebook_id[:36] if notebook_id else "",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    usage["calls"] = usage["calls"][-30:]
    _save_usage(usage)


def _check_query_budget() -> bool:
    """Return True if we have query budget remaining."""
    usage = _load_usage()
    return usage["queries_used"] < DAILY_QUERY_LIMIT


def _check_audio_budget() -> bool:
    """Return True if we have audio budget remaining."""
    usage = _load_usage()
    return usage["audio_used"] < DAILY_AUDIO_LIMIT


# ── Error Classes ─────────────────────────────────────────────────────────────

class NotebookLMError(Exception):
    """Base error for NotebookLM operations."""
    pass


# ── Organized RAG Notebook Registry ──────────────────────────────────────────
# Pre-loaded notebooks with curated knowledge. Consumer code should query these
# instead of creating ephemeral notebooks for better grounding and token savings.

_RAG_REGISTRY_FILE = Path(__file__).parent.parent / "opai-engine" / "data" / "nlm-loader-state.json"

# Topic → notebook key mapping (keyword routing)
_TOPIC_MAP = {
    # Client / Drive / Project
    "client": "client-portfolio",
    "drive": "client-portfolio",
    "project": "client-portfolio",
    "brand": "client-portfolio",
    "asset": "client-portfolio",
    "folder": "client-portfolio",
    "file": "client-portfolio",
    # Business / HELM / Pricing / Playbooks
    "helm": "business-helm",
    "business": "business-helm",
    "pricing": "business-helm",
    "playbook": "business-helm",
    "revenue": "business-helm",
    "strategy": "business-helm",
    "service": "business-helm",
    "saas": "business-helm",
    "geo": "business-helm",
    "onboarding": "business-helm",
    "delivery": "business-helm",
    # Technical / Dev / API / Infrastructure
    "technical": "technical-reference",
    "api": "technical-reference",
    "dev": "technical-reference",
    "command": "technical-reference",
    "linux": "technical-reference",
    "systemd": "technical-reference",
    "caddy": "technical-reference",
    "supabase": "technical-reference",
    "mcp": "technical-reference",
    "deploy": "technical-reference",
    "troubleshoot": "technical-reference",
    "n8n": "technical-reference",
    "auth": "technical-reference",
    # Agent / Ops / Prompts / Squads
    "agent": "agent-ops",
    "squad": "agent-ops",
    "prompt": "agent-ops",
    "fleet": "agent-ops",
    "heartbeat": "agent-ops",
    "convention": "agent-ops",
    "framework": "agent-ops",
    "assessment": "agent-ops",
    "meta": "agent-ops",
    "worker": "agent-ops",
}


def _load_rag_registry() -> dict[str, str]:
    """Load organized notebook IDs from loader state file."""
    try:
        if _RAG_REGISTRY_FILE.exists():
            data = json.loads(_RAG_REGISTRY_FILE.read_text())
            return data.get("notebooks", {})
    except Exception:
        pass
    return {}


def get_rag_notebook_id(topic: str) -> Optional[str]:
    """Get the organized RAG notebook ID for a topic keyword.

    Returns notebook UUID if found, None if topic doesn't map to any notebook.
    Uses keyword matching against the topic map.
    """
    registry = _load_rag_registry()
    if not registry:
        return None

    topic_lower = topic.lower()

    # Direct key match first
    if topic_lower in registry:
        return registry[topic_lower]

    # Keyword match from topic map
    for keyword, nb_key in _TOPIC_MAP.items():
        if keyword in topic_lower:
            nb_id = registry.get(nb_key)
            if nb_id:
                return nb_id

    return None


def get_all_rag_notebooks() -> dict[str, str]:
    """Get all organized RAG notebook IDs. Returns {key: notebook_id}."""
    return _load_rag_registry()


async def ask_rag(
    client, question: str, topic_hint: str = "",
    conversation_id: Optional[str] = None,
) -> Optional[dict]:
    """Query the organized RAG notebooks with smart routing.

    Determines which notebook to query based on topic_hint keywords.
    Returns the answer dict or None if no matching notebook found.

    This is the primary token-saving function — use it instead of Claude CLI
    for factual questions about OPAI system, clients, business, tech, or agents.
    """
    nb_id = get_rag_notebook_id(topic_hint or question)
    if not nb_id:
        log.debug("[NLM] No RAG notebook match for topic: %s", topic_hint or question[:50])
        return None

    try:
        result = await ask_notebook(client, nb_id, question, conversation_id)
        log.info("[NLM] RAG query routed to notebook %s for topic '%s'",
                 nb_id[:8], topic_hint or question[:30])
        return result
    except NotebookLMRateLimitError:
        raise
    except Exception as e:
        log.warning("[NLM] RAG query failed for notebook %s: %s", nb_id[:8], e)
        return None


class NotebookLMAuthError(NotebookLMError):
    """Authentication failed or expired."""
    pass


class NotebookLMRateLimitError(NotebookLMError):
    """Daily rate limit reached."""
    pass


# ── Auth Storage ──────────────────────────────────────────────────────────────

_AUTH_PATH = Path.home() / ".notebooklm" / "storage_state.json"


def _get_auth_path() -> Optional[Path]:
    """Get auth storage path from env, vault, or default location."""
    # 1. Environment variable
    env_path = os.environ.get("NOTEBOOKLM_AUTH_PATH")
    if env_path:
        p = Path(env_path)
        if p.exists():
            return p

    # 2. Default location
    if _AUTH_PATH.exists():
        return _AUTH_PATH

    # 3. Try vault
    try:
        result = subprocess.run(
            ["python3", "-c",
             "import sys; sys.path.insert(0, '/workspace/synced/opai/tools/opai-vault'); "
             "import store; v = store.get_secret('notebooklm-auth-json'); print(v[:20] if v else '')"],
            capture_output=True, text=True, timeout=5,
        )
        if result.stdout.strip():
            # Auth JSON is in vault — write it to disk for the library
            vault_result = subprocess.run(
                ["python3", "-c",
                 "import sys; sys.path.insert(0, '/workspace/synced/opai/tools/opai-vault'); "
                 "import store; print(store.get_secret('notebooklm-auth-json') or '')"],
                capture_output=True, text=True, timeout=5,
            )
            auth_json = vault_result.stdout.strip()
            if auth_json and auth_json.startswith("{"):
                _AUTH_PATH.parent.mkdir(parents=True, exist_ok=True)
                _AUTH_PATH.write_text(auth_json)
                log.info("[NotebookLM] Restored auth from vault")
                return _AUTH_PATH
    except Exception:
        pass

    return None


# ── Availability Check ────────────────────────────────────────────────────────

def is_available() -> bool:
    """Quick check: auth exists + package importable."""
    try:
        from notebooklm import NotebookLMClient  # noqa: F401
    except ImportError:
        return False
    return _get_auth_path() is not None


# ── Client ────────────────────────────────────────────────────────────────────

async def get_client():
    """Get an authenticated NotebookLM client (async context manager).

    Usage:
        async with await get_client() as client:
            notebooks = await client.notebooks.list()
    """
    try:
        from notebooklm import NotebookLMClient
    except ImportError:
        raise NotebookLMError("notebooklm-py package not installed. Run: pip install 'notebooklm-py[browser]'")

    auth_path = _get_auth_path()
    if not auth_path:
        raise NotebookLMAuthError("NotebookLM auth not configured. Run: notebooklm login")

    try:
        client = await NotebookLMClient.from_storage(str(auth_path))
        return client
    except Exception as e:
        if "auth" in str(e).lower() or "login" in str(e).lower():
            raise NotebookLMAuthError(f"NotebookLM auth expired or invalid: {e}")
        raise NotebookLMError(f"Failed to create NotebookLM client: {e}")


# ── Notebook Management ───────────────────────────────────────────────────────

async def list_notebooks(client) -> list[dict]:
    """List all notebooks."""
    try:
        notebooks = await client.notebooks.list()
        return [
            {
                "id": nb.id,
                "title": nb.title,
                "source_count": getattr(nb, "source_count", 0),
            }
            for nb in notebooks
        ]
    except Exception as e:
        log.error("[NotebookLM] list_notebooks failed: %s", e)
        raise NotebookLMError(f"Failed to list notebooks: {e}")


async def ensure_notebook(client, title: str, notebook_id: Optional[str] = None) -> str:
    """Get or create a notebook by title. Returns notebook ID."""
    # If we have an explicit ID, try to use it
    if notebook_id:
        try:
            nb = await client.notebooks.get(notebook_id)
            if nb:
                return notebook_id
        except Exception:
            log.debug("[NotebookLM] Notebook ID %s not found, searching by title", notebook_id)

    # Search by title
    try:
        notebooks = await client.notebooks.list()
        for nb in notebooks:
            if nb.title == title:
                return nb.id
    except Exception as e:
        log.warning("[NotebookLM] Error listing notebooks: %s", e)

    # Create new
    try:
        nb = await client.notebooks.create(title=title)
        log.info("[NotebookLM] Created notebook '%s' → %s", title, nb.id)
        return nb.id
    except Exception as e:
        raise NotebookLMError(f"Failed to create notebook '{title}': {e}")


# ── Source Management ─────────────────────────────────────────────────────────

async def add_source_text(client, nb_id: str, title: str, content: str) -> dict:
    """Add a text source to a notebook."""
    try:
        source = await client.sources.add_text(nb_id, title=title, content=content)
        _track_usage("add_source", nb_id)
        return {"id": getattr(source, "id", ""), "title": title, "type": "text"}
    except Exception as e:
        raise NotebookLMError(f"Failed to add text source: {e}")


async def add_source_url(client, nb_id: str, url: str) -> dict:
    """Add a web URL source to a notebook."""
    try:
        source = await client.sources.add_url(nb_id, url=url)
        _track_usage("add_source", nb_id)
        return {"id": getattr(source, "id", ""), "url": url, "type": "url"}
    except Exception as e:
        raise NotebookLMError(f"Failed to add URL source: {e}")


async def add_source_youtube(client, nb_id: str, url: str) -> dict:
    """Add a YouTube URL source (native NotebookLM indexing).

    NotebookLM treats YouTube URLs as regular URL sources but natively
    indexes the video content (transcript + metadata).
    """
    try:
        source = await client.sources.add_url(nb_id, url=url)
        _track_usage("add_source", nb_id)
        return {"id": getattr(source, "id", ""), "url": url, "type": "youtube"}
    except Exception as e:
        raise NotebookLMError(f"Failed to add YouTube source: {e}")


async def add_source_file(client, nb_id: str, path: str) -> dict:
    """Add a file source (PDF, etc.) to a notebook."""
    try:
        source = await client.sources.add_file(nb_id, file_path=path)
        _track_usage("add_source", nb_id)
        return {"id": getattr(source, "id", ""), "path": path, "type": "file"}
    except Exception as e:
        raise NotebookLMError(f"Failed to add file source: {e}")


# ── Grounded Q&A ─────────────────────────────────────────────────────────────

async def ask_notebook(
    client, nb_id: str, question: str, conversation_id: Optional[str] = None
) -> dict:
    """Ask a grounded Q&A question against notebook sources."""
    if not _check_query_budget():
        raise NotebookLMRateLimitError(f"Daily query limit ({DAILY_QUERY_LIMIT}) reached")

    try:
        kwargs = {}
        if conversation_id:
            kwargs["conversation_id"] = conversation_id

        response = await client.chat.ask(nb_id, question, **kwargs)
        _track_usage("ask", nb_id)

        return {
            "answer": getattr(response, "answer", str(response)),
            "conversation_id": getattr(response, "conversation_id", None),
            "references": getattr(response, "references", []),
        }
    except Exception as e:
        if "rate" in str(e).lower() or "limit" in str(e).lower():
            raise NotebookLMRateLimitError(f"Rate limited: {e}")
        raise NotebookLMError(f"Q&A failed: {e}")


# ── Summaries & Reports ──────────────────────────────────────────────────────

async def get_notebook_summary(client, nb_id: str) -> dict:
    """Get auto-generated notebook summary."""
    if not _check_query_budget():
        raise NotebookLMRateLimitError("Daily query limit reached")

    try:
        summary = await client.notebooks.get_summary(nb_id)
        _track_usage("summary", nb_id)
        return {"summary": summary if isinstance(summary, str) else str(summary)}
    except Exception as e:
        raise NotebookLMError(f"Summary failed: {e}")


async def generate_report(
    client, nb_id: str, format: str = "briefing_doc",
    instructions: str = "", timeout: int = 300,
) -> dict:
    """Generate a written report from notebook sources.

    format: 'briefing_doc' (default), or use generate_study_guide() for study guides.
    """
    if not _check_query_budget():
        raise NotebookLMRateLimitError("Daily query limit reached")

    try:
        kwargs = {}
        if instructions:
            kwargs["extra_instructions"] = instructions

        status = await client.artifacts.generate_report(nb_id, **kwargs)
        # Wait for completion
        result = await client.artifacts.wait_for_completion(
            nb_id, status.task_id, timeout=timeout,
        )
        _track_usage("generate_report", nb_id)

        # Download the report content (artifact_id=None grabs latest)
        content = ""
        try:
            import tempfile
            tmp = tempfile.mktemp(suffix=".md")
            await client.artifacts.download_report(nb_id, tmp)
            content = Path(tmp).read_text()
            Path(tmp).unlink(missing_ok=True)
        except Exception as dl_err:
            log.warning("[NotebookLM] Report download failed: %s", dl_err)
            content = str(result)

        return {"content": content, "format": format}

    except asyncio.TimeoutError:
        raise NotebookLMError(f"Report generation timed out ({timeout}s)")
    except Exception as e:
        raise NotebookLMError(f"Report generation failed: {e}")


# ── Audio Overview ────────────────────────────────────────────────────────────

async def generate_audio(
    client, nb_id: str,
    instructions: str = "",
    output_path: Optional[str] = None,
    timeout: int = 300,
) -> dict:
    """Generate an audio overview (podcast-style) from notebook sources."""
    if not _check_audio_budget():
        raise NotebookLMRateLimitError(f"Daily audio limit ({DAILY_AUDIO_LIMIT}) reached")

    try:
        kwargs = {}
        if instructions:
            kwargs["instructions"] = instructions

        status = await client.artifacts.generate_audio(nb_id, **kwargs)
        # Wait for completion
        result = await client.artifacts.wait_for_completion(
            nb_id, status.task_id, timeout=timeout,
        )
        _track_usage("audio", nb_id)

        out = {
            "status": "completed",
            "task_id": status.task_id,
        }

        # Download audio if path provided
        if output_path and hasattr(result, "artifact_id") and result.artifact_id:
            try:
                await client.artifacts.download_audio(nb_id, output_path, artifact_id=result.artifact_id)
                out["path"] = output_path
            except Exception as dl_err:
                log.warning("[NotebookLM] Audio download failed: %s", dl_err)

        return out

    except asyncio.TimeoutError:
        raise NotebookLMError(f"Audio generation timed out ({timeout}s)")
    except Exception as e:
        raise NotebookLMError(f"Audio generation failed: {e}")


# ── Other Deliverables ────────────────────────────────────────────────────────

async def generate_study_guide(client, nb_id: str, instructions: str = "", timeout: int = 300) -> dict:
    """Generate a study guide from notebook sources."""
    if not _check_query_budget():
        raise NotebookLMRateLimitError("Daily query limit reached")
    try:
        kwargs = {}
        if instructions:
            kwargs["extra_instructions"] = instructions

        status = await client.artifacts.generate_study_guide(nb_id, **kwargs)
        result = await client.artifacts.wait_for_completion(nb_id, status.task_id, timeout=timeout)
        _track_usage("study_guide", nb_id)

        # Download content (artifact_id=None grabs latest)
        content = ""
        try:
            import tempfile
            tmp = tempfile.mktemp(suffix=".md")
            await client.artifacts.download_report(nb_id, tmp)
            content = Path(tmp).read_text()
            Path(tmp).unlink(missing_ok=True)
        except Exception as dl_err:
            log.warning("[NotebookLM] Study guide download failed: %s", dl_err)
            content = str(result)

        return {"content": content, "format": "study_guide"}
    except asyncio.TimeoutError:
        raise NotebookLMError(f"Study guide generation timed out ({timeout}s)")
    except Exception as e:
        raise NotebookLMError(f"Study guide generation failed: {e}")


async def generate_slide_deck(client, nb_id: str, instructions: str = "", timeout: int = 600) -> dict:
    """Generate a slide deck from notebook sources."""
    if not _check_query_budget():
        raise NotebookLMRateLimitError("Daily query limit reached")
    try:
        kwargs = {}
        if instructions:
            kwargs["instructions"] = instructions

        status = await client.artifacts.generate_slide_deck(nb_id, **kwargs)
        result = await client.artifacts.wait_for_completion(nb_id, status.task_id, timeout=timeout)
        _track_usage("slide_deck", nb_id)

        # Download slide deck as PDF
        content = ""
        output_path = ""
        try:
            import tempfile
            tmp = tempfile.mktemp(suffix=".pdf")
            await client.artifacts.download_slide_deck(nb_id, tmp)
            output_path = tmp
            content = f"Slide deck saved to: {tmp}"
        except Exception as dl_err:
            log.warning("[NotebookLM] Slide deck download failed: %s", dl_err)
            content = str(result)

        return {"content": content, "format": "slide_deck", "task_id": status.task_id, "path": output_path}
    except asyncio.TimeoutError:
        raise NotebookLMError(f"Slide deck generation timed out ({timeout}s)")
    except Exception as e:
        raise NotebookLMError(f"Slide deck generation failed: {e}")


async def generate_infographic(client, nb_id: str, instructions: str = "", timeout: int = 600) -> dict:
    """Generate an infographic from notebook sources."""
    if not _check_query_budget():
        raise NotebookLMRateLimitError("Daily query limit reached")
    try:
        kwargs = {}
        if instructions:
            kwargs["instructions"] = instructions

        status = await client.artifacts.generate_infographic(nb_id, **kwargs)
        result = await client.artifacts.wait_for_completion(nb_id, status.task_id, timeout=timeout)
        _track_usage("infographic", nb_id)

        # Download infographic
        content = ""
        output_path = ""
        try:
            import tempfile
            tmp = tempfile.mktemp(suffix=".png")
            await client.artifacts.download_infographic(nb_id, tmp)
            output_path = tmp
            content = f"Infographic saved to: {tmp}"
        except Exception as dl_err:
            log.warning("[NotebookLM] Infographic download failed: %s", dl_err)
            content = str(result)

        return {"content": content, "format": "infographic", "task_id": status.task_id, "path": output_path}
    except asyncio.TimeoutError:
        raise NotebookLMError(f"Infographic generation timed out ({timeout}s)")
    except Exception as e:
        raise NotebookLMError(f"Infographic generation failed: {e}")


async def generate_quiz(client, nb_id: str, timeout: int = 300) -> dict:
    """Generate a quiz from notebook sources."""
    if not _check_query_budget():
        raise NotebookLMRateLimitError("Daily query limit reached")
    try:
        status = await client.artifacts.generate_quiz(nb_id)
        result = await client.artifacts.wait_for_completion(nb_id, status.task_id, timeout=timeout)
        _track_usage("quiz", nb_id)

        # Download quiz (artifact_id=None grabs latest)
        content = ""
        try:
            import tempfile
            tmp = tempfile.mktemp(suffix=".json")
            await client.artifacts.download_quiz(nb_id, tmp)
            content = Path(tmp).read_text()
            Path(tmp).unlink(missing_ok=True)
        except Exception as dl_err:
            log.warning("[NotebookLM] Quiz download failed: %s", dl_err)
            content = str(result)

        return {"content": content, "format": "quiz"}
    except asyncio.TimeoutError:
        raise NotebookLMError(f"Quiz generation timed out ({timeout}s)")
    except Exception as e:
        raise NotebookLMError(f"Quiz generation failed: {e}")


async def generate_flashcards(client, nb_id: str, timeout: int = 300) -> dict:
    """Generate flashcards from notebook sources."""
    if not _check_query_budget():
        raise NotebookLMRateLimitError("Daily query limit reached")
    try:
        status = await client.artifacts.generate_flashcards(nb_id)
        result = await client.artifacts.wait_for_completion(nb_id, status.task_id, timeout=timeout)
        _track_usage("flashcards", nb_id)

        # Download flashcards (artifact_id=None grabs latest)
        content = ""
        try:
            import tempfile
            tmp = tempfile.mktemp(suffix=".json")
            await client.artifacts.download_flashcards(nb_id, tmp)
            content = Path(tmp).read_text()
            Path(tmp).unlink(missing_ok=True)
        except Exception as dl_err:
            log.warning("[NotebookLM] Flashcards download failed: %s", dl_err)
            content = str(result)

        return {"content": content, "format": "flashcards"}
    except asyncio.TimeoutError:
        raise NotebookLMError(f"Flashcards generation timed out ({timeout}s)")
    except Exception as e:
        raise NotebookLMError(f"Flashcards generation failed: {e}")


async def generate_mind_map(client, nb_id: str) -> dict:
    """Generate a mind map from notebook sources (synchronous — no polling needed)."""
    if not _check_query_budget():
        raise NotebookLMRateLimitError("Daily query limit reached")
    try:
        result = await client.artifacts.generate_mind_map(nb_id)
        _track_usage("mind_map", nb_id)
        # generate_mind_map returns a dict directly, not a GenerationStatus
        return {"content": json.dumps(result) if isinstance(result, dict) else str(result), "format": "mind_map"}
    except Exception as e:
        raise NotebookLMError(f"Mind map generation failed: {e}")


# ── Web/Scholar Research ──────────────────────────────────────────────────────

async def research_topic(
    client, nb_id: str, query: str,
    source: str = "web", mode: str = "fast",
) -> dict:
    """Run web or scholar research and add findings to notebook.

    Starts a research task, polls for completion, then optionally imports sources.
    """
    if not _check_query_budget():
        raise NotebookLMRateLimitError("Daily query limit reached")

    try:
        result = await client.research.start(nb_id, query=query, source=source, mode=mode)
        _track_usage("research", nb_id)

        if result is None:
            return {"findings": "", "sources_added": 0, "query": query}

        # Poll for completion (research is async)
        task_id = result.get("task_id", "")
        for _ in range(30):
            await asyncio.sleep(3)
            poll_result = await client.research.poll(nb_id)
            status = poll_result.get("status", "")
            if status in ("completed", "done", "finished"):
                # Import discovered sources
                sources = poll_result.get("sources", [])
                if sources and task_id:
                    try:
                        await client.research.import_sources(nb_id, task_id, sources)
                    except Exception:
                        pass
                return {
                    "findings": poll_result.get("summary", str(poll_result)),
                    "sources_added": len(sources),
                    "query": query,
                }
            if status in ("failed", "error"):
                return {"findings": "", "sources_added": 0, "query": query, "error": poll_result.get("error", "")}

        return {"findings": "", "sources_added": 0, "query": query, "error": "research timed out"}

    except Exception as e:
        raise NotebookLMError(f"Research failed: {e}")


# ── Usage Stats ───────────────────────────────────────────────────────────────

def get_usage() -> dict:
    """Get current usage stats."""
    data = _load_usage()
    return {
        "date": data["date"],
        "queries_used": data["queries_used"],
        "queries_limit": DAILY_QUERY_LIMIT,
        "queries_remaining": max(0, DAILY_QUERY_LIMIT - data["queries_used"]),
        "audio_used": data["audio_used"],
        "audio_limit": DAILY_AUDIO_LIMIT,
        "audio_remaining": max(0, DAILY_AUDIO_LIMIT - data["audio_used"]),
        "warning": data["queries_used"] >= DAILY_QUERY_LIMIT * 0.8,
        "recent_calls": data.get("calls", [])[-10:],
    }
