"""OPAI Studio — Configuration."""
import os
from pathlib import Path

HOST = os.getenv("OPAI_STUDIO_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_STUDIO_PORT", "8108"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"

MAX_UPLOAD_SIZE = 20 * 1024 * 1024  # 20MB
