"""OPAI Bot Space — Configuration."""

import os
from pathlib import Path

HOST = os.getenv("OPAI_BOT_SPACE_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_BOT_SPACE_PORT", "8099"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"

# Internal service endpoints for dispatch
EMAIL_AGENT_URL = os.getenv("EMAIL_AGENT_URL", "http://127.0.0.1:8093")
FORUM_BOT_URL = os.getenv("FORUM_BOT_URL", "http://127.0.0.1:8095")

# Scheduler tick interval (seconds)
SCHEDULER_TICK = int(os.getenv("BOT_SPACE_SCHEDULER_TICK", "60"))
