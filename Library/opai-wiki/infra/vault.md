# OPAI Vault — Encrypted Credential Management

> **Port**: 8105 | **Path**: `/vault/` | **Dir**: `tools/opai-vault/`

## Purpose

OPAI Vault is the encrypted credential store and broker for all OPAI services. It replaces the scattered plaintext `.env` files and `notes/Access/` markdown files with a single SOPS+age encrypted vault.

**Key design principle**: AI agents can never see raw credential values. They interact with services that internally fetch credentials from the vault. The vault is localhost-only, admin-only, and audit-logged.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  AI Agent (Claude Code)                             │
│  Can: call service APIs, read masked secret lists   │
│  Cannot: read raw values, access vault directly     │
└────────────────────┬────────────────────────────────┘
                     │ uses service endpoints
                     ▼
┌─────────────────────────────────────────────────────┐
│  OPAI Services (billing, helm, chat, etc.)          │
│  Load secrets at startup via:                       │
│    Option A: vault-env.sh → tmpfs EnvironmentFile   │
│    Option B: vault API (service-to-service auth)    │
└────────────────────┬────────────────────────────────┘
                     │ authenticated request
                     ▼
┌─────────────────────────────────────────────────────┐
│  OPAI Vault (FastAPI, port 8105)                    │
│  - Localhost-only middleware                         │
│  - Admin auth required for all operations           │
│  - Audit logging on every access                    │
└────────────────────┬────────────────────────────────┘
                     │ SOPS decrypt
                     ▼
┌─────────────────────────────────────────────────────┐
│  secrets.enc.yaml (SOPS + age encrypted)            │
│  - Keys readable, values AES-256-GCM encrypted      │
│  - Safe to commit to git                            │
│  - Decryption requires age private key              │
└─────────────────────────────────────────────────────┘
```

## Encryption Stack

| Layer | Tool | Purpose |
|-------|------|---------|
| Encryption algorithm | AES-256-GCM | Per-value encryption |
| Key wrapping | age (v1.2.1) | Modern, simple, no GPG dependency |
| File format | SOPS (v3.9.4) | Encrypts values only, keeps keys readable |
| Key storage | `~/.opai-vault/vault.key` | age keypair, chmod 0600 |

## Secret Organization

```yaml
# secrets.enc.yaml structure (keys visible, values encrypted)
shared:                         # Used by ALL services
  SUPABASE_URL: ENC[...]
  SUPABASE_ANON_KEY: ENC[...]
  SUPABASE_SERVICE_KEY: ENC[...]
  SUPABASE_JWT_SECRET: ENC[...]

services:                       # Per-service secrets
  opai-billing:
    STRIPE_SECRET_KEY: ENC[...]
    STRIPE_WEBHOOK_SECRET: ENC[...]
  opai-helm:
    HOSTINGER_API_KEY: ENC[...]
    GODADDY_API_KEY: ENC[...]
  discord-bridge:
    DISCORD_BOT_TOKEN: ENC[...]

credentials:                    # Named credentials (from notes/Access/)
  stripe-boutabyte/LIVE_SECRET: ENC[...]
  hostinger/SSH_PASSWORD: ENC[...]
```

When a service requests its secrets, it receives `shared` + `services.<name>` merged together. Shared keys provide the base; service-specific keys override.

## CLI Usage

```bash
# Alias for convenience
alias vault='/workspace/synced/opai/tools/opai-vault/scripts/vault-cli.sh'

# List all secrets (values masked)
vault list

# Get a specific secret
vault get STRIPE_SECRET_KEY

# Set a secret
vault set MY_NEW_KEY "the-value"

# Generate .env for a service (stdout)
vault env opai-billing

# Export .env to a file
vault export opai-billing /tmp/billing.env

# Show vault statistics
vault stats

# Edit secrets interactively (opens in $EDITOR)
vault edit

# Import all .env files (first-time migration)
vault import
vault import --dry-run

# Import notes/Access/ credentials
vault import-access
vault import-access --dry-run

