# Invite & Onboarding Flow
> Last updated: 2026-02-20 | Source: `tools/opai-portal/`, `tools/opai-monitor/routes_users.py`, `config/supabase-email-templates/invite.html`

## Overview

Complete end-to-end flow for inviting a new user to OPAI and getting them from zero to a fully provisioned workspace. Covers admin invite, Supabase email delivery, PKCE token verification, 5-step onboarding wizard, NAS sandbox provisioning, and post-onboarding dashboard access.

## Flow Diagram

```
Admin (User Controls)                    Supabase                    New User
       │                                    │                           │
  1. POST /api/users/invite ──────────────► │                           │
       │ (email, name, role,                │                           │
       │  custom_message,                   │                           │
       │  tailscale_invite)                 │                           │
       │                                    │   2. Send branded email   │
       │                                    │ ─────────────────────────►│
       │                                    │                           │
       │                                    │   3. User clicks          │
       │                                    │      "Accept Invite"      │
       │                                    │◄──────────────────────────│
       │                                    │                           │
       │                           4. Token verification                │
       │                              /auth/v1/verify                   │
       │                                    │                           │
       │                           5. PKCE redirect                     │
       │                              /auth/verify?code=xxx ───────────►│
       │                                    │                           │
       │                                    │   6. exchangeCodeForSession
       │                                    │◄──────────────────────────│
       │                                    │                           │
       │                                    │   7. Session created      │
       │                                    │ ─────────────────────────►│
       │                                    │                           │
       │                                    │   8. Redirect to /onboard/│
       │                                    │                           │
       │                                    │   9. 5-step wizard        │
       │                                    │      (password, storage,  │
       │                                    │       profile, provision, │
       │                                    │       outcome)            │
       │                                    │                           │
       │                                    │  10. Redirect to /        │
       │                                    │      (Portal dashboard)   │
```

---

## Step-by-Step Guide

### 1. Admin Sends Invite

**Where**: User Controls panel at `/users/` (admin-only)

**UI Flow**:
1. Click "Invite User" button in the top bar
2. Fill in the invite modal:
   - **Email** (required): New user's email address
   - **Display Name** (optional): Defaults to email prefix if blank
   - **Role** (dropdown): `admin` or `user` (default: `user`)
   - **Tailscale Invite Link** (optional): Pre-generated Tailscale invite URL
   - **Custom Message** (optional): Personal note shown in the invite email
   - **Preface Prompt** (optional): Admin-set system context prepended to user's AI messages
   - **Allowed Apps** (multi-select): Which OPAI services the user can access
3. Click "Send Invite"

**API Call**:
```
POST /users/api/users/invite
Authorization: Bearer <admin JWT>
Content-Type: application/json

{
    "email": "denise@example.com",
    "display_name": "Denise",
    "role": "user",
    "tailscale_invite": "https://login.tailscale.com/...",
    "custom_message": "Welcome to the team!",
    "preface_prompt": "",
    "allowed_apps": ["chat", "files", "messenger"]
}
```

**Backend** (`tools/opai-monitor/routes_users.py`):
1. Validates admin JWT via `require_admin` dependency
2. Calls Supabase Admin API: `POST {SUPABASE_URL}/auth/v1/invite`
3. Passes `data` object with `display_name`, `role`, `invited_by`, `tailscale_invite`, `custom_message`
4. Supabase creates `auth.users` entry (status: `invited`) and sends the email
5. If `preface_prompt` or `allowed_apps` provided, updates `public.profiles` via service key
6. Returns `{ "message": "Invite sent", "user_id": "..." }`

**What Supabase does**:
- Creates user in `auth.users` with `is_sso_user=false`, `invited_at` timestamp
- Triggers `on_auth_user_created` → auto-creates `public.profiles` row from user metadata
- Generates a confirmation token and sends the invite email using the configured template

### 2. Email Delivery

**Template**: `config/supabase-email-templates/invite.html`

**Configuration**: Paste the template into Supabase Dashboard > Authentication > Email Templates > Invite User

The email uses OPAI branding (dark theme, purple accents) and includes:

| Section | Content |
|---------|---------|
| Header | OPAI logo, "You're Invited to OPAI" |
| Greeting | "Hello {{ .Data.display_name }}" |
| Custom message | Admin's personal note (if provided) — purple left-border quote block |
| Step 1 | Install Tailscale — download link |
| Step 2 | Join OPAI Network — Tailscale invite button (if link provided) or "admin will send link" |
| Step 3 | Accept Invite — **{{ .ConfirmationURL }}** button (triggers the auth flow) |
| Step 4 | Login URL — `https://opai-server.tail856df6.ts.net` with cert warning note |
| Footer | Help text ("Reply to this email or contact your administrator") |

