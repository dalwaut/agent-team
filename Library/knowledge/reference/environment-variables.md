# Environment Variables Reference

> **Last updated:** 2026-03-05
> **Purpose:** Central index of all environment variables used across OPAI services.
> **Note:** All secrets are managed by the Vault (`tools/opai-vault/`). Services receive env vars via systemd tmpfs injection.

---

## Shared Variables (Used by Multiple Services)

These are stored in the Vault under the `shared` section.

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SUPABASE_URL` | Yes | Supabase project URL | `https://idorgloobxkmlnwnxbej.supabase.co` |
| `SUPABASE_ANON_KEY` | Yes | Supabase anonymous/public key (for client-side auth) | `eyJ...` |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key (bypasses RLS) | `eyJ...` |
| `SUPABASE_JWT_SECRET` | Some | JWT signing secret for token verification | `super-secret...` |
| `SUPABASE_JWKS_URL` | Some | JWKS endpoint for ES256 key verification | `https://.../.well-known/jwks.json` |
| `ANTHROPIC_API_KEY` | No | Anthropic API key. If unset, system uses CLI (`claude -p`) instead. Most services run without this. | `sk-ant-...` |

---

## Engine (`opai-engine`, port 8080)

Source: `tools/opai-engine/config.py`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPAI_ENGINE_HOST` | No | `127.0.0.1` | Bind address |
| `OPAI_ENGINE_PORT` | No | `8080` | Listen port |
| `OPAI_ENGINE_TOKEN` | No | `""` | Legacy bearer token (Supabase JWT preferred) |
| `OPAI_MONITOR_TOKEN` | No | `""` | Fallback for legacy token |
| `LOCKDOWN_PIN` | No | `""` | Network lockdown kill-switch PIN |
| `NFS_CLAWBOTS_BASE` | No | `/workspace/users/_clawbots` | Base path for NFS ClawBot dispatch |
| `NFS_ADMIN_HITL` | No | `/workspace/users/_admin/hitl` | Admin HITL folder for NFS |
| `TEAMHUB_INTERNAL_URL` | No | `http://127.0.0.1:8089/api/internal` | Team Hub internal API endpoint |
| `WORKERS_WORKSPACE_ID` | No | `d27944f3-...` | Team Hub workspace ID for workers |
| `HITL_QUEUE_LIST_ID` | No | `ac6071d1-...` | Team Hub list ID for HITL queue |
| `ACTIVE_WORK_LIST_ID` | No | `0e074890-...` | Team Hub list ID for active work |
| `SYSTEM_USER_ID` | No | `1c93c5fe-...` | System user ID for creating items |

---

## Portal (`opai-portal`, port 8090)

Source: `tools/opai-portal/config.py`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPAI_PORTAL_HOST` | No | `127.0.0.1` | Bind address |
| `OPAI_PORTAL_PORT` | No | `8090` | Listen port |
| `OPAI_AUTH_DISABLED` | No | `""` | Set to `1`/`true`/`yes` to bypass auth |
| `OPAI_WORKSPACE` | No | `/workspace/synced/opai` | Workspace root path |
| `OPAI_PUBLIC_SITE_DIR` | No | `tools/opai-billing/public-site` | Public site deploy directory |
| `OPAI_SERVER_TAILSCALE` | No | `100.72.206.23` | Tailscale IP of OPAI server |
| `OPAI_PUBLIC_DOMAIN` | No | `opai.boutabyte.com` | Public-facing domain |
| `OPAI_BB_VPS_HOST` | No | `root@bb-vps` | BB VPS SSH target |
| `OPAI_SSH_KEY` | No | `~/.ssh/bb_vps` | SSH key for VPS deployment |
| `OPAI_NVM_BIN` | No | `/home/dallas/.nvm/.../bin` | Node.js binary path |

---

## Team Hub (`opai-team-hub`, port 8089)

Source: `tools/opai-team-hub/config.py`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPAI_TEAM_HUB_HOST` | No | `127.0.0.1` | Bind address |
| `OPAI_TEAM_HUB_PORT` | No | `8089` | Listen port |
| `TEAM_HUB_CLAUDE_MODEL` | No | `claude-sonnet-4-6` | AI model for Team Hub features |
| `CLICKUP_API_KEY` | No | `""` | ClickUp API key (for import) |
| `CLICKUP_TEAM_ID` | No | `8500473` | ClickUp team ID |

