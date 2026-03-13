"""OPAI Instagram Scraper MCP Server.

Wraps the tools/shared/instagram.py library as a stdio MCP server
for Claude Code. Provides reel transcript, metadata, frame extraction,
and transcript search.

Data-only tools — no nested Claude calls. Analysis is done by the
calling agent, not by these tools.

Tools:
  - get_reel_transcript: Transcript + metadata for an Instagram reel
  - get_reel_metadata: Caption, author, hashtags, duration, engagement
  - get_reel_frames: Download video, extract frames, return base64 images
  - search_reel_transcript: Keyword search across transcript segments
"""

import asyncio
import sys
from pathlib import Path

# Add shared library to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "tools" / "shared"))

from mcp.server.fastmcp import FastMCP
import instagram

mcp = FastMCP("opai-instagram-scraper")


def _format_timestamp(seconds: float) -> str:
    """Convert seconds to MM:SS format."""
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d}"


def _format_engagement(meta: dict) -> str:
    """Format engagement metrics as a readable string."""
    parts = []
    if meta.get("likes") is not None:
        parts.append(f"Likes: {meta['likes']:,}")
    if meta.get("views") is not None:
        parts.append(f"Views: {meta['views']:,}")
    if meta.get("comments") is not None:
        parts.append(f"Comments: {meta['comments']:,}")
    if meta.get("shares") is not None:
        parts.append(f"Shares: {meta['shares']:,}")
    return " | ".join(parts) if parts else "No engagement data available"


@mcp.tool()
async def get_reel_transcript(url: str) -> str:
    """Get the full transcript and metadata for an Instagram reel.

    Args:
        url: Instagram reel URL (e.g., https://www.instagram.com/reel/XXXXX/)

    Returns:
        Transcript text with reel metadata (author, caption, engagement).
    """
    shortcode = instagram.extract_shortcode(url)
    if not shortcode:
        return f"Error: Could not extract shortcode from: {url}"

    canonical = f"https://www.instagram.com/reel/{shortcode}/"

    # Fetch metadata and transcript concurrently
    meta_task = instagram.fetch_metadata(canonical)
    transcript_task = instagram.fetch_transcript(canonical)

    meta = await meta_task
    transcript_data = await transcript_task

    parts = []
    if meta.get("author"):
        author_display = meta.get("author_name") or meta["author"]
        parts.append(f"Author: @{meta['author']} ({author_display})")
    if meta.get("caption"):
        parts.append(f"Caption: {meta['caption'][:500]}")
    if meta.get("hashtags"):
        parts.append(f"Hashtags: #{' #'.join(meta['hashtags'][:15])}")
    if meta.get("duration"):
        parts.append(f"Duration: {meta['duration']}s")
    if meta.get("music"):
        parts.append(f"Music: {meta['music']}")

    engagement = _format_engagement(meta)
    if engagement != "No engagement data available":
        parts.append(f"Engagement: {engagement}")

    parts.append(f"Shortcode: {shortcode}")
    parts.append(f"Data source: {meta.get('source', 'unknown')}")
    parts.append("")  # blank line before transcript

    if transcript_data and transcript_data.get("text"):
        transcript = instagram.truncate_transcript(transcript_data["text"], 100000)
        parts.append(transcript)
    else:
        parts.append("(No transcript available — reel may not have speech)")

    return "\n".join(parts)


