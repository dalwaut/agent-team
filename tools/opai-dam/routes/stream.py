"""DAM Bot — SSE streaming for live session updates."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from core.supabase import sb_get

log = logging.getLogger("dam.routes.stream")
router = APIRouter(prefix="/api/stream")


@router.get("/{session_id}")
async def stream_session(session_id: str, request: Request):
    """SSE stream for live session updates (logs + step changes)."""

    async def event_generator():
        last_log_ts = datetime.now(timezone.utc).isoformat()
        last_step_check = {}

        while True:
            if await request.is_disconnected():
                break

            try:
                # Poll for new logs
                new_logs = await sb_get(
                    f"dam_session_logs?session_id=eq.{session_id}"
                    f"&created_at=gt.{last_log_ts}"
                    f"&select=*&order=created_at.asc&limit=20"
                )
                for log_entry in new_logs:
                    yield {
                        "event": "log",
                        "data": json.dumps(log_entry),
                    }
                    last_log_ts = log_entry["created_at"]

                # Check for step status changes
                steps = await sb_get(
                    f"dam_steps?session_id=eq.{session_id}&select=id,status,completed_at&order=ordinal.asc"
                )
                for step in steps:
                    prev_status = last_step_check.get(step["id"])
                    if prev_status != step["status"]:
                        last_step_check[step["id"]] = step["status"]
                        if prev_status is not None:
                            yield {
                                "event": "step_update",
                                "data": json.dumps(step),
                            }

                # Check session status
                sessions = await sb_get(
                    f"dam_sessions?id=eq.{session_id}&select=status"
                )
                if sessions:
                    sess_status = sessions[0]["status"]
                    if sess_status in ("completed", "failed", "cancelled"):
                        yield {
                            "event": "session_ended",
                            "data": json.dumps({"status": sess_status}),
                        }
                        break

            except Exception as exc:
                log.warning("Stream error: %s", exc)

            await asyncio.sleep(2)

    return EventSourceResponse(event_generator())


@router.get("/{session_id}/logs")
async def get_logs(session_id: str, limit: int = 100):
    """Get session logs (non-streaming)."""
    rows = await sb_get(
        f"dam_session_logs?session_id=eq.{session_id}"
        f"&select=*&order=created_at.desc&limit={limit}"
    )
    return {"logs": rows}
