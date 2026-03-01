"""HELM — Autonomous Business Runner — Configuration."""
import os
from pathlib import Path

HOST = os.getenv("OPAI_HELM_HOST", "127.0.0.1")
PORT = int(os.getenv("OPAI_HELM_PORT", "8102"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.getenv("HELM_CLAUDE_MODEL", "claude-sonnet-4-6")

# Fernet key for credential encryption (generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
VAULT_KEY = os.getenv("HELM_VAULT_KEY", "")

TOOL_DIR = Path(__file__).parent
STATIC_DIR = TOOL_DIR / "static"
DATA_DIR = TOOL_DIR / "data"
VAULT_DIR = DATA_DIR / "vault"

# Scheduler tick in seconds
SCHEDULER_TICK = int(os.getenv("HELM_SCHEDULER_TICK", "60"))

# Internal service URLs
DISCORD_BRIDGE_URL = os.getenv("DISCORD_BRIDGE_URL", "http://127.0.0.1:8083")
TASKS_URL = os.getenv("TASKS_URL", "http://127.0.0.1:8081")
OP_WORDPRESS_URL = os.getenv("OP_WORDPRESS_URL", "http://127.0.0.1:8095")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")

# Public URL (used for Stripe redirect URLs)
HELM_PUBLIC_URL = os.getenv("HELM_PUBLIC_URL", "https://opai.boutabyte.com")

# Hostinger Agency API — domain availability + hosting provisioning
HOSTINGER_API_KEY = os.getenv("HOSTINGER_API_KEY", "")

# GoDaddy Domain API (kept for future use / MCP)
GODADDY_API_KEY = os.getenv("GODADDY_API_KEY", "")
GODADDY_API_SECRET = os.getenv("GODADDY_API_SECRET", "")

# Netlify Admin PAT (kept for future use)
NETLIFY_ADMIN_PAT = os.getenv("NETLIFY_ADMIN_PAT", "")

# Stripe — shared BoutaByte account (same STRIPE_SECRET_KEY as opai-billing)
# Set STRIPE_TEST_MODE=true to use sandbox keys + test price IDs for end-to-end testing.
STRIPE_TEST_MODE = os.getenv("STRIPE_TEST_MODE", "false").lower() in ("1", "true", "yes")
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")          # live
STRIPE_TEST_SECRET_KEY = os.getenv("STRIPE_TEST_SECRET_KEY", "") # sandbox
STRIPE_HELM_WEBHOOK_SECRET = os.getenv("STRIPE_HELM_WEBHOOK_SECRET", "")       # live webhook
STRIPE_TEST_WEBHOOK_SECRET = os.getenv("STRIPE_TEST_WEBHOOK_SECRET", "")       # test webhook (Stripe CLI)

def stripe_key() -> str:
    return STRIPE_TEST_SECRET_KEY if STRIPE_TEST_MODE else STRIPE_SECRET_KEY

def stripe_webhook_secret() -> str:
    return STRIPE_TEST_WEBHOOK_SECRET if STRIPE_TEST_MODE else STRIPE_HELM_WEBHOOK_SECRET

# Stripe price IDs — live
STRIPE_PRICE_HOSTING_STARTER = os.getenv("STRIPE_PRICE_HOSTING_STARTER", "")
STRIPE_PRICE_HOSTING_PRO = os.getenv("STRIPE_PRICE_HOSTING_PRO", "")
STRIPE_PRICE_HOSTING_BUSINESS = os.getenv("STRIPE_PRICE_HOSTING_BUSINESS", "")
STRIPE_PRICE_DOMAIN_STANDARD = os.getenv("STRIPE_PRICE_DOMAIN_STANDARD", "")
STRIPE_PRICE_DOMAIN_BUNDLE = os.getenv("STRIPE_PRICE_DOMAIN_BUNDLE", "")
STRIPE_PRICE_WP_PRO_ADDON = os.getenv("STRIPE_PRICE_WP_PRO_ADDON", "")

# Stripe price IDs — test/sandbox
STRIPE_TEST_PRICE_HOSTING_STARTER = os.getenv("STRIPE_TEST_PRICE_HOSTING_STARTER", "")
STRIPE_TEST_PRICE_HOSTING_PRO = os.getenv("STRIPE_TEST_PRICE_HOSTING_PRO", "")
STRIPE_TEST_PRICE_HOSTING_BUSINESS = os.getenv("STRIPE_TEST_PRICE_HOSTING_BUSINESS", "")
STRIPE_TEST_PRICE_DOMAIN_STANDARD = os.getenv("STRIPE_TEST_PRICE_DOMAIN_STANDARD", "")
STRIPE_TEST_PRICE_DOMAIN_BUNDLE = os.getenv("STRIPE_TEST_PRICE_DOMAIN_BUNDLE", "")
STRIPE_TEST_PRICE_WP_PRO_ADDON = os.getenv("STRIPE_TEST_PRICE_WP_PRO_ADDON", "")

VERSION = "1.0.0"
