"""OPAI Monitor — Claude Session Collector.

Reads ~/.claude/stats-cache.json and session JSONL files to provide
token-based usage metrics for the Claude Max subscription model.
Also fetches live plan usage from Anthropic's OAuth API.
"""

import json
import logging
import os
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import psutil

from . import config

log = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────

CLAUDE_HOME = Path.home() / ".claude"
STATS_CACHE_FILE = CLAUDE_HOME / "stats-cache.json"
PROJECTS_DIR = CLAUDE_HOME / "projects"
MAX_CONCURRENT_SESSIONS = config.MAX_CONCURRENT_SESSIONS

# Cache TTLs
_STATS_CACHE_TTL = 60       # seconds
_SESSION_INDEX_TTL = 300     # 5 minutes

# ── Internal caches ───────────────────────────────────────

_stats_cache = None
_stats_cache_time = 0
_session_index = None
_session_index_time = 0


# ── Plan Usage (Anthropic OAuth API) ──────────────────────

CREDENTIALS_FILE = CLAUDE_HOME / ".credentials.json"
_PLAN_USAGE_API = "https://api.anthropic.com/api/oauth/usage"
_PLAN_USAGE_CACHE_TTL = 15  # seconds — don't hammer the API

_plan_usage_cache: dict = {}
_plan_usage_cache_time: float = 0


def _get_oauth_token() -> str | None:
    """Read OAuth access token from Claude Code credentials file."""
    try:
        data = json.loads(CREDENTIALS_FILE.read_text())
        return data.get("claudeAiOauth", {}).get("accessToken")
    except Exception:
        return None


def get_plan_usage() -> dict:
    """Fetch current plan usage from Anthropic OAuth API.

    Returns session (5h), weekly (7d all models), weekly Sonnet,
    and extra usage with utilization percentages and reset times.
    """
    global _plan_usage_cache, _plan_usage_cache_time
    now = time.time()
    if _plan_usage_cache and (now - _plan_usage_cache_time) < _PLAN_USAGE_CACHE_TTL:
        return _plan_usage_cache

    token = _get_oauth_token()
    if not token:
        return {"error": "No OAuth token found"}

    try:
        resp = httpx.get(
            _PLAN_USAGE_API,
            headers={
                "Authorization": f"Bearer {token}",
                "anthropic-beta": "oauth-2025-04-20",
                "Content-Type": "application/json",
            },
            timeout=10,
        )
        resp.raise_for_status()
        raw = resp.json()
    except Exception as e:
        log.warning("Failed to fetch plan usage: %s", e)
        if _plan_usage_cache:
            return _plan_usage_cache  # Return stale data on error
        return {"error": str(e)}

    # Normalize into a clean structure
    result = {
        "session": _normalize_usage(raw.get("five_hour"), "Current session"),
        "weekAll": _normalize_usage(raw.get("seven_day"), "Current week (all models)"),
        "weekSonnet": _normalize_usage(raw.get("seven_day_sonnet"), "Current week (Sonnet only)"),
        "weekOpus": _normalize_usage(raw.get("seven_day_opus"), "Current week (Opus only)"),
        "extraUsage": _normalize_extra(raw.get("extra_usage")),
        "raw": raw,
        "fetchedAt": datetime.now().isoformat(),
    }

    _plan_usage_cache = result
    _plan_usage_cache_time = now
    return result


def _normalize_usage(data: dict | None, label: str) -> dict | None:
    """Normalize a usage bucket (five_hour, seven_day, etc.)."""
    if not data:
        return None
    return {
        "label": label,
        "utilization": data.get("utilization", 0),
        "resetsAt": data.get("resets_at"),
    }


def _normalize_extra(data: dict | None) -> dict | None:
    """Normalize extra usage data."""
    if not data or not data.get("is_enabled"):
        return None
    return {
        "label": "Extra usage",
        "isEnabled": True,
        "monthlyLimit": data.get("monthly_limit"),
        "usedCredits": data.get("used_credits"),
        "utilization": data.get("utilization", 0),
    }


