# Auth & Network Architecture
> Last updated: 2026-02-26 | Source: `tools/shared/auth.py`, `config/Caddyfile`, `config/network.json`

## Overview

All OPAI web services are gated behind **Supabase Auth** (cloud-hosted JWT auth) and served through a **Caddy reverse proxy** on port 443 (HTTPS). Port 80 redirects all traffic to HTTPS via 301. Cross-subnet access uses **Tailscale** VPN mesh. Users authenticate once at the portal, and the session persists across all services via shared localStorage. HTTPS is required for features that need a secure browser context (e.g., microphone access for voice input, file uploads).

## Architecture

```
Devices (any subnet)
    ↓ Tailscale VPN (WireGuard mesh)
    ↓
Caddy (:443 HTTPS, :80 redirects to HTTPS) on opai-server
    /              → Portal (login + role router, :8090)
    /auth/*        → Portal auth endpoints
    /chat/*        → Chat (:8888) [any authenticated user]
    /monitor/*     → Monitor (:8080) [admin only]
    /tasks/*       → Task Control (:8081) [admin only]
    /terminal/*    → Web Terminal (:8082) [admin only]
    /claude/       → Claude Code Terminal (:8082) [admin only]
    /ws/chat       → Chat WebSocket
    /ws/terminal   → Terminal WebSocket
    /ws/claude     → Claude Code WebSocket
    /users/*       → User Controls (:8084) [admin only]
    /files/*       → Files (:8086) [any authenticated user]
    /health        → Aggregated health (proxied to Monitor /api/health/summary)
    /oc/*          → OpenClaw Broker (:8106) [admin only]
                     OC containers bind 127.0.0.1:9001-9099 (localhost-only)

HTTPS (:443) serves all routes. HTTP (:80) 301-redirects to HTTPS.
Uses `tls internal` (Caddy self-signed CA).
Required for browser secure context features (microphone, file uploads, etc.).
```

All backend services bind to `127.0.0.1` — Caddy is the ONLY externally-reachable entry point. Auth is enforced at the application level (not Caddy) because WebSocket auth and role checks happen inside each service.

## Network Topology

```
Internet → Coast Connect (main router)
               ├── Daily work zone (subnet A)
               ├── Extender → RV Router → Server + NAS (subnet B) ← OPAI here
               └── Extender → Bus Router (subnet C)
```

Tailscale creates a flat WireGuard mesh so every device sees `opai-server` regardless of subnet. Also works off-network.

### NFS Storage

The Synology DS418 NAS (192.168.2.138) exports `/volume2/opai-users` via NFS v4.1, mounted at `/workspace/users` on the OPAI server. This provides per-user sandbox storage. See [Sandbox System](sandbox-system.md) for details.

## Auth Flow

### Login
1. User navigates to `http://opai-server/` → Portal dashboard
2. No session → redirect to `/auth/login`
3. Login form uses Supabase JS client (`signInWithPassword`)
4. Session stored in `localStorage` (keyed by Supabase project ref)
5. Redirect to `/` → Portal checks role → admin dashboard or user dashboard

### Accessing Services
1. Click "OPAI Chat" → `/chat/`
2. `auth.js` (shared) creates Supabase client, reads session from localStorage
3. Session found → user object returned → app initializes with auth
4. API calls include `Authorization: Bearer <JWT>` header
5. WebSocket sends auth token as first message: `{"type":"auth","token":"..."}`

### Role-Based + App-Based Access

Access is now a two-tier system:

1. **Role**: `admin` has unrestricted access to all apps. `user` is gated by `allowed_apps`.
2. **App Access**: Each user's `profiles.allowed_apps` (TEXT[]) controls which services they can reach. Managed via [User Controls](user-controls.md).

| Role | Portal | Apps | Behavior |
|------|--------|------|----------|
| `admin` | Full dashboard (all tiles) | All | Always allowed, no app check |
| `user` | Dynamic dashboard (only allowed tiles) | Per `allowed_apps` | Redirected to portal if accessing unauthorized app |

**Enforcement**: Every app frontend calls `opaiAuth.init({ requireApp: '<app_id>' })` on page load. For non-admins, auth.js fetches `GET /api/me/apps` (portal backend) and redirects to `/` if the app is not in the user's list. Empty list = fail open (server couldn't verify). Admins skip the check entirely.

**App IDs**: `chat`, `monitor`, `tasks`, `terminal`, `messenger`, `users`, `dev`, `files`, `forum`, `claude`, `rustdesk`

**App registry**: Defined in `tools/opai-users/app.py` (`APP_REGISTRY` list with id/label/category). Served at `GET /api/apps` for dynamic checkbox rendering in invite/edit modals.

Roles stored in `auth.users.raw_app_meta_data.role` and mirrored in `public.profiles.role`. For the complete invite and onboarding flow, see [Invite & Onboarding Flow](invite-onboarding-flow.md).

