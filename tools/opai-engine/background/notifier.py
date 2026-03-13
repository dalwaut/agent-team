"""OPAI Engine — Telegram Notifier.

Sends notifications directly via Telegram Bot API using httpx.
No dependency on the Telegram service process.

Token strategy:
  1. Check env vars TELEGRAM_BOT_TOKEN + ADMIN_GROUP_ID
  2. Fallback: read tools/opai-telegram/.env
  3. If neither: skip notifications (log warning)

Topic routing (forum group):
  Messages route to specific forum topics via message_thread_id.
  Topic IDs are loaded from env vars or orchestrator.json heartbeat config.
  Falls back to General if unset.

  Alerts (106)        — Problems only: service down, stalls, restart failures.
                        Includes [Restart] buttons for failed services.
  Server Status (107) — Server status, daily summary, consolidation, digest.
  HITL (112)          — Human decisions: task approvals, HITL briefings with action buttons.
"""

import json
import logging
import os
from collections import deque
from pathlib import Path

import httpx

import config

logger = logging.getLogger("opai-engine.notifier")

_TELEGRAM_API = "https://api.telegram.org"

# Cached credentials
_bot_token: str | None = None
_chat_id: str | None = None
_loaded = False

# Forum topic thread IDs (loaded from env/config)
_alert_thread_id: int | None = None
_server_status_thread_id: int | None = None
_hitl_thread_id: int | None = None

# Notification queue for sync-to-async bridge
_notification_queue: deque[dict] = deque()

# Telegram-initiated restarts — worker IDs that were restarted via Telegram.
# When these workers come back healthy, we send a recovery notification.
_telegram_restarts: set[str] = set()

# HITL escalation tracker — item_id → {first_notified, acknowledged, escalated, escalation_count}
_hitl_escalation: dict[str, dict] = {}


def _load_config():
    """Load Telegram bot token, admin group ID, and topic thread IDs."""
    global _bot_token, _chat_id, _loaded
    global _alert_thread_id, _server_status_thread_id, _hitl_thread_id
    if _loaded:
        return
    _loaded = True

    # 1. Environment variables
    _bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    _chat_id = os.getenv("ADMIN_GROUP_ID")

    # Topic thread IDs from env
    _alert_thread_id = _parse_int(os.getenv("ALERT_THREAD_ID"))
    _server_status_thread_id = _parse_int(os.getenv("SERVER_STATUS_THREAD_ID"))
    _hitl_thread_id = _parse_int(os.getenv("HITL_THREAD_ID"))

    if _bot_token and _chat_id:
        logger.info("Telegram notifier configured from env vars")
    else:
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
            if not _alert_thread_id:
                _alert_thread_id = _parse_int(env_vals.get("ALERT_THREAD_ID"))
            if not _server_status_thread_id:
                _server_status_thread_id = _parse_int(env_vals.get("SERVER_STATUS_THREAD_ID"))
            if not _hitl_thread_id:
                _hitl_thread_id = _parse_int(env_vals.get("HITL_THREAD_ID"))

            if _bot_token and _chat_id:
                logger.info("Telegram notifier configured from %s", dotenv)

    # 3. Fallback: orchestrator.json heartbeat config
    try:
        orch = config.load_orchestrator_config()
        hb_cfg = orch.get("heartbeat", {})
        if not _alert_thread_id:
            _alert_thread_id = _parse_int(hb_cfg.get("alert_thread_id"))
        if not _server_status_thread_id:
            _server_status_thread_id = _parse_int(hb_cfg.get("server_status_thread_id"))
        if not _hitl_thread_id:
            _hitl_thread_id = _parse_int(hb_cfg.get("hitl_thread_id"))
    except Exception:
        pass

    if not _bot_token or not _chat_id:
        logger.warning(
            "Telegram notifier disabled — no TELEGRAM_BOT_TOKEN/ADMIN_GROUP_ID found"
        )

    logger.info(
        "Topic routing: alerts=%s, server_status=%s, hitl=%s",
        _alert_thread_id or "General",
        _server_status_thread_id or "General",
        _hitl_thread_id or "General",
    )


def _parse_int(val) -> int | None:
    """Parse a value to int, returning None if empty/invalid."""
    if not val:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


# ── Core Send Functions ───────────────────────────────────


