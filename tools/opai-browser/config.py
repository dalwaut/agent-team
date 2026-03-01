"""OPAI Browser Automation — Configuration."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Paths
OPAI_ROOT = Path("/workspace/synced/opai")
TOOLS_DIR = OPAI_ROOT / "tools"
BROWSER_DIR = TOOLS_DIR / "opai-browser"
SESSIONS_DIR = BROWSER_DIR / "data" / "sessions"

# Server
HOST = os.getenv("BROWSER_HOST", "127.0.0.1")
PORT = int(os.getenv("BROWSER_PORT", "8107"))

# Supabase (for future audit logging)
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Auth
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# Claude CLI
CLAUDE_BIN = os.getenv("CLAUDE_BIN", "/home/dallas/.nvm/versions/node/v20.19.5/bin/claude")
NVM_BIN = "/home/dallas/.nvm/versions/node/v20.19.5/bin"

# Playwright MCP settings
PLAYWRIGHT_MCP = "@playwright/mcp@latest"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
VIEWPORT = "1280x900"

# Job defaults
DEFAULT_MAX_TURNS = 15
DEFAULT_TIMEOUT_SEC = 300  # 5 min
MAX_CONCURRENT_JOBS = 3
JOB_HISTORY_MAX = 100  # Keep last N completed jobs in memory

# MCP config template for browser jobs
def build_mcp_config(session_dir: str, vision_ok: bool = False) -> dict:
    """Build a temporary MCP config for a browser job."""
    args = [
        PLAYWRIGHT_MCP,
        "--headless",
        "--user-data-dir", str(session_dir),
        "--user-agent", USER_AGENT,
        "--viewport-size", VIEWPORT,
    ]
    if not vision_ok:
        args.append("--no-screenshots")

    return {
        "mcpServers": {
            "playwright": {
                "type": "stdio",
                "command": "npx",
                "args": args,
            }
        }
    }
