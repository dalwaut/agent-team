# Bx4 — BoutaByte Business Bot
> Last updated: 2026-02-22 (post-launch fixes) | Source: `tools/opai-bx4/` | Port: 8100 | Route: `/bx4/`

## Overview

Bx4 is a persistent AI business intelligence companion. It maintains a living model of every connected company — fed by real financial data, social analytics, and market signals — then surfaces prioritized, budget-aware, actionable advice that users can act on or route to Team Hub as tasks.

**Core loop:** Ingest → Analyze → Advise (budget-filtered) → Track → Repeat

**Budget-First Principle:** Every recommendation is scored for financial impact before surfacing. Triage Mode auto-engages when runway < 2 months or health score < 40.

| Property | Value |
|----------|-------|
| **Port** | `8100` |
| **Framework** | FastAPI + Uvicorn |
| **Database** | Supabase (19 tables, RLS) |
| **Auth** | Shared Supabase JWT — admin-only Phase 1, delegated via Users tool |
| **Frontend** | Vanilla JS SPA (`static/index.html` + 10 JS files) |
| **Service** | `opai-bx4` (systemd user unit) |
| **Caddy route** | `/bx4/` → `localhost:8100` |
| **Migrations** | `024_bx4.sql` (P1), `025_bx4_phase2.sql` (P2), `026_bx4_phase3.sql` (P3), `027_bx4_phase4.sql` (P4), `028_bx4_phase5.sql` (P5) |
| **Version** | 1.0.0 (Phase 5 complete) |

---

## Architecture

```
tools/opai-bx4/
  ├── app.py                     FastAPI entrypoint — mounts all routers + static files
  ├── config.py                  Port 8100, Supabase env, Anthropic key, CREDIT_COSTS
  ├── requirements.txt
  ├── .env -> ../opai-agents/.env  (shared Supabase + Anthropic keys)
  │
  ├── core/
  │   ├── advisor.py             4-layer Claude prompt builder + analysis/chat caller
  │   ├── budget_filter.py       Green Filter — scores and ranks recs by financial impact
  │   ├── intake.py              10-question onboarding Q&A flow
  │   ├── alerts.py              Threshold monitoring against financial snapshots
  │   ├── scheduler.py           Background asyncio loop — checks for due analyses
  │   ├── taskhub.py             Team Hub bridge — create/monitor tasks
  │   └── credits.py             Credit tracking (logging-only; billing inactive)
  │
  ├── wings/
  │   ├── financial.py           P&L processing, cash flow, expense analysis
  │   ├── market.py              Web-search market intel, competitor monitoring
  │   ├── social.py              Platform analytics aggregation, frequency grading
  │   ├── operations.py          KPI + goal management, anomaly detection, ROI scoring
  │   └── briefings.py           Briefing generation, storage, Discord/email dispatch
  │
  ├── connectors/
  │   ├── __init__.py            Connector registry + tier definitions
  │   ├── csv_import.py          CSV/spreadsheet P&L import (Tier 0)
  │   ├── stripe.py              Stripe multi-account sync (Tier 1) — internal + user keys
  │   └── google_analytics.py   GA4 Data API via service account JWT (Tier 1)
  │
  ├── routes/
  │   ├── companies.py           Company CRUD + access management
  │   ├── financial.py           Snapshots, transactions, Stripe, cash flow, audit, scenario
  │   ├── social.py              Social accounts, snapshots, GA4 sync, trend, health
  │   ├── market.py              Market analysis, competitors, news, SWOT, positioning
  │   ├── advisor.py             Chat, pulse (stored to bx4_briefings), full analysis
  │   ├── settings.py            Company settings, goals, KPIs, KPI history, anomaly detection, alerts
  │   ├── briefings.py           List/generate/dispatch briefings (daily, weekly, pulse)
  │   ├── health.py              Aggregate health, pulse/latest, portfolio view
  │   ├── intake.py              Onboarding Q&A endpoints
  │   └── credits.py             Credit usage + recommendation management
  │
  └── static/
      ├── index.html             SPA shell (8 nav views)
      ├── style.css              Dark-theme design system
      └── js/
          ├── app.js             Auth, company switcher, routing, api() helper
          ├── dashboard.js       Pulse, wing cards, priority actions, goal progress
          ├── financial.js       Health, snapshot, transactions, cash flow chart, revenue
          │                      breakdown, expense audit, scenario modeler, tax estimate
          ├── market.js          Analysis, SWOT auto-draft, news digest, competitor research,
          │                      positioning map (2×2)
          ├── social.js          Platform health cards, follower trend chart, GA4 sync
          ├── operations.js      Goals, KPIs, Team Hub task bridge, goal decomposition (AI milestones)
          ├── advisor.js         Chat UI with history + suggested prompts
          ├── briefings.js       Briefing archive, generate daily/weekly, Discord/email dispatch, print/PDF
          ├── settings.js        Connectors (Stripe multi-account, GA4), users, schedule, alerts, notifications, billing toggle
          ├── portfolio.js       Admin-only multi-company health overview with triage flagging
          └── intake.js          Onboarding wizard
```

