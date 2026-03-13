"""OPAI Engine — Personal Notification Watches.

Register watches on tasks/items. When the watched item completes,
a formatted Telegram notification is sent to the personal topic.

Storage: data/personal-notifications.json
"""

import json
import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import config
from auth import require_admin

logger = logging.getLogger("opai-engine.notifications")

router = APIRouter(prefix="/api")


class WatchRequest(BaseModel):
    task_id: str | None = None
    teamhub_item_id: str | None = None
    title: str = ""
    message: str | None = None
    source: str = "api"


# ── Storage ──────────────────────────────────────────────


def _read_watches() -> list[dict]:
    try:
        if config.PERSONAL_NOTIFICATIONS_FILE.is_file():
            data = json.loads(config.PERSONAL_NOTIFICATIONS_FILE.read_text())
            return data.get("watches", [])
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read personal notifications: %s", e)
    return []


def _write_watches(watches: list[dict]):
    config.PERSONAL_NOTIFICATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.PERSONAL_NOTIFICATIONS_FILE.write_text(
        json.dumps({"watches": watches}, indent=2, default=str)
    )


# ── API ──────────────────────────────────────────────────


@router.post("/notifications/watch", dependencies=[Depends(require_admin)])
def add_watch(req: WatchRequest):
    """Register a personal notification watch on a task or Team Hub item."""
    if not req.task_id and not req.teamhub_item_id:
        raise HTTPException(400, "Either task_id or teamhub_item_id is required")

    watches = _read_watches()

    watch_id = f"watch_{int(time.time())}_{len(watches)}"
    watch = {
        "id": watch_id,
        "task_id": req.task_id,
        "teamhub_item_id": req.teamhub_item_id,
        "title": req.title,
        "message": req.message,
        "source": req.source,
        "status": "watching",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "fired_at": None,
    }

    watches.append(watch)
    _write_watches(watches)

    logger.info("Watch registered: %s → %s", watch_id, req.title or req.task_id)
    return {"success": True, "watch": watch}


@router.get("/notifications/watches", dependencies=[Depends(require_admin)])
def list_watches(status: str | None = None):
    """List all notification watches. Optional filter by status."""
    watches = _read_watches()
    if status:
        watches = [w for w in watches if w.get("status") == status]
    return {"watches": watches}


@router.delete("/notifications/watch/{watch_id}", dependencies=[Depends(require_admin)])
def remove_watch(watch_id: str):
    """Remove a specific notification watch."""
    watches = _read_watches()
    before = len(watches)
    watches = [w for w in watches if w.get("id") != watch_id]
    if len(watches) == before:
        raise HTTPException(404, f"Watch {watch_id} not found")
    _write_watches(watches)
    return {"success": True, "removed": watch_id}


@router.delete("/notifications/watches/fired", dependencies=[Depends(require_admin)])
def clear_fired():
    """Remove all fired (delivered) watches."""
    watches = _read_watches()
    active = [w for w in watches if w.get("status") != "fired"]
    removed = len(watches) - len(active)
    _write_watches(active)
    return {"success": True, "removed_count": removed}
