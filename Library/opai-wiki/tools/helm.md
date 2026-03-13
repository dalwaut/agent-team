# HELM — Handsfree Enterprise Launch Machine

> **H**andsfree **E**nterprise **L**aunch **M**achine
> Your AI takes the helm and runs the business — content, social, revenue, operations — so you focus on what matters.

**Port:** `8102` | **Path:** `/helm/` | **Service:** `opai-helm` | **Migration:** `030_helm.sql`
**Hostinger:** Agency plan — all hosting is free, treated with full paid-account urgency.

---

## Overview

HELM accepts any business idea, plan, or document and fully operates that business autonomously: website management, content creation, social media, payments, outreach, SEO, lead capture, security, and reporting. It manages a portfolio of businesses simultaneously, each with its own identity, credentials, and operating parameters.

**Core concept:** HELM acts independently on nearly all tasks and escalates to the human owner (CEO-gate) only for: financial decisions, unresolvable errors, and conflicts. Default autonomy: 8/10.

**Account type rule (applies to all sites HELM builds):**
Every site has two distinct account types:
- **Bot/Agent accounts** — AI-operated, content attributed to AI (transparent)
- **User accounts** — human-operated, normal member content

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│  Business Brief (PDF/DOCX/form/URL)                             │
│         ↓ AI parse + human confirmation                         │
│  Business Profile (name, industry, goals, voice, audience)      │
│         ↓ bootstrap                                             │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────────────┐  │
│  │   Website    │ │ Social Media │ │   Stripe / Revenue    │  │
│  │ WordPress or │ │ 7 platforms  │ │ Products + Prices     │  │
│  │ Static Site  │ │ OAuth-linked │ │ Bot + User accounts   │  │
│  │ (Hostinger)  │ │              │ │                       │  │
│  └──────────────┘ └──────────────┘ └───────────────────────┘  │
│         ↓ autonomous operations within HITL rails               │
│  Content → Social → Email → Leads → Reports → Knowledge update  │
└─────────────────────────────────────────────────────────────────┘
```

**Stack:** FastAPI + Supabase + vanilla JS
**Scheduler:** asyncio internal loop (60s tick) — NOT systemd timers
**Secrets:** Fernet-encrypted file vault per business (`vault/{business_id}/service.json.enc`)
**AI:** Claude via `core/ai.py` — layered system prompt built from business personality + knowledge base

---

## File Structure

```
tools/opai-helm/
├── app.py                      # FastAPI, lifespan, router registration
├── config.py                   # All env vars, paths, constants
├── requirements.txt
├── .env                        # gitignored — keys, Stripe IDs, Hostinger key
│
├── routes/
│   ├── health.py               # GET /health + /api/health (both — monitor compat)
│   ├── businesses.py           # Business CRUD + dashboard KPIs
│   ├── onboarding.py           # 8-step onboarding wizard
│   ├── content.py              # Content generation + WP publish
│   ├── social.py               # Social accounts + post management
│   ├── website_builder.py      # Website Builder sub-wizard (Step 4)
│   ├── webhooks.py             # Stripe + social platform webhooks
│   ├── credentials.py          # Vault management
│   ├── schedule.py             # Per-job automation schedule config
│   ├── actions.py              # Audit log + HITL queue
│   └── health.py
│
├── core/
│   ├── ai.py                   # Claude wrapper: prompt builder, cost tracker, logging
│   ├── knowledge.py            # Knowledge base retrieval (semantic or full)
│   ├── scheduler.py            # Asyncio scheduler loop + job dispatch
│   ├── vault.py                # Fernet encrypt/decrypt credentials
│   ├── hitl.py                 # HITL queue helpers + auto-approve logic
│   ├── realtime.py             # Supabase Realtime broadcast helper
│   └── supabase.py             # Shared httpx DB helpers (_sb_get, _sb_post, _sb_patch)
│
├── connectors/
│   ├── hostinger.py            # Hostinger API — domain availability + catalog pricing
│   ├── godaddy.py              # GoDaddy REST API + RDAP fallback (domain availability)
│   ├── netlify_admin.py        # Netlify Admin PAT — create_site, deploy_template
│   ├── wordpress.py            # WP REST API v2 + Application Passwords
│   └── (social connectors TBD)
│
├── jobs/
│   ├── content_generate.py
│   ├── hitl_expiry.py
│   ├── report_weekly.py
│   ├── site_health_check.py
│   ├── social_stats_sync.py
│   └── stripe_sync.py
│
├── vault/                      # gitignored — encrypted credential store per business
└── static/
    ├── index.html              # Full-height SPA (must be in FULL_HEIGHT_TOOLS)
    ├── style.css
    └── js/
        ├── app.js              # Auth, routing, global state (HELM object), Stripe return handler
        ├── onboarding.js       # 8-step wizard, step rendering, state persistence
        ├── website-builder.js  # "I need a website" sub-wizard (Step 4)
        ├── dashboard.js        # Business dashboard + health score
        └── ...