---

## Multi-Tenant Model

Access is controlled at every layer via RLS and `bx4_company_access`.

| Level | Who | What |
|-------|-----|------|
| OPAI Admin | Uses service key | Bypasses all RLS — sees all companies |
| Company Owner | Granted via Users tool | Full control within their companies |
| Company Manager | Granted via Users tool | Edit goals, trigger analyses |
| Company Viewer | Granted via Users tool | Read-only dashboard |

Access grant flow: Settings → Users tab → [+ Grant Access] → email + role + company.

---

## Database Schema (23 tables + Phase 4/5 additions)

| Table | Purpose |
|-------|---------|
| `bx4_companies` | Company profiles |
| `bx4_company_access` | User-to-company role mapping (multi-tenant) |
| `bx4_company_goals` | Goals per company (hierarchical, is_primary flag) |
| `bx4_onboarding_log` | Q&A answers from intake wizard |
| `bx4_financial_accounts` | Connected financial sources (provider, credentials_ref) |
| `bx4_transactions` | Raw transaction feed (positive=revenue, negative=expense) |
| `bx4_pl_documents` | Uploaded P&L files with parsed JSON |
| `bx4_financial_snapshots` | Periodic financial summaries + health score/grade |
| `bx4_expense_categories` | Expense taxonomy with monthly budgets |
| `bx4_recommendations` | AI-generated recommendations (urgency, financial_impact, ROI) |
| `bx4_action_log` | All bot actions + chat messages + credit usage |
| `bx4_market_analyses` | Market analysis runs (news, SWOT, competitor, briefing) |
| `bx4_market_news` | Cached industry news items from Claude web_search (Phase 3) |
| `bx4_swot_analyses` | SWOT drafts — strengths/weaknesses/opportunities/threats JSON (Phase 3) |
| `bx4_competitors` | User-defined competitor list |
| `bx4_social_accounts` | Connected social platforms |
| `bx4_social_snapshots` | Platform analytics snapshots (frequency_grade, health_score) |
| `bx4_kpis` | Custom KPIs with targets, current values, anomaly_flag, z_score |
| `bx4_kpi_history` | KPI value log over time — drives Z-score anomaly detection (Phase 4) |
| `bx4_briefings` | Daily/weekly/pulse briefings with dispatch status (Phase 4) |
| `bx4_alerts` | Threshold alerts (fired_at, resolved_at) |
| `bx4_credit_transactions` | Credit usage log (billing inactive, tracking active) |
| `bx4_settings` | Per-company + global settings (key/value) |

`profiles.bx4_credits` column added by migration.
`bx4_recommendations.roi_score` column added by migration 027.
`bx4_alerts.dispatched_at`, `bx4_company_goals.order_index/team_hub_task_id/is_milestone`, `bx4_financial_snapshots.quarter` columns added by migration 028.
`bx4_settings` stores notification settings: `notify_discord`, `notify_email`, `notify_email_address`, `discord_guild_id` (per-company key/value pairs).

---

## AI Advisor — 4-Layer Prompt System

| Layer | Content | Always? |
|-------|---------|---------|
| 1 — Core Identity | Bx4 persona, non-negotiable rules, budget-first mandate | Yes |
| 2 — Company Context | Company profile + latest financial snapshot + triage status | Yes |
| 3 — Wing Focus | Wing-specific instructions (financial/market/social/operations) | Per-analysis |
| 4 — Goal Lens | Active goal + filtering rules | Yes |

