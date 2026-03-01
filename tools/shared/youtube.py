"""OPAI Shared YouTube — transcript fetching, metadata, and summarization.

Usage in any OPAI FastAPI service:

    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
    from youtube import process_video, summarize_video

    info = await process_video("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    summary = await summarize_video(info)
"""

import asyncio
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

# ── Proxy Configuration ──────────────────────────────────────────────────────

# SOCKS5 proxy via SSH tunnel for bypassing YouTube IP blocks.
# Preferred: NAS at home (residential IP): ssh -D 1080 -q -N dallas@100.113.66.23 &
# Fallback: BB VPS (cloud IP, may be blocked): ssh -D 1080 -q -N root@72.60.115.74 &
# Or use the helper: scripts/web-fetch-fallback.sh --tunnel
PROXY_URL = os.environ.get("OPAI_YT_PROXY", "socks5://127.0.0.1:1080")


def get_proxy_config():
    """Return a GenericProxyConfig if a SOCKS5 tunnel is active, else None."""
    import socket
    try:
        # Check if SOCKS5 proxy is listening
        host, port = "127.0.0.1", 1080
        proxy_env = os.environ.get("OPAI_YT_PROXY", "")
        if proxy_env:
            # Parse socks5://host:port
            parts = proxy_env.replace("socks5://", "").replace("socks5h://", "").split(":")
            host = parts[0] if parts else "127.0.0.1"
            port = int(parts[1]) if len(parts) > 1 else 1080

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex((host, port))
        sock.close()
        if result == 0:
            from youtube_transcript_api.proxies import GenericProxyConfig
            return GenericProxyConfig(
                http_url=f"socks5h://{host}:{port}",
                https_url=f"socks5h://{host}:{port}",
            )
    except Exception:
        pass
    return None

# ── URL Parsing ──────────────────────────────────────────────────────────────

# Matches: watch?v=, youtu.be/, shorts/, embed/, live/, v/
_YT_PATTERNS = [
    re.compile(r"(?:youtube\.com/watch\?.*v=|youtu\.be/)([\w-]{11})"),
    re.compile(r"youtube\.com/(?:shorts|embed|live|v)/([\w-]{11})"),
]

_YT_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:youtube\.com|youtu\.be)/\S+"
)


def extract_video_id(url: str) -> Optional[str]:
    """Extract the 11-char video ID from any YouTube URL format."""
    for pat in _YT_PATTERNS:
        m = pat.search(url)
        if m:
            return m.group(1)
    return None


def is_youtube_url(text: str) -> bool:
    """Quick check if text contains a YouTube URL."""
    return bool(_YT_URL_RE.search(text))


def extract_youtube_url(text: str) -> Optional[str]:
    """Extract the first YouTube URL from text."""
    m = _YT_URL_RE.search(text)
    return m.group(0) if m else None


# ── Metadata (oEmbed, no API key) ───────────────────────────────────────────

async def fetch_metadata(video_id: str) -> dict:
    """Fetch video metadata via YouTube oEmbed API (no key needed).

    Returns dict with title, author, thumbnail_url, or empty values on failure.
    """
    oembed_url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(oembed_url)
            resp.raise_for_status()
            data = resp.json()
            return {
                "title": data.get("title", ""),
                "author": data.get("author_name", ""),
                "thumbnail_url": data.get("thumbnail_url", ""),
            }
    except Exception:
        return {"title": "", "author": "", "thumbnail_url": ""}


# ── Transcript ───────────────────────────────────────────────────────────────

def _fetch_transcript_sync(video_id: str, languages: list[str] = None) -> dict:
    """Synchronous transcript fetch (runs in thread pool).

    Returns {"text": str, "segments": list, "language": str} or raises.
    Uses SOCKS5 proxy when available (BB VPS tunnel) to bypass IP rate limits.
    """
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import IpBlocked

    langs = languages or ["en"]

    # Try direct first, fall back to proxy on IP block
    try:
        api = YouTubeTranscriptApi()
        transcript = api.fetch(video_id, languages=langs)
    except IpBlocked:
        proxy_config = get_proxy_config()
        if proxy_config:
            api = YouTubeTranscriptApi(proxy_config=proxy_config)
            transcript = api.fetch(video_id, languages=langs)
        else:
            raise

    segments = []
    text_parts = []
    for snippet in transcript:
        segments.append({
            "text": snippet.text,
            "start": snippet.start,
            "duration": snippet.duration,
        })
        text_parts.append(snippet.text)

    return {
        "text": " ".join(text_parts),
        "segments": segments,
        "language": langs[0],
    }


async def fetch_transcript(
    video_id: str, languages: list[str] = None
) -> dict:
    """Async wrapper: fetch transcript via youtube-transcript-api.

    Returns {"text": str, "segments": list, "language": str}.
    Raises RuntimeError if transcript unavailable.
    Auto-falls back to SOCKS5 proxy on IP block.
    """
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(
            None, _fetch_transcript_sync, video_id, languages
        )
    except Exception as e:
        raise RuntimeError(f"Transcript unavailable for {video_id}: {e}")


# ── Smart Truncation ─────────────────────────────────────────────────────────

