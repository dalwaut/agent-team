"""Google Workspace — Co-Edit session manager.

Manages activity-gated co-editing sessions on Google Docs/Sheets.
Sessions are explicitly activated (via @agent join or Chat command),
require continuous human activity (10-min timeout), and can be
manually deactivated (@agent leave or Chat command).

Session state persisted to coedit-sessions.json.
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("opai.workspace_coedit")

SESSIONS_FILE = Path(__file__).resolve().parent.parent / "data" / "coedit-sessions.json"


# ── Session I/O ──────────────────────────────────────────

def load_sessions() -> dict:
    """Load co-edit sessions from disk."""
    try:
        if SESSIONS_FILE.is_file():
            data = json.loads(SESSIONS_FILE.read_text())
            return data if isinstance(data, dict) and "sessions" in data else {"sessions": {}}
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to load coedit sessions: %s", e)
    return {"sessions": {}}


def save_sessions(data: dict):
    """Persist co-edit sessions to disk."""
    try:
        SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SESSIONS_FILE.write_text(json.dumps(data, indent=2))
    except OSError as e:
        logger.error("Failed to save coedit sessions: %s", e)


# ── Session Management ───────────────────────────────────

def activate_session(
    doc_id: str,
    doc_title: str,
    doc_type: str,
    user_email: str,
    revision_id: str | None = None,
) -> dict:
    """Create or reactivate a co-edit session.

    Args:
        doc_id: Google Drive file ID.
        doc_title: Document title.
        doc_type: "document" or "spreadsheet".
        user_email: Email of the user who activated co-edit.
        revision_id: Current revision ID (baseline for activity detection).

    Returns:
        The session dict.
    """
    data = load_sessions()
    now = datetime.now(timezone.utc).isoformat()

    session = {
        "doc_id": doc_id,
        "doc_title": doc_title,
        "doc_type": doc_type,
        "activated_by": user_email,
        "activated_at": now,
        "last_human_edit": now,
        "last_agent_edit": None,
        "status": "active",
        "revision_baseline": revision_id,
    }

    data["sessions"][doc_id] = session
    save_sessions(data)
    logger.info("Co-edit activated: %s (%s) by %s", doc_title, doc_id, user_email)
    return session


def deactivate_session(doc_id: str, reason: str = "manual") -> dict | None:
    """End a co-edit session.

    Args:
        doc_id: Google Drive file ID.
        reason: "manual" (user said leave), "timeout" (no activity), or other.

    Returns:
        The deactivated session dict, or None if not found.
    """
    data = load_sessions()
    session = data["sessions"].get(doc_id)

    if not session:
        return None

    session["status"] = "inactive"
    session["deactivated_at"] = datetime.now(timezone.utc).isoformat()
    session["deactivate_reason"] = reason

    # Remove from active sessions
    del data["sessions"][doc_id]
    save_sessions(data)
    logger.info("Co-edit deactivated: %s (%s) — reason: %s", session.get("doc_title"), doc_id, reason)
    return session


def get_session(doc_id: str) -> dict | None:
    """Get a session by doc ID, or None if not found/active."""
    data = load_sessions()
    return data["sessions"].get(doc_id)


def get_active_sessions() -> list[dict]:
    """List all active co-edit sessions."""
    data = load_sessions()
    return [
        s for s in data["sessions"].values()
        if s.get("status") == "active"
    ]


def is_coedit_active(doc_id: str) -> bool:
    """Quick check if co-edit is active on a document."""
    session = get_session(doc_id)
    return session is not None and session.get("status") == "active"


def update_human_activity(doc_id: str, revision_id: str | None = None):
    """Bump last_human_edit timestamp (called when a human revision is detected)."""
    data = load_sessions()
    session = data["sessions"].get(doc_id)
    if not session:
        return

    session["last_human_edit"] = datetime.now(timezone.utc).isoformat()
    if revision_id:
        session["revision_baseline"] = revision_id
    save_sessions(data)


def update_agent_activity(doc_id: str):
    """Bump last_agent_edit timestamp (called after the agent makes an edit)."""
    data = load_sessions()
    session = data["sessions"].get(doc_id)
    if not session:
        return

    session["last_agent_edit"] = datetime.now(timezone.utc).isoformat()
    save_sessions(data)


def check_timeouts(timeout_minutes: int = 10) -> list[dict]:
    """Scan all active sessions and deactivate stale ones.

    Args:
        timeout_minutes: Minutes of no human activity before auto-deactivation.

    Returns:
        List of sessions that were timed out.
    """
    data = load_sessions()
    now = datetime.now(timezone.utc)
    timed_out = []

    # Iterate over a copy since we'll modify during iteration
    for doc_id, session in list(data["sessions"].items()):
        if session.get("status") != "active":
            continue

        last_edit_str = session.get("last_human_edit")
        if not last_edit_str:
            continue

        try:
            last_edit = datetime.fromisoformat(last_edit_str)
        except (ValueError, TypeError):
            continue

        elapsed_minutes = (now - last_edit).total_seconds() / 60

        if elapsed_minutes >= timeout_minutes:
            session_copy = dict(session)
            deactivate_session(doc_id, reason="timeout")
            timed_out.append(session_copy)

    return timed_out
