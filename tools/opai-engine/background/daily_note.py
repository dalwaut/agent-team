"""OPAI Engine — Daily Note Generator.

Generates structured daily notes at end of day from heartbeat history
and audit entries. Optionally enriched with AI summary via call_claude().
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import config
from background.notifier import notify_daily_summary

logger = logging.getLogger("opai-engine.daily-note")


async def generate_daily_note(heartbeat) -> str | None:
    """Build a daily note from today's heartbeat data + audit entries.

    Args:
        heartbeat: Heartbeat instance (for cycle count, snapshot data)

    Returns:
        Path to the written note file, or None on failure.
    """
    today = datetime.now()
    date_str = today.strftime("%Y-%m-%d")
    date_display = today.strftime("%B %d, %Y")

    # Gather data
    audit_entries = _get_todays_audit(date_str)
    task_changes = _get_task_changes(date_str)
    snapshot = heartbeat.get_latest()
    summary_data = snapshot.get("summary", {})

    # Classify audit entries
    completed = [
        e for e in audit_entries
        if e.get("status") == "completed" and e.get("tier") == "execution"
    ]
    failed = [
        e for e in audit_entries
        if e.get("status") == "failed"
    ]
    health_events = [
        e for e in audit_entries
        if e.get("tier") == "health"
    ]
    heartbeat_cycles = [
        e for e in health_events
        if e.get("event") == "heartbeat:cycle"
    ]
    restarts = [
        e for e in health_events
        if e.get("event") in ("heartbeat:restart", "heartbeat:stall")
    ]

    # Build markdown
    lines = [f"# OPAI Daily Note — {date_display}", ""]

    # AI Summary (optional)
    orch = config.load_orchestrator_config()
    hb_cfg = orch.get("heartbeat", {})
    ai_summary = None

    if hb_cfg.get("ai_summary_enabled", True):
        ai_summary = await _ai_summary(
            completed=completed,
            failed=failed,
            restarts=restarts,
            task_changes=task_changes,
            summary_data=summary_data,
        )

    if ai_summary:
        lines.append(f"> {ai_summary}")
        lines.append("")

    # Work Summary
    lines.append("## Work Summary")

    if completed:
        lines.append(f"### Completed ({len(completed)})")
        for e in completed:
            ts = _format_time(e.get("timestamp"))
            dur = _format_duration_ms(e.get("duration_ms"))
            dur_str = f" ({dur})" if dur else ""
            lines.append(f"- [{ts}] {e.get('summary', e.get('event', '?'))}{dur_str}")
        lines.append("")

    if failed:
        lines.append(f"### Failed ({len(failed)})")
        for e in failed:
            ts = _format_time(e.get("timestamp"))
            lines.append(f"- [{ts}] {e.get('summary', e.get('event', '?'))}")
        lines.append("")

    if task_changes:
        lines.append("### Task Updates")
        for tc in task_changes:
            lines.append(f"- {tc['title']} — {tc['status']}")
        lines.append("")

    if not completed and not failed and not task_changes:
        lines.append("_No work items recorded today._")
        lines.append("")

    # Service Health
    lines.append("## Service Health")
    if restarts:
        for r in restarts:
            ts = _format_time(r.get("timestamp"))
            lines.append(f"- [{ts}] {r.get('summary', r.get('event', '?'))}")
    else:
        healthy = summary_data.get("healthy", 0)
        total = summary_data.get("total", 0)
        if total > 0:
            lines.append(f"All services healthy ({healthy}/{total}). No restarts.")
        else:
            lines.append("_No health data available._")
    lines.append("")

    # Heartbeat Stats
    lines.append("## Heartbeat Stats")
    cycle_count = heartbeat._cycle_count
    notification_count = len([
        e for e in health_events
        if "heartbeat" in e.get("event", "")
    ])
    restart_count = len(restarts)
    lines.append(
        f"- Cycles: {cycle_count} | Health events: {notification_count} | Restarts: {restart_count}"
    )
    lines.append(
        f"- CPU: {summary_data.get('cpu', 0):.0f}% | Memory: {summary_data.get('memory', 0):.0f}%"
    )
    lines.append(
        f"- Active sessions: {summary_data.get('active_sessions', 0)}"
    )
    lines.append("")

    # Decisions Needed
    decisions = [e for e in audit_entries if e.get("status") == "failed" and e.get("tier") == "execution"]
    if decisions:
        lines.append("## Decisions Needed")
        for d in decisions:
            lines.append(f"- {d.get('summary', '?')} — review or re-assign?")
        lines.append("")

    content = "\n".join(lines)

    # Write note
    note_path = _write_note(content, date_str)

    # Send Telegram summary
    tg_lines = [f"OPAI Daily Summary — {date_display}", ""]
    if ai_summary:
        tg_lines.append(ai_summary)
        tg_lines.append("")
    tg_lines.append(
        f"Completed: {len(completed)} | Failed: {len(failed)} | "
        f"Restarts: {restart_count}"
    )
    tg_lines.append(
        f"Heartbeat cycles: {cycle_count} | "
        f"CPU {summary_data.get('cpu', 0):.0f}% | Mem {summary_data.get('memory', 0):.0f}%"
    )

    try:
        await notify_daily_summary("\n".join(tg_lines))
    except Exception as e:
        logger.warning("Failed to send daily summary to Telegram: %s", e)

    return str(note_path) if note_path else None


def _get_todays_audit(date_str: str) -> list[dict]:
    """Read audit.json, filter to today's entries."""
    try:
        if config.AUDIT_JSON.is_file():
            records = json.loads(config.AUDIT_JSON.read_text())
            return [
                r for r in records
                if r.get("timestamp", "").startswith(date_str)
            ]
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read audit.json: %s", e)
    return []


