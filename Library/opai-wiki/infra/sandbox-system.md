# Sandbox System (NAS-backed User Workspaces)
> Last updated: 2026-02-20 | Source: `scripts/provision-sandbox.sh`, `config/sandbox-*`, `/workspace/users/`

## Overview

Each non-admin OPAI user gets an isolated "mini-OPAI" sandbox — a personal workspace with their own AI agent team, file storage, task queue, and knowledge base. Sandboxes are backed by the **Synology DS418 NAS** (10TB+, Btrfs) mounted via NFS, and provisioned automatically during the user onboarding flow.

Dallas (admin/superuser) does NOT have a sandbox — admin access bypasses all sandboxing.

## Architecture

```
Synology DS418 NAS (192.168.2.138)
  /volume2/opai-users/
    Denise/        ← NAS folder per user
    Caitlin/
    Dallas/
        ↓ NFS v4.1 mount
OPAI Server (192.168.2.92)
  /workspace/users/
    Denise/        ← User sandbox (NFS-mounted)
    Caitlin/
    <uuid> → Denise/  ← UUID symlink for programmatic access
        ↓ scanned every 5 min
  Central Orchestrator
    picks up tasks from /workspace/users/*/tasks/queue.json
```

## Sandbox Structure

Each user sandbox at `/workspace/users/<DisplayName>/`:

```
CLAUDE.md               Source of truth — agents read this
.opai-user.json         Identity metadata (user_id, email, role, expertise)
files/                  Personal file storage (NAS-backed, Synology Drive syncable)
agents/
  team.json             User's agent roster (filtered by role)
  prompts/              Agent prompt files (reviewer.txt, researcher.txt, etc.)
scripts/
  run_agent.sh          Run a single agent (timeout-enforced, sandbox-scoped)
  run_squad.sh          Run a named squad from team.json
  submit_task.sh        Submit work to central OPAI queue
reports/latest/         Agent output
tasks/queue.json        Local task queue (orchestrator reads this)
config/sandbox.json     Limits, allowed categories, central queue path
wiki/                   Personal knowledge base (4 starter pages)
workflows/README.md     Usage guide
```

## Role-Based Defaults

Defined in `config/sandbox-defaults.json`:

| Setting | team | client | user |
|---------|------|--------|------|
| Parallel agents | 2 | 1 | 1 |
| Storage limit | 50 GB | 10 GB | 10 GB |
| Agent timeout | 300s | 120s | 120s |
| Starter agents | reviewer, researcher, features, health | reviewer, researcher | reviewer |
| Agent categories | all | quality, research | quality |

## Key Files

| File | Purpose |
|------|---------|
| `scripts/provision-sandbox.sh` | Create user sandbox end-to-end (10 steps) |
| `scripts/deprovision-sandbox.sh` | Remove user sandbox (unmount, cleanup, deactivate) |
| `scripts/setup-nfs.sh` | One-time NFS client setup (install nfs-common, mount, fstab) |
| `config/sandbox-defaults.json` | Role-based limits and starter agent definitions |
| `config/sandbox-skeleton/` | Golden template copied into each sandbox |
| `config/supabase-migrations/006_sandbox_fields.sql` | DB migration for sandbox + onboarding columns |

## Provisioning Script

`scripts/provision-sandbox.sh` performs these steps:

```bash
Usage: provision-sandbox.sh --user-id <uuid> --name <name> --email <email> \
    [--role team|client|user] [--profile-json '{"expertise_level":"..."}']
```

1. Create directory on NFS mount (`/workspace/users/<DisplayName>`)
2. Copy skeleton from `config/sandbox-skeleton/` (rsync, no-perms for NFS)
3. Generate `.opai-user.json` (identity metadata)
4. Generate `config/sandbox.json` (role-based limits from defaults)
5. Filter `agents/team.json` to role-appropriate starter agents
6. Generate `CLAUDE.md` (personalized source of truth with agent list, limits, quick start)
7. Generate `wiki/` knowledge base (4 pages: README, getting-started, agents-guide, file-storage)
8. Create UUID symlink (`/workspace/users/<uuid>` -> `/workspace/users/<DisplayName>`)
9. Update Supabase profile (`sandbox_provisioned=true`, `sandbox_path`, `sandbox_nas_path`)
10. Write provision report to `reports/<date>/provision-<name>.md`

