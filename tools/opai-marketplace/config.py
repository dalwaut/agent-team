"""OPAI Marketplace — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_MARKETPLACE_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_MARKETPLACE_PORT", "8092"))

# OPAI Supabase (main database)
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# BoutaByte Supabase (source catalog)
BB_SUPABASE_URL = os.getenv("BB_SUPABASE_URL", "")
BB_SUPABASE_SERVICE_KEY = os.getenv("BB_SUPABASE_SERVICE_KEY", "")
BB_PLATFORM_URL = os.getenv("BB_PLATFORM_URL", "https://boutabyte.com")

# n8n VPS (SSH to Hostinger — SQLite database inside Docker volume)
N8N_SSH_HOST = os.getenv("N8N_SSH_HOST", "")
N8N_SSH_USER = os.getenv("N8N_SSH_USER", "root")
N8N_SSH_PASSWORD = os.getenv("N8N_SSH_PASSWORD", "")
N8N_SQLITE_PATH = os.getenv(
    "N8N_SQLITE_PATH",
    "/var/lib/docker/volumes/c0g0wk48okcos04c0k4cokkw_n8n-data/_data/database.sqlite",
)

# Webhook secret for event-driven sync from BB2.0
SYNC_WEBHOOK_SECRET = os.getenv("SYNC_WEBHOOK_SECRET", "")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"

# Tier hierarchy (for filtering)
TIER_ORDER = {"free": 0, "starter": 1, "pro": 2, "unlimited": 3}
