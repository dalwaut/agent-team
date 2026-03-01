# Browser Automation

> Headless Playwright browser control via Claude CLI. Internal-only service for programmatic web interaction.

## Overview

OPAI Browser Automation provides headless browser capabilities to other OPAI tools. External tools submit natural-language jobs via REST API; the service wraps each job as a Claude CLI subprocess with a temporary Playwright MCP config. Claude drives the browser using accessibility tree snapshots (not screenshots by default).

Two access patterns:
1. **Job Queue API** (port 8107) — other OPAI services POST tasks, get async results
2. **Playwright MCP** (`.mcp.json`) — Claude Code sessions use Playwright tools directly (no job queue needed)

## Architecture

```
┌─────────────────────────────────────────────┐
│  Callers (Discord, Telegram, DAM, etc.)     │
│  POST /api/jobs { task: "scrape pricing" }  │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  app.py (FastAPI, port 8107)                │
│  - localhost-only middleware (+ Tailscale)   │
│  - /health + /api/health                    │
│  - /api/jobs (submit, list, get, cancel)    │
│  - /api/sessions (list, create, delete)     │
│  - / → static admin UI                      │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  job_queue.py (async worker)                │
│  - In-memory OrderedDict (100 job history)  │
│  - Max 3 concurrent jobs                    │
│  - Per-job: build temp MCP config →         │
│    spawn `claude -p --mcp-config <tmp>`     │
│  - Unsets CLAUDECODE env to allow nesting   │
│  - Timeout + cancel support                 │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  claude -p (subprocess)                     │
│  - Reads temp MCP config with Playwright    │
│  - Navigates via accessibility tree         │
│  - Returns structured text result           │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  Playwright MCP (@playwright/mcp)           │
│  - Headless Chromium via npx                │
│  - Per-session user-data-dir persistence    │
│  - Custom user-agent + viewport             │
└─────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-browser/app.py` | FastAPI entrypoint, localhost guard, route mounting, static UI |
| `tools/opai-browser/config.py` | Paths, env vars, Playwright MCP settings, `build_mcp_config()` |
| `tools/opai-browser/job_queue.py` | `Job` model, `JobQueue` singleton, async worker, Claude CLI subprocess |
| `tools/opai-browser/session_manager.py` | Named session CRUD (persistent user-data-dirs) |
| `tools/opai-browser/routes/health.py` | `/health` + `/api/health` (Monitor-compatible) |
| `tools/opai-browser/routes/jobs.py` | Job submit/list/get/cancel (admin auth) |
| `tools/opai-browser/routes/sessions.py` | Session list/create/delete (admin auth) |
| `tools/opai-browser/static/index.html` | Admin debug UI |
| `tools/opai-browser/.env` | Vault-injected credentials (Supabase URL/keys) |
| `config/service-templates/opai-browser.service` | systemd unit file |

## Configuration

### Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `BROWSER_HOST` | `127.0.0.1` | Bind address |
| `BROWSER_PORT` | `8107` | Listen port |
| `SUPABASE_URL` | (vault) | Future audit logging |
| `SUPABASE_SERVICE_KEY` | (vault) | Future audit logging |
| `SUPABASE_JWT_SECRET` | (vault) | Admin auth |
| `CLAUDE_BIN` | `/home/dallas/.nvm/versions/node/v20.19.5/bin/claude` | Claude CLI path |

### Job Defaults (config.py)

| Setting | Value | Purpose |
|---------|-------|---------|
| `DEFAULT_MAX_TURNS` | 15 | Max Claude agentic turns per job |
| `DEFAULT_TIMEOUT_SEC` | 300 (5 min) | Job timeout |
| `MAX_CONCURRENT_JOBS` | 3 | Parallel job limit |
| `JOB_HISTORY_MAX` | 100 | In-memory completed job retention |

### Playwright MCP Settings (config.py)

| Setting | Value |
|---------|-------|
| `PLAYWRIGHT_MCP` | `@playwright/mcp@latest` |
| `USER_AGENT` | Chrome 145 on Linux |
| `VIEWPORT` | `1280x900` |
| Headless | Always (no display server) |
| Screenshots | Disabled by default (`--no-screenshots`), enable per-job with `vision_ok: true` |

## API

All job/session endpoints require admin auth (Supabase JWT with admin role).

### Jobs

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/jobs` | `{ task, session?, vision_ok?, max_turns?, timeout_sec?, caller? }` | Submit a browser job |
| `GET` | `/api/jobs` | `?limit=50` | List recent jobs (newest first) |
| `GET` | `/api/jobs/{id}` | — | Get job status + result |
| `DELETE` | `/api/jobs/{id}` | — | Cancel a queued/running job |

### Sessions

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/api/sessions` | — | List all named sessions |
| `POST` | `/api/sessions` | `{ name }` | Create a named session |
| `DELETE` | `/api/sessions/{name}` | — | Delete session + wipe storage state |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Monitor probe (no auth) |
| `GET` | `/api/health` | Alias (no auth) |