**Available template variables** (set by the invite API):
| Variable | Source | Purpose |
|----------|--------|---------|
| `{{ .ConfirmationURL }}` | Supabase auto-generated | Token verification URL (Step 3 button) |
| `{{ .Data.display_name }}` | `data.display_name` from invite | Greeting name |
| `{{ .Data.role }}` | `data.role` from invite | Assigned role |
| `{{ .Data.custom_message }}` | `data.custom_message` from invite | Personal note |
| `{{ .Data.tailscale_invite }}` | `data.tailscale_invite` from invite | VPN join link |
| `{{ .Data.invited_by }}` | `data.invited_by` (admin UUID) | Audit trail |

### 3. Prerequisites (Before Clicking Accept)

The user must complete these steps BEFORE clicking "Accept Invite":

1. **Install Tailscale** on their device (link in email)
2. **Join the OPAI Tailscale network** (via invite link or admin manual approval)
3. **Verify VPN connectivity**: Can reach `opai-server` via Tailscale hostname

Without Tailscale connected, the PKCE redirect will fail because Supabase redirects to `https://opai-server.tail856df6.ts.net/auth/verify?code=xxx` which is only reachable over the VPN.

### 4. Token Verification (PKCE Flow)

When the user clicks "Accept Invite" in the email:

```
1. Browser opens: {SUPABASE_URL}/auth/v1/verify?token=xxx&type=invite&redirect_to={SITE_URL}/auth/verify
2. Supabase validates token, marks user as confirmed
3. Supabase redirects to: https://opai-server.tail856df6.ts.net/auth/verify?code=xxx (PKCE)
4. Caddy proxies /auth/verify to Portal (:8090)
5. Portal serves verify.html
```

**Supabase redirect URL configuration**:
- **Site URL**: Set in Supabase Dashboard > Authentication > URL Configuration
- Must point to `https://opai-server.tail856df6.ts.net`
- **Redirect URLs**: Add `https://opai-server.tail856df6.ts.net/auth/verify` to the allowed list

### 5. Verify Page (`/auth/verify`)

**File**: `tools/opai-portal/static/verify.html`

The verify page handles multiple Supabase redirect methods for maximum compatibility:

| Priority | Method | URL Pattern | Handler |
|----------|--------|-------------|---------|
| 1 | **PKCE flow** (current default) | `?code=xxx` | `sb.auth.exchangeCodeForSession(code)` |
| 2 | Hash fragment | `#access_token=xxx&refresh_token=xxx` | `sb.auth.setSession()` |
| 3 | Token hash | `?token_hash=xxx&type=invite` | `sb.auth.verifyOtp()` |
| 4 | Existing session | (no params) | `sb.auth.getSession()` |

On success: Sets session in localStorage and redirects to `/onboard/`.

On failure: Shows error message (e.g., "Code expired", "Invalid token").

### 6. Onboarding Wizard (`/onboard/`)

**Files**: `tools/opai-portal/static/onboard.html`, `tools/opai-portal/static/js/onboard.js`

The wizard runs client-side with Supabase JS. It checks for an active session first — if none, redirects to `/auth/login`.

**Early exit check**: Before showing any step, the wizard checks if `onboarding_completed === true` in the user's profile. If already complete, it redirects straight to `/` (the portal dashboard).

#### Step 1: Set Password

- Two password fields (new + confirm) with eye toggle for visibility
- Calls `sb.auth.updateUser({ password })` to set the user's password
- This replaces the invite token-based session with a password-based one
- Validates: minimum 6 characters, fields must match

#### Step 2: Storage Information

- Informational only (no data collected)
- Explains NAS-backed storage, Synology Drive sync option
- Shows the user's allocated storage quota (from role defaults)
- User clicks "Next" to continue

#### Step 3: Profile Setup

- **Expertise Level** (single-select cards): Beginner, Intermediate, Advanced
- **Primary Use Case** (single-select cards): Development, Content Creation, Research, Administration
- **Preferred Tools** (multi-select grid): Code Review, Writing, Research, Automation, Design, Analytics
- **Focus Areas** (multi-select grid): Quality, Performance, Security, AI/ML, Documentation, Testing

Data saved via `PUT /users/api/users/{id}/profile-setup`:
```json
{
    "expertise_level": "beginner",
    "primary_use_case": "content",
    "tools": ["writing", "research"],
    "focus_areas": ["quality", "documentation"],
    "onboarding_completed": false
}
```

