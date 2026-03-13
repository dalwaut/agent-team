# User Controls
> Last updated: 2026-03-05 | Source: `tools/opai-users/`, `tools/opai-portal/static/js/auth-v3.js`

## Overview

The User Controls app is a standalone admin panel for managing OPAI users, permissions, and network security. It provides user invite/edit/deactivation, per-user app and agent access control, preface prompt management, **AI lock management** (unlock users locked by security system), **hard delete** (permanent user removal), and a network lockdown kill switch.

## Architecture

```
Browser → Caddy (:443 HTTPS) → User Controls (:8084)
                            ├── /api/users              → List/invite/update users
                            ├── /api/users/{id}         → Get/update/deactivate user
                            ├── /api/users/invite       → Send Supabase email invite
                            ├── /api/users/drop-all     → Deactivate all non-admins
                            ├── /api/users/restore-all  → Re-enable all users
                            ├── /api/system/settings/*  → System settings CRUD
                            ├── /api/system/network/*   → Network lockdown/restore/status
                            ├── /api/auth/config        → Supabase credentials
                            ├── /api/team               → Agent roster from team.json
                            └── /                       → Dashboard UI
```

- **Backend**: FastAPI (Python) with Uvicorn on port 8084
- **Frontend**: Vanilla JS, dark terminal theme, no framework
- **Auth**: Admin-only (Supabase JWT, requires `role = admin`)
- **Shared code**: Imports `routes_users.py` (local), `auth.py` and `config.py` from `tools/shared/` via sys.path

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-users/app.py` | FastAPI entrypoint — mounts routes_users router, auth/team/apps endpoints, dynamic app registry |
| `tools/opai-users/config.py` | Config: OPAI_ROOT, Supabase credentials, LOCKDOWN_PIN |
| `tools/opai-users/routes_users.py` | API router — user CRUD, invite, sandbox provisioning, network lockdown, system settings |
| `tools/opai-users/static/index.html` | Dashboard — user table, invite/edit/PIN modals |
| `tools/opai-users/static/app.js` | User management JS — CRUD, invite, network lockdown |
| `tools/opai-users/static/style.css` | Dark terminal theme (standalone copy) |
| `config/supabase-email-templates/invite.html` | Branded invite email template for Supabase |

## Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `OPAI_USERS_HOST` | Bind address | `127.0.0.1` |
| `SUPABASE_URL` | Supabase project URL | (required) |
| `SUPABASE_ANON_KEY` | Public key (frontend auth) | (required) |
| `SUPABASE_SERVICE_KEY` | Service role key (admin API) | (required) |
| `LOCKDOWN_PIN` | PIN for network lockdown/restore | (required) |

Credentials are injected via the vault-env pattern (see [Services & systemd](../core/services-systemd.md)).

## Features

### User Management

- **List Users**: Table showing name, email, role, active status, allowed apps, preface indicator. **AI-locked users** highlighted with red background, red left border, and lock icon
- **Invite User**: Send Supabase email invite with OPAI branding, Tailscale setup instructions, custom message
- **Edit User**: Modify display name, role, active status, preface prompt, allowed apps/agents, sandbox path
- **Dynamic App List**: App checkboxes in invite/edit modals are fetched from `GET /api/apps`. The registry is built dynamically at startup by scanning the `tools/` directory, merged with a metadata map for labels/categories. New tools automatically appear without code changes. External services (Claude Code, Remote Desktop) and exclusions (orchestrator, portal, etc.) are configured in `_APP_META`, `_EXTERNAL_APPS`, and `_EXCLUDED_TOOLS` in `app.py`
- **Toggle Active**: Quick on/off button per user
- **Unlock AI**: Button in edit modal (orange, shown only for locked users) — removes AI lock, clears reason/timestamp
- **Hard Delete**: Red button in edit modal — permanently deletes user (profile, auth account, sandbox, n8n unlink). Double-confirm required. Hidden for admin users
- **AI Lock Banner**: Red banner in edit modal showing lock reason when user is AI-locked
- **Drop All**: Global kill switch — deactivates all non-admin users, sets `system_settings.users_enabled = false`
- **Restore All**: Re-enables all users, clears kill switch

### Preface Prompt

Admin-set text prepended to every non-admin user's messages before sending to AI models. Used for sandboxing, role enforcement, or context injection.

```
[SYSTEM PREFACE - ADMIN SET]: {preface_prompt}
--- USER MESSAGE FOLLOWS ---
{actual user message}
```

Enforced in: `tools/opai-chat/routes_ws.py` (Chat service WebSocket handler)

### Network Lockdown

PIN-protected system to kill all external network connectivity:

1. **Lockdown**: `tailscale down` → `ufw default deny outgoing` → stop RustDesk
2. **Restore**: `ufw default allow outgoing` → `tailscale up` → start RustDesk
3. **Status**: Polls every 10s, button shows "Kill Net" (normal) or "LOCKED" (pulsing red)

Requires sudoers entries in `/etc/sudoers.d/opai-network`:
```
dallas ALL=(ALL) NOPASSWD: /usr/bin/ufw
dallas ALL=(ALL) NOPASSWD: /usr/bin/tailscale
dallas ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop rustdesk
dallas ALL=(ALL) NOPASSWD: /usr/bin/systemctl start rustdesk
```

### Invite Email

Custom OPAI-branded email template (dark theme, purple accents) configured in Supabase Dashboard > Auth > Email Templates > Invite User. For the complete invite-to-onboarding flow, see [Invite & Onboarding Flow](invite-onboarding-flow.md).

Includes:

1. Install Tailscale link
2. Join OPAI network (with optional Tailscale invite link)
3. Accept invite & set password
4. Login URL (`https://opai-server.tail856df6.ts.net`)