# Backup encrypted file
vault backup
```

## API Endpoints

All endpoints require admin authentication (Supabase JWT or service key).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/vault/api/health` | Health check |
| GET | `/vault/api/secrets` | List all secret names (masked) |
| GET | `/vault/api/secrets/{name}` | Get a single secret value |
| PUT | `/vault/api/secrets/{name}` | Create/update a secret |
| DELETE | `/vault/api/secrets/{name}` | Delete a secret |
| GET | `/vault/api/service/{name}/env` | Generate .env for a service |
| GET | `/vault/api/service/{name}/secrets` | Get all service secrets (with values) |
| POST | `/vault/api/reload` | Force reload from encrypted file |
| GET | `/vault/api/stats` | Vault + audit statistics |
| GET | `/vault/api/audit` | View audit log entries |

## systemd Integration

### Option A: Pre-start decryption to tmpfs (active — 24 services migrated)

```ini
[Service]
EnvironmentFile=-/workspace/synced/opai/tools/<service>/.env    # fallback (loaded first)
ExecStartPre=-/workspace/synced/opai/tools/opai-vault/scripts/vault-env.sh <vault-name>
EnvironmentFile=-%t/opai-vault/<vault-name>.env                  # vault (overrides, loaded last)
ExecStart=/usr/bin/python3 -m uvicorn app:app --host 127.0.0.1 --port XXXX
```

The `-` prefix on `ExecStartPre` means soft-fail: if vault is unavailable, the service still starts from its original `.env`. The `%t` expands to `$XDG_RUNTIME_DIR` (`/run/user/1000`).

The `vault-env.sh` script:
1. Decrypts `secrets.enc.yaml` using the age key
2. Extracts shared + service-specific keys
3. Writes to `$XDG_RUNTIME_DIR/opai-vault/<service>.env` (tmpfs — RAM only, never touches disk)
4. Sets file permissions to 0600

### Option B: Runtime API fetch

Services can also fetch secrets at runtime via the vault API, using the Supabase service key for auth.

### MCP Server Integration

MCP servers use `mcp-with-vault.sh` to inject credentials from the vault at launch:

```json
{
  "clickup": {
    "command": "/workspace/synced/opai/tools/opai-vault/scripts/mcp-with-vault.sh",
    "args": ["clickup", "node", "/path/to/mcp/index.js"]
  }
}
```

The wrapper decrypts vault, exports env vars for the named service, then `exec`s the real MCP binary.

## Web UI

The Vault has a browser-based credential viewer/manager at `/vault/`. It runs as part of the existing FastAPI service (port 8105) — no separate process.

### Auth System

The Web UI has its own auth layer, independent of the Supabase JWT used for service-to-service API calls:

| Auth Method | Flow |
|-------------|------|
| **PIN** (primary) | 4-6 digit PIN → bcrypt verify → signed JWT session cookie |
| **WebAuthn/FIDO2** (bypass) | Hardware security key (UF2) → WebAuthn challenge → JWT session cookie (skips PIN) |

Both methods produce the same session cookie: `HttpOnly; Secure; SameSite=Strict; Path=/vault/; Max-Age=1800`.

**Session**: HS256 JWT with a vault-specific 256-bit random secret (stored in `data/auth.json`, NOT the Supabase JWT secret). 30-minute sliding window — each API call extends the TTL.

**Rate limiting**: 5 PIN attempts, then 60-second lockout. All failures audited.

**First-time setup**: If no `auth.json` exists, the UI shows a "Set Your PIN" form. After setting, the user is logged in.

### Web UI Screens

**Auth Gate** (centered card):
- VT badge with green accent
- Status indicator (age key present: green dot)
- 6-box PIN pad with auto-advance, auto-submit on 6th digit, paste support
- "Use Security Key" button (if WebAuthn registered)
- Rate-limit feedback ("Too many attempts, wait 60s")

**Vault Browser** (post-auth):
- **Top bar**: VT badge, "OPAI Vault", stats count, Add Secret button, Register Key button, Lock button
- **Search bar**: Full-width, filters across all secret names live
- **Section accordions** (all collapsed by default, auto-expand on search):
  - Shared — flat list
  - Services — nested sub-accordions per service
  - Credentials — flat list
- **Each secret row**: monospace name, masked value, eye toggle (reveal 10s then auto-mask), copy button, delete button
- **Add Secret modal**: section picker (Shared/Credentials/Service), service dropdown (existing + new), key name, value textarea
- **Inactivity timer**: Warning bar at 29 min, auto-lock at 30 min

### Web UI Endpoints