Stored in Supabase `profiles`:
- `expertise_level` → TEXT column
- `primary_use_case` → TEXT column
- `tools[]` and `focus_areas[]` → merged into `notification_preferences` JSONB column

#### Step 4: Workspace Provisioning

- Calls `POST /users/api/users/{id}/provision-sandbox` to trigger provisioning
- Shows animated checklist with progress indicators:
  - Creating workspace directory
  - Installing AI agents
  - Setting up file storage
  - Configuring permissions
  - Generating documentation
- Polls `GET /users/api/users/{id}/sandbox-status` every 2 seconds until complete
- Server runs `scripts/provision-sandbox.sh` in background (see [Sandbox System](sandbox-system.md))

#### Step 5: Outcome Display

- Shows what was created:
  - **Workspace tree**: Visual directory listing of the sandbox
  - **Agent badges**: Which AI agents were installed (role-dependent)
  - **App badges**: Which OPAI services the user can access
- Marks onboarding complete: `PUT /users/api/users/{id}/profile-setup { "onboarding_completed": true }`
  - Retries up to 3 times if the request fails
- "Go to Dashboard" button → redirects to `/`

### 7. Post-Onboarding: Portal Dashboard

When the user arrives at `/` after onboarding:

1. `index.html` loads, fetches `/auth/config`, creates Supabase client
2. Gets session from localStorage
3. Checks `user.app_metadata.role`:
   - **Admin**: Shows full admin dashboard (10+ service tiles)
   - **Non-admin**: Fetches `/onboard/status` to verify `onboarding_completed`
     - `false` → redirect back to `/onboard/`
     - `true` → show user dashboard (Chat, Messenger, My Files tiles)

The user can now access their allowed services. Their sandbox is ready at `/workspace/users/<DisplayName>/`.

---

## Supabase Configuration Checklist

Settings that must be configured in the Supabase Dashboard for the invite flow to work:

| Setting | Location | Value |
|---------|----------|-------|
| Site URL | Auth > URL Configuration | `https://opai-server.tail856df6.ts.net` |
| Redirect URLs | Auth > URL Configuration | `https://opai-server.tail856df6.ts.net/auth/verify` |
| Invite template | Auth > Email Templates > Invite User | Contents of `config/supabase-email-templates/invite.html` |
| SMTP | Auth > SMTP Settings | Configured email provider (or use Supabase built-in) |
| Enable email signup | Auth > Providers > Email | Enabled |
| PKCE flow | Auth > Advanced | Enabled (default in Supabase v2) |

**Supabase project**: `idorgloobxkmlnwnxbej` (OPAI Agent System)

---

## Re-Inviting Existing Users

Supabase does NOT allow re-inviting a user whose email already exists (returns 422 `email_exists`). Options:

1. **Admin generates a magic link**: Use `POST /auth/v1/admin/generate_link` with the service key:
   ```bash
   curl -X POST "{SUPABASE_URL}/auth/v1/admin/generate_link" \
     -H "apikey: {ANON_KEY}" \
     -H "Authorization: Bearer {SERVICE_KEY}" \
     -H "Content-Type: application/json" \
     -d '{"email":"user@example.com","type":"invite","redirect_to":"https://opai-server.tail856df6.ts.net/auth/verify"}'
   ```
   This returns an `action_link` URL that can be sent manually.

2. **Reset onboarding**: If the user account exists but needs to re-onboard:
   - Admin updates profile in User Controls: set `onboarding_completed = false`, `sandbox_provisioned = false`
   - User logs in normally → gets redirected to `/onboard/`

3. **Delete and re-create**: In Supabase Dashboard > Authentication > Users, delete the user, then send a fresh invite from OPAI User Controls.

---

## How to Add the Email Template to Supabase

1. Open Supabase Dashboard for project `idorgloobxkmlnwnxbej`
2. Navigate to **Authentication** > **Email Templates**
3. Select the **Invite User** tab
4. Copy the contents of `config/supabase-email-templates/invite.html`
5. Paste into the template editor (HTML mode)
6. Set the **Subject** to something like: `You're Invited to OPAI`
7. Click **Save**

The template uses Go template syntax (`{{ .ConfirmationURL }}`, `{{ .Data.display_name }}`, etc.) which Supabase processes server-side before sending.

---

## Environment Variables

These must be set for the invite and onboarding flow to work:

### Portal (`tools/opai-portal/.env`)

| Var | Purpose |
|-----|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Public key (for frontend Supabase JS client) |
| `SUPABASE_SERVICE_KEY` | Service role key (**required** for `/onboard/status` endpoint) |
| `SUPABASE_JWT_SECRET` | JWT secret for HS256 fallback auth |