Template location: `config/supabase-email-templates/invite.html`

## API

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/users` | GET | Admin | List all user profiles |
| `/api/users/{id}` | GET | Admin | Get single user profile |
| `/api/users/invite` | POST | Admin | Send Supabase email invite |
| `/api/users/{id}` | PUT | Admin | Update user profile fields |
| `/api/users/{id}` | DELETE | Admin | Deactivate user (is_active=false) |
| `/api/users/{id}/unlock-ai` | POST | Admin | Remove AI lock (clears ai_locked, reason, timestamp) |
| `/api/users/{id}/hard-delete` | DELETE | Admin | Permanently delete user (profile + auth + sandbox + n8n unlink) |
| `/api/users/drop-all` | POST | Admin | Deactivate all non-admin users |
| `/api/users/restore-all` | POST | Admin | Re-enable all users |
| `/api/system/settings/{key}` | GET | Admin | Get system setting |
| `/api/system/settings/{key}` | PUT | Admin | Update system setting |
| `/api/system/network/lockdown` | POST | Admin | Kill external networking (PIN required) |
| `/api/system/network/restore` | POST | Admin | Restore networking (PIN required) |
| `/api/users/{id}/provision-sandbox` | POST | Self or Admin | Trigger sandbox provisioning (runs script in background) |
| `/api/users/{id}/sandbox-status` | GET | Self or Admin | Poll sandbox provisioning status |
| `/api/users/{id}/profile-setup` | PUT | Self or Admin | Save onboarding profile (expertise, use case, tools, completion flag) |
| `/api/system/network/status` | GET | Admin | Current lockdown state |
| `/api/apps` | GET | Public | Dynamic app registry (id, label, category) for checkbox rendering |
| `/api/auth/config` | GET | Public | Supabase URL + anon key |
| `/api/team` | GET | Public | Agent roster from team.json |

## Database

### profiles table (extended)

| Column | Type | Purpose |
|--------|------|---------|
| `preface_prompt` | TEXT | Admin-set system preface for user messages |
| `allowed_apps` | TEXT[] | Apps this user can access |
| `allowed_agents` | TEXT[] | Agents this user can interact with |
| `invited_by` | UUID | Admin who sent the invite |
| `invited_at` | TIMESTAMPTZ | When the invite was sent |
| `last_login` | TIMESTAMPTZ | Last login timestamp |
| `sandbox_provisioned` | BOOLEAN | Whether sandbox has been created |
| `sandbox_provisioned_at` | TIMESTAMPTZ | When sandbox was provisioned |
| `sandbox_nas_path` | TEXT | NAS path (e.g., `/volume2/opai-users/Denise`) |
| `onboarding_completed` | BOOLEAN | Whether user finished onboarding wizard |
| `onboarding_completed_at` | TIMESTAMPTZ | When onboarding completed |
| `expertise_level` | TEXT | beginner/intermediate/advanced (from onboarding) |
| `primary_use_case` | TEXT | development/content/research/admin (from onboarding) |
| `notification_preferences` | JSONB | Stores tools[], focus_areas[] from onboarding |
| `ai_locked` | BOOLEAN | Whether AI access is locked (default false) |
| `ai_locked_at` | TIMESTAMPTZ | When AI was locked |
| `ai_locked_reason` | TEXT | Why AI was locked (e.g., "Malicious upload: prompt injection") |

Migration: `config/supabase-migrations/006_sandbox_fields.sql`

### system_settings table

| Key | Value Schema | Purpose |
|-----|-------------|---------|
| `users_enabled` | `{ enabled: bool }` | Global user kill switch |
| `network_locked` | `{ locked: bool, locked_at?: string, locked_by?: string }` | Network lockdown state |

Migration: `config/supabase-migrations/004_user_controls.sql`

## BoutaByte Linking

The Edit User modal includes a "BoutaByte Account" section (below Marketplace Tier) for linking OPAI users to their BoutaByte accounts and syncing tier levels.

### UI Elements

- **Link status badge**: Shows "Not Linked" (grey) or "Linked" (green) based on `bb_user_id`
- **"Link by Email" button**: Searches BB2.0 auth users by the OPAI user's email, links if found. Changes to "Re-sync Tier" when already linked
- **Tier dropdown**: Becomes read-only with a "synced from BB" badge when a BB account is linked
- **"Sync BB" header button**: Bulk action — auto-links all OPAI users by email match and syncs tiers

### Data Flow

```
User Controls → Edit User → "Link by Email"
    → GET /marketplace/api/bb/lookup?email=user@example.com
    → POST /marketplace/api/bb/link {user_id, bb_user_id}
    → BB profile fetched → tier mapped → OPAI profile updated
