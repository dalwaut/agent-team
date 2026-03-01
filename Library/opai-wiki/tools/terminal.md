# Terminal & Claude Code
> Last updated: 2026-02-14 | Source: `tools/opai-terminal/`

## Overview

Browser-based terminal access providing two modes: a standard **Bash shell** and an interactive **Claude Code CLI** session. Both use xterm.js on the frontend and PTY-backed WebSockets on the backend. Restricted to admin users only. All sessions are audit-logged.

## Architecture

```
Browser (xterm.js)
    ↓ WebSocket
Caddy (:80)
    /ws/terminal → Terminal backend (:8082) → PTY → /bin/bash --login
    /ws/claude   → Terminal backend (:8082) → PTY → nvm + claude
```

- **Backend**: FastAPI (Python) with Uvicorn on port 8082
- **Frontend**: xterm.js v5.5.0 with fit + web-links addons
- **PTY**: Python `pty.fork()` — forks a real child process with a pseudo-terminal
- **Auth**: Supabase JWT sent as first WebSocket message, validated via shared `auth.py`

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-terminal/app.py` | FastAPI entrypoint — WebSocket handlers, PTY management, HTTP routes |
| `tools/opai-terminal/config.py` | Paths, env vars, idle timeout, Claude CLI path |
| `tools/opai-terminal/static/index.html` | Bash terminal page (xterm.js) |
| `tools/opai-terminal/static/claude.html` | Claude Code terminal page (xterm.js, purple accent) |
| `tools/shared/auth.py` | Backend JWT validation (shared module) |

## Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `OPAI_TERMINAL_HOST` | Bind address | `127.0.0.1` |
| `OPAI_TERMINAL_PORT` | Listen port | `8082` |
| `OPAI_TERMINAL_IDLE_TIMEOUT` | Idle disconnect (seconds) | `1800` (30 min) |
| `CLAUDE_CLI` | Path to claude binary | `~/.nvm/versions/node/v20.19.5/bin/claude` |
| `SUPABASE_URL` | Supabase project URL | (required) |
| `SUPABASE_ANON_KEY` | Supabase public key | (required) |
| `SUPABASE_JWT_SECRET` | JWT secret | (required) |

## How It Works

### PTY Session Lifecycle

1. **WebSocket accepted** → `_authenticate_admin()` waits for auth message
2. **JWT validated** → must have `role: admin` in `app_metadata`
3. **`pty.fork()`** — forks a child process:
   - Child: sets `TERM=xterm-256color`, `OPAI_TERMINAL_USER=<email>`, strips `CLAUDECODE` env var, execs command
   - Parent: gets `(child_pid, master_fd)` for relay
4. **Three async tasks** run concurrently:
   - `read_pty()` — reads from PTY master fd, sends to WebSocket (20ms poll)
   - `write_pty()` — reads from WebSocket, writes to PTY (handles resize + ping messages)
   - `idle_watchdog()` — disconnects after `IDLE_TIMEOUT` seconds of inactivity
5. **Cleanup** on disconnect:
   - SIGTERM to child, non-blocking wait (up to 2s), SIGKILL if still alive
   - Close master fd
   - Audit log entry

### Bash Terminal (`/ws/terminal`)

Execs: `/bin/bash --login`
Working directory: `/workspace/synced/opai`

### Claude Code Terminal (`/ws/claude`)

Execs: `/bin/bash -c 'export NVM_DIR="~/.nvm" && . "$NVM_DIR/nvm.sh" && exec claude'`
Working directory: `/workspace/synced/opai`

The Claude CLI is installed via nvm and not in the default PATH. The shell command sources nvm to make `claude` available, then `exec`s it to replace the bash process.

The `CLAUDECODE` env var is stripped from the child environment to prevent the Claude CLI from refusing to start (it detects nested sessions via this variable).

### WebSocket Protocol

**Client → Server:**
| Message | Format | Purpose |
|---------|--------|---------|
| Auth | `{"type":"auth","token":"<JWT>"}` | Must be first message |
| Resize | `{"type":"resize","cols":N,"rows":N}` | Terminal resize (TIOCSWINSZ ioctl) |
| Ping | `{"type":"ping"}` | Keepalive (sent every 30s) |
| Input | Raw text | Keyboard input forwarded to PTY |

**Server → Client:**
| Message | Format | Purpose |
|---------|--------|---------|
| Connected | `{"type":"connected","message":"..."}` | Auth successful |
| System | `{"type":"system","message":"..."}` | System messages (timeout, etc.) |
| Pong | `{"type":"pong"}` | Keepalive response |
| Output | Raw text | PTY output forwarded to browser |

### Frontend Auth

Both terminal pages use the same auth pattern:
1. Fetch `/auth/config` → get Supabase URL + anon key
2. Create Supabase client → `getSession()` then `refreshSession()` fallback
3. No session → redirect to `/auth/login?return=/terminal` (or `/claude`)
4. Session found → extract `access_token` → send as first WebSocket message

The `refreshSession()` fallback handles stale sessions where the access token has expired but the refresh token is still valid.

## API

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/` | GET | Public | Serve bash terminal page |
| `/claude` | GET | Public | Serve Claude Code terminal page |
| `/ws/terminal` | WS | Admin JWT | Bash terminal WebSocket |
| `/ws/claude` | WS | Admin JWT | Claude Code terminal WebSocket |
| `/health` | GET | Public | Service health check (uptime, memory) |
| `/static/*` | GET | Public | Static assets (CSS, JS) |

