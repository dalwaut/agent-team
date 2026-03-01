# OPAI Docs
> Last updated: 2026-02-24 | Source: `tools/opai-docs/`

## Overview

Auto-updating documentation portal that generates browsable, searchable docs from the wiki source files (`Library/opai-wiki/*.md`). Content is split into two tiers: user-facing (features, how-to guides) and admin-only (architecture, config, internals shown in collapsible accordions). A background watcher regenerates docs when wiki files change. Users see only content relevant to their role and allowed apps — infrastructure details (NAS, Docker, internal paths) are automatically sanitized from user-facing content.

## Architecture

```
Browser (HTTPS)
  |
  v
Caddy (:443/:80)
  |  handle_path /docs/* → reverse_proxy localhost:8091
  v
FastAPI (Python) on port 8091
  ├── GET /                    → index.html (SPA)
  ├── GET /api/docs            → Full docs JSON (role-filtered)
  ├── POST /api/docs/regenerate → Admin: force rebuild docs.json
  ├── GET /api/auth/config     → Supabase config for frontend
  ├── GET /health              → Service health check
  └── Background watcher       → Every 5 min, check wiki file hashes
                                  → Regenerate if changed

Generator (generator.py):
  Library/opai-wiki/*.md  →  SHA256 hash check  →  parse markdown
       ↓                                              ↓
  Split by ## headings                     User headings → content_md
       ↓                                  Tech headings → technical_md
  Sanitize user content                   Custom overrides (e.g., OP IDE)
       ↓
  data/docs.json + data/docs-meta.json
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-docs/app.py` | FastAPI entrypoint — health, lifespan with background watcher |
| `tools/opai-docs/config.py` | Port 8091, paths, env vars, watcher interval |
| `tools/opai-docs/generator.py` | Wiki parser — content splitting, sanitization, custom overrides, hash-based change detection |
| `tools/opai-docs/routes_api.py` | API — `/api/docs` (role-filtered), `/api/docs/regenerate` (admin), `/api/auth/config` |
| `tools/opai-docs/data/docs.json` | Generated structured documentation (19 sections) |
| `tools/opai-docs/data/docs-meta.json` | SHA256 hashes of source files for change detection |
| `tools/opai-docs/static/index.html` | SPA — sidebar, search, content area, accordions |
| `tools/opai-docs/static/style.css` | Dark theme matching portal |
| `tools/opai-docs/static/js/app.js` | Auth, hash routing, markdown rendering, accordion logic |
| `tools/opai-docs/static/js/search.js` | Fuse.js fuzzy search with Ctrl+K shortcut |

## Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `OPAI_DOCS_HOST` | Bind address | `127.0.0.1` |
| `OPAI_DOCS_PORT` | Listen port | `8091` |
| `SUPABASE_URL` | Supabase project URL | (required) |
| `SUPABASE_ANON_KEY` | Supabase anonymous key | (required) |
| `SUPABASE_SERVICE_KEY` | Service role key (profile lookup for role filtering) | (required) |
| `SUPABASE_JWT_SECRET` | JWT validation secret | (required) |

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | No | Serve SPA (auth checked client-side) |
| GET | `/health` | No | Service health check |
| GET | `/api/auth/config` | No | Supabase URL + anon key for frontend |
| GET | `/api/docs` | Bearer | Full docs JSON, filtered by user role + allowed_apps |
| POST | `/api/docs/regenerate` | Admin | Force regenerate docs.json from wiki sources |
| GET | `/api/scheduler/settings` | Admin | Runtime watcher state `{tick_seconds, paused}` |
| PUT | `/api/scheduler/settings` | Admin | Update watcher interval / pause (body: `{tick_seconds?, paused?}`) |

## How It Works

### Content Tiers

Every wiki `.md` file is parsed and split by `##` headings into two buckets:

- **User-facing (`content_md`)**: Overview, Features, How to Use — shown to all users
- **Admin-only (`technical_md`)**: Architecture, Key Files, Configuration, API, Security, Dependencies — shown in a collapsible "Technical Details" accordion for admins only

### Role-Based Filtering (Server-Side)

The `GET /api/docs` endpoint applies three filters before returning data:

1. **App access override**: If a section has an `app_id` and the user has that app in `allowed_apps`, the section is shown regardless of its visibility setting. This allows admin-only tools (Agent Studio, Monitor, etc.) to appear in user docs when explicitly granted
2. **Visibility**: Sections with `visibility: "admin"` are stripped for non-admins (unless overridden by app access above)
3. **App gating**: Sections tied to an `app_id` are only shown if the user has that app in `allowed_apps`
4. **Technical content**: All `technical_md` fields are stripped for non-admins
5. **Category filtering**: Categories are included dynamically — any category with at least one visible section appears, rather than being filtered by a static visibility flag

Users never receive admin content in the API response — it's not just hidden with CSS.

### Content Sanitization

User-facing content is automatically sanitized to replace infrastructure-specific terms:

| Original | Replaced With |
|----------|--------------|
| NAS, Synology, DS418 | storage / storage server |
| NFS, NFSv4.1 | network storage |
| Docker, container | workspace environment |
| systemd, Caddy, FastAPI | service manager / proxy / server |
| localhost:NNNN, port NNNN | internal service / internal port |
| /workspace/users/... | your workspace |
| IP addresses | [internal] |

### Custom Content Overrides

Some sections have custom user-friendly content instead of sanitized wiki text. For example, OP IDE shows a curated guide (features, extensions, AI assistant, project management) to users, while admins see the full wiki content (Docker, NFS mounts, Unix sockets) in the technical accordion.

### Scheduler Control Endpoints

Admin-only endpoints for dynamically controlling the background watcher without restarting the service:

- **`GET /api/scheduler/settings`** -- Returns the current watcher state:
  ```json
  { "tick_seconds": 300, "paused": false }
  ```
- **`PUT /api/scheduler/settings`** -- Update the watcher interval or pause/resume it. Accepts a JSON body with optional fields:
  - `tick_seconds` (integer) -- Change how often the watcher checks for wiki file changes (minimum 60 seconds)
  - `paused` (boolean) -- Pause (`true`) or resume (`false`) automatic `docs.json` regeneration

This allows admins to temporarily pause automatic regeneration during bulk wiki edits, or adjust the tick interval for performance tuning, all without a service restart. Manual regeneration via `POST /api/docs/regenerate` still works even when the watcher is paused.

### Auto-Update Watcher

A background task runs every 5 minutes (same pattern as `opai-monitor/updater.py`):

1. Read SHA256 hashes of all `Library/opai-wiki/*.md` files
2. Compare against stored hashes in `data/docs-meta.json`
3. If any hash differs → regenerate `docs.json`
4. Lightweight: only stat + hash unless changes detected

### Search

Client-side fuzzy search using Fuse.js, indexing titles, descriptions, and content. Activated with `Ctrl+K` shortcut. Results link directly to sections via hash routing.

## Frontend

- **Sidebar** (280px): search box, category groups with section links, active section highlighted with purple left border
- **Content area**: rendered markdown with syntax-highlighted code blocks (highlight.js)
- **Technical accordion**: admin-only, collapsed by default, "Admin" badge
- **Routing**: hash-based (`#chat`, `#dev`) for deep linking
- **Responsive**: sidebar collapses to hamburger on mobile (<768px)
- **Theme**: dark theme matching portal (Inter font, `--bg: #0a0a0f`, `--accent: #a855f7`)
- **CDN deps**: Supabase JS v2, marked.js, highlight.js, Fuse.js, Inter font
- **Navbar**: shared `navbar.js` included

## Dependencies

- **Python**: FastAPI, uvicorn, python-dotenv, python-jose, httpx
- **Shared**: `tools/shared/auth.py` (Supabase JWT validation)
- **Wiki sources**: `Library/opai-wiki/*.md` (20 files)
- **Frontend CDN**: Supabase JS v2, marked.js, highlight.js, Fuse.js, Inter font
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-docs` service)
- **Auth via**: [Auth & Network](auth-network.md)
- **Proxied by**: Caddy at `/docs/*` (see [Auth & Network](auth-network.md))
- **Health tracked by**: [Monitor](monitor.md) (in `_HEALTH_SERVICES` and `SYSTEMD_SERVICES`)
- **Dashboard tile**: [Portal](portal.md) (admin grid + `APP_CARDS` user registry)