async def send_telegram(
    text: str,
    parse_mode: str = "Markdown",
    thread_id: int | None = None,
) -> bool:
    """Send a message via Telegram Bot API.

    Args:
        text: Message text.
        parse_mode: Telegram parse mode (Markdown/HTML).
        thread_id: Forum topic thread ID (None = General).

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
    if thread_id:
        payload["message_thread_id"] = thread_id

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


async def send_telegram_with_buttons(
    text: str,
    buttons: list[list[dict]],
    parse_mode: str = "Markdown",
    thread_id: int | None = None,
) -> bool:
    """Send a message with inline keyboard buttons via Telegram Bot API.

    Args:
        text: Message text.
        buttons: Inline keyboard layout — list of rows, each row a list of
                 {"text": "Label", "callback_data": "action:data"} dicts.
        parse_mode: Telegram parse mode (Markdown/HTML).
        thread_id: Forum topic thread ID (None = General).

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
        "reply_markup": json.dumps({"inline_keyboard": buttons}),
    }
    if thread_id:
        payload["message_thread_id"] = thread_id

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code == 200:
                return True
            logger.warning(
                "Telegram send (buttons) failed: %d %s",
                resp.status_code, resp.text[:200],
            )
            return False
    except Exception as e:
        logger.warning("Telegram send (buttons) error: %s", e)
        return False


# ── Immediate Notification Dispatch (sync-to-async bridge) ─


def _dispatch_async(coro):
    """Fire-and-forget an async coroutine from sync context.

    Tries the running event loop first (FastAPI/uvicorn context),
    falls back to a new loop in a thread if none exists.
    """
    import asyncio
    import threading

    try:
        loop = asyncio.get_running_loop()
        # We're inside an async context — schedule directly
        loop.create_task(coro)
        return
    except RuntimeError:
        pass

    # No running loop — spawn a background thread
    def _run():
        asyncio.run(coro)

    t = threading.Thread(target=_run, daemon=True)
    t.start()


def queue_notification(notification_type: str, **kwargs):
    """Send a notification immediately from sync context.

    Called from guardrails.py, task_processor.py, and suggestions.py
    which run in sync context. Uses fire-and-forget dispatch to send
    the Telegram notification without blocking the caller.
    """
    logger.info("Dispatching immediate notification: %s", notification_type)

    if notification_type == "hitl_briefing":
        _dispatch_async(notify_hitl_briefing(**kwargs))
    elif notification_type == "worker_approval":
        _dispatch_async(notify_worker_approval(**kwargs))
    else:
        logger.warning("Unknown notification type: %s", notification_type)


async def flush_notifications() -> int:
    """Deliver any remaining queued notifications. Returns count delivered.

    Legacy — kept for heartbeat compatibility. Most notifications now
    dispatch immediately via queue_notification().
    """
    delivered = 0
    while _notification_queue:
        notif = _notification_queue.popleft()
        try:
            ntype = notif.pop("type")
            if ntype == "hitl_briefing":
                await notify_hitl_briefing(**notif)
            elif ntype == "worker_approval":
                await notify_worker_approval(**notif)
            else:
                logger.warning("Unknown queued notification type: %s", ntype)
                continue
            delivered += 1
        except Exception as e:
            logger.warning("Failed to deliver queued notification: %s", e)
    return delivered


# ── Helpers ───────────────────────────────────────────────


def _bar(pct: float) -> str:
    """10-char percentage bar."""
    filled = round(min(pct, 100) / 10)
    return "\u25B0" * filled + "\u25B1" * (10 - filled)


def _lvl(pct: float) -> str:
    """Color icon based on percentage threshold."""
    if pct < 60:
        return "\U0001F7E2"  # green
    if pct < 85:
        return "\U0001F7E1"  # yellow
    return "\U0001F534"      # red


def _fmt_uptime(seconds: float) -> str:
    if seconds > 86400:
        return f"{int(seconds / 86400)}d {int((seconds % 86400) / 3600)}h"
    if seconds > 3600:
        return f"{int(seconds / 3600)}h {int((seconds % 3600) / 60)}m"
    return f"{int(seconds / 60)}m"


def _get_disk():
    """Get disk usage. Returns (pct, used_str, total_str)."""
    try:
        import shutil
        usage = shutil.disk_usage("/")
        pct = round((usage.used / usage.total) * 100, 1)
        used = f"{usage.used / (1024**3):.0f}G"
        total = f"{usage.total / (1024**3):.0f}G"
        return pct, used, total
    except Exception:
        return 0, "?", "?"


