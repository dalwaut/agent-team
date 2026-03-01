"""OPAI Engine — Heartbeat API endpoints.

Provides access to heartbeat snapshots, daily notes, and manual triggers.
"""

import json

from fastapi import APIRouter, Depends, HTTPException

import config
from auth import require_admin

router = APIRouter(prefix="/api/heartbeat")

# Heartbeat instance set by app.py during startup
_heartbeat = None


def set_heartbeat(hb):
    global _heartbeat
    _heartbeat = hb


def _get_heartbeat():
    if _heartbeat is None:
        raise HTTPException(503, "Heartbeat not initialized")
    return _heartbeat


@router.get("/latest")
def get_latest():
    """Return the most recent heartbeat snapshot."""
    hb = _get_heartbeat()
    return hb.get_latest()


@router.get("/daily-notes")
def list_daily_notes():
    """List available daily notes."""
    notes_dir = config.DAILY_NOTES_DIR
    if not notes_dir.is_dir():
        return {"notes": []}

    notes = []
    for f in sorted(notes_dir.glob("*.md"), reverse=True):
        notes.append({
            "date": f.stem,
            "filename": f.name,
            "size": f.stat().st_size,
        })

    return {"notes": notes[:30]}  # Last 30 days


@router.get("/daily-notes/{date}")
def get_daily_note(date: str):
    """Read a specific daily note by date (YYYY-MM-DD)."""
    # Validate date format
    if len(date) != 10 or date.count("-") != 2:
        raise HTTPException(400, "Date must be YYYY-MM-DD format")

    note_path = config.DAILY_NOTES_DIR / f"{date}.md"
    if not note_path.is_file():
        raise HTTPException(404, f"No daily note for {date}")

    return {
        "date": date,
        "content": note_path.read_text(),
        "size": note_path.stat().st_size,
    }


@router.post("/trigger", dependencies=[Depends(require_admin)])
async def trigger_heartbeat():
    """Force an immediate heartbeat cycle (admin only)."""
    hb = _get_heartbeat()
    result = await hb.trigger()
    return result