### Profile Enrichment & Access Control
On every authenticated request, the backend fetches the user's `profiles` row (cached 60s) and enriches the `AuthUser` with:
- **`is_active`** — Inactive users get 403 on all endpoints (admin exempt)
- **`ai_locked`** — AI-locked users get 403 on REST, 4003 close on WebSocket (admin exempt). Set automatically when malicious file uploads are detected. See [Chat](chat.md) for the security flow
- **`preface_prompt`** — Admin-set text prepended to user messages in Chat
- **`allowed_apps`** / **`allowed_agents`** — Per-user access restrictions
- **`sandbox_path`** — User's sandbox directory path (e.g., `/workspace/users/Denise`)
- **`onboarding_completed`** — Whether user has finished the onboarding wizard
- Managed via [User Controls](user-controls.md) and [Sandbox System](sandbox-system.md)

## Key Files

| File | Purpose |
|------|---------|
| `tools/shared/auth.py` | Backend JWT validation — imported by all FastAPI services |
| `tools/shared/__init__.py` | Package init |
| `tools/opai-portal/static/js/auth-v3.js` | Frontend auth client — loaded by all web frontends (renamed for cache busting) |
| `tools/opai-portal/app.py` | Portal: login page, role router, admin dashboard |
| `tools/opai-portal/static/login.html` | Login form (Supabase JS) |
| `tools/opai-portal/static/index.html` | Dashboard (admin/user views) |
| `config/Caddyfile` | Reverse proxy config |
| `config/network.json` | Network topology reference |
| `config/supabase-migrations/` | SQL migrations for auth schema (6 files, incl. 004_user_controls.sql, 006_sandbox_fields.sql) |
| `config/supabase-email-templates/invite.html` | OPAI-branded invite email template for Supabase |
| `SERVICES_QUICKSTART.md` | 8-step deployment guide |

## Backend Auth Module (`tools/shared/auth.py`)

| Export | Type | Purpose |
|--------|------|---------|
| `AuthUser` | dataclass | User info: `.id`, `.email`, `.role`, `.display_name`, `.is_admin`, `.is_active`, `.ai_locked`, `.preface_prompt`, `.allowed_apps`, `.allowed_agents`, `.sandbox_path`, `.onboarding_completed` |
| `get_current_user` | FastAPI Depends | Validates Bearer token (or service key fast-path) → enriches from profiles → blocks inactive users (403) → blocks AI-locked users (403) → returns `AuthUser` or 401 |
| `clear_profile_cache` | function | Clears cached profile data (by user_id or all). Called after lock/unlock to take immediate effect |
| `require_admin` | FastAPI Depends | Validates Bearer + admin role → returns `AuthUser` or 403 |
| `_fetch_profile` | internal | Fetches user profile from Supabase REST API (service role key), cached 60s |
| `_enrich_user` | internal | Populates AuthUser fields from profile data (is_active, preface_prompt, allowed_apps, etc.) |
| `authenticate_websocket` | async function | First WS message must be `{"type":"auth","token":"..."}` → returns `AuthUser` or closes 4001 |
| `decode_token` | async function | Validates JWT via JWKS (RS256/ES256) or JWT_SECRET (HS256) |

**Service key fast-path**: If the Bearer token exactly matches `SUPABASE_SERVICE_KEY`, `get_current_user` returns an admin `AuthUser` immediately (id=`service-role`, role=`admin`) without JWT decode or profile enrichment. This enables service-to-service calls (e.g., TCP heartbeat proxy → individual tool endpoints) using the service key. Consistent with Supabase's security model where the service key has full access.

Dev mode: set `OPAI_AUTH_DISABLED=1` in any service's `.env` to bypass all auth (treats all requests as admin).

## Frontend Auth Client (`auth-v3.js`)

| Method | Purpose |
|--------|---------|
| `opaiAuth.init(opts)` | Check session, redirect to login if missing. `opts.requireApp` checks `allowed_apps` via `/api/me/apps` (takes precedence over `requireAdmin`). `opts.requireAdmin` enforces admin role. `opts.allowAnonymous` skips redirect. |
| `opaiAuth.fetchWithAuth(url, opts)` | `fetch()` wrapper that adds Bearer token |
| `opaiAuth.fetchJSON(url, opts)` | JSON fetch with auth + error handling |
| `opaiAuth.getAuthMessage()` | Returns WebSocket auth payload string |
| `opaiAuth.getToken()` | Get current JWT (auto-refreshes) |
| `opaiAuth.signOut()` | Sign out + redirect to login |
| `opaiAuth.isAdmin()` | Check admin role |