### Job Lifecycle

```
queued → running → completed
                 → failed (error / timeout)
       → cancelled (user cancel)
```

## Session Persistence

Each named session gets a `user-data-dir` under `tools/opai-browser/data/sessions/<name>/`. This preserves:
- Cookies and login state
- localStorage / sessionStorage
- Browser cache

The `default` session is auto-created at startup. Named sessions allow different tools to maintain isolated browser contexts (e.g., `discord-admin`, `wordpress-mgmt`).

## How It Works (Job Execution)

1. Caller POSTs to `/api/jobs` with a natural-language task
2. `JobQueue.submit()` creates a `Job` and enqueues it
3. Background worker picks up the job (respects `MAX_CONCURRENT_JOBS`)
4. `_execute()` builds a temporary MCP config via `config.build_mcp_config()`:
   ```json
   {
     "mcpServers": {
       "playwright": {
         "type": "stdio",
         "command": "npx",
         "args": ["@playwright/mcp@latest", "--headless", "--user-data-dir", "<session_dir>", ...]
       }
     }
   }
   ```
5. Writes config to `/tmp/browser-job-<id>.json`
6. Spawns `claude -p <prompt> --mcp-config /tmp/browser-job-<id>.json --max-turns <n>`
   - Unsets `CLAUDECODE` and `CLAUDE_CODE` env vars to allow nested CLI spawn
   - Adds NVM bin to PATH so `npx` is available to the Claude subprocess
7. Claude reads the MCP config, launches Playwright, executes the task
8. Result (stdout) or error (stderr/timeout) is captured on the `Job` object
9. Temp MCP config file is cleaned up

## Claude Code Direct Access

For interactive use (not via job queue), the Playwright MCP is configured in `.mcp.json`:

```json
"playwright": {
  "type": "stdio",
  "command": "npx",
  "args": [
    "@playwright/mcp@latest",
    "--headless",
    "--user-data-dir", "/workspace/synced/opai/tools/opai-browser/data/sessions/default",
    "--user-agent", "Mozilla/5.0 ...",
    "--viewport-size", "1280x900"
  ]
}
```

This gives Claude Code sessions direct access to `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, etc. without going through the job queue.

## Security

- **Localhost-only**: Middleware rejects non-local IPs (allows `127.0.0.1`, `::1`, Tailscale `100.*`)
- **Admin auth**: All job/session endpoints require Supabase JWT with admin role
- **No screenshots by default**: Reduces data leakage; `vision_ok: true` must be explicitly set
- **Env isolation**: `CLAUDECODE` unset in subprocess to allow nested Claude spawn
- **Temp file cleanup**: MCP config deleted after job completes (even on failure)
- **Vault integration**: Credentials injected via `vault-env.sh` at service start

## Dependencies

- Python 3.12+, FastAPI, uvicorn, httpx, python-dotenv
- Claude CLI (`~/.nvm/versions/node/v20.19.5/bin/claude`)
- `npx` + `@playwright/mcp@latest` (auto-downloaded by npx)
- Shared auth module (`tools/shared/auth.py`)
- Vault service (for credential injection)

## Systemd

```
Unit: opai-browser.service
After: network.target, opai-vault.service
WorkingDirectory: /workspace/synced/opai/tools/opai-browser
Exec: python3 -m uvicorn app:app --host 127.0.0.1 --port 8107
Restart: on-failure (10s)
```

## Gotchas

- **`type: stdio` required in MCP config**: The `build_mcp_config()` function must include `"type": "stdio"` in the generated Playwright server entry. Without it, Claude CLI silently ignores the MCP server and the subprocess has zero browser tools. Fixed 2026-02-27.
- **`CLAUDECODE` env var**: Must be unset in the subprocess environment or Claude CLI refuses to spawn (nested session detection). The job queue handles this automatically.
- **npx PATH**: The Claude subprocess inherits `env` from `create_subprocess_exec`. NVM bin must be prepended to `PATH` so that when Claude CLI spawns the MCP server, `npx` is found.
- **Monitor health probes**: Both `/health` and `/api/health` are registered to avoid the common gotcha where Monitor only checks `/health`.
- **No database**: All state is in-memory. Jobs are lost on restart. This is intentional — browser jobs are ephemeral.
- **Session cleanup**: Deleting a session wipes the entire `user-data-dir` including all cookies/state. No undo.

---

*Last updated: 2026-02-27*