All prefixed with `/vault/api/`. Auth and UI endpoints use vault session (cookie), NOT Supabase JWT.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/status` | None | Returns age_key_present, pin_configured, webauthn status, session validity |
| POST | `/auth/pin/setup` | None | Set initial PIN or change (requires current PIN) |
| POST | `/auth/pin/verify` | None | Verify PIN → sets session cookie. Rate-limited |
| POST | `/auth/lock` | Session | Invalidates session, clears cookie |
| POST | `/auth/webauthn/register/options` | Session | Returns PublicKeyCredentialCreationOptions |
| POST | `/auth/webauthn/register/verify` | Session | Stores credential in auth.json |
| POST | `/auth/webauthn/login/options` | None | Returns PublicKeyCredentialRequestOptions |
| POST | `/auth/webauthn/login/verify` | None | Verifies assertion → sets session cookie |
| GET | `/ui/secrets` | Session | All secrets organized by section (values masked) |
| POST | `/ui/reveal` | Session | Body: `{ name, section?, service? }` → `{ value }`. Audited |
| POST | `/ui/secrets/add` | Session | Body: `{ name, value, section?, service? }` → adds to encrypted store |
| POST | `/ui/secrets/delete` | Session | Body: `{ name, section?, service? }` → removes from encrypted store |

### WebAuthn (FIDO2/UF2)

- **Library**: `webauthn` v2.7.1 (Python)
- **RP ID**: Dynamic from request hostname (strips port)
- **Authenticator**: `cross-platform` attachment (external hardware keys), `residentKey: discouraged`
- **Registration**: Requires active session (must log in via PIN first), then "Register Key" button in topbar
- **Login**: "Use Security Key" button on PIN screen, bypasses PIN entirely
- **Credentials**: Stored in `data/auth.json` with public key + sign count

### Web UI Theme

- Dark: `--bg: #0d0d0f`, `--surface: #16161a`, `--border: #2a2a35`
- Green accent: `--accent: #22c55e`
- Monospace values: JetBrains Mono / Fira Code fallback
- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'` (`unsafe-inline` required for navbar.js injected styles)

## Per-User Vault (Standalone)

Each authenticated user gets their own personal encrypted vault at `/vault/my/`, completely isolated from the admin system vault at `/vault/`.

### Architecture

```
┌──────────────────────────────────────────────────────┐
│  User (browser)                                       │
│  1. Supabase JWT auth (portal login)                  │
│  2. Per-user PIN auth (4-6 digit, bcrypt hashed)      │
│  3. Encrypted secrets (AES-256-GCM, HKDF per user)   │
└──────────────┬───────────────────────────────────────┘
               │
       ┌───────┴────────┐
       │  /vault/my/    │  Standalone SPA (user-vault.html)
       │  State machine:│  loading → setup-pin → locked → browser
       └───────┬────────┘
               │ Two-layer auth
               ▼
┌──────────────────────────────────────────────────────┐
│  Layer 1: Supabase JWT (Authorization header)         │
│  → Identifies the user, fetched via Supabase JS SDK   │
│                                                       │
│  Layer 2: PIN session cookie (user_vault_session)     │
│  → Proves user unlocked their vault with their PIN    │
│  → HttpOnly, Secure, SameSite=Strict, Path=/vault/   │
│  → 30-min expiry, HS256 JWT with scope=user_vault    │
└──────────────────────────────────────────────────────┘
```

### Auth Flow

1. User visits `/vault/my/` → SPA fetches `/vault/api/user/auth/config` (public, returns Supabase URL + anon key)
2. SPA creates Supabase client → `getSession()` → if no session, redirect to `/auth/login?return=/vault/my/`
3. SPA calls `GET /vault/api/user/pin/status` with JWT → returns `{ pin_configured, locked, locked_seconds }`
4. First-time: PIN setup screen (4-6 digits, confirm) → `POST /vault/api/user/pin/setup`
5. Return visit: PIN entry (6-digit pad, auto-submit) → `POST /vault/api/user/pin/verify`
6. On success: `user_vault_session` cookie set → SPA loads secrets from `/vault/api/user/secrets`

### PIN Storage

Supabase table `user_vault_pins` (migration `042_user_vault_pins.sql`):

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | UUID PK | References `auth.users(id)` |
| `pin_hash` | TEXT | bcrypt cost default |
| `failed_attempts` | INT | Resets on success |
| `locked_until` | TIMESTAMPTZ | Set after 5 failures |

RLS: `auth.uid() = user_id` — users can only see/modify their own PIN row.

### Secret Encryption

