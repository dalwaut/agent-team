"""OPAI Files — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_FILES_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_FILES_PORT", "8086"))

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"

# File manager settings
MAX_EDIT_SIZE = 1 * 1024 * 1024  # 1MB — files larger than this are download-only
MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50MB per file
BINARY_CHECK_BYTES = 8192  # Check first 8KB for null bytes

# Admin workspace override — admins get this as their root instead of sandbox
ADMIN_WORKSPACE_ROOT = Path("/workspace/synced/opai")

# Protected files — viewable but not editable/deletable by non-admins
PROTECTED_FILES = {".opai-user.json", "CLAUDE.md", "config/sandbox.json"}

# Claude CLI path (installed via nvm)
CLAUDE_CLI = os.getenv("CLAUDE_CLI", str(Path.home() / ".nvm/versions/node/v20.19.5/bin/claude"))

# AI instruction limits
AI_TIMEOUT = 120  # seconds

# Link index settings
LINK_INDEX_MAX_FILES = 5000  # Max files to index
CONTENT_SEARCH_MAX_RESULTS = 100  # Max content search results
