"""Shared audit logger for all OPAI services.

Usage from any service:
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
    from audit import log_audit

    log_audit(
        tier="system",
        service="opai-wordpress",
        event="push-op",
        status="completed",
        summary="Push OP v2.1.3 — 4/5 sites updated",
        duration_ms=12000,
        details={"sites_total": 5, "sites_pushed": 4}
    )
"""

import json
import fcntl
import random
import time
from datetime import datetime, timezone
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────
AUDIT_JSON = Path("/workspace/synced/opai/tasks/audit.json")
AUDIT_ARCHIVE_JSON = Path("/workspace/synced/opai/tasks/audit-archive.json")
AUDIT_MAX_RECORDS = 2000

# Valid tiers
VALID_TIERS = ("execution", "system", "health")


def _generate_audit_id() -> str:
    """Generate a unique audit record ID: audit-YYYYMMDD-RRR-TTTTTT."""
    now = datetime.now()
    date_str = now.strftime("%Y%m%d")
    rand = random.randint(100, 999)
    ts = str(int(time.time() * 1000))[-6:]
    return f"audit-{date_str}-{rand}-{ts}"


def _read_audit() -> list:
    """Read audit.json, returning empty list on failure."""
    try:
        if AUDIT_JSON.is_file():
            return json.loads(AUDIT_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return []


def _write_audit_locked(records: list):
    """Write audit.json with file locking for cross-process safety."""
    AUDIT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(AUDIT_JSON, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            json.dump(records, f, indent=2)
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def _archive_overflow(overflow: list):
    """Append overflow records to audit-archive.json."""
    existing = []
    try:
        if AUDIT_ARCHIVE_JSON.is_file():
            existing = json.loads(AUDIT_ARCHIVE_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    existing.extend(overflow)
    with open(AUDIT_ARCHIVE_JSON, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            json.dump(existing, f, indent=2)
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def log_audit(
    tier: str,
    service: str,
    event: str,
    status: str = "completed",
    summary: str = "",
    duration_ms: int = None,
    details: dict = None,
) -> str:
    """Append a tiered audit record to audit.json.

    Args:
        tier: "execution", "system", or "health"
        service: originating service name (e.g., "opai-wordpress")
        event: event type (e.g., "push-op", "squad-run", "health-check")
        status: "completed", "failed", "partial", "skipped"
        summary: human-readable one-liner
        duration_ms: execution duration in milliseconds
        details: tier-specific additional data

    Returns:
        The generated audit ID.
    """
    if tier not in VALID_TIERS:
        tier = "system"

    audit_id = _generate_audit_id()
    now = datetime.now(timezone.utc).isoformat()

    record = {
        "id": audit_id,
        "timestamp": now,
        "tier": tier,
        "service": service,
        "event": event,
        "status": status,
        "summary": summary,
        "duration_ms": duration_ms,
        "details": details or {},
    }

    # Read, insert, cap, write — with file lock
    records = _read_audit()
    records.insert(0, record)  # newest first
    if len(records) > AUDIT_MAX_RECORDS:
        overflow = records[AUDIT_MAX_RECORDS:]
        records = records[:AUDIT_MAX_RECORDS]
        _archive_overflow(overflow)
    _write_audit_locked(records)

    return audit_id


def log_execution(
    service: str,
    event: str,
    status: str = "completed",
    summary: str = "",
    duration_ms: int = None,
    task_id: str = None,
    agent_id: str = None,
    agent_type: str = None,
    agent_name: str = None,
    model: str = None,
    tokens_input: int = 0,
    tokens_output: int = 0,
    tokens_cache_read: int = 0,
    tokens_total: int = 0,
    cost_usd: float = 0.0,
    num_turns: int = 0,
    report_file: str = None,
    session_id: str = None,
    is_error: bool = False,
    error_message: str = None,
    **extra_details,
) -> str:
    """Convenience wrapper for execution-tier audit records (agent/squad runs)."""
    details = {
        "taskId": task_id,
        "agentId": agent_id,
        "agentType": agent_type,
        "agentName": agent_name,
        "model": model,
        "tokensInput": tokens_input,
        "tokensOutput": tokens_output,
        "tokensCacheRead": tokens_cache_read,
        "tokensTotal": tokens_total,
        "costUsd": cost_usd,
        "numTurns": num_turns,
        "reportFile": report_file,
        "sessionId": session_id,
        "isError": is_error,
        "errorMessage": error_message,
    }
    details.update(extra_details)
    # Remove None values to keep records clean
    details = {k: v for k, v in details.items() if v is not None}

    return log_audit(
        tier="execution",
        service=service,
        event=event,
        status=status,
        summary=summary,
        duration_ms=duration_ms,
        details=details,
    )