# ── Stats Cache Reader ────────────────────────────────────

def get_stats_cache() -> dict:
    """Read stats-cache.json with 60s TTL cache."""
    global _stats_cache, _stats_cache_time
    now = time.time()
    if _stats_cache is not None and (now - _stats_cache_time) < _STATS_CACHE_TTL:
        return _stats_cache

    try:
        if STATS_CACHE_FILE.is_file():
            _stats_cache = json.loads(STATS_CACHE_FILE.read_text())
            _stats_cache_time = now
            return _stats_cache
    except (json.JSONDecodeError, OSError):
        pass

    _stats_cache = {}
    _stats_cache_time = now
    return _stats_cache


# ── Session Index Builder ─────────────────────────────────

def build_session_index() -> list[dict]:
    """Lightweight scan of OPAI session JSONL files.

    Returns list of session metadata dicts (sessionId, cwd, model, size, mtime).
    Cached for 5 minutes.
    """
    global _session_index, _session_index_time
    now = time.time()
    if _session_index is not None and (now - _session_index_time) < _SESSION_INDEX_TTL:
        return _session_index

    sessions = []
    if not PROJECTS_DIR.is_dir():
        _session_index = sessions
        _session_index_time = now
        return sessions

    # Scan all project dirs that match the OPAI workspace
    for project_dir in PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        # Only scan OPAI-related project dirs
        if "workspace-synced-opai" not in project_dir.name:
            continue

        for jsonl_file in project_dir.glob("*.jsonl"):
            try:
                stat = jsonl_file.stat()
                # Read first few lines to extract session metadata
                meta = _extract_session_meta(jsonl_file)
                sessions.append({
                    "file": str(jsonl_file),
                    "sessionId": meta.get("sessionId", jsonl_file.stem),
                    "cwd": meta.get("cwd", ""),
                    "model": meta.get("model", ""),
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                    "mtimeIso": datetime.fromtimestamp(stat.st_mtime).isoformat() + "Z",
                })
            except OSError:
                continue

    # Sort by modification time, newest first
    sessions.sort(key=lambda s: s["mtime"], reverse=True)
    _session_index = sessions
    _session_index_time = now
    return sessions


def _extract_session_meta(jsonl_path: Path) -> dict:
    """Read first few lines of a JSONL to extract session metadata."""
    meta = {}
    try:
        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i > 20:  # Don't read too deep
                    break
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if entry.get("sessionId") and not meta.get("sessionId"):
                    meta["sessionId"] = entry["sessionId"]
                if entry.get("cwd") and not meta.get("cwd"):
                    meta["cwd"] = entry["cwd"]
                if entry.get("model") and not meta.get("model"):
                    meta["model"] = entry["model"]

                if all(k in meta for k in ("sessionId", "cwd", "model")):
                    break
    except OSError:
        pass
    return meta


# ── Session Detail Parser ─────────────────────────────────

