"""OPAI Docs — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_DOCS_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_DOCS_PORT", "8091"))

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"
DOCS_JSON = DATA_DIR / "docs.json"
DOCS_META_JSON = DATA_DIR / "docs-meta.json"

# Wiki source
OPAI_ROOT = Path("/workspace/synced/opai")
WIKI_DIR = OPAI_ROOT / "Library" / "opai-wiki"
TEAM_JSON = OPAI_ROOT / "team.json"
CADDYFILE = OPAI_ROOT / "config" / "Caddyfile"

# Background watcher
WATCHER_INTERVAL = int(os.getenv("WATCHER_INTERVAL", "300"))  # 5 minutes
