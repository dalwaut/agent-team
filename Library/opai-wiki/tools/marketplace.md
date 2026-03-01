# OPAI Marketplace
> Last updated: 2026-02-20 | Source: `tools/opai-marketplace/`

BoutaByte product catalog integration with n8n user provisioning.

> **Internal Only**: n8n access is restricted to internal team members (employees, admins) due to licensing. n8n is NOT offered to paying customers as a feature.

## Overview

The Marketplace service surfaces BoutaByte.com products (webapps, automations, plugins, mobile apps) as a browsable embedded catalog inside OPAI. Admins control access via tier-based filtering and per-user product grants. It also handles n8n account provisioning so OPAI users can access automation workflows on n8n.boutabyte.com.

## Architecture

```
BoutaByte Supabase (aggxspqzerfimqzkjgct)
    ├── sub_apps → webapp
    ├── n8n_automations → automation
    ├── wp_plugins → plugin
    └── mobile_apps → mobile
            │
            ▼  INSERT/UPDATE/DELETE triggers (pg_net)
n8n Workflow on BoutaByte VPS (bb-vps)
    "OPAI Marketplace Sync Trigger" (id: RReCJByY8YO9oUrb)
            │
            ▼  POST via Tailscale (100.72.206.23)
OPAI Marketplace (/marketplace/api/sync/webhook)
            │
            ▼  re-fetch all products from BB2.0
OPAI Supabase (idorgloobxkmlnwnxbej)
    └── marketplace_products (cached catalog)
            │
            ▼  filtered by tier + grants
    Marketplace UI (/marketplace/)
```

**Sync is event-driven, not polling.** DB triggers on BB2.0 fire on every table change → pg_net HTTP → n8n webhook → OPAI sync. A startup sync also runs once when the service starts.

**n8n Provisioning (new account):**
```
Admin clicks "Provision New" in User Controls
    → POST /marketplace/api/n8n/provision
    → Fetch user email from Supabase auth
    → Generate random password + bcrypt hash
    → SSH into bb-vps, sqlite3 INSERT into n8n user table
    → Update OPAI profile (n8n_provisioned=true)
    → Return one-time password to admin
```

**n8n Linking (existing account):**
```
Admin selects account from dropdown → clicks "Link"
    → POST /marketplace/api/n8n/link {user_id, n8n_email}
    → Update OPAI profile (n8n_provisioned=true, n8n_username=email)
    → No SSH needed — just a Supabase profile update

Bulk: "Sync n8n" header button
    → POST /marketplace/api/n8n/sync-all
    → SSH list all n8n users → match OPAI users by email → bulk link
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-marketplace/app.py` | FastAPI app, health endpoint, startup sync |
| `tools/opai-marketplace/config.py` | Port 8092, env vars, tier hierarchy |
| `tools/opai-marketplace/routes_api.py` | Product listing, sync webhook, n8n provisioning/linking, BB association |
| `tools/opai-marketplace/sync_products.py` | BoutaByte catalog → OPAI cache sync |
| `tools/opai-marketplace/n8n_provisioner.py` | n8n user management: SSH-based provisioning, account listing, profile linking/unlinking |
| `tools/opai-marketplace/static/` | Browse UI (index.html, style.css, js/app.js) |
| `config/supabase-migrations/010_marketplace_and_n8n.sql` | DB migration |
| `config/service-templates/opai-marketplace.service` | systemd unit |

## Configuration

**Environment Variables (`.env`):**
| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | OPAI Supabase URL |
| `SUPABASE_ANON_KEY` | OPAI Supabase anon key |
| `SUPABASE_SERVICE_KEY` | OPAI Supabase service key |
| `SUPABASE_JWT_SECRET` | JWT validation |
| `BB_SUPABASE_URL` | BoutaByte Supabase URL (aggxspqzerfimqzkjgct) |
| `BB_SUPABASE_SERVICE_KEY` | BoutaByte Supabase service key |
| `N8N_SSH_HOST` | Hostinger VPS IP (72.60.115.74) |
| `N8N_SSH_USER` | SSH user (root) |
| `N8N_SSH_PASSWORD` | SSH password |
| `N8N_SQLITE_PATH` | Path to n8n SQLite DB inside Docker volume |
| `SYNC_WEBHOOK_SECRET` | HMAC secret for webhook endpoint |

## Event-Driven Sync Chain

The catalog stays in sync without polling:

1. **BB2.0 Supabase trigger** — `notify_opai_marketplace()` function fires on INSERT/UPDATE/DELETE on all 4 catalog tables
2. **pg_net HTTP POST** — Sends `{table, type, timestamp}` to `https://n8n.boutabyte.com/webhook/opai-marketplace-sync`
3. **n8n workflow** — "OPAI Marketplace Sync Trigger" (id: `RReCJByY8YO9oUrb`) forwards to OPAI via Tailscale
4. **OPAI webhook** — `POST /marketplace/api/sync/webhook` (authenticated via `x-webhook-secret` header) triggers full catalog re-sync
5. **Startup sync** — One initial sync when the service starts, to catch any changes while offline