def _get_uptime() -> str:
    """Get system uptime string."""
    try:
        with open("/proc/uptime") as f:
            up_sec = float(f.read().split()[0])
        return _fmt_uptime(up_sec)
    except Exception:
        return ""


# ── Server Status Template ───────────────────────────────
# LOCKED TEMPLATE — do not alter without explicit user approval.
#
# ⚙️ OPAI Status
#
# 🟢 Services  3/3 healthy
# 🟢 CPU    20%  ▰▰▱▱▱▱▱▱▱▱
# 🟢 Mem    48%  ▰▰▰▰▰▱▱▱▱▱
# 🟢 Disk   50%  ▰▰▰▰▰▱▱▱▱▱
#        114G / 228G
# ⏱️ Up 1d 4h
# 💻 Sessions: 4  |  Tasks: 0


def _build_status_message(summary: dict) -> str:
    """Build the canonical Server Status message.

    Uses the locked template — Services, CPU, Mem, Disk, Uptime, Sessions/Tasks.
    """
    healthy = summary.get("healthy", 0)
    worker_total = summary.get("worker_total", summary.get("total", 0))
    cpu = summary.get("cpu", 0)
    mem = summary.get("memory", 0)
    sessions = summary.get("active_sessions", 0)
    running_tasks = summary.get("running_tasks", 0)

    disk_pct, disk_used, disk_total = _get_disk()
    uptime_str = _get_uptime()

    svc_icon = "\U0001F7E2" if healthy == worker_total else "\U0001F534"

    lines = [
        "\u2699\uFE0F *OPAI Status*",
        "",
        f"{svc_icon} Services  {healthy}/{worker_total} healthy",
        f"{_lvl(cpu)} CPU   `{cpu:3.0f}%`  {_bar(cpu)}",
        f"{_lvl(mem)} Mem   `{mem:3.0f}%`  {_bar(mem)}",
        f"{_lvl(disk_pct)} Disk  `{disk_pct:3.0f}%`  {_bar(disk_pct)}",
        f"       {disk_used} / {disk_total}",
    ]

    if uptime_str:
        lines.append(f"\u23F1\uFE0F Up {uptime_str}")

    lines.append(f"\U0001F4BB Sessions: {sessions}  |  Tasks: {running_tasks}")

    return "\n".join(lines)


# ── Heartbeat Notifications ───────────────────────────────


async def notify_changes(changes: list[dict], summary: dict) -> bool:
    """Route heartbeat changes to Alerts topic.

    Failures/stalls/restarts → single Alert message with action buttons.
    Completions are logged only, not sent as notifications.
    """
    if not changes:
        return True

    orch = config.load_orchestrator_config()
    hb_cfg = orch.get("heartbeat", {})
    if not hb_cfg.get("notifications_enabled", True):
        return True

    max_notifs = hb_cfg.get("max_notifications_per_cycle", 5)

    # Group by type
    failures = [c for c in changes if c["type"] == "failed"]
    stalls = [c for c in changes if c["type"] == "stall_detected"]
    restarts = [c for c in changes if c["type"] == "restarted"]

    cpu = summary.get("cpu", 0)
    mem = summary.get("memory", 0)

    _load_config()

    # ── Alerts topic: failures, stalls, restarts — single message ──
    alert_items = failures + stalls + restarts
    if not alert_items:
        return True

    lines = ["\U0001F6A8 *Alert*", ""]
    restart_worker_ids = []  # Track failed workers for restart buttons

    count = 0
    for c in failures:
        if count >= max_notifs:
            break
        name = c.get("title", c.get("item", "?"))
        lines.append(f"\U0001F534 `{name}` \u2014 *FAILED*")
        if c.get("error"):
            lines.append(f"   {c['error'][:120]}")
        # Track for restart button
        item_key = c.get("item", "")
        if item_key.startswith("worker:"):
            restart_worker_ids.append(item_key.replace("worker:", ""))
        count += 1

    for c in stalls:
        if count >= max_notifs:
            break
        name = c.get("title", c.get("item", "?"))
        action = c.get("action", "logged")
        lines.append(f"\U0001F7E1 `{name}` \u2014 *stalled*")
        lines.append(f"   {action}")
        item_key = c.get("item", "")
        if item_key.startswith("worker:"):
            restart_worker_ids.append(item_key.replace("worker:", ""))
        count += 1

    for c in restarts:
        if count >= max_notifs:
            break
        name = c.get("title", c.get("item", "?"))
        attempt = c.get("attempt", "")
        att_str = f" (attempt {attempt})" if attempt else ""
        lines.append(f"\U0001F504 `{name}` \u2014 auto-restarted{att_str}")
        count += 1

    # Only include health stats if resources are critical (>85%)
    if cpu > 85 or mem > 85:
        lines.append("")
        if cpu > 85:
            lines.append(f"{_lvl(cpu)} CPU `{cpu:3.0f}%`  {_bar(cpu)}")
        if mem > 85:
            lines.append(f"{_lvl(mem)} Mem `{mem:3.0f}%`  {_bar(mem)}")

    # Build restart buttons for failed/stalled workers
    if restart_worker_ids:
        buttons = []
        for wid in restart_worker_ids[:3]:  # Max 3 buttons
            buttons.append(
                {"text": f"Restart {wid}", "callback_data": f"svc:restart:{wid}"}
            )
        if len(restart_worker_ids) > 1:
            all_ids = ",".join(restart_worker_ids[:5])
            buttons.append(
                {"text": "Restart All", "callback_data": f"svc:restartall:{all_ids}"}
            )
        return await send_telegram_with_buttons(
            "\n".join(lines),
            [buttons],
            parse_mode="Markdown",
            thread_id=_alert_thread_id,
        )
    else:
        return await send_telegram(
            "\n".join(lines), parse_mode="Markdown", thread_id=_alert_thread_id
        )


