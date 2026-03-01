"""OpenClaw Vault Broker — Configuration."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Paths
OPAI_ROOT = Path("/workspace/synced/opai")
TOOLS_DIR = OPAI_ROOT / "tools"
BROKER_DIR = TOOLS_DIR / "open-claw" / "broker"
INSTANCES_DIR = TOOLS_DIR / "open-claw" / "instances"

# Vault connection (localhost only — broker talks to vault on the host)
VAULT_URL = os.getenv("VAULT_URL", "http://127.0.0.1:8105")

# Broker server
HOST = os.getenv("BROKER_HOST", "0.0.0.0")  # Docker containers reach via host.docker.internal
PORT = int(os.getenv("BROKER_PORT", "8106"))

# Supabase (for manifest CRUD and audit logging)
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Auth
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# Docker
DOCKER_NETWORK = os.getenv("OC_DOCKER_NETWORK", "opai-claw")
CONTAINER_PORT_RANGE = (9001, 9099)

# Safety limits
MAX_CREDENTIALS_PER_INSTANCE = int(os.getenv("OC_MAX_CREDS", "25"))
CREDENTIAL_INJECT_LOG = BROKER_DIR / "data" / "inject-audit.json"

# NAS Workspace
NAS_USERS_ROOT = Path(os.getenv("OC_NAS_USERS_ROOT", "/workspace/users"))
NAS_CLAWBOTS_DIR = NAS_USERS_ROOT / "_clawbots"
NAS_SHARED_DIR = NAS_USERS_ROOT / "_shared"

# LLM Proxy
LLM_MAX_CONCURRENT = int(os.getenv("OC_LLM_MAX_CONCURRENT", "3"))
CLAUDE_CLI_PATH = os.getenv("CLAUDE_CLI_PATH", "/home/dallas/.nvm/versions/node/v20.19.5/bin/claude")
LLM_REQUEST_TIMEOUT = int(os.getenv("OC_LLM_TIMEOUT", "120"))  # seconds
