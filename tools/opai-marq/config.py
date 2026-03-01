"""Marq — App Store Publisher Agent — Configuration."""
import os
from pathlib import Path

HOST = os.getenv("OPAI_MARQ_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_MARQ_PORT", "8103"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# Fernet key for credential encryption
VAULT_KEY = os.getenv("MARQ_VAULT_KEY", "")

TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"
VAULT_DIR = DATA_DIR / "vault"

# Scheduler tick in seconds
SCHEDULER_TICK = int(os.getenv("MARQ_SCHEDULER_TICK", "60"))

# Internal service URLs
TEAMHUB_URL = os.getenv("TEAMHUB_URL", "http://127.0.0.1:8089")
TASKS_URL = os.getenv("TASKS_URL", "http://127.0.0.1:8081")

# Admin user ID — used as fallback author for automated TeamHub comments
ADMIN_USER_ID = os.getenv("ADMIN_USER_ID", "1c93c5fe-d304-40f2-9169-765d0d2b7638")

VERSION = "1.0.0"
