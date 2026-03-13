"""2nd Brain — Instagram save/research/rewrite routes.

Mirrors routes/youtube.py for Instagram reels.
"""
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
from instagram import process_reel, truncate_transcript

sys.path.insert(0, str(Path(__file__).parent.parent))
from claude_cli import call_claude
import config

log = logging.getLogger("brain.routes.instagram")
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


async def _sb_patch_research(session_id: str, body: dict):
    url = f"{config.SUPABASE_URL}/rest/v1/brain_research?id=eq.{session_id}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.patch(url, headers=_svc_headers(), json=body)
        r.raise_for_status()


# ── Models ───────────────────────────────────────────────────────────────────

class InstagramSaveRequest(BaseModel):
    url: str
    caption: Optional[str] = None
    author: Optional[str] = None
    transcript: Optional[str] = None
    hashtags: Optional[list[str]] = None
    metadata: Optional[dict] = None


class InstagramResearchRequest(BaseModel):
    url: str
    caption: Optional[str] = None
    author: Optional[str] = None
    transcript: Optional[str] = None


class InstagramRewriteRequest(BaseModel):
    url: str
    caption: Optional[str] = None
    author: Optional[str] = None
    transcript: Optional[str] = None
    hashtags: Optional[list[str]] = None
    metadata: Optional[dict] = None


# ── Save to Brain ────────────────────────────────────────────────────────────