```

---

## Database Tables (`030_helm.sql`)

All tables use the `helm_` prefix.

| Table | Purpose |
|-------|---------|
| `helm_businesses` | Core business profile: identity, personality, tone, goals, autonomy level |
| `helm_business_access` | Multi-user ACL per business (owner/editor/viewer) |
| `helm_business_onboarding` | Onboarding state — current step, parsed_data, completion status |
| `helm_business_configs` | Flexible KV store per business (content cadence, flags, etc.) |
| `helm_business_goals` | Trackable goals with metric type, target, current value, deadline |
| `helm_business_knowledge` | Versioned AI knowledge base |
| `helm_business_websites` | Site registry: platform, domain, hosting, WP REST URL |
| `helm_business_content` | Blog posts, pages, emails — full lifecycle |
| `helm_business_social_accounts` | Platform accounts with OAuth token refs (vault) |
| `helm_business_social_posts` | Scheduled/published posts with metrics JSONB |
| `helm_business_stripe_config` | Stripe account config + cached MRR/ARR/customer count |
| `helm_business_actions` | Immutable audit log of every AI and user action |
| `helm_business_reports` | Periodic AI-generated reports |
| `helm_business_leads` | Basic CRM: status, score, AI summary, next followup |
| `helm_business_hitl_queue` | Mutable work queue for human approval decisions |
| `helm_business_schedule` | Per-job automation schedule with cron_expr + next_run_at |
| `helm_business_credential_refs` | Vault key registry (tracks what secrets exist, not their values) |
| `helm_website_builds` | Website Builder purchases — domain, platform, Stripe session, provision status |

**RLS:** Uses `helm_has_access(business_id)` helper function (SECURITY DEFINER). Admins bypass all policies.

### `helm_website_builds` table (`031_helm_website_builds.sql`)

```sql
helm_website_builds (
  id uuid PRIMARY KEY,
  business_id uuid REFERENCES helm_businesses(id) ON DELETE CASCADE,
  domain text,                   -- e.g. "boutacare"
  tld text,                      -- e.g. "com"
  platform text,                 -- "wordpress" | "static"
  provider text,                 -- "hostinger" (primary)
  hosting_plan text,             -- "starter" | "pro" | "business"
  stripe_session_id text,
  stripe_payment_status text,    -- "pending" | "paid"
  provision_status text,         -- "pending" | "provisioning" | "live" | "failed"
  provision_data jsonb,          -- URLs, site IDs, HITL task IDs
  export_only boolean,           -- true if user downloaded guide instead of paying
  wp_pro_addon boolean,          -- WP Pro Updates & Backup add-on purchased
  created_at timestamptz,
  updated_at timestamptz
)
```

---

## Onboarding Flow (8 Steps)

Resumable wizard (state persisted in `helm_business_onboarding`):

1. **Document Upload** — PDF/DOCX/MD/text paste OR structured form
2. **AI Parse** — SSE stream, extracts profile fields with confidence scores + source citations
3. **Business Profile** — identity, brand colors, audience, autonomy slider
4. **Website Setup** — Connect existing OR build new (see Website Builder below)
5. **Social Accounts** — OAuth popup flow per platform
6. **Stripe Setup** — connect existing account or create new; import existing products
7. **AI Content Generation** — SSE: generates initial content calendar + brand guidelines
8. **Review & Launch** — shows week 1 plan, HITL constraints, safety controls, launch confirmation

---

## Website Builder — "I Need a Website" Flow

Step 4 of onboarding includes a fourth card: **"✨ I need a website — build one for me"**. This guides through domain search, platform selection, Stripe checkout, and HITL provisioning.

### User Flow

```
Step 4: Website Setup
└── [✨ I need a website]
    ├── Sub A: Domain Search
    │   ↳ Type domain name → Hostinger availability check (debounced 600ms)
    │   ↳ Shows available/taken + real price from Hostinger catalog
    │   ↳ Auto-suggests from business name across 4 TLDs
    │   ↳ TLD picker: .com / .net / .co / .io
    │
    ├── Sub B: Platform + Hosting
    │   ↳ HELM recommends based on business industry/stage
    │   ↳ [WordPress] or [Static / Landing Page]  — both on Hostinger
    │   ↳ Hosting plan tiers: Starter $10/mo / Pro $15/mo / Business $25/mo
    │   ↳ Bundle badge: "Add domain for $1.00" when hosting selected
    │
    ├── Sub C: Order Summary + Pay
    │   ↳ Line items: domain (bundle $1.00), hosting plan/mo
    │   ↳ WordPress only: checkbox "WP Pro Updates & Backup +$15/mo"
    │   ↳ [Pay with Card →] → Stripe checkout
    │   ↳ [Export Setup Guide] → download .md, skip payment
    │
    └── Sub D: Confirmation
        ↳ HITL task queued in opai-tasks → "Site being provisioned..."
        ↳ URL stored in helm_website_builds.provision_data
        ↳ Advances to Step 5 (Social Accounts)