async def notify_service_recovered(worker_id: str) -> bool:
    """Send a recovery notification to Alerts topic.

    Only called when a Telegram-initiated restart succeeds and the
    worker is confirmed healthy.
    """
    _load_config()
    text = f"\u2705 `{worker_id}` \u2014 *Back Online*"
    return await send_telegram(
        text, parse_mode="Markdown", thread_id=_alert_thread_id
    )


def mark_telegram_restart(worker_id: str):
    """Mark a worker as restarted via Telegram. Called by the restart API."""
    _telegram_restarts.add(worker_id)
    logger.info("Marked %s for Telegram recovery notification", worker_id)


def check_telegram_recovery(worker_id: str) -> bool:
    """Check if a worker was restarted via Telegram and is now due for recovery notice.

    Returns True and clears the flag if the worker was pending recovery.
    """
    if worker_id in _telegram_restarts:
        _telegram_restarts.discard(worker_id)
        return True
    return False


async def notify_activity_digest(snapshot: dict) -> bool:
    """Send a periodic status message to Server Status topic.

    Uses the locked Server Status template.
    """
    _load_config()
    summary = snapshot.get("summary", {})
    text = _build_status_message(summary)
    return await send_telegram(
        text, parse_mode="Markdown", thread_id=_server_status_thread_id
    )


async def notify_server_restart() -> bool:
    """Send a server restart notification to Server Status topic.

    Called once at engine startup.
    """
    _load_config()
    uptime_str = _get_uptime()

    lines = [
        "\U0001F504 *OPAI Engine Restarted*",
        "",
        f"\u23F1\uFE0F System uptime: {uptime_str}" if uptime_str else "",
    ]

    return await send_telegram(
        "\n".join(l for l in lines if l).strip(),
        parse_mode="Markdown",
        thread_id=_server_status_thread_id,
    )


async def notify_daily_summary(summary_text: str) -> bool:
    """Send end-of-day daily summary to Server Status topic."""
    orch = config.load_orchestrator_config()
    hb_cfg = orch.get("heartbeat", {})
    if not hb_cfg.get("notifications_enabled", True):
        return True

    _load_config()
    return await send_telegram(
        summary_text, parse_mode="Markdown", thread_id=_server_status_thread_id
    )


