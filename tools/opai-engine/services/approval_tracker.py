"""OPAI Engine — Approval Tracker (v3.3).

Tracks every approval decision persistently for bottleneck pattern detection.
Ring buffer stored in data/approval-tracker.json (~500 records max).

Event types:
    task_auto_approved       — commandIntent decision == "allow"
    task_requires_approval   — commandIntent decision == "approve"
    task_denied              — commandIntent decision == "deny"
    task_manually_approved   — POST /tasks/{id}/approve
    task_cancelled           — POST /tasks/{id}/cancel
    worker_approval_requested — guardrails.request_approval()
    worker_approval_approved  — guardrails.approve_request()
    worker_approval_denied    — guardrails.deny_request()
"""

import json
import logging
import time
from datetime import datetime, timezone

import config

logger = logging.getLogger("opai-engine.approval-tracker")

TRACKER_FILE = config.APPROVAL_TRACKER_FILE
TRACKER_MAX_RECORDS = 500


def _read_tracker() -> list:
    """Read the approval tracker ring buffer."""
    try:
        if TRACKER_FILE.is_file():
            data = json.loads(TRACKER_FILE.read_text())
            return data if isinstance(data, list) else data.get("events", [])
    except (json.JSONDecodeError, OSError):
        pass
    return []


def _write_tracker(events: list):
    """Write the tracker, capping at TRACKER_MAX_RECORDS."""
    if len(events) > TRACKER_MAX_RECORDS:
        events = events[-TRACKER_MAX_RECORDS:]
    TRACKER_FILE.parent.mkdir(parents=True, exist_ok=True)
    TRACKER_FILE.write_text(json.dumps(events, indent=2, default=str))


def record_event(
    event_type: str,
    source: str = "",
    trust_level: str = "",
    action: str = "",
    approved_by: str = "",
    wait_time_sec: float = None,
    outcome: str = "",
    task_id: str = "",
    worker_id: str = "",
    metadata: dict = None,
) -> dict:
    """Record an approval event. Returns the created event record."""
    event = {
        "id": f"ae-{int(time.time() * 1000)}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event_type": event_type,
        "source": source,
        "trust_level": trust_level,
        "action": action,
        "approved_by": approved_by,
        "wait_time_sec": wait_time_sec,
        "outcome": outcome,
        "task_id": task_id,
        "worker_id": worker_id,
        "metadata": metadata or {},
    }

    events = _read_tracker()
    events.append(event)
    _write_tracker(events)

    logger.debug(
        "approval_tracker: %s source=%s trust=%s outcome=%s",
        event_type, source, trust_level, outcome,
    )
    return event


def get_events(limit: int = 100, event_type: str = None) -> list:
    """Get recent events, newest first, with optional type filter."""
    events = _read_tracker()
    if event_type:
        events = [e for e in events if e.get("event_type") == event_type]
    return list(reversed(events[-limit:]))


def get_stats() -> dict:
    """Aggregate stats over all tracked events."""
    events = _read_tracker()
    stats = {
        "total_events": len(events),
        "by_type": {},
        "by_source": {},
        "avg_wait_time_sec": None,
    }
    wait_times = []
    for e in events:
        et = e.get("event_type", "unknown")
        src = e.get("source", "unknown")
        stats["by_type"][et] = stats["by_type"].get(et, 0) + 1
        stats["by_source"][src] = stats["by_source"].get(src, 0) + 1
        wt = e.get("wait_time_sec")
        if wt is not None:
            wait_times.append(wt)
    if wait_times:
        stats["avg_wait_time_sec"] = round(sum(wait_times) / len(wait_times), 1)
    return stats