**Modes:** Full analysis (all 4 layers) | Wing deep dive | Advisor chat | Quick pulse | Triage brief | Weekly briefing

---

## Budget-Aware Green Filter

`core/budget_filter.py` scores every recommendation before it's stored or displayed:

- **Financial impact positive** → 2.0× multiplier (revenue-growing, cost-cutting)
- **Financial impact neutral** → 1.0× multiplier
- **Financial impact negative** → 0.3× (spending suggestions heavily suppressed when stressed)
- **Triage mode active** → non-financial wing recs get ×0.1 (almost never surfaced)

**Triage Mode** auto-engages: `runway_months < 2` OR `health_score < 40` OR `net < 0`

### Financial Health Score (0-100)
| Component | Weight |
|-----------|--------|
| Liquidity Ratio (cash/burn months) | 25% |
| Revenue Growth Rate (MoM) | 20% |
| Gross Margin % | 20% |
| Expense Efficiency | 15% |
| Debt Burden | 10% |
| Cash Conversion Cycle | 10% |

Grades: A (85+), B (70+), C (55+), D (40+), F (<40). Triage auto at <40.

---

## Connector Tiers

| Tier | Connector | Status |
|------|-----------|--------|
| 0 | Manual CSV / Data Entry | Always active |
| 1 | Stripe | Quick-connect (API key) |
| 1 | Google Analytics GA4 | Quick-connect (service account JSON) |
| 2 | QuickBooks, Xero, PayPal | OAuth (Phase 2) |
| 2 | Meta, X/Twitter, LinkedIn | OAuth social (Phase 2) |
| 3 | Plaid | Advanced — connect when needed |

---

## Credit System (Tracking-Ready, Billing Inactive)

All actions are logged to `bx4_credit_transactions` from day one.

| Action | Cost |
|--------|------|
| Full 4-wing analysis | 10 credits |
| Wing-specific analysis | 3 credits |
| Weekly briefing | 8 credits |
| Advisor chat message | 1 credit |
| Briefing export | 2 credits |
| Anomaly scan | 2 credits |

`billing_active` setting = `false` → all costs logged but not enforced. Flip to `true` when billing opens.

---

## Key Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/config` | GET | Supabase anon key for frontend init |
| `/api/health` | GET | Service health + uptime |
| `/api/companies` | GET/POST | List companies / create company |
| `/api/companies/{id}` | GET/PATCH | Company detail + snapshot + goals |
| `/api/companies/{id}/financial/snapshot` | GET/POST | Financial snapshot |
| `/api/companies/{id}/financial/upload-pl` | POST | Upload P&L CSV/XLSX |
| `/api/companies/{id}/financial/analyze` | POST | Trigger financial analysis |
| `/api/companies/{id}/advisor/chat` | POST | AI advisor chat |
| `/api/companies/{id}/advisor/pulse` | POST | Quick daily pulse |
| `/api/companies/{id}/advisor/analyze` | POST | Full multi-wing analysis |
| `/api/companies/{id}/intake/next` | GET | Next onboarding question |
| `/api/companies/{id}/intake/answer` | POST | Submit onboarding answer |
| `/api/companies/{id}/recommendations` | GET | List recommendations |
| `/api/companies/{id}/recommendations/{rid}/push-to-taskhub` | POST | Push to Team Hub |
| `/api/companies/{id}/settings/{key}` | PUT | Update a setting |
| `/api/companies/{id}/access` | GET/POST | Manage user access |
| `/api/companies/{id}/health` | GET | Aggregate health score + per-wing breakdown |
| `/api/companies/{id}/pulse/latest` | GET | Latest stored pulse for dashboard widget |
| `/api/companies/{id}/briefings` | GET | List daily/weekly briefings |
| `/api/companies/{id}/briefings/generate` | POST | Generate new daily or weekly briefing |
| `/api/companies/{id}/briefings/{id}/dispatch` | POST | Dispatch to Discord or email |
| `/api/companies/{id}/kpis/{id}/history` | POST | Log KPI value to history |
| `/api/companies/{id}/kpis/detect-anomalies` | POST | Z-score anomaly scan on all KPIs |
| `/api/portfolio` | GET | Admin: all companies with health scores |
| `/api/companies/{id}/goals/{gid}/decompose` | POST | AI goal decomposition → milestones → Team Hub |
| `/api/companies/{id}/goals/{gid}/milestones` | GET | List milestone subgoals for a goal |
| `/api/companies/{id}/financial/tax-estimate` | GET | Quarterly tax estimate (25% rate on net income) |
| `/api/companies/{id}/settings/notifications` | GET/PUT | Notification channel settings |
| `/api/companies/{id}/settings/notifications/test` | POST | Send test Discord/email notification |
| `/api/admin/billing/status` | GET | Check billing_active global setting |
| `/api/admin/billing/toggle` | POST | Toggle billing on/off (admin only) |
| `/api/scheduler/settings` | GET | Runtime scheduler state `{tick_seconds, paused}` |
| `/api/scheduler/settings` | PUT | Update tick interval / pause (body: `{tick_seconds?, paused?}`) |