```

### API Endpoints (mounted at `/api/website-builder/`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/domain/check` | Hostinger availability for `?name=X&tld=.com` |
| GET | `/domain/suggest` | Auto-suggest across 4 TLDs from `?business_name=X` |
| GET | `/recommend` | Platform recommendation from business profile industry |
| GET | `/plans` | Hosting plans + live prices from Hostinger catalog |
| POST | `/checkout` | Create Stripe checkout session (returns `checkout_url`) |
| POST | `/webhook/complete` | Post-payment provisioning — Stripe sends this OR client calls after redirect |
| GET | `/session-status` | Check Stripe session payment status by `?session_id=` |
| GET | `/export` | Generate + download Markdown setup guide |

### Recommendation Logic

| Industry signal | Platform | Plan |
|-----------------|----------|------|
| e-commerce / retail / shop | WordPress | Pro |
| saas / software / tech / portfolio | Static | Starter |
| service / consulting / default | WordPress | Starter |

### Domain Provider: Hostinger

Primary domain availability source. Falls back to ICANN RDAP if Hostinger API errors.

**Connector:** `connectors/hostinger.py`
- `check_availability(name, tlds)` — `POST /api/domains/v1/availability` → `is_available`, `domain`
- `get_domain_price(tld)` — reads from Hostinger billing catalog (first-year price, in cents/100)
- `_get_catalog()` — in-process cached catalog fetch from `GET /api/billing/v1/catalog`
- RDAP fallback: `https://rdap.org/domain/{fqdn}` — 404=available, 200=taken

**Pricing from catalog (first-year rates as of 2026-02):**
| TLD | First year | Renew |
|-----|-----------|-------|
| .com | $9.99 | $19.99 |
| .net | $14.99 | ~$19.99 |
| .co | $27.99 | ~$29.99 |
| .io | $31.99 | ~$39.99 |

**API base URL:** `https://developers.hostinger.com`
**Auth:** `Authorization: Bearer {HOSTINGER_API_KEY}` (never-expiring key)

### Stripe Products

Two sets of products — live and test. Created on the BoutaByte account (`dallas@boutabyte.com`, `acct_1SxDwVEiZuVYT71f`).

| Product | Type | Price | Live env var | Test env var |
|---------|------|-------|-------------|-------------|
| HELM Hosting — Starter | recurring/monthly | $10.00/mo | `STRIPE_PRICE_HOSTING_STARTER` | `STRIPE_TEST_PRICE_HOSTING_STARTER` |
| HELM Hosting — Pro | recurring/monthly | $15.00/mo | `STRIPE_PRICE_HOSTING_PRO` | `STRIPE_TEST_PRICE_HOSTING_PRO` |
| HELM Hosting — Business | recurring/monthly | $25.00/mo | `STRIPE_PRICE_HOSTING_BUSINESS` | `STRIPE_TEST_PRICE_HOSTING_BUSINESS` |
| HELM Domain — Standard | one_time | $14.99 | `STRIPE_PRICE_DOMAIN_STANDARD` | `STRIPE_TEST_PRICE_DOMAIN_STANDARD` |
| HELM Domain — Bundle | one_time | $1.00 | `STRIPE_PRICE_DOMAIN_BUNDLE` | `STRIPE_TEST_PRICE_DOMAIN_BUNDLE` |
| WP Pro Updates & Backup | recurring/monthly | $15.00/mo | `STRIPE_PRICE_WP_PRO_ADDON` | `STRIPE_TEST_PRICE_WP_PRO_ADDON` |

**Checkout URLs:**
- Success: `/helm/?ws_session={CHECKOUT_SESSION_ID}&ob={onboarding_id}`
- Cancel: `/helm/?ob={onboarding_id}&step=4`

**Registered live webhook:** `we_1T49XeEiZuVYT71fA3iMcya6` → `https://opai.boutabyte.com/helm/api/website-builder/webhook/complete`

### Provisioning Flow (Post-Payment)

All sites provisioned via HITL — a task is queued in opai-tasks for the operator:

1. Stripe sends `checkout.session.completed` webhook → `/api/website-builder/webhook/complete`
2. OR: on Stripe redirect return, `completeAfterStripe()` in JS calls the endpoint directly
3. Backend verifies session payment status
4. Creates HITL task: "Provision Hostinger Site — {domain}"
   - Login to Hostinger agency hPanel
   - Register/transfer domain
   - Create hosting account for chosen plan
   - Install WordPress (or deploy static starter)
   - Install OPAI WP Connector plugin (if WordPress)
   - Update `provision_data` + set `provision_status = 'live'`
5. Updates `helm_website_builds` + `helm_businesses.website` + advances onboarding to step 5

### Frontend Flow on Stripe Return

After Stripe redirect: URL is `/helm/?ws_session=XXX&ob={onboarding_id}`

1. `initApp()` in `app.js` detects `ws_session` + `ob` params
2. Seeds `onboardingState.onboardingId` from `ob` param
3. Sets step to 4, shows onboarding tab
4. `renderStep4()` detects `ws_session` → calls `initWebsiteBuilder()`
5. `initWebsiteBuilder()` detects `ws_session` → renders Sub D + calls `completeAfterStripe(sessionId)`
6. On success: cleans URL params, pauses 3s, advances to step 5

### WP Pro Add-on

When "WP Pro Updates & Backup" checkbox is checked:
1. `STRIPE_PRICE_WP_PRO_ADDON` added as third line item in Stripe checkout (recurring $15/mo)
2. After payment: `_register_in_op_wordpress()` called — POSTs to `OP_WORDPRESS_URL/api/sites/register`
3. Site appears in OP WordPress admin with `plugin_auto_push: true`
4. `wp_pro_addon=true` stored on `helm_website_builds` row

---

## Stripe Test Mode (Sandbox)

Toggle `STRIPE_TEST_MODE=true` in `.env` to switch the website builder to sandbox mode.

**How it works:**
- `config.stripe_key()` returns `STRIPE_TEST_SECRET_KEY` when test mode is on
- `config.stripe_webhook_secret()` returns `STRIPE_TEST_WEBHOOK_SECRET`
- All `_plan_price_id()` / `_domain_price_id()` calls use `STRIPE_TEST_PRICE_*` env vars
- No charges to real cards — use Stripe test card numbers

**Test card numbers (always work in Stripe test mode):**
| Card | Number | Use |
|------|--------|-----|
| Visa | `4242 4242 4242 4242` | Successful payment |
| Visa (3D Secure) | `4000 0027 6000 3184` | Requires auth |
| Decline | `4000 0000 0000 9995` | Insufficient funds |

Use any future expiry (e.g. `12/34`), any 3-digit CVC, any ZIP.

**Webhook forwarding for local test:**
```bash
~/bin/stripe listen --forward-to localhost:8102/helm/api/website-builder/webhook/complete \
  --api-key $STRIPE_TEST_SECRET_KEY
# whsec_ it prints is already set in STRIPE_TEST_WEBHOOK_SECRET in .env
# Run in a terminal before doing test purchases — keeps running in foreground
```

**To go live:** Set `STRIPE_TEST_MODE=false` in `.env` and restart.

---

## Scheduler Jobs

The asyncio scheduler (60-second tick) queries `helm_business_schedule WHERE enabled = true AND next_run_at <= now()`.

| Job | Default Schedule | What It Does |
|-----|-----------------|--------------|
| `content_generate` | Daily 6am (business TZ) | Generate N content drafts → HITL if required. Optional [NotebookLM](../integrations/notebooklm.md) topic research (`research_first: true`) |
| `social_post` | Per platform, configurable | Pick/generate post → publish via platform API |
| `report_weekly` | Mon 7am | Full week summary: content, social, revenue, recommendations. [NotebookLM](../integrations/notebooklm.md) pre-analysis + optional audio briefing |
| `competitor_research` | Configurable | [NotebookLM](../integrations/notebooklm.md)-native competitive analysis: web research + synthesized report per business |
| `stripe_sync` | Every 6h | Pull MRR/ARR/customers → cache in stripe_config row |
| `site_health_check` | Every 30m | HEAD request to each domain → update uptime_status |
| `social_stats_sync` | Daily | Sync follower/engagement stats from all platforms |
| `hitl_expiry` | Every 15m | Mark expired HITL items; auto-approve if autopilot enabled |

---

## CEO-Gate (HITL) — When HELM Escalates

**Default autonomy: 8/10.** The human owner is only pulled in for:

**1. Financial decisions** (always escalate):
- Any Stripe product or price change, new product creation
- Any vendor payment or subscription
- Paid advertising budget changes
- Invoicing or billing modifications

**2. Errors it cannot self-resolve:**
- API failures after N retries (N configured per connector)
- Credential expiry after attempted refresh
- Deployment failures after rollback attempt

**3. Conflicts:**
- Brand inconsistency detected in generated content
- Legal compliance flag triggered
- Contradictory instructions between knowledge base and business profile
- Negative press / reputation event detected

