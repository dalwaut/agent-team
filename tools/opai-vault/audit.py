"""OPAI Vault — Audit logger.

Logs every credential access with timestamp, caller, action, and target.
Never logs credential values — only names and metadata.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import config


def _load_log() -> list[dict]:
    """Load audit log entries."""
    if not config.AUDIT_LOG.exists():
        return []
    try:
        return json.loads(config.AUDIT_LOG.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def _save_log(entries: list[dict]):
    """Save audit log, trimming to max entries."""
    if len(entries) > config.MAX_AUDIT_ENTRIES:
        entries = entries[-config.MAX_AUDIT_ENTRIES:]
    config.AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
    config.AUDIT_LOG.write_text(json.dumps(entries, indent=2))


def log_access(
    action: str,
    target: str,
    caller: str,
    caller_ip: str = "",
    success: bool = True,
    detail: str = "",
):
    """Log a vault access event.

    Actions: get, set, delete, list, generate_env, reload, export
    Target: secret name, service name, or section
    Caller: service identity or 'admin'
    """
    entries = _load_log()
    entries.append({
        "ts": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "target": target,
        "caller": caller,
        "caller_ip": caller_ip,
        "success": success,
        "detail": detail,
    })
    _save_log(entries)


def get_recent(limit: int = 50, action_filter: Optional[str] = None) -> list[dict]:
    """Get recent audit log entries."""
    entries = _load_log()
    if action_filter:
        entries = [e for e in entries if e.get("action") == action_filter]
    return entries[-limit:]


def get_stats() -> dict:
    """Audit log statistics."""
    entries = _load_log()
    actions = {}
    for e in entries:
        a = e.get("action", "unknown")
        actions[a] = actions.get(a, 0) + 1
    return {
        "total_entries": len(entries),
        "actions": actions,
        "last_access": entries[-1]["ts"] if entries else None,
    }