### Important: NFS rsync flags

NFS mounts map all files to a fixed UID and reject `chgrp` calls. The rsync command uses:
```bash
rsync -rl --ignore-existing --no-perms --no-group --no-owner
```
Using `-a` (archive) will fail with "Operation not permitted" on chgrp.

## NFS Configuration

### Server Side

- **Mount point**: `/workspace/users`
- **NFS options**: `rw,soft,timeo=50,retrans=3,nfsvers=4.1,_netdev`
- **fstab entry**: `192.168.2.138:/volume2/opai-users /workspace/users nfs rw,soft,timeo=50,retrans=3,nfsvers=4.1,_netdev 0 0`
- **Setup script**: `scripts/setup-nfs.sh`

### NAS Side (Synology DSM)

- **Shared folder**: `opai-users` on Volume 2 (Btrfs)
- **NFS permissions**: IP `192.168.2.92`, Read/Write, "Map all users to admin" squash
- **Recycle Bin**: Enabled (admin-only access)

### Network

| Host | LAN IP | Tailscale IP | Tailscale Hostname |
|------|--------|-------------|-------------------|
| OPAI Server | 192.168.2.92 | 100.91.27.73 | opai-server |
| Synology NAS | 192.168.2.138 | 100.113.66.23 | ds418 |

NFS uses LAN IP for sub-millisecond latency (both on same subnet).

## Onboarding Flow

For the complete end-to-end guide covering admin invite, email template, Supabase config, and troubleshooting, see [Invite & Onboarding Flow](invite-onboarding-flow.md).

When a new user accepts their invite email:

```
1. Email "Accept Invite" → Supabase /auth/v1/verify (token verification)
2. Supabase redirects → /auth/verify?code=xxx (PKCE flow)
3. verify.html exchanges code → session created → redirect to /onboard/
4. /onboard/ — 5-step wizard:
   Step 1: Set password (with strength meter, eye toggle)
   Step 2: Storage info (NAS features, Synology Drive)
   Step 3: Profile (expertise level, use case, tools, focus areas)
   Step 4: Provisioning progress (animated checklist)
   Step 5: Outcome display (workspace tree, agent badges, app badges)
5. "Go to Dashboard" → / → Portal with available tools
```

### Verify Page (`/auth/verify`)

Handles three Supabase redirect methods:
1. **PKCE flow**: `?code=xxx` → `exchangeCodeForSession(code)` (current default)
2. **Hash fragment**: `#access_token=xxx&refresh_token=xxx` → `setSession()`
3. **Token hash**: `?token_hash=xxx&type=invite` → `verifyOtp()`
4. **Existing session**: Already authenticated → redirect to `/onboard/`

### Onboarding Wizard (`/onboard/`)

| Step | What It Does | Data Collected |
|------|-------------|----------------|
| 1. Password | `sb.auth.updateUser({ password })` | New password |
| 2. Storage | Informational (NAS features, sync options) | None |
| 3. Profile | Option card grids (single + multi-select) | expertise_level, primary_use_case, tools[], focus_areas[] |
| 4. Provisioning | Calls provision API, polls status | None (server-side) |
| 5. Outcome | Shows workspace tree, agents, apps | None (display only) |

### Post-Onboarding Portal Redirect

In `index.html`, after login:
1. Check `user.app_metadata.role` — admin skips onboarding check
2. Fetch `/onboard/status` → checks `profiles.onboarding_completed`
3. If `false` → redirect to `/onboard/`
4. If `true` → show dashboard with tool cards

## API Endpoints

### Monitor API (`tools/opai-monitor/routes_users.py`)

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/users/{id}/provision-sandbox` | POST | Self or Admin | Trigger provisioning (runs script in background) |
| `/api/users/{id}/sandbox-status` | GET | Self or Admin | Poll provisioning completion |
| `/api/users/{id}/profile-setup` | PUT | Self or Admin | Save onboarding answers + completion flag |

### Portal API (`tools/opai-portal/app.py`)

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/auth/verify` | GET | Public | Serve invite token verification page |
| `/onboard/` | GET | Public | Serve onboarding wizard |
| `/onboard/status` | GET | Bearer | Check if user completed onboarding |

