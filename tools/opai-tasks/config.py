"""OPAI Task Control Panel — Configuration & paths."""

import os
from pathlib import Path

# ── Workspace (operational) ───────────────────────────────
WORKSPACE_ROOT = Path("/workspace")
REPORTS_DIR = WORKSPACE_ROOT / "reports"
REPORTS_HITL = REPORTS_DIR / "HITL"
REPORTS_ARCHIVE = REPORTS_DIR / "Archive"

# ── OPAI Framework (synced repo) ──────────────────────────
OPAI_ROOT = Path("/workspace/synced/opai")
TOOLS_DIR = OPAI_ROOT / "tools"
SCRIPTS_DIR = OPAI_ROOT / "scripts"

# Framework data sources
TEAM_JSON = OPAI_ROOT / "team.json"
QUEUE_JSON = OPAI_ROOT / "tasks" / "queue.json"
REGISTRY_JSON = OPAI_ROOT / "tasks" / "registry.json"
ORCHESTRATOR_JSON = OPAI_ROOT / "config" / "orchestrator.json"
CONTACTS_JSON = OPAI_ROOT / "config" / "contacts.json"
PROJECTS_DIR = OPAI_ROOT / "Projects"
CLIENTS_DIR = OPAI_ROOT / "Clients"
EMAIL_CHECKER_DIR = TOOLS_DIR / "email-checker"
SEND_EMAIL_SCRIPT = TOOLS_DIR / "opai-tasks" / "send-email.js"

ARCHIVE_JSON = OPAI_ROOT / "tasks" / "archive.json"
AUDIT_JSON = OPAI_ROOT / "tasks" / "audit.json"
OPAI_REPORTS_DIR = OPAI_ROOT / "reports"
OPAI_REPORTS_LATEST = OPAI_ROOT / "reports" / "latest"

# ── Server ────────────────────────────────────────────────
HOST = os.getenv("OPAI_TASKS_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_TASKS_PORT", "8081"))

# Auth (legacy bearer token — kept for backward compat, Supabase JWT preferred)
AUTH_TOKEN = os.getenv("OPAI_TASKS_TOKEN", os.getenv("OPAI_MONITOR_TOKEN", ""))

# Supabase auth
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Network lockdown PIN
LOCKDOWN_PIN = os.getenv("LOCKDOWN_PIN", "")

