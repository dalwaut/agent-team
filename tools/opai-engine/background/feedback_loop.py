"""OPAI Engine — Agent Feedback Confidence Decay Loop.

Runs every 24 hours. Decays confidence on stale feedback items
(not updated in 30+ days) and deactivates items below 0.2 confidence.
"""

import asyncio
import logging
from datetime import datetime, timezone, timedelta

import httpx

import config

logger = logging.getLogger("opai-engine.feedback-loop")

_TABLE = "engine_agent_feedback"
_DECAY_INTERVAL = 86400  # 24 hours
_STALE_DAYS = 30
_DECAY_AMOUNT = 0.05
_DEACTIVATE_THRESHOLD = 0.2


def _sb_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url() -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{_TABLE}"


async def feedback_loop():
    """Confidence decay loop — decays stale hints, deactivates low-confidence items."""
    logger.info("Feedback decay loop started (runs every 24h)")
    await asyncio.sleep(300)  # 5-min startup delay

    while True:
        try:
            await _decay_cycle()
        except Exception as e:
            logger.error("Feedback decay cycle error: %s", e)
        await asyncio.sleep(_DECAY_INTERVAL)


async def _decay_cycle():
    """One decay cycle: find stale items, reduce confidence, deactivate if too low."""
    if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
        logger.debug("Supabase not configured — skipping decay cycle")
        return

    cutoff = (datetime.now(timezone.utc) - timedelta(days=_STALE_DAYS)).isoformat()

    async with httpx.AsyncClient(timeout=15) as client:
        # Fetch active items not updated in 30+ days
        resp = await client.get(
            _sb_url(),
            headers=_sb_headers(),
            params={
                "active": "eq.true",
                "updated_at": f"lt.{cutoff}",
                "limit": "500",
            },
        )
        if resp.status_code != 200:
            logger.warning("Failed to fetch stale feedback: %s", resp.status_code)
            return

        stale_items = resp.json()
        if not stale_items:
            logger.debug("No stale feedback items to decay")
            return

        now = datetime.now(timezone.utc).isoformat()
        decayed = 0
        deactivated = 0

        for item in stale_items:
            item_id = item["id"]
            current_confidence = item.get("confidence", 0.5)
            new_confidence = round(current_confidence - _DECAY_AMOUNT, 3)

            if new_confidence < _DEACTIVATE_THRESHOLD:
                # Deactivate
                patch_data = {
                    "active": False,
                    "confidence": max(0.0, new_confidence),
                    "updated_at": now,
                }
                deactivated += 1
            else:
                # Just decay
                patch_data = {
                    "confidence": new_confidence,
                    "updated_at": now,
                }
                decayed += 1

            await client.patch(
                _sb_url(),
                headers=_sb_headers(),
                params={"id": f"eq.{item_id}"},
                json=patch_data,
            )

        logger.info(
            "Feedback decay cycle: decayed %d hints, deactivated %d (of %d stale)",
            decayed, deactivated, len(stale_items),
        )
