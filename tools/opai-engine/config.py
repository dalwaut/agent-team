"""OPAI Engine — Unified configuration & paths.

Merges Monitor + TCP + Orchestrator configs into a single module.

Two-level layout:
  /workspace/              — Operational root (live reports, logs, scratch)
  /workspace/synced/opai/  — OPAI framework source (git repo, synced across machines)
"""

import json
import os
from pathlib import Path

# ── Workspace (operational) ───────────────────────────────
WORKSPACE_ROOT = Path("/workspace")
REPORTS_DIR = WORKSPACE_ROOT / "reports"
REPORTS_LATEST = REPORTS_DIR / "latest"
REPORTS_ARCHIVE = REPORTS_DIR / "Archive"
REPORTS_HITL = REPORTS_DIR / "HITL"
LOGS_DIR = WORKSPACE_ROOT / "logs"
LOCAL_DIR = WORKSPACE_ROOT / "local"

# ── OPAI Framework (synced repo) ──────────────────────────
OPAI_ROOT = Path("/workspace/synced/opai")
TOOLS_DIR = OPAI_ROOT / "tools"
ENGINE_DIR = TOOLS_DIR / "opai-engine"
SCRIPTS_DIR = OPAI_ROOT / "scripts"

# Framework data sources
TEAM_JSON = OPAI_ROOT / "team.json"
QUEUE_JSON = OPAI_ROOT / "tasks" / "queue.json"
REGISTRY_JSON = OPAI_ROOT / "tasks" / "registry.json"
ARCHIVE_JSON = OPAI_ROOT / "tasks" / "archive.json"
AUDIT_JSON = OPAI_ROOT / "tasks" / "audit.json"
ORCHESTRATOR_JSON = OPAI_ROOT / "config" / "orchestrator.json"
CONTACTS_JSON = OPAI_ROOT / "config" / "contacts.json"
PROJECTS_DIR = OPAI_ROOT / "Projects"
CLIENTS_DIR = OPAI_ROOT / "Clients"
EMAIL_CHECKER_DIR = TOOLS_DIR / "email-checker"
SEND_EMAIL_SCRIPT = ENGINE_DIR / "send-email.js"

# Framework reports (reference copies, used by evolve/updater)
OPAI_REPORTS_DIR = OPAI_ROOT / "reports"
OPAI_REPORTS_LATEST = OPAI_ROOT / "reports" / "latest"

# ── Tool-specific paths ──────────────────────────────────
DISCORD_BRIDGE_DIR = TOOLS_DIR / "discord-bridge"
DISCORD_BOT_LOG = DISCORD_BRIDGE_DIR / "data" / "bot.log"

# ── Engine data ──────────────────────────────────────────
ENGINE_STATE_FILE = ENGINE_DIR / "data" / "engine-state.json"
UPDATER_STATE_FILE = ENGINE_DIR / "data" / "updater-state.json"
UPDATER_SUGGESTIONS_FILE = ENGINE_DIR / "data" / "updater-suggestions.json"

# Heartbeat (v3)
HEARTBEAT_STATE_FILE = ENGINE_DIR / "data" / "heartbeat-state.json"
DAILY_NOTES_DIR = OPAI_ROOT / "notes" / "daily"
TELEGRAM_DIR = TOOLS_DIR / "opai-telegram"

# Consolidator (v3.1)
CONSOLIDATOR_STATE_FILE = ENGINE_DIR / "data" / "consolidator-state.json"
WIKI_RECOMMENDATIONS_FILE = ENGINE_DIR / "data" / "wiki-recommendations.json"
TACIT_KNOWLEDGE_FILE = Path.home() / ".claude" / "projects" / "-workspace-synced-opai" / "memory" / "tacit-knowledge.md"
MEMORY_MD_FILE = Path.home() / ".claude" / "projects" / "-workspace-synced-opai" / "memory" / "MEMORY.md"

# Bottleneck detector (v3.3)
APPROVAL_TRACKER_FILE = ENGINE_DIR / "data" / "approval-tracker.json"
BOTTLENECK_STATE_FILE = ENGINE_DIR / "data" / "bottleneck-state.json"
BOTTLENECK_SUGGESTIONS_FILE = ENGINE_DIR / "data" / "bottleneck-suggestions.json"

# Fleet coordinator (v3.5)
FLEET_STATE_FILE = ENGINE_DIR / "data" / "fleet-state.json"

