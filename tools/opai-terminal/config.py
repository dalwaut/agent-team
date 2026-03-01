"""OPAI Terminal — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_TERMINAL_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_TERMINAL_PORT", "8082"))

# Supabase auth
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# Terminal settings
IDLE_TIMEOUT = int(os.getenv("TERMINAL_IDLE_TIMEOUT", "1800"))  # 30 minutes
AUDIT_LOG = Path(os.getenv("TERMINAL_AUDIT_LOG", "/workspace/logs/terminal-audit.log"))

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"

# Claude CLI path (installed via nvm, not in /bin/sh PATH)
CLAUDE_CLI = os.getenv("CLAUDE_CLI", os.path.expanduser("~/.nvm/versions/node/v20.19.5/bin/claude"))

# Ensure log directory exists
AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
