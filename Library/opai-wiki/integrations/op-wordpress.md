# OP WordPress — Multi-Site WordPress Management
> Last updated: 2026-02-24 | Source: `tools/opai-wordpress/`

**Status**: v1.5.1 | **Port**: 8096 | **Path**: `/wordpress/` | **Connector**: v1.4.0
**Service**: `opai-wordpress` | **Source**: `tools/opai-wordpress/`

## Overview

OP WordPress is a ManageWP replacement that manages multiple WordPress sites from a single dashboard. It wraps the existing `tools/wp-agent/` library (70+ actions across 10 agents) and adds multi-site orchestration, WooCommerce support, and an AI assistant.

Key capabilities: multi-strategy connector deployment, **Push OP** (force-push connector plugin updates to all sites), self-healing connection retry agent, per-site method pinning, WooCommerce REST API integration, AI-assisted management via Claude CLI, Push OP run logging to the OPAI Task Control Panel.

## Architecture

```
Browser → Caddy (/wordpress/*) → FastAPI (port 8096) → wp-agent library → WP REST API
                                       ↕                                       ↕
                                  Supabase (site credentials,           OPAI Connector
                                    user access, connection logs)       (on WP site)
                                       ↕
                                  Claude CLI (AI assistant)
```

### Background Services (3 async tasks started at boot)

| Task | Interval | Purpose |
|------|----------|---------|
| `background_checker` | 30 min | Scans all sites for available updates using strategy chain |
| `scheduler_loop` | 60 sec | Processes scheduled automation tasks |
| `connection_agent_loop` | 10 min | Self-healing retry agent for failed/broken connections |

## Key Files

| File | Purpose |
|------|---------|
| `app.py` | FastAPI app, health endpoint, static mount, 3 background tasks |
| `config.py` | Port 8096, Supabase config, paths, agent intervals |
| `auth.py` | Supabase JWT auth middleware |
| `routes_sites.py` | Site CRUD, connector install/status, **Push OP** (`/api/connector/push-all`) |
| `routes_updates.py` | Plugin/theme/core update management, aggregated dashboard |
| `routes_content.py` | Posts, pages, media proxy via wp-agent |
| `routes_woo.py` | WooCommerce products, orders, customers |
| `routes_management.py` | Users, comments, settings, plugins, themes (+ upload), menus, taxonomies |
| `routes_avada.py` | Envato Theme Manager — per-user API key CRUD (Supabase), version check, pull, deploy |
| `routes_ai.py` | AI assistant (plan/execute pattern, chat, templates) |
| `routes_automation.py` | Scheduled tasks and automation |
| `services/update_checker.py` | Multi-strategy update scanner with per-site method pinning |
| `services/deployer.py` | Multi-strategy connector deployment engine + `push_update_connector()` |
| `services/task_logger.py` | Push OP audit logger — writes system-tier audit records via shared `audit.py` helper (79 lines) |
| `services/connection_agent.py` | Self-healing background retry agent |
| `services/scheduler.py` | Automation task scheduler |
| `services/site_manager.py` | Multi-site orchestrator pool (wraps wp-agent) |
| `services/woo_client.py` | WooCommerce REST API v3 client |
| `services/ai_assistant.py` | Claude CLI integration for WP tasks |
| `wp-plugin/opai-connector/` | WordPress plugin installed on managed sites |
| `data/avada.json` | Server-side cache only: `cached_version`. Keys no longer stored here. |
| `data/avada-latest.zip` | Most recently pulled Avada theme ZIP (ready to deploy, shared across users) |

## Multi-Strategy Connection System

The core innovation: every connection operation (deploying the connector, checking updates) uses a **strategy chain** with per-site method pinning. When a strategy works, it's "pinned" in the site's `capabilities` JSONB. On subsequent runs, the pinned method is tried first. If it fails, the pin is cleared and the full chain retries.

### Deploy Strategies (`services/deployer.py`)

Tried in order when installing the OPAI Connector plugin:

| # | Strategy | How It Works | Requires |
|---|----------|-------------|----------|
| 1 | `rest_api` | Check if plugin already exists, activate + setup | `app_password` |
| 2 | `admin_upload` | Login to wp-admin, upload ZIP via plugin-install.php (with overwrite confirmation handling) | `admin_password` |
| 3 | `file_manager` | Use WP File Manager plugin's elFinder AJAX API | `admin_password` + File Manager plugin |
| 4 | `manual` | Returns download URL for manual install (fallback) | — |

Pinned in `capabilities.deploy_method`. Cleared and retried if pinned method fails.

**Admin upload nuances** (fixed in v1.4.0, updated for WP 6.9 in v1.5.0):
- Tries two upload URL candidates in order: `wp-admin/update.php?action=upload-plugin` first, then `wp-admin/plugin-install.php?action=upload-plugin` if the first returns 404/403 (some hosts block `update.php` from external IPs)
- Detects "replace existing?" confirmation page (WP shows this when plugin is already installed) by scanning response HTML for `overwrite` or `already installed`:
  - **WP 6.9+**: Extracts `<a href>` link with overwrite query params, follows via GET
  - **WP < 6.9**: Extracts hidden form inputs (`package` path), submits via POST
- Post-upload verification uses a **fresh httpx client** (no wp-admin cookies) for REST API calls, avoiding cookie/Basic Auth conflicts
- `_push_via_rest_api()` is a documented **no-op** — `POST /wp/v2/plugins` is the wp.org slug installer, not a ZIP upload endpoint. Sites pinned to `rest_api` fall through to `admin_upload`

### Push OP (`push_update_connector`)

Force-push the latest OPAI Connector plugin ZIP to all connected sites. Distinct from initial install: always uploads the current ZIP regardless of current version.

```python
# services/deployer.py
OPAI_CONNECTOR_VERSION_STR = "1.4.0"  # updated when plugin version bumps

async def push_update_connector(site: dict) -> dict:
    # Returns {"status": "success"|"manual", "method": ..., "reason": ...}
```

**Push strategy order**: uses the site's `pinned deploy_method` first, then full fallback chain (`admin_upload → file_manager → rest_api`). On all strategies failing, stores failure state in `capabilities` (see below) and returns `{"status": "manual"}`.

**Failure state stored in `capabilities` JSONB**:
```json
{
  "push_status": "manual_required",
  "push_reason": "host_blocks_upload",
  "push_failure_detail": "update.php 404, plugin-install.php 404",
  "push_version_needed": "1.2.0"
}
```

**`push_reason` values**:
- `host_blocks_upload` — both upload URLs returned 404/403 (host IP-restricts wp-admin)
- `no_credentials` — no `admin_password` stored for this site
- `upload_failed` — upload succeeded but plugin not detected after upload
- `error` — unexpected exception during push

### Data Strategies (`services/update_checker.py`)

Tried in order when checking for available updates:

| # | Strategy | How It Works | Requires |
|---|----------|-------------|----------|
| 1 | `connector_refresh` | `/opai/v1/updates/check` — forces WP transient refresh | Connector installed |
| 2 | `connector_cached` | `/opai/v1/updates/check?refresh=0` — reads cached transients | Connector installed |
| 3 | `rest_api` | `/wp/v2/plugins?context=edit` + `/wp/v2/themes?context=edit` | `app_password` only |

Pinned in `capabilities.data_method`. The `connector_refresh` strategy is most accurate because it forces WordPress to re-scan for updates.

### Connection Retry Agent (`services/connection_agent.py`)

Self-healing background agent that detects broken connections and automatically retries.

