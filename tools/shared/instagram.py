"""OPAI Shared Instagram — reel scraping, frame extraction, and analysis.

Two analysis modes:
    - **Build mode**: Frames + transcript → structured build guide (materials, steps, etc.)
    - **Intel mode**: Transcript + metadata → content strategy analysis (hook, virality, etc.)

Usage in any OPAI service:

    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
    from instagram import process_reel, is_instagram_url

    info = await process_reel("https://www.instagram.com/reel/XXXXX/", mode="intel")

Data providers:
    1. yt-dlp (video download + basic metadata, free, local)
    2. Bright Data API (rich engagement data: likes, views, comments, shares)
    3. Supadata API (transcript — shared 100/month pool with YouTube)
    4. ffmpeg (frame extraction from downloaded video)
    5. Claude CLI with --image (Vision analysis for build mode)
"""

import asyncio
import base64
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

log = logging.getLogger("opai.instagram")


# ── URL Parsing ──────────────────────────────────────────────────────────────

# Matches: instagram.com/reel/, instagram.com/reels/, instagram.com/p/, instagram.com/tv/
_IG_PATTERNS = [
    re.compile(r"instagram\.com/(?:reel|reels|p|tv)/([\w-]+)"),
]

_IG_URL_RE = re.compile(
    r"https?://(?:www\.)?instagram\.com/(?:reel|reels|p|tv)/[\w-]+/?(?:\?[^\s]*)?"
)


def extract_shortcode(url: str) -> Optional[str]:
    """Extract the shortcode from any Instagram URL format."""
    for pat in _IG_PATTERNS:
        m = pat.search(url)
        if m:
            return m.group(1)
    return None


def is_instagram_url(text: str) -> bool:
    """Quick check if text contains an Instagram reel/post URL."""
    return bool(_IG_URL_RE.search(text))


def extract_instagram_url(text: str) -> Optional[str]:
    """Extract the first Instagram URL from text."""
    m = _IG_URL_RE.search(text)
    return m.group(0) if m else None


# ── Temp Workspace ───────────────────────────────────────────────────────────

@contextmanager
def _temp_workspace():
    """Context manager for a temp directory that auto-cleans on exit."""
    tmpdir = tempfile.mkdtemp(prefix="opai-ig-")
    try:
        yield Path(tmpdir)
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


# ── Transcript (Supadata) ────────────────────────────────────────────────────

async def fetch_transcript(url: str) -> Optional[dict]:
    """Fetch transcript via Supadata API.

    Shares the 100/month pool with YouTube.
    Returns {"text": str, "segments": list, "language": str} or None.
    """
    from supadata import fetch_transcript_supadata
    return await fetch_transcript_supadata(url, source="instagram")


# ── Metadata ─────────────────────────────────────────────────────────────────

def _get_brightdata_token() -> Optional[str]:
    """Get Bright Data API token from env or vault."""
    key = os.environ.get("BRIGHTDATA_API_TOKEN")
    if key:
        return key
    try:
        result = subprocess.run(
            ["python3", "-c",
             "import sys; sys.path.insert(0, '/workspace/synced/opai/tools/opai-vault'); "
             "import store; print(store.get_secret('BRIGHTDATA_API_TOKEN') or '')"],
            capture_output=True, text=True, timeout=5,
        )
        val = result.stdout.strip()
        return val if val else None
    except Exception:
        return None


async def _fetch_metadata_brightdata(url: str) -> Optional[dict]:
    """Fetch rich metadata via Bright Data API (engagement data, hashtags, music)."""
    token = _get_brightdata_token()
    if not token:
        log.debug("[Instagram] No Bright Data API token — skipping")
        return None

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            # Bright Data Social Media API endpoint
            resp = await client.post(
                "https://api.brightdata.com/datasets/v3/trigger",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=[{"url": url}],
                params={"dataset_id": "gd_lyclf20il4r5helnj", "format": "json", "type": "discover_new"},
            )
            resp.raise_for_status()
            snapshot_id = resp.json().get("snapshot_id")
            if not snapshot_id:
                return None

            # Poll for results (up to 30s)
            for _ in range(6):
                await asyncio.sleep(5)
                result_resp = await client.get(
                    f"https://api.brightdata.com/datasets/v3/snapshot/{snapshot_id}",
                    headers={"Authorization": f"Bearer {token}"},
                    params={"format": "json"},
                )
                if result_resp.status_code == 200:
                    data = result_resp.json()
                    if isinstance(data, list) and data:
                        item = data[0]
                        return {
                            "author": item.get("author", {}).get("username", ""),
                            "author_name": item.get("author", {}).get("full_name", ""),
                            "caption": item.get("caption", ""),
                            "hashtags": item.get("hashtags", []),
                            "likes": item.get("likes_count"),
                            "comments": item.get("comments_count"),
                            "views": item.get("views_count"),
                            "shares": item.get("shares_count"),
                            "duration": item.get("duration"),
                            "music": item.get("music", {}).get("title", ""),
                            "thumbnail_url": item.get("thumbnail_url", ""),
                            "posted_at": item.get("posted_at", ""),
                            "source": "brightdata",
                        }
                elif result_resp.status_code != 202:
                    break

    except Exception as e:
        log.warning("[Instagram] Bright Data metadata fetch failed: %s", e)

    return None