---

## Brain (`opai-brain`, port 8101)

Source: `tools/opai-brain/config.py`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPAI_BRAIN_HOST` | No | `127.0.0.1` | Bind address |
| `OPAI_BRAIN_PORT` | No | `8101` | Listen port |
| `BRAIN_CLAUDE_MODEL` | No | `claude-sonnet-4-6` | AI model for Brain features |
| `BRAIN_SCHEDULER_TICK` | No | `60` | Scheduler interval in seconds |

---

## Telegram (`opai-telegram`, port 8110)

Source: `tools/opai-telegram/index.js`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Telegram Bot API token (fatal if missing) |
| `WEBHOOK_SECRET` | No | — | Secret for webhook verification |
| `WEBHOOK_URL` | No | — | Public webhook URL |
| `PORT` | No | `8110` | Listen port |
| `NODE_ENV` | No | — | Set to `production` for webhook mode; else polling |
| `ADMIN_GROUP_ID` | No | — | Telegram group ID for admin alerts |
| `ALERT_THREAD_ID` | No | — | Forum topic ID for alert messages |
| `SERVER_STATUS_THREAD_ID` | No | — | Forum topic ID for server status |
| `PERSONAL_CHAT_ID` | No | — | Dallas's personal chat ID for DM alerts |
| `WAUTERSEDGE_GROUP_ID` | No | — | WautersEdge team group ID |

---

## WordPress (`opai-wordpress`, port 8096)

Source: `tools/opai-wordpress/config.py`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPAI_WORDPRESS_HOST` | No | `127.0.0.1` | Bind address |
| `OPAI_WORDPRESS_PORT` | No | `8096` | Listen port |
| `SCHEDULER_INTERVAL` | No | `60` | Background scheduler interval (seconds) |
| `HEALTH_CHECK_TIMEOUT` | No | `15` | Health check timeout (seconds) |
| `BACKUP_RETENTION_DAYS` | No | `30` | Days to retain backups |
| `BACKUP_STORAGE_DIR` | No | `/home/dallas/WautersEdge/WPBackups` | Local backup directory |
| `AGENT_LINK_CHECK_CONCURRENCY` | No | `10` | Parallel link checks |
| `AGENT_LINK_CHECK_TIMEOUT` | No | `15` | Link check timeout (seconds) |
| `AGENT_SCHEDULER_INTERVAL` | No | `60` | Agent scheduler interval (seconds) |

---

## Email Agent (`opai-email-agent`, port 8093)

Source: `tools/opai-email-agent/config.json` (JSON config, not env vars)

Configuration is JSON-based per account. Each account specifies:
- `email` — Account email address
- `envPrefix` — Prefix for env-injected IMAP/SMTP credentials (e.g., `AGENT` -> `AGENT_IMAP_HOST`)
- `imap.host/port/user/pass` — IMAP connection (or via envPrefix)
- `smtp.host/port/user/pass` — SMTP connection (or via envPrefix)
- `mode` — `suggestion` or `internal`
- `checkIntervalMinutes` — Polling interval (default 30)
- `rateLimitPerHour` — Max actions per hour (default 5)

---

## Claude API (`tools/shared/claude_api.py`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | No | `""` | If set, uses API. If unset, falls back to `claude -p` CLI (subscription). |

---

## Vault Notes

- All `.env` files are imported into the vault via `tools/opai-vault/scripts/import-env.py`
- Services listed in the vault import script: opai-billing, opai-brain, opai-browser, opai-bx4, opai-dam, opai-email-agent, opai-engine, opai-files, opai-forumbot, opai-helm, opai-marq, opai-portal, opai-prd, opai-team-hub, opai-users, opai-wordpress, discord-bridge, email-checker
- Shared keys (SUPABASE_*) are deduplicated into a `shared` section
- Vault injects env vars at service start via systemd `EnvironmentFile=` pointing to tmpfs
