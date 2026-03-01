"""OP WordPress — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_WORDPRESS_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_WORDPRESS_PORT", "8096"))

# OPAI Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Paths
TOOL_DIR = Path(__file__).parent
BASE_DIR = TOOL_DIR.parent.parent  # workspace root (/workspace/synced/opai)
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"
WP_AGENT_DIR = TOOL_DIR.parent / "wp-agent"

# Update checker interval (seconds)
UPDATE_CHECK_INTERVAL = 30 * 60  # 30 minutes

# Scheduler
SCHEDULER_INTERVAL = int(os.getenv("SCHEDULER_INTERVAL", "60"))  # seconds
HEALTH_CHECK_TIMEOUT = int(os.getenv("HEALTH_CHECK_TIMEOUT", "15"))  # seconds
BACKUP_RETENTION_DAYS = int(os.getenv("BACKUP_RETENTION_DAYS", "30"))

# Local backup storage (synced to NAS via Synology Drive)
BACKUP_STORAGE_DIR = Path(os.getenv("BACKUP_STORAGE_DIR", "/home/dallas/WautersEdge/WPBackups"))

# Connection retry agent
CONNECTION_AGENT_INTERVAL = 10 * 60  # 10 minutes
CONNECTION_AGENT_BATCH_SIZE = 5      # attempts before HITL report
