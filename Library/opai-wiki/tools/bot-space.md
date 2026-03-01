# Bot Space
> Last updated: 2026-02-21 | Port: 8099 | Route: `/bot-space/` | Service: `opai-bot-space` | Stack: Python FastAPI

## Overview

Bot Space is the unified agent catalog for OPAI. Admins can see and manage their built-in system bots (Email Agent, Forum Bot). Users can discover, unlock, configure, and schedule user-facing AI bots via a credit system. Every bot runs on a user-chosen cron schedule dispatched by a built-in background scheduler.

**Design goal**: Make bots discoverable and monetizable while keeping admin bots zero-cost and always available.

---

## Architecture

```
tools/opai-bot-space/
├── app.py              FastAPI bootstrap + lifespan (seeds catalog, starts scheduler)
├── config.py           Port 8099, env paths, service URLs
├── routes_api.py       All REST endpoints (catalog, installs, credits, runs, admin)
├── bot_registry.py     Seed definitions for built-in bots + dispatch map
├── scheduler.py        Background cron dispatcher (60s tick, asyncio)
├── tester.py           Per-bot live connectivity test handlers
├── .env                Supabase creds (same keys as other tools)
└── static/
    ├── index.html      SPA shell
    ├── js/app.js       All UI logic (vanilla JS)
    └── css/style.css   Dark theme matching OPAI portal
```

---

## Database Tables

All tables in Supabase, applied via `config/supabase-migrations/023_bot_space.sql`.

| Table | Purpose |
|-------|---------|
| `bot_space_catalog` | Bot definitions — slug, pricing, setup_schema, cron_options |
| `bot_space_installations` | User-activated bots — status, cron, config, next_run_at |
| `bot_space_runs` | Execution log — status, credits_charged, result_summary |
| `bot_space_credit_transactions` | Full credit audit ledger |

`profiles.agent_credits INT DEFAULT 0` — added by migration, tracks each user's credit balance.

### Key columns

**`bot_space_catalog.setup_schema`** (JSONB): Multi-step wizard field definitions. Each step can include a `guide` object with numbered instructions and an external URL. See `bot_registry.py` for the email bot example.

**`bot_space_installations.config`** (JSONB): User's saved credentials and settings (encrypted at rest by Supabase). Never exposed in API responses for security — only used internally by the scheduler.

---

## Credit System

| Action | Credit Change |
|--------|--------------|
| Admin grants credits | +N (via `POST /api/admin/credits/grant`) |
| User unlocks a bot | -`unlock_credits` (one-time, on unlock) |
| Scheduler runs a bot | -`run_credits` (per tick, if balance sufficient) |
| Skipped run (low credits) | 0 (next_run_at not advanced — retry next tick) |

Admin bots (`email-agent`, `forum-bot`) have `unlock_credits=0` and `run_credits=0` — they never charge.

Future: Stripe checkout stub exists at `POST /api/credits/purchase` — returns 501 until implemented.

---

## Scheduler

File: `scheduler.py`. Runs as an asyncio task started in `app.py` lifespan.

**Tick interval**: 60 seconds (configurable via `BOT_SPACE_SCHEDULER_TICK` env var).

**Per tick**:
1. Query `bot_space_installations WHERE status='active' AND next_run_at <= now()`
2. For each due installation:
   - Fetch catalog entry (run_credits)
   - Fetch user's agent_credits
   - If insufficient credits: log `skipped_credits` run, do NOT advance next_run_at
   - If sufficient: insert `running` run, compute next_run_at via croniter, dispatch bot, deduct credits, update run to `completed|failed`

**Dispatch map** (in `bot_registry.py`):

| Slug | Dispatch |
|------|---------|
| `email-agent` | `POST http://127.0.0.1:8093/api/check-now` |
| `forum-bot` | `POST http://127.0.0.1:8095/api/run-now` |

---

## Test Connection

Setup wizard includes a "Test Connection" button after credential fields are entered.

- Calls `POST /api/bots/{slug}/test` with the (unsaved) config from the form
- 15-second timeout, runs in-process via `tester.py`
- Returns `{success, message, preview?}`
- Never saves credentials or charges credits
- Error messages include specific guidance (e.g., "IMAP auth failed — check App Password")

**Test handlers** (`tester.py`):

| Slug | Test |
|------|------|
| `email-agent-user` | IMAP SSL connect → login → search UNSEEN → fetch 1 header → return preview |
| `forum-bot` | GET Supabase `forum_posts?limit=1` → confirm reachable |

---

## Built-in Bots

| Slug | Name | Admin Only | Unlock | Run | Dashboard |
|------|------|-----------|--------|-----|-----------|
| `email-agent` | Email Agent | Yes | 0 | 0 | `/email-agent/` |
| `forum-bot` | Forum Bot | Yes | 0 | 0 | `/forumbot/` |
| `email-agent-user` | Email Agent | No | 50 | 5 | `/bot-space/dashboard/email-agent-user/` |

