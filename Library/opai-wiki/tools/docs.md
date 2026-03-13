# Docs Portal
> Last updated: 2026-03-12 | Source: `tools/opai-docs/`

## Overview

Documentation portal with two modes:

1. **Wiki Browser** — Zero-process static SPA serving the OPAI system wiki (`Library/opai-wiki/`, 79 docs). Client-side markdown rendering (marked.js), full-text indexed fuzzy search (Fuse.js), and hash-based routing. Caddy serves everything as static files.
2. **Document Viewer** — Auth-gated FastAPI backend (port 8091) that securely serves any workspace file via a direct link. Used for sharing documents via Telegram, email, or any chat channel.

**v3.5 additions**: The Document Viewer backend was added to enable direct-link file viewing across workspace directories, while the wiki browser remains zero-process static.

**v3.5.1 improvements** (2026-03-12):
- **Full-text indexed search** — Manifest now includes stripped plaintext content (up to 2000 chars per doc). Fuse.js searches across titles, sections, full body text, descriptions, and categories. Search results show contextual snippets with highlighted matching terms.
- **Navbar-aware layout** — CSS uses `--navbar-h` variable, dynamically detected from the OPAI navbar (44px). The docs topbar, sidebar, and main content all offset below the navbar — no more overlap.
- **Full-width responsive content** — Doc content uses 100% available width instead of a fixed 820px cap. Padding scales with viewport size (3-4vw on desktop, 2.5rem mid-range, 1.25rem mobile).

## Architecture

```
Browser (HTTPS)
  |
  v
Caddy (:443)
  ├── /docs/api/*   → reverse_proxy :8091 (FastAPI — Document Viewer)
  ├── /docs/wiki/*  → file_server → Library/opai-wiki/*.md (raw text)
  ├── /docs/*       → file_server → tools/opai-docs/static/ (SPA + view.html)
  └── /docs         → 301 → /docs/
                              |
                     SPA loads manifest.json
                     SPA fetches /docs/wiki/{path}
                     marked.js renders markdown
                     Fuse.js provides search
```

Key design decisions:
- **API route before wiki before SPA** in Caddyfile (most specific path first)
- **Raw markdown served as `text/plain`** — the SPA fetches and renders client-side
- **Document Viewer requires auth** — JWT validation via shared `auth.py`
- **Wiki browser allows anonymous** — `allowAnonymous: true` for wiki SPA
- **Manifest is pre-built** — no runtime scanning, just a static JSON file

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-docs/app.py` | **Document Viewer backend** — FastAPI, auth-gated `/view` endpoint, path safety |
| `tools/opai-docs/static/view.html` | **Document Viewer frontend** — standalone page with auth, markdown rendering |
| `tools/opai-docs/build-manifest.py` | Offline manifest generator — scans wiki, extracts metadata + search text |
| `tools/opai-docs/manifest.json` | Generated manifest (79 docs with titles, sections, categories, full-text search content) |
| `tools/opai-docs/static/index.html` | Wiki SPA shell — topbar, sidebar, content area, CDN deps |
| `tools/opai-docs/static/app.js` | Wiki SPA logic — auth init, manifest fetch, sidebar nav, hash routing, full-text search, navbar detection |
| `tools/opai-docs/static/style.css` | Shared dark theme (`--bg: #0a0a0f`, `--accent: #a855f7`, Inter font, navbar-aware layout) |
| `tools/opai-docs/requirements.txt` | Python deps: fastapi, uvicorn, aiofiles, python-jose, httpx |

## Document Viewer

### What It Does

Serves any workspace file through a secure, shareable URL. Primary use case: dropping clickable document links in Telegram, Slack, email, or any channel.

**Link format:**
```
https://opai.boutabyte.com/docs/static/view.html?path=<workspace-relative-path>
```

**Examples:**
```
https://opai.boutabyte.com/docs/static/view.html?path=notes/Improvements/calendar-agent-plan.md
https://opai.boutabyte.com/docs/static/view.html?path=Library/opai-wiki/tools/docs.md
https://opai.boutabyte.com/docs/static/view.html?path=reports/latest/_run_summary.md
```

