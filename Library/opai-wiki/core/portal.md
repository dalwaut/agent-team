# Portal
> Last updated: 2026-02-25 | Source: `tools/opai-portal/`

## Overview

The Portal is the main entry point for all OPAI web services. It serves a **public landing page** for visitors, handles authentication (login/logout via Supabase), role-based routing, onboarding, and an **admin dashboard** with live service health indicators and system stats. It also includes a **Pages Manager** — a WordPress-style page lifecycle tool with a table list view, unified editor, file browser, registry, route management, Traefik config generation, archive versioning, and AI page generation.

## Architecture

```
Browser → Caddy (:80) → Portal (:8090)
                            ├── /                   → Public landing page (landing.html)
                            ├── /dashboard          → Authenticated dashboard (index.html)
                            ├── /admin              → Alias for dashboard
                            ├── /auth/login         → Login form (Supabase JS)
                            ├── /auth/verify        → Invite token verification (PKCE/hash/OTP)
                            ├── /auth/config        → Public Supabase credentials
                            ├── /auth/callback      → OAuth redirect handler
                            ├── /onboard/           → 5-step onboarding wizard
                            ├── /onboard/status     → Check if user completed onboarding
                            ├── /archive/           → Pages Manager (admin tool)
                            ├── /api/me/apps        → User's allowed apps
                            ├── /api/feedback       → User feedback submission
                            ├── /api/request        → App/tool/agent request submission
                            ├── /api/rustdesk       → RustDesk connection info
                            ├── /api/pages/*        → Pages registry + route management
                            ├── /api/archive/*      → Archive CRUD endpoints
                            └── /health             → Service health check
```