**CEO-gate queue behavior:**
- **Financial:** Wait indefinitely. Re-notify every 24h via Discord. Never auto-skip.
- **Error:** Wait 4h then escalate to Discord alert if unresolved.
- **Conflict:** Pause affected operations only. Continue everything else.

---

## Credential Vault

Actual secrets never touch the database. Fernet-encrypted JSON blobs on disk.

```
vault/{business_id}/
  twitter.json.enc
  stripe.json.enc
  wordpress.json.enc
  netlify.json.enc
  sendgrid.json.enc
```

`HELM_VAULT_KEY` (Fernet key) lives in `.env`. `helm_business_credential_refs` tracks what vault keys exist and their expiry — never the values.

---

## Claude Prompting — Layered System Prompt

Every Claude call is built in layers via `core/ai.py`:

1. **Identity layer** — business name, industry, stage, value proposition, target audience
2. **Brand voice layer** — personality, tone-of-voice, brand voice notes
3. **Goals layer** — primary goal, revenue target, lead target
4. **Knowledge layer** — relevant knowledge base entries
5. **Task layer** — task-specific instructions (content_generate, social_post, etc.)

---

## Required Environment Variables

```bash
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
SUPABASE_JWT_SECRET=

# Vault encryption (never rotate without migrating vault files)
HELM_VAULT_KEY=

# Public URL (used for Stripe redirect URLs)
HELM_PUBLIC_URL=https://opai.boutabyte.com

# Internal services
DISCORD_BRIDGE_URL=http://127.0.0.1:8083
TASKS_URL=http://127.0.0.1:8081
OP_WORDPRESS_URL=http://127.0.0.1:8095
INTERNAL_API_KEY=

# Hostinger Agency API (domain availability + catalog pricing)
HOSTINGER_API_KEY=          # never expires

# GoDaddy (kept for future MCP use — fallback used via RDAP)
GODADDY_API_KEY=
GODADDY_API_SECRET=

# Netlify Admin PAT (kept for future auto-provisioning)
NETLIFY_ADMIN_PAT=

# Stripe — BoutaByte account
STRIPE_TEST_MODE=false      # set true for sandbox testing
STRIPE_SECRET_KEY=sk_live_...
STRIPE_TEST_SECRET_KEY=sk_test_...
STRIPE_HELM_WEBHOOK_SECRET=whsec_...   # live webhook signing secret
STRIPE_TEST_WEBHOOK_SECRET=whsec_...   # Stripe CLI forwarding secret

# Stripe price IDs — live
STRIPE_PRICE_HOSTING_STARTER=price_1T49XcEiZuVYT71fpEUVIodC
STRIPE_PRICE_HOSTING_PRO=price_1T49XcEiZuVYT71fmgVsDVAf
STRIPE_PRICE_HOSTING_BUSINESS=price_1T49XcEiZuVYT71f1hbxLsCS
STRIPE_PRICE_DOMAIN_STANDARD=price_1T49XdEiZuVYT71f8PSAG5vH
STRIPE_PRICE_DOMAIN_BUNDLE=price_1T49XdEiZuVYT71fzdpMddVv
STRIPE_PRICE_WP_PRO_ADDON=price_1T49XeEiZuVYT71fDRivfl3m

# Stripe price IDs — test (created by running create-test-products.py)
STRIPE_TEST_PRICE_HOSTING_STARTER=
STRIPE_TEST_PRICE_HOSTING_PRO=
STRIPE_TEST_PRICE_HOSTING_BUSINESS=
STRIPE_TEST_PRICE_DOMAIN_STANDARD=
STRIPE_TEST_PRICE_DOMAIN_BUNDLE=
STRIPE_TEST_PRICE_WP_PRO_ADDON=
```

---

## Caddy + Navbar Registration

**Caddyfile** (`config/Caddyfile`):
```caddy
handle_path /helm/* {
    reverse_proxy localhost:8102
}
@helmExact path /helm
redir @helmExact /helm/ 301
```

**navbar.js** (`tools/opai-portal/static/js/navbar.js`):
```javascript
'helm': {
    abbr: 'HL',
    color: '#e11d48',
    label: 'HELM',
    path: '/helm/'
},
```
`'helm'` must be in `FULL_HEIGHT_TOOLS` — HELM is a full-height SPA.

---

## systemd Service

