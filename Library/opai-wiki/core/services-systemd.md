# Services & systemd
> Last updated: 2026-03-05 | Source: `scripts/opai-control.sh`, `~/.config/systemd/user/` | **12 services, 3 timers** (v3.5)

## Overview

All OPAI services run as **systemd user services** (no root required). Managed via `opai-control.sh` or individual `systemctl --user` commands. User lingering is enabled so services run without an active login session.

OPAI v2 consolidated 28+ services down to 10 active services. v3.5 added Brain and Browser, bringing the total to **12 active services + 3 timers**. The core consolidation merged the orchestrator, monitor, and task control panel into a single `opai-engine` service. Many v1 services were archived (see [v1 to v2 Migration](#v1--v2-migration) at the bottom).

## Architecture

```
systemd --user
  ├─ opai-vault.service            (credential store, 127.0.0.1:8105)
  ├─ opai-caddy.service            (reverse proxy, port 80/443)
  ├─ opai-portal.service           (auth + dashboard, 127.0.0.1:8090)
  ├─ opai-engine.service           (core engine, 127.0.0.1:8080)
  │    └─ [managed] email-agent    (spawned by WorkerManager)
  ├─ opai-brain.service            (2nd Brain, 127.0.0.1:8101)
  ├─ opai-files.service            (file manager, 127.0.0.1:8086)
  ├─ opai-team-hub.service         (project management, 127.0.0.1:8089)
  ├─ opai-users.service            (user management, 127.0.0.1:8084)
  ├─ opai-wordpress.service        (WordPress management, 127.0.0.1:8096)
  ├─ opai-oc-broker.service        (OpenClaw container broker, 127.0.0.1:8106)
  ├─ opai-browser.service          (Playwright automation, 127.0.0.1:8107)
  ├─ opai-discord-bot.service      (Discord bridge, no port)
  ├─ opai-docker-cleanup.timer     (daily prune)
  ├─ opai-journal-cleanup.timer    (daily vacuum)
  └─ opai-farmos-sync.timer        (farmOS data sync)
```

## Services

| # | Service | Type | Port | Bind | Purpose | Core |
|---|---------|------|------|------|---------|------|
| 1 | `opai-vault` | simple | 8105 | 127.0.0.1 | Encrypted credential store (SOPS+age). All other services depend on it. | Yes |
| 2 | `opai-caddy` | simple | 80/443 | all | Reverse proxy -- sole external entry point, HTTPS termination | Yes |
| 3 | `opai-portal` | simple | 8090 | 127.0.0.1 | Auth gateway, admin dashboard (20 tiles), Pages Archive | Yes |
| 4 | `opai-engine` | simple | 8080 | 127.0.0.1 | Core engine: scheduler, tasks, workers, monitor, dashboard. **Replaces** opai-orchestrator + opai-monitor + opai-tasks. Manages email-agent as a child process via WorkerManager. | Yes |
| 5 | `opai-brain` | simple | 8101 | 127.0.0.1 | 2nd Brain -- knowledge graph, library, research, Instagram/YouTube integration | No |
| 6 | `opai-files` | simple | 8086 | 127.0.0.1 | Sandboxed file manager + NAS integration | No |
| 7 | `opai-team-hub` | simple | 8089 | 127.0.0.1 | Project/task management -- workspaces, boards, lists | No |
| 8 | `opai-users` | simple | 8084 | 127.0.0.1 | User management + sandbox provisioning | No |
| 9 | `opai-wordpress` | simple | 8096 | 127.0.0.1 | Multi-site WordPress management -- updates, content, WooCommerce | No |
| 10 | `opai-oc-broker` | simple | 8106 | 127.0.0.1 | OpenClaw vault broker + container runtime (Docker lifecycle, credential injection, port 9001-9099 range) | No |
| 11 | `opai-browser` | simple | 8107 | 127.0.0.1 | Headless Playwright browser automation -- job queue, named sessions | No |
| 12 | `opai-discord-bot` | simple | -- | -- | Discord <-> Claude bridge (daemon, no HTTP port) | No |

**Core services** (`opai-vault`, `opai-caddy`, `opai-portal`, `opai-engine`) cannot be restarted by agents from non-interactive shells. Use `restart-one` with `OPAI_FORCE=1` or an interactive terminal to restart them.

### Engine-Managed Processes

The `opai-engine` service internally spawns and manages child processes via its WorkerManager:

| Process | Description |
|---------|-------------|
| `email-agent` | Autonomous email monitoring (previously `opai-email-agent.service`). Spawned via `Popen`, ring buffer logs, auto-restart on crash. |

These are **not** separate systemd services -- they are managed processes inside the engine. The engine handles their lifecycle (start, stop, restart, log collection).

## Timers

| Timer | Oneshot Service | Schedule | Delay | Persistent |
|-------|-----------------|----------|-------|------------|
| `opai-docker-cleanup.timer` | `opai-docker-cleanup.service` | Daily at 3:00 AM (`*-*-* 03:00:00`) | 0-5 min jitter | Yes |
| `opai-journal-cleanup.timer` | `opai-journal-cleanup.service` | Daily (`OnCalendar=daily`) | -- | Yes |
| `opai-farmos-sync.timer` | `opai-farmos-sync.service` | farmOS data synchronization | -- | Yes |

> **Note**: `opai-email.timer` (legacy) and `opai-git-sync.timer` still exist as unit files but are not in the active TIMERS array in `opai-control.sh`. Email is now engine-managed via WorkerManager.

## Key Files

| File | Purpose |
|------|---------|
| `scripts/opai-control.sh` | Unified management script (start, stop, restart, restart-one, status, logs, enable, disable) |
| `~/.config/systemd/user/*.service` | Installed service unit files (v1 units still present but disabled/inactive) |
| `~/.config/systemd/user/*.timer` | Timer unit files |
| `tools/opai-vault/scripts/vault-env.sh` | Pre-start credential decryptor (writes to tmpfs) |
| `config/Caddyfile` | Caddy reverse proxy configuration (10 upstreams) |
| `scripts/docker-cleanup.sh` | Docker prune script (dangling images, exited containers) |

## Service Configuration Patterns

### Common settings across v2 services

- **Restart**: `Restart=on-failure` (most services) or `Restart=always` (engine), `RestartSec=5-10`
- **Resources**: `MemoryMax=512M`, `CPUQuota=50%` (engine)
- **Environment**: `PYTHONUNBUFFERED=1`, `NODE_ENV=production` (Discord bot)
- **Logging**: `StandardOutput=journal`, `StandardError=journal` (systemd defaults)
- **Boot**: `WantedBy=default.target` (auto-start)
- **Lingering**: `loginctl enable-linger $USER` (run without login)

### Vault credential injection

Services load secrets from the encrypted vault at startup using a two-step pattern:

```ini
[Service]
# Step 1: Decrypt vault secrets to tmpfs (soft-fail with - prefix)
ExecStartPre=-/workspace/synced/opai/tools/opai-vault/scripts/vault-env.sh <vault-name>

# Step 2: Load decrypted env file from tmpfs (soft-fail)
EnvironmentFile=-%t/opai-vault/<vault-name>.env

# Optional: Keep original .env as fallback (loaded first, vault overrides)
EnvironmentFile=-/workspace/synced/opai/tools/<service>/.env
```

The `-` prefix on `ExecStartPre` and `EnvironmentFile` means soft-fail: if the vault is unavailable, the service still starts from its original `.env`. `%t` expands to `$XDG_RUNTIME_DIR` (`/run/user/1000`), which is tmpfs (RAM-only, never persisted to disk).

**Vault** itself does not use the vault-env pattern (it is the source). It loads `SOPS_AGE_KEY_FILE` directly from its unit environment.

### Service dependency chain

```ini
# opai-engine depends on vault
[Unit]
After=network.target opai-vault.service
Requires=opai-vault.service
```

Only `opai-engine` declares an explicit `Requires=` dependency on vault. Other services use soft-fail vault loading and can start independently.

## How to Use

### opai-control.sh (recommended)

```bash
# Full lifecycle
./scripts/opai-control.sh enable       # Enable auto-start on boot
./scripts/opai-control.sh start        # Start all v2 services (in order)
./scripts/opai-control.sh stop         # Stop all services (reverse order, INTERACTIVE ONLY)
./scripts/opai-control.sh restart      # Stop + start (INTERACTIVE ONLY)
./scripts/opai-control.sh status       # Show status, memory, uptime for all services
./scripts/opai-control.sh disable      # Disable auto-start

# Single-service restart (agent-safe for non-core services)
./scripts/opai-control.sh restart-one engine       # Accepts short names
./scripts/opai-control.sh restart-one opai-engine   # Or full names

# Logs
./scripts/opai-control.sh logs         # All OPAI service logs (follow mode)
./scripts/opai-control.sh logs engine  # Specific service logs
```

**Safety guards**:
- `stop` and `restart` are blocked in non-interactive shells (prevents agents from taking down the whole system)
- Core services (`opai-caddy`, `opai-portal`, `opai-engine`, `opai-vault`) are blocked from `restart-one` in non-interactive shells
- Override with `OPAI_FORCE=1` if needed

### Individual service control

```bash
systemctl --user start opai-discord-bot
systemctl --user stop opai-discord-bot
systemctl --user restart opai-discord-bot
systemctl --user status opai-discord-bot
journalctl --user -u opai-discord-bot -f

# Timer control
systemctl --user start opai-email.timer
systemctl --user list-timers --all
```

### Start order

`opai-control.sh start` launches services in this exact order:

1. `opai-vault` (credential store -- must start first, 1s pause after start)
2. `opai-caddy` (reverse proxy)
3. `opai-portal` (auth + dashboard)
4. `opai-engine` (core engine -- depends on vault)
5. `opai-brain` (2nd Brain)
6. `opai-files` (file manager)
7. `opai-team-hub` (project management)
8. `opai-users` (user management)
9. `opai-wordpress` (WordPress management)
10. `opai-oc-broker` (OpenClaw container broker)
11. `opai-browser` (Playwright automation)
12. `opai-discord-bot` (Discord bridge)
13. Timers: `opai-docker-cleanup.timer`, `opai-journal-cleanup.timer`, `opai-farmos-sync.timer`

**Stop is reverse order**: Discord bot first, vault last.

## Important Notes

- **Old service units still exist**: v1 `.service` files (opai-chat, opai-billing, opai-orchestrator, etc.) are still present in `~/.config/systemd/user/` but are disabled and not started by `opai-control.sh`. They are kept for reference and rollback.
- **Engine-managed email**: The email agent is no longer a standalone systemd service. It runs as a managed child process inside `opai-engine` via WorkerManager (Popen, ring buffer logs, auto-restart).
- **nvm requirement**: Discord bot requires nvm for Claude CLI path -- handled by `start-bot.sh`
- **nvm PATH for engine workers**: Any engine-managed worker that spawns `claude` CLI needs nvm node bin in PATH (`/home/dallas/.nvm/versions/node/v20.19.5/bin`)
- **CLAUDECODE env var**: Must be stripped before spawning `claude` -- handled by service environment and `start-bot.sh`
- **All HTTP services bind 127.0.0.1**: Only Caddy binds to all interfaces. All other services are localhost-only. External access is exclusively through Caddy.
- **Dependency pinning (2026-03-05)**: All Python tools use `>=` minimum version pinning in `requirements.txt`. 35 packages pinned across 6 tools (opai-bx4, opai-brain, opai-prd, opai-wordpress, opai-forumbot, opai-studio). This prevents silent downgrades while allowing patch updates.

## Dependencies

- **Requires**: systemd (user mode), `loginctl enable-linger`
- **Credential source**: [Vault](vault.md) (SOPS+age encrypted store, pre-start injection)
- **Reverse proxy**: Caddy (`config/Caddyfile`) routes external traffic to the 11 backend ports
- **Installed from**: `~/.config/systemd/user/` (unit files)

---

## v1 to v2 Migration

### What changed (2026-02-25)

The v2 restructure reduced OPAI from **28+ active services** to 10 services + 3 timers. v3.5 added Brain and Browser, bringing the total to **12 services + 3 timers**.

### Merged into opai-engine

These three services were consolidated into a single `opai-engine` service:

| v1 Service | v1 Port | v2 Location |
|------------|---------|-------------|
| `opai-orchestrator` | 3737 | Engine: scheduler module |
| `opai-monitor` | 8080 | Engine: monitor/dashboard module |
| `opai-tasks` | 8081 | Engine: task management module |

### Moved to engine-managed process

| v1 Service | v1 Port | v2 Location |
|------------|---------|-------------|
| `opai-email-agent` | 8093 | Engine WorkerManager: spawned as child process with ring buffer logs and auto-restart |

### Archived (no longer running)

These services existed in v1 but are no longer active. Their unit files may still be present in `~/.config/systemd/user/` but are disabled:

| v1 Service | v1 Port | Notes |
|------------|---------|-------|
| `opai-chat` | 8888 | AI chat server |
| `opai-messenger` | 8083 | Team messaging |
| `opai-terminal` | 8082 | Web shell (xterm.js) |
| `opai-dev` | 8085 | Browser IDE |
| `opai-forum` | 8087 | Dev community forum |
| `opai-agents` | 8088 | Agent Studio |
| `opai-docs` | 8091 | Documentation portal |
| `opai-marketplace` | 8092 | Product catalog |
| `opai-billing` | 8094 | Stripe billing |
| `opai-forumbot` | 8095 | AI forum content |
| `opai-prd` | 8097 | PRD Pipeline |
| `opai-orchestra` | 8098 | Agent Orchestra visualization |
| `opai-bot-space` | 8099 | Bot catalog + credits |
| `opai-bx4` | 8100 | Business intelligence |
| `opai-brain` | 8101 | 2nd Brain cognitive layer — **now active (v3.5)**, see services table |
| `opai-helm` | 8102 | Autonomous business runner |
| `opai-marq` | 8103 | App store publisher |
| `opai-dam` | 8104 | Meta-orchestrator |
| `opai-impresario` | -- | Agent impresario |

### Caddy changes

The Caddy configuration (`config/Caddyfile`) was rewritten to proxy the active service upstreams, removing routes for all archived services. v3.5 added routes for brain (:8101), browser (:8107), studio (:8108), and others.

### Timer changes

| Timer | v1 Status | v2 Status |
|-------|-----------|-----------|
| `opai-docker-cleanup.timer` | Active | Active (in TIMERS array) |
| `opai-journal-cleanup.timer` | Active | Active (in TIMERS array) |
| `opai-email.timer` | Active | Legacy -- still exists, not in TIMERS array. Email now engine-managed. |
| `opai-git-sync.timer` | Active | Unit file exists but not in TIMERS array |
