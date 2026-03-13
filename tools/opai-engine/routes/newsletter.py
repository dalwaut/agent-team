"""OPAI Engine — Newsletter API.

Endpoints:
  POST /api/newsletter/send     — Send pending announcements NOW
  GET  /api/newsletter/preview   — Return HTML preview of pending announcements
  POST /api/newsletter/create    — Create a new announcement entry
  GET  /api/newsletter/list      — List all announcements (pending + sent)
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import config
from auth import require_admin

logger = logging.getLogger("opai-engine.newsletter")

router = APIRouter(prefix="/api")

ANNOUNCEMENTS_FILE = config.ANNOUNCEMENTS_FILE

# Reference to the app's resident scheduler (set at startup)
_scheduler = None


def set_scheduler(sched):
    global _scheduler
    _scheduler = sched


# ── Models ────────────────────────────────────────────────


class AnnouncementSection(BaseModel):
    title: str
    icon: str = "default"
    items: list[str]


class CreateAnnouncementRequest(BaseModel):
    headline: str
    subheadline: str = ""
    sections: list[AnnouncementSection]
    footer: str = ""
    recipients: list[str] = ["Dallas@paradisewebfl.com", "Denise@paradisewebfl.com"]


# ── Helpers ───────────────────────────────────────────────


def _load_announcements() -> list[dict]:
    try:
        if ANNOUNCEMENTS_FILE.is_file():
            return json.loads(ANNOUNCEMENTS_FILE.read_text())
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to load announcements: %s", e)
    return []


def _save_announcements(data: list[dict]):
    ANNOUNCEMENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ANNOUNCEMENTS_FILE.write_text(json.dumps(data, indent=2))


# ── Routes ────────────────────────────────────────────────


@router.get("/newsletter/list", dependencies=[Depends(require_admin)])
async def list_announcements():
    """List all announcements."""
    entries = _load_announcements()
    return {
        "total": len(entries),
        "pending": sum(1 for e in entries if not e.get("announced")),
        "announcements": entries,
    }


@router.get("/newsletter/preview", dependencies=[Depends(require_admin)])
async def preview_newsletter():
    """Return HTML preview of pending announcements."""
    from background.scheduler import Scheduler

    entries = _load_announcements()
    pending = [e for e in entries if not e.get("announced")]

    if not pending:
        return {"status": "empty", "message": "No pending announcements"}

    today = datetime.now().strftime("%Y-%m-%d")
    html = Scheduler._build_newsletter_html(today, [], [], pending)

    return {
        "status": "ok",
        "announcement_count": len(pending),
        "headlines": [e.get("headline", "") for e in pending],
        "recipients": list({r for e in pending for r in e.get("recipients", [])}),
        "html": html,
    }


@router.post("/newsletter/send", dependencies=[Depends(require_admin)])
async def send_newsletter():
    """Send pending announcements immediately using the resident scheduler."""
    entries = _load_announcements()
    pending = [e for e in entries if not e.get("announced")]

    if not pending:
        raise HTTPException(status_code=404, detail="No pending announcements to send")

    if not _scheduler:
        raise HTTPException(status_code=503, detail="Scheduler not initialized")

    # Use the app's resident scheduler (has loaded config + vault access)
    result = await _scheduler._daily_agent_newsletter()

    if result:
        # Re-check if announcements were marked as sent
        updated = _load_announcements()
        sent_count = sum(1 for e in updated if e.get("announced"))
        return {
            "status": "sent",
            "announcement_count": len(pending),
            "headlines": [e.get("headline", "") for e in pending],
        }
    else:
        raise HTTPException(status_code=500, detail="Newsletter send failed — check engine logs")


@router.post("/newsletter/create", dependencies=[Depends(require_admin)])
async def create_announcement(req: CreateAnnouncementRequest):
    """Create a new announcement entry (pending, not yet sent)."""
    entries = _load_announcements()

    today = datetime.now().strftime("%Y-%m-%d")
    slug = req.headline.lower().replace(" ", "-")[:40]
    ann_id = f"{today}-{slug}"

    # Check for duplicate
    if any(e.get("id") == ann_id for e in entries):
        raise HTTPException(status_code=409, detail=f"Announcement '{ann_id}' already exists")

    new_entry = {
        "id": ann_id,
        "date": today,
        "announced": False,
        "headline": req.headline,
        "subheadline": req.subheadline,
        "sections": [s.model_dump() for s in req.sections],
        "footer": req.footer,
        "recipients": req.recipients,
    }

    entries.append(new_entry)
    _save_announcements(entries)

    logger.info("Newsletter announcement created: %s", ann_id)
    return {"status": "created", "id": ann_id, "entry": new_entry}
