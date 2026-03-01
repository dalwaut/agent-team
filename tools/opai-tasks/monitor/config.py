"""Monitor config — imports shared values from parent TCP config, adds Monitor-specific."""

import os
from pathlib import Path

# Import shared values from parent config
from config import (
    WORKSPACE_ROOT, OPAI_ROOT, TOOLS_DIR, SCRIPTS_DIR,
    TEAM_JSON, QUEUE_JSON, REGISTRY_JSON, OPAI_REPORTS_DIR,
    SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET,
    AUTH_TOKEN,
)

# ── Monitor-specific paths ───────────────────────────────
MONITOR_DIR = TOOLS_DIR / "opai-monitor"
REPORTS_DIR = WORKSPACE_ROOT / "reports"
REPORTS_LATEST = REPORTS_DIR / "latest"
REPORTS_ARCHIVE = REPORTS_DIR / "Archive"
REPORTS_HITL = REPORTS_DIR / "HITL"
LOGS_DIR = WORKSPACE_ROOT / "logs"

# Orchestrator state
ORCHESTRATOR_DIR = TOOLS_DIR / "opai-orchestrator"
ORCHESTRATOR_STATE = ORCHESTRATOR_DIR / "data" / "orchestrator-state.json"
DISCORD_BRIDGE_DIR = TOOLS_DIR / "discord-bridge"
DISCORD_BOT_LOG = DISCORD_BRIDGE_DIR / "data" / "bot.log"

# Log sources
LOG_SOURCES = [
    LOGS_DIR / "orchestrator.log",
    LOGS_DIR / "bot.log",
    DISCORD_BOT_LOG,
]

# Agent detection
CLAUDE_TEMP_PATTERN = "/tmp/claude_prompt_*.??????"
CLAUDE_PROCESS_NAMES = ("claude", "claude-code")

# Services (systemd user units) — monitor removed from list
SYSTEMD_SERVICES = [
    "opai-orchestrator",
    "opai-discord-bot",
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

# Supabase service key + lockdown PIN (from env)
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
LOCKDOWN_PIN = os.getenv("LOCKDOWN_PIN", "")

# WebSocket intervals (seconds)
WS_STATS_INTERVAL = 2
WS_AGENTS_INTERVAL = 3
WS_LOGS_INTERVAL = 1
WS_CLAUDE_INTERVAL = 10

# Claude Max subscription
CLAUDE_HOME = Path.home() / ".claude"
MAX_CONCURRENT_SESSIONS = 20

# Updater agent
UPDATER_SCAN_INTERVAL = 300  # 5 minutes
UPDATER_STATE_FILE = MONITOR_DIR / "data" / "updater-state.json"
UPDATER_SUGGESTIONS_FILE = MONITOR_DIR / "data" / "updater-suggestions.json"