def get_session_detail(session_id: str) -> dict | None:
    """Full parse of one session JSONL for detailed token breakdown.

    Returns dict with total tokens in/out/cache, message counts, tool calls, duration.
    """
    index = build_session_index()
    session = next((s for s in index if s["sessionId"] == session_id), None)
    if not session:
        return None

    jsonl_path = Path(session["file"])
    if not jsonl_path.is_file():
        return None

    tokens_input = 0
    tokens_output = 0
    tokens_cache_read = 0
    tokens_cache_create = 0
    message_count = 0
    tool_call_count = 0
    first_ts = None
    last_ts = None
    model = session.get("model", "")

    try:
        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Track timestamps
                ts = entry.get("timestamp")
                if ts:
                    if first_ts is None:
                        first_ts = ts
                    last_ts = ts

                # Count messages
                if entry.get("type") in ("human", "assistant", "user"):
                    message_count += 1

                # Extract usage from response entries
                usage = entry.get("usage") or entry.get("message", {}).get("usage") or {}
                if usage:
                    tokens_input += usage.get("input_tokens", 0)
                    tokens_output += usage.get("output_tokens", 0)
                    tokens_cache_read += usage.get("cache_read_input_tokens", 0) or usage.get("cacheReadInputTokens", 0)
                    tokens_cache_create += usage.get("cache_creation_input_tokens", 0) or usage.get("cacheCreationInputTokens", 0)

                # Count tool calls
                if entry.get("type") == "tool_use" or entry.get("tool_name"):
                    tool_call_count += 1

                if not model and entry.get("model"):
                    model = entry["model"]
    except OSError:
        return None

    # Calculate duration
    duration_ms = 0
    if first_ts and last_ts:
        try:
            t1 = _parse_timestamp(first_ts)
            t2 = _parse_timestamp(last_ts)
            if t1 and t2:
                duration_ms = int((t2 - t1).total_seconds() * 1000)
        except (ValueError, TypeError):
            pass

    return {
        "sessionId": session_id,
        "file": session["file"],
        "model": model,
        "cwd": session.get("cwd", ""),
        "size": session["size"],
        "mtime": session["mtimeIso"],
        "tokensInput": tokens_input,
        "tokensOutput": tokens_output,
        "tokensCacheRead": tokens_cache_read,
        "tokensCacheCreate": tokens_cache_create,
        "tokensTotal": tokens_input + tokens_output + tokens_cache_read + tokens_cache_create,
        "messageCount": message_count,
        "toolCallCount": tool_call_count,
        "durationMs": duration_ms,
    }


def _parse_timestamp(ts) -> datetime | None:
    """Parse various timestamp formats."""
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000 if ts > 1e12 else ts)
    if isinstance(ts, str):
        for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%f"):
            try:
                return datetime.strptime(ts, fmt)
            except ValueError:
                continue
    return None


# ── Live Usage (lightweight, 5s polling) ─────────────────

_live_cache: dict = {}
_live_cache_time: float = 0
_LIVE_CACHE_TTL = 8  # seconds — scans 7 days of JSONL, cache a bit longer


