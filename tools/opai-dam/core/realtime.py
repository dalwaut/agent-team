"""DAM Bot — Supabase Realtime broadcast + Discord bridge."""

from __future__ import annotations

import logging

import httpx

import config

log = logging.getLogger("dam.realtime")


async def broadcast_realtime(session_id: str, payload: dict) -> None:
    """Broadcast event via Supabase Realtime HTTP API."""
    if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
        return

    url = f"{config.SUPABASE_URL}/realtime/v1/api/broadcast"
    headers = {"apikey": config.SUPABASE_SERVICE_KEY, "Content-Type": "application/json"}
    body = {
        "messages": [{
            "topic": f"realtime:dam_{session_id}",
            "event": "broadcast",
            "payload": payload,
        }]
    }

    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(url, headers=headers, json=body)
    except Exception as exc:
        log.warning("Realtime broadcast failed: %s", exc)


async def broadcast_discord(message: str, level: str = "info") -> None:
    """Post notification to Discord bridge webhook."""
    if not config.DISCORD_BRIDGE_URL:
        return

    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(
                f"{config.DISCORD_BRIDGE_URL}/api/webhook",
                json={
                    "source": "dam-bot",
                    "level": level,
                    "message": message,
                },
            )
    except Exception as exc:
        log.warning("Discord broadcast failed: %s", exc)
