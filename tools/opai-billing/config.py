"""OPAI Billing — Configuration."""

import os
from pathlib import Path

# Server
HOST = os.getenv("OPAI_BILLING_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_BILLING_PORT", "8094"))

# BB2.0 Supabase (billing data — stripe tables live here)
SUPABASE_URL = os.getenv("BB_SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("BB_SUPABASE_SERVICE_KEY", "")

# OPAI Supabase (operational data)
OPAI_SUPABASE_URL = os.getenv("OPAI_SUPABASE_URL", "")
OPAI_SUPABASE_SERVICE_KEY = os.getenv("OPAI_SUPABASE_SERVICE_KEY", "")

# Stripe
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PUBLISHABLE_KEY = os.getenv("STRIPE_PUBLISHABLE_KEY", "")

# Public site URL (for Stripe checkout redirects)
PUBLIC_SITE_URL = os.getenv("PUBLIC_SITE_URL", "https://opai.boutabyte.com")

# Paths
TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"