def get_live_usage() -> dict:
    """Lightweight live usage data optimized for frequent polling.

    Scans JSONL files across ALL project dirs for real-time stats:
    - Today's token/message/tool counts
    - Live 7-day daily trend (from JSONL mtimes + content)
    - Today's hourly activity breakdown (from timestamps)
    """
    global _live_cache, _live_cache_time
    now = time.time()
    if _live_cache and (now - _live_cache_time) < _LIVE_CACHE_TTL:
        return _live_cache

    stats = get_stats_cache()
    local_tz = ZoneInfo("America/Chicago")
    today_dt = datetime.now(tz=local_tz)
    today_str = today_dt.strftime("%Y-%m-%d")
    today_midnight = today_dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    week_ago_midnight = (today_dt - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

    # UTC offset in hours for quick timestamp conversion (e.g. -6 for CST)
    utc_offset_hours = today_dt.utcoffset().total_seconds() / 3600

    # Aggregate from stats-cache (lifetime totals)
    model_usage = stats.get("modelUsage", {})
    total_output = sum(m.get("outputTokens", 0) for m in model_usage.values())
    total_input = sum(m.get("inputTokens", 0) for m in model_usage.values())
    total_cache_read = sum(m.get("cacheReadInputTokens", 0) for m in model_usage.values())
    total_cache_create = sum(m.get("cacheCreationInputTokens", 0) for m in model_usage.values())

    # Build date strings for the last 7 days
    day_strs = [(today_dt - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(6, -1, -1)]
    # Initialize daily trend counters and today's hourly counters
    daily_counts: dict[str, dict] = {d: {"messages": 0, "sessions": 0, "toolCalls": 0} for d in day_strs}
    hourly_counts: dict[int, int] = {h: 0 for h in range(24)}

    # Today accumulators
    today_input = 0
    today_output = 0
    today_cache_read = 0
    today_cache_create = 0
    today_messages = 0
    today_sessions = 0
    today_tool_calls = 0
    active_sessions = 0
    today_models: dict[str, int] = {}

    if PROJECTS_DIR.is_dir():
        for project_dir in PROJECTS_DIR.iterdir():
            if not project_dir.is_dir():
                continue
            for jsonl_file in project_dir.glob("*.jsonl"):
                try:
                    fstat = jsonl_file.stat()
                    if fstat.st_mtime < week_ago_midnight:
                        continue

                    is_today = fstat.st_mtime >= today_midnight
                    file_day = datetime.fromtimestamp(fstat.st_mtime).strftime("%Y-%m-%d")

                    # Count session for its day
                    if file_day in daily_counts:
                        daily_counts[file_day]["sessions"] += 1

                    if is_today:
                        today_sessions += 1
                        if (now - fstat.st_mtime) < 120:
                            active_sessions += 1

                    with open(jsonl_file, "r", errors="replace") as f:
                        for line in f:
                            if '"usage"' not in line:
                                continue
                            try:
                                entry = json.loads(line)
                                ts = entry.get("timestamp", "")
                                if not ts:
                                    continue
                                msg = entry.get("message", {})
                                usage = msg.get("usage")
                                if not usage:
                                    continue

                                # Convert UTC timestamp to local date/hour
                                # Timestamps are ISO "2026-02-23T18:51:30.245Z"
                                try:
                                    utc_hour = int(ts[11:13])
                                    utc_day = ts[:10]
                                    # Quick local conversion — shift hour by UTC offset
                                    local_hour = utc_hour + int(utc_offset_hours)
                                    local_day = utc_day
                                    if local_hour < 0:
                                        local_hour += 24
                                        # Rolled back a day
                                        dt_tmp = datetime.strptime(utc_day, "%Y-%m-%d") - timedelta(days=1)
                                        local_day = dt_tmp.strftime("%Y-%m-%d")
                                    elif local_hour >= 24:
                                        local_hour -= 24
                                        dt_tmp = datetime.strptime(utc_day, "%Y-%m-%d") + timedelta(days=1)
                                        local_day = dt_tmp.strftime("%Y-%m-%d")
                                except (ValueError, IndexError):
                                    local_day = ts[:10]
                                    local_hour = -1

                                # Accumulate daily trend for any day in range
                                if local_day in daily_counts:
                                    daily_counts[local_day]["messages"] += 1
                                    content = msg.get("content")
                                    if isinstance(content, list):
                                        tc = sum(1 for c in content if isinstance(c, dict) and c.get("type") == "tool_use")
                                        daily_counts[local_day]["toolCalls"] += tc

                                # Today-specific accumulators
                                if local_day == today_str:
                                    today_input += usage.get("input_tokens", 0)
                                    today_output += usage.get("output_tokens", 0)
                                    today_cache_read += usage.get("cache_read_input_tokens", 0)
                                    today_cache_create += usage.get("cache_creation_input_tokens", 0)
                                    today_messages += 1

                                    content = msg.get("content")
                                    if isinstance(content, list):
                                        today_tool_calls += sum(
                                            1 for c in content
                                            if isinstance(c, dict) and c.get("type") == "tool_use"
                                        )

                                    model = msg.get("model", "unknown")
                                    today_models[model] = today_models.get(model, 0) + usage.get("output_tokens", 0)

                                    # Hourly breakdown (local hour)
                                    if 0 <= local_hour < 24:
                                        hourly_counts[local_hour] += 1

                            except (json.JSONDecodeError, KeyError):
                                continue
                except (OSError, PermissionError):
                    continue

    # Concurrency snapshot (lightweight — reuse psutil scan)
    concurrency = get_concurrency_snapshot()

    result = {
        "today": {
            "date": today_str,
            "inputTokens": today_input,
            "outputTokens": today_output,
            "cacheReadTokens": today_cache_read,
            "cacheCreateTokens": today_cache_create,
            "totalTokens": today_input + today_output + today_cache_read + today_cache_create,
            "messages": today_messages,
            "sessions": today_sessions,
            "toolCalls": today_tool_calls,
            "models": today_models,
        },
        "lifetime": {
            "totalSessions": stats.get("totalSessions", 0),
            "totalMessages": stats.get("totalMessages", 0),
            "outputTokens": total_output,
            "inputTokens": total_input,
            "cacheReadTokens": total_cache_read,
            "cacheCreateTokens": total_cache_create,
            "firstSession": stats.get("firstSessionDate"),
            "lastComputed": stats.get("lastComputedDate"),
        },
        "activeSessions": active_sessions,
        "concurrency": {
            "active": concurrency["active"],
            "max": concurrency["max"],
            "status": concurrency["status"],
        },
        "dailyTrend": [
            {"date": d, **daily_counts[d]}
            for d in day_strs
        ],
        "modelUsage": {
            name: {
                "outputTokens": info.get("outputTokens", 0),
                "inputTokens": info.get("inputTokens", 0),
            }
            for name, info in model_usage.items()
        },
        "hourCounts": {str(h): c for h, c in hourly_counts.items()},
    }

    _live_cache = result
    _live_cache_time = now
    return result


# ── Usage Dashboard ───────────────────────────────────────

def get_usage_dashboard() -> dict:
    """Aggregated dashboard data: today, week, model breakdown, trends, heatmap."""
    stats = get_stats_cache()
    if not stats:
        return _empty_dashboard()

    today = datetime.now().strftime("%Y-%m-%d")
    week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")

    # Daily activity
    daily = stats.get("dailyActivity", [])
    today_data = next((d for d in daily if d.get("date") == today), {})
    week_data = [d for d in daily if (d.get("date") or "") >= week_ago]

    # Model usage
    model_usage = stats.get("modelUsage", {})

    # Daily model tokens
    daily_tokens = stats.get("dailyModelTokens", [])
    today_tokens = next((d for d in daily_tokens if d.get("date") == today), {})
    today_output = sum(today_tokens.get("tokensByModel", {}).values())

    # Week totals
    week_messages = sum(d.get("messageCount", 0) for d in week_data)
    week_sessions = sum(d.get("sessionCount", 0) for d in week_data)
    week_tools = sum(d.get("toolCallCount", 0) for d in week_data)
    week_tokens = 0
    for dt in daily_tokens:
        if (dt.get("date") or "") >= week_ago:
            week_tokens += sum(dt.get("tokensByModel", {}).values())

    # Hourly heatmap
    hour_counts = stats.get("hourCounts", {})

    # Sessions by project (from session index)
    index = build_session_index()
    projects = {}
    for s in index:
        cwd = s.get("cwd", "")
        # Extract project name from cwd
        proj = _project_from_cwd(cwd)
        projects[proj] = projects.get(proj, 0) + 1

    return {
        "today": {
            "messages": today_data.get("messageCount", 0),
            "sessions": today_data.get("sessionCount", 0),
            "toolCalls": today_data.get("toolCallCount", 0),
            "outputTokens": today_output,
        },
        "week": {
            "messages": week_messages,
            "sessions": week_sessions,
            "toolCalls": week_tools,
            "tokens": week_tokens,
        },
        "lifetime": {
            "totalSessions": stats.get("totalSessions", 0),
            "totalMessages": stats.get("totalMessages", 0),
            "firstSession": stats.get("firstSessionDate"),
        },
        "modelUsage": {
            name: {
                "inputTokens": info.get("inputTokens", 0),
                "outputTokens": info.get("outputTokens", 0),
                "cacheReadInputTokens": info.get("cacheReadInputTokens", 0),
                "cacheCreationInputTokens": info.get("cacheCreationInputTokens", 0),
            }
            for name, info in model_usage.items()
        },
        "dailyTrend": [
            {
                "date": d.get("date"),
                "messages": d.get("messageCount", 0),
                "sessions": d.get("sessionCount", 0),
                "toolCalls": d.get("toolCallCount", 0),
                "tokens": sum(
                    next(
                        (dt.get("tokensByModel", {}) for dt in daily_tokens if dt.get("date") == d.get("date")),
                        {}
                    ).values()
                ),
            }
            for d in daily[-7:]  # Last 7 days
        ],
        "hourlyHeatmap": {str(h): hour_counts.get(str(h), 0) for h in range(24)},
        "sessionsByProject": dict(sorted(projects.items(), key=lambda x: -x[1])[:15]),
    }


def _empty_dashboard() -> dict:
    return {
        "today": {"messages": 0, "sessions": 0, "toolCalls": 0, "outputTokens": 0},
        "week": {"messages": 0, "sessions": 0, "toolCalls": 0, "tokens": 0},
        "lifetime": {"totalSessions": 0, "totalMessages": 0, "firstSession": None},
        "modelUsage": {},
        "dailyTrend": [],
        "hourlyHeatmap": {str(h): 0 for h in range(24)},
        "sessionsByProject": {},
    }


def _project_from_cwd(cwd: str) -> str:
    """Extract a short project name from a working directory path."""
    if not cwd:
        return "unknown"
    parts = cwd.split("/")
    # Look for known patterns
    if "tools" in parts:
        idx = parts.index("tools")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    if "Projects" in parts:
        idx = parts.index("Projects")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    if "Clients" in parts:
        idx = parts.index("Clients")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    # Fall back to last meaningful directory
    for part in reversed(parts):
        if part and part not in ("", "workspace", "synced", "opai"):
            return part
    return "opai"


# ── Concurrency Snapshot ──────────────────────────────────

def get_concurrency_snapshot() -> dict:
    """Get running claude processes and classify them.

    Returns active count, max limit, status level, and process list.
    """
    processes = []
    for proc in psutil.process_iter(["pid", "name", "cmdline", "create_time", "cwd"]):
        try:
            info = proc.info
            name = info.get("name", "")
            cmdline = info.get("cmdline") or []
            cmdline_str = " ".join(cmdline)

            # Match actual claude CLI processes only — skip electron/node subprocesses
            if name in ("claude", "claude-code"):
                pass  # direct match
            elif cmdline and cmdline[0].endswith("/claude"):
                pass  # full-path invocation
            else:
                continue

            # Skip Claude Desktop electron processes
            if "electron" in cmdline_str or "claude-desktop" in cmdline_str:
                continue

            # Classify session type
            session_type = _classify_session(cmdline_str, info.get("cwd", ""))
            uptime = time.time() - (info.get("create_time") or time.time())

            processes.append({
                "pid": info["pid"],
                "type": session_type,
                "uptime_seconds": int(uptime),
                "cwd": info.get("cwd", ""),
                "cmdline": cmdline_str[:200],
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    count = len(processes)
    if count >= 18:
        status = "critical"
    elif count >= 14:
        status = "warning"
    else:
        status = "ok"

    return {
        "active": count,
        "max": MAX_CONCURRENT_SESSIONS,
        "status": status,
        "processes": processes,
        "byType": _group_by_type(processes),
    }


def _classify_session(cmdline: str, cwd: str) -> str:
    """Classify a claude process by its invocation context."""
    cmdline_lower = cmdline.lower()
    if "-p" in cmdline.split() or "--print" in cmdline.split():
        # Non-interactive (piped) sessions
        if "discord" in (cwd or "").lower() or "discord" in cmdline_lower:
            return "discord-bot"
        if "feedback" in cmdline_lower:
            return "feedback-fixer"
        if "squad" in cmdline_lower or "agent" in cmdline_lower:
            return "automated-agent"
        return "automated"
    return "interactive"


def _group_by_type(processes: list[dict]) -> dict:
    """Group process count by type."""
    groups = {}
    for p in processes:
        t = p["type"]
        groups[t] = groups.get(t, 0) + 1
    return groups


# ── Claude Status ────────────────────────────────────────

_status_cache: dict = {}
_status_cache_time: float = 0
_STATUS_CACHE_TTL = 30  # seconds


def get_claude_status() -> dict:
    """Get Claude Code installation status: version, MCP servers, settings, memory."""
    global _status_cache, _status_cache_time
    now = time.time()
    if _status_cache and (now - _status_cache_time) < _STATUS_CACHE_TTL:
        return _status_cache

    result: dict = {
        "version": None,
        "loginMethod": None,
        "email": None,
        "model": None,
        "mcpServers": [],
        "memory": [],
        "settingSources": [],
        "activeSessions": [],
    }

    # Version — try multiple paths (systemd doesn't have nvm in PATH)
    claude_paths = [
        "claude",
        str(Path.home() / ".nvm/versions/node/v20.19.5/bin/claude"),
        "/usr/local/bin/claude",
    ]
    for claude_bin in claude_paths:
        try:
            env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
            out = subprocess.run(
                [claude_bin, "--version"],
                capture_output=True, text=True, timeout=5, env=env,
            )
            if out.returncode == 0 and out.stdout.strip():
                result["version"] = out.stdout.strip()
                break
        except Exception:
            continue

    # Credentials / login
    creds_file = CLAUDE_HOME / ".credentials.json"
    if creds_file.exists():
        try:
            creds = json.loads(creds_file.read_text())
            if "claudeAiOauth" in creds:
                result["loginMethod"] = "Claude Max Account"
        except Exception:
            pass

    # Settings
    settings_sources = []
    user_settings = CLAUDE_HOME / "settings.json"
    if user_settings.exists():
        settings_sources.append({"label": "User settings", "path": str(user_settings)})
        try:
            s = json.loads(user_settings.read_text())
            if "effortLevel" in s:
                result["effortLevel"] = s["effortLevel"]
        except Exception:
            pass

    local_settings = CLAUDE_HOME / "settings.local.json"
    if local_settings.exists():
        settings_sources.append({"label": "Project local settings", "path": str(local_settings)})

    # Project-level CLAUDE.md
    workspace = Path("/workspace/synced/opai")
    claude_md = workspace / "CLAUDE.md"
    if claude_md.exists():
        settings_sources.append({"label": "Project (CLAUDE.md)", "path": str(claude_md)})

    result["settingSources"] = settings_sources

    # Model — detect from active sessions or default
    result["model"] = "Default Opus 4.6"

    # MCP servers — scan .mcp.json in workspace
    mcp_file = workspace / ".mcp.json"
    mcp_servers = []
    if mcp_file.exists():
        try:
            mcp = json.loads(mcp_file.read_text())
            for name in mcp.get("mcpServers", {}):
                mcp_servers.append({"name": name, "status": "configured"})
        except Exception:
            pass

    # Also check for claude.ai MCP servers from the running environment
    # These are injected at runtime, detect from tool availability
    for ai_mcp in ["claude.ai n8n", "claude.ai Supabase", "claude.ai Netlify"]:
        mcp_servers.append({"name": ai_mcp, "status": "connected"})

    result["mcpServers"] = mcp_servers

    # Memory files
    memory = []
    if claude_md.exists():
        memory.append({
            "type": "project",
            "path": str(claude_md),
            "label": "project (" + claude_md.name + ")",
        })
    auto_memory = CLAUDE_HOME / "projects" / "-workspace-synced-opai" / "memory" / "MEMORY.md"
    if auto_memory.exists():
        memory.append({
            "type": "auto memory",
            "path": str(auto_memory),
            "label": "auto memory (~/.claude/projects/-workspace-synced-opai/memory/MEMORY.md)",
        })
    result["memory"] = memory

    # Active sessions (from concurrency snapshot — reuse lightweight scan)
    snap = get_concurrency_snapshot()
    result["activeSessions"] = snap.get("processes", [])
    result["sessionCount"] = snap.get("active", 0)

    _status_cache = result
    _status_cache_time = now
    return result
