"""OPAI Chat - Configuration and constants."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Server configuration
HOST = os.getenv("OPAI_CHAT_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_CHAT_PORT", "8888"))

# API Keys
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Supabase auth
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# Admin notification
ADMIN_EMAIL = os.getenv("OPAI_ADMIN_EMAIL", "dallas@artistatlarge.com")

# User sandboxes root (Synology NAS mount point)
USERS_ROOT = Path(os.getenv("OPAI_USERS_ROOT", "/workspace/users"))

# Paths
OPAI_ROOT = Path("/workspace/synced/opai")
WORKSPACE_ROOT = Path("/workspace")
TOOL_DIR = Path(__file__).parent
DATA_DIR = TOOL_DIR / "data"
CONVERSATIONS_DIR = DATA_DIR / "conversations"
STATIC_DIR = TOOL_DIR / "static"

# Ensure data directories exist
CONVERSATIONS_DIR.mkdir(parents=True, exist_ok=True)

# File access configuration
ALLOWED_ROOTS = [
    OPAI_ROOT,
    WORKSPACE_ROOT / "reports",
    WORKSPACE_ROOT / "logs",
    USERS_ROOT,
]

BLOCKED_PATTERNS = [
    ".env",
    "notes/Access/**",
    "node_modules/**",
    "__pycache__/**",
    ".git/**",
    "**/credentials*",
    "**/secrets*",
    "*.pyc",
    ".DS_Store",
]

# Model definitions (Claude + Gemini)
MODELS = [
    {
        "id": "gemini-flash",
        "label": "Flash",
        "provider": "gemini",
        "description": "Gemini 2.5 Flash — fast, free, great for search & Q&A",
        "color": "#4285f4",  # Google blue
    },
    {
        "id": "haiku",
        "label": "Haiku",
        "provider": "claude",
        "description": "Fast, cheap — quick questions, simple lookups",
        "color": "#10b981",  # Green
    },
    {
        "id": "sonnet",
        "label": "Sonnet",
        "provider": "claude",
        "description": "Balanced — default for most tasks",
        "color": "#a855f7",  # Purple
    },
    {
        "id": "opus",
        "label": "Opus",
        "provider": "claude",
        "description": "Max capability — complex code, architecture, deep analysis",
        "color": "#d946ef",  # Magenta
    },
]

DEFAULT_MODEL = "haiku"

# Simple mode uses Gemini Flash instead of Claude
SIMPLE_MODE_MODEL = "gemini-flash"

# OPAI context files
TEAM_JSON = OPAI_ROOT / "team.json"
QUEUE_JSON = OPAI_ROOT / "tasks" / "queue.json"
REGISTRY_JSON = OPAI_ROOT / "tasks" / "registry.json"

# Cache duration for OPAI context (seconds)
CONTEXT_CACHE_DURATION = 300  # 5 minutes
