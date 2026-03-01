"""OPAI Forum Bot — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_FORUMBOT_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_FORUMBOT_PORT", "8095"))

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Forum Bot author (Supabase user ID that posts appear under)
FORUM_BOT_AUTHOR_ID = os.getenv("FORUM_BOT_AUTHOR_ID", "")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"
OPAI_ROOT = TOOL_DIR.parent.parent

# Claude CLI
CLAUDE_CMD = os.getenv("CLAUDE_CMD", "claude")
CLAUDE_TIMEOUT = int(os.getenv("CLAUDE_TIMEOUT", "120"))

# Scheduler
SCHEDULER_TICK = int(os.getenv("FORUMBOT_SCHEDULER_TICK", "60"))

# Pagination
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 50
