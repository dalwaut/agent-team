"""OPAI PRD Pipeline — Configuration."""

import os
from pathlib import Path

# ── Workspace ────────────────────────────────────────────
OPAI_ROOT = Path("/workspace/synced/opai")
TOOL_DIR  = OPAI_ROOT / "tools" / "opai-prd"
DATA_DIR  = TOOL_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

PROJECTS_DIR = OPAI_ROOT / "Projects"
SCRIPTS_DIR  = OPAI_ROOT / "scripts"

# Legacy flat file (fallback only — primary store is now Supabase prd_ideas table)
IDEAS_JSON = DATA_DIR / "ideas.json"

# ── Agent ─────────────────────────────────────────────────
PROMPT_FILE     = SCRIPTS_DIR / "prompt_prdgent.txt"
CLAUDE_CMD      = "claude"
AGENT_MODEL     = os.getenv("PRDGENT_MODEL", "sonnet")   # haiku is fast enough for eval
AGENT_MAX_TURNS = int(os.getenv("PRDGENT_MAX_TURNS", "3"))
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")    # enables API mode + PTC in shared wrapper

# ── Server ────────────────────────────────────────────────
HOST = os.getenv("OPAI_PRD_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_PRD_PORT", "8097"))

# ── Auth ──────────────────────────────────────────────────
SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY    = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_JWT_SECRET  = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# ── Project Templates ────────────────────────────────────
PROJECT_SUBDIRS = ["docs", "assets", "research", "designs"]