### Monitor / User Controls (`tools/opai-monitor/.env`)

| Var | Purpose |
|-----|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Public key |
| `SUPABASE_SERVICE_KEY` | Service role key (for invite API + profile updates) |

---

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-monitor/routes_users.py` | Backend: invite API, provision endpoints, profile setup |
| `tools/opai-portal/app.py` | Portal: serves verify, onboard pages, onboard/status check |
| `tools/opai-portal/static/verify.html` | PKCE token exchange page |
| `tools/opai-portal/static/onboard.html` | 5-step onboarding wizard (HTML + CSS) |
| `tools/opai-portal/static/js/onboard.js` | Wizard logic (Supabase auth, profile save, provision trigger) |
| `tools/opai-portal/static/login.html` | Login page (password eye toggle) |
| `tools/opai-portal/static/style.css` | Shared styles (login, onboard, password toggle) |
| `tools/opai-portal/static/js/auth.js` | Frontend auth client (session management) |
| `tools/opai-users/static/app.js` | User Controls UI (invite modal) |
| `config/supabase-email-templates/invite.html` | Branded invite email template |
| `config/supabase-migrations/006_sandbox_fields.sql` | DB migration for onboarding columns |
| `scripts/provision-sandbox.sh` | Sandbox provisioning script (called during onboarding) |

---

## Troubleshooting

### "No verification token found"
- **Cause**: verify.html received no `?code=`, `?token_hash=`, or `#access_token=` parameter
- **Fix**: Ensure Supabase Site URL and Redirect URLs are configured correctly (see checklist above)
- **Check**: The `{{ .ConfirmationURL }}` in the email should point to Supabase's `/auth/v1/verify` endpoint

### User stuck in onboarding redirect loop
- **Cause**: Portal's `.env` is missing `SUPABASE_SERVICE_KEY`
- **How**: `/onboard/status` endpoint can't query profiles without the service key, so it returns `{ onboarded: false }` every time
- **Fix**: Add `SUPABASE_SERVICE_KEY=xxx` to `tools/opai-portal/.env` and restart the portal service
- **Verify**: `curl -H "Authorization: Bearer <token>" http://127.0.0.1:8090/onboard/status` should return `{ "onboarded": true }`

### Invite email not received
- **Check**: Supabase Dashboard > Authentication > Users — user should appear with status "Invited"
- **Check**: Supabase email rate limits (default: 3/hour for free tier)
- **Check**: Spam folder
- **Check**: SMTP settings in Supabase Dashboard > Authentication > SMTP Settings

### 422 "email_exists" when re-inviting
- **Cause**: Supabase doesn't allow re-inviting existing users via the invite endpoint
- **Fix**: Use `admin/generate_link` API (see "Re-Inviting Existing Users" above) or delete and re-create

### PKCE code expired
- **Cause**: User waited too long to click the invite link, or clicked it twice
- **Fix**: Re-send the invite (new token generated each time)

### Sandbox not provisioned (missing CLAUDE.md)
- **Cause**: `rsync -a` fails on NFS due to `chgrp` permission errors, and `set -e` in the script causes early exit
- **Fix**: The provisioning script uses `rsync -rl --no-perms --no-group --no-owner` — if files are missing, re-run provisioning by resetting `sandbox_provisioned = false` and re-triggering from User Controls
- **See**: [Sandbox System](sandbox-system.md) for full provisioning details

### Tailscale not connected
- **Symptom**: "Accept Invite" link in email goes nowhere or times out
- **Cause**: User hasn't installed/connected Tailscale, so `opai-server.tail856df6.ts.net` is unreachable
- **Fix**: User must complete Steps 1-2 in the email (install Tailscale, join network) before clicking Step 3

---

## Dependencies

- **Supabase**: Cloud auth, email delivery, user management, profiles table
- **Portal**: [Portal](portal.md) serves verify.html, onboard pages, onboard/status check
- **Monitor API**: [Monitor](monitor.md) provides invite, provision, profile-setup endpoints (shared via `routes_users.py`)
- **User Controls**: [User Controls](user-controls.md) provides the admin invite UI
- **Sandbox System**: [Sandbox System](sandbox-system.md) provisioned during Step 4
- **Auth & Network**: [Auth & Network](auth-network.md) manages JWT validation, Caddy routing, Tailscale VPN
- **Tailscale**: VPN mesh required for user to reach OPAI server
- **Caddy**: Reverse proxy routes `/auth/verify` and `/onboard/` to Portal