**Runs every 10 minutes** (30-second initial delay). For each site needing attention, tries one strategy per cycle (round-robin through all 6 strategies: 3 deploy + 3 data). A full chain rotation takes ~60 minutes.

**Site selection criteria** (any of):
- `status = 'offline'` or `'degraded'`
- `capabilities.retry_active = true` (ongoing retry cycle)
- `connector_installed = false` AND credentials exist to try
- `last_check` older than 2 hours with 0 updates (suspiciously stale)

**Retry state** (stored in `capabilities` JSONB):
```json
{
  "retry_active": true,
  "retry_count": 12,
  "retry_started": "2026-02-19T10:00:00Z",
  "last_retry": "2026-02-19T12:00:00Z",
  "last_hitl_at_count": 10,
  "strategies_tried": ["deploy:rest_api", "deploy:admin_upload"]
}
```

**HITL integration** — after every 5 failed attempts:
- Writes HIGH entry to `notes/Improvements/Feedback-WordPress.md`
- Appends to `notes/Improvements/FEEDBACK-IMPROVEMENTS-LOG.md`
- Continues retrying (never stops — 5 → HITL → 5 → HITL → ...)

**On success after failures**:
- Clears retry state in capabilities
- Writes RESOLVED entry to feedback file
- Broadcasts `system_update` via Supabase Realtime

**Config constants** (`config.py`):
```python
CONNECTION_AGENT_INTERVAL = 10 * 60  # 10 minutes
CONNECTION_AGENT_BATCH_SIZE = 5      # attempts before HITL report
```

## Scheduler Health Check System

The scheduler (`services/scheduler.py`) includes a 3-pronged health check used both as a standalone scheduled task type and as post-update verification.

### 3-Pronged Health Check (`_health_check`)

Each check probes three independent signals. A site is considered **healthy if at least 2 of 3 pass** (not all-or-nothing):

| # | Probe | What It Checks | Pass Condition |
|---|-------|----------------|----------------|
| 1 | `connector_health` | OPAI Connector `/health` endpoint | HTTP 200 + `{"status": "healthy"}` |
| 2 | `homepage_http` | Site homepage GET (follows redirects) | HTTP status < 400 |
| 3 | `wp_rest_api` | WP REST API root (`/wp-json`) | HTTP status < 400 |

**Return value**: `(healthy: bool, steps: list[dict])` where each step has `name`, `status` (`"pass"` or `"fail"`), and `detail`.

**Timeout**: All probes use `config.HEALTH_CHECK_TIMEOUT` (configurable).

### How Health Checks Are Used

1. **Scheduled `health_check` task type**: Run on a cron schedule to monitor site availability
2. **Post-update verification**: After applying plugin/theme/core updates, automatically verifies the site is still healthy
3. **Auto-rollback trigger**: If the post-update health check fails and `auto_rollback` is enabled on the schedule, the scheduler restores the pre-backup and logs the execution as `"rolled_back"`

### Scheduler Loop

The main `scheduler_loop()` runs as a background async task with a configurable tick interval (default from `config.SCHEDULER_INTERVAL`, adjustable at runtime via `set_scheduler_settings()`):

- **Tick interval**: Configurable between 10 and 3600 seconds (clamped)
- **Pause/resume**: Admin can pause the scheduler via `PUT /api/scheduler/settings {paused: true}`
- **Per-site lock**: `_running_sites` set prevents overlapping executions for the same site
- **Concurrent execution**: Multiple due schedules run concurrently via `asyncio.gather()`
- **Audit logging**: Each completed scheduled task writes an `execution`-tier audit record via `log_audit()`

## OPAI Connector Plugin (v1.4.0)

A lightweight WordPress plugin installed on each managed site. Provides accurate update detection (forces WP transient refresh), backup management with real-time progress tracking and tar streaming for ZipArchive-less hosts, health monitoring, and theme/plugin management via custom REST endpoints.

### Plugin Files

| File | Purpose |
|------|---------|
| `opai-connector.php` | Main plugin file — REST routes, admin UI, activation hook |
| `includes/class-auth.php` | Auth: X-OPAI-Key header or WP Basic Auth |
| `includes/class-health.php` | Health check (DB, disk, PHP, plugins count) |
| `includes/class-updater.php` | Update detection and apply (plugins, themes, core) |
| `includes/class-backup.php` | Complete site backup (wp-admin + wp-includes + wp-content + root PHP), chunked download streaming, progress tracking, DB dump streaming, tar file streaming |

### Plugin REST Endpoints (on managed WP site)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/opai/v1/health` | GET | Site health: DB, disk, PHP version, plugin count |
| `/opai/v1/updates/check` | GET | Available updates (`?refresh=0` for cached only) |
| `/opai/v1/updates/apply` | POST | Apply plugin/theme/core updates |
| `/opai/v1/setup` | POST | Get/generate connector key (idempotent) |
| `/opai/v1/themes/upload` | POST | Upload and install a theme ZIP (multipart) |
| `/opai/v1/themes/{stylesheet}/delete` | POST | Delete a theme by stylesheet name (uses `delete_theme()`) |
| `/opai/v1/backup/create` | POST | Create complete backup with progress tracking (requires ZipArchive) |
| `/opai/v1/backup/create-async` | POST | Schedule backup via WP-Cron (returns immediately, poll status) |
| `/opai/v1/backup/dump-db` | GET | Stream raw SQL database dump (no temp file, no ZIP) |
| `/opai/v1/backup/stream-tar` | GET | Stream all WordPress files as POSIX tar archive (no ZipArchive needed) |
| `/opai/v1/backup/list` | GET | List available backups |
| `/opai/v1/backup/restore` | POST | Restore from backup |
| `/opai/v1/backup/download/{id}` | GET | Download backup archive (chunked streaming) |
| `/opai/v1/backup/status/{id}` | GET | Real-time backup creation progress (reads ephemeral progress file; `id=latest` for most recent) |

**Theme delete** (added v1.2.0): Uses `POST` (not `DELETE`) because WP REST has no DELETE /themes route. Blocks deletion of the active theme (returns 400). Calls WordPress core `delete_theme($stylesheet)`. Backend `DELETE /api/sites/{id}/themes/{slug}` calls this connector endpoint.

### Plugin Admin UI

- **Settings page**: WP Admin > Settings > OPAI Connector — displays connection key with copy button, version, status, regenerate key option
- **Admin notice**: Info bar on Plugins page showing the connection key
- **Plugin action link**: "Connection Key" quick link on Plugins list page
- **Activation**: Auto-generates connection key on first activation

### Connecting a Site with the Connector

1. Download ZIP from OP WordPress (`/wordpress/api/connector/download`)
2. Upload & activate in WP Admin > Plugins > Add New > Upload
3. Go to **Settings > OPAI Connector** — copy the connection key
4. In OP WordPress, open **Site Settings** > paste key into **Connector Key** field > Save
5. Backend auto-marks `connector_installed = true`

### Auth Strategy

The backend communicates with the connector using **Basic Auth only** (WP Application Password). The `X-OPAI-Key` header is NOT sent from the backend because:
- Stale keys cause 403 (connector rejects mismatched keys without falling through to Basic Auth)
- Basic Auth with Application Password always works for admin users

The connector key stored in `connector_secret` is used for identification/verification, not as the primary auth mechanism.

### Updater Internals

The `class-updater.php` check method:
1. Loads `wp-admin/includes/plugin.php` and `wp-admin/includes/update.php` (required for REST API context)
2. Optionally calls `wp_update_plugins()`, `wp_update_themes()`, `wp_version_check()` to refresh transients
3. Registers a shutdown handler to return stale transient data if a PHP fatal occurs during refresh
4. Reads `get_site_transient('update_plugins')` and `get_site_transient('update_themes')` for actual data
5. Returns structured JSON with plugin/theme/core update arrays + refresh status

