"""OPAI Engine — Telegram Notifier.

Sends notifications directly via Telegram Bot API using httpx.
No dependency on the Telegram service process.

Token strategy:
  1. Check env vars TELEGRAM_BOT_TOKEN + ADMIN_GROUP_ID
  2. Fallback: read tools/opai-telegram/.env
  3. If neither: skip notifications (log warning)
"""

import logging
import os
from pathlib import Path

import httpx

import config

logger = logging.getLogger("opai-engine.notifier")

_TELEGRAM_API = "https://api.telegram.org"

# Cached credentials
_bot_token: str | None = None
_chat_id: str | None = None
_loaded = False


def _load_config():
    """Load Telegram bot token and admin group ID."""
    global _bot_token, _chat_id, _loaded
    if _loaded:
        return
    _loaded = True

    # 1. Environment variables
    _bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    _chat_id = os.getenv("ADMIN_GROUP_ID")

    if _bot_token and _chat_id:
        logger.info("Telegram notifier configured from env vars")
        return

    # 2. Fallback: read tools/opai-telegram/.env
    dotenv = config.TELEGRAM_DIR / ".env"
    if dotenv.is_file():
        env_vals = {}
        for line in dotenv.read_text().splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, _, val = line.partition("=")
                env_vals[key.strip()] = val.strip().strip('"')

        if not _bot_token:
            _bot_token = env_vals.get("TELEGRAM_BOT_TOKEN")
        if not _chat_id:
            _chat_id = env_vals.get("ADMIN_GROUP_ID")

        if _bot_token and _chat_id:
            logger.info("Telegram notifier configured from %s", dotenv)
            return

    if not _bot_token or not _chat_id:
        logger.warning(
            "Telegram notifier disabled — no TELEGRAM_BOT_TOKEN/ADMIN_GROUP_ID found"
        )


async def send_telegram(text: str, parse_mode: str = "Markdown") -> bool:
    """Send a message via Telegram Bot API.

    Returns True on success, False on failure (non-fatal).
    """
    _load_config()
    if not _bot_token or not _chat_id:
        return False

    url = f"{_TELEGRAM_API}/bot{_bot_token}/sendMessage"
    payload = {
        "chat_id": _chat_id,
        "text": text,
        "parse_mode": parse_mode,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code == 200:
                return True
            logger.warning(
                "Telegram send failed: %d %s", resp.status_code, resp.text[:200]
            )
            return False
    except Exception as e:
        logger.warning("Telegram send error: %s", e)
        return False


async def notify_changes(changes: list[dict], summary: dict) -> bool:
    """Format and send completion/failure/stall alerts.

    Batches multiple items into one message. Respects max_notifications_per_cycle
    by truncating if needed.
    """
    if not changes:
        return True

    orch = config.load_orchestrator_config()
    hb_cfg = orch.get("heartbeat", {})
    if not hb_cfg.get("notifications_enabled", True):
        return True

    max_notifs = hb_cfg.get("max_notifications_per_cycle", 5)

    # Group by type
    completions = [c for c in changes if c["type"] == "completed"]
    failures = [c for c in changes if c["type"] == "failed"]
    stalls = [c for c in changes if c["type"] == "stall_detected"]
    restarts = [c for c in changes if c["type"] == "restarted"]

    lines = []

    # Build header
    parts = []
    if completions:
        parts.append(f"{len(completions)} completed")
    if failures:
        parts.append(f"{len(failures)} failed")
    if stalls:
        parts.append(f"{len(stalls)} stalled")
    if restarts:
        parts.append(f"{len(restarts)} restarted")

    header = "OPAI Heartbeat"
    if parts:
        header += " — " + ", ".join(parts)
    lines.append(header)
    lines.append("")

    count = 0

    if completions:
        for c in completions:
            if count >= max_notifs:
                lines.append(f"  ...and {len(completions) - count} more")
                break
            duration = c.get("duration", "")
            dur_str = f" ({duration})" if duration else ""
            lines.append(f"  {c.get('title', c.get('item', '?'))}{dur_str}")
            count += 1

    if failures:
        lines.append("")
        for c in failures:
            if count >= max_notifs:
                break
            lines.append(f"  {c.get('title', c.get('item', '?'))} — FAILED")
            count += 1

    if stalls:
        lines.append("")
        for c in stalls:
            if count >= max_notifs:
                break
            action = c.get("action", "logged")
            lines.append(f"  {c.get('title', c.get('item', '?'))} — stalled")
            lines.append(f"  Action: {action}")
            count += 1

    if restarts:
        lines.append("")
        for c in restarts:
            if count >= max_notifs:
                break
            lines.append(f"  {c.get('title', c.get('item', '?'))} — auto-restarted")
            count += 1

    # Footer
    healthy = summary.get("healthy", 0)
    total = summary.get("total", 0)
    cpu = summary.get("cpu", 0)
    mem = summary.get("memory", 0)
    lines.append("")
    lines.append(f"{healthy}/{total} healthy | CPU {cpu:.0f}% | Mem {mem:.0f}%")

    text = "\n".join(lines)
    return await send_telegram(text, parse_mode="Markdown")


async def notify_daily_summary(summary_text: str) -> bool:
    """Send end-of-day daily summary to Telegram."""
    orch = config.load_orchestrator_config()
    hb_cfg = orch.get("heartbeat", {})
    if not hb_cfg.get("notifications_enabled", True):
        return True

    return await send_telegram(summary_text, parse_mode="Markdown")


async def notify_consolidation(extraction: dict, date_str: str) -> bool:
    """Send memory consolidation summary to Telegram."""
    facts = extraction.get("stable_facts", [])
    wiki = extraction.get("wiki_updates", [])
    prefs = extraction.get("learned_preferences", [])
    corrections = extraction.get("corrections", [])

    lines = ["OPAI Memory Consolidation", ""]
    lines.append(f"Facts extracted: {len(facts)}")
    lines.append(f"Wiki recommendations: {len(wiki)}")
    lines.append(f"Preferences learned: {len(prefs)}")
    lines.append(f"Corrections logged: {len(corrections)}")

    # Top fact
    if facts:
        top = facts[0]
        lines.append("")
        lines.append(f"Top fact: {top.get('fact', '?')}")

    # New preference
    if prefs:
        top_pref = prefs[0]
        lines.append(f"New preference: {top_pref.get('preference', '?')}")

    # Wiki files flagged
    if wiki:
        files = list({w.get("file", "?") for w in wiki})
        lines.append("")
        lines.append(f"Wiki files flagged: {', '.join(files[:5])}")

    return await send_telegram("\n".join(lines), parse_mode="Markdown")