### How It Works

```
User clicks link (e.g., from Telegram)
  ↓
Caddy serves view.html (static file)
  ↓
view.html fetches /auth/config → gets Supabase URL + anon key
  ↓
opaiAuth.init({ allowAnonymous: false }) → checks JWT session
  ↓ (no session? → redirect to /auth/login with ?return= URL)
  ↓ (logged in? → continue)
opaiAuth.fetchWithAuth('/docs/api/view?path=...')
  ↓
FastAPI backend validates JWT + resolves safe path
  ↓
Returns { path, name, content, type, size }
  ↓
view.html renders markdown (marked.js) or raw text
```

### Backend API

**Endpoint:** `GET /docs/api/view`

| Param | Type | Description |
|-------|------|-------------|
| `path` | query string (required) | Workspace-relative file path |
| `Authorization` | header (required) | `Bearer <JWT>` |

**Responses:**

| Status | Meaning |
|--------|---------|
| 200 | Success — returns `{ path, name, content, type, size }` |
| 400 | Path is empty or target is not a file |
| 401 | Missing or invalid JWT |
| 403 | Path traversal attempt or directory not in allowed list |
| 404 | File not found |
| 413 | File exceeds 2 MB limit |
| 415 | Binary file (cannot be viewed as text) |

**Health check:** `GET /docs/api/health` → `{ "status": "ok", "service": "opai-docs" }`

### Security Model

Four layers of protection:

1. **JWT Authentication** — Every request requires a valid Supabase JWT via `Depends(get_current_user)` from `tools/shared/auth.py`. No anonymous access.
2. **Path Traversal Prevention** — `_resolve_safe_path()` blocks `..` components, resolves symlinks, and verifies the resolved path stays within `WORKSPACE_ROOT`.
3. **Directory Allowlist** — Only files under these top-level directories are viewable:
   ```
   notes, Library, reports, Templates, workflows,
   tools, config, scripts, tasks, Research, Documents
   ```
4. **File Safety** — Binary files rejected (null-byte detection), max 2 MB file size, UTF-8 decode with Latin-1 fallback.

**What this means in practice:**
- Links are **not publicly accessible** — requires login
- Sessions expire per Supabase JWT policy (auto-refresh handled by `auth-v3.js`)
- No one can access files outside allowed workspace directories
- No path traversal (`../../etc/passwd` is blocked)
- Sharing a link with someone without an OPAI account → they see a login wall

### Frontend (view.html)

Standalone page (not part of the SPA). Features:
- **Sticky topbar** with OPAI Docs branding, file path display, "All Docs" link, "Copy Link" button
- **Auth flow**: Fetches `/auth/config` → sets Supabase vars → `opaiAuth.init()` → `opaiAuth.fetchWithAuth()` for API call
- **Markdown rendering** via marked.js with GFM, external links open in new tab
- **Raw text fallback** for non-markdown files (monospace `<pre>` block)
- **Meta bar** showing file type (markdown/text), file size, and filename
- **Error states**: auth wall, file not found, access denied, connection error
- **Mobile responsive** — path display truncates, padding adjusts
- **Reuses** `style.css` from the docs portal for consistent theming

### Service Configuration

| Setting | Value |
|---------|-------|
| Port | 8091 |
| systemd service | `opai-docs.service` |
| Process | `uvicorn app:app --host 127.0.0.1 --port 8091` |
| Working directory | `/workspace/synced/opai/tools/opai-docs` |
| Env vars | `OPAI_WORKSPACE` (default: `/workspace/synced/opai`) |
| Caddy route | `handle_path /docs/api/*` → `reverse_proxy localhost:8091` |

### Generating Links (for agents/integrations)

Any agent or integration that wants to share a document link should construct:

```
https://opai.boutabyte.com/docs/static/view.html?path={workspace_relative_path}
```