**Manual sync**: Admins can still trigger `POST /marketplace/api/products/sync` for immediate refresh.

## n8n VPS Details

| Item | Value |
|------|-------|
| VPS IP | 72.60.115.74 |
| Tailscale hostname | `bb-vps` (100.106.200.68) |
| n8n URL | https://n8n.boutabyte.com |
| n8n DB | SQLite at `/var/lib/docker/volumes/c0g0wk48okcos04c0k4cokkw_n8n-data/_data/database.sqlite` |
| Container | `n8n-c0g0wk48okcos04c0k4cokkw` (n8nio/n8n:latest) |
| Provisioning | SSH + sqlite3 on host (sqlite3 installed on VPS) |
| Existing users | dallas@wautersedge.com (owner), denise@wautersedge.com (member) |

## Database Schema

**Profile extensions (on `profiles` table):**
- `marketplace_tier` — free/starter/pro/unlimited
- `n8n_provisioned` — boolean
- `n8n_username` — n8n login email
- `n8n_provisioned_at` — timestamp

**`marketplace_products` table:**
- Cached catalog from BoutaByte, keyed by `bb_id`
- `product_type`: webapp, automation, plugin, mobile
- `tier_requirement`: minimum tier to see the product
- RLS: all authenticated users read active products; admins manage

**`marketplace_user_access` table:**
- Per-user product overrides (grants individual access regardless of tier)
- RLS: users see own grants; admins manage all

## API Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/products` | User | List products (tier-filtered) |
| GET | `/api/products/{slug}` | User | Product detail |
| POST | `/api/products/sync` | Admin | Trigger manual catalog sync |
| POST | `/api/sync/webhook` | Secret | Event-driven sync from BB2.0 |
| POST | `/api/products/{id}/toggle` | Admin | Enable/disable product |
| GET | `/api/admin/products` | Admin | Full catalog |
| POST | `/api/admin/user-access` | Admin | Grant product access |
| DELETE | `/api/admin/user-access` | Admin | Revoke product access |
| PUT | `/api/admin/user-tier/{user_id}` | Admin | Set user's tier |
| GET | `/api/n8n/status` | User | Own n8n status |
| POST | `/api/n8n/provision` | Admin | Create n8n account |
| POST | `/api/n8n/provision-bulk` | Admin | Bulk provision |
| GET | `/api/n8n/accounts` | Admin | List all n8n users from VPS SQLite (cached 60s) |
| GET | `/api/n8n/lookup?email=X` | Admin | Find specific n8n account by email |
| POST | `/api/n8n/link` | Admin | Link OPAI user to existing n8n account (or unlink if empty email) |
| POST | `/api/n8n/sync-all` | Admin | Auto-link all OPAI users to n8n by email match |

## BoutaByte User Association + Tier Sync

OPAI users can be linked to their BoutaByte accounts. Once linked, tier levels are synced from BB2.0 profiles so admins manage tiers in one place.

### BB Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/bb/lookup?email=...` | Admin | Search BB2.0 auth users by email, return BB profile info (id, display_name, tier) |
| POST | `/api/bb/link` | Admin | Link OPAI user to BB user (body: `{user_id, bb_user_id}`), syncs tier from BB profile |
| POST | `/api/bb/sync-all` | Admin | Auto-link all OPAI users by email match, sync tiers. Returns `{linked_count, skipped_count, failed_count}` |

### Tier Mapping

| BoutaByte Tier | OPAI Tier |
|----------------|-----------|
| free | free |
| starter | starter |
| pro | pro |
| ultimate | unlimited |

All tiers map directly except BB "ultimate" which maps to OPAI "unlimited".

### Configuration

Uses the existing BB2.0 Supabase connection:
- `BB_SUPABASE_URL` — BoutaByte Supabase URL (project `aggxspqzerfimqzkjgct`)
- `BB_SUPABASE_SERVICE_KEY` — BoutaByte Supabase service key

Both are already configured in `tools/opai-marketplace/config.py`.

### Database

Two columns added to the `profiles` table:
- `bb_user_id` (UUID) — linked BoutaByte user ID
- `bb_linked_at` (TIMESTAMPTZ) — when the link was established

Migration: `config/supabase-migrations/011_bb_user_link.sql`

### Frontend Integration

See [User Controls](user-controls.md) — the Edit User modal has a "BoutaByte Account" section with link/sync buttons. When linked, the marketplace tier dropdown becomes read-only (synced from BB). A bulk "Sync BB" button in the header runs `/api/bb/sync-all`.

## Tier Hierarchy

Products are visible to users at or above the tier requirement:
- **free** (0) — everyone sees these
- **starter** (1) — starter, pro, unlimited users
- **pro** (2) — pro, unlimited users
- **unlimited** (3) — unlimited users only

Individual grants via `marketplace_user_access` override tier filtering.

## Product Detail Modal

When users click a product card in the marketplace grid, a detail modal overlay opens instead of navigating externally. The modal displays comprehensive product information including name, icon, badges, tags, full description, and screenshots. Each product type has specialized action buttons and metadata display.

