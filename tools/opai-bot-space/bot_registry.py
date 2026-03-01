"""OPAI Bot Space — Bot registry with seed definitions and setup guides."""

import config

# ── Seed Data ──────────────────────────────────────────────────────────────────
# Each entry maps to a row in bot_space_catalog.
# Call seed_catalog() to INSERT OR IGNORE into the DB.

CATALOG_SEED = [
    {
        "slug": "email-agent",
        "name": "Email Agent",
        "tagline": "Autonomous email monitoring, triage, drafting, and response",
        "description": (
            "The OPAI Email Agent connects to your IMAP inbox and continuously monitors for new messages. "
            "It classifies emails by intent, drafts replies using Claude, manages your whitelist, "
            "and keeps a full audit trail of every action taken. Admin-managed — runs as a shared system service."
        ),
        "icon": "📧",
        "category": "productivity",
        "tags": ["email", "inbox", "automation", "ai"],
        "unlock_credits": 0,
        "run_credits": 0,
        "cron_options": [
            {"value": "*/5 * * * *", "label": "Every 5 minutes"},
            {"value": "*/15 * * * *", "label": "Every 15 minutes"},
            {"value": "*/30 * * * *", "label": "Every 30 minutes"},
        ],
        "setup_schema": {},
        "dashboard_url": "/email-agent/",
        "features": [
            "IMAP inbox monitoring with configurable interval",
            "AI-powered email classification and intent detection",
            "Automated reply drafting with Claude",
            "Whitelist gate — ignore unknown senders",
            "Full audit trail with SSE live feed",
            "Kill-switch and manual mode override",
        ],
        "is_admin_only": True,
        "is_active": True,
        "author": "OPAI",
        "version": "1.0.0",
    },
    {
        "slug": "forum-bot",
        "name": "Forum Bot",
        "tagline": "AI content generation, scheduling, and moderation for the OPAI Forum",
        "description": (
            "Forum Bot autonomously generates posts, polls, and discussions for the OPAI Forum "
            "on a configurable schedule. Uses Claude to produce on-topic content, "
            "manages post scheduling, and keeps your community active. Admin-managed."
        ),
        "icon": "🤖",
        "category": "content",
        "tags": ["forum", "content", "scheduling", "ai"],
        "unlock_credits": 0,
        "run_credits": 0,
        "cron_options": [
            {"value": "0 * * * *", "label": "Hourly"},
            {"value": "0 */6 * * *", "label": "Every 6 hours"},
            {"value": "0 9 * * *", "label": "Daily at 9am"},
        ],
        "setup_schema": {},
        "dashboard_url": "/forumbot/",
        "features": [
            "AI-generated forum posts, polls, and discussions",
            "Configurable posting schedule per category",
            "Claude-powered content with topic awareness",
            "Post history and audit log",
            "Manual trigger and preview mode",
        ],
        "is_admin_only": True,
        "is_active": True,
        "author": "OPAI",
        "version": "1.0.0",
    },
    {
        "slug": "email-agent-user",
        "name": "Email Agent",
        "tagline": "Connect your own inbox — AI monitors, classifies, and drafts replies for you",
        "description": (
            "Your personal Email Agent connects to any IMAP inbox (Gmail, Outlook, custom domains) "
            "and works autonomously on your behalf. It classifies incoming mail by priority and intent, "
            "drafts contextual replies using Claude, and respects your whitelist rules. "
            "Runs on your chosen schedule, charging only for active ticks."
        ),
        "icon": "📬",
        "category": "productivity",
        "tags": ["email", "inbox", "automation", "ai", "personal"],
        "unlock_credits": 50,
        "run_credits": 5,
        "cron_options": [
            {"value": "*/30 * * * *", "label": "Every 30 minutes (10 credits/hr)"},
            {"value": "0 * * * *", "label": "Every hour (5 credits/hr)"},
            {"value": "0 */6 * * *", "label": "Every 6 hours"},
            {"value": "0 9 * * *", "label": "Daily at 9am"},
        ],
        "setup_schema": {
            "steps": [
                {
                    "title": "Email Account",
                    "guide": {
                        "title": "How to connect your Gmail account",
                        "steps": [
                            "Go to myaccount.google.com → Security → 2-Step Verification (must be ON).",
                            "Search for 'App Passwords' at the top → Select app: Mail → Select device: Other → name it 'OPAI Bot'.",
                            "Copy the 16-character password shown — paste it as your App Password below.",
                            "Use imap.gmail.com as IMAP Host, port 993, and your full email address as Username.",
                        ],
                        "external_url": "https://support.google.com/accounts/answer/185833",
                        "external_label": "Google App Passwords guide",
                    },
                    "fields": [
                        {
                            "name": "imap_host",
                            "label": "IMAP Server",
                            "type": "text",
                            "required": True,
                            "placeholder": "imap.gmail.com",
                        },
                        {
                            "name": "imap_port",
                            "label": "IMAP Port",
                            "type": "number",
                            "required": True,
                            "placeholder": "993",
                            "default": 993,
                        },
                        {
                            "name": "imap_user",
                            "label": "Email Address",
                            "type": "email",
                            "required": True,
                            "placeholder": "you@gmail.com",
                        },
                        {
                            "name": "imap_pass",
                            "label": "App Password",
                            "type": "password",
                            "required": True,
                            "placeholder": "xxxx xxxx xxxx xxxx",
                        },
                    ],
                },
                {
                    "title": "Schedule",
                    "fields": [
                        {
                            "name": "cron_preset",
                            "label": "Check Frequency",
                            "type": "select",
                            "required": True,
                            "options": [
                                {"value": "*/30 * * * *", "label": "Every 30 minutes (10 credits/hr)"},
                                {"value": "0 * * * *", "label": "Every hour (5 credits/hr)"},
                                {"value": "0 */6 * * *", "label": "Every 6 hours"},
                                {"value": "0 9 * * *", "label": "Daily at 9am"},
                            ],
                        }
                    ],
                },
            ]
        },
        "dashboard_url": "/bot-space/dashboard/email-agent-user/",
        "features": [
            "Connect any IMAP mailbox (Gmail, Outlook, custom)",
            "AI classification: priority, intent, sentiment",
            "Draft replies with Claude using your writing style",
            "Whitelist rules — skip unknown senders",
            "Runs on your schedule — pay only per active run",
            "Full action log accessible any time",
        ],
        "is_admin_only": False,
        "is_active": True,
        "author": "OPAI",
        "version": "1.0.0",
    },
]

