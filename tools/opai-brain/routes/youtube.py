"""2nd Brain — YouTube save/research routes."""
from __future__ import annotations

import logging
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from youtube import process_video, summarize_video, truncate_transcript

sys.path.insert(0, str(Path(__file__).parent.parent))
from claude_cli import call_claude
import config

log = logging.getLogger("brain.routes.youtube")
router = APIRouter()


# ── Supabase helpers ─────────────────────────────────────────────────────────

def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _sb_post(path: str, body: dict) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else rows


# ── Models ───────────────────────────────────────────────────────────────────

class YouTubeSaveRequest(BaseModel):
    url: str
    title: Optional[str] = None
    author: Optional[str] = None
    transcript: Optional[str] = None
    summary_data: Optional[dict] = None


class YouTubeResearchRequest(BaseModel):
    url: str
    title: Optional[str] = None
    transcript: Optional[str] = None


class YouTubeRewriteRequest(BaseModel):
    url: str
    title: Optional[str] = None
    author: Optional[str] = None
    transcript: Optional[str] = None
    summary_data: Optional[dict] = None


# ── Save to Brain ────────────────────────────────────────────────────────────

@router.post("/api/youtube/save")
async def youtube_save(req: YouTubeSaveRequest):
    """Save a YouTube video as a Brain node (note with transcript + tags)."""

    # If no transcript provided, fetch it
    title = req.title
    author = req.author
    transcript = req.transcript

    if not transcript:
        info = await process_video(req.url)
        if info.get("error") and not info.get("transcript"):
            raise HTTPException(status_code=422, detail=info["error"])
        title = title or info.get("title", "")
        author = author or info.get("author", "")
        transcript = info.get("transcript", "")

    # Build node content
    content_parts = []
    if author:
        content_parts.append(f"**Author:** {author}")
    content_parts.append(f"**URL:** {req.url}")
    content_parts.append("")

    # Include summary if available
    sd = req.summary_data
    if sd:
        if sd.get("description"):
            content_parts.append(sd["description"])
            content_parts.append("")
        if sd.get("key_points"):
            content_parts.append("## Key Points")
            for pt in sd["key_points"]:
                content_parts.append(f"- {pt}")
            content_parts.append("")
        if sd.get("summary"):
            content_parts.append("## Summary")
            content_parts.append(sd["summary"])
            content_parts.append("")

    content_parts.append("## Transcript")
    content_parts.append(truncate_transcript(transcript, 80000))

    content = "\n".join(content_parts)

    # Auto-generate tags
    tags = ["youtube"]
    if sd and sd.get("topics"):
        tags.extend(sd["topics"][:5])

    # Create brain node
    node = {
        "id": str(uuid.uuid4()),
        "type": "note",
        "title": title or "YouTube Video",
        "content": content,
        "tags": tags,
        "metadata": {
            "source": "youtube",
            "video_url": req.url,
            "author": author or "",
        },
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    result = await _sb_post("brain_nodes", node)
    log.info("[YouTube] Saved node %s: %s", result.get("id", "?")[:8], title)
    return {"id": result.get("id"), "title": title}


# ── Research from Video ──────────────────────────────────────────────────────

async def _run_youtube_research(session_id: str, title: str, transcript: str, url: str):
    """Background: run research on the video transcript.

    Uses NotebookLM when available (native YouTube URL indexing, free),
    falls back to Claude CLI transcript analysis.
    """
    analysis_source = "claude"

    try:
        await _sb_patch_research(session_id, {"status": "running"})

        result = None

        # Try NotebookLM first — native YouTube URL support
        try:
            from nlm import (
                is_available, get_client, ensure_notebook,
                add_source_youtube, ask_notebook,
            )

            if is_available():
                client = await get_client()
                async with client:
                    nb_id = await ensure_notebook(client, "YouTube Research")
                    await add_source_youtube(client, nb_id, url)

                    research_prompt = (
                        f"Analyze this YouTube video \"{title}\" deeply. Provide:\n"
                        f"1. Key themes and concepts\n"
                        f"2. Notable claims or data points\n"
                        f"3. Related topics worth exploring\n"
                        f"4. Potential applications or action items\n"
                        f"5. Questions this raises for further research"
                    )
                    nlm_result = await ask_notebook(client, nb_id, research_prompt)
                    nlm_answer = nlm_result.get("answer", "")

                    if len(nlm_answer) > 200:
                        result = nlm_answer
                        analysis_source = "notebooklm"
                        log.info("[YouTube] NotebookLM research succeeded for session %s", session_id[:8])

        except Exception as nlm_err:
            log.warning("[YouTube] NotebookLM unavailable, falling back to Claude: %s", nlm_err)

        # Fallback to Claude
        if not result:
            truncated = truncate_transcript(transcript, 60000)
            prompt = (
                f"Research and analyze this YouTube video deeply.\n\n"
                f"Video: \"{title}\"\nURL: {url}\n\n"
                f"Transcript:\n{truncated}\n\n"
                f"Provide:\n"
                f"1. Key themes and concepts\n"
                f"2. Notable claims or data points\n"
                f"3. Related topics worth exploring\n"
                f"4. Potential applications or action items\n"
                f"5. Questions this raises for further research"
            )
            result = await call_claude(prompt, model=config.CLAUDE_MODEL, timeout=120)
            analysis_source = "claude"

        # Create a brain node with the research
        node = {
            "id": str(uuid.uuid4()),
            "type": "note",
            "title": f"Research: {title}",
            "content": result,
            "tags": ["youtube", "research"],
            "metadata": {
                "source": "youtube-research",
                "video_url": url,
                "research_session": session_id,
                "analysis_source": analysis_source,
            },
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        await _sb_post("brain_nodes", node)

        await _sb_patch_research(session_id, {
            "status": "completed",
            "result_text": result[:5000],
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        log.info("[YouTube] Research completed for session %s", session_id[:8])

    except Exception as e:
        log.error("[YouTube] Research failed for session %s: %s", session_id[:8], e)
        await _sb_patch_research(session_id, {
            "status": "failed",
            "result_text": f"Error: {e}",
        })


async def _sb_patch_research(session_id: str, body: dict):
    url = f"{config.SUPABASE_URL}/rest/v1/brain_research?id=eq.{session_id}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.patch(url, headers=_svc_headers(), json=body)
        r.raise_for_status()


@router.post("/api/youtube/research")
async def youtube_research(req: YouTubeResearchRequest, bg: BackgroundTasks):
    """Create a research session seeded from a YouTube video transcript."""

    title = req.title
    transcript = req.transcript

    if not transcript:
        info = await process_video(req.url)
        if info.get("error") and not info.get("transcript"):
            raise HTTPException(status_code=422, detail=info["error"])
        title = title or info.get("title", "")
        transcript = info.get("transcript", "")

    if not transcript:
        raise HTTPException(status_code=422, detail="No transcript available for this video")

    session_id = str(uuid.uuid4())
    session = {
        "id": session_id,
        "query": f"YouTube Research: {title or req.url}",
        "status": "queued",
        "scope": "youtube",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    await _sb_post("brain_research", session)
    bg.add_task(_run_youtube_research, session_id, title or "Video", transcript, req.url)

    log.info("[YouTube] Research session created %s for: %s", session_id[:8], title)
    return {"id": session_id, "status": "queued"}


# ── Re-Write from Video ────────────────────────────────────────────────────

_REWRITE_PROMPT = """You are a professional content creator. A user watched a YouTube video and wants to create their OWN original content inspired by the same TOPIC.

Your job is NOT to rewrite, paraphrase, or summarize the original video. Instead:
- Extract the core TOPIC and THEMES only
- Create 100% original content from YOUR OWN perspective, knowledge, and angle
- Use different examples, different structure, different arguments
- The output must be fully original — zero copied phrases, zero paraphrased sentences

SOURCE VIDEO (for topic reference only — do NOT copy):
Title: "{title}" by {author}
URL: {url}

Key themes from transcript:
{themes}

---

Produce ALL of the following sections. Use the exact markdown headers shown:

## VIDEO SCRIPT
A complete script/guide for recording an original YouTube video on this same topic.
Include: hook/intro (first 30 seconds), 3-5 main talking points with transitions, call-to-action, outro.
Format as a teleprompter-ready script with [VISUAL CUE] markers where B-roll or graphics should go.
Target length: 8-12 minutes of speaking.

## BLOG POST
A full, publish-ready blog post (800-1200 words). Original angle, original examples.
Include: compelling headline, intro hook, subheadings, conclusion with CTA.
SEO-friendly structure. Do NOT reference the original video.

## FACEBOOK POST
An engaging Facebook post (150-300 words). Conversational tone, story-driven opening.
Include 2-3 relevant hashtags at the end.

## X POST (TWITTER)
A punchy tweet or short thread (max 280 chars per tweet, up to 4 tweets).
Format each tweet on its own line prefixed with the tweet number (1/, 2/, etc.).
Include 1-2 hashtags.

## LINKEDIN POST
A professional LinkedIn post (200-400 words). Thought-leadership angle.
Opening hook line, then line break, then body. Include 3-5 hashtags at the end.

---

Remember: Every piece of content must be YOUR original take on the TOPIC — never a derivative of the source video."""


async def _run_youtube_rewrite(
    session_id: str, title: str, author: str, transcript: str,
    url: str, summary_data: Optional[dict],
):
    """Background: run Claude re-write content generation from video topics.

    When available, uses NotebookLM to pre-analyze the video for richer context.
    """
    try:
        await _sb_patch_research(session_id, {"status": "running"})

        # Try NotebookLM pre-analysis for better theme extraction
        nlm_context = ""
        try:
            from nlm import is_available, get_client, ensure_notebook, add_source_youtube, ask_notebook
            if is_available():
                client = await get_client()
                async with client:
                    nb_id = await ensure_notebook(client, "YouTube Research")
                    await add_source_youtube(client, nb_id, url)
                    nlm_result = await ask_notebook(
                        client, nb_id,
                        f"Extract the core topics, themes, key arguments, and unique angles from this video by {author}: \"{title}\""
                    )
                    nlm_answer = nlm_result.get("answer", "")
                    if len(nlm_answer) > 100:
                        nlm_context = f"\n\nPre-research analysis:\n{nlm_answer}"
                        log.info("[YouTube] NotebookLM pre-analysis enriched rewrite for session %s", session_id[:8])
        except Exception as nlm_err:
            log.debug("[YouTube] NotebookLM unavailable for rewrite pre-analysis: %s", nlm_err)

        # Build theme summary from summary_data or transcript
        themes = ""
        sd = summary_data
        if sd:
            parts = []
            if sd.get("key_points"):
                parts.append("Key points: " + "; ".join(sd["key_points"]))
            if sd.get("topics"):
                parts.append("Topics: " + ", ".join(sd["topics"]))
            if sd.get("summary"):
                parts.append("Summary: " + sd["summary"][:2000])
            themes = "\n".join(parts)

        if not themes:
            # Fall back to truncated transcript for theme extraction
            themes = truncate_transcript(transcript, 8000)

        # Enrich themes with NotebookLM pre-analysis if available
        if nlm_context:
            themes += nlm_context

        prompt = _REWRITE_PROMPT.format(
            title=title, author=author, url=url, themes=themes,
        )

        result = await call_claude(prompt, model=config.CLAUDE_MODEL, timeout=180)

        # Save as brain node with structured content
        node = {
            "id": str(uuid.uuid4()),
            "type": "note",
            "title": f"Content Pack: {title}",
            "content": (
                f"**Source Topic:** {title} by {author}\n"
                f"**URL:** {url}\n"
                f"**Generated:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n\n"
                f"---\n\n{result}"
            ),
            "tags": ["youtube", "rewrite", "content-pack", "video-script", "blog"],
            "metadata": {
                "source": "youtube-rewrite",
                "video_url": url,
                "author": author or "",
                "research_session": session_id,
            },
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        await _sb_post("brain_nodes", node)

        await _sb_patch_research(session_id, {
            "status": "completed",
            "result_text": result[:5000],
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        log.info("[YouTube] Rewrite completed for session %s", session_id[:8])

    except Exception as e:
        log.error("[YouTube] Rewrite failed for session %s: %s", session_id[:8], e)
        await _sb_patch_research(session_id, {
            "status": "failed",
            "result_text": f"Error: {e}",
        })


@router.post("/api/youtube/rewrite")
async def youtube_rewrite(req: YouTubeRewriteRequest, bg: BackgroundTasks):
    """Generate original content pack (video script, blog, social posts) from a video's topics."""

    title = req.title
    author = req.author or ""
    transcript = req.transcript

    if not transcript:
        info = await process_video(req.url)
        if info.get("error") and not info.get("transcript"):
            raise HTTPException(status_code=422, detail=info["error"])
        title = title or info.get("title", "")
        author = author or info.get("author", "")
        transcript = info.get("transcript", "")

    if not transcript:
        raise HTTPException(status_code=422, detail="No transcript available for this video")

    session_id = str(uuid.uuid4())
    session = {
        "id": session_id,
        "query": f"YouTube Rewrite: {title or req.url}",
        "status": "queued",
        "scope": "youtube-rewrite",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    await _sb_post("brain_research", session)
    bg.add_task(
        _run_youtube_rewrite, session_id, title or "Video", author,
        transcript, req.url, req.summary_data,
    )

    log.info("[YouTube] Rewrite session created %s for: %s", session_id[:8], title)
    return {"id": session_id, "status": "queued"}