User secrets are encrypted per-user using `user_vault_crypto.py`:
- Master key from vault (`MASTER_KEY` env var or generated)
- HKDF derives a unique AES-256 key per `user_id`
- Each secret: AES-256-GCM with random 12-byte nonce
- Stored in Supabase `user_vault_secrets` table (RLS: user sees only own rows)

### User Vault API

All endpoints under `/vault/api/user/`. PIN endpoints require Supabase JWT. Secret CRUD requires JWT + `user_vault_session` cookie.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/pin/status` | JWT | PIN configured? Locked? Remaining seconds? |
| POST | `/pin/setup` | JWT | Set PIN (4-6 digits) → sets session cookie |
| POST | `/pin/verify` | JWT | Verify PIN → sets session cookie. 5 attempts, 60s lockout |
| POST | `/pin/lock` | JWT | Clear session cookie |
| GET | `/auth/config` | None | Returns `{ supabase_url, supabase_anon_key }` |
| GET | `/secrets` | JWT + PIN | List all user's secrets |
| GET | `/secrets/{name}` | JWT + PIN | Get a specific secret |
| PUT | `/secrets/{name}` | JWT + PIN | Create/update a secret |
| DELETE | `/secrets/{name}` | JWT + PIN | Delete a secret |
| GET | `/audit` | JWT + PIN | User's vault audit log |
| GET | `/stats` | JWT + PIN | User's vault statistics |

### User Vault SPA

Standalone SPA at `/vault/my/` (3 files in `tools/opai-vault/static/`):

| File | Purpose |
|------|---------|
| `user-vault.html` | HTML shell — loads Supabase JS SDK, navbar.js, user-vault.css/js |
| `user-vault.js` | State machine SPA: auth, PIN setup/verify, secret browser, 30-min auto-lock |
| `user-vault.css` | Self-contained dark theme (same design language as admin vault) |

**UI features**: Dark theme with green accent, PIN pad with 6-digit auto-submit, top bar with user email + secret count + lock button, search input, secrets grouped by category with colored badges, reveal (10s auto-mask), copy, delete with confirmation, add secret modal, audit log modal, 30-min inactivity auto-lock with warning bar, session expiry → redirect to PIN screen.

### User vs Admin Vault Separation

| Aspect | Admin Vault (`/vault/`) | User Vault (`/vault/my/`) |
|--------|------------------------|--------------------------|
| Purpose | System-wide credentials (services, APIs) | Personal user secrets |
| Auth | PIN + WebAuthn (local `auth.json`) | Supabase JWT + per-user PIN (Supabase DB) |
| Encryption | SOPS + age (file-based) | AES-256-GCM per user (Supabase DB) |
| Access | Dallas admin only | Any authenticated portal user |
| Session cookie | `vault_session` | `user_vault_session` |
| SPA | `index.html` + `app.js` + `style.css` | `user-vault.html` + `user-vault.js` + `user-vault.css` |
| Portal tile | "Vault" (admin dashboard) | "My Vault" (user dashboard) |

## Key Files

| Path | Purpose |
|------|---------|
| `tools/opai-vault/app.py` | FastAPI application (includes auth router, static mount, SPA catch-all) |
| `tools/opai-vault/store.py` | SOPS+age encrypted store manager |
| `tools/opai-vault/audit.py` | Audit logger |
| `tools/opai-vault/config.py` | Configuration (includes web UI auth constants, `SUPABASE_ANON_KEY`) |
| `tools/opai-vault/routes_auth.py` | Admin vault auth routes: PIN, WebAuthn, session, UI secret endpoints |
| `tools/opai-vault/routes_user_vault.py` | Per-user vault CRUD (requires JWT + PIN session) |
| `tools/opai-vault/routes_user_vault_auth.py` | Per-user vault PIN auth: status/setup/verify/lock |
| `tools/opai-vault/user_vault_crypto.py` | Per-user AES-256-GCM encryption (HKDF key derivation) |
| `tools/opai-vault/session.py` | JWT session tokens: create, validate, sliding window, revocation |
| `tools/opai-vault/auth_store.py` | Admin PIN hash, WebAuthn credential CRUD, session secret (`data/auth.json`) |
| `tools/opai-vault/static/index.html` | Admin vault SPA shell |
| `tools/opai-vault/static/style.css` | Admin vault dark theme styles |
| `tools/opai-vault/static/app.js` | Admin vault frontend: auth, secret browser, WebAuthn |
| `tools/opai-vault/static/user-vault.html` | User vault SPA shell |
| `tools/opai-vault/static/user-vault.js` | User vault frontend: Supabase auth, PIN, secret browser |
| `tools/opai-vault/static/user-vault.css` | User vault dark theme styles |
| `tools/opai-vault/data/secrets.enc.yaml` | Encrypted secrets (safe to commit) |
| `tools/opai-vault/data/auth.json` | Admin vault auth state (PIN hash, WebAuthn creds, session secret) |
| `tools/opai-vault/data/vault-audit.json` | Access audit log |
| `tools/opai-vault/scripts/vault-cli.sh` | CLI wrapper |
| `tools/opai-vault/scripts/vault-env.sh` | systemd pre-start decryptor |
| `tools/opai-vault/scripts/mcp-with-vault.sh` | MCP server credential injector |
| `tools/opai-vault/scripts/migrate-services.sh` | Batch service template updater |
| `tools/opai-vault/scripts/import-env.py` | .env file importer |
| `tools/opai-vault/scripts/import-access.py` | notes/Access/ importer |
| `~/.opai-vault/vault.key` | age private key (NEVER commit) |
| `~/.config/sops/age/keys.txt` | SOPS age key (copy of vault.key) |
| `config/service-templates/opai-vault.service` | systemd unit |
| `config/supabase-migrations/042_user_vault_pins.sql` | Per-user PIN hash table migration |

## Security Properties

| Property | How |
|----------|-----|
| Encrypted at rest | SOPS + age (AES-256-GCM per value) |
| AI-safe | Localhost-only, admin auth, values never in AI context |
| Audit trail | Every access logged with timestamp, caller, action |
| Key isolation | age private key in `~/.opai-vault/` (chmod 0600), not in repo |
| tmpfs injection | Decrypted .env written to `$XDG_RUNTIME_DIR/opai-vault/` (RAM), never persisted |
| Git-safe | Encrypted file can be committed (keys visible, values encrypted) |
| Single source of truth | All credentials in one encrypted YAML, no more scatter |
| Web UI PIN brute-force | 5 attempts/min, 60s lockout, all failures audited |
| Web UI PIN storage | bcrypt cost 12 |
| Web UI session cookie | `HttpOnly; Secure; SameSite=Strict; Path=/vault/; Max-Age=1800` |
| Web UI session token | HS256 JWT with vault-specific 256-bit random secret (NOT Supabase JWT secret) |
| Web UI no caching | Revealed values only in DOM, never localStorage/sessionStorage. Auto-mask after 10s |
| Web UI CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'` |
| Web UI WebAuthn | Cross-platform hardware keys only, sign count tracked |
| Web UI network | Accessed via Caddy at `/vault/` — localhost + Tailscale only (NOT exposed via BB VPS public Caddy) |
| User vault isolation | Per-user encryption (HKDF-derived AES-256 keys), RLS on Supabase tables |
| User vault 2-layer auth | Supabase JWT (user identity) + PIN session cookie (vault unlock proof) |
| User vault PIN storage | bcrypt hashed in Supabase `user_vault_pins` table with RLS |
| User vault session | Separate cookie (`user_vault_session`), same security flags as admin vault |

