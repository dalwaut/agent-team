"""OPAI YouTube Transcript MCP Server.

Wraps the battle-tested tools/shared/youtube.py library as a stdio MCP server
for Claude Code. Replaces third-party MCP packages (@emit-ia, @kimtaeyoon83)
that kept breaking due to YouTube anti-bot blocks.

IP ban workaround: The shared library auto-detects a SOCKS5 proxy on port 1080
and falls back to it when YouTube blocks the local IP.
Start tunnel: ssh -D 1080 -q -N dallas@100.113.66.23 &  (NAS, residential IP)
Or: scripts/web-fetch-fallback.sh --tunnel

Tools:
  - get_transcript: Full transcript + metadata for a YouTube video
  - get_video_metadata: Title, author, thumbnail (oEmbed, no API key)
  - search_transcript: Keyword search across transcript segments with timestamps
"""

import asyncio
import sys
from pathlib import Path

# Add shared library to path so we can import youtube.py directly
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "tools" / "shared"))

from mcp.server.fastmcp import FastMCP
import youtube

mcp = FastMCP("opai-youtube-transcript")


def _format_timestamp(seconds: float) -> str:
    """Convert seconds to HH:MM:SS or MM:SS format."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


@mcp.tool()
async def get_transcript(url: str, lang: str = "en") -> str:
    """Get the full transcript and metadata for a YouTube video.

    Args:
        url: YouTube video URL (any format: watch, youtu.be, shorts, embed, live)
        lang: Language code for transcript (default: "en")

    Returns:
        Transcript text with video metadata (title, author, language).
    """
    info = await youtube.process_video(url)

    if info.get("error") and not info.get("transcript"):
        return f"Error: {info['error']}"

    parts = []
    if info.get("title"):
        parts.append(f"Title: {info['title']}")
    if info.get("author"):
        parts.append(f"Author: {info['author']}")
    if info.get("language"):
        parts.append(f"Language: {info['language']}")
    if info.get("video_id"):
        parts.append(f"Video ID: {info['video_id']}")

    parts.append("")  # blank line before transcript

    transcript = info.get("transcript", "")
    if transcript:
        # Truncate very long transcripts to stay within reasonable context
        transcript = youtube.truncate_transcript(transcript, 100000)
        parts.append(transcript)
    else:
        parts.append("(No transcript available)")

    if info.get("error"):
        parts.append(f"\nNote: {info['error']}")

    return "\n".join(parts)


@mcp.tool()
async def get_video_metadata(url: str) -> str:
    """Get metadata for a YouTube video (title, author, thumbnail).

    Uses the YouTube oEmbed API — no API key required.

    Args:
        url: YouTube video URL

    Returns:
        Video metadata: title, author, thumbnail URL.
    """
    video_id = youtube.extract_video_id(url)
    if not video_id:
        return f"Error: Could not extract video ID from: {url}"

    meta = await youtube.fetch_metadata(video_id)

    parts = []
    parts.append(f"Video ID: {video_id}")
    parts.append(f"Title: {meta.get('title', '(unknown)')}")
    parts.append(f"Author: {meta.get('author', '(unknown)')}")
    if meta.get("thumbnail_url"):
        parts.append(f"Thumbnail: {meta['thumbnail_url']}")

    return "\n".join(parts)


@mcp.tool()
async def search_transcript(url: str, query: str, lang: str = "en") -> str:
    """Search a YouTube video's transcript for matching segments.

    Finds all segments containing the query text and returns them
    with timestamps. Case-insensitive search.

    Args:
        url: YouTube video URL
        query: Search text to find in the transcript
        lang: Language code for transcript (default: "en")

    Returns:
        Matching transcript segments with timestamps, or a message if none found.
    """
    video_id = youtube.extract_video_id(url)
    if not video_id:
        return f"Error: Could not extract video ID from: {url}"

    try:
        transcript_data = await youtube.fetch_transcript(video_id, [lang])
    except RuntimeError as e:
        return f"Error: {e}"

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