Config is read at `init()` call time from `window.OPAI_SUPABASE_URL` / `window.OPAI_SUPABASE_ANON_KEY` (set by each app's config fetch).

## Supabase Schema

**Project**: `idorgloobxkmlnwnxbej` (OPAI Agent System)

### Tables
| Table | Purpose | RLS |
|-------|---------|-----|
| `public.profiles` | User profiles (extends `auth.users`) — role, display_name, sandbox_path, sandbox_provisioned, onboarding_completed, expertise_level, primary_use_case, preface_prompt, allowed_apps, allowed_agents, invited_by, last_login | Users read/update own, admins read/update all (via `get_my_role()`) |
| `public.conversations` | Chat conversations (multi-user). `user_id` defaults to `auth.uid()` | Users CRUD own, admins read all (via `get_my_role()`) |
| `public.messages` | Chat messages | Scoped through conversation ownership, admins read all (via `get_my_role()`) |
| `public.system_settings` | Global settings (users_enabled, network_locked) | Admin-only read/write (via `get_my_role()`) |
| `public.dev_workspaces` | Theia IDE containers | Users read/update own, admins full access (via `get_my_role()`) |

### RLS Helper Functions

| Function | Type | Purpose |
|----------|------|---------|
| `get_my_role()` | `SECURITY DEFINER` | Returns `profiles.role` for current user, bypassing RLS. Used in all admin policies on core tables to avoid infinite recursion. Migration: `017_fix_profiles_rls_recursion.sql` |
| `is_workspace_member(ws_id, user_id)` | Regular | Checks Team Hub workspace membership. Used by all `team_*` table policies |
| `workspace_role(ws_id, user_id)` | Regular | Returns Team Hub workspace role (`owner`/`admin`/`member`). Used for write-access checks on `team_*` tables |

**Why `get_my_role()` exists**: Admin policies originally used `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')`. This self-referencing subquery caused infinite recursion when evaluated via the anon key + user JWT (any non-service-role client). The `SECURITY DEFINER` function reads `profiles.role` as the function owner, bypassing RLS entirely. Backend services using the service role key were never affected (service role skips RLS).

**Tables using `get_my_role()`**: `profiles` (SELECT, UPDATE), `conversations` (SELECT), `messages` (SELECT), `dev_workspaces` (ALL, SELECT), `system_settings` (SELECT, UPDATE, INSERT).

**Team Hub tables are safe**: They use `is_workspace_member()` / `workspace_role()` which query `team_membership`, not `profiles`. No recursion risk.

### Column Defaults

| Table | Column | Default | Notes |
|-------|--------|---------|-------|
| `conversations` | `user_id` | `auth.uid()` | Added 2026-02-18. Allows direct Supabase inserts without explicitly passing `user_id` |
| `conversations` | `title` | `'New Chat'` | Original default |
| `conversations` | `model` | `'sonnet'` | Original default |

### Triggers
- `on_auth_user_created` → auto-creates `profiles` row from `auth.users` metadata
- `on_auth_user_created_team_hub` → auto-creates personal Team Hub workspace
- `profiles_updated_at` / `conversations_updated_at` → auto-update timestamps
- `trg_workspace_default_statuses` → creates default statuses on new Team Hub workspace
- `trg_workspace_default_dashboard` → creates default dashboard on new Team Hub workspace

## Caddy Reverse Proxy

- **HTTPS-first**: `:443` serves all routes (HTTPS with `tls internal` self-signed CA), `:80` 301-redirects to HTTPS
- Uses `handle_path` (strips prefix before proxying)
- `/chat` → 301 redirect to `/chat/` (trailing slash required for relative paths)
- Same pattern for `/monitor`, `/tasks`, `/terminal`
- Static assets use relative paths in HTML (e.g., `static/style.css` not `/static/style.css`)
- Auth.js loaded from portal: `/auth/static/js/auth-v3.js` (portal serves at both `/static` and `/auth/static`)
- Shared navbar loaded from portal: `/auth/static/js/navbar.js` — see [Shared Navbar](navbar.md)
- **Cache-Control**: Caddy sets `no-cache, no-store, must-revalidate` on all HTML page routes (`/`, `/monitor/`, `/tasks/`, etc.) to prevent stale auth logic
- Logs to `caddy-access-https.log` (HTTPS), 10MB rotation, 5 files
- HTTPS note: browser will show self-signed cert warning on first visit — accept once to proceed

## Firewall

```bash
ufw allow in on tailscale0 to any port 80    # HTTP via Tailscale
ufw allow in on tailscale0 to any port 443   # HTTPS via Tailscale (self-signed, for secure context)
ufw deny 8080:8888/tcp                        # Block direct service ports
```

## Dependencies

- **Supabase**: Cloud-hosted auth (project `idorgloobxkmlnwnxbej`)
- **Tailscale**: VPN mesh (free tier, 100 devices)
- **Caddy**: Reverse proxy (apt package)
- **Python**: `python-jose[cryptography]`, `httpx` (JWT validation)
- **Frontend**: Supabase JS client v2 (CDN)
- **Managed by**: [Services & systemd](services-systemd.md)
- **Used by**: All web services ([Portal](portal.md), [Monitor](monitor.md), [Task Control Panel](task-control-panel.md), Chat, [Terminal](terminal.md), [User Controls](user-controls.md), [Files](opai-files.md))
