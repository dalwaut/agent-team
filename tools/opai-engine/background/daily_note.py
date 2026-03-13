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
    git_activity = _get_git_activity(date_str)
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
            git_activity=git_activity,
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
        lines.append("_No audit work items recorded today._")
        lines.append("")

    # Git Activity (actual file changes — the real record of work done)
    if git_activity.get("commits"):
        lines.append("## Git Activity")
        lines.append(git_activity.get("summary", ""))
        lines.append("")
        for c in git_activity["commits"][:15]:
            lines.append(f"- `{c['hash']}` {c['message']}")
        lines.append("")

        files = git_activity.get("files_changed", [])
        wiki_files = [f for f in files if "opai-wiki" in f]
        tool_files = [f for f in files if f.startswith("tools/")]
        if wiki_files:
            lines.append(f"### Wiki Updates ({len(wiki_files)} files)")
            for f in wiki_files[:10]:
                lines.append(f"- {f}")
            lines.append("")
        if tool_files:
            lines.append(f"### Tool Changes ({len(tool_files)} files)")
            for f in tool_files[:10]:
                lines.append(f"- {f}")
            lines.append("")
    else:
        lines.append("## Git Activity")
        lines.append("_No commits found for today._")
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
    stats_parts = [f"Completed: {len(completed)}"]
    if task_changes:
        stats_parts.append(f"Task updates: {len(task_changes)}")
    if failed:
        stats_parts.append(f"Failed: {len(failed)}")
    if restart_count:
        stats_parts.append(f"Restarts: {restart_count}")
    tg_lines.append(" | ".join(stats_parts))
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


def _get_git_activity(date_str: str) -> dict:
    """Collect git commits and changed files for the given date."""
    import subprocess

    result = {"commits": [], "files_changed": [], "summary": ""}

    try:
        log_output = subprocess.run(
            [
                "git", "log",
                f"--since={date_str} 00:00",
                f"--until={date_str} 23:59",
                "--format=%H|%s|%an|%ai",
                "--no-merges",
            ],
            capture_output=True, text=True, timeout=10,
            cwd=str(config.OPAI_ROOT),
        )

        if log_output.returncode == 0 and log_output.stdout.strip():
            for line in log_output.stdout.strip().split("\n")[:30]:
                parts = line.split("|", 3)
                if len(parts) >= 2:
                    result["commits"].append({
                        "hash": parts[0][:8],
                        "message": parts[1],
                        "author": parts[2] if len(parts) > 2 else "",
                        "date": parts[3] if len(parts) > 3 else "",
                    })

        diff_output = subprocess.run(
            [
                "git", "log",
                f"--since={date_str} 00:00",
                f"--until={date_str} 23:59",
                "--no-merges",
                "--stat", "--stat-width=120",
                "--format=",
            ],
            capture_output=True, text=True, timeout=10,
            cwd=str(config.OPAI_ROOT),
        )

        if diff_output.returncode == 0 and diff_output.stdout.strip():
            seen = set()
            for line in diff_output.stdout.strip().split("\n"):
                line = line.strip()
                if "|" in line and not line.startswith(" "):
                    fname = line.split("|")[0].strip()
                    if fname and fname not in seen:
                        seen.add(fname)
                        result["files_changed"].append(fname)

        n_commits = len(result["commits"])
        n_files = len(result["files_changed"])
        if n_commits:
            dirs = {}
            for f in result["files_changed"]:
                top = f.split("/")[0] if "/" in f else f
                dirs[top] = dirs.get(top, 0) + 1
            dir_summary = ", ".join(
                f"{d} ({c})" for d, c in sorted(dirs.items(), key=lambda x: -x[1])[:8]
            )
            result["summary"] = f"{n_commits} commits, {n_files} files changed. Areas: {dir_summary}"
        else:
            result["summary"] = "No commits found for this date."

    except (subprocess.TimeoutExpired, OSError) as e:
        logger.warning("Git activity collection failed: %s", e)

    return result


async def _ai_summary(
    completed: list,
    failed: list,
    restarts: list,
    task_changes: list,
    summary_data: dict,
    git_activity: dict | None = None,
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

        if git_activity and git_activity.get("commits"):
            prompt_parts.append(f"\nGit activity: {git_activity.get('summary', '')}")
            for c in git_activity["commits"][:8]:
                prompt_parts.append(f"  - {c['message']}")

        if task_changes:
            prompt_parts.append(f"\nTask registry updates ({len(task_changes)}):")
            for tc in task_changes[:10]:
                prompt_parts.append(f"  - {tc.get('title', tc.get('id', '?'))} → {tc.get('status', '?')}")

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
            system="You are OPAI's internal summarizer. Write a brief, factual 2-3 sentence summary of today's system activity. Consider ALL signals: git commits, task registry updates, completed jobs, and system health. Task registry updates reflect real work (planning, status changes, coordination) even without commits. On quiet days, say what DID happen rather than leading with what didn't. No greetings, no fluff.",
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
