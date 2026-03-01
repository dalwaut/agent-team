"""OPAI Team Hub — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_TEAM_HUB_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_TEAM_HUB_PORT", "8089"))

# OPAI Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# AI
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.getenv("TEAM_HUB_CLAUDE_MODEL", "claude-sonnet-4-6")

# ClickUp
CLICKUP_API_KEY = os.getenv("CLICKUP_API_KEY", "pk_12684773_506E7BHJVG1DWN9GTHKM2LF9WSO5HQHN")
CLICKUP_TEAM_ID = os.getenv("CLICKUP_TEAM_ID", "8500473")
CLICKUP_BASE = "https://api.clickup.com/api/v2"

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"