### Modal UI Components

- **Header:** Product name, icon, type badge (webapp/automation/plugin/mobile), tier badge (free/starter/pro/unlimited)
- **Metadata:** Tags (parsed from `metadata` JSON string), category
- **Description:** Full text (not truncated like cards)
- **Screenshots:** Horizontal scrollable strip; clicking any screenshot opens full-size in new tab
- **Type-Specific Section:** Action buttons and metadata rendered per product type (see below)
- **Response Area (Automations only):** Shows webhook call results with formatted JSON/text output

### Per-Type Behavior

**WebApps** (`product_type = 'webapp'`):
- "Open App" button → navigates to `{BB_PLATFORM_URL}{metadata.app_url}` in new tab (e.g., `https://boutabyte.com/apps/boutachat`)
- Demo mode indicator shown if `metadata.demo_mode = true`
- GitHub link displayed if `metadata.github_repo` exists
- Screenshots sourced from `metadata.screenshots[]`

**Automations** (`product_type = 'automation'`):
- Functional input form rendered from `metadata.Input_Schema`
- Input schema contains triggers with `input_fields` array; each field has: `field_name`, `field_label`, `field_type`, `placeholder`, `required`, `description`
- Form fields include labels, placeholders, and required indicators (marked in red if empty on submit)
- "Run Automation" button collects all form values and POSTs JSON to the n8n webhook URL
- Webhook URL preference: uses `metadata.Webhook_Trigger_URL` if available, falls back to `metadata.Form_Trigger_URL`
- POST payload format: `{"field_name_1": "value", "field_name_2": "value"}` sent as `application/json`
- Response display: green background for success (200-299), red for errors; shows formatted JSON if parseable, raw text otherwise
- Workflow ID displayed from `metadata.Workflow_ID`
- Validation: required fields checked before submission; form highlighted if validation fails

**Plugins** (`product_type = 'plugin'`):
- "Download Plugin" button → downloads from BB Supabase storage: `{BB_SUPABASE_URL}/storage/v1/object/public/plugins/{metadata.file_path}`
- Metadata displayed: version, author (linked to `metadata.author_url` if provided), file size, download count, license requirement

**Mobile** (`product_type = 'mobile'`):
- Platform-specific buttons: App Store, Play Store, Expo Link, Download (sourced from `metadata.app_store_url`, `metadata.play_store_url`, `metadata.expo_url`, `metadata.download_url`)
- Auto-generated QR code via `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data={url}` pointing to first available install link
- "Scan to install" label under QR code
- Buttons only shown if corresponding URL exists in metadata

### Configuration

**New environment variable in `config.py`:**
- `BB_PLATFORM_URL` — Base URL for BoutaByte webapp links (default: `https://boutabyte.com`)

**API response:** The `/api/auth/config` endpoint now returns two additional fields:
- `bb_platform_url` — Used by frontend to construct app URLs
- `bb_supabase_url` — Used by frontend to construct plugin download URLs

### Implementation Details

**Key files modified:**
| File | Change |
|------|--------|
| `tools/opai-marketplace/config.py` | Added `BB_PLATFORM_URL` env var with default `https://boutabyte.com` |
| `tools/opai-marketplace/routes_api.py` | Updated `/api/auth/config` endpoint to return `bb_platform_url` and `bb_supabase_url` |
| `tools/opai-marketplace/static/index.html` | Added product detail modal overlay HTML template |
| `tools/opai-marketplace/static/js/app.js` | Added `openProductDetail()` function to open modal with product data, `runAutomation()` to POST webhook requests, form rendering logic for automation inputs |
| `tools/opai-marketplace/static/style.css` | Modal overlay styles, detail panel layout, automation form styling, response area styling (success/error states) |

### Modal Lifecycle

1. User clicks product card in grid
2. `openProductDetail(product)` called with product object
3. Modal content populated from product data and metadata
4. Modal overlay displayed (visible, opaque background)
5. For automations: input form rendered, ready to accept user input
6. User interacts: views screenshots, clicks action buttons, or (for automations) enters form data and clicks "Run Automation"
7. Webhook requests POST to n8n and display response
8. User closes modal via close button or background click

## Admin Integration

**User Controls (edit modal):**
- Marketplace Tier dropdown (free/starter/pro/unlimited)
- n8n Account: status badge, dropdown of existing accounts + "Link" button, "Provision New" button, "Unlink" button
- One-time password display after provisioning
- "Sync n8n" header button for bulk email-match linking

**Invite flow:**
- `marketplace_tier` field on InviteRequest
- `provision_n8n` boolean to auto-create n8n account during invite

## Dependencies

- OPAI Supabase (main database)
- BoutaByte Supabase (source catalog — BB2.0)
- Hostinger VPS (n8n + Tailscale — `bb-vps`)
- Shared auth module (`tools/shared/auth.py`)
- bcrypt (n8n password hashing)
- paramiko (SSH to VPS for n8n provisioning)
