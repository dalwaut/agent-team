# OPAI Billing
> Last updated: 2026-02-20 | Source: `tools/opai-billing/`

Stripe-powered billing system for OPAI subscriptions. Handles product/price management, checkout sessions, webhook processing, subscription lifecycle, and post-purchase auto-provisioning. Uses a dual-Supabase architecture: OPAI Supabase for auth/JWT validation and BB2.0 Supabase for all billing data.

## Overview

| Property | Value |
|----------|-------|
| **Port** | `8094` |
| **Framework** | FastAPI + Uvicorn |
| **Database** | BB2.0 Supabase (`aggxspqzerfimqzkjgct`) for billing data |
| **Auth** | OPAI Supabase JWT (ES256 JWKS, HS256 fallback) via `shared/auth.py` |
| **Payments** | Stripe (test mode: `sk_test_...`, live publishable: `pk_live_...`) |
| **Frontend** | Admin dashboard (vanilla JS SPA) + public landing site |
| **Service** | `opai-billing` (systemd user unit) |
| **Caddy route** | `/billing/*` -> `localhost:8094` |
| **Public URL** | `https://opai.boutabyte.com` (reverse proxy to OPAI Server; marketing page at `/about`) |
| **Version** | 1.0.0 |

## Architecture

### Dual-Supabase Setup

This is the critical architectural distinction. Unlike every other OPAI tool (which uses a single Supabase instance), billing straddles two:

```
                     OPAI Supabase (idorgloobxkmlnwnxbej)
                     ├── Auth (JWT validation via shared/auth.py)
                     ├── profiles table (tier, opai_access, stripe_customer_id)
                     └── Standard SUPABASE_* env vars

                     BB2.0 Supabase (aggxspqzerfimqzkjgct)
                     ├── stripe_products, stripe_prices
                     ├── subscriptions, stripe_customers
                     ├── payment_transactions
                     ├── stripe_webhook_events
                     ├── provisioning_queue
                     └── BB_SUPABASE_URL / BB_SUPABASE_SERVICE_KEY env vars
```

**Why the split**: All OPAI tools authenticate against OPAI Supabase (shared JWT, shared `auth.py`). But the Stripe/billing tables live on BB2.0 Supabase, which is the BoutaByte product database. The billing service bridges both: it validates admin identity via OPAI Supabase, then reads/writes billing data on BB2.0.

