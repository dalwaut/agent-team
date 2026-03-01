"""OPAI Vault — Configuration."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Paths
OPAI_ROOT = Path("/workspace/synced/opai")
TOOLS_DIR = OPAI_ROOT / "tools"
VAULT_DIR = TOOLS_DIR / "opai-vault"
DATA_DIR = Path(os.getenv("VAULT_DATA_DIR", str(VAULT_DIR / "data")))

# Encrypted secrets store
SECRETS_FILE = DATA_DIR / "secrets.enc.yaml"

# Vault key (age private key)
VAULT_KEY_FILE = Path(os.getenv("VAULT_KEY_FILE", str(Path.home() / ".opai-vault" / "vault.key")))

# SOPS binary
SOPS_BIN = os.getenv("SOPS_BIN", str(Path.home() / "bin" / "sops"))
AGE_BIN = os.getenv("AGE_BIN", str(Path.home() / "bin" / "age"))

# Server
HOST = os.getenv("VAULT_HOST", "127.0.0.1")
PORT = int(os.getenv("VAULT_PORT", "8105"))

# Audit
AUDIT_LOG = Path(os.getenv("VAULT_AUDIT_LOG", str(DATA_DIR / "vault-audit.json")))
MAX_AUDIT_ENTRIES = 10000

# Auth
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

# Allowed callers: only internal services on localhost can request secrets
# AI sessions (Claude Code) should NEVER call the vault directly
ALLOWED_SERVICE_KEYS = set(filter(None, os.getenv("VAULT_ALLOWED_KEYS", "").split(",")))

# Age public key (for encrypting new secrets)
AGE_PUBLIC_KEY = os.getenv("AGE_PUBLIC_KEY", "age1rftaldecj33n259vahtvj5pw38naqjvsh93mmj5y2y7hfpp5gu9qzc09tw")

# ── Web UI Auth ──────────────────────────────────────────
STATIC_DIR = VAULT_DIR / "static"
AUTH_FILE = DATA_DIR / "auth.json"
SESSION_TTL = 1800  # 30 minutes (seconds)
PIN_MAX_ATTEMPTS = 5
PIN_LOCKOUT_SECONDS = 60
VAULT_RP_ID = os.getenv("VAULT_RP_ID", "opai-server")
VAULT_RP_NAME = "OPAI Vault"
