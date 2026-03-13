"""OPAI Shared Supadata — API transcript provider utilities.

Shared pool of 100 free transcripts/month across YouTube + Instagram.
Both youtube.py and instagram.py import from here.

Usage:
    from supadata import (
        get_supadata_key, load_supadata_usage, save_supadata_usage,
        get_supadata_usage, fetch_transcript_supadata, SUPADATA_MONTHLY_LIMIT,
    )
"""

import json
import logging
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

log = logging.getLogger("opai.supadata")

SUPADATA_API_URL = "https://api.supadata.ai/v1/transcript"
SUPADATA_MONTHLY_LIMIT = 100
_USAGE_FILE = Path(__file__).parent.parent / "opai-engine" / "data" / "supadata-usage.json"


def get_supadata_key() -> Optional[str]:
    """Get Supadata API key from env or vault."""
    key = os.environ.get("SUPADATA_API_KEY")
    if key:
        return key
    try:
        result = subprocess.run(
            ["python3", "-c",
             "import sys; sys.path.insert(0, '/workspace/synced/opai/tools/opai-vault'); "
             "import store; print(store.get_secret('SUPADATA_API_KEY') or '')"],
            capture_output=True, text=True, timeout=5,
        )
        val = result.stdout.strip()
        return val if val else None
    except Exception:
        return None


def load_supadata_usage() -> dict:
    """Load Supadata usage tracker. Resets monthly."""
    try:
        if _USAGE_FILE.exists():
            data = json.loads(_USAGE_FILE.read_text())
            now = datetime.now(timezone.utc)
            if data.get("month") != now.strftime("%Y-%m"):
                return {"month": now.strftime("%Y-%m"), "count": 0, "calls": []}
            return data
    except Exception:
        pass
    return {"month": datetime.now(timezone.utc).strftime("%Y-%m"), "count": 0, "calls": []}


def save_supadata_usage(data: dict):
    """Save Supadata usage tracker."""
    try:
        _USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _USAGE_FILE.write_text(json.dumps(data, indent=2))
    except Exception as e:
        log.warning("[Supadata] Failed to save usage tracker: %s", e)


def get_supadata_usage() -> dict:
    """Public: get current Supadata usage stats."""
    data = load_supadata_usage()
    return {
        "month": data["month"],
        "used": data["count"],
        "limit": SUPADATA_MONTHLY_LIMIT,
        "remaining": max(0, SUPADATA_MONTHLY_LIMIT - data["count"]),
        "warning": data["count"] >= SUPADATA_MONTHLY_LIMIT * 0.8,
    }


async def fetch_transcript_supadata(url: str, source: str = "unknown") -> Optional[dict]:
    """Fetch transcript via Supadata API. Returns dict or None on failure.

    Tracks usage against the 100/month free tier limit.
    Args:
        url: Full URL (YouTube watch URL or Instagram reel URL)
        source: "youtube" or "instagram" for usage tracking
    """
    api_key = get_supadata_key()
    if not api_key:
        log.warning("[Supadata] No API key available — skipping fallback")
        return None

    usage = load_supadata_usage()
    if usage["count"] >= SUPADATA_MONTHLY_LIMIT:
        log.warning("[Supadata] Monthly limit reached (%d/%d) — skipping",
                    usage["count"], SUPADATA_MONTHLY_LIMIT)
        return None

    if usage["count"] >= SUPADATA_MONTHLY_LIMIT * 0.8:
        log.warning("[Supadata] Approaching limit: %d/%d used this month",
                    usage["count"], SUPADATA_MONTHLY_LIMIT)

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                SUPADATA_API_URL,
                params={"url": url, "format": "json"},
                headers={"x-api-key": api_key},
            )
            resp.raise_for_status()
            data = resp.json()

        # Track usage
        usage["count"] += 1
        usage["calls"].append({
            "source": source,
            "url": url[:120],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        usage["calls"] = usage["calls"][-20:]
        save_supadata_usage(usage)

        remaining = SUPADATA_MONTHLY_LIMIT - usage["count"]
        log.info("[Supadata] Transcript fetched for %s (source: %s, usage: %d/%d, %d remaining)",
                 url[:60], source, usage["count"], SUPADATA_MONTHLY_LIMIT, remaining)

        # Parse response: {content: [{text, offset, duration}, ...], lang: "en"}
        content = data.get("content", [])
        if isinstance(content, list):
            segments = []
            text_parts = []
            for item in content:
                text = item.get("text", "")
                text_parts.append(text)
                segments.append({
                    "text": text,
                    "start": item.get("offset", 0),
                    "duration": item.get("duration", 0),
                })
            return {
                "text": " ".join(text_parts),
                "segments": segments,
                "language": data.get("lang", "en"),
            }
        elif isinstance(content, str):
            return {
                "text": content,
                "segments": [],
                "language": data.get("lang", "en"),
            }

        return None

    except Exception as e:
        log.error("[Supadata] Transcript fetch failed for %s: %s", url[:60], e)
        return None