async def _fetch_metadata_ytdlp(url: str) -> Optional[dict]:
    """Fetch basic metadata via yt-dlp --dump-json (free fallback)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp", "--dump-json", "--no-download", "--no-warnings",
            "--socket-timeout", "15", url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)

        if proc.returncode != 0:
            err = stderr.decode().strip()[:200]
            log.warning("[Instagram] yt-dlp metadata failed: %s", err)
            return None

        data = json.loads(stdout.decode())
        return {
            "author": data.get("uploader_id", data.get("channel", "")),
            "author_name": data.get("uploader", data.get("creator", "")),
            "caption": data.get("description", ""),
            "hashtags": _extract_hashtags(data.get("description", "")),
            "likes": data.get("like_count"),
            "comments": data.get("comment_count"),
            "views": data.get("view_count"),
            "shares": None,
            "duration": data.get("duration"),
            "music": "",
            "thumbnail_url": data.get("thumbnail", ""),
            "posted_at": data.get("upload_date", ""),
            "source": "yt-dlp",
        }

    except asyncio.TimeoutError:
        log.warning("[Instagram] yt-dlp metadata timed out")
        return None
    except Exception as e:
        log.warning("[Instagram] yt-dlp metadata error: %s", e)
        return None


def _extract_hashtags(text: str) -> list[str]:
    """Extract hashtags from caption text."""
    return re.findall(r"#(\w+)", text or "")


async def fetch_metadata(url: str) -> dict:
    """Fetch reel metadata. Tries Bright Data first, falls back to yt-dlp.

    Returns dict with author, caption, hashtags, engagement data, etc.
    """
    # Try Bright Data for rich engagement data
    result = await _fetch_metadata_brightdata(url)
    if result:
        return result

    # Fallback to yt-dlp
    result = await _fetch_metadata_ytdlp(url)
    if result:
        return result

    return {
        "author": "", "author_name": "", "caption": "",
        "hashtags": [], "likes": None, "comments": None,
        "views": None, "shares": None, "duration": None,
        "music": "", "thumbnail_url": "", "posted_at": "",
        "source": "none",
    }


# ── Video Download ───────────────────────────────────────────────────────────

async def download_video(url: str, output_dir: Path) -> Optional[Path]:
    """Download Instagram reel via yt-dlp. Returns path to video file or None."""
    output_template = str(output_dir / "reel.%(ext)s")
    try:
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp",
            "--no-warnings",
            "--socket-timeout", "15",
            "--max-filesize", "100m",
            "-o", output_template,
            url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)

        if proc.returncode != 0:
            err = stderr.decode().strip()[:200]
            log.warning("[Instagram] Video download failed: %s", err)
            return None

        # Find the downloaded file
        for f in output_dir.iterdir():
            if f.name.startswith("reel.") and f.suffix in (".mp4", ".webm", ".mkv"):
                log.info("[Instagram] Downloaded video: %s (%.1f MB)", f.name, f.stat().st_size / 1e6)
                return f

        return None

    except asyncio.TimeoutError:
        log.warning("[Instagram] Video download timed out")
        return None
    except Exception as e:
        log.warning("[Instagram] Video download error: %s", e)
        return None


# ── Frame Extraction ─────────────────────────────────────────────────────────

async def extract_frames(
    video_path: Path,
    count: int = 8,
    output_dir: Optional[Path] = None,
) -> list[Path]:
    """Extract evenly-spaced JPEG frames from a video using ffmpeg.

    Args:
        video_path: Path to the video file
        count: Number of frames to extract (default 8, max 12)
        output_dir: Directory to save frames (default: same as video)

    Returns:
        List of paths to extracted JPEG frames.
    """
    count = min(count, 12)
    out_dir = output_dir or video_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    # Get video duration
    try:
        probe = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", str(video_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(probe.communicate(), timeout=10)
        info = json.loads(stdout.decode())
        duration = float(info.get("format", {}).get("duration", 0))
    except Exception:
        duration = 0

    if duration <= 0:
        # Fallback: extract first N frames at 1fps
        duration = count

    # Skip > 10 min videos (cost/disk protection)
    if duration > 600:
        log.warning("[Instagram] Video too long (%.0fs > 600s), skipping frames", duration)
        return []

    # Calculate timestamps for evenly-spaced frames
    interval = duration / (count + 1)
    frame_paths = []

    for i in range(1, count + 1):
        timestamp = interval * i
        frame_path = out_dir / f"frame_{i:02d}.jpg"

        try:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-y", "-ss", str(timestamp),
                "-i", str(video_path),
                "-frames:v", "1",
                "-q:v", "2",
                str(frame_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=10)

            if frame_path.exists() and frame_path.stat().st_size > 0:
                frame_paths.append(frame_path)
        except Exception as e:
            log.warning("[Instagram] Frame extraction failed at %.1fs: %s", timestamp, e)

    log.info("[Instagram] Extracted %d/%d frames from video", len(frame_paths), count)
    return frame_paths


def frames_to_base64(frame_paths: list[Path]) -> list[dict]:
    """Convert frame files to base64-encoded dicts for API transport."""
    results = []
    for fp in frame_paths:
        try:
            data = fp.read_bytes()
            results.append({
                "filename": fp.name,
                "base64": base64.b64encode(data).decode("ascii"),
                "size_bytes": len(data),
            })
        except Exception:
            pass
    return results


# ── Vision Analysis (Claude CLI with --image) ───────────────────────────────

async def analyze_frames_vision(
    frame_paths: list[Path],
    transcript: Optional[str] = None,
    mode: str = "build",
    metadata: Optional[dict] = None,
    timeout: int = 120,
) -> dict:
    """Analyze extracted frames + transcript via Claude CLI Vision.

    Args:
        frame_paths: Paths to extracted JPEG frames
        transcript: Optional transcript text
        mode: "build" for tutorial extraction, "intel" for strategy analysis
        metadata: Optional metadata dict (caption, hashtags, etc.)
        timeout: CLI timeout in seconds

    Returns:
        Parsed JSON analysis result.
    """
    if not frame_paths:
        return {"error": "No frames provided for analysis"}

    if mode == "build":
        prompt = _build_prompt(transcript, metadata)
    else:
        prompt = _intel_prompt(transcript, metadata)

    # Build claude CLI args with --image flags
    args = ["claude", "--print", "--output-format", "text", "--model", "claude-sonnet-4-6"]
    for fp in frame_paths:
        args.extend(["--image", str(fp)])
    args.append(prompt)

    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return {"error": "Vision analysis timed out"}

    text = stdout.decode().strip()
    return _parse_json_response(text, mode)


def _build_prompt(transcript: Optional[str], metadata: Optional[dict]) -> str:
    """Generate the Build mode prompt for Vision analysis."""
    parts = [
        "Analyze these video frames from an Instagram tutorial reel. "
        "Extract a structured build/tutorial guide.\n"
    ]

    if metadata and metadata.get("caption"):
        parts.append(f"Caption: {metadata['caption'][:500]}\n")

    if transcript:
        from youtube import truncate_transcript
        parts.append(f"Transcript:\n{truncate_transcript(transcript, 15000)}\n")

    parts.append(
        "Respond in this EXACT JSON format (no markdown, no code fences):\n"
        '{"title": "descriptive title", '
        '"difficulty": "beginner|intermediate|advanced", '
        '"estimated_time": "time estimate", '
        '"materials": ["material 1", "material 2"], '
        '"tools": ["tool 1", "tool 2"], '
        '"steps": [{"step": 1, "description": "what to do", "visual_note": "what the frame shows"}], '
        '"safety_notes": ["note 1"], '
        '"tips": ["pro tip 1"]}'
    )
    return "\n".join(parts)


def _intel_prompt(transcript: Optional[str], metadata: Optional[dict]) -> str:
    """Generate the Intel mode prompt for strategy analysis."""
    parts = [
        "Analyze these video frames from a successful Instagram reel for content strategy insights.\n"
    ]

    if metadata:
        if metadata.get("caption"):
            parts.append(f"Caption: {metadata['caption'][:500]}")
        if metadata.get("likes") is not None:
            parts.append(f"Likes: {metadata['likes']}")
        if metadata.get("views") is not None:
            parts.append(f"Views: {metadata['views']}")
        if metadata.get("comments") is not None:
            parts.append(f"Comments: {metadata['comments']}")
        if metadata.get("hashtags"):
            parts.append(f"Hashtags: {', '.join(metadata['hashtags'][:20])}")
        if metadata.get("music"):
            parts.append(f"Music: {metadata['music']}")
        parts.append("")

    if transcript:
        from youtube import truncate_transcript
        parts.append(f"Transcript:\n{truncate_transcript(transcript, 15000)}\n")

    parts.append(
        "Respond in this EXACT JSON format (no markdown, no code fences):\n"
        '{"hook_analysis": "how the first 3 seconds grab attention", '
        '"content_structure": "pacing, transitions, visual flow", '
        '"virality_factors": ["factor 1", "factor 2"], '
        '"engagement_ratio": "assessment of likes/views/comments ratio", '
        '"target_audience": "who this appeals to", '
        '"replication_tips": ["actionable tip 1", "tip 2"], '
        '"content_format": "type of content (tutorial, story, trend, etc.)", '
        '"estimated_production_effort": "low|medium|high"}'
    )
    return "\n".join(parts)


def _parse_json_response(text: str, mode: str) -> dict:
    """Parse Claude's JSON response, handling markdown fences."""
    try:
        cleaned = re.sub(r"^```(?:json)?\s*", "", text, flags=re.MULTILINE)
        cleaned = re.sub(r"```\s*$", "", cleaned, flags=re.MULTILINE).strip()
        result = json.loads(cleaned)
        result["_mode"] = mode
        return result
    except (json.JSONDecodeError, KeyError):
        return {"_mode": mode, "raw_analysis": text[:5000]}