## Database Schema

### profiles table (sandbox columns)

Added by `config/supabase-migrations/006_sandbox_fields.sql`:

| Column | Type | Purpose |
|--------|------|---------|
| `sandbox_provisioned` | BOOLEAN | Whether sandbox has been created |
| `sandbox_provisioned_at` | TIMESTAMPTZ | When sandbox was provisioned |
| `sandbox_nas_path` | TEXT | NAS path (e.g., `/volume2/opai-users/Denise`) |
| `onboarding_completed` | BOOLEAN | Whether user finished the wizard |
| `onboarding_completed_at` | TIMESTAMPTZ | When onboarding completed |
| `expertise_level` | TEXT | beginner/intermediate/advanced |
| `primary_use_case` | TEXT | development/content/research/admin |
| `notification_preferences` | JSONB | Stores tools[], focus_areas[] from onboarding |

## Orchestrator Integration

The central orchestrator scans user sandboxes every 5 minutes (`user_sandbox_scan` schedule in `config/orchestrator.json`).

`scanUserSandboxes()` in `tools/opai-orchestrator/index.js`:
1. Reads `/workspace/users/*/tasks/queue.json` for pending tasks
2. Validates against per-user limits (`config/sandbox.json`)
3. Checks global `max_parallel_jobs: 3` (user jobs count toward this)
4. Picks up task → sets `in_progress` in user queue → creates entry in central `tasks/registry.json`
5. Executes within user's sandbox directory
6. Writes reports to user's `reports/` dir
7. Updates both queues on completion

Config in `config/orchestrator.json`:
```json
"sandbox": {
    "scan_root": "/workspace/users",
    "max_user_jobs_parallel": 2,
    "timeout_seconds": 300,
    "enabled": true
}
```

## Application Isolation

- **Chat** (`tools/opai-chat/config.py`): `USERS_ROOT` added to `ALLOWED_ROOTS` — non-admins scoped to `/workspace/users/<their-uuid>/`
- **Files** (`tools/opai-files/`): Non-admins see only their sandbox in the file manager
- **Auth** (`tools/shared/auth.py`): `AuthUser` enriched with `sandbox_path` and `onboarding_completed`
- **Agents**: `run_agent.sh` uses `timeout`, `ulimit`, explicit working directory
- **NFS UID mapping**: All mounts map to dallas (UID 1000). Users have no shell access.

## Gotchas

1. **rsync on NFS**: Must use `--no-perms --no-group --no-owner` or it fails with chgrp errors
2. **Portal needs SUPABASE_SERVICE_KEY**: The `/onboard/status` endpoint queries Supabase with the service key — without it, `onboarded` always returns `false` and users get stuck in an onboarding redirect loop
3. **Supabase invite PKCE flow**: Modern Supabase redirects with `?code=xxx` (not `token_hash` or hash fragment) — verify.html must handle `exchangeCodeForSession()`
4. **Display names are capitalized**: Sandbox dirs use `DisplayName` (e.g., `Denise`), not lowercase. The provision script capitalizes via `sed 's/\b\(.\)/\u\1/g'`
5. **UUID symlinks**: Each user has both `/workspace/users/Denise/` (human-readable) and `/workspace/users/<uuid>` (symlink for programmatic access)
6. **NAS squash**: Synology DSM NFS UI doesn't have raw UID/GID fields — use "Map all users to admin" in the Squash dropdown

## Dependencies

- **Synology DS418 NAS**: Btrfs storage, NFS server, Synology Drive (optional client sync)
- **NFS v4.1**: `nfs-common` package on server, `nfsvers=4.1` mount option
- **Supabase**: profiles table, auth invite flow, service key for admin operations
- **Provisioned by**: [Portal](portal.md) onboarding wizard → [Monitor](monitor.md) provision API → `provision-sandbox.sh`
- **Scanned by**: [Orchestrator](orchestrator.md) (`scanUserSandboxes` every 5 min)
- **Isolated by**: [Auth & Network](auth-network.md) (role-based path scoping)
- **User management**: [User Controls](user-controls.md) (invite, role assignment)