In `config.py`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` point to BB2.0 (billing data), while `OPAI_SUPABASE_URL` and `OPAI_SUPABASE_SERVICE_KEY` point to OPAI (operational data). The standard `SUPABASE_*` env vars (without prefix) are read by `shared/auth.py` for JWT validation and point to OPAI Supabase.

### Request Flow

```
Public (opai.boutabyte.com)          Admin (OPAI portal /billing)
        │                                      │
        │ GET /api/checkout/products           │ GET /api/dashboard
        │ POST /api/checkout/session           │ CRUD /api/products
        │                                      │ /api/subscriptions/*
        ▼                                      ▼
   BB VPS Traefik ──→ OPAI Server Caddy ──→ localhost:8094
        │                                      │
        │                            ┌─────────┼───────────┐
        │                            ▼         ▼           ▼
        │                     shared/auth.py  config.py  stripe_client.py
        │                     (OPAI Supa)     (BB Supa)  (BB Supa REST)
        │                                                     │
   Stripe ──────── webhooks ──→ POST /api/webhooks/stripe ────┘
                                      │
                                      ▼
                               provisioner.py
                               (queue steps for orchestrator)
```

### BB VPS Proxy (Traefik via Coolify)

BB VPS (`72.60.115.74` / Tailscale `100.106.200.68`) runs Traefik v3 via Coolify with Let's Encrypt TLS. Config: `/data/coolify/proxy/dynamic/opai-boutabyte.yaml` on the VPS. Reference copy: `tools/opai-billing/deploy/bb-vps-caddyfile`. SSH as `root@bb-vps` (no `dallas` user on VPS). Traefik entrypoints are `http`/`https` (NOT `web`/`websecure`). YAML comments must be ASCII-only (no unicode).

| Path | Traefik Router | Target |
|------|---------------|--------|
| `/about`, `/about/*` | `opai-about` (priority 100) | Static server `host.docker.internal:8095` (strips `/about` prefix) |
| `/welcome` | `opai-welcome` (priority 100) | Static server (rewrites path to `/welcome.html`) |
| `/*` (everything else) | `opai-catchall` (priority 1) | `https://100.72.206.23` (OPAI Caddy via Tailscale, insecureSkipVerify) |

All OPAI platform traffic (auth, dashboard, chat, billing API, etc.) flows through the catch-all reverse proxy to OPAI Server Caddy (`100.72.206.23`), which handles internal routing to localhost services. WebSockets work automatically. Static files served by Python `http.server` on port 8095 (`opai-landing.service`).

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-billing/app.py` | FastAPI entrypoint, mounts 4 routers + static files, health endpoint |
| `tools/opai-billing/config.py` | Env config: server, dual-Supabase, Stripe keys, paths |
| `tools/opai-billing/stripe_client.py` | BB2.0 Supabase REST helpers (`bb_query`, `bb_rpc`, `bb_admin_create_user`, `bb_admin_generate_link`) + OPAI Supabase helpers (`_opai_headers`, `_opai_rest`) |
| `tools/opai-billing/routes_api.py` | Admin API: product/price CRUD, dashboard, transactions, Stripe import/push |
| `tools/opai-billing/routes_subscriptions.py` | Subscription management: list, cancel, pause, resume, revoke |
| `tools/opai-billing/routes_webhooks.py` | Stripe webhook handler (signature verification, idempotency, 7 event types) |
| `tools/opai-billing/routes_checkout.py` | Public checkout: list products, create Stripe Checkout Session |
| `tools/opai-billing/provisioner.py` | Post-purchase provisioning queue (4 steps, orchestrator-driven) |
| `tools/opai-billing/static/` | Admin dashboard SPA (index.html, app.js, style.css) |
| `tools/opai-billing/public-site/` | Public landing page (index.html) + welcome/onboarding page (welcome.html) |
| `tools/opai-billing/deploy/deploy-bb-vps.sh` | SSH deploy script for public site to BB VPS |
| `tools/shared/auth.py` | Shared JWT auth module (JWKS + HS256), reads standard `SUPABASE_*` env vars |

## Database Schema (BB2.0 Supabase)

### Billing Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `stripe_products` | Product catalog | stripe_product_id, name, description, category, tier_mapping, `active` (boolean), `images` (array), metadata |
| `stripe_prices` | Price records | stripe_price_id, product_id (FK), `unit_amount` (cents), currency, type, `recurring_interval`, active |
| `subscriptions` | Active/canceled subs | user_id, stripe_subscription_id, `price_id` (UUID FK to stripe_prices.id), status, tier_mapping, current_period_start/end, cancel_at_period_end |
| `stripe_customers` | Stripe-to-user mapping | user_id, stripe_customer_id, email |
| `payment_transactions` | Payment log | user_id, `stripe_payment_intent_id`, stripe_checkout_session_id, amount, currency, status, `customer_email` |
| `stripe_webhook_events` | Idempotency log | stripe_event_id, event_type, processed (boolean), payload, error |
| `provisioning_queue` | Post-purchase setup | user_id, trigger_event, trigger_id, steps (JSONB array), status, metadata |

### Column Name Gotchas

These differ from what you might expect based on Stripe naming:

- `stripe_products.active` is a **boolean**, not a status text field (there is a separate `status` column)
- `stripe_products.images` is an **array**, not `image_url`
- `stripe_prices.unit_amount`, not `amount`
- `stripe_prices.recurring_interval`, not `interval`
- `subscriptions.price_id` is a **UUID FK** to `stripe_prices.id`, not a text Stripe price ID
- `payment_transactions.customer_email` exists but there is **no description field**

### OPAI Supabase Profile Fields (Updated by Billing)

The webhook handler updates these columns on the OPAI `profiles` table:

| Column | Set When |
|--------|----------|
| `opai_access` | `true` on checkout complete, `false` on subscription deleted/revoked |
| `stripe_customer_id` | Set on checkout complete |
| `tier` | Set to tier_mapping on active sub, `"free"` on cancel/unpaid/revoke |

## Stripe Products (Live)

| Product | Price | Stripe Product ID | Tier Mapping |
|---------|-------|-------------------|-------------|
| OPAI Starter | $29/mo | `prod_TzjNusxln6Z9V7` | `starter` |
| OPAI Pro | $79/mo | `prod_TzjN4p2omLTqE6` | `pro` |
| OPAI Ultimate | $149/mo | `prod_TzjNdKTClYYVLT` | `ultimate` |

## API Routes

### Admin (`routes_api.py`, prefix `/api`) -- require_admin

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/dashboard` | Revenue overview: MRR, active subs, product count, recent transactions |
| GET | `/products` | List all products with grouped prices |
| POST | `/products` | Create product (Stripe + DB), optionally with initial price |
| PUT | `/products/{id}` | Update product (Stripe + DB) |
| DELETE | `/products/{id}` | Soft-delete: archive product (deactivate on Stripe, mark archived in DB) |
| POST | `/products/import` | Import all active products + prices from Stripe into DB |
| POST | `/products/{id}/push` | Push local product to Stripe (create or update) |
| POST | `/prices` | Create a price for a product (Stripe + DB) |
| GET | `/transactions` | Paginated transaction history (`?page=0&limit=25`) |

### Subscriptions (`routes_subscriptions.py`, prefix `/api`) -- require_admin

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/subscriptions` | List all subs with user display name + flattened price data |
| POST | `/subscriptions/{id}/cancel` | Cancel at period end (or immediately with `?immediate=true`) |
| POST | `/subscriptions/{id}/pause` | Pause collection (void behavior) |
| POST | `/subscriptions/{id}/resume` | Resume paused subscription |
| DELETE | `/subscriptions/{id}/revoke` | Cancel + deactivate user (`opai_access=false`, `tier=free`) |

### Webhooks (`routes_webhooks.py`, prefix `/api`) -- Stripe signature only, no OPAI auth

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/webhooks/stripe` | Stripe webhook receiver |

**Webhook endpoint**: `https://opai.boutabyte.com/billing/api/webhooks/stripe` (ID: `we_1T1jvqHoKo1t3CUKNNaP3qcO`)
> **Note**: The old URL was `/api/webhooks/stripe` (when BB VPS Traefik added the `/billing` prefix). Now all traffic proxies through OPAI Caddy, so the full `/billing/` prefix is needed in the Stripe dashboard URL.

**Handled events**:

| Event | Handler | Effect |
|-------|---------|--------|
| `checkout.session.completed` | `_handle_checkout_completed` | Create BB2.0 user, stripe_customers record, subscription record, update OPAI profile (opai_access, tier), queue provisioning |
| `invoice.payment_succeeded` | `_handle_payment_succeeded` | Log payment_transaction (succeeded) |
| `invoice.payment_failed` | `_handle_payment_failed` | Log payment_transaction (failed) |
| `customer.subscription.updated` | `_handle_subscription_updated` | Update sub status/period, update user tier (active -> tier_mapping, canceled/unpaid/past_due -> free) |
| `customer.subscription.deleted` | `_handle_subscription_deleted` | Mark sub canceled, set user opai_access=false + tier=free |
| `product.updated` | `_handle_product_updated` | Sync name/description/active from Stripe to DB |
| `price.updated` | `_handle_price_updated` | Sync unit_amount/active from Stripe to DB |

**Idempotency**: Each event is checked against `stripe_webhook_events` table before processing. Duplicate events return `{"status": "already_processed"}`.

### Public Checkout (`routes_checkout.py`, prefix `/api/checkout`) -- no auth

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/products` | List active products with prices (for landing page pricing grid) |
| POST | `/session` | Create Stripe Checkout Session, returns `{session_id, url}` |

Checkout sessions redirect to:
- **Success**: `https://opai.boutabyte.com/welcome?session_id={CHECKOUT_SESSION_ID}`
- **Cancel**: `https://opai.boutabyte.com/about#pricing`

## Auto-Provisioning Pipeline

After checkout completion, `provisioner.py` queues a 4-step provisioning task:

| Step | Status | Notes |
|------|--------|-------|
| `create_opai_profile` | Completed immediately | Profile created on first OPAI portal login |
| `provision_sandbox` | Queued for orchestrator | Requires server-side NFS/sandbox access |
| `provision_n8n` | Queued for orchestrator | **Admin/internal only** — not part of customer onboarding (n8n licensing restricts customer access). Requires BB VPS Docker access |
| `send_welcome_email` | Queued for n8n workflow | Sent via n8n automation |

Steps are stored as a JSONB array in `provisioning_queue.steps`. The orchestrator or manual admin action completes queued steps. Status flow: `pending` -> `in_progress` -> `completed` or `partial`.

## Configuration

| Env Var | Purpose | Target |
|---------|---------|--------|
| `SUPABASE_URL` | OPAI Supabase URL (auth) | `shared/auth.py` |
| `SUPABASE_ANON_KEY` | OPAI Supabase anon key | `shared/auth.py` |
| `SUPABASE_SERVICE_KEY` | OPAI Supabase service key | `shared/auth.py` |
| `SUPABASE_JWT_SECRET` | OPAI JWT secret (HS256 fallback) | `shared/auth.py` |
| `BB_SUPABASE_URL` | BB2.0 Supabase URL (billing data) | `config.py` -> `stripe_client.py` |
| `BB_SUPABASE_SERVICE_KEY` | BB2.0 Supabase service key | `config.py` -> `stripe_client.py` |
| `OPAI_SUPABASE_URL` | Same as SUPABASE_URL (for stripe_client.py OPAI helpers) | `config.py` |
| `OPAI_SUPABASE_SERVICE_KEY` | Same as SUPABASE_SERVICE_KEY | `config.py` |
| `STRIPE_SECRET_KEY` | Stripe API secret key | All Stripe operations |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | `routes_webhooks.py` |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key | Not used server-side (reserved for frontend) |
| `PUBLIC_SITE_URL` | Base URL for checkout redirects | `routes_checkout.py` |
| `OPAI_BILLING_HOST` | Bind address (default: `127.0.0.1`) | `config.py` |
| `OPAI_BILLING_PORT` | Port (default: `8094`) | `config.py` |

## Frontend

### Admin Dashboard (`static/`)

Vanilla JS SPA with 4 tabs, admin-only (requires `requireAdmin: true` via `opaiAuth.init()`).

| Tab | Data Source | Content |
|-----|------------|---------|
| **Dashboard** | `GET /api/dashboard` | MRR stat card, active subs count, product count, recent transactions table |
| **Products** | `GET /api/products` | Product cards with tier badge, price, sync status, Edit/Push/Archive actions |
| **Subscriptions** | `GET /api/subscriptions` | Table with user, plan, status, amount, period end, Cancel/Pause/Resume/Revoke actions |
| **Transactions** | `GET /api/transactions` | Paginated table with date, customer, payment intent, amount, status |

Product modal supports create (with price) and edit. Import from Stripe button bulk-imports existing Stripe products.

### Frontend Auth Pattern

**Important gotcha**: `auth-v3.js` declares `const opaiAuth` in the global lexical scope, NOT on `window`. Access it directly as `opaiAuth`, never as `window.opaiAuth`.

Initialization sequence in `app.js`:
1. Fetch `/auth/config` to get Supabase URL + anon key
2. Set `window.OPAI_SUPABASE_URL` and `window.OPAI_SUPABASE_ANON_KEY`
3. Wait for `opaiAuth` to be defined (polling, max 5s)
4. Call `opaiAuth.init({ requireAdmin: true })` -- handles login redirect
5. Get token via `opaiAuth.getToken()` for API calls

The `app.js` script must NOT be wrapped in an IIFE -- it needs access to the global lexical scope where `opaiAuth` lives. Use `defer` attribute on the script tag.

### Public Landing Site (`public-site/`)

Static site served at `https://opai.boutabyte.com/about` with:
- **Landing page** (`index.html`): Hero, features grid, pricing cards (3 tiers) — served at `/about`
- **Welcome page** (`welcome.html`): Post-purchase onboarding — served at `/welcome`

The pricing grid loads dynamically from `GET /api/checkout/products`. If the API is unavailable, static HTML fallback prices are shown. Clicking a tier button creates a Stripe Checkout Session via `POST /api/checkout/session` and redirects to Stripe.

Deploy via: `./deploy/deploy-bb-vps.sh [host]` (SSH as dallas to BB VPS, copies files to `/var/www/opai-landing/`).

## Service Management

```bash
# systemd
systemctl --user status opai-billing
systemctl --user restart opai-billing
journalctl --user -u opai-billing -f

# via opai-control
./scripts/opai-control.sh status
./scripts/opai-control.sh restart billing
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `fastapi` | Web framework |
| `uvicorn` | ASGI server |
| `httpx` | HTTP client (Supabase REST API calls) |
| `stripe` | Stripe Python SDK (products, prices, checkout, webhooks) |
| `python-dotenv` | `.env` loading |
| `python-jose` | JWT decoding (shared auth) |
| `pydantic` | Request/response models |

## Known Issues / Gotchas

- **Dual-Supabase confusion**: `config.py` maps `BB_SUPABASE_*` env vars to `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` internally (for `stripe_client.py`), while `shared/auth.py` reads the standard `SUPABASE_*` env vars (which point to OPAI). The `.env` file has both sets.
- **`opaiAuth` is lexical, not on `window`**: `auth-v3.js` uses `const opaiAuth` -- never reference `window.opaiAuth`. The admin dashboard `app.js` must not be wrapped in an IIFE for this reason.
- **Webhook URL changed**: BB VPS now proxies all traffic directly to OPAI Caddy (no Traefik path rewrite). The Stripe webhook URL must be `https://opai.boutabyte.com/billing/api/webhooks/stripe` (the full path as seen by OPAI Caddy).
- **`subscriptions.price_id` is a UUID**: It references `stripe_prices.id` (the DB primary key), NOT the Stripe price ID string. The webhook handler looks up `stripe_prices` by `stripe_price_id` to find the correct UUID.
- **Soft delete for products**: `DELETE /products/{id}` does NOT delete -- it sets `active=false` and `status=archived` in DB, and deactivates on Stripe.
- **MRR calculation**: Dashboard computes MRR by summing `unit_amount` of all active subscriptions (dividing yearly by 12). Returns 0 on any error rather than failing.
- **CORS limited**: Only `https://opai.boutabyte.com` and `http://localhost:3000` are allowed origins. Only GET and POST methods.
- **Provisioning is queue-only**: `provisioner.py` queues tasks but only completes `create_opai_profile` automatically. The other steps (sandbox, welcome email) require orchestrator or manual intervention. The `provision_n8n` step is admin/internal-only and is not executed for customer onboarding.

## Cross-References

- [Auth & Network](auth-network.md) -- JWT validation via shared/auth.py, Caddy proxy
- [Portal](portal.md) -- Navigation includes billing link; profiles table updated by webhooks
- [Marketplace](marketplace.md) -- Tier-based access controlled by billing tier
- [Orchestrator](orchestrator.md) -- Processes provisioning_queue tasks
- [Sandbox System](sandbox-system.md) -- Sandbox provisioning queued by billing
- [Services & systemd](services-systemd.md) -- Service unit management
- [Shared Navbar](navbar.md) -- Injected navigation bar on admin dashboard
- [User Controls](user-controls.md) -- User profiles updated with tier/opai_access by webhook