# ── Text-Only Intel Analysis (no frames needed) ─────────────────────────────

async def analyze_intel_text(
    transcript: Optional[str] = None,
    metadata: Optional[dict] = None,
    timeout: int = 90,
) -> dict:
    """Run intel analysis using transcript + metadata only (no frames/Vision).

    Cheaper and faster than frame-based analysis.
    """
    parts = [
        "Analyze this Instagram reel for content strategy insights.\n"
    ]

    if metadata:
        if metadata.get("caption"):
            parts.append(f"Caption: {metadata['caption'][:1000]}")
        if metadata.get("author"):
            parts.append(f"Author: @{metadata['author']}")
        if metadata.get("likes") is not None:
            parts.append(f"Likes: {metadata['likes']}")
        if metadata.get("views") is not None:
            parts.append(f"Views: {metadata['views']}")
        if metadata.get("comments") is not None:
            parts.append(f"Comments: {metadata['comments']}")
        if metadata.get("shares") is not None:
            parts.append(f"Shares: {metadata['shares']}")
        if metadata.get("hashtags"):
            parts.append(f"Hashtags: #{' #'.join(metadata['hashtags'][:20])}")
        if metadata.get("music"):
            parts.append(f"Music: {metadata['music']}")
        if metadata.get("duration"):
            parts.append(f"Duration: {metadata['duration']}s")
        parts.append("")

    if transcript:
        from youtube import truncate_transcript
        parts.append(f"Transcript:\n{truncate_transcript(transcript, 30000)}\n")

    parts.append(
        "Respond in this EXACT JSON format (no markdown, no code fences):\n"
        '{"hook_analysis": "how the first 3 seconds grab attention", '
        '"content_structure": "pacing, transitions, narrative flow", '
        '"virality_factors": ["factor 1", "factor 2", "factor 3"], '
        '"engagement_ratio": "assessment of engagement metrics", '
        '"target_audience": "who this appeals to", '
        '"replication_tips": ["actionable tip 1", "tip 2", "tip 3"], '
        '"content_format": "type of content (tutorial, story, trend, etc.)", '
        '"estimated_production_effort": "low|medium|high"}'
    )

    prompt = "\n".join(parts)

    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    proc = await asyncio.create_subprocess_exec(
        "claude", "--print", "--output-format", "text",
        "--model", "claude-sonnet-4-6", prompt,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return {"error": "Intel analysis timed out"}

    text = stdout.decode().strip()
    return _parse_json_response(text, "intel")


# ── Smart Truncation (re-export from youtube) ────────────────────────────────

def truncate_transcript(text: str, max_chars: int = 80000) -> str:
    """Smart truncation: keep first 20%, sample middle, keep last 10%."""
    from youtube import truncate_transcript as _yt_truncate
    return _yt_truncate(text, max_chars)


# ── Combined Processor ───────────────────────────────────────────────────────

async def process_reel(
    url: str,
    mode: str = "intel",
    include_frames: bool = False,
    frame_count: int = 8,
) -> dict:
    """Full pipeline: metadata + transcript + optional frames + analysis.

    Args:
        url: Instagram reel URL
        mode: "intel" (content strategy) or "build" (tutorial extraction)
        include_frames: Whether to download video and extract frames
        frame_count: Number of frames to extract (default 8, max 12)

    Returns:
        ReelInfo dict with metadata, transcript, optional analysis.
    """
    shortcode = extract_shortcode(url)
    if not shortcode:
        return {"error": f"Could not extract shortcode from: {url}", "url": url}

    # Normalize URL
    if not url.startswith("http"):
        url = "https://" + url
    canonical_url = f"https://www.instagram.com/reel/{shortcode}/"

    # Fetch metadata and transcript concurrently
    meta_task = fetch_metadata(canonical_url)
    transcript_task = fetch_transcript(canonical_url)

    meta = await meta_task
    transcript_data = await transcript_task

    result = {
        "shortcode": shortcode,
        "url": canonical_url,
        "author": meta.get("author", ""),
        "author_name": meta.get("author_name", ""),
        "caption": meta.get("caption", ""),
        "hashtags": meta.get("hashtags", []),
        "likes": meta.get("likes"),
        "comments": meta.get("comments"),
        "views": meta.get("views"),
        "shares": meta.get("shares"),
        "duration": meta.get("duration"),
        "music": meta.get("music", ""),
        "thumbnail_url": meta.get("thumbnail_url", ""),
        "posted_at": meta.get("posted_at", ""),
        "metadata_source": meta.get("source", "none"),
        "transcript": transcript_data["text"] if transcript_data else "",
        "segments": transcript_data.get("segments", []) if transcript_data else [],
        "language": transcript_data.get("language", "") if transcript_data else "",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "mode": mode,
        "error": None,
    }

    # Frame extraction + analysis (only when explicitly requested)
    if include_frames:
        with _temp_workspace() as tmpdir:
            video_path = await download_video(canonical_url, tmpdir)
            if video_path:
                frames = await extract_frames(video_path, count=frame_count, output_dir=tmpdir)
                if frames:
                    analysis = await analyze_frames_vision(
                        frames,
                        transcript=result["transcript"],
                        mode=mode,
                        metadata=meta,
                    )
                    result["analysis"] = analysis
                    result["frame_count"] = len(frames)
                else:
                    result["analysis"] = {"error": "No frames extracted"}
                    result["frame_count"] = 0
            else:
                result["analysis"] = {"error": "Video download failed"}
                result["frame_count"] = 0
    elif mode == "intel" and (result["transcript"] or meta.get("caption")):
        # Text-only intel analysis (no frames, cheaper)
        analysis = await analyze_intel_text(
            transcript=result["transcript"],
            metadata=meta,
        )
        result["analysis"] = analysis

    return result


# ── CLI entry point ──────────────────────────────────────────────────────────

async def _cli_main():
    """CLI mode: process a URL passed as argument, output JSON to stdout."""
    import sys as _sys

    if len(_sys.argv) < 2:
        print(json.dumps({"error": "Usage: python instagram.py <url> [--mode build|intel] [--frames] [--metadata-only]"}))
        _sys.exit(1)

    url = _sys.argv[1]
    mode = "intel"
    include_frames = "--frames" in _sys.argv
    metadata_only = "--metadata-only" in _sys.argv

    if "--mode" in _sys.argv:
        idx = _sys.argv.index("--mode")
        if idx + 1 < len(_sys.argv):
            mode = _sys.argv[idx + 1]

    if metadata_only:
        meta = await fetch_metadata(url)
        print(json.dumps(meta, default=str))
        return

    info = await process_reel(url, mode=mode, include_frames=include_frames)

    # Don't send full segments in CLI output (too large)
    info.pop("segments", None)

    # Truncate transcript for JSON output
    if info.get("transcript") and len(info["transcript"]) > 100000:
        info["transcript"] = truncate_transcript(info["transcript"], 100000)

    print(json.dumps(info, default=str))


if __name__ == "__main__":
    asyncio.run(_cli_main())