```ini
# config/service-templates/opai-helm.service
[Unit]
Description=OPAI HELM — Autonomous Business Runner (port 8102)
After=network.target

[Service]
Type=simple
User=dallas
WorkingDirectory=/workspace/synced/opai/tools/opai-helm
Environment="PATH=/home/dallas/.nvm/versions/node/v20.19.5/bin:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile=/workspace/synced/opai/tools/opai-helm/.env
ExecStart=/usr/bin/python3 -m uvicorn app:app --host 127.0.0.1 --port 8102
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

---

## Key Design Decisions

**Hostinger as primary domain + hosting provider:** Hostinger's agency account gives HELM free hosting for all managed businesses. Domain purchase uses the agency billing account (card on file). Domain availability uses the Hostinger API (`developers.hostinger.com`) with RDAP as fallback.

**GoDaddy kept as fallback:** GoDaddy API credentials in `.env` and `connectors/godaddy.py` are retained for potential future reseller access. GoDaddy MCP server configured globally in `.mcp.json` (`https://api.godaddy.com/v1/domains/mcp`). Currently, standard credentials return `ACCESS_DENIED` — RDAP is used instead.

**Stripe StripeClient (not global):** HELM uses `stripe.StripeClient(key)` (stripe-python 14.x new-style client), NOT the old global `stripe.api_key = key` pattern. All session create/retrieve calls use `params={}` dict format. Webhook verification uses `sc.construct_event()`.

**Test mode toggle:** `STRIPE_TEST_MODE=true` in `.env` switches the entire checkout flow to sandbox — keys, webhook secret, and price IDs. The domain availability check always uses the real Hostinger API (safe for testing).

**HITL-first provisioning:** All site provisioning goes through the HITL task queue (opai-tasks). This avoids partial automated provisioning failures in MVP. Full auto-provisioning via Hostinger API is Phase 2.

**Why file vault over DB:** Supabase has no managed per-row JSON blob encryption. Fernet vault is auditable, zero-cost, and portable. Interface isolated in `core/vault.py` — easy to migrate to HashiCorp/cloud KMS later.

---

## Build Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 — Foundation | DB, FastAPI skeleton, onboarding steps 1-3, business profile CRUD | ✅ Complete |
| 2 — Website Builder | Domain search (Hostinger), Stripe checkout, HITL provisioning | ✅ Complete |
| 3 — Content | Content generation, WP REST publish, calendar view | 🔶 Partial |
| 4 — Social | Platform OAuth connectors, social post generation, scheduler | ⬜ Planned |
| 5 — Revenue | Stripe integration, product management, revenue dashboard | ⬜ Planned |
| 6 — Reports | Weekly/monthly AI reports, health score, knowledge update | 🔶 Partial |
| 7 — Mobile | HELM tab in OPAI mobile app, push notifications for HITL | ⬜ Planned |

---

## State of Development (as of 2026-02-24)

> This section is a pause-point snapshot. HELM is MVP-functional but ~40% of the originally planned features are stubs or unconnected. Pick up from here on resume.

---

### ✅ What Works (Confirmed Functional)

**Infrastructure:**
- FastAPI app boots cleanly, scheduler starts, all routes mount
- Supabase CRUD (get/post/patch/delete helpers in `core/supabase.py`)
- Auth via shared `tools/shared/auth.py` (JWT + Supabase service key)
- Fernet credential vault (`core/vault.py`) — encrypt/decrypt, per-business directory
- Caddy proxy at `/helm/`, registered in navbar, correct full-height SPA handling
- systemd service auto-restarts, logs clean

**Onboarding (8-step wizard):**
- Step 1: Document upload (PDF/DOCX/MD/text) AND structured form path — both functional
- Step 2: AI parse with SSE streaming — extracts fields, confidence scores, source citations
- Step 3: Business profile confirmation — name, slug, brand colors, tone, audience, autonomy slider (slider now syncs to state in real time; pre-selects saved tone value)
- Step 4: Website Setup — all 4 cards (WordPress, Netlify, Other, Build-for-me) functional
- Step 5: Social accounts — add/display existing social accounts (OAuth popup stubs, credential storage works)
- Step 6: Stripe setup — connect Stripe, skip option
- Step 7: AI content generation — SSE stream, generates 3 initial content pieces
- Step 8: Review & Launch — week 1 plan, autonomy display (now reads actual slider value), launch confirmation
- **Onboarding resume:** on page refresh, in-progress businesses are found (even while `is_active=False`) and auto-resumed at the correct step
- **Step tracking:** current_step saved at steps 5, 6, 7 so resume is accurate

**Settings Tab:**
- All profile fields save correctly via `PATCH /api/businesses/{id}/settings`
- Stage options match DB constraint (`idea/mvp/growth/established/scaling`)
- Automation schedule toggles save immediately (per-job `PATCH /schedules/{job_type}`)
- Automation schedule frequency changes save immediately — "Next:" display updates without reload
- Products and Competitors arrays (add/remove via JSON manager)
- Social accounts display — connected accounts shown, handle set/remove works
- Credentials display — stored vault refs shown, remove works
- WordPress connections — add/test/remove via WP REST Application Passwords
- GitHub/Netlify connections — add/test/remove (pushes content as Markdown to GitHub repo)
- **Social Post Schedules** (new 2026-02-24): per-platform scheduling in the Automation Schedules section — create, toggle, set frequency, delete — stored in `social_post` schedule row `config.platforms[]`

