"""OPAI Messenger - Configuration and constants."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Server configuration
HOST = os.getenv("OPAI_MESSENGER_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_MESSENGER_PORT", "8083"))

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"

# File upload limits
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
ALLOWED_FILE_TYPES = {
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "application/pdf", "text/plain", "text/csv",
    "application/zip", "application/json",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
STORAGE_BUCKET = "messenger-files"

# Pagination
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100