New bots are added by inserting into `bot_space_catalog` (via admin API or migration), and optionally registering a test handler in `tester.py` and a dispatch entry in `bot_registry.DISPATCH_MAP`.

---

## API Reference

### Public
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/health` | None | Health check |
| GET | `/api/auth/config` | None | Supabase config for frontend |

### Catalog
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/bots` | User | List catalog + user install status |
| GET | `/api/bots/{slug}` | User | Bot detail |
| POST | `/api/bots/{slug}/unlock` | User | Deduct unlock credits, create pending_setup install |
| POST | `/api/bots/{slug}/test` | User | Live connectivity test (dry run, 15s timeout) |

### Installations
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/installations` | User | User's installed bots |
| POST | `/api/installations` | User | Complete wizard → activate installation |
| GET | `/api/installations/{id}` | User | Installation detail |
| PATCH | `/api/installations/{id}` | User | Update config/schedule |
| POST | `/api/installations/{id}/pause` | User | Pause cron |
| POST | `/api/installations/{id}/resume` | User | Resume cron |
| DELETE | `/api/installations/{id}` | User | Remove |

### Credits
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/credits` | User | Balance + recent transactions |
| POST | `/api/credits/purchase` | User | Stub (Stripe pending) |
| POST | `/api/admin/credits/grant` | Admin | Grant credits to a user |

### Runs
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/runs` | User | User's run history (last 50) |

### Admin
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/admin/bots` | Admin | Full catalog management |
| POST | `/api/admin/bots` | Admin | Add bot to catalog |
| PATCH | `/api/admin/bots/{slug}` | Admin | Edit bot entry |
| GET | `/api/admin/installations` | Admin | All users' installations |
| GET | `/api/admin/runs` | Admin | All runs |
| GET | `/api/scheduler/settings` | Admin | Runtime scheduler state `{tick_seconds, paused}` |
| PUT | `/api/scheduler/settings` | Admin | Update tick interval / pause (body: `{tick_seconds?, paused?}`) |

---

## UI Layout

### Header
- Left: "⚡ Bot Space" title
- Right: credit chip (`⚡ N credits`, opens credit modal) + "Run Log" button

### My Agents (top section)
- Shown only if user has at least one installation
- Color-coded by status: green=active, yellow=paused, red=error, blue=pending setup
- Per row: icon, name, status badge, next run time, cron expr
- Row actions: Dashboard link, Configure (re-opens wizard), Pause/Resume

### Browse Agents (card grid)
- Category filter chips (All, Productivity, Content, Communication)
- Search bar
- Card states: locked (default), unlocked/not-configured (blue border), active (green border)
- CTA: "Get Agent" | "Set Up" | "Manage"

### Agent Detail Popup (modal)
- Full description, feature bullets, pricing box
- State-driven CTA button

### Setup Wizard (multi-step modal)
1. Schema steps (credential fields + setup guide accordion)
2. Schedule step (cron preset dropdown)
3. Review & Activate (summary card)

After each credential step: "🔌 Test Connection" button → live test with result preview.

---

## Deployment

### Apply migration
```bash
./scripts/supabase-sql.sh < config/supabase-migrations/023_bot_space.sql
```

### Install service
```bash
cp config/service-templates/opai-bot-space.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start opai-bot-space
systemctl --user enable opai-bot-space
```

### Reload Caddy
```bash
./scripts/opai-control.sh restart-one opai-caddy
```

### Health check
```bash
curl http://127.0.0.1:8099/health
# → {"status":"ok","service":"opai-bot-space","version":"1.0.0",...}
```

### Python dependencies
```bash
pip install fastapi uvicorn httpx python-dotenv python-jose croniter
```

---

## Marketplace Integration (Future)

`bot_space_catalog` schema mirrors `marketplace_products` so bots can be listed as `product_type = 'bot'` in BoutaByte marketplace. Bot cards in marketplace: "Get" → Bot Space setup wizard; "Open" (if installed) → `dashboard_url`.

Planned additions:
- `tier_requirement` column (pro/unlimited tier gating)
- Unlimited plan: flat subscription bypasses per-run credit deduction
- Third-party bot submissions with sandboxed dispatch

**Do not implement now** — architecture is forward-compatible.

---

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Catalog empty on load | Migration not applied or seed failed | Check logs, re-run `seed_catalog()` via `/health` restart |
| Test connection timeout | IMAP server unreachable | Check firewall, IMAP port 993 |
| Scheduler not firing | `croniter` not installed | `pip install croniter` |
| Credits not deducting | `agent_credits` column missing | Apply migration 023 |
| Bot shows for non-admin | `is_admin_only` not set | Check catalog row |