**Website Builder (Step 4 "I need a website"):**
- Domain availability check via Hostinger API + RDAP fallback
- Domain suggestions across 4 TLDs from business name
- Platform recommendation logic (e-commerce→WP Pro, tech→Static, default→WP Starter)
- Hosting plan selection (Starter/Pro/Business)
- Stripe checkout — line items, domain bundle pricing, WP Pro add-on checkbox
- Post-payment flow: HITL task queued in opai-tasks, `helm_website_builds` row created
- Export Setup Guide — downloads Markdown file, skips payment
- Stripe test mode toggle (`STRIPE_TEST_MODE=true`)
- Live Stripe webhook registered: `we_1T49XeEiZuVYT71fA3iMcya6`

**Dashboard Tab:**
- Renders KPIs from `/api/businesses/{id}/dashboard`: action counts, content queue, social accounts, recent actions
- Shows content queue (draft/review/scheduled items)
- Shows HITL pending count (badge on tab, items in dashboard)
- Health score bar visible
- Alerts section (if any flagged items exist)

**Scheduler (asyncio 60s tick):**
- `content_generate` — fully implemented (calls Claude, saves draft, creates HITL item, publishes if autonomy high) ✅
- `report_weekly` — fully implemented (calls Claude, saves report, creates HITL item) ✅
- `site_health_check` — fully implemented (HEAD request per domain, updates `is_active`) ✅
- `hitl_expiry` — fully implemented (expires stale items, auto-approves on full autopilot) ✅
- `stripe_sync` — **placeholder only** (logs action, no Stripe API call) ⚠️
- `social_stats_sync` — **placeholder only** (logs action, no platform API call) ⚠️
- `social_post` — **no job file at all** — `JOB_DISPATCH` maps it but no `jobs/social_post.py` exists ❌

**Actions Tab / HITL Tab:**
- Actions tab renders activity log (all `helm_business_actions` rows)
- HITL tab renders pending items — approve/reject works
- HITL badge on tab nav updates with count

---

### ⚠️ Known Issues / Partially Broken

1. **`social_post` job missing** — `core/scheduler.py` `JOB_DISPATCH` includes `"social_post": "jobs.social_post"` but `jobs/social_post.py` does not exist. If this schedule fires (it's seeded with `enabled=False` so it won't by default), the scheduler will throw `ModuleNotFoundError`. The new per-platform social post config UI is wired up but the actual job that acts on it isn't written yet.

2. **`stripe_sync` job is a stub** — job runs successfully (no error) but doesn't call Stripe API. The `helm_business_stripe_config` table MRR/ARR fields remain 0 forever until this is wired.

3. **`social_stats_sync` job is a stub** — same pattern. Follower counts in the dashboard remain at whatever was manually set.

4. **`routes/social.py` is empty** — the social router mounts but has zero endpoints. Social platform OAuth, post scheduling, analytics — none of it is there. The onboarding Step 5 "Connect Social Accounts" UI shows account types but the backend OAuth flow is not wired.

5. **Content generation → WordPress publish** — `content_generate.py` generates a draft and creates a HITL item, but the WP publish step (via `connectors/wordpress.py`) is not called from the job. Approved content in HITL doesn't auto-push to WordPress. `routes/content.py` has a manual publish endpoint but it's not connected to HITL approval flow.

6. **Dashboard KPIs mostly empty** — revenue figures (MRR, ARR, customers) show 0 because `stripe_sync` is a stub. Social follower counts show 0 because `social_stats_sync` is a stub. These sections look bare for new businesses.

7. **Step 5 Social OAuth** — The onboarding UI shows platform icons and a "Connect" button, but the popup OAuth flow isn't wired to any backend. Credentials can be manually entered as vault entries, but the automated OAuth token flow doesn't exist.

8. **Settings tab "Social Post Schedules" requires reload to update card state** — After creating/deleting a platform schedule, the card re-renders but if the social accounts list changed mid-session, a full page reload is needed to show updated state.

9. **Schedule `next_run_at` timezone storage inconsistency** — `seed_schedules` uses `next_run.isoformat()` which produces `+00:00` suffix. The scheduler query uses `Z` suffix. Supabase/Postgres handles both correctly, but the "Next:" display in the UI calls `timeAgo()` which expects UTC — this should be fine but could cause display glitches if the DB stores naive datetimes from an older seed run.

---

### ❌ Not Built Yet (Confirmed Missing)