def _get_task_changes(date_str: str) -> list[dict]:
    """Read registry.json, find tasks updated today."""
    changes = []
    try:
        if config.REGISTRY_JSON.is_file():
            registry = json.loads(config.REGISTRY_JSON.read_text())
            for tid, task in registry.get("tasks", {}).items():
                updated = task.get("updatedAt", "")
                if updated and updated.startswith(date_str):
                    changes.append({
                        "id": tid,
                        "title": task.get("title", tid),
                        "status": task.get("status", "unknown"),
                        "updatedAt": updated,
                    })
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read registry.json: %s", e)
    return changes


async def _ai_summary(
    completed: list,
    failed: list,
    restarts: list,
    task_changes: list,
    summary_data: dict,
) -> str | None:
    """Generate a 2-3 sentence AI summary. Graceful fallback if unavailable."""
    try:
        # Import lazily to avoid circular deps
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
        from claude_api import call_claude

        prompt_parts = ["Summarize today's OPAI system activity in 2-3 concise sentences:"]
        prompt_parts.append(f"- {len(completed)} tasks/jobs completed")
        prompt_parts.append(f"- {len(failed)} failures")
        prompt_parts.append(f"- {len(restarts)} service restarts")
        prompt_parts.append(f"- {len(task_changes)} task registry updates")
        prompt_parts.append(f"- CPU: {summary_data.get('cpu', 0):.0f}%, Memory: {summary_data.get('memory', 0):.0f}%")

        if completed:
            prompt_parts.append("\nCompleted items:")
            for e in completed[:5]:
                prompt_parts.append(f"  - {e.get('summary', e.get('event', ''))}")

        if failed:
            prompt_parts.append("\nFailed items:")
            for e in failed[:3]:
                prompt_parts.append(f"  - {e.get('summary', e.get('event', ''))}")

        prompt = "\n".join(prompt_parts)

        result = await call_claude(
            prompt,
            system="You are OPAI's internal summarizer. Write a brief, factual 2-3 sentence summary of today's system activity. No greetings, no fluff. Start with the most important outcome.",
            model="haiku",
            max_tokens=200,
            timeout=30,
        )

        content = result.get("content", "").strip()
        if content:
            return content
    except Exception as e:
        logger.debug("AI summary unavailable: %s", e)
    return None


def _write_note(content: str, date_str: str) -> Path | None:
    """Write daily note to notes/daily/YYYY-MM-DD.md."""
    try:
        notes_dir = config.DAILY_NOTES_DIR
        notes_dir.mkdir(parents=True, exist_ok=True)
        note_path = notes_dir / f"{date_str}.md"
        note_path.write_text(content)
        logger.info("Daily note written: %s", note_path)
        return note_path
    except OSError as e:
        logger.error("Failed to write daily note: %s", e)
        return None


def _format_time(timestamp: str | None) -> str:
    """Extract HH:MM from an ISO timestamp."""
    if not timestamp:
        return "??:??"
    try:
        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        # Convert to local time
        local = dt.astimezone()
        return local.strftime("%H:%M")
    except (ValueError, TypeError):
        return "??:??"


def _format_duration_ms(ms: int | None) -> str:
    """Format milliseconds into a human-readable duration."""
    if not ms:
        return ""
    seconds = ms / 1000
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes = seconds / 60
    if minutes < 60:
        secs = int(seconds % 60)
        return f"{int(minutes)}m {secs}s"
    hours = int(minutes / 60)
    mins = int(minutes % 60)
    return f"{hours}h {mins}m"