def truncate_transcript(text: str, max_chars: int = 80000) -> str:
    """Smart truncation: keep first 20%, sample middle, keep last 10%."""
    if len(text) <= max_chars:
        return text

    first_len = int(max_chars * 0.2)
    last_len = int(max_chars * 0.1)
    middle_budget = max_chars - first_len - last_len - 50  # 50 for marker

    first = text[:first_len]
    last = text[-last_len:]

    # Sample evenly from the middle
    middle_text = text[first_len:-last_len] if last_len else text[first_len:]
    if len(middle_text) > middle_budget:
        step = len(middle_text) // (middle_budget // 200)  # ~200 char chunks
        chunks = []
        pos = 0
        while pos < len(middle_text) and len(" ".join(chunks)) < middle_budget:
            chunks.append(middle_text[pos:pos + 200])
            pos += step
        middle_sampled = " ".join(chunks)[:middle_budget]
    else:
        middle_sampled = middle_text

    return first + "\n[...transcript truncated...]\n" + middle_sampled + "\n[...]\n" + last


# ── Combined Processor ───────────────────────────────────────────────────────

async def process_video(url: str) -> dict:
    """Full pipeline: extract ID, fetch metadata + transcript.

    Returns a YouTubeVideoInfo dict:
    {
        "video_id": str,
        "url": str,
        "title": str,
        "author": str,
        "thumbnail_url": str,
        "transcript": str,
        "segments": list,
        "language": str,
        "fetched_at": str (ISO UTC),
        "error": str | None,
    }
    """
    video_id = extract_video_id(url)
    if not video_id:
        return {"error": f"Could not extract video ID from: {url}", "url": url}

    # Fetch metadata and transcript concurrently
    meta_task = fetch_metadata(video_id)
    transcript_task = fetch_transcript(video_id)

    meta = await meta_task
    try:
        transcript_data = await transcript_task
    except RuntimeError as e:
        return {
            "video_id": video_id,
            "url": url,
            **meta,
            "transcript": "",
            "segments": [],
            "language": "",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "error": str(e),
        }

    return {
        "video_id": video_id,
        "url": url,
        **meta,
        "transcript": transcript_data["text"],
        "segments": transcript_data["segments"],
        "language": transcript_data["language"],
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
    }


# ── Claude Summarization ────────────────────────────────────────────────────

async def summarize_video(
    video_info: dict,
    model: str = "claude-sonnet-4-6",
    timeout: int = 120,
) -> dict:
    """Summarize a video using Claude CLI (no API key — uses subscription).

    Returns {"description": str, "key_points": list, "topics": list, "summary": str}.
    """
    title = video_info.get("title", "Unknown")
    author = video_info.get("author", "Unknown")
    transcript = video_info.get("transcript", "")

    if not transcript:
        return {
            "description": f"Video by {author}: {title} (no transcript available)",
            "key_points": [],
            "topics": [],
            "summary": "Transcript was not available for this video.",
        }

    truncated = truncate_transcript(transcript, 60000)

    prompt = f"""Analyze this YouTube video and provide a structured summary.

Video: "{title}" by {author}

Transcript:
{truncated}

Respond in this EXACT JSON format (no markdown, no code fences):
{{"description": "1-2 sentence description of the video", "key_points": ["point 1", "point 2", "point 3"], "topics": ["topic1", "topic2"], "summary": "3-5 paragraph detailed summary"}}"""

    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    proc = await asyncio.create_subprocess_exec(
        "claude", "--print", "--output-format", "text", "--model", model, prompt,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return {
            "description": f"Video by {author}: {title}",
            "key_points": [],
            "topics": [],
            "summary": "Summarization timed out.",
        }

    text = stdout.decode().strip()

    # Try to parse JSON response
    try:
        # Strip any markdown fences Claude might add
        cleaned = re.sub(r"^```(?:json)?\s*", "", text, flags=re.MULTILINE)
        cleaned = re.sub(r"```\s*$", "", cleaned, flags=re.MULTILINE).strip()
        result = json.loads(cleaned)
        return {
            "description": result.get("description", ""),
            "key_points": result.get("key_points", []),
            "topics": result.get("topics", []),
            "summary": result.get("summary", ""),
        }
    except (json.JSONDecodeError, KeyError):
        # Fallback: return raw text as summary
        return {
            "description": f"Video by {author}: {title}",
            "key_points": [],
            "topics": [],
            "summary": text[:3000],
        }


# ── CLI entry point (for Node.js wrapper) ───────────────────────────────────

async def _cli_main():
    """CLI mode: process a URL passed as argument, output JSON to stdout."""
    import sys as _sys

    if len(_sys.argv) < 2:
        print(json.dumps({"error": "Usage: python youtube.py <url> [--summarize]"}))
        _sys.exit(1)

    url = _sys.argv[1]
    do_summarize = "--summarize" in _sys.argv

    info = await process_video(url)
    if info.get("error") and not info.get("transcript"):
        print(json.dumps(info))
        _sys.exit(1)

    if do_summarize:
        summary = await summarize_video(info)
        info["summary_data"] = summary
        # Don't send full segments in CLI output (too large)
        info.pop("segments", None)

    # Truncate transcript for JSON output to keep it reasonable
    if info.get("transcript") and len(info["transcript"]) > 100000:
        info["transcript"] = truncate_transcript(info["transcript"], 100000)
    info.pop("segments", None)

    print(json.dumps(info))


if __name__ == "__main__":
    asyncio.run(_cli_main())
