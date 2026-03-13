"""OPAI Engine — Google Chat status & management route.

Provides status endpoints for the Chat integration. The actual message
handling is done by the workspace_chat background poller (user-auth based,
messages appear FROM agent@paradisewebfl.com).

Endpoints:
  GET  /api/google-chat/status   — Current chat polling state + stats
  POST /api/google-chat/trigger  — Manually trigger a chat poll cycle
"""

import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth import require_admin

logger = logging.getLogger("opai.google_chat")

router = APIRouter(prefix="/api/google-chat", tags=["google-chat"])

CHAT_STATE_FILE = Path(__file__).resolve().parent.parent / "data" / "workspace-chat-state.json"
MENTION_STATE_FILE = Path(__file__).resolve().parent.parent / "data" / "workspace-mentions-state.json"


class StatusResponse(BaseModel):
    status: str
    chat: dict | None = None
    mentions: dict | None = None


@router.get("/status")
async def chat_status():
    """Get current Google Chat + Mentions polling status."""
    chat_state = {}
    mention_state = {}

    try:
        if CHAT_STATE_FILE.is_file():
            chat_state = json.loads(CHAT_STATE_FILE.read_text())
    except Exception:
        chat_state = {"error": "Could not read state file"}

    try:
        if MENTION_STATE_FILE.is_file():
            mention_state = json.loads(MENTION_STATE_FILE.read_text())
    except Exception:
        mention_state = {"error": "Could not read state file"}

    return StatusResponse(
        status="ok",
        chat={
            "last_poll": chat_state.get("last_poll"),
            "last_stats": chat_state.get("last_stats"),
            "processed_count": len(chat_state.get("processed_ids", [])),
        },
        mentions={
            "last_poll": mention_state.get("last_poll"),
            "last_stats": mention_state.get("last_stats"),
            "processed_count": len(mention_state.get("processed_ids", [])),
        },
    )


@router.post("/trigger", dependencies=[Depends(require_admin)])
async def trigger_chat_poll():
    """Manually trigger a chat poll cycle."""
    try:
        from background.workspace_chat import poll_workspace_chat
        stats = await poll_workspace_chat()
        return {"status": "completed", "stats": stats}
    except Exception as e:
        logger.error("Manual chat poll trigger failed: %s", e)
        return {"status": "error", "error": str(e)}


@router.post("/trigger-mentions", dependencies=[Depends(require_admin)])
async def trigger_mention_poll():
    """Manually trigger a doc mentions poll cycle."""
    try:
        from background.workspace_mentions import poll_workspace_mentions
        stats = await poll_workspace_mentions()
        return {"status": "completed", "stats": stats}
    except Exception as e:
        logger.error("Manual mention poll trigger failed: %s", e)
        return {"status": "error", "error": str(e)}