@mcp.tool()
async def get_reel_metadata(url: str) -> str:
    """Get metadata for an Instagram reel (caption, author, hashtags, engagement).

    Tries Bright Data API for rich data, falls back to yt-dlp.

    Args:
        url: Instagram reel URL

    Returns:
        Reel metadata: author, caption, hashtags, engagement metrics.
    """
    shortcode = instagram.extract_shortcode(url)
    if not shortcode:
        return f"Error: Could not extract shortcode from: {url}"

    canonical = f"https://www.instagram.com/reel/{shortcode}/"
    meta = await instagram.fetch_metadata(canonical)

    parts = []
    parts.append(f"Shortcode: {shortcode}")
    if meta.get("author"):
        parts.append(f"Author: @{meta['author']}")
    if meta.get("author_name"):
        parts.append(f"Name: {meta['author_name']}")
    if meta.get("caption"):
        parts.append(f"Caption: {meta['caption']}")
    if meta.get("hashtags"):
        parts.append(f"Hashtags: #{' #'.join(meta['hashtags'])}")
    if meta.get("duration"):
        parts.append(f"Duration: {meta['duration']}s")
    if meta.get("music"):
        parts.append(f"Music: {meta['music']}")
    if meta.get("posted_at"):
        parts.append(f"Posted: {meta['posted_at']}")
    if meta.get("thumbnail_url"):
        parts.append(f"Thumbnail: {meta['thumbnail_url']}")

    parts.append("")
    parts.append(f"Engagement: {_format_engagement(meta)}")
    parts.append(f"Data source: {meta.get('source', 'unknown')}")

    return "\n".join(parts)


@mcp.tool()
async def get_reel_frames(url: str, count: int = 8) -> str:
    """Download an Instagram reel video and extract evenly-spaced frames.

    Returns base64-encoded JPEG frames plus any transcript found.
    This is a heavier operation — downloads the full video.

    Args:
        url: Instagram reel URL
        count: Number of frames to extract (default 8, max 12)

    Returns:
        JSON string with frame data (base64) and transcript.
    """
    import json

    shortcode = instagram.extract_shortcode(url)
    if not shortcode:
        return f"Error: Could not extract shortcode from: {url}"

    canonical = f"https://www.instagram.com/reel/{shortcode}/"
    count = min(max(count, 1), 12)

    # Fetch transcript in parallel with download
    transcript_task = instagram.fetch_transcript(canonical)

    with instagram._temp_workspace() as tmpdir:
        video_path = await instagram.download_video(canonical, tmpdir)
        transcript_data = await transcript_task

        if not video_path:
            return "Error: Could not download the reel video. Instagram may be blocking access."

        frames = await instagram.extract_frames(video_path, count=count, output_dir=tmpdir)

        if not frames:
            return "Error: Could not extract frames from the video."

        frame_data = instagram.frames_to_base64(frames)

        result = {
            "shortcode": shortcode,
            "frame_count": len(frame_data),
            "frames": frame_data,
            "transcript": transcript_data["text"] if transcript_data else "",
        }

        return json.dumps(result)


@mcp.tool()
async def search_reel_transcript(url: str, query: str) -> str:
    """Search an Instagram reel's transcript for matching segments.

    Finds all segments containing the query text and returns them
    with timestamps. Case-insensitive search.

    Args:
        url: Instagram reel URL
        query: Search text to find in the transcript

    Returns:
        Matching transcript segments with timestamps, or a message if none found.
    """
    shortcode = instagram.extract_shortcode(url)
    if not shortcode:
        return f"Error: Could not extract shortcode from: {url}"

    canonical = f"https://www.instagram.com/reel/{shortcode}/"
    transcript_data = await instagram.fetch_transcript(canonical)

    if not transcript_data or not transcript_data.get("segments"):
        # Try full text search if we have text but no segments
        if transcript_data and transcript_data.get("text"):
            if query.lower() in transcript_data["text"].lower():
                return f"Found '{query}' in transcript (no timestamp data available):\n\n{transcript_data['text'][:2000]}"
            return f"No matches found for '{query}' in the transcript."
        return "No transcript available for this reel."

    query_lower = query.lower()
    matches = []

    for seg in transcript_data["segments"]:
        if query_lower in seg["text"].lower():
            ts = _format_timestamp(seg["start"])
            matches.append(f"[{ts}] {seg['text']}")

    if not matches:
        return f"No matches found for '{query}' in the transcript."

    header = f"Found {len(matches)} match{'es' if len(matches) != 1 else ''} for '{query}':\n"
    return header + "\n".join(matches)


if __name__ == "__main__":
    mcp.run(transport="stdio")