## Supabase

### Table: `wp_sites`

Stores connected WordPress sites with credentials and health info. RLS enforces user-scoped access.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `user_id` | UUID | Owner (references auth.users) |
| `name` | TEXT | Display name |
| `url` | TEXT | Site URL |
| `api_base` | TEXT | API base path (default `/wp-json`) |
| `username` | TEXT | WP username |
| `app_password` | TEXT | WP application password |
| `admin_password` | TEXT | WP login password (for auto-login, auto-install) |
| `connector_installed` | BOOLEAN | OPAI Connector plugin active on site |
| `connector_secret` | TEXT | Connection key (generated by plugin, stored here) |
| `capabilities` | JSONB | Per-site method pins, retry state, host feature flags |
| `is_woocommerce` | BOOLEAN | Has WooCommerce |
| `woo_key` / `woo_secret` | TEXT | WC consumer key/secret |
| `backup_folder` | TEXT | Local backup subfolder name (e.g. `"WautersEdge"`) |
| `status` | TEXT | healthy, degraded, offline, unknown |
| `wp_version` | TEXT | Detected WordPress version |
| `theme` | TEXT | Active theme name |
| `plugins_total` | INT | Total plugin count |
| `plugins_updates` | INT | Plugins with available updates |
| `themes_updates` | INT | Themes with available updates |
| `core_update` | BOOLEAN | Core update available |
| `last_check` | TIMESTAMPTZ | Last update check time |

### Table: `wp_envato_keys`

Stores Envato Personal Tokens per user. Keys are isolated — each user only sees their own keys, admins see all.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `user_id` | UUID | Owner (references auth.users, CASCADE delete) |
| `label` | TEXT | Human-readable label (e.g. "My Envato Account") |
| `token` | TEXT | Full Envato Personal Token (plaintext, server-side only — never returned to client) |
| `created_at` | TIMESTAMPTZ | When the key was added |

**RLS policies**:
- `Users manage own keys` — `auth.uid() = user_id` (full CRUD for owner)
- `Admins manage all keys` — `get_my_role() = 'admin'` (full CRUD for admins)

**API behaviour**: `GET /api/avada/config` returns keys with the token masked (`XXXXXX...last4`). The raw token is never sent to the browser.

### Table: `wp_connection_log`

Stores every connection retry attempt with full diagnostic detail. Used by the connection retry agent.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `site_id` | UUID | FK to `wp_sites(id)`, CASCADE delete |
| `attempt_number` | INT | Sequential attempt number for this site |
| `strategy` | TEXT | e.g. `deploy:rest_api`, `data:connector_refresh` |
| `success` | BOOLEAN | Whether this attempt succeeded |
| `error_detail` | TEXT | Error message if failed |
| `response_code` | INT | HTTP status code if applicable |
| `duration_ms` | INT | How long the attempt took |
| `created_at` | TIMESTAMPTZ | Timestamp |

**Index**: `idx_connection_log_site` on `(site_id, created_at DESC)`
**RLS**: Service role only (internal background agent)

### Capabilities JSONB Schema

The `capabilities` column on `wp_sites` stores per-site state:

```json
{
  "deploy_method": "admin_upload",
  "data_method": "connector_refresh",
  "admin_accessible": true,
  "has_file_manager": false,
  "last_failure_log": null,
  "retry_active": false,
  "retry_count": 0,
  "retry_started": null,
  "last_retry": null,
  "last_hitl_at_count": null,
  "strategies_tried": null,
  "push_status": null,
  "push_reason": null,
  "push_failure_detail": null,
  "push_version_needed": null
}
```

**Push-related fields** (set by `push_update_connector()` on failure, cleared on success):
- `push_status`: `null` (never pushed / success) | `"manual_required"` (all strategies failed)
- `push_reason`: `"host_blocks_upload"` | `"no_credentials"` | `"upload_failed"` | `"error"`
- `push_failure_detail`: human-readable description of the last failure
- `push_version_needed`: version string that failed to push (e.g. `"1.2.0"`)

## Update Detection

Three-strategy chain with connector preferred:

1. **Connector + refresh** (`connector_refresh`): Forces WP to refresh transients — most accurate, detects all pending updates
2. **Connector + cached** (`connector_cached`): Reads existing transients without refresh — avoids PHP fatals on hosts with restricted functions
3. **WP REST API fallback** (`rest_api`): Reads `/wp/v2/plugins?context=edit` + themes — may show stale/empty data if WP transients haven't been refreshed

Background scanner runs every **30 minutes**. Results cached in-memory for **5 minutes**.

## wp-agent Integration

The `site_manager.py` service creates `WordPressClient` and `AgentOrchestrator` instances without config files by building credentials programmatically from Supabase data. Orchestrators are pooled per site UUID with a 5-minute idle timeout.

Available agents: `posts`, `pages`, `media`, `taxonomy`, `users`, `comments`, `settings`, `menus`, `plugins`, `search`.

## WooCommerce

WC uses its own OAuth 1.0a auth (consumer key/secret) separate from WP REST API. The `woo_client.py` handles WC-specific endpoints:
- **Products**: Full CRUD — create, edit (name, price, sale price, SKU, stock, status, description), delete, bulk updates. Table shows image, name (clickable to edit), SKU, price, stock status, publish status, action buttons.
- **Orders**: List with search + status filter tabs (All/Pending/Processing/On Hold/Completed/Cancelled/Refunded/Failed). Click any order to open detail modal with billing/shipping addresses, line items (product name, SKU, qty, price), subtotals (discount, shipping, tax, total), customer notes, and status update dropdown.
- **Customers**: List with search, avatars, order count, total spent, registration date. Click any customer to open detail modal with 3 stat cards (orders, total spent, avg order value), contact info, address, and recent orders table (clickable to jump to order detail).
- Product categories, coupons, reports

WC API keys are optional — basic product browsing works via WP REST API without them. In basic mode (no keys), write operations and orders/customers are blocked with a clear "API keys required" message.

### WooCommerce API Routes (v1.5.0)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sites/{id}/woo/status` | GET | WC capabilities check |
| `/api/sites/{id}/woo/products` | GET/POST | List/create products |
| `/api/sites/{id}/woo/products/{pid}` | GET/PUT/DELETE | Get/update/delete product |
| `/api/sites/{id}/woo/products/bulk` | POST | Bulk product operations |
| `/api/sites/{id}/woo/orders` | GET | List orders (filterable by status, search) |
| `/api/sites/{id}/woo/orders/{oid}` | GET/PUT | Get/update order (status change) |
| `/api/sites/{id}/woo/customers` | GET | List customers (searchable) |
| `/api/sites/{id}/woo/customers/{cid}` | GET | Customer detail |
| `/api/sites/{id}/woo/customers/{cid}/orders` | GET | Customer's order history |
| `/api/sites/{id}/woo/categories` | GET | Product categories |
| `/api/sites/{id}/woo/reports/sales` | GET | Sales report |

## AI Assistant

Uses Claude CLI with plan/execute pattern:
1. User describes task in natural language
2. AI generates structured action plan (agent, action, params)
3. User reviews and approves plan
4. System executes plan step-by-step via wp-agent

Templates: write-post, seo-audit, woo-cleanup, fusion-cleanup, security-scan, plugin-audit.

## Frontend

SPA with sidebar navigation. Sections:

**Overview** (always visible):
- **Dashboard**: Multi-site update command center — aggregated plugin/theme/core updates with per-site breakdown, bulk update actions, tab interface (Plugins/Themes/Core), expandable/collapsible update groups. Entries animate out (fade + height-collapse) when updates complete; remaining groups slide up to fill the gap. Includes **Push OP** button that force-pushes the latest OPAI Connector plugin to all sites.
- **Sites**: Connect, test, refresh, settings, remove WordPress sites. Settings modal includes connector key field.

**Theme Hub** (always visible):
- **Envato**: Envato Theme Manager — see below.

**Automation** (always visible — moved up from site-dependent section in v1.4.0):
- **Schedules**: Create/edit/delete automation schedules with cron presets or custom expressions, timezone support, enable/disable toggle, Run Now, duplicate schedule. Table shows last run result badge (green check/red X/orange rollback), site name from join, and next/last run times.
- **Backups**: Create manual backups (full/database/files) with real-time progress bar, native browser download, restore, delete. Shows stats row (total backups, completed count, total size, last backup time). Connector status warning banner when connector not installed. New backups appear in-place (no page refresh) with pulse animation then persistent green highlight that fades on hover. Deleted backups slide out of the list with CSS transition.
- **Activity Log**: Paginated execution logs with status filter tabs (All/Success/Failed/Rolled Back/Running), task type dropdown filter, stats cards (total/success/failed/rolled back counts). Click any entry to open full detail modal with step timeline, duration, trigger type, rollback warnings.

**Site Management** (shown when a site is selected):
- **Overview**: Health stats, quick actions, connector status with auto-install/check-key prompts, WP admin login button. If `push_status === "manual_required"`, shows a **yellow warning banner** with a "View Steps" button — opens a step-by-step fix modal tailored to the `push_reason` (manual upload walkthrough, credentials setup, or retry instructions).
- **Updates**: Plugin/theme/core update grid with per-item Update buttons, Update All by type, Check Now
- **Posts** / **Pages**: Full CRUD with search, status filter, inline editor. Each row has a blue **WP** button that opens the WordPress block editor for that post/page in a new tab.
- **Media**: Image/file gallery with upload, edit, delete
- **Plugins**: Activate/deactivate, delete, install from WordPress.org, per-plugin update ignore
- **Themes**: View all themes with screenshots, activate, delete, **Upload Theme** (ZIP upload via modal)
- **Users**: Add, edit, delete with role assignment and post reassignment
- **Comments**: Approve, unapprove, spam, trash, permanent delete with status filtering
- **Settings**: General site settings, reading & discussion, connection settings (credentials, connector key, WooCommerce)
- **Agents**: Site-specific AI automation builder — run article writer, auto commenter, SEO optimizer, broken link scanner

**WooCommerce** (shown when site is marked as WC):
- **Products** (CRUD + bulk), **Orders** (detail + status update), **Customers** (detail + order history)

**AI Assistant**: Slide-out chat panel (always accessible)

### Update Animations (Dashboard)

Implemented in `dashboard.js` using JS height-collapse technique:
- **`_animateOut(el)`**: Measures `offsetHeight`, forces reflow, then transitions `opacity` → 0, `height` → 0 over ~600ms. Returns a Promise.
- Individual site rows within a plugin/theme group animate out when their update completes (`[data-site-id]` attribute used for targeting).
- When all sites in a group are done, the entire group animates out.
- On "Update All Sites" for a group: if expanded, each site row animates individually; if collapsed, group animates as a unit.
- DOM uses `id="ug-p-{slug}"`, `id="ug-t-{slug}"`, `id="ug-c-{site_id}"` for targeting.

### Key Frontend Files

| File | Purpose |
|------|---------|
| `static/index.html` | SPA shell, sidebar (4 sections), modals, script loading order |
| `static/js/app.js` | Core app: auth, routing, API helper, toast, navigate switch |
| `static/js/sites.js` | Site cards, connect modal, settings modal (with connector key) |
| `static/js/dashboard.js` | Aggregated updates, connector status, bulk actions, height-collapse animations, Push OP button + results modal, push failure banner + fix steps popup |
| `static/js/updates.js` | Per-site update view with inline update buttons, CSS keyframe dismiss animation |
| `static/js/content.js` | Posts, pages, media — CRUD + blue WP edit link in actions |
| `static/js/management.js` | Plugins, themes (+ Upload Theme), users, comments, settings |
| `static/js/agents.js` | Site-specific AI agent builder (4 templates, in-memory state) |
| `static/js/avada.js` | Envato Theme Manager UI — key management, version display, pull + deploy |
| `static/js/woo.js` | WooCommerce views — product CRUD, order detail + status, customer detail |
| `static/js/automation.js` | Schedules (CRUD + duplicate + last result), Backups (download/delete/stats), Activity Log (filters + stats + detail modal) |
| `static/js/ai.js` | AI assistant slide-out panel |
| `static/style.css` | Full stylesheet — Catppuccin Mocha theme |

### Sidebar Structure

```
Overview
  Dashboard | Sites
Theme Hub
  Envato
Automation                   ← always visible (was site-dependent before v1.4.0)
  Schedules | Backups | Activity Log
Site Management  (shown when site selected)
  Overview | Updates | Posts | Pages | Media | Plugins | Themes | Users | Comments | Settings | Agents
WooCommerce  (shown when site is_woocommerce=true)
  Products | Orders | Customers
```

### WP Edit Link (Posts & Pages)

Each post/page table row has a blue **WP** link button before the Eye/Edit icons:
```js
'<a class="btn-sm" href="' + siteUrl + '/wp-admin/post.php?post=' + id + '&action=edit"
   target="_blank" style="color:var(--blue);text-decoration:none;border-color:var(--blue)"
   title="Edit in WP Admin">WP</a>'
```
Works for both posts and pages (WP uses same URL pattern for both).

### Theme Upload

"Upload Theme" button opens a modal with file picker (`.zip` only). Frontend uses a raw `fetch()` with `FormData` (not `WP.api()`) because the API helper uses JSON. The backend endpoint at `POST /api/sites/{id}/themes/upload` tries:
1. OPAI Connector plugin (`/opai/v1/themes/upload`) — preferred
2. WP REST API `POST /wp/v2/themes` with `Content-Type: application/zip` — WP 5.5+

## Envato Theme Manager

Centralized management for the Avada premium theme across all connected sites. Renamed from "Avada Theme Hub" (v1.5.1) — now uses per-user Envato key storage via Supabase.

### How It Works