## Migration Path

### Phase 1 (done 2026-02-25): Import existing secrets
```bash
vault import          # 110 secrets from 27 service .env files
vault import-access   # 30 credentials from notes/Access/ markdown files
```
Total: 144 secrets (4 shared, 108 service-specific, 32 credentials) across 18 services.

### Phase 2 (done 2026-02-25): Update systemd services
24 service templates updated with `ExecStartPre=-vault-env.sh` and vault `EnvironmentFile`. Original `.env` files kept as fallback. Tested: billing, monitor, chat, helm, tasks — all healthy.

### Phase 3: Remove plaintext (when ready)
Once confidence is high, delete plaintext `.env` files and convert `notes/Access/` to reference stubs. Migration notice placed at `notes/Access/VAULT-MIGRATION.md`.

### Phase 4: Hardening (pending)
- [ ] Pre-commit hook to block credential patterns
- [ ] Credential rotation schedule
- [ ] Rotate compromised Discord bot token (exposed 2026-02-09) — TeamHub task `9531ccd8`
- [x] Age key backed up to `/workspace/local/vault-backup/` — also back up offsite (USB/password manager)

## Service Name Mapping

Most systemd unit names match vault service names exactly. Exceptions:

| systemd Unit | Vault Service Name | Why |
|-------------|-------------------|-----|
| `opai-discord-bot` | `discord-bridge` | Tool dir is `tools/discord-bridge/` |
| `opai-email` (timer) | `email-checker` | Tool dir is `tools/email-checker/` |

