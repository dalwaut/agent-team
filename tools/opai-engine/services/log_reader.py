"""OPAI Engine — Log aggregation from files and journalctl.

Migrated from opai-monitor/log_reader.py with unified config imports.
"""

import asyncio
import os
import time
from collections import deque
from pathlib import Path

import config

# In-memory ring buffer for recent log lines
_log_buffer: deque[dict] = deque(maxlen=500)
_file_positions: dict[str, int] = {}


def get_recent_logs(limit: int = 100, source: str | None = None) -> list[dict]:
    """Return recent log entries from the buffer."""
    entries = list(_log_buffer)
    if source:
        entries = [e for e in entries if e.get("source") == source]
    return entries[-limit:]


def _parse_log_line(line: str, source: str) -> dict:
    """Parse a log line into structured format."""
    line = line.rstrip()
    if not line:
        return {}
    return {
        "text": line,
        "source": source,
        "timestamp": time.time(),
    }


async def tail_file(path: Path, source_name: str) -> list[dict]:
    """Read new lines from a log file since last position."""
    str_path = str(path)
    new_entries = []

    if not path.is_file():
        return new_entries

    try:
        size = path.stat().st_size
        last_pos = _file_positions.get(str_path, 0)

        if size < last_pos:
            last_pos = 0

        if size == last_pos:
            return new_entries

        with open(path, "r", errors="replace") as f:
            f.seek(last_pos)
            for line in f:
                entry = _parse_log_line(line, source_name)
                if entry:
                    new_entries.append(entry)
                    _log_buffer.append(entry)

            _file_positions[str_path] = f.tell()

    except (OSError, PermissionError):
        pass

    return new_entries


async def read_journalctl(unit_pattern: str = "opai-*",
                          lines: int = 50) -> list[dict]:
    """Read recent journalctl entries for OPAI services."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "journalctl", "--user", "-u", unit_pattern,
            "--no-pager", "-n", str(lines), "--output=short-iso",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        entries = []
        for line in stdout.decode("utf-8", errors="replace").splitlines():
            entry = _parse_log_line(line, "journalctl")
            if entry:
                entries.append(entry)
                _log_buffer.append(entry)
        return entries
    except (asyncio.TimeoutError, FileNotFoundError, OSError):
        return []


async def stream_journalctl(unit_pattern: str = "opai-*"):
    """Async generator that yields live journalctl lines."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "journalctl", "--user", "-u", unit_pattern,
            "--no-pager", "-f", "--output=short-iso",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        while True:
            line = await asyncio.wait_for(
                proc.stdout.readline(), timeout=30
            )
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                entry = {"text": text, "source": "journalctl", "timestamp": time.time()}
                _log_buffer.append(entry)
                yield entry
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass
    except (FileNotFoundError, OSError):
        pass
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


async def collect_all_logs() -> list[dict]:
    """One-shot: read new lines from all log files + journalctl."""
    entries = []

    for log_path in config.LOG_SOURCES:
        source = log_path.stem
        new = await tail_file(log_path, source)
        entries.extend(new)

    journal = await read_journalctl(lines=20)
    entries.extend(journal)

    return entries
