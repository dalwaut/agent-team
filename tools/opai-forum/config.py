"""OPAI Forum — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_FORUM_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_FORUM_PORT", "8087"))

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"

# Upload settings
MAX_UPLOAD_SIZE = 5 * 1024 * 1024  # 5MB
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

# Pagination
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 50
