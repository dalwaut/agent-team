# Monitor
> Last updated: 2026-02-25 | Source: `tools/opai-engine/`

> **v2 MIGRATION (2026-02-25)**: Monitor → TCP merger (v1.x) → **Engine merger (v2)**. All Monitor functionality is now served by the **OPAI Engine** at `tools/opai-engine/` on port **8080**. The standalone `opai-monitor` directory has been deleted. The `opai-tasks/monitor/` sub-module has been migrated to `opai-engine/services/` and `opai-engine/routes/`. See [OPAI v2](opai-v2.md) for the current architecture.
>
> **Engine equivalents**:
> - `routes_api.py` → `routes/monitor.py` + `routes/health.py` + `routes/suggestions.py`
> - `routes_ws.py` → `ws/` handlers
> - `routes_users.py` → `routes/users.py` (826 lines migrated)
> - `collectors.py` → `services/collectors.py`
> - `session_collector.py` → `services/session_collector.py` (1488 lines migrated)
> - `services.py` → `services/service_controller.py`
> - `log_reader.py` → `services/log_reader.py`
> - `updater.py` → `background/updater.py`
> - Port 8080 (same) and port 8081 (TCP) → port 8080 (engine)

## Overview

Web-based dashboard providing real-time visibility into the OPAI system: CPU/memory/disk metrics, Claude Code token usage with progress bars, running agents, systemd service control, live logs, reports browser, task queue, and automatic system change detection. Panels are resizable and drag-to-reorder with layout persisted in localStorage.

All Monitor functionality is accessed through the **Health tab** of the Task Control Panel at `http://localhost:8081` (or via Caddy at `/tasks/#health`).

## Architecture

```
Browser ←─ WebSocket (stats, agents, logs) ←─ FastAPI (TCP :8081) ←─ psutil, journalctl, log files
        ←─ REST API (services, reports, tasks) ←──────────────────← systemctl, file I/O
        ←─ Claude usage (5s poll) ←────────────────────────────────← ~/.claude/ JSONL + stats-cache
        ←─ Updater suggestions ←────────────────────────────────────← background scan (5 min)
```