async def notify_synology_rescan() -> bool | None:
    """Send Synology Drive rescan progress to Server Status topic.

    Reads the daemon log to estimate rescan progress. Returns:
      True  — notification sent (rescan still running)
      False — send failed
      None  — rescan finished or daemon not running, no notification sent
    """
    import subprocess

    _load_config()

    # Find the cloud-drive-daemon PID
    try:
        result = subprocess.run(
            ["pgrep", "-f", "cloud-drive-daemon serve"],
            capture_output=True, text=True, timeout=5,
        )
        pids = result.stdout.strip().split()
        if not pids:
            return None  # Daemon not running
        pid = pids[-1]  # Use the newest daemon PID
    except Exception:
        return None

    # Check if rescan is still active (last rescan entry within 5 min)
    from pathlib import Path
    from datetime import datetime, timedelta

    log_path = Path.home() / ".SynologyDrive" / "log" / "daemon.log"
    if not log_path.is_file():
        return None

    try:
        result = subprocess.run(
            ["grep", "-c", "Rescan directory", str(log_path)],
            capture_output=True, text=True, timeout=10,
        )
        dirs_scanned = int(result.stdout.strip() or "0")
    except Exception:
        dirs_scanned = 0

    # Get last rescan timestamp
    try:
        result = subprocess.run(
            ["grep", "Rescan directory", str(log_path)],
            capture_output=True, text=True, timeout=10,
        )
        lines = result.stdout.strip().split("\n")
        last_line = lines[-1] if lines else ""
        # Extract timestamp: 2026-03-05T14:26:43
        ts_str = last_line.split(" ")[0] if last_line else ""
        if ts_str:
            last_ts = datetime.fromisoformat(ts_str)
            if datetime.now() - last_ts > timedelta(minutes=5):
                return None  # Rescan finished — no activity in 5 min
            last_dir = last_line.split("Rescan directory '")[-1].rstrip("'. (merge_mode: 1)")
        else:
            return None
    except Exception:
        return None

    # Get total dirs from inotify watch count (proxy for total scope)
    total_dirs = 81500  # Known baseline from investigation
    try:
        fdinfo_path = f"/proc/{pid}/fdinfo/16"
        result = subprocess.run(
            ["grep", "-c", "inotify", fdinfo_path],
            capture_output=True, text=True, timeout=10,
        )
        inotify_count = int(result.stdout.strip() or "0")
        if inotify_count > 0:
            total_dirs = inotify_count
    except Exception:
        pass

    # Get daemon CPU
    try:
        result = subprocess.run(
            ["ps", "-p", pid, "-o", "%cpu", "--no-headers"],
            capture_output=True, text=True, timeout=5,
        )
        daemon_cpu = float(result.stdout.strip() or "0")
    except Exception:
        daemon_cpu = 0

    # Calculate progress
    pct = min(round((dirs_scanned / total_dirs) * 100, 1), 99.9) if total_dirs > 0 else 0

    # Estimate time remaining
    try:
        # Get daemon uptime
        result = subprocess.run(
            ["ps", "-p", pid, "-o", "etimes", "--no-headers"],
            capture_output=True, text=True, timeout=5,
        )
        elapsed_sec = int(result.stdout.strip() or "0")
        if elapsed_sec > 60 and dirs_scanned > 100:
            rate = dirs_scanned / elapsed_sec  # dirs per second
            remaining = (total_dirs - dirs_scanned) / rate if rate > 0 else 0
            eta_str = _fmt_uptime(remaining)
        else:
            eta_str = "calculating..."
    except Exception:
        eta_str = "unknown"

    lines = [
        "\U0001F4C2 *Synology Rescan*",
        "",
        f"{_lvl(pct)} Progress `{pct:4.1f}%`  {_bar(pct)}",
        f"       {dirs_scanned:,} / ~{total_dirs:,} dirs",
        f"\U0001F4BB Daemon CPU: `{daemon_cpu:.0f}%`",
        f"\u23F1\uFE0F ETA: {eta_str}",
        f"\U0001F4C1 Current: `{last_dir[:45]}`",
    ]

    return await send_telegram(
        "\n".join(lines),
        parse_mode="Markdown",
        thread_id=_server_status_thread_id,
    )