Where `workspace_relative_path` is relative to `/workspace/synced/opai/`. Do NOT include the workspace root in the path. Examples for common agent use:

```python
# Python
doc_url = f"https://opai.boutabyte.com/docs/static/view.html?path={urllib.parse.quote(relative_path)}"

# JavaScript
const docUrl = `https://opai.boutabyte.com/docs/static/view.html?path=${encodeURIComponent(relativePath)}`;
```

**Important:** Use `opai.boutabyte.com` (public domain via VPS), not `192.168.1.191` (LAN only). Links sent via Telegram or email must use the public domain to work over cellular.

---

## Wiki Browser (SPA)

### Manifest Generation

Run manually after wiki edits:

```bash
python3 tools/opai-docs/build-manifest.py
```

Scans `Library/opai-wiki/` subdirectories (`core/`, `tools/`, `agents/`, `integrations/`, `infra/`, `plans/`). For each `.md` file extracts:

| Field | Source |
|-------|--------|
| `title` | First `# Heading` (fallback: filename) |
| `description` | First non-heading, non-blockquote line |
| `sections` | All `## Headings` |
| `port` | Regex match for "Port NNNN" |
| `source` | Regex match for "tools/opai-*" |
| `last_updated` | Regex match for "Last updated: YYYY-MM-DD" |
| `category` | Parent subdirectory name |
| `search_text` | Full doc text stripped of markdown formatting (code blocks, links, emphasis, tables), capped at 2000 chars. Powers full-text search |

Output: `tools/opai-docs/manifest.json` (~225 KB, gzips to ~40 KB) — pure stdlib Python, no dependencies.

### Frontend SPA

- **Sidebar**: Collapsible category groups (Core, Tools, Agents, Integrations, Infrastructure, Plans) with doc counts. Active doc highlighted with purple left border
- **Search**: Full-text indexed Fuse.js fuzzy search across titles, sections, body content, descriptions, and categories. `Ctrl+K` shortcut. Arrow keys + Enter to navigate results. Debounced 150ms. Results show contextual snippets with highlighted matching terms. Up to 15 results displayed
- **Routing**: Hash-based (`#core/portal`, `#tools/brain`). Deep-linkable. Browser back/forward works
- **Markdown rendering**: marked.js with GFM support. Internal `.md` links rewritten to hash routes. External links open in new tab
- **Meta bar**: Category tag, port number, source tool, last updated date (extracted from manifest)
- **Navbar-aware layout**: On boot, JS detects `.opai-navbar` (44px) via MutationObserver and sets `--navbar-h` CSS variable. Topbar, sidebar, and main content all offset below the navbar using `calc(var(--navbar-h) + var(--topbar-h))`
- **Full-width responsive content**: Doc content uses 100% width (no fixed max-width). Main area padding scales: `3vw` default, `4vw` on 1400px+ screens, `2.5rem` mid-range, `1.25rem` mobile
- **Mobile**: Sidebar collapses to hamburger toggle (<768px), overlay backdrop
- **Auth**: Loads shared `auth-v3.js` and `navbar.js` from portal
- **CDN deps**: marked.js v15, Fuse.js v7, Supabase JS v2, Inter font

### Welcome Page

When no doc is selected, shows total doc count and per-category counts from the manifest.

---

## Access Control

The two modes have different access levels:

| Mode | Auth Required | Why |
|------|--------------|-----|
| Wiki Browser (`/docs/`) | No — `allowAnonymous: true` | Internal wiki, viewable by anyone on the network |
| Document Viewer (`/docs/static/view.html`) | **Yes** — JWT required | Serves arbitrary workspace files, must be access-controlled |

### Wiki Auth Flow

```
User visits /docs/
  ↓
Caddy serves SPA (index.html)
  ↓
auth-v3.js init({ allowAnonymous: true })
  ↓
If logged in → navbar shows user state
If not logged in → docs still render (anonymous access)
```

### Document Viewer Auth Flow