- **Backend**: FastAPI (Python) with Uvicorn on port 8090
- **Frontend**: Vanilla JS, dark theme, no framework
- **Auth**: Supabase JS client v2 — session stored in localStorage, shared across all OPAI pages on the same origin

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-portal/app.py` | FastAPI entrypoint — routes, archive API, RustDesk, feedback, requests, onboarding |
| `tools/opai-portal/config.py` | Paths, env vars, Supabase credentials |
| `tools/opai-portal/static/landing.html` | Public-facing marketing/product page (self-contained CSS) |
| `tools/opai-portal/static/index.html` | Authenticated dashboard — admin and user views, health polling, stats |
| `tools/opai-portal/static/login.html` | Login form with `return` URL parameter support, password eye toggle |
| `tools/opai-portal/static/verify.html` | Invite token verification (PKCE + hash fragment + token_hash) |
| `tools/opai-portal/static/onboard.html` | 5-step onboarding wizard (password, storage, profile, provisioning, outcome) |
| `tools/opai-portal/static/js/onboard.js` | Onboarding wizard logic — Supabase auth, profile collection, provisioning API |
| `tools/opai-portal/static/style.css` | Shared styles for login, dashboard, onboarding, password toggle |
| `tools/opai-portal/static/js/auth-v3.js` | Frontend auth client — used by all OPAI web frontends |
| `tools/opai-portal/static/js/navbar.js` | Shared navigation bar — self-injecting, loaded by all tool pages (see [Shared Navbar](navbar.md)) |
| `tools/opai-portal/static/archive/index.html` | Pages Manager webapp (WordPress-style: table list, unified editor, archives) |
| `tools/opai-portal/static/archive/pages-registry.json` | Page registry: slugs, routes, status, deploy methods (auto-seeded) |
| `tools/opai-portal/static/archive/*.html` | Archived page snapshots (timestamped copies) |

## Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `OPAI_PORTAL_HOST` | Bind address | `127.0.0.1` |
| `OPAI_PORTAL_PORT` | Listen port | `8090` |
| `SUPABASE_URL` | Supabase project URL | (required) |
| `SUPABASE_ANON_KEY` | Supabase public key | (required) |
| `SUPABASE_SERVICE_KEY` | Service role key (needed for `/onboard/status` profile query) | (required) |
| `SUPABASE_JWT_SECRET` | JWT secret for HS256 fallback | (required) |

## Public Landing Page

The root URL (`/`) serves `landing.html` — a self-contained marketing page visible to **all visitors** without authentication. It showcases OPAI's capabilities and drives sign-ups.

### Sections

1. **Nav** — OPAI logo, Sign In + Dashboard buttons
2. **Hero** — Gradient headline, subtitle, stats bar (25 agents, 17 squads, 16+ tools), CTA buttons
3. **Mozart Orchestra Section** — Flow diagram showing the conductor/orchestration model:
   - Composer (You) → Score (Prompts) → Conductor (Mozart) → Ensemble (Agents) → Performance (Results)
   - 4 capability cards: Intelligent Orchestration, Specialist Agents, Adaptive Scaling, Human-in-the-Loop
4. **Features** — 4 grouped sections:
   - AI & Intelligence (Chat, Claude Code, Agent Studio, Email Agent)
   - Development & Workspace (OP IDE, Files, 1 workspace per account note)
   - Collaboration & Community (Messenger, Forum, Team Hub with sharing)
   - Platform & Operations (Monitor, Docs, Marketplace)
5. **Workspace Note** — 1 workspace per account, Team Hub for collaboration
6. **Beta CTA** — Founding member pricing, 1:1 support offer
7. **Footer** — BoutaByte branding, copyright

### Design

- Fully self-contained CSS (no external stylesheet dependency)
- Dark theme matching OPAI design system (`--bg: #0a0a0f`, purple accent `#a855f7`)
- Responsive layout (mobile-friendly)
- No authentication required — purely static/public

## Dashboard

Served at `/dashboard` (and `/admin` alias). Authentication is checked client-side; unauthenticated users are redirected to `/auth/login?return=/dashboard`.

### Admin Dashboard

Shown when `user.app_metadata.role === "admin"`.

1. **Status Bar** — Overall system health ("All Systems Operational" / "Some Systems Degraded") with per-service mini dots
2. **Quick Stats Row** — CPU, Memory, Disk, Uptime with progress bars (fetched from `/engine/api/system/stats` every 10s)
3. **Dashboard Toolbar** — Search, sort, view toggle, and layout save controls (see [Dashboard Toolbar](#dashboard-toolbar))
4. **Service Cards** (16 tiles, rendered dynamically from `ADMIN_CARDS` array — 9 active + 7 v3-deferred):

**Active tiles (9):**

| Card | Route | Health Source | Description |
|------|-------|---------------|-------------|
| Command Center | `/engine/` | `services.engine` | Unified dashboard |
| Team Hub | `/team-hub/` | `services.team-hub` | Tasks, workspaces, collaboration |
| OPAI Files | `/files/` | `services.files` | File manager |
| OP WordPress | `/wordpress/` | `services.wordpress` | Multi-site WordPress management |
| Email Agent | `/email-agent/` | `services.email-agent` | Autonomous email handling |
| User Controls | `/users/` | `services.users` | User management (admin only) |
| Discord Bot | — | `services.discord-bot` | Discord bridge (no web UI) |
| Pages Manager | `/archive/` | (no health dot) | Page version management |
| n8n Automations | `n8n.boutabyte.com` | (external) | Workflow automation (admin-only) |

**v3-Deferred tiles (7, visually distinct — dashed border, 50% opacity, "v3" badge):**

| Card | Route | Description |
|------|-------|-------------|
| 2nd Brain | `/brain/` | Knowledge management |
| Bx4 | `/bx4/` | Business intelligence |
| HELM | `/helm/` | Autonomous business runner |
| DAM Bot | `/dam/` | Meta-orchestrator |
| Marq | `/marq/` | App store publisher |
| PRD Pipeline | `/prd/` | Product idea evaluation |
| Forum Bot | `/forumbot/` | AI content generation |

v3-deferred cards use CSS class `.card-deferred` with dashed borders and 50% opacity, plus a `.deferred-badge` element positioned in the top-right corner displaying "v3". This visually separates planned-but-not-yet-active tools from the current working set.

Each card shows:
- Health dot (green/red/gray) from aggregated health endpoint
- Service uptime and memory usage in card footer
- Colored left border accent per service
- Drag grip icon (shown in default sort mode) for reordering

### Dashboard Toolbar

A toolbar rendered between the Quick Stats row and the service card grid. Only shown on the admin dashboard.

```html
<!-- Left side -->
<input type="search" id="admin-search" placeholder="Search tools...">
<select id="admin-sort">
    Custom order | Name A→Z | Name Z→A | Status: healthy first
</select>

<!-- Right side -->
<div class="view-toggle">
    [Grid] [List]
</div>
<button id="save-layout-btn">Save Layout</button>
```

#### Search

The search input filters the card grid in real time (150ms debounce). Matches against both `title` and `desc` fields of each card. Matching text is highlighted with `<mark>` tags. When a search is active, drag-to-reorder is disabled (sort is no longer `default`).

#### Sort

Four sort options, applied on every render:

| Option | Behavior |
|--------|----------|
| **Custom order** (default) | Uses `_adminOrder` array (drag-arranged or loaded from localStorage) |
| **Name A→Z** | Alphabetical by title |
| **Name Z→A** | Reverse alphabetical |
| **Status: healthy first** | Healthy services first; re-applies after each health poll |

When sort is not `default`, drag-to-reorder grips are hidden and drag events are not wired.

#### View Toggle

Two view modes:

| Mode | Grid Class | Layout |
|------|-----------|--------|
| **Grid** (default) | `admin-grid` | Card tiles in CSS grid |
| **List** | `admin-grid list-view` | Full-width rows with compact display |

The active button gets the `.active` CSS class. Switching view triggers a full `renderAdminCards()` call. View preference is stored in layout and loaded on next visit.

#### Save Layout

The **Save Layout** button persists the current order and view to `localStorage` under key `opai_dashboard_layout`. While unsaved changes exist (from drag or view toggle), the button shows `Save Layout*` with the `.unsaved` CSS class.

**Saved data structure:**
```json
{
  "order": ["chat", "claude", "agents", ...],
  "view": "grid"
}
```

On load, `loadAdminLayout()` merges the saved order with `ADMIN_CARDS`: saved order is respected, any new cards not in the saved list are appended at the end. This prevents new tiles from disappearing when a layout was saved before they were added.

### Drag-to-Reorder

Admin cards are draggable when sort mode is `default` and no search is active. Each card renders with `draggable="true"` and a grip icon (`⠿`) in the top-right corner.

**Drag behavior:**
- `dragstart`: Marks source card with `.drag-source` class (deferred via `requestAnimationFrame` so ghost image renders normally)
- `dragover`: Highlights target card with `.drag-over` class; sets `dropEffect: "move"`
- `drop`: Inserts source card before or after target based on mouse position
  - **Grid view**: Uses horizontal position (`e.clientX < rect.left + rect.width / 2`)
  - **List view**: Uses vertical position (`e.clientY < rect.top + rect.height / 2`)
- `dragend`: Reads new DOM order from `[data-card-id]` attributes, updates `_adminOrder`, marks layout as unsaved

The `_adminOrder` array is updated from DOM on every `dragend` — the DOM is the source of truth during drag, not a separate data model.

### User Dashboard

Shown when role is not admin. Cards are **dynamic** — rendered from the user's `allowed_apps` list in their profile, not hardcoded.

1. Portal fetches `GET /api/me/apps` (server-side profile lookup using service key)
2. Returns `allowed_apps` array from the user's `profiles` row
3. `renderUserCards()` builds card tiles from `APP_CARDS` catalog (JS object mapping app IDs to href/icon/title/desc)
4. Only apps in the user's list are shown; empty list shows "No apps assigned" message
5. Health dots are updated dynamically for all rendered cards

Fallback: if `/api/me/apps` fails, defaults to `['chat', 'messenger', 'files', 'forum']`.

App cards link with `?_=timestamp` cache buster to prevent stale HTML caching.

### Health Polling

- `fetchHealth()` — Calls `/engine/api/health/summary` every 30s, updates all health dots
- `fetchStats()` — Calls `/engine/api/system/stats` every 10s (admin only), updates CPU/Mem/Disk/Uptime
- `fetchRustDesk()` — Calls `/api/rustdesk` every 60s (admin only), updates RustDesk tile

## Pages Manager

WordPress-style admin tool at `/archive/` for full page lifecycle management. Accessible via the **Pages Archive** tile on the admin dashboard. Includes a shared navbar at the top.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Pages Manager (archive/index.html)                               │
│  ┌────────────────┐ ┌──────────────────┐ ┌────────────────────┐  │
│  │  Pages List     │ │  Editor View     │ │  Archives View     │  │
│  │  (table)        │ │  (unified)       │ │  (split panel)     │  │
│  │  - WP-style     │ │  - Title input   │ │  - Tab strip       │  │
│  │    sortable rows│ │  - Code/Preview  │ │  - List + preview  │  │
│  │  - Hover actions│ │  - File Browser  │ │  - Save/Rollback   │  │
│  │  - Status badge │ │    (modal popup) │ │  - Paste HTML      │  │
│  │  - Deploy btns  │ │  - Sidebar:      │ │  - AI Generate     │  │
│  │                 │ │    Publish box,   │ │  - Deploy          │  │
│  │                 │ │    Settings,      │ │                    │  │
│  │                 │ │    Actions        │ │                    │  │
│  └────────────────┘ └──────────────────┘ └────────────────────┘  │
│           showView('pages')  showView('editor')  showView('archives') │
└──────────────────────────────────────────────────────────────────┘
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
     pages-registry.json   Archive files   Traefik YAML
     (slug, route, status)  (*_*.html)     (opai-boutabyte.yaml)
                                            │
                                            ▼ SCP
                                    BB VPS /data/coolify/
                                    proxy/dynamic/
```

### UI (Three Views)

**Pages List (default)** — WordPress-style table:
- Columns: Title, Route, File, Status, Modified
- Row hover reveals actions: Edit, Preview, View Live, Archives, Trash
- Status badges: green "Active", gray "Draft"
- Top toolbar: "Add New" (opens editor), "Deploy Routes", "Deploy Content"
- Deploy Routes opens YAML preview modal before confirming

**Editor View** — unified Add/Edit page:
- **Header bar**: Back arrow (returns to list) + "Edit Page" / "Add New Page" title
- **Content area** (left, 70%):
  - Title input field
  - Content tabs: **Code** (textarea for raw HTML) | **Preview** (live iframe render)
  - "Browse Files" button (right of tab bar) → opens File Browser modal
- **Sidebar** (right, 30%):
  - **Publish box**: Status indicator (Active/Draft) + "Update" / "Publish" button
  - **Page Settings**: Slug, Route, Source File, Notes fields
  - **Actions**: "View Archives" link, "AI Generate" button (opens AI modal with page-type dropdown + prompt)
- On save: creates/updates registry entry. If HTML content provided, saves to source file.

**Archives View** — unchanged from prior version:
- Dynamic tab strip populated from registry (page name + route)
- Split-panel: archive list (left) + iframe preview (right)
- Actions: Save Current, Push Live (rollback + deploy), Delete, AI Create, Paste HTML
- Draft pages show warning banner, deploy disabled
- Create from HTML modal: label + textarea + preview button

**File Browser Modal:**
- Triggered by "Browse Files" button in editor content area
- Navigates the OPAI workspace filesystem (`/workspace/synced/opai`)
- Breadcrumb path display with clickable segments
- Directory listing: folders first, then files (name, size, modified date)
- Click folder to navigate into it, click file to select it
- "Use This File" button loads selected file's content into the code editor
- Default start directory: `tools/opai-billing/public-site`
- Scoped to workspace root (cannot escape `/workspace/synced/opai`)

### Pages Registry

Central data model stored at `static/archive/pages-registry.json`. Auto-seeded on first run with `landing` and `welcome` entries.

```json
{
  "version": 1,
  "pages": [{
    "slug": "landing",
    "name": "Landing Page",
    "source_file": "index.html",
    "route": "/about",
    "status": "active",
    "created_at": "...",
    "updated_at": "...",
    "notes": ""
  }]
}
```

| Field | Description |
|-------|-------------|
| `slug` | URL-safe ID, archive filename prefix. Regex: `^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$` |
| `source_file` | Filename on VPS at `/var/www/opai-landing/` (e.g., `pricing.html`) |
| `route` | URL path on opai.boutabyte.com (e.g., `/pricing`). Must be unique |
| `status` | `"active"` (deployed + routed) or `"draft"` (archive only) |
| `notes` | Free-text notes about the page |

**Removed fields** (simplified): `page_type` and `deploy_method` are no longer exposed in the UI. Deploy method defaults to `"static"` for new pages.

**Validation rules:**
- Routes must start with `/`, lowercase alphanumeric + hyphens, unique across all pages
- Reserved routes blocked: `/`, `/auth`, `/dashboard`, `/admin`, `/billing`, `/api`, `/onboard`, `/health`, `/static`, `/archive`
- HTML content: max 2MB, must contain `<`
- Source filenames: must end `.html`, no path separators

### Registry & File API

Thread-safe in-memory cache backed by JSON file. Atomic writes (`.tmp` → rename).

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/pages/registry` | List all registered pages |
| `POST` | `/api/pages/registry` | Create new page (name, slug, route; optional `html_content` saved to source file) |
| `PUT` | `/api/pages/{slug}` | Update page metadata (slug immutable) |
| `DELETE` | `/api/pages/{slug}` | Delete page + all its archive files |
| `POST` | `/api/pages/{slug}/create-from-html` | Save pasted HTML as archive entry |
| `POST` | `/api/pages/{slug}/toggle-status` | Toggle active/draft |
| `POST` | `/api/pages/{slug}/save-content` | Save HTML content to page's source file |
| `GET` | `/api/pages/{slug}/preview-source` | Serve source file for preview iframe |
| `GET` | `/api/pages/source-files` | List HTML files in `public-site/` directory |
| `GET` | `/api/pages/browse?dir=...` | Browse OPAI workspace filesystem (for file picker) |
| `GET` | `/api/pages/read-file?path=...` | Read file content for code editor |
| `GET` | `/api/pages/routes-preview` | Preview generated Traefik YAML (dry run) |
| `POST` | `/api/pages/deploy-routes` | Generate Traefik YAML + SCP to BB VPS |
| `POST` | `/api/pages/deploy-all` | **Unified deploy** — content (rsync) + routes (Traefik YAML) in one action |

### Route Management (Traefik YAML)

The Pages Manager generates a complete Traefik dynamic config (`opai-boutabyte.yaml`) from all active pages and deploys it via SCP to BB VPS at `/data/coolify/proxy/dynamic/`. Traefik auto-reloads when the file changes.

**Generated structure:**
- Each active page → a router (priority 100) + middleware
- `deploy_method: "static"` → `stripPrefix` middleware (for index.html-based pages like `/about`)
- `deploy_method: "rewrite"` → `replacePath` middleware (for named pages like `/welcome`)
- HTTP→HTTPS redirect router always included
- Catch-all `opai-catchall` (priority 1) → reverse proxy to OPAI Server via Tailscale
- Local copy saved at `tools/opai-billing/deploy/opai-boutabyte.yaml`

**Traefik YAML constraints (Coolify):**
- EntryPoints must be `http` / `https` (NOT `web` / `websecure` — Coolify's Traefik uses `http`/`https`)
- `serversTransports` must be indented under `http:` (not top-level)
- YAML comments must be ASCII only (no em dashes or unicode — Traefik's parser rejects them)
- SSH user is `root@bb-vps` (no `dallas` user on VPS)

### Archive Management

Archive files stored at `static/archive/{slug}_{YYYY-MM-DD_HHMMSS}[_label].html`. Managed via the archive API, resolved dynamically through the registry.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/archive/list?page={slug}` | GET | List archived versions for a page |
| `/api/archive/preview/{filename}` | GET | Serve archived HTML for iframe preview |
| `/api/archive/save` | POST | Snapshot current live source file to archive |
| `/api/archive/rollback` | POST | Restore archive as live page (auto-backs-up current first) |
| `/api/archive/deploy` | POST | SCP all source files to BB VPS `/var/www/opai-landing/` |
| `/api/pages/generate` | POST | AI-generate page via Claude CLI with OPAI context |
| `/api/archive/{filename}` | DELETE | Delete an archived version |

### Deploy Flows

**Content change** (edit in editor):
1. Edit HTML in Code tab or load from File Browser
2. Click "Update" → saves content to source file via `/api/pages/{slug}/save-content`
3. Click "Deploy All" → rsync content + Traefik YAML to BB VPS in one action

**New page creation:**
1. Click "Add New" → opens editor in create mode
2. Fill in title, slug, route, source filename
3. Write/paste HTML in Code tab or load from File Browser
4. Click "Publish" → creates registry entry + saves source file
5. Toggle to active → auto-triggers unified deploy (content + routes)
6. Page is immediately live at its route

**Archive rollback:**
1. Open Archives view → select page tab → pick version
2. Push Live → rollback + unified deploy (auto-backs-up current first)

**Route change:**
1. Edit page route in editor sidebar
2. Click "Deploy All" → content + routes deployed together
3. Traefik auto-reloads (watches dynamic config dir)

**Deploy mechanism:**
- Content: `rsync -az` over SSH to `root@bb-vps:/var/www/opai-landing/` (uses `--no-perms --no-group --no-owner` for NFS compatibility)
- Routes: SCP Traefik YAML to `root@bb-vps:/data/coolify/proxy/dynamic/opai-boutabyte.yaml`
- SSH key: `~/.ssh/bb_vps` (ED25519)
- "Deploy All" button replaces old separate "Deploy Content" / "Deploy Routes" buttons
- Advanced "Routes" button still available for route-only preview/deploy

### Safety

- `_valid_archive_name()` validates filenames against registry slugs (prevents path traversal)
- `is_relative_to(ARCHIVE_DIR)` check on all file operations
- File browser scoped to `_BROWSE_ROOT` (`/workspace/synced/opai`) — cannot escape workspace
- **Auto-backup before rollback**: current live page saved as `{slug}_{timestamp}_pre-rollback.html`
- Route uniqueness enforced at creation and update time
- Reserved routes blocked to prevent conflicts with OPAI services
- HTML content size limit (2MB)

## Feedback & Requests

A **Feedback** button appears in both the admin and user dashboard headers (next to the username, matching the Sign Out button style). Clicking it opens a modal with two tabs:

### Feedback Tab

Free-text feedback submitted via `POST /api/feedback` with `tool: "portal"`. Uses the existing feedback pipeline:
1. Appended to `notes/Improvements/feedback-queue.json`
2. Instantly written to `notes/Improvements/Feedback-Portal.md` for Task Control Panel visibility
3. Feedback processor classifies severity/category on next 5-minute cycle

### Request Tab

App/tool/agent/integration/feature requests submitted via `POST /api/request`. Creates a system task for agent review:

| Request Type | Description |
|-------------|-------------|
| App / Tool | Request a new application or tool |
| AI Agent | Request a new AI agent capability |
| Integration | Request a third-party integration |
| Feature Enhancement | Request an improvement to existing functionality |

**Flow:**
1. User submits request with type + description
2. Portal creates a **system task** in `tasks/registry.json` (`source: "user-request"`, `assignee: "agent"`)
3. Task assigned to `problem-solver` agent with instructions to classify as valid improvement or unnecessary
4. Entry written to `notes/Improvements/Feedback-Portal.md` for visibility
5. Entry appended to `feedback-queue.json` for feedback pipeline processing
6. Agent reviews → classifies → writes spec to `notes/Improvements/` if valid
7. Task appears in Task Control Panel for HITL review

**Rate limiting:** Both endpoints are rate-limited to 5 submissions per 60 seconds per IP.

**User attribution:** Submissions include `user_id` and `user_email` from the active session (stored in `window._opaiUserId` / `window._opaiUserEmail` on login).

## API

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/` | GET | Public | Serve public landing page (`landing.html`) |
| `/dashboard` | GET | Public | Serve authenticated dashboard (`index.html`, auth checked client-side) |
| `/admin` | GET | Public | Alias for `/dashboard` |
| `/auth/login` | GET | Public | Serve login page |
| `/auth/verify` | GET | Public | Invite token verification (PKCE code exchange) |
| `/auth/config` | GET | Public | Return Supabase URL + anon key (safe to expose) |
| `/auth/callback` | GET | Public | OAuth redirect (redirects to `/`) |
| `/onboard/` | GET | Public | Serve onboarding wizard (auth checked client-side) |
| `/onboard/status` | GET | Bearer | Check `profiles.onboarding_completed` for current user |
| `/api/me/apps` | GET | Bearer | Return `allowed_apps` for current user |
| `/api/feedback` | POST | Public | Accept user feedback (rate-limited 5/min/IP, see [Feedback System](feedback-system.md)) |
| `/api/request` | POST | Public | Accept app/tool/agent requests — creates system task + improvement entry (rate-limited 5/min/IP) |
| `/api/rustdesk` | GET | Public | RustDesk ID, active status, web client URL |
| `/archive/` | GET | Public | Serve Pages Manager webapp |
| `/api/pages/registry` | GET | Public | List all registered pages |
| `/api/pages/registry` | POST | Public | Create new page (name, slug, route; optional `html_content`) |
| `/api/pages/{slug}` | PUT | Public | Update page metadata |
| `/api/pages/{slug}` | DELETE | Public | Delete page + all archives |
| `/api/pages/{slug}/create-from-html` | POST | Public | Save pasted HTML as archive entry |
| `/api/pages/{slug}/toggle-status` | POST | Public | Toggle page active/draft |
| `/api/pages/{slug}/save-content` | POST | Public | Save HTML content to page's source file |
| `/api/pages/{slug}/preview-source` | GET | Public | Serve source file for preview iframe |
| `/api/pages/source-files` | GET | Public | List HTML files in public-site directory |
| `/api/pages/browse` | GET | Public | Browse OPAI workspace filesystem (file picker) |
| `/api/pages/read-file` | GET | Public | Read file content for code editor |
| `/api/pages/routes-preview` | GET | Public | Preview generated Traefik YAML |
| `/api/pages/deploy-routes` | POST | Public | Generate + SCP Traefik YAML to BB VPS |
| `/api/pages/deploy-all` | POST | Public | Unified deploy: rsync content + Traefik YAML to BB VPS |
| `/api/pages/generate` | POST | Public | AI-generate page via Claude CLI |
| `/api/archive/list` | GET | Public | List archived versions (`?page={slug}`) |
| `/api/archive/preview/{filename}` | GET | Public | Serve archived HTML for iframe preview |
| `/api/archive/save` | POST | Public | Save current live page as timestamped archive snapshot |
| `/api/archive/rollback` | POST | Public | Restore archive as live page (auto-backs-up current first) |
| `/api/archive/deploy` | POST | Public | SCP all source files to BB VPS |
| `/api/archive/{filename}` | DELETE | Public | Delete an archived version |
| `/health` | GET | Public | Service health check |

## Routing Model

```
opai.boutabyte.com/                 → landing.html   (public, no auth)
opai.boutabyte.com/dashboard        → index.html     (auth checked client-side)
opai.boutabyte.com/admin            → index.html     (alias for /dashboard)
opai.boutabyte.com/auth/login       → login.html     (redirects to /dashboard on success)
opai.boutabyte.com/archive/         → archive/index.html  (admin tool)
```

Key routing decisions:
- **`/`** serves the public landing page — visitors see marketing content without logging in
- **`/dashboard`** is the authenticated entry point — if no session, redirects to `/auth/login?return=/dashboard`
- **Login success** redirects to `?return=` param or defaults to `/dashboard` (not `/`)
- **Non-admin users** are checked for onboarding completion before showing dashboard

## Login Flow

1. User hits `/dashboard` → `index.html` loads
2. JS fetches `/auth/config` → creates Supabase client
3. `sb.auth.getSession()` — checks localStorage for existing session
4. No session → redirect to `/auth/login?return=/dashboard`
5. User enters email/password → `sb.auth.signInWithPassword()`
6. On success → `redirectAfterLogin()` reads `?return=` param or defaults to `/dashboard`
7. Dashboard loads → checks `user.app_metadata.role` → shows admin or user view
8. **Non-admin users**: fetches `/onboard/status` — if `onboarded: false` → redirect to `/onboard/`
9. Token stored in `window._opaiToken`, refreshed via `onAuthStateChange` listener

## Invite & Onboarding Flow

For the complete end-to-end guide (admin invite → email → PKCE verification → wizard → provisioning), see [Invite & Onboarding Flow](invite-onboarding-flow.md). For sandbox architecture details, see [Sandbox System](sandbox-system.md).

```
Email "Accept Invite"
  → Supabase /auth/v1/verify (token verification)
  → Redirect to /auth/verify?code=xxx (PKCE flow)
  → verify.html exchanges code for session
  → Redirect to /onboard/
  → 5-step wizard: Password → Storage → Profile → Provisioning → Outcome
  → "Go to Dashboard" → /dashboard → Portal with tool cards
```

### Password Fields

All password inputs (login + onboarding) include an **eye toggle** button for show/hide. Styles in `style.css` (`.pw-wrapper`, `.pw-toggle`), toggle logic inline in each page.

## Dependencies

- **Supabase**: Cloud-hosted auth (project `idorgloobxkmlnwnxbej`)
- **Fetches from**: Engine (`/engine/api/health/summary`, `/engine/api/system/stats`)
- **Serves auth for**: All web services (Chat, [Monitor](monitor.md), [Task Control Panel](task-control-panel.md), [Terminal](terminal.md), [Files](opai-files.md))
- **Onboarding triggers**: [Sandbox System](sandbox-system.md) provisioning via [Monitor](monitor.md) API — see [Invite & Onboarding Flow](invite-onboarding-flow.md)
- **Python deps**: fastapi, uvicorn, python-dotenv, httpx
- **Frontend deps**: Supabase JS client v2 (CDN), Inter font (Google Fonts)
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-portal` service)
- **Proxied by**: Caddy at `/`, `/auth/*`, `/onboard/*`, `/archive/*` (see [Auth & Network](auth-network.md))

## Navbar FULL_HEIGHT_TOOLS

The shared `navbar.js` maintains a `FULL_HEIGHT_TOOLS` list for SPAs that use `flex: 1` root layouts with internal scrolling. Any tool in this list gets special body styling so `overflow-y: auto` triggers correctly. Current list:

`terminal`, `claude`, `chat`, `bx4`, `brain`, `bot-space`, `orchestra`, `helm`, `marq`, `dam`

See the [Common Gotchas section in CLAUDE.md](../CLAUDE.md) for details on why this is required.