```

### Database Columns (profiles table)

| Column | Type | Purpose |
|--------|------|---------|
| `bb_user_id` | UUID | Linked BoutaByte user ID |
| `bb_linked_at` | TIMESTAMPTZ | When the BB link was established |

Migration: `config/supabase-migrations/011_bb_user_link.sql`

## n8n Account Linking

> **Internal Only**: n8n linking is restricted to internal team members (employees, admins). Not available to customer accounts.

The Edit User modal includes an "n8n Account" section for linking OPAI users to existing n8n accounts on the BoutaByte VPS, or provisioning new ones.

### UI Elements

- **Link status badge**: Shows "Not Linked" (grey) or "Linked: user@email.com" (green) based on `n8n_provisioned`
- **Account dropdown**: When not linked, a `<select>` dropdown lists all n8n accounts from the VPS (fetched via SSH), excluding accounts already linked to other OPAI users
- **"Link" button**: Links the selected n8n account to the OPAI user (sets `n8n_provisioned=true, n8n_username=email`)
- **"Provision New" button**: Creates a new n8n account via SSH (existing provisioning flow)
- **"Unlink" button**: Clears `n8n_provisioned` fields (shown when linked)
- **"Sync n8n" header button**: Bulk action — auto-links all OPAI users to n8n accounts by email match

### Data Flow

```
User Controls → Edit User → Select n8n account → "Link"
    → POST /marketplace/api/n8n/link {user_id, n8n_email}
    → OPAI profile updated (n8n_provisioned=true)

Header → "Sync n8n"
    → POST /marketplace/api/n8n/sync-all
    → SSH list all n8n users → match by email → bulk link
```

### API Endpoints (via Marketplace service)

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/marketplace/api/n8n/accounts` | Admin | List all n8n users from VPS SQLite (cached 60s) |
| GET | `/marketplace/api/n8n/lookup?email=X` | Admin | Find specific n8n account by email |
| POST | `/marketplace/api/n8n/link` | Admin | Link OPAI user to existing n8n account |
| POST | `/marketplace/api/n8n/sync-all` | Admin | Auto-link all OPAI users by email match |

## Dependencies

- **Supabase**: Cloud auth + profiles table + system_settings table
- **Shared auth**: `tools/shared/auth.py` (`require_admin`, `get_current_user`)
- **Auth enforced by**: [Auth & Network](../core/auth-network.md) (profile enrichment, is_active check)
- **Preface used by**: Chat services (prepends to non-admin messages)
- **Sandbox provisioning**: [Sandbox System](sandbox-system.md) (triggered during onboarding via provision-sandbox.sh) — see [Invite & Onboarding Flow](../plans/invite-onboarding-flow.md)
- **Managed by**: [Services & systemd](../core/services-systemd.md) (`opai-users` service)
- **Proxied by**: Caddy at `/users/*` (see [Auth & Network](../core/auth-network.md))
- **Portal tile**: [Portal](../core/portal.md) (User Controls card with health dot)
