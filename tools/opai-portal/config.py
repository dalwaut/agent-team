"""OPAI Portal — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_PORTAL_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_PORTAL_PORT", "8090"))

# Supabase (needed for auth.js config injection)
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
