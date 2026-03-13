"""OPAI Users — Configuration."""

import os
from pathlib import Path

OPAI_ROOT = Path("/workspace/synced/opai")

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Network lockdown PIN
LOCKDOWN_PIN = os.getenv("LOCKDOWN_PIN", "")