@router.post("/api/instagram/save")
async def instagram_save(req: InstagramSaveRequest):
    """Save an Instagram reel as a Brain node (note with transcript + tags)."""

    caption = req.caption
    author = req.author
    transcript = req.transcript
    hashtags = req.hashtags or []
    meta = req.metadata or {}

    # If minimal data, fetch it
    if not caption and not transcript:
        info = await process_reel(req.url, mode="intel", include_frames=False)
        if info.get("error") and not info.get("caption") and not info.get("transcript"):
            raise HTTPException(status_code=422, detail=info.get("error", "Failed to fetch reel"))
        caption = caption or info.get("caption", "")
        author = author or info.get("author", "")
        transcript = transcript or info.get("transcript", "")
        hashtags = hashtags or info.get("hashtags", [])
        meta = {
            "likes": info.get("likes"),
            "views": info.get("views"),
            "comments": info.get("comments"),
            "music": info.get("music"),
            "duration": info.get("duration"),
        }

    # Build node content
    content_parts = []
    if author:
        content_parts.append(f"**Author:** @{author}")
    content_parts.append(f"**URL:** {req.url}")
    if meta.get("likes") is not None:
        content_parts.append(f"**Likes:** {meta['likes']:,}")
    if meta.get("views") is not None:
        content_parts.append(f"**Views:** {meta['views']:,}")
    if meta.get("music"):
        content_parts.append(f"**Music:** {meta['music']}")
    content_parts.append("")

    if caption:
        content_parts.append("## Caption")
        content_parts.append(caption)
        content_parts.append("")

    if transcript:
        content_parts.append("## Transcript")
        content_parts.append(truncate_transcript(transcript, 80000))
        content_parts.append("")

    content = "\n".join(content_parts)

    # Tags
    tags = ["instagram", "reel"]
    for ht in hashtags[:10]:
        tag = ht.lower().strip("#")
        if tag and tag not in tags:
            tags.append(tag)

    # Create brain node
    from instagram import extract_shortcode
    shortcode = extract_shortcode(req.url) or ""

    node = {
        "id": str(uuid.uuid4()),
        "type": "note",
        "title": f"IG Reel: {caption[:60]}..." if caption and len(caption) > 60 else f"IG Reel: {caption or shortcode}",
        "content": content,
        "tags": tags,
        "metadata": {
            "source": "instagram",
            "reel_url": req.url,
            "shortcode": shortcode,
            "author": author or "",
            "likes": meta.get("likes"),
            "views": meta.get("views"),
            "music": meta.get("music", ""),
        },
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    result = await _sb_post("brain_nodes", node)
    log.info("[Instagram] Saved node %s: %s", result.get("id", "?")[:8], node["title"][:50])
    return {"id": result.get("id"), "title": node["title"]}


# ── Research from Reel ───────────────────────────────────────────────────────

async def _run_instagram_research(session_id: str, caption: str, author: str, transcript: str, url: str):
    """Background: run research on the reel content.

    Uses NotebookLM when available (adds transcript as text source, grounded Q&A),
    falls back to Claude CLI.
    """
    analysis_source = "claude"

    try:
        await _sb_patch_research(session_id, {"status": "running"})

        result = None

        # Try NotebookLM first
        try:
            from nlm import (
                is_available, get_client, ensure_notebook,
                add_source_text, ask_notebook,
            )

            if is_available() and (transcript or caption):
                client = await get_client()
                async with client:
                    nb_id = await ensure_notebook(client, "Instagram Research")

                    # Add reel content as text source
                    source_content = ""
                    if caption:
                        source_content += f"Caption: {caption}\n\n"
                    if transcript:
                        source_content += f"Transcript: {transcript}"
                    await add_source_text(client, nb_id, f"IG Reel by @{author}", source_content[:50000])

                    research_prompt = (
                        f"Analyze this Instagram reel by @{author} deeply. Provide:\n"
                        f"1. Key themes and messaging strategy\n"
                        f"2. Content format analysis (hook, pacing, CTA)\n"
                        f"3. Target audience and engagement tactics\n"
                        f"4. How to create similar content (actionable steps)\n"
                        f"5. Potential business applications or opportunities"
                    )
                    nlm_result = await ask_notebook(client, nb_id, research_prompt)
                    nlm_answer = nlm_result.get("answer", "")

                    if len(nlm_answer) > 200:
                        result = nlm_answer
                        analysis_source = "notebooklm"
                        log.info("[Instagram] NotebookLM research succeeded for session %s", session_id[:8])

        except Exception as nlm_err:
            log.warning("[Instagram] NotebookLM unavailable, falling back to Claude: %s", nlm_err)

        # Fallback to Claude
        if not result:
            parts = [
                f"Research and analyze this Instagram reel deeply.\n",
                f"Reel URL: {url}",
            ]
            if author:
                parts.append(f"Author: @{author}")
            if caption:
                parts.append(f"\nCaption:\n{caption[:2000]}")
            if transcript:
                truncated = truncate_transcript(transcript, 60000)
                parts.append(f"\nTranscript:\n{truncated}")

            parts.append(
                "\n\nProvide:\n"
                "1. Key themes and messaging strategy\n"
                "2. Content format analysis (hook, pacing, CTA)\n"
                "3. Target audience and engagement tactics\n"
                "4. How to create similar content (actionable steps)\n"
                "5. Potential business applications or opportunities"
            )

            prompt = "\n".join(parts)
            result = await call_claude(prompt, model=config.CLAUDE_MODEL, timeout=120)
            analysis_source = "claude"

        # Create a brain node with the research
        node = {
            "id": str(uuid.uuid4()),
            "type": "note",
            "title": f"Research: IG Reel by @{author or 'unknown'}",
            "content": result,
            "tags": ["instagram", "research"],
            "metadata": {
                "source": "instagram-research",
                "reel_url": url,
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
        log.info("[Instagram] Research completed for session %s", session_id[:8])

    except Exception as e:
        log.error("[Instagram] Research failed for session %s: %s", session_id[:8], e)
        await _sb_patch_research(session_id, {
            "status": "failed",
            "result_text": f"Error: {e}",
        })


@router.post("/api/instagram/research")
async def instagram_research(req: InstagramResearchRequest, bg: BackgroundTasks):
    """Create a research session seeded from an Instagram reel."""

    caption = req.caption or ""
    author = req.author or ""
    transcript = req.transcript or ""

    # Fetch if we don't have content
    if not caption and not transcript:
        info = await process_reel(req.url, mode="intel", include_frames=False)
        if info.get("error") and not info.get("caption") and not info.get("transcript"):
            raise HTTPException(status_code=422, detail=info.get("error", "Failed to fetch reel"))
        caption = info.get("caption", "")
        author = author or info.get("author", "")
        transcript = info.get("transcript", "")

    if not caption and not transcript:
        raise HTTPException(status_code=422, detail="No caption or transcript available for this reel")

    session_id = str(uuid.uuid4())
    session = {
        "id": session_id,
        "query": f"Instagram Research: @{author or 'unknown'} reel",
        "status": "queued",
        "scope": "instagram",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    await _sb_post("brain_research", session)
    bg.add_task(_run_instagram_research, session_id, caption, author, transcript, req.url)

    log.info("[Instagram] Research session created %s for: @%s", session_id[:8], author)
    return {"id": session_id, "status": "queued"}


# ── Re-Write from Reel ──────────────────────────────────────────────────────

_REWRITE_PROMPT = """You are a professional content creator. A user watched an Instagram reel and wants to create their OWN original content inspired by the same TOPIC.

Your job is NOT to copy or paraphrase the original reel. Instead:
- Extract the core TOPIC and THEMES only
- Create 100% original content from YOUR OWN perspective and angle
- Use different examples, different structure, different arguments
- The output must be fully original

SOURCE REEL (for topic reference only — do NOT copy):
Author: @{author}
URL: {url}
Caption: {caption}

Key themes:
{themes}

---

Produce ALL of the following sections:

## REEL SCRIPT
A complete script for recording an original Instagram reel on this same topic.
Include: hook (first 3 seconds), main content with visual cues, CTA.
Target length: 30-90 seconds.

## CAROUSEL POST
A 5-7 slide carousel post. Format each slide as:
**Slide 1:** [Content]
Cover slide should have a compelling headline.

## BLOG POST
A full, publish-ready blog post (800-1200 words). Original angle, original examples.
Include: compelling headline, intro hook, subheadings, conclusion with CTA.

## X POST (TWITTER)
A punchy tweet or short thread (max 280 chars per tweet, up to 4 tweets).
Include 1-2 hashtags.

## LINKEDIN POST
A professional LinkedIn post (200-400 words). Thought-leadership angle.
Include 3-5 hashtags at the end.

---

Every piece of content must be YOUR original take on the TOPIC — never a derivative of the source reel."""


async def _run_instagram_rewrite(
    session_id: str, caption: str, author: str, transcript: str,
    url: str, hashtags: list,
):
    """Background: run Claude re-write content generation from reel topics."""
    try:
        await _sb_patch_research(session_id, {"status": "running"})

        # Build theme summary
        themes_parts = []
        if hashtags:
            themes_parts.append("Hashtags: #" + " #".join(hashtags[:15]))
        if transcript:
            themes_parts.append("Transcript themes: " + truncate_transcript(transcript, 8000))
        if not themes_parts:
            themes_parts.append(caption[:2000] if caption else "No content available")

        themes = "\n".join(themes_parts)

        prompt = _REWRITE_PROMPT.format(
            author=author, url=url,
            caption=caption[:1000] if caption else "(none)",
            themes=themes,
        )

        result = await call_claude(prompt, model=config.CLAUDE_MODEL, timeout=180)

        # Save as brain node
        node = {
            "id": str(uuid.uuid4()),
            "type": "note",
            "title": f"Content Pack: IG Reel by @{author or 'unknown'}",
            "content": (
                f"**Source:** Instagram reel by @{author}\n"
                f"**URL:** {url}\n"
                f"**Generated:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n\n"
                f"---\n\n{result}"
            ),
            "tags": ["instagram", "rewrite", "content-pack", "reel-script", "blog"],
            "metadata": {
                "source": "instagram-rewrite",
                "reel_url": url,
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
        log.info("[Instagram] Rewrite completed for session %s", session_id[:8])

    except Exception as e:
        log.error("[Instagram] Rewrite failed for session %s: %s", session_id[:8], e)
        await _sb_patch_research(session_id, {
            "status": "failed",
            "result_text": f"Error: {e}",
        })


@router.post("/api/instagram/rewrite")
async def instagram_rewrite(req: InstagramRewriteRequest, bg: BackgroundTasks):
    """Generate original content pack (reel script, carousel, blog, social posts) from a reel's topics."""

    caption = req.caption or ""
    author = req.author or ""
    transcript = req.transcript or ""
    hashtags = req.hashtags or []

    if not caption and not transcript:
        info = await process_reel(req.url, mode="intel", include_frames=False)
        if info.get("error") and not info.get("caption") and not info.get("transcript"):
            raise HTTPException(status_code=422, detail=info.get("error", "Failed to fetch reel"))
        caption = info.get("caption", "")
        author = author or info.get("author", "")
        transcript = info.get("transcript", "")
        hashtags = hashtags or info.get("hashtags", [])

    if not caption and not transcript:
        raise HTTPException(status_code=422, detail="No caption or transcript available for this reel")

    session_id = str(uuid.uuid4())
    session = {
        "id": session_id,
        "query": f"Instagram Rewrite: @{author or 'unknown'} reel",
        "status": "queued",
        "scope": "instagram-rewrite",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    await _sb_post("brain_research", session)
    bg.add_task(
        _run_instagram_rewrite, session_id, caption, author,
        transcript, req.url, hashtags,
    )

    log.info("[Instagram] Rewrite session created %s for: @%s", session_id[:8], author)
    return {"id": session_id, "status": "queued"}