---

## Service Control

```bash
# Start / stop / restart
systemctl --user start opai-bx4
systemctl --user stop opai-bx4
systemctl --user restart opai-bx4

# Status + logs
systemctl --user status opai-bx4
journalctl --user -u opai-bx4 -f

# Via control script
./scripts/opai-control.sh restart bx4
```

---

## Build Progress

### ✅ Phase 1 — Core Infrastructure
- Multi-tenant DB (19 tables), RLS, 4-layer Claude prompt, Green Filter, Triage Mode
- Financial wing: snapshots, transactions, P&L upload, health score, recommendations
- Settings panel, onboarding wizard, advisor chat, credit tracking, scheduler

### ✅ Phase 2 — Financial Deep Dive
- Stripe multi-account connector (internal OPAI key + user/client keys), deduplication via `external_id`
- Google Analytics 4 connector (service account JWT auth)
- Cash flow 90-day chart with 3-band forecast (conservative/baseline/optimistic)
- Revenue breakdown by category, source, month
- AI expense audit (Claude fat-trim report) + expense audit storage
- Scenario modeler (what-if: revenue/expenses/burn_rate/headcount)
- Settings connectors tab: Stripe account management UI with validate-before-save flow

### ✅ Phase 3 — Market + Social Wings
- `routes/social.py`: social accounts CRUD, manual snapshots, GA4 sync, trend endpoint, aggregate health
- `routes/market.py`: market analysis, competitors CRUD, news, SWOT, positioning map
- `wings/market.py`: Claude web_search news digest, competitor research, SWOT auto-draft, 2×2 positioning
- `wings/social.py`: GA4 snapshot sync, historical trend query, aggregate health score
- `connectors/google_analytics.py`: fully wired into social wing sync
- Frontend — `social.js`: follower trend chart (CSS bars), GA4 Sync button on accounts
- Frontend — `market.js`: news refresh, SWOT auto-draft, competitor research, 2×2 positioning map
- DB: `bx4_market_news`, `bx4_swot_analyses` tables; competitor `last_research_at`/`intel_summary` columns

### ✅ Phase 4 — Operations + Advanced
- `wings/briefings.py`: generate_briefing() (Claude), store_briefing(), dispatch_discord(), dispatch_email(), mark_dispatched()
- `routes/briefings.py`: GET /briefings, POST /briefings/generate, POST /briefings/{id}/dispatch
- `routes/health.py`: GET /health (aggregate all wings), GET /pulse/latest, GET /portfolio (admin)
- `wings/operations.py` additions: detect_anomalies() (Z-score, threshold 2.0σ), roi_score_recommendation() (0-10 scale)
- `routes/settings.py` additions: POST /kpis/{id}/history, POST /kpis/detect-anomalies
- `routes/advisor.py` updated: pulse stored to bx4_briefings (type='pulse') on every generate
- Frontend — `operations.js`: anomaly badges on KPI cards, Z-score display, ROI score on recs, runAnomalyDetection(), Team Hub tasks panel
- Frontend — `briefings.js`: Discord/Email dispatch buttons, Print/PDF, toggleBriefingDetail()
- Frontend — `portfolio.js` (new): admin multi-company health grid with triage flagging, switchToCompany()
- `index.html`: Portfolio nav item (admin-only, hidden by default)
- `app.js`: portfolio in VIEW_MAP, admin nav-admin-only show logic
- DB: `bx4_briefings`, `bx4_kpi_history` tables; `bx4_kpis.anomaly_flag/z_score`, `bx4_recommendations.roi_score` columns
- Migration: `027_bx4_phase4.sql`

