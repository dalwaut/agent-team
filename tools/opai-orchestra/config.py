"""OPAI Orchestra — Configuration."""

import os
from pathlib import Path

HOST = os.getenv("OPAI_ORCHESTRA_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_ORCHESTRA_PORT", "8098"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
