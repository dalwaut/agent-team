"""OPAI Monitor — Configuration & paths.

Two-level layout:
  /workspace/              — Operational root (live reports, logs, scratch)
  /workspace/synced/opai/  — OPAI framework source (git repo, synced across machines)

The dashboard reads OPERATIONAL data from /workspace/ (reports, logs).
The updater reads BOTH levels to detect framework changes for the evolve cycle.
Tool-specific data stays in each tool's data/ directory inside the framework.
"""

import os
from pathlib import Path

# ── Workspace (operational) ───────────────────────────────
WORKSPACE_ROOT = Path("/workspace")
REPORTS_DIR = WORKSPACE_ROOT / "reports"             # Live agent reports
REPORTS_LATEST = REPORTS_DIR / "latest"
REPORTS_ARCHIVE = REPORTS_DIR / "Archive"
REPORTS_HITL = REPORTS_DIR / "HITL"                  # Human-in-the-loop briefings
LOGS_DIR = WORKSPACE_ROOT / "logs"                   # Runtime logs
LOCAL_DIR = WORKSPACE_ROOT / "local"                 # Machine-local scratch

# ── OPAI Framework (synced repo) ──────────────────────────
OPAI_ROOT = Path("/workspace/synced/opai")
TOOLS_DIR = OPAI_ROOT / "tools"
MONITOR_DIR = TOOLS_DIR / "opai-monitor"
SCRIPTS_DIR = OPAI_ROOT / "scripts"

# Framework data sources
TEAM_JSON = OPAI_ROOT / "team.json"
QUEUE_JSON = OPAI_ROOT / "tasks" / "queue.json"
REGISTRY_JSON = OPAI_ROOT / "tasks" / "registry.json"

# Framework-internal reports (reference copies, used by evolve/updater)
OPAI_REPORTS_DIR = OPAI_ROOT / "reports"

# ── Tool-specific data ────────────────────────────────────
ORCHESTRATOR_DIR = TOOLS_DIR / "opai-orchestrator"
ORCHESTRATOR_STATE = ORCHESTRATOR_DIR / "data" / "orchestrator-state.json"
DISCORD_BRIDGE_DIR = TOOLS_DIR / "discord-bridge"
DISCORD_BOT_LOG = DISCORD_BRIDGE_DIR / "data" / "bot.log"
EMAIL_CHECKER_DIR = TOOLS_DIR / "email-checker"
API_SERVER_DIR = TOOLS_DIR / "opai-api-server"

# ── Log sources (all locations the dashboard tails) ───────
LOG_SOURCES = [
    # Workspace-level runtime logs
    LOGS_DIR / "orchestrator.log",
    LOGS_DIR / "bot.log",
    # Tool-specific logs that live inside the framework
    DISCORD_BOT_LOG,
]

# Agent detection
CLAUDE_TEMP_PATTERN = "/tmp/claude_prompt_*.??????"
CLAUDE_PROCESS_NAMES = ("claude", "claude-code")

# Services (systemd user units)
SYSTEMD_SERVICES = [
    "opai-orchestrator",
    "opai-discord-bot",
    "opai-monitor",
    "opai-chat",
    "opai-tasks",
    "opai-users",
    "opai-dev",
    "opai-files",
    "opai-docs",
    "opai-team-hub",
    "opai-billing",
    "opai-forumbot",
    "opai-wordpress",
    "opai-prd",
    "opai-orchestra",
    "opai-bot-space",
    "opai-bx4",
    "opai-brain",
    "opai-helm",
    "opai-marq",
    "opai-dam",
]
SYSTEMD_TIMERS = [
    "opai-email",
]

# Server
HOST = os.getenv("OPAI_MONITOR_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_MONITOR_PORT", "8080"))

# Auth (legacy bearer token — kept for backward compat, Supabase JWT preferred)
AUTH_TOKEN = os.getenv("OPAI_MONITOR_TOKEN", "")

# Supabase auth
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Network lockdown PIN (plaintext in .env, verified server-side)
LOCKDOWN_PIN = os.getenv("LOCKDOWN_PIN", "")

# WebSocket intervals (seconds)
WS_STATS_INTERVAL = 2
WS_AGENTS_INTERVAL = 3
WS_LOGS_INTERVAL = 1

# Claude Max subscription
CLAUDE_HOME = Path.home() / ".claude"
MAX_CONCURRENT_SESSIONS = 20

# WebSocket intervals (additional)
WS_CLAUDE_INTERVAL = 10

# Updater agent
UPDATER_SCAN_INTERVAL = 300  # 5 minutes
UPDATER_STATE_FILE = MONITOR_DIR / "data" / "updater-state.json"
UPDATER_SUGGESTIONS_FILE = MONITOR_DIR / "data" / "updater-suggestions.json"