- **Backend**: FastAPI sub-module within TCP (`tools/opai-engine/`), served on port 8081
- **Frontend**: Vanilla JS with dark terminal theme (Health tab in TCP)
- **Real-time**: WebSocket streaming for stats (2s), agents (3s), logs (1s)
- **Token usage**: REST polling every 5s with 4s server-side cache
- **Change detection**: UpdaterAgent runs as an `asyncio` background task during the TCP lifespan (started/cancelled alongside the auto-executor loop in `tools/opai-tasks/app.py`)
- **Caddy routing**: `/monitor/*` redirects (302) to `/tasks/#health`; `/health` rewrites to `/api/monitor/health/summary` on port 8081

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-engine/__init__.py` | Package init |
| `tools/opai-engine/routes_api.py` | REST API endpoints (prefix `/api/monitor`) -- health summary, system stats, services, agents, Claude usage, updater |
| `tools/opai-engine/routes_users.py` | User management + network lockdown + AI unlock + hard delete API (shared with [User Controls](user-controls.md)) |
| `tools/opai-engine/routes_ws.py` | WebSocket streaming (99 lines): stats, agents, logs, Claude usage |
| `tools/opai-engine/collectors.py` | Read-only data collection: system stats, agents, reports, services, queue |
| `tools/opai-engine/session_collector.py` | Claude Code usage data: live polling, dashboard aggregation, session index, concurrency snapshot |
| `tools/opai-engine/services.py` | Mutating operations: kill agents, control services, run squads |
| `tools/opai-engine/log_reader.py` | Log aggregation: ring buffer (500 lines), file tailing, journalctl streaming |
| `tools/opai-engine/updater.py` | System change detection (355 lines): scans tools/, team.json, scripts/ every 5 minutes, diffs against baseline, generates suggestions |
| `tools/opai-engine/config.py` | Monitor-specific paths, env vars, service lists, WebSocket intervals -- inherits shared values from TCP `config.py` (WORKSPACE_ROOT, TOOLS_DIR, SCRIPTS_DIR, Supabase keys, etc.) |
| `tools/opai-monitor/data/updater-state.json` | Change detection baseline and file fingerprints (legacy path, still used by updater) |
| `tools/opai-monitor/data/updater-suggestions.json` | Categorized system change suggestions (legacy path, still used by updater) |

### Relationship to TCP

The monitor sub-module is wired into TCP in `tools/opai-tasks/app.py`:

1. **Router mounting**: `monitor_api_router`, `monitor_users_router`, and `monitor_ws_router` are included on the FastAPI app
2. **UpdaterAgent lifecycle**: Instantiated at module level, its `run()` coroutine is launched as an `asyncio.create_task()` during the TCP lifespan context manager, and cancelled on shutdown
3. **Updater reference**: Passed into `monitor.routes_api._updater` so the updater state/suggestions endpoints can read live data

## Configuration

Configuration is inherited from TCP's `.env` -- see [Task Control Panel](task-control-panel.md) for env vars.

Monitor-specific values defined in `tools/opai-engine/config.py`:

| Setting | Value | Notes |
|---------|-------|-------|
| `WS_STATS_INTERVAL` | 2s | System stats WebSocket push interval |
| `WS_AGENTS_INTERVAL` | 3s | Agent list WebSocket push interval |
| `WS_LOGS_INTERVAL` | 1s | Log streaming WebSocket push interval |
| `WS_CLAUDE_INTERVAL` | 10s | Claude usage WebSocket push interval |
| `UPDATER_SCAN_INTERVAL` | 300s (5 min) | How often UpdaterAgent scans for changes |
| `MAX_CONCURRENT_SESSIONS` | 20 | Claude Max subscription session limit |

**Access**: Admin-only. Served within TCP at `/tasks/`. Caddy redirects `/monitor/*` to `/tasks/#health`. See [Auth & Network](auth-network.md).

## API / Interface

All endpoints below are served on **port 8081** (TCP) under the `/api/monitor/` prefix.

### Health
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/monitor/health/summary` | GET | Public | Aggregated health of all services (HTTP probe + systemd check) |

Returns `{"status": "healthy"|"degraded", "services": {name: {status, uptime_seconds, memory_mb}}}`. Probes **25 HTTP services** (chat:8888, tasks:8081, terminal:8082, messenger:8083, users:8084, dev:8085, files:8086, forum:8087, agents:8088, portal:8090, docs:8091, marketplace:8092, email-agent:8093, team-hub:8089, billing:8094, forumbot:8095, wordpress:8096, prd:8097, orchestra:8098, bot-space:8099, bx4:8100, brain:8101, helm:8102, marq:8103, dam:8104) with 2s timeout via httpx. Checks 3 systemd-only services (discord-bot, orchestrator, email.timer). Used by [Portal](portal.md) dashboard (via `/tasks/api/monitor/health/summary`) and Caddy `/health` route.

### System
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/monitor/system/stats` | GET | CPU, memory, disk, load, network, swap, process count |
| `/api/monitor/system/services` | GET | All systemd unit statuses |
| `/api/monitor/system/services/{name}/{action}` | POST | Control service (start/stop/restart) |
| `/api/monitor/system/start-all` | POST | Start all enabled services |

### Agents & Squads
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/agents` | GET | List running claude processes |
| `/api/agents/{pid}` | GET | Detailed agent info (CPU, mem, cmdline, cwd, threads, FDs) |
| `/api/agents/{pid}/kill` | POST | Kill agent by PID |
| `/api/agents/kill-all` | POST | Emergency stop all agents |
| `/api/squad` | GET | Orchestrator state + available squads |

### Reports & Logs
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/reports` | GET | List reports (optional date filter) |
| `/api/reports/latest` | GET | Latest reports |
| `/api/reports/{date}/{filename}` | GET | Read specific report |
| `/api/logs` | GET | Recent log entries from buffer |

### Tasks
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tasks/queue` | GET | Queue state |
| `/api/tasks/registry` | GET | Full task registry |
| `/api/tasks/registry/summary` | GET | Count by status/priority |
| `/api/tasks/registry/{id}/run` | POST | Trigger squad run |
| `/api/tasks/registry/{id}/delegate` | POST | Auto-route and assign task |
| `/api/tasks/registry/{id}/complete` | POST | Mark task completed |
| `/api/tasks/settings` | GET/POST | Auto-execute toggle, cooldown, max squad runs |

### Claude Usage
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/claude/usage` | GET | Live usage (5s poll): today tokens/messages/tools, concurrency, trend, heatmap |
| `/api/claude/dashboard` | GET | Heavier aggregation: week totals, sessions by project, model breakdown |
| `/api/claude/sessions` | GET | Session index with pagination |
| `/api/claude/sessions/{id}` | GET | Detailed token breakdown for one session |
| `/api/claude/concurrency` | GET | Active sessions vs max limit |
| `/api/claude/status` | GET | Installation status: version, model, MCP servers, memory, settings (30s cache) |
| `/api/claude/plan-usage` | GET | Live plan usage from Anthropic OAuth API: session %, weekly %, Sonnet %, extra usage (15s cache) |

**Data sources**: `~/.claude/stats-cache.json` (aggregate lifetime data), `~/.claude/projects/*//*.jsonl` (per-session JSONL with `message.usage` token fields). The live endpoint scans ALL project directories for today's JSONL files (filtered by mtime), with a 4-second server-side cache to handle 5s polling efficiently.

**Token counting**: Extracts `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` from `message.usage` in JSONL entries. Tool calls are counted from `message.content[]` blocks with `type: "tool_use"`. Active sessions are files modified within last 120 seconds.

**Plan usage**: Calls `GET https://api.anthropic.com/api/oauth/usage` with OAuth token from `~/.claude/.credentials.json` and `anthropic-beta: oauth-2025-04-20` header. Returns `five_hour` (session), `seven_day` (all models), `seven_day_sonnet`, `seven_day_opus`, and `extra_usage` with utilization percentages and reset timestamps. Normalized into `session`, `weekAll`, `weekSonnet`, `weekOpus`, `extraUsage` keys. 15-second server-side cache.

**Status data**: Reads `claude --version` (with nvm path fallback for systemd), `~/.claude/.credentials.json` (login method), `~/.claude/settings.json`, `.mcp.json` (MCP servers), CLAUDE.md and auto-memory paths. Active sessions from psutil process scan. 30-second cache.

### Updater
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/updater/suggestions` | GET | System change suggestions |
| `/api/updater/state` | GET | Updater agent state |
| `/api/updater/suggestions/{id}/archive` | POST | Suppress suggestion |
| `/api/updater/suggestions/{id}/task` | POST | Create task from suggestion |

### WebSockets
| Path | Interval | Data |
|------|----------|------|
| `/ws/stats` | 2s | CPU, memory, disk, load, network |
| `/ws/agents` | 3s | Running claude processes |
| `/ws/logs` | 1s | Live log entries (journalctl + file tailing) |
| `/ws/claude` | 10s | Live usage data from `session_collector.get_live_usage()` |

## Dashboard Panels

13 panels in a 2-column CSS grid. All panels support resize (width: half/full, height: compact/default/tall/max) and drag-to-reorder. Layout persisted in localStorage.

| # | Panel | ID | Default Size | Key Features |
|---|-------|----|-------------|--------------|
| 1 | **System Stats** | `panel-stats` | half | CPU (cores + freq), RAM, NVMe + system disk, load, network (with rate), swap, processes. All with progress bars. |
| 2 | **Current Usage** | `panel-usage-meters` | half | Plan-level usage from Anthropic OAuth API with `/usage`-style block-character bars: Current session (5h rolling), Week all models (7d), Week Sonnet only, Extra usage ($spent/$limit). Color-coded thresholds (green/orange/red). Hover tooltips show utilization %, availability, exact reset time, time remaining, and context about throttling. 15s refresh. See [Usage Throttling](usage-throttling.md). |
| 3 | **Claude Status** | `panel-claude-status` | half | Version, active sessions (with cwd/uptime), login method, model, MCP servers (with status icons), memory files, setting sources. 30s refresh. |
| 4 | **Claude Details** | `panel-claude-usage` | half | Messages, Tool Calls, Cache Created, Lifetime Output stat cards. Daily trend bar chart (7 days). Hourly activity heatmap (24h). Sessions by Project list. Model usage breakdown with percentages. |
| 5 | **Running Agents** | `panel-agents` | half | PID, name, CPU%, memory%, uptime. Open detail modal, kill button. |
| 6 | **Squad Status** | `panel-squad` | half | Orchestrator stats (jobs run/failed, restarts, active), service health, available squads. |
| 7 | **Services** | `panel-services` | half | systemd units with start/stop/restart buttons. |
| 8 | **Log Viewer** | `panel-logs` | full/tall | Live WebSocket streaming with text filter, pause, clear. |
| 9 | **Reports** | `panel-reports` | half/tall | Date picker, clickable report list, markdown viewer (pretty/raw toggle). |
| 10 | **Task Queue** | `panel-queue` | half | Queue status + registry summary + "Process Queue" button. |
| 11 | **Quick Actions** | `panel-actions` | full | Kill all, start/restart orchestrator/discord, process queue, EMERGENCY STOP. |
| 12 | **User Controls** | `panel-users` | full/tall | User table, invite, edit, drop-all/restore-all, preface prompt management, AI lock/unlock (shared with [User Controls](user-controls.md)). |
| 13 | **System Changes** | `panel-updater` | full (hidden) | Toggled via UPD header badge. Filter tabs: All/Updates/Notices/Archived. Create task from suggestion. |

### Panel Layout System

Two independent systems handle panel customization, both persisted to localStorage:

**PanelResize** (`opai-monitor-panel-sizes`):
- Width toggle: half / full width -- click icons in header
- Height toggle: C (250px) / D (400px) / T (600px) / M (900px)
- Edge drag: right edge snaps width, bottom edge snaps height
- CSS classes: `size-half`/`size-full`, `height-compact`/`height-default`/`height-tall`/`height-max`

**PanelOrder** (`opai-monitor-panel-order`):
- Drag grip: hamburger icon on left of each panel header (visible on hover)
- Drag panel to new position; placeholder shows insertion point
- Order saved as array of panel IDs

## How to Use

```bash
# Monitor is part of TCP -- start/restart TCP service
systemctl --user restart opai-tasks

# Access in browser (Health tab)
open http://localhost:8081

# Caddy route: /monitor/* -> redirects to /tasks/#health
# Direct API: /tasks/api/monitor/health/summary
# Global health route: /health -> rewrites to /api/monitor/health/summary on port 8081
```

> **Note**: The old standalone command `systemctl --user restart opai-monitor` is no longer valid. Use `opai-tasks` for all Monitor operations.

## Deprecated: Standalone opai-monitor

The original standalone service at `tools/opai-monitor/` (port 8080) is no longer used. Key migration notes:

- **Service**: `opai-monitor.service` removed from systemd; replaced by `opai-tasks.service`
- **Port**: 8080 is no longer in use; all traffic goes to 8081 (TCP)
- **Code**: The canonical source is `tools/opai-engine/`; the old `tools/opai-monitor/` directory is a legacy artifact
- **Data files**: `tools/opai-monitor/data/updater-state.json` and `updater-suggestions.json` are still read/written by the updater (path configured in `monitor/config.py`)
- **Caddy**: The `/monitor/*` path now returns a 302 redirect to `/tasks/#health`

## Dependencies

- **Reads**: `team.json`, `tasks/queue.json`, `tasks/registry.json`, `reports/`, `logs/`, `tools/opai-orchestrator/data/orchestrator-state.json`, `~/.claude/stats-cache.json`, `~/.claude/projects/*//*.jsonl`, `~/.claude/.credentials.json` (OAuth token), `~/.claude/settings.json`, `.mcp.json`
- **Calls**: `systemctl --user` (service control), `run_squad.sh` (squad execution), `process_queue.sh`, `claude --version`, Anthropic OAuth API (`api.anthropic.com/api/oauth/usage`)
- **Scans**: `tools/*/`, `scripts/`, `config/` (updater change detection)
- **Python deps**: fastapi, uvicorn, psutil, httpx, python-dotenv
- **Hosted by**: [Task Control Panel](task-control-panel.md) -- merged as sub-module, served on port 8081
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-tasks` service)
- **Shares code with**: [User Controls](user-controls.md) (`routes_users.py` shared router)
- **Related**: [Usage Throttling](usage-throttling.md) -- task prioritization based on plan usage levels
