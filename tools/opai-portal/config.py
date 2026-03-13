"""OPAI Portal — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_PORTAL_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_PORTAL_PORT", "8090"))

# Supabase (needed for auth.js config injection)
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

# Auth bypass for local access (auto-detected from localhost, or force via env)
AUTH_DISABLED = os.getenv("OPAI_AUTH_DISABLED", "").strip() in ("1", "true", "yes")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
WORKSPACE_ROOT = Path(os.getenv("OPAI_WORKSPACE", "/workspace/synced/opai"))

# Infrastructure — deploy targets
PUBLIC_SITE_DIR = WORKSPACE_ROOT / os.getenv("OPAI_PUBLIC_SITE_DIR", "tools/opai-billing/public-site")
OPAI_SERVER_TAILSCALE = os.getenv("OPAI_SERVER_TAILSCALE", "100.72.206.23")
PUBLIC_DOMAIN = os.getenv("OPAI_PUBLIC_DOMAIN", "opai.boutabyte.com")
BB_VPS_HOST = os.getenv("OPAI_BB_VPS_HOST", "root@bb-vps")
SSH_KEY_PATH = Path(os.getenv("OPAI_SSH_KEY", str(Path.home() / ".ssh" / "bb_vps")))
NVM_BIN = os.getenv("OPAI_NVM_BIN", "/home/dallas/.nvm/versions/node/v20.19.5/bin")
