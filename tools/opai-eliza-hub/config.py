"""Eliza Hub — Configuration."""
import os
from pathlib import Path

HOST = os.getenv("ELIZA_HUB_HOST", "127.0.0.1")
PORT = int(os.getenv("ELIZA_HUB_PORT", "8083"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# ElizaOS runtime
ELIZA_RUNTIME_URL = os.getenv("ELIZA_RUNTIME_URL", "http://127.0.0.1:8085")

# Team Hub internal API
TEAMHUB_URL = os.getenv("TEAMHUB_API_URL", "http://127.0.0.1:8089")
WORKERS_WORKSPACE_ID = os.getenv("WORKERS_WORKSPACE_ID", "d27944f3-8079-4e40-9e5d-c323d6cf7b0f")

# Brain API
BRAIN_URL = os.getenv("BRAIN_API_URL", "http://127.0.0.1:8101")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"

# Admin user (Dallas)
ADMIN_USER_ID = "1c93c5fe-d304-40f2-9169-765d0d2b7638"
