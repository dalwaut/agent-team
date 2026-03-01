"""Bx4 — BoutaByte Business Bot — Configuration."""
import os
from pathlib import Path

HOST = os.getenv("OPAI_BX4_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_BX4_PORT", "8100"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.getenv("BX4_CLAUDE_MODEL", "claude-sonnet-4-6")

# Internal Stripe key (shared with opai-billing — auto-connects for admins)
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")

# Google Analytics service account JSON path (optional)
GA_SERVICE_ACCOUNT_JSON = os.getenv("BX4_GA_SERVICE_ACCOUNT_JSON", "")

TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"

# Internal service URLs
TEAM_HUB_URL = os.getenv("TEAM_HUB_URL", "http://127.0.0.1:8089")
DISCORD_BRIDGE_URL = os.getenv("DISCORD_BRIDGE_URL", "http://127.0.0.1:8083")
EMAIL_AGENT_URL = os.getenv("EMAIL_AGENT_URL", "http://127.0.0.1:8085")

# Analysis scheduler ticks (seconds)
SCHEDULER_TICK = int(os.getenv("BX4_SCHEDULER_TICK", "300"))

# Credit costs per action (billing inactive but tracked)
CREDIT_COSTS = {
    "full_analysis": 10,
    "wing_analysis": 3,
    "weekly_briefing": 8,
    "advisor_chat": 1,
    "briefing_export": 2,
    "anomaly_scan": 2,
}