async def notify_consolidation(extraction: dict, date_str: str) -> bool:
    """Send memory consolidation summary to Server Status topic (curated style)."""
    facts = extraction.get("stable_facts", [])
    wiki = extraction.get("wiki_updates", [])
    prefs = extraction.get("learned_preferences", [])
    corrections = extraction.get("corrections", [])

    lines = ["\U0001F9E0 *Memory Consolidation*", ""]
    lines.append(f"\U0001F4DD Facts: {len(facts)}  |  Wiki: {len(wiki)}")
    lines.append(f"\u2699\uFE0F Prefs: {len(prefs)}  |  Fixes: {len(corrections)}")

    if facts:
        top = facts[0]
        lines.append(f"\n\U0001F4A1 {top.get('fact', '?')}")

    if prefs:
        top_pref = prefs[0]
        lines.append(f"\U0001F527 {top_pref.get('preference', '?')}")

    if wiki:
        files = list({w.get("file", "?") for w in wiki})
        lines.append(f"\n\U0001F4C2 {', '.join(files[:5])}")

    _load_config()
    return await send_telegram(
        "\n".join(lines), parse_mode="Markdown", thread_id=_server_status_thread_id
    )


# ── HITL Notifications ────────────────────────────────────


async def notify_hitl_briefing(
    task_id: str,
    filename: str,
    title: str,
    priority: str = "normal",
    source: str = "",
    teamhub_item_id: str = "",
) -> bool:
    """Send a HITL briefing notification with action buttons to the HITL topic.

    If teamhub_item_id is provided, buttons route through Team Hub (v3.5+).
    Otherwise falls back to legacy filename-based routing.
    """
    _load_config()
    import time

    # Determine callback key — prefer Team Hub ID, fall back to filename
    cb_key = teamhub_item_id or filename

    priority_icon = {"high": "\U0001F534", "critical": "\U0001F534", "low": "\U0001F7E2"}.get(priority, "\U0001F7E1")

    lines = [
        f"{priority_icon} *HITL \u2014 Decision Needed*",
        "",
        f"\U0001F4CB *{title}*",
        f"Task: `{task_id}`",
        f"Priority: {priority} | Source: {source}",
    ]

    buttons = [
        [
            {"text": "\u25B6\uFE0F Run", "callback_data": f"hitl:run:{cb_key}"},
            {"text": "\u2705 Approve", "callback_data": f"hitl:approve:{cb_key}"},
        ],
        [
            {"text": "\U0001F5D1\uFE0F Dismiss", "callback_data": f"hitl:dismiss:{cb_key}"},
            {"text": "\u274C Reject", "callback_data": f"hitl:reject:{cb_key}"},
        ],
        [
            {"text": "\U0001F4BB Picked up in GC", "callback_data": f"hitl:gc:{cb_key}"},
        ],
    ]

    result = await send_telegram_with_buttons(
        "\n".join(lines),
        buttons,
        parse_mode="Markdown",
        thread_id=_hitl_thread_id,
    )

    # Track for escalation
    if result and cb_key:
        _hitl_escalation[cb_key] = {
            "first_notified": time.time(),
            "acknowledged": False,
            "escalated": False,
            "escalation_count": 0,
            "task_id": task_id,
            "title": title,
            "priority": priority,
        }

    return result


def acknowledge_hitl(item_key: str):
    """Mark an HITL item as acknowledged — clears the escalation timer.

    Called when any action is taken (approve/run/dismiss/reject/gc).
    """
    if item_key in _hitl_escalation:
        _hitl_escalation[item_key]["acknowledged"] = True
        logger.info("HITL escalation cleared for %s", item_key)


async def check_hitl_escalations(escalation_minutes: int = 15) -> int:
    """Check for unacknowledged HITL items and send escalation reminders.

    Called from the heartbeat loop. Returns count of escalations sent.
    """
    import time
    _load_config()
    now = time.time()
    sent = 0

    for item_key, tracker in list(_hitl_escalation.items()):
        if tracker.get("acknowledged"):
            continue

        age_min = (now - tracker["first_notified"]) / 60
        if age_min < escalation_minutes:
            continue

        # Already escalated recently? Wait another interval
        if tracker.get("escalated"):
            last_escalation = tracker.get("last_escalation", tracker["first_notified"])
            since_last = (now - last_escalation) / 60
            if since_last < escalation_minutes:
                continue

        # Send escalation
        count = tracker.get("escalation_count", 0) + 1
        title = tracker.get("title", item_key)
        priority = tracker.get("priority", "normal")

        lines = [
            f"\u23F0 *HITL Escalation* (#{count})",
            "",
            f"\U0001F4CB *{title}*",
            f"Waiting {int(age_min)} minutes for a decision.",
            f"Priority: {priority}",
        ]

        buttons = [
            [
                {"text": "\u25B6\uFE0F Run", "callback_data": f"hitl:run:{item_key}"},
                {"text": "\u2705 Approve", "callback_data": f"hitl:approve:{item_key}"},
            ],
            [
                {"text": "\U0001F5D1\uFE0F Dismiss", "callback_data": f"hitl:dismiss:{item_key}"},
                {"text": "\U0001F4BB Picked up in GC", "callback_data": f"hitl:gc:{item_key}"},
            ],
        ]

        result = await send_telegram_with_buttons(
            "\n".join(lines),
            buttons,
            parse_mode="Markdown",
            thread_id=_hitl_thread_id,
        )

        if result:
            tracker["escalated"] = True
            tracker["last_escalation"] = now
            tracker["escalation_count"] = count
            sent += 1
            logger.info("HITL escalation #%d for %s (age: %dm)", count, item_key, int(age_min))

    # Prune acknowledged entries older than 1 hour
    cutoff = now - 3600
    stale_keys = [
        k for k, v in _hitl_escalation.items()
        if v.get("acknowledged") and v.get("first_notified", now) < cutoff
    ]
    for k in stale_keys:
        del _hitl_escalation[k]

    return sent


