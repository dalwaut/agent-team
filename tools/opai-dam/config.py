"""DAM Bot — Do Anything Mode — Configuration."""
import os
from pathlib import Path

HOST = os.getenv("OPAI_DAM_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_DAM_PORT", "8104"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.getenv("DAM_CLAUDE_MODEL", "claude-sonnet-4-6")

TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"

# Scheduler tick in seconds
SCHEDULER_TICK = int(os.getenv("DAM_SCHEDULER_TICK", "30"))

# Internal service URLs
DISCORD_BRIDGE_URL = os.getenv("DISCORD_BRIDGE_URL", "http://127.0.0.1:8083")
TASKS_URL = os.getenv("TASKS_URL", "http://127.0.0.1:8081")
HELM_URL = os.getenv("HELM_URL", "http://127.0.0.1:8102")
PRD_URL = os.getenv("PRD_URL", "http://127.0.0.1:8097")

# Agent execution
OPAI_ROOT = Path(os.getenv("OPAI_ROOT", "/workspace/synced/opai"))
TEAM_JSON = OPAI_ROOT / "team.json"
SANDBOX_DIR = Path(os.getenv("DAM_SANDBOX_DIR", "/workspace/dam-sandbox"))

# Default autonomy level (1-4): 1=Supervised, 2=Guided, 3=Autonomous, 4=Full
DEFAULT_AUTONOMY = int(os.getenv("DAM_DEFAULT_AUTONOMY", "3"))

VERSION = "1.0.0"
