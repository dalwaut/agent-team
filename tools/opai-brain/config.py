"""2nd Brain — Configuration."""
import os
from pathlib import Path

HOST = os.getenv("OPAI_BRAIN_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_BRAIN_PORT", "8101"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

CLAUDE_MODEL = os.getenv("BRAIN_CLAUDE_MODEL", "claude-sonnet-4-6")

TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"

# Scheduler tick interval (seconds)
SCHEDULER_TICK = int(os.getenv("BRAIN_SCHEDULER_TICK", "60"))

# Library Sync — admin user who owns synced nodes
ADMIN_USER_ID = "1c93c5fe-d304-40f2-9169-765d0d2b7638"

# Workspace root (parent of tools/)
WORKSPACE_ROOT = Path(__file__).parent.parent.parent

# Source directories for library sync {relative_path: [tags]}
LIBRARY_SYNC_SOURCES = {
    "Library/helm-playbooks": ["helm", "playbook"],
    "Research": ["research"],
    "notes/plans": ["plan"],
    "notes/ideas": ["idea"],
    "notes/personal": ["personal"],
}