# ── Test Handlers Registry ─────────────────────────────────────────────────────
# Maps agent slug → module function name in tester.py

TESTER_MAP = {
    "email-agent-user": "test_email_bot",
    "forum-bot": "test_forum_bot",
}


# ── Dispatch Handlers Registry ─────────────────────────────────────────────────
# Maps agent slug → (method, url_template)
# Admin bots dispatch to their own running service.
# User bots will dispatch to a shared agent runner (future).

DISPATCH_MAP = {
    "email-agent": ("POST", f"{config.EMAIL_AGENT_URL}/api/check-now"),
    "forum-bot": ("POST", f"{config.FORUM_BOT_URL}/api/run-now"),
}


# ── Seed Function ──────────────────────────────────────────────────────────────

async def seed_catalog(supabase_url: str, service_key: str):
    """Insert seed bots into bot_space_catalog if they don't exist yet."""
    import httpx
    import json

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=ignore-duplicates,return=minimal",
    }

    url = f"{supabase_url}/rest/v1/bot_space_catalog"

    async with httpx.AsyncClient(timeout=10) as client:
        for bot in CATALOG_SEED:
            payload = {**bot, "setup_schema": json.dumps(bot["setup_schema"])}
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code == 409:
                pass  # Already exists — expected on restart, skip silently
            elif resp.status_code not in (200, 201, 204):
                print(f"[BOT-SPACE] Seed warning for {bot['slug']}: {resp.status_code} {resp.text[:200]}")
            else:
                print(f"[BOT-SPACE] Seeded: {bot['slug']}")