# Worker mail (v3.6 — swarm messaging)
MAIL_DB_PATH = ENGINE_DIR / "data" / "mail.db"
AGENT_WORKSPACE_BASE = Path("/workspace/local/agent-workspaces")

# Proactive intelligence (v3.5)
PROACTIVE_STATE_FILE = ENGINE_DIR / "data" / "proactive-state.json"

# Personal notifications (v3.5)
PERSONAL_NOTIFICATIONS_FILE = ENGINE_DIR / "data" / "personal-notifications.json"

# Context harvester journal (v3.5)
JOURNAL_DIR = ENGINE_DIR / "data" / "journal"
JOURNAL_LATEST = ENGINE_DIR / "data" / "journal-latest.json"

# Assembly Line (v3.7 — end-to-end build pipeline)
ASSEMBLY_RUNS_FILE = ENGINE_DIR / "data" / "assembly-runs.json"

# Vercel Demo Platform (ephemeral demo deploys)
VERCEL_DEMOS_FILE = ENGINE_DIR / "data" / "vercel-demos.json"

# Knowledge refresher (v3.6 — nightly business context for chat agent)
KNOWLEDGE_REFRESHER_STATE_FILE = ENGINE_DIR / "data" / "knowledge-refresher-state.json"

# NFS dispatcher (v3.5 — external ClaudeClaw workers)
NFS_CLAWBOTS_BASE = Path(os.getenv("NFS_CLAWBOTS_BASE", "/workspace/users/_clawbots"))
NFS_ADMIN_HITL = Path(os.getenv("NFS_ADMIN_HITL", "/workspace/users/_admin/hitl"))
NFS_DISPATCHER_STATE_FILE = ENGINE_DIR / "data" / "nfs-dispatcher-state.json"

# Team Hub integration (v3.5 — Workers workspace)
TEAMHUB_INTERNAL = os.getenv("TEAMHUB_INTERNAL_URL", "http://127.0.0.1:8089/api/internal")
WORKERS_WORKSPACE_ID = os.getenv(
    "WORKERS_WORKSPACE_ID", "d27944f3-8079-4e40-9e5d-c323d6cf7b0f"
)
HITL_QUEUE_LIST_ID = os.getenv(
    "HITL_QUEUE_LIST_ID", "ac6071d1-c86b-4c09-b379-cae8e4f5bd63"
)
ACTIVE_WORK_LIST_ID = os.getenv(
    "ACTIVE_WORK_LIST_ID", "0e074890-a10f-4f7f-9155-9bf0094f9559"
)
# System user ID for creating items when no real user context
SYSTEM_USER_ID = os.getenv(
    "SYSTEM_USER_ID", "1c93c5fe-d304-40f2-9169-765d0d2b7638"
)

# Newsletter / feature announcements
ANNOUNCEMENTS_FILE = ENGINE_DIR / "data" / "feature-announcements.json"

# ── Log sources (all locations the dashboard tails) ───────
LOG_SOURCES = [
    LOGS_DIR / "orchestrator.log",
    LOGS_DIR / "bot.log",
    DISCORD_BOT_LOG,
]

# Agent detection
CLAUDE_TEMP_PATTERN = "/tmp/claude_prompt_*.??????"
CLAUDE_PROCESS_NAMES = ("claude", "claude-code")

# ── Services (systemd user units) ────────────────────────
# v2 services: engine replaces orchestrator + monitor + tasks
SYSTEMD_SERVICES = [
    "opai-engine",
    "opai-vault",
    "opai-caddy",
    "opai-portal",
    "opai-files",
    "opai-team-hub",
    "opai-users",
    "opai-wordpress",
    "opai-discord-bot",
    # opai-email-agent removed — now engine-managed
]
SYSTEMD_TIMERS = [
    "opai-docker-cleanup",
    "opai-journal-cleanup",
]

# ── Server ───────────────────────────────────────────────
HOST = os.getenv("OPAI_ENGINE_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_ENGINE_PORT", "8080"))

# Auth (legacy bearer token — kept for backward compat, Supabase JWT preferred)
AUTH_TOKEN = os.getenv("OPAI_ENGINE_TOKEN", os.getenv("OPAI_MONITOR_TOKEN", ""))

# Supabase auth
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Network lockdown PIN
LOCKDOWN_PIN = os.getenv("LOCKDOWN_PIN", "")