```
User clicks document link
  ↓
view.html loads → fetches /auth/config
  ↓
opaiAuth.init({ allowAnonymous: false })
  ↓
No session → redirect to /auth/login?return=<original-url>
  ↓
After login → redirect back → view.html loads file via authed API
```

### Access Layers

| Layer | Wiki Browser | Document Viewer |
|-------|-------------|-----------------|
| **Caddy** | Static file server, no auth | Proxies to FastAPI backend |
| **auth-v3.js** | `allowAnonymous: true` | `allowAnonymous: false` — redirects to login |
| **Backend** | N/A (no backend) | JWT validated via `Depends(get_current_user)` |
| **Path safety** | N/A | `_resolve_safe_path()` — traversal blocked, directory allowlist |

### User Setup

For wiki access:
1. **Network access** — must be on Tailscale or VPN
2. **No login required** — wiki renders for anonymous users

For document viewer access:
1. **OPAI account** — must have a Supabase profile
2. **Login session** — must be logged in (auto-redirects to login if not)
3. **Works over cellular** — use `opai.boutabyte.com` domain

## Portal Integration

- **Admin dashboard**: Docs tile in `ADMIN_CARDS` array (after Studio)
- **User dashboard**: Docs entry in `APP_CARDS` registry (assignable via `allowed_apps`). Default fallback includes `docs`
- **Navbar**: `docs` entry in `navbar.js` (abbr: DC, color: #22d3ee)
- **CSS**: `.card-docs` class in portal `style.css` (cyan left border)

## Caddyfile Routes

```caddyfile
# API routes → backend (auth-gated file viewer)
handle_path /docs/api/* {
    reverse_proxy localhost:8091
}

# Raw wiki markdown (must come before SPA catch-all)
handle_path /docs/wiki/* {
    root * /workspace/synced/opai/Library/opai-wiki
    file_server
    header Content-Type "text/plain; charset=utf-8"
}

# SPA static files + view.html + index.html fallback
handle_path /docs/* {
    root * /workspace/synced/opai/tools/opai-docs
    try_files {path} /static/{path} /static/index.html
    file_server
}

@docsExactS path /docs
redir @docsExactS /docs/ 301
```

**Route order matters**: `/docs/api/*` must come before `/docs/*`. Caddy's `handle_path` strips the prefix, so the backend receives `/view` not `/docs/api/view`.

## Dependencies

- **Runtime (Wiki)**: None — Caddy only (already running)
- **Runtime (Viewer)**: Python 3, FastAPI, uvicorn, aiofiles, python-jose, httpx
- **Build-time**: Python 3 stdlib (for `build-manifest.py`)
- **Frontend CDN**: marked.js v15, Fuse.js v7, Supabase JS v2, Inter + JetBrains Mono fonts
- **Wiki sources**: `Library/opai-wiki/` (79 files across 6 subdirectories)
- **Auth via**: [Auth & Network](../core/auth-network.md) (shared `auth-v3.js` + `tools/shared/auth.py`)
- **Proxied by**: Caddy at `/docs/api/*`, `/docs/wiki/*`, `/docs/*`
- **Dashboard tile**: [Portal](../core/portal.md) (admin grid + `APP_CARDS` user registry)

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Document Viewer returns 401 | JWT expired or missing | Log in again at `/auth/login` |
| Document Viewer returns 403 | File outside allowed dirs or path traversal | Check path is under one of: notes, Library, reports, Templates, workflows, tools, config, scripts, tasks, Research, Documents |
| Login redirect loop on view.html | Supabase config not loading | Check `/auth/config` endpoint returns valid JSON. Ensure portal (8090) is running |
| `ERR_CONNECTION_ABORTED` on mobile | Using LAN IP with self-signed cert | Use `opai.boutabyte.com` domain instead of `192.168.1.191` |
| Wiki SPA shows no docs | Manifest not built or stale | Run `python3 tools/opai-docs/build-manifest.py` |
| View page shows "Connection Error" | opai-docs service not running | `sudo systemctl restart opai-docs` |