### ✅ Phase 5 — Integrations + Billing
- **Goal decomposition engine**: Claude breaks a goal → JSON milestone plan → stored as subgoals with `is_milestone=True` → each pushed to Team Hub as a task. Decompose button on every goal card in operations.js.
- **Alert dispatch**: `core/alerts.py` now fires Discord/email notifications per company settings when thresholds breach. Checks `notify_discord`, `notify_email`, `notify_email_address`, `discord_guild_id` from `bx4_settings`. Sets `dispatched_at` on alert.
- **Tax estimate tracker**: `GET /financial/tax-estimate` groups last 12 snapshots by quarter, applies 25% rate to net income. Collapsible card in Financial view with quarterly table + annual totals.
- **Notification settings tab**: Settings → Notifications — Discord toggle (guild ID field) + Email toggle (address field) + Send Test button. Stored in `bx4_settings` as per-company key/value pairs.
- **Billing activation toggle**: Settings → Credits — admin-only "Activate/Deactivate Billing" button. Calls `/api/admin/billing/toggle`. Credits tab now dynamically loads billing status from DB.
- **Migration**: `028_bx4_phase5.sql` — `dispatched_at` on alerts, `order_index/team_hub_task_id/is_milestone` on goals, `quarter` on snapshots.

### 🔲 Phase 6 — Tier 2/3 Connectors (Future)
- QuickBooks/Xero OAuth (Tier 2)
- Plaid bank aggregation (Tier 3)

---

## Post-Launch Fixes (2026-02-22)

### Monitor Health Endpoint
Monitor probes `/health` (not `/api/health`). Added `@app.get("/health")` decorator alias to `app.py` alongside `/api/health`. Same fix applied to `opai-brain` (`routes/health.py`). Without this, the service shows as unreachable in the monitor health summary.

### Scheduler Column Names
`core/scheduler.py` was querying `bx4_action_log` with wrong column names — caused 400 Bad Request every 5 minutes. Actual schema:
- `action_type` (not `action`)
- `summary` (not `result`)
- `actor` (not `user_id`)

### Timestamp Column Names (Critical — Supabase returns 400 on wrong column)
Different tables use different timestamp column names — do NOT assume `created_at`:

| Column | Tables |
|--------|--------|
| `generated_at` | `bx4_financial_snapshots`, `bx4_recommendations`, `bx4_market_analyses`, expense audits |
| `captured_at` | `bx4_social_snapshots` |
| `asked_at` | `bx4_onboarding_log` |
| `created_at` | `bx4_action_log`, `bx4_credit_transactions`, and all others |

Fixes applied across: `routes/companies.py`, `routes/health.py`, `routes/market.py`, `routes/credits.py`, `wings/financial.py`, `wings/social.py`.

### Onboarding Wizard — Three JS Bugs Fixed
All three bugs were in `static/js/intake.js`:

1. **Wrong property**: `status.complete` → `status.completed`
2. **Wrong assignment**: `_intakeCurrentQ = data` → `_intakeCurrentQ = data.question` (was storing entire API response, causing `[object Object]` display)
3. **Wrong POST field**: `{question_id: ...}` → `{question: _intakeCurrentQ.question, answer, phase}` (backend expects `question` field, not `question_id`)

`core/intake.py` FOUNDATION_QUESTIONS enriched with full metadata per question: `type`, `key`, `hint`, `placeholder`, `options` (for select/chips), `unit` (for currency/number). Supports 6 input types: `textarea`, `text`, `select`, `chips`, `number`, `currency`.

### Layout & Scrolling Fix
Bx4 is a full-height SPA. Added `bx4` to `FULL_HEIGHT_TOOLS` in `navbar.js` so the navbar injects `body { display: flex; flex-direction: column }`. Without this, `flex: 1` on `.app` has no effect (parent not flex) and `.main-content`'s `overflow-y: auto` never triggers — all wing pages appear non-scrollable.

Also changed `.top-bar` from `position: fixed; top: 0` to `flex-shrink: 0` (in-flow) to avoid overlapping the injected OPAI navbar.