# ── WebSocket intervals (seconds) ────────────────────────
WS_STATS_INTERVAL = 2
WS_AGENTS_INTERVAL = 3
WS_LOGS_INTERVAL = 1
WS_CLAUDE_INTERVAL = 10

# ── Claude Max subscription ──────────────────────────────
CLAUDE_HOME = Path.home() / ".claude"
MAX_CONCURRENT_SESSIONS = 20

# ── Updater agent ────────────────────────────────────────
UPDATER_SCAN_INTERVAL = 300  # 5 minutes

# ── HTTP health services to probe ────────────────────────
# Service name → port. Engine probes these for /health summary.
HEALTH_SERVICES = {
    "engine": PORT,
    "portal": 8090,
    "files": 8086,
    "team-hub": 8089,
    "users": 8084,
    "wordpress": 8096,
    "vault": 8105,
    "browser": 8107,
    "brain": 8101,
    "studio": 8108,
    "eliza-hub": 8083,
    "eliza": 8085,
}

# systemd-only services (no HTTP endpoint, checked via systemctl)
SYSTEMD_ONLY = ["opai-discord-bot"]


# ── Orchestrator config (loaded from orchestrator.json) ───
def load_orchestrator_config() -> dict:
    """Load orchestrator.json with defaults."""
    defaults = {
        "schedules": {
            "email_check": "*/30 * * * *",
            "health_check": "*/5 * * * *",
            "task_process": "*/15 * * * *",
            "feedback_process": "*/5 * * * *",
            "feedback_act": "*/15 * * * *",
            "user_sandbox_scan": "*/5 * * * *",
            "self_assessment": "0 2 * * *",
            "evolution": "0 3 * * *",
            "workspace_audit": "0 9 * * 1",
        },
        "resources": {
            "max_cpu_percent": 80,
            "max_memory_percent": 85,
            "max_parallel_jobs": 3,
            "check_interval_seconds": 30,
        },
        "services": {},
        "task_processor": {
            "auto_execute": True,
            "max_squad_runs_per_cycle": 2,
            "cooldown_minutes": 30,
            "max_parallel_jobs": 3,
        },
        "sandbox": {
            "enabled": True,
            "scan_root": "/workspace/users",
            "max_user_jobs_parallel": 2,
            "timeout_seconds": 300,
        },
        "heartbeat": {
            "interval_minutes": 30,
            "stall_threshold_minutes": 60,
            "daily_note_hour": 23,
            "daily_note_minute": 55,
            "notifications_enabled": True,
            "ai_summary_enabled": True,
            "max_notifications_per_cycle": 5,
        },
        "consolidator": {
            "enabled": True,
            "hour": 1,
            "minute": 0,
            "model": "haiku",
            "prune_memory_md": False,
            "max_extraction_tokens": 2000,
            "notification_enabled": True,
        },
        "command_channels": {
            "telegram": {
                "trust_by_role": {
                    "owner": "command",
                    "admin": "command",
                    "member": "proposal",
                    "viewer": "context",
                }
            },
            "discord": {
                "trust_by_channel_role": {
                    "admin": "command",
                    "team-hub": "proposal",
                },
                "require_home_guild": True,
            },
            "email": {"trust_level": "proposal"},
            "portal": {
                "trust_by_role": {
                    "admin": "command",
                    "user": "proposal",
                }
            },
            "scheduler": {"trust_level": "command"},
            "system": {"trust_level": "command"},
            "feedback": {"trust_level": "command"},
            "default": {"trust_level": "proposal"},
        },
        "bottleneck_detector": {
            "enabled": True,
            "interval_hours": 6,
            "approval_threshold": 10,
            "lookback_days": 7,
        },
        "process_sweeper": {
            "enabled": True,
            "interval_seconds": 300,
            "min_age_seconds": 600,
            "max_kills_per_cycle": 10,
            "sigterm_wait_seconds": 5,
            "dry_run": False,
            "notify_on_kill": True,
        },
    }
    try:
        if ORCHESTRATOR_JSON.is_file():
            loaded = json.loads(ORCHESTRATOR_JSON.read_text())
            # Merge loaded over defaults (shallow per top-level key)
            for key in defaults:
                if key in loaded:
                    if isinstance(defaults[key], dict):
                        defaults[key].update(loaded[key])
                    else:
                        defaults[key] = loaded[key]
            # Keep any extra keys from loaded
            for key in loaded:
                if key not in defaults:
                    defaults[key] = loaded[key]
    except (json.JSONDecodeError, OSError):
        pass
    return defaults