**Social platform connectors** (Phase 4):
- No `connectors/twitter.py`, `connectors/instagram.py`, `connectors/linkedin.py`, etc.
- No OAuth token exchange flow (backend)
- No post publishing to any platform API
- No `jobs/social_post.py` (the job that would USE the connectors)
- Social accounts in settings are display-only; handle can be set manually

**Stripe business integration** (Phase 5):
- `routes/stripe.py` or similar doesn't exist — no product/price management UI for managed businesses
- `stripe_sync` job doesn't pull real data
- Revenue dashboard tile shows zeros

**Knowledge base management UI** — table exists, `core/knowledge.py` has retrieval logic, but no UI to add/edit/view knowledge entries

**Multi-business home view** — UI is single-business after selection. No overview screen showing all businesses at a glance with health scores, revenue, pending HITL across all.

**Lead management UI** — `helm_business_leads` table exists and is in the DB migration but there's no tab or route to view/manage leads

**Email/outreach automation** — `email_campaign` is in the scheduler job_type CHECK constraint but there's no job file, route, or email connector

**Discord per-business channels** — planned (helm-{slug} channel per business via discord-bridge) but not implemented

**Mobile HELM tab** (Phase 7) — not started

**Auto-provisioning via Hostinger API** — currently all site provisioning goes to HITL. Hostinger has an API (`POST /api/hosting/v1/`) to create accounts programmatically — not wired.

**WP plugin push** — `_register_in_op_wordpress()` is called in `website_builder.py` for WP Pro add-on, but the OPAI WP Connector plugin isn't auto-installed on new Hostinger sites (that part is manual HITL)

**Content calendar view** — Step 7 generates 3 initial pieces but there's no calendar/kanban UI to view/manage the full content pipeline. The dashboard shows a flat list of queue items.

---

### 🗺️ Resume Roadmap (Suggested Order)

Pick up from here in priority order:

| # | What | Effort | Impact |
|---|------|--------|--------|
| 1 | `jobs/social_post.py` — write stub that reads `config.platforms`, picks a draft from content queue, and posts via connector | Med | Closes the scheduler loop for social |
| 2 | `connectors/twitter.py` (or Instagram) — one real platform connector, post + read stats | High | Unlocks all social Phase 4 work |
| 3 | Wire HITL approval → WP auto-publish in `routes/content.py` HITL approval endpoint | Low | Closes content generation loop |
| 4 | `stripe_sync` job — call Stripe API, pull MRR/ARR/customer count, store in `helm_business_stripe_config` | Med | Revenue dashboard goes live |
| 5 | Multi-business home view (front-end only) — card grid showing active businesses with health/revenue/HITL badges | Med | Makes HELM useful at scale |
| 6 | Lead management tab | Low | Long-requested feature |
| 7 | Knowledge base UI | Low | Rounds out settings |
| 8 | Discord bridge per-business channel | Low | Comms layer |
| 9 | Social OAuth backend flow (Twitter/LinkedIn OAuth 2.0) | High | Required for automated posting |
| 10 | Mobile HELM tab | High | Phase 7 |

---

## Playbook Library

> Updated 2026-03-05 (Token Burn Sprint Phase 2, Track D)

HELM's business playbooks live in `Library/helm-playbooks/`. Each playbook is a self-contained brief that HELM reads to understand how to deliver a service. See `Library/helm-playbooks/README.md` for the full index and format spec.

### Current Playbooks

| Playbook | Status | Category |
|----------|--------|----------|
| GEO Audit & Optimization Service | Draft | Agency / Marketing |
| AIOS Consulting & Vertical Packages | **Draft** | Consulting |
| Customer Onboarding Playbook | **Draft** | Consulting / Operations |
| Affiliate Revenue Streams | Idea | Passive Income / Affiliate |
| AI-Native SaaS Playbook | Reference | SaaS / Product |

**Recent changes:**
- **AIOS Consulting** upgraded from Idea to Draft status with full service tiers, pricing, and delivery workflow
- **Customer Onboarding Playbook** created — SOP for deploying consulting services to paying customers (qualification, assessment, deployment, training, retainer transition)
- **Gap analysis** performed — see `notes/Improvements/knowledge-gap-analysis.md` for identified documentation gaps and recommendations

### Supporting Reference Docs

Several reference docs were created to support playbook execution:

| Document | Path |
|----------|------|
| Tool Selection Guide | `Library/knowledge/reference/tool-selection-guide.md` |
| Client Onboarding Checklist | `Library/knowledge/reference/client-onboarding-checklist.md` |
| Service Delivery Workflow | `Library/knowledge/reference/service-delivery-workflow.md` |
| Agency Pricing Framework | `Library/knowledge/reference/agency-pricing-framework.md` |
