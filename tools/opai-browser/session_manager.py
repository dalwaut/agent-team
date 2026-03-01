"""Browser session management — persistent user-data-dirs for Playwright."""

import shutil
from pathlib import Path
from datetime import datetime, timezone

import config


def ensure_sessions_dir():
    """Create sessions directory if it doesn't exist."""
    config.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def list_sessions() -> list[dict]:
    """List all named browser sessions."""
    ensure_sessions_dir()
    sessions = []
    for d in sorted(config.SESSIONS_DIR.iterdir()):
        if d.is_dir() and not d.name.startswith("."):
            stat = d.stat()
            sessions.append({
                "name": d.name,
                "path": str(d),
                "created_at": datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat(),
                "last_used": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "size_mb": round(sum(f.stat().st_size for f in d.rglob("*") if f.is_file()) / (1024 * 1024), 2),
            })
    return sessions


def get_session_dir(name: str) -> Path:
    """Get or create a session directory. Returns the path."""
    ensure_sessions_dir()
    session_dir = config.SESSIONS_DIR / name
    session_dir.mkdir(parents=True, exist_ok=True)
    return session_dir


def session_exists(name: str) -> bool:
    """Check if a named session exists."""
    return (config.SESSIONS_DIR / name).is_dir()


def create_session(name: str) -> dict:
    """Create a new named session. Returns session info."""
    if session_exists(name):
        return {"error": f"Session '{name}' already exists"}

    session_dir = get_session_dir(name)
    return {
        "name": name,
        "path": str(session_dir),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def delete_session(name: str) -> bool:
    """Delete a named session and all its storage state."""
    session_dir = config.SESSIONS_DIR / name
    if not session_dir.is_dir():
        return False
    shutil.rmtree(session_dir)
    return True
