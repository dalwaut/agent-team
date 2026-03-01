"""OPAI Agents — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_AGENTS_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_AGENTS_PORT", "8088"))

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
WORKSPACE_ROOT = Path("/workspace/synced/opai")
TEAM_JSON = WORKSPACE_ROOT / "team.json"
SCRIPTS_DIR = WORKSPACE_ROOT / "scripts"
TEMPLATES_DIR = WORKSPACE_ROOT / "Templates"
REPORTS_DIR = WORKSPACE_ROOT / "reports"
ORCHESTRATOR_CONFIG = WORKSPACE_ROOT / "config" / "orchestrator.json"
USERS_ROOT = Path("/workspace/users")

# Agent categories (used in wizard dropdown)
AGENT_CATEGORIES = [
    "quality", "planning", "research", "operations",
    "leadership", "content", "execution", "meta", "orchestration",
]

# Run order options
RUN_ORDERS = ["parallel", "first", "last"]