1. **Add Envato Personal Token** — go to [build.envato.com](https://build.envato.com/create-token/), create token with **"Download your purchased items"** and **"List purchases"** permissions. Add via the Envato section.
2. **Pull Now** — the button is disabled until at least one key is added. Hits Envato API with the user's token to fetch the latest Avada version and download the full theme ZIP.
3. **Deploy** — select any connected site from the dropdown, click Deploy. The stored ZIP is uploaded via OPAI Connector or WP REST API fallback.

### Envato API Integration

All Envato API calls require Bearer authentication — there is no public endpoint for version checks.

- **Version check** (auth required): `GET https://api.envato.com/v3/market/catalog/item?id=2833226` with `Authorization: Bearer {token}`
- **Download**: `GET https://api.envato.com/v3/market/buyer/download?item_id=2833226&shorten_url=true` → follow `wordpress_theme` URL
- **Avada ThemeForest item ID**: `2833226`

Version check parses these response fields in order (first non-null wins):
1. `wordpress_theme_metadata.version`
2. `attributes.current-version`
3. `current_version`

### Key Storage

Envato keys are stored in the `wp_envato_keys` Supabase table, scoped to `user_id`. Users cannot see each other's keys.

On `GET /api/avada/config`:
- Tokens are returned masked: first 6 chars + `...` + last 4 chars
- Raw tokens are **never** sent to the browser

Server-side cache (`data/avada.json`) stores only:

```json
{
  "cached_version": "7.14.2"
}
```

`data/avada-latest.zip` — the downloaded theme ZIP (shared across users, overwritten on each Pull).

## API Endpoints

### Sites
- `POST /api/sites` — Connect new site (validates first, accepts optional connector_secret)
- `GET /api/sites` — List user's sites
- `GET/PUT/DELETE /api/sites/{id}` — Site CRUD (PUT accepts connector_secret)
- `GET /api/sites/{id}/credentials` — Get WP login creds (for auto-login)
- `POST /api/sites/{id}/test` — Test connection
- `POST /api/sites/{id}/refresh` — Refresh site info (version, theme, plugin counts)

### Connector
- `GET /api/connector/download` — Download OPAI Connector plugin ZIP
- `POST /api/sites/{id}/connector/install` — Auto-install connector (needs admin_password)
- `GET /api/sites/{id}/connector/status` — Check connector reachability (returns `push_status`, `push_reason`, `push_version_needed` if push failed)
- `POST /api/connector/push-all` — **Push OP**: force-push latest plugin ZIP to all sites (admin only). Returns per-site results table + `task_id` + `audit_id` for tracking in Task Control Panel.

### Updates
- `GET /api/sites/{id}/updates` — Available updates for a site (cached or fresh)
- `GET /api/updates/all-sites` — Aggregated updates across all sites (dashboard)
- `POST /api/sites/{id}/updates/check` — Force update check
- `POST /api/sites/{id}/updates/plugins` — Update specific plugins
- `POST /api/sites/{id}/updates/themes` — Update specific themes
- `POST /api/sites/{id}/updates/all` — Update everything on a site
- `POST /api/bulk/updates` — Bulk check across sites

### Content
- `GET/POST/PUT/DELETE /api/sites/{id}/posts` — Posts
- `GET/POST/PUT/DELETE /api/sites/{id}/pages` — Pages
- `GET/DELETE /api/sites/{id}/media` — Media
- `GET /api/sites/{id}/search?q=...` — Search

### WooCommerce
- `GET/POST /api/sites/{id}/woo/products` — List/create products
- `GET/PUT/DELETE /api/sites/{id}/woo/products/{pid}` — Product CRUD
- `POST /api/sites/{id}/woo/products/bulk` — Bulk operations
- `GET /api/sites/{id}/woo/orders` — List orders (filterable by status, search)
- `GET/PUT /api/sites/{id}/woo/orders/{oid}` — Get/update order (status change)
- `GET /api/sites/{id}/woo/customers` — List customers (searchable)
- `GET /api/sites/{id}/woo/customers/{cid}` — Customer detail
- `GET /api/sites/{id}/woo/customers/{cid}/orders` — Customer order history
- `GET /api/sites/{id}/woo/categories` — Product categories
- `GET /api/sites/{id}/woo/reports/sales` — Sales report

### Automation
- `GET/POST /api/schedules` — List/create schedules
- `PUT/DELETE /api/schedules/{id}` — Update/delete schedule
- `POST /api/schedules/{id}/toggle` — Toggle enabled/disabled
- `POST /api/schedules/{id}/run` — Trigger immediate execution
- `GET /api/scheduler/settings` — Runtime scheduler state `{tick_seconds, paused}` (admin)
- `PUT /api/scheduler/settings` — Update tick interval / pause (admin)
- `GET /api/sites/{id}/logs` — Paginated execution logs (filterable by `status`, `task_type`)
- `GET /api/sites/{id}/logs/stats` — Log summary stats (counts by status)
- `GET /api/logs/{id}` — Single log detail with full step data
- `GET /api/sites/{id}/backups` — List backups
- `POST /api/sites/{id}/backups` — Create manual backup (blocks until connector completes, then background download)
- `GET /api/sites/{id}/backups/progress` — Poll backup creation progress (proxies to connector's `/backup/status/`)
- `DELETE /api/backups/{id}` — Delete backup (removes remote + local file)
- `GET /api/backups/{id}/download` — Download backup file; accepts `?token=` query param for native browser download
- `POST /api/backups/{id}/restore` — Restore from backup

#### Schedule Request Models (`routes_automation.py`)

**`CreateSchedule`** (POST /api/schedules):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `site_id` | str | required | Target site UUID |
| `name` | str | required | Schedule display name |
| `task_type` | str | required | `health_check`, `backup`, `update_all`, `update_plugins`, `update_themes`, `update_core` |
| `cron_expression` | str | required | Standard cron (validated via `croniter`) |
| `timezone` | str | `"America/Chicago"` | IANA timezone for cron evaluation |
| `task_config` | dict | `{}` | Type-specific config (e.g. `{"backup_type": "full"}`) |
| `enabled` | bool | `true` | Whether the schedule is active |
| `auto_rollback` | bool | `true` | Restore pre-backup if post-update health check fails |
| `pre_backup` | bool | `true` | Create backup before update tasks |

**`UpdateSchedule`** (PUT /api/schedules/{id}): Same fields as `CreateSchedule`, all optional. Recomputes `next_run_at` when `cron_expression` or `timezone` changes.

**Toggle** (POST /api/schedules/{id}/toggle): Reads current `enabled` state, flips it, returns updated row.

**Run Now** (POST /api/schedules/{id}/run): Fetches the schedule, spawns `execute_schedule()` as a background `asyncio.create_task()`, returns immediately.

#### Aggregated Updates Dashboard (`routes_updates.py`)

`GET /api/updates/all-sites` combines per-site update data into a single response for the multi-site dashboard:

1. Fetches all sites visible to the user (admin sees all, non-admin sees own)
2. For each site, reads cached updates or fetches fresh via `check_site_updates()`
3. Aggregates plugins by file path — groups the same plugin across multiple sites
4. Aggregates themes by stylesheet — groups the same theme across multiple sites
5. Collects core updates per site

**Response shape**:

```json
{
  "sites": [{"id", "name", "url", "status", "wp_version", "plugins_updates", "themes_updates", "core_update"}],
  "aggregated_plugins": [{"plugin", "slug", "name", "new_version", "sites": [{"site_id", "site_name", "current_version"}]}],
  "aggregated_themes": [{"stylesheet", "name", "new_version", "sites": [{"site_id", "site_name", "current_version"}]}],
  "core_updates": [{"site_id", "site_name", "current_version", "latest_version"}],
  "total_plugins": 12,
  "total_themes": 3,
  "total_core": 1,
  "total_updates": 16
}
```

The `total_*` counts reflect individual site-update pairs (e.g. if 3 sites need the same plugin update, that counts as 3).

### Management
- `GET /api/sites/{id}/plugins` — List plugins
- `POST /api/sites/{id}/plugins/{slug}/activate|deactivate` — Toggle plugin
- `POST /api/sites/{id}/plugins/install` — Install plugin from WordPress.org slug
- `DELETE /api/sites/{id}/plugins/{slug}` — Delete plugin
- `GET /api/sites/{id}/themes` — List themes
- `POST /api/sites/{id}/themes/{slug}/activate` — Activate theme
- `DELETE /api/sites/{id}/themes/{slug}` — Delete theme (via connector)
- `POST /api/sites/{id}/themes/upload` — Upload theme ZIP (connector → WP REST API fallback)
- `GET /api/sites/{id}/users` — WP users
- `POST /api/sites/{id}/users` — Create user
- `PUT /api/sites/{id}/users/{uid}` — Edit user
- `DELETE /api/sites/{id}/users/{uid}` — Delete user (with optional post reassign)
- `GET /api/sites/{id}/comments` — Comments (filterable by status)
- `POST /api/sites/{id}/comments/{id}/{action}` — approve, unapprove, spam, trash, delete
- `GET /api/sites/{id}/settings` — Site settings
- `PUT /api/sites/{id}/settings` — Save site settings

### Envato Theme Manager
- `GET /api/avada/config` — User's Envato keys (masked) + server cached version + zip status
- `POST /api/avada/config/keys` — Add Envato Personal Token `{label, token}` (stored per user in Supabase)
- `DELETE /api/avada/config/keys/{key_id}` — Remove key (own user or admin only)
- `POST /api/avada/check-version` — Fetch latest Avada version from Envato API using caller's first stored key; also downloads ZIP. Returns `{version, downloaded}`. Requires a key — returns 400 if none configured.
- `POST /api/avada/deploy` — Deploy stored ZIP to a site `{site_id}`

### AI
- `POST /api/ai/plan` — Generate action plan
- `POST /api/ai/execute` — Execute approved plan
- `POST /api/ai/chat` — Conversational mode
- `GET /api/ai/templates` — List AI task templates

## Connected Sites

| Site | URL | Connector | Data Method | Deploy Method | Push Status | Notes |
|------|-----|-----------|-------------|---------------|-------------|-------|
| Constitution for the People | constitutionforthepeople.org | v1.4.0 | connector_refresh | admin_upload | success | Hostinger shared hosting — no ZipArchive, uses two-phase tar streaming backup. PHP 8.1, 128M memory |
| WautersEdge | wautersedge.com | v1.4.0 | connector_refresh | admin_upload | success | WP 6.9 overwrite handled, local backup storage active. PHP 8.4, 1024M memory, ZipArchive available |

## Deployment

```bash
# Install systemd service
cp config/service-templates/opai-wordpress.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opai-wordpress

# Verify
curl -s http://localhost:8096/health | python3 -m json.tool

# Restart after changes
./scripts/opai-control.sh restart-one opai-wordpress

# Caddy reload (after Caddyfile update)
sudo systemctl reload caddy
```

## Known Issues & Gotchas

- **`get_core_updates()` in REST context**: Requires `require_once 'wp-admin/includes/update.php'` — without it, the connector crashes with a PHP fatal. Fixed in connector v1.1.0 class-updater.php.
- **Hostinger shared hosting**: `disk_free_space()` disabled, `wp-admin/update.php` may trigger fatals during transient refresh — connector has `function_exists()` guards and shutdown handler fallback
- **Admin upload on rate-limited hosts**: Hosts like Hostinger may return 508/503 or disconnect during wp-admin plugin upload. The connection agent retries automatically.
- **REST API stale transients**: Without connector, `/wp/v2/plugins?context=edit` shows `update: null` if WP hasn't refreshed transients. `wp-cron.php` trigger doesn't always help. Connector `connector_refresh` strategy is the reliable solution.
- **Auto-install verification**: After uploading plugin ZIP via wp-admin, REST API may not immediately list the plugin — needs retry/delay
- **httpx cookies**: `httpx.AsyncClient(cookies=jar)` with external `httpx.Cookies()` jar does NOT populate during redirects — use `client.cookies` instead
- **Connector auth**: Never send `X-OPAI-Key` from backend — stale keys cause 403. Always use Basic Auth (Application Password)
- **Setup endpoint**: Returns existing key (idempotent). Only regenerates with `force=true`. Prevents key drift.
- **Plugin deletion via REST API**: Use the raw path `/wp/v2/plugins/plugin-dir/plugin-file` (not URL-encoded). DELETE on URL-encoded path returns 404.
- **Theme deletion via REST API**: `DELETE /wp/v2/themes/{slug}` does NOT exist in WordPress REST API — returns `rest_no_route` 404. Always use the connector endpoint `POST /opai/v1/themes/{stylesheet}/delete` instead.
- **Pinned method stuck on `rest_api`**: If the REST API fallback "succeeds" (returns 200 with plugin list) but finds 0 updates (stale transients), it pins `rest_api` and never tries the connector. Fix: manually set `capabilities.data_method` to `connector_refresh` in Supabase, or clear the pin so the full chain retries.
- **Host blocks `update.php` from external IPs**: Some managed hosts (e.g. Hostinger) return 404 on `POST /wp-admin/update.php` from non-allowlisted IPs even with valid admin session cookies. Push OP now tries `plugin-install.php?action=upload-plugin` as a fallback. If both fail, site is tagged `push_reason: "host_blocks_upload"` and the site overview shows manual instructions.
- **WP "replace existing?" confirmation page**: When the connector plugin is already installed and you upload a new ZIP via wp-admin, WordPress shows an HTML confirmation page (HTTP 200) rather than installing immediately. **WP < 6.9**: POST form with hidden inputs. **WP 6.9+**: `<a>` link with query params (GET). Push OP handles both formats.
- **Hostinger disables `exec()` in PHP**: Connector `class-backup.php` wraps both `exec()` calls in `function_exists('exec')` guards. The pure-PHP unbuffered streaming fallback runs automatically.
- **Hostinger lacks ZipArchive extension**: Some Hostinger shared hosting PHP builds don't include the `ZipArchive` class. The connector's `/backup/create` fails with "ZipArchive extension not available". WP-Cron context may also lack it. Solution: use the two-phase server-side approach (`/backup/dump-db` + `/backup/stream-tar`) which needs no extensions.
- **Hostinger web server timeout (~300s)**: Shared hosting web server proxy kills PHP processes after ~300 seconds regardless of `set_time_limit(0)`. Long-running backup creation hits 503. Solution: stream-based endpoints (`dump-db`, `stream-tar`) start outputting immediately, keeping the connection alive.
- **MySQL OFFSET pagination is O(n^2)**: `SELECT * FROM table LIMIT offset, 1000` re-scans all rows up to the offset on every query. On large tables (100K+ rows), this makes DB dumps exponentially slow. Fixed with `mysqli->use_result()` unbuffered streaming — single pass, constant memory.
- **WP-Cron PHP process may lack web SAPI extensions**: Connector's `create_async` schedules backup via WP-Cron, but the cron PHP process on some hosts doesn't load the same extensions as the web SAPI (e.g. ZipArchive missing). The two-phase server-side approach is more reliable.
- **httpx cookie/auth conflict**: After wp-admin login, httpx retains session cookies that override Basic Auth on subsequent REST API calls (401). Always use a fresh `httpx.AsyncClient()` for REST API calls after admin operations.
- **deployer.py `last_failure_log` null**: `capabilities.last_failure_log` can be `None` — always use `(caps.get("last_failure_log") or "")` before string operations.
- **`POST /wp/v2/plugins` is NOT a ZIP uploader**: This endpoint installs plugins from WordPress.org by slug. Sending a ZIP to it fails with `rest_missing_callback_param: slug`. The `_push_via_rest_api()` function is therefore a no-op that falls through to admin_upload.
- **Task logger audit writes**: `services/task_logger.py` uses the shared `tools/shared/audit.py` helper which internally uses `fcntl.flock(LOCK_EX)` for cross-process safe writes to `tasks/audit.json`. Never write `audit.json` directly from another service without using the shared helper.

## Push OP — Task Logging

Every Push OP run is logged to the OPAI audit system via `services/task_logger.py`.

### Task Logger Service (`services/task_logger.py`)

A 79-line module that writes Push OP run results as system-tier audit records. Uses the shared `tools/shared/audit.py` helper for cross-process safe, tiered audit writes to `tasks/audit.json`.

**Public API**:

```python
def log_push_op(
    plugin_version: str,   # e.g. "1.4.0"
    results: list[dict],   # per-site push results
    started_at: str,       # ISO timestamp
    completed_at: str,     # ISO timestamp
    duration_ms: int,      # wall-clock duration
) -> dict:                 # {"audit_id": ...} or {"error": ...}
```

**How it works**:
1. Counts pushed/manual/error sites from `results` list (each entry has `status`: `"pushed"`, `"manual_required"`, or `"error"`)
2. Builds a summary string: `"Push OP v1.4.0 — 4/5 pushed, 1 manual"`
3. Determines overall status: `"completed"` (all pushed), `"partial"` (some manual), `"failed"` (any errors)
4. Calls `log_audit()` with these parameters:

| Audit Field | Value |
|-------------|-------|
| `tier` | `"system"` |
| `service` | `"opai-wordpress"` |
| `event` | `"push-op"` |
| `status` | `"completed"` / `"partial"` / `"failed"` |
| `summary` | Human-readable push summary |
| `duration_ms` | Wall-clock duration of the push run |
| `details.pluginVersion` | Plugin version pushed |
| `details.sitesTotal` | Total sites attempted |
| `details.sitesPushed` | Count of successfully pushed sites |
| `details.sitesManual` | Count of manual-required sites |
| `details.sitesError` | Count of errored sites |
| `details.pushResults` | Full per-site results array |

Results are visible in the **Task Control Panel** at `/tasks/` — the `audit_id` returned by `POST /api/connector/push-all` links directly to the audit tab.

**Shared audit helper** (`tools/shared/audit.py`): Cross-process safe writer using `fcntl.flock(LOCK_EX)`. Writes to `tasks/audit.json` with automatic rotation to `tasks/audit-archive.json` at 2000 records. Three valid tiers: `execution`, `system`, `health`.

## Backup System (v1.4.0)

Complete site backups with two-phase server-side architecture, tar streaming for ZipArchive-less hosts, real-time progress, chunked download streaming, download verification, and a no-refresh frontend UX.

### Architecture (v1.4.0 — Two-Phase Server-Side)

```
WP Site (Connector)                    OPAI Server                        NAS
  /backup/dump-db    ──stream──→  Phase 1: DB dump → local .sql file
  /backup/stream-tar ──stream──→  Phase 2: Files tar → local .tar file
                                  Phase 3: Assemble .sql + .tar → .zip  ──→  Synology Drive sync
                                                                              WPBackups/<folder>/
```

**Why two-phase**: Shared hosting (Hostinger) kills long-running PHP processes (~300s timeout) and may lack `ZipArchive` extension. The two-phase approach:
1. Streams DB and files **separately** as raw data (no ZIP, no temp files on remote)
2. The OPAI server pulls both streams and assembles the final ZIP locally
3. No server-side timeout issues — each stream starts outputting immediately

**Fallback**: If `stream-tar` is unavailable (connector < 1.4.0), falls back to connector's `/backup/create` (ZIP-based, requires ZipArchive).

### What's In a Backup

Backups are **complete, drop-in restorable** WordPress site archives:

| Directory/File | Included | Notes |
|----------------|----------|-------|
| `wp-admin/` | Yes | Full core admin |
| `wp-includes/` | Yes | Full core includes |
| `wp-content/` | Yes | Themes, plugins, uploads — excludes cache, backup, staging dirs |
| Root PHP files | Yes | `wp-config.php`, `index.php`, `wp-login.php`, etc. |
| `.htaccess` | Yes | If present |
| `db.sql` | Yes | Full database dump (unbuffered streaming, no OFFSET pagination) |

**Excluded directories** (defined in `_get_excludes()`): `opai-backups/`, `wp-content/cache/`, `wp-content/uploads/cache/`, `wp-content/backups/`, `wp-content/updraft/`, `wp-content/ai1wm-backups/`, `wp-content/wpvividbackups/`, `wp-content/wpvivid_staging/`, `wp-content/litespeed/`, `.git/`, `.svn/`, `node_modules/`, any `backup_*` directories.

### Connector Backup Endpoints

| Endpoint | Method | How It Works |
|----------|--------|-------------|
| `/backup/dump-db` | GET | Streams raw SQL directly to HTTP response. Uses `mysqli->use_result()` for unbuffered single-pass queries (no OFFSET pagination). Flushes every 500 rows. No temp file. |
| `/backup/stream-tar` | GET | Streams all WordPress files as a POSIX ustar tar archive. Pure PHP tar header construction — no extensions needed. Walks wp-admin, wp-includes, wp-content, root files with excludes. Flushes every ~2MB. No temp file. |
| `/backup/create` | POST | Creates ZIP on the remote server (requires ZipArchive). Used for WautersEdge-style hosts with ZipArchive. |
| `/backup/create-async` | POST | Schedules backup via WP-Cron (returns immediately). Unreliable on hosts where cron PHP process lacks extensions. |

### Database Dump — Unbuffered Streaming

The DB dump uses `mysqli->use_result()` (unbuffered queries) instead of OFFSET pagination:

```php
// OLD (O(n^2) — catastrophic on shared hosting for large tables):
for ( $offset = 0; $offset < $total; $offset += $limit ) {
    $data_res = $mysqli->query( "SELECT * FROM `{$table}` LIMIT {$offset}, {$limit}" );

// NEW (single pass, constant memory):
$mysqli->real_query( "SELECT * FROM `{$table}`" );
$data_res = $mysqli->use_result();
while ( $row = $data_res->fetch_array( MYSQLI_NUM ) ) { ... }
$data_res->free();
```

Both `dump_db()` (streaming endpoint) and `_dump_database()` (file-based for ZIP backups) use this approach.

### Tar Streaming — Pure PHP

The `/backup/stream-tar` endpoint writes POSIX ustar tar format directly to the HTTP output using native PHP file I/O — no extensions required:

- 512-byte ustar headers with proper checksum calculation
- Long filename support via prefix field (up to 255 chars: 155 prefix + 100 name)
- Files streamed in 512KB chunks with periodic flush
- End-of-archive marker (two 512-byte zero blocks)
- Respects all exclude rules from `_get_excludes()`

### Two-Phase Server-Side Flow (`routes_automation.py`)

```python
# Phase 1: Stream DB dump from connector → save locally
async with client.stream("GET", "/backup/dump-db") as resp:
    # Writes to _tmp_db_{date}.sql

# Phase 2: Stream files tar from connector → save locally
async with client.stream("GET", "/backup/stream-tar") as resp:
    # Writes to _tmp_files_{date}.tar

# Phase 3: Assemble local ZIP
with zipfile.ZipFile(local_zip_path, "w", ZIP_DEFLATED) as zf:
    zf.write(db_sql_path, "db.sql")
    with tarfile.open(files_tar_path, "r") as tf:
        for member in tf:
            if member.isfile():
                zf.writestr(member.name, tf.extractfile(member).read())
```

**Timing** (Constitution for the People, ~1.3GB total data):
- Phase 1 (DB dump): ~16 seconds (160 MB)
- Phase 2 (Files tar): ~2 minutes (1.18 GB, 32,388 files)
- Phase 3 (ZIP assembly): ~17 seconds
- **Total: ~2.5 minutes → 300 MB compressed ZIP**

### Progress Tracking

The connector writes an ephemeral `{id}.progress.json` file during ZIP-based backup creation:

```json
{
  "phase": "files",
  "section": "wp-content",
  "pct": 65,
  "files_added": 3200,
  "db_done": true,
  "backup_id": "backup_20260221_143022"
}
```

**Phases**: `starting` (0%) → `database` (10%) → `files` with sections: `wp-admin` (15%) → `wp-includes` (30%) → `wp-content` (50-90%) → `completed` (100%)

Progress updates every 50 files using linear formula: `min(90, 15 + (75 * count / 6000))`

Note: The two-phase tar streaming approach does not use progress files (the connector streams directly). Frontend progress is based on the POST request being in-flight.

### Chunked Download Streaming (v1.3.0 Fix)

PHP's `readfile()` on shared hosting hits memory/output-buffer limits, causing truncated downloads (e.g. 218 MB backup downloads as 49 MB). Fixed with `_stream_file()` helper:

```php
@set_time_limit( 0 );
while ( ob_get_level() ) ob_end_clean();
// Stream in 512KB chunks
$fh = fopen( $zip_path, 'rb' );
while ( ! feof( $fh ) ) {
    echo fread( $fh, 524288 );
    flush();
}
fclose( $fh );
exit;
```

### Download Verification

`_download_and_store_backup()` in `scheduler.py` compares downloaded file size against the connector's reported `size_bytes`. If the download is less than 95% of expected size, it's flagged as truncated, deleted, and metadata updated.

### Activity Log Integration (v1.4.0)

Manual backups and manual updates now write to `wp_execution_logs` for visibility in the Activity Log:
- **Manual backup**: `_create_log(None, site_id, "backup", trigger="manual")` — logged with per-phase step details (db_dump, files_stream, assemble)
- **Manual plugin update**: `_create_log(None, site_id, "update_plugins", trigger="manual")`
- **Manual theme update**: `_create_log(None, site_id, "update_themes", trigger="manual")`
- **Manual update all**: `_create_log(None, site_id, "update_all", trigger="manual")`

### Configuration

- **`config.BACKUP_STORAGE_DIR`**: Root path (default `/home/dallas/WautersEdge/WPBackups`)
- **`wp_sites.backup_folder`**: Per-site subfolder name (e.g. `"WautersEdge"`)
- Files named: `{SiteName}_{YYYYMMDD_HHMMSS}_backup.zip`

### Flow

1. Frontend sends POST to create backup, immediately starts polling `/sites/{id}/backups/progress` every 3 seconds
2. Backend streams DB dump from connector (Phase 1), then streams files tar (Phase 2), then assembles ZIP (Phase 3)
3. Frontend shows smooth progress bar (target-based ticker, max 2%/tick increment, no jumps)
4. On completion, metadata recorded in `wp_backups` table with `local_path`
5. New backup row inserted into DOM (no page refresh) with pulse animation → persistent green highlight
6. Download endpoint serves local file via `FileResponse` with original filename preserved

### Backend Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/backup-folders` | GET | List subdirectories of `BACKUP_STORAGE_DIR` |
| `/api/sites/{id}/backup-folder` | PUT | Set `backup_folder` on `wp_sites` (creates dir if needed) |
| `/api/sites/{id}/backups/progress` | GET | Proxy to connector's backup status endpoint (for progress polling) |
| `/api/backups/{id}/download` | GET | Serve local backup file; accepts `?token=` query param for native browser download |

### Frontend UX

- **Create Backup**: Modal with folder selector → progress bar with smooth incremental updates (target-based ticker system) → new backup row appears in-place at top of list
- **Progress bar**: Server polls set a target percentage; a 1-second ticker catches up gradually (max 2%/tick) with gap-aware acceleration — prevents the 5→92% jumps of direct server updates
- **New backup animation**: Purple pulse (1.5s) → persistent green highlight → green fades only when user hovers for >1 second (hover-to-dismiss pattern)
- **Delete**: Row slides out with CSS transition (opacity + translateX over 300ms), remaining rows shift up, stat cards update in-place
- **Download**: Native browser download via `<a>` click with `?token=` query string — no fetch+blob RAM loading. ZIP filename matches server filename exactly
- **No page refresh**: All create/delete operations use surgical DOM manipulation (`insertAdjacentHTML`, `element.remove()`) with stat card in-place updates

### Connector Plugin — `exec()` Guard

Hostinger shared hosting disables PHP `exec()`. The connector's `class-backup.php` uses `mysqldump` via `exec()` for database backups, with a pure-PHP unbuffered streaming export as fallback. Both `exec()` call sites (backup create and restore) are wrapped in `function_exists('exec')` guards so the fallback runs automatically on restricted hosts.

## Deployer — WP 6.9+ Compatibility

Three bugs were fixed in `services/deployer.py` for WP 6.9+ compatibility:

### 1. Null check on `last_failure_log`
`caps.get("last_failure_log")` can return `None`. Fixed with `(caps.get(...) or "").startswith(...)`.

### 2. WP 6.9 overwrite confirmation page
WordPress 6.9 changed the plugin overwrite confirmation page from a POST form with hidden inputs to an `<a>` link with query parameters (`action=upload-plugin&overwrite=update-plugin&_wpnonce=...`). The deployer now:
1. Tries to extract the `<a href>` link with an overwrite URL pattern
2. Follows via GET (not POST)
3. Falls back to the legacy POST form method for older WP versions

### 3. Cookie/Basic Auth conflict
After wp-admin login, the httpx client retains session cookies. When the same client makes REST API calls with Basic Auth, the cookies take precedence — and the cookie-authenticated session lacks REST API plugin management capability (returns 401). Fixed by using a fresh `httpx.AsyncClient()` (no cookies) for post-upload REST API verification.

### Failed Deployment Approaches (Reference)

| Approach | Why It Failed |
|----------|---------------|
| `POST /wp/v2/plugins` with ZIP | REST API only installs from WordPress.org by slug, not ZIP upload |
| WP File Manager AJAX (`admin-ajax.php`) | elfinder protocol requires cookie auth session, not Basic Auth |
| Hostinger API file upload | API key scope/expiration issues |
| `deploy_connector()` when plugin exists | Strategy 1 short-circuits — activates existing, never uploads new files |

**Working approach**: `push_update_connector()` with `admin_upload` method — wp-admin login + form upload + WP 6.9 overwrite handling + fresh client for verification.

## Feedback Loop Integration

OP WordPress is included in the **OPAI Feedback System** auto-fix loop (added 2026-02-20). User feedback tagged as `WordPress` is routed directly to `tools/opai-wordpress/` for automated implementation.

- **Tool name** in feedback system: `WordPress`
- **Source directory**: `tools/opai-wordpress/`
- **Wiki reference** used by fixer agent: `Library/opai-wiki/op-wordpress.md` (this file)
- **Feedback file**: `notes/Improvements/Feedback-WordPress.md`

The fixer agent has access to all files under `tools/opai-wordpress/` — routes, services, static JS, config, and the WP plugin. HIGH severity items auto-run; MEDIUM items queue for manual Run or auto-act.

See [Feedback System](feedback-system.md) for the full loop architecture.

## Related

- **wp-agent library**: `tools/wp-agent/` — Core WP REST API client and agents
- **Portal tile**: Admin dashboard card at `/dashboard`
- **Monitor**: Health probed on port 8096
- **Task Control Panel**: Push OP runs logged with `origin: "push-op"` in `tasks/audit.json`
- **Research notes**: `notes/Improvements/op-wordpress-connector-research.md`