## Caddy Routes

```
/terminal/*     → handle_path → localhost:8082 (prefix stripped)
/terminal       → 301 redirect to /terminal/
/ws/terminal    → handle → localhost:8082 (no strip)
/claude/        → handle → localhost:8082 (rewrite to /claude)
/claude         → handle → localhost:8082 (rewrite to /claude)
/ws/claude      → handle → localhost:8082 (no strip)
/claude/static/* → handle_path → localhost:8082 (prefix stripped)
```

## Audit Log

All sessions are logged to `tools/opai-terminal/data/audit.log`:
```
[2026-02-14T05:29:04Z] user=admin@example.com event=terminal_connect
[2026-02-14T05:35:30Z] user=admin@example.com event=claude_disconnect
```

Events: `terminal_connect`, `terminal_disconnect`, `terminal_idle_timeout`, `claude_connect`, `claude_disconnect`, `claude_idle_timeout`

## Key Implementation Details

### Why `pty.fork()` not `pty.openpty()`

`pty.openpty()` returns `(master_fd, slave_fd)` — just file descriptors, no process. `pty.fork()` returns `(child_pid, master_fd)` — actually forks a child process. The child branch (`pid == 0`) execs the shell command; the parent relays I/O between the master fd and the WebSocket.

### Non-blocking PTY Cleanup

When a WebSocket disconnects, the child process must be cleaned up without blocking the async event loop:
1. Send SIGTERM to child
2. Poll `waitpid(WNOHANG)` every 100ms for up to 2 seconds
3. If still alive, send SIGKILL
4. Close master fd

A blocking `waitpid(0)` would freeze the entire server.

### Claude CLI Environment Requirements

- `NVM_DIR` must be set and nvm sourced (claude installed via nvm, not in system PATH)
- `CLAUDECODE` env var must be unset (prevents "nested session" detection)
- `TERM=xterm-256color` for proper terminal rendering

## Dependencies

- **Python deps**: fastapi, uvicorn, python-dotenv
- **Frontend deps**: xterm.js v5.5.0, xterm-addon-fit, xterm-addon-web-links, Supabase JS v2 (all CDN)
- **System deps**: `/bin/bash`, `claude` CLI (via nvm)
- **Auth**: [Auth & Network](auth-network.md) (shared `auth.py`)
- **Accessed via**: [Portal](portal.md) (Terminal and Claude Code tiles)
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-terminal` service)