# ── Personal Notifications ────────────────────────────────


async def notify_personal(
    title: str,
    status: str = "completed",
    worker: str = "",
    duration: str = "",
    summary: str = "",
    custom_message: str = "",
) -> bool:
    """Send a formatted personal notification to Server Status topic.

    Triggered when a watched task/item reaches completion.
    """
    _load_config()

    status_icon = {
        "completed": "\u2705",
        "done": "\u2705",
        "failed": "\u274C",
        "review": "\U0001F7E1",
    }.get(status, "\U0001F4CB")

    lines = [f"{status_icon} *Task Complete*", ""]
    lines.append(f"\U0001F4CB {title}")

    detail_parts = []
    if worker:
        detail_parts.append(f"Worker: {worker}")
    if duration:
        detail_parts.append(f"Duration: {duration}")
    if detail_parts:
        lines.append(" | ".join(detail_parts))

    if summary:
        lines.append(f"\n{summary[:300]}")

    if custom_message:
        lines.append(f"\n\U0001F4AC _{custom_message}_")

    return await send_telegram(
        "\n".join(lines), parse_mode="Markdown", thread_id=_server_status_thread_id
    )


def check_and_fire_personal_notifications(
    task_id: str = "",
    teamhub_item_id: str = "",
    status: str = "completed",
    title: str = "",
    worker: str = "",
    duration: str = "",
    summary: str = "",
):
    """Check if any watches match and fire personal notifications.

    Called from task completion points (fleet coordinator, task processor,
    tasks route, team hub). Runs synchronously — dispatches async send.
    """
    from routes.notifications import _read_watches, _write_watches

    watches = _read_watches()
    fired_any = False

    for watch in watches:
        if watch.get("status") != "watching":
            continue

        match = False
        if task_id and watch.get("task_id") == task_id:
            match = True
        if teamhub_item_id and watch.get("teamhub_item_id") == teamhub_item_id:
            match = True

        if not match:
            continue

        # Fire the notification
        display_title = title or watch.get("title", task_id or teamhub_item_id)
        custom = watch.get("message", "")

        _dispatch_async(notify_personal(
            title=display_title,
            status=status,
            worker=worker,
            duration=duration,
            summary=summary,
            custom_message=custom,
        ))

        watch["status"] = "fired"
        watch["fired_at"] = __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat()
        fired_any = True
        logger.info("Personal notification fired: %s → %s", watch.get("id"), display_title)

    if fired_any:
        _write_watches(watches)


async def notify_worker_approval(
    request_id: str,
    worker_name: str,
    action: str,
    params_summary: str = "",
) -> bool:
    """Send a worker approval request with action buttons to the HITL topic."""
    _load_config()

    lines = [
        "Approval Needed",
        "",
        f"Worker: {worker_name}",
        f"Action: {action}",
    ]
    if params_summary:
        lines.append(f"Details: {params_summary}")

    buttons = [[
        {"text": "Approve", "callback_data": f"appr:yes:{request_id}"},
        {"text": "Deny", "callback_data": f"appr:no:{request_id}"},
    ]]

    return await send_telegram_with_buttons(
        "\n".join(lines),
        buttons,
        parse_mode="Markdown",
        thread_id=_hitl_thread_id,
    )