The `migrate-services.sh` script handles this mapping automatically via a `NAME_MAP` array.

## Vault Consumers

| Consumer | How It Uses Vault | Notes |
|----------|-------------------|-------|
| systemd services (24) | Pre-start `vault-env.sh` → tmpfs EnvironmentFile | Standard pattern for all OPAI services |
| MCP servers | `mcp-with-vault.sh` wrapper → exec | Injects env vars before MCP binary starts |
| **OpenClaw Broker** | Runtime API fetch (`/vault/api/service/{name}/secrets`) | Fetches only credentials explicitly granted in `oc_access_manifest`. Writes to tmpfs for Docker container env_file injection. See [OpenClaw Broker](openclaw-broker.md) |

The OpenClaw Broker is notable because it's the only consumer that **dynamically scopes** vault access — it fetches all credentials for a vault service, but only injects the subset that an admin has granted to each OC instance via the access manifest.

## Gotchas

- **Caddy routing (local only)**: Vault is routed through OPAI Server Caddy at `/vault/` (uses `handle`, NOT `handle_path`, because vault routes include the `/vault/` prefix). This is the LOCAL Caddy only — vault is NOT exposed via BB VPS public Caddy. Access is via OPAI Server (localhost + Tailscale).
- **SOPS version**: Installed at `~/bin/sops` (v3.9.4). Not system-wide.
- **age version**: Installed at `~/bin/age` (v1.2.1). Not system-wide.
- **Key file permissions**: `vault.key` MUST be 0600. SOPS will refuse if world-readable.
- **SOPS_AGE_KEY_FILE**: Must be set in env for SOPS to find the key. The systemd service template sets this.
- **Cache**: Secrets are cached in memory after first load. Use `/vault/api/reload` or restart service after editing the encrypted file via CLI. Services that were running when secrets changed need a restart or API reload call.
- **Shared key dedup**: Import script stores shared keys (SUPABASE_*) only once. First service's values win.
- **Backup the age key**: If `vault.key` is lost, ALL secrets are permanently unrecoverable. Backed up to `/workspace/local/vault-backup/` — also back up offsite (USB/password manager).
- **Adding new secrets**: Use `vault-cli.sh set <name> <value>`, `vault-cli.sh edit` (interactive SOPS editor), or the Web UI "Add Secret" button. Do NOT add secrets to `.env` files or `notes/Access/` anymore.
- **New services**: When creating a new OPAI tool, add its secrets to the vault via `vault-cli.sh set <KEY> <VALUE> --service <name>`, then add the `ExecStartPre` and `EnvironmentFile` lines to its systemd template (see systemd Integration above).
- **Web UI `FULL_HEIGHT_TOOLS`**: Vault is in the navbar `FULL_HEIGHT_TOOLS` array. If removed, the flex layout breaks and scrolling stops working.
- **Web UI `webauthn` package**: The correct pip package is `webauthn` (v2.7.1), NOT `py_webauthn` (which installs an ancient v0.0.4). Uses `AuthenticatorSelectionCriteria` wrapper for registration options.
- **Web UI auth.json**: Created on first PIN setup. Contains bcrypt hash, WebAuthn credentials, session HMAC secret. If deleted, all sessions invalidate and PIN must be re-set (secrets are unaffected — they're in `secrets.enc.yaml`).
- **User vault vs admin vault cookies**: Admin vault uses `vault_session`, user vault uses `user_vault_session`. Both scoped to `Path=/vault/` but have different JWT payloads (admin has no `scope`, user has `scope: "user_vault"`). They do not interfere.
- **User vault PIN lockout**: Managed in Supabase `user_vault_pins` table (server-side), not client-side. 5 failed attempts → 60s lockout. Reset on successful verify.
- **User vault requires `SUPABASE_ANON_KEY`**: The user vault SPA needs the anon key to initialize the Supabase JS client. Set via env var or vault-env.sh injection.
- **User vault Caddy routing**: `/vault/my/` is served by the same port 8105 service — no additional Caddy config needed. The existing `/vault/*` rule covers it.
