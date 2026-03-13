# OPAI v2 — "The Operator"

> **Status:** Complete (2026-02-25)
> **Dir:** `tools/opai-engine/` | **Port:** 8080 | **Path:** `/engine/`
> **Plan docs:** `notes/Improvements/V2/` | **Progress log:** `notes/Improvements/V2/PROGRESS-LOG.md`

---

## Overview

OPAI v2 is a ground-up simplification of the platform. 28 standalone services collapsed to 9. Six dashboards replaced by one. 42 agent roles consolidated into 12 managed workers. The central idea: one engine, one dashboard, workers that do jobs.

The restructure was executed in a single day (2026-02-25) across five phases, ordered to build foundations first and cut last: Vault (2) --> Engine (3) --> Workers (5) --> Dashboard (4) --> Cleanup (1).

---

## Architecture

```
                    ┌────────────────────────────────────┐
                    │  Caddy (HTTPS Gateway)              │
                    │  443/80 — reverse proxy, auth       │
                    └───────────────┬────────────────────┘
                                    │
          ┌─────────────────────────┼────────────────────────────┐
          │                         │                            │
  ┌───────┴────────┐  ┌────────────┴────────────┐  ┌───────────┴──────────┐
  │ Portal (8090)  │  │ Engine (8080)            │  │ Vault (8105)         │
  │ Auth, login,   │  │ Scheduler, health,       │  │ SOPS+age encrypted   │
  │ admin tiles    │  │ tasks, workers,           │  │ credential store     │
  └────────────────┘  │ monitor, dashboard        │  │ localhost-only       │
                      └─────────┬─────────────────┘  └────────────────────┘
                                │
           ┌────────────────────┼────────────────────────┐
           │ manages            │ manages                 │ manages
   ┌───────┴──────┐   ┌────────┴───────┐   ┌────────────┴────────────┐
   │ Email Agent  │   │ Discord Bot    │   │ Task Workers (8)        │
   │ (Popen,      │   │ (systemd,      │   │ claude-cli on demand:   │
   │  auto-restart│   │  event-driven) │   │ reviewer, builder,      │
   │  ring buffer)│   │                │   │ researcher, librarian,  │
   └──────────────┘   └────────────────┘   │ assessor, scanner,      │
                                           │ dispatcher, browser     │
          ┌─────────────────────────┐      └─────────────────────────┘
          │ Independent Services    │
          │ Files (8086)            │
          │ Team Hub (8089)         │
          │ Users (8084)            │
          │ WordPress (8096)        │
          │ Discord Bot (no port)   │
          └─────────────────────────┘
```

**Stack:** Python FastAPI + Supabase + vanilla JS dashboard
**Config:** `config/orchestrator.json` (schedules) + `config/workers.json` (worker registry)
**Auth:** Supabase JWT (primary) + legacy bearer token (backward compat)

---

## Service Map

| Service | Port | systemd Unit | Role |
|---------|------|-------------|------|
| Caddy (Gateway) | 443/80 | `opai-caddy` | HTTPS termination, reverse proxy, auth routing |
| opai-portal | 8090 | `opai-portal` | Auth, login, admin dashboard (16 tiles: 9 active + 7 v3-deferred) |
| **opai-engine** | **8080** | `opai-engine` | Scheduler, health, tasks, workers, monitor, dashboard |
| opai-vault | 8105 | `opai-vault` | Encrypted credential store (SOPS+age, localhost-only) |
| opai-files | 8086 | `opai-files` | File management + NAS/Synology integration |
| opai-team-hub | 8089 | `opai-team-hub` | Project and task management (ClickUp-style) |
| opai-users | 8084 | `opai-users` | Internal user management + sandbox system |
| opai-wordpress | 8096 | `opai-wordpress` | Client site management (app + registered worker) |
| opai-oc-broker | 8106 | `opai-oc-broker` | OpenClaw vault broker + container runtime (Docker lifecycle, credential injection, ports 9001-9099) |
| opai-discord-bot | -- | `opai-discord-bot` | Discord <--> Claude bridge |

**Total: 10 systemd services** (down from 28).

Additionally, 2 systemd timers remain: `opai-docker-cleanup` and `opai-journal-cleanup`.

---

## The Engine (`tools/opai-engine/`)

The Engine is the core of v2. It replaced three separate services (Orchestrator, Monitor, Task Control Panel) with a single Python FastAPI application.

### What It Replaced

| Old Service | Old Port | Runtime | Absorbed Into |
|-------------|----------|---------|---------------|
| opai-orchestrator | 3737 | Node.js | `background/scheduler.py` (cron engine, croniter) |
| opai-monitor | 8080 | Python | `routes/health.py`, `routes/monitor.py`, `services/collectors.py`, `ws/streams.py` |
| opai-tasks (TCP) | 8081 | Python | `routes/tasks.py`, `routes/feedback.py`, `routes/audit.py`, `services/task_processor.py` |

### Directory Structure

```
tools/opai-engine/
├── app.py                     — FastAPI entry, lifespan (7 background tasks + managed workers)
├── config.py                  — All paths, service lists, constants, env vars
├── send-email.js              — Email sending helper (Node.js, migrated from opai-tasks)
├── opai-engine.service        — systemd unit template
├── requirements.txt           — fastapi, uvicorn, psutil, croniter, httpx, python-jose
│
├── background/                — Background task loops
│   ├── scheduler.py           — Cron-like scheduler (croniter, 15 schedules from orchestrator.json)
│   ├── worker_manager.py      — Worker lifecycle: start/stop/health/guardrails/managed procs
│   ├── service_monitor.py     — systemd service health checks every 5min, auto-restart
│   ├── resource_monitor.py    — CPU/memory/disk monitoring every 30s
│   ├── updater.py             — Component scanner every 5min (detects new tools, orphan prompts)
│   ├── auto_executor.py       — Single 30s loop for pending task execution (fixes old dual-executor race)
│   ├── feedback_loop.py       — Feedback processing trigger
│   ├── stale_job_sweeper.py   — Zombie job cleanup every 2min
│   └── sandbox_scanner.py     — Scans /workspace/users/ for pending sandbox tasks
│
├── routes/                    — API endpoints
│   ├── health.py              — /api/health, /api/health/summary, /api/monitor/* compat aliases
│   ├── monitor.py             — /api/squad, /api/reports/*, /api/logs, /api/team
│   ├── tasks.py               — /api/tasks/* (full CRUD, execution, delegation, HITL, archive)
│   ├── workers.py             — /api/workers/* (status, control, logs, guardrails, approvals)
│   ├── feedback.py            — /api/feedback (items + actions)
│   ├── audit.py               — /api/audit (token costs, session traces, summary)
│   ├── suggestions.py         — /api/updater/suggestions, /api/updater/state
│   ├── claude_usage.py        — /api/claude/* (usage, dashboard, sessions, plan-usage)
│   └── users.py               — /api/users/* (user management, network lockdown)
│
├── services/                  — Business logic
│   ├── collectors.py          — Read-only data: system stats, agents, reports, task summaries
│   ├── session_collector.py   — Claude usage data (live polling, dashboard aggregation) [1488 lines]
│   ├── task_processor.py      — Full task lifecycle [3566 lines, migrated from opai-tasks]
│   ├── service_controller.py  — systemd service control (start/stop/restart)
│   ├── log_reader.py          — Log ring buffer, file tailing, journalctl streaming
│   └── guardrails.py          — Worker guardrails (file access, rate limits, approval gates)
│
├── ws/                        — WebSocket handlers
│   └── streams.py             — /ws/stats, /ws/agents, /ws/logs, /ws/claude
│
├── static/                    — Dashboard UI (vanilla JS SPA)
│   ├── index.html             — 4-tab SPA shell
│   ├── style.css              — Dark theme + responsive (768px tablet, 640px mobile)
│   └── js/app.js              — All dashboard logic + keyboard shortcuts
│
└── data/                      — Runtime state files
    ├── engine-state.json      — Scheduler state (last_run, active_jobs, stats)
    ├── updater-state.json     — Component scanner state
    └── updater-suggestions.json — Detected changes/suggestions
```

**Total: ~30 Python files, ~8000 lines.** Engine is fully self-contained with zero external bridge dependencies.

### Background Tasks (started in lifespan)

| Task | Interval | Purpose |
|------|----------|---------|
| `scheduler` | Cron-based | 15 schedules from orchestrator.json (squads, email, feedback, health) |
| `service-monitor` | 5 min | Checks systemd services, auto-restarts failed ones |
| `auto-executor` | 30 sec | Executes pending tasks (single loop, no race condition) |
| `resource-monitor` | 30 sec | CPU/memory/disk metrics, sets can_execute flag |
| `updater` | 5 min | Scans tools/, team.json, scripts/ for changes |
| `stale-sweeper` | 2 min | Cleans zombie job entries |
| `worker-health` | 60 sec | Checks all managed workers, auto-restarts crashed processes |

### Key API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health/summary` | Aggregated health of all services |
| GET | `/api/system/stats` | CPU, RAM, disk, swap, uptime |
| GET | `/api/system/services` | All systemd service statuses |
| GET | `/api/tasks` | Task list with filtering |
| GET | `/api/tasks/summary` | Status/priority/source breakdown |
| POST | `/api/tasks/{id}/run` | Execute a task |
| GET | `/api/workers` | All workers + status |
| GET | `/api/workers/guardrails` | Guardrails summary |
| GET | `/api/workers/approvals` | Pending approval requests |
| GET | `/api/feedback` | Feedback items |
| GET | `/api/audit` | Audit records (2000 cap) |
| GET | `/api/claude/plan-usage` | Claude subscription usage |
| GET | `/api/settings` | Engine settings |
| WS | `/ws/stats` | Live system metrics |
| WS | `/ws/logs` | Log streaming |

Backward-compatibility aliases: `/api/monitor/health/summary`, `/api/monitor/system/stats`, `/api/monitor/system/services` redirect to their engine equivalents.

### systemd Unit

```ini
[Service]
ExecStartPre=-/workspace/synced/opai/tools/opai-vault/scripts/vault-env.sh opai-engine
EnvironmentFile=-%t/opai-vault/opai-engine.env
ExecStart=/usr/bin/python3 -m uvicorn app:app --host 127.0.0.1 --port 8080
MemoryMax=512M
CPUQuota=50%
Restart=always
RestartSec=10
```

Requires `opai-vault.service`. Vault injects Supabase credentials at startup via tmpfs EnvironmentFile.

---

## Workers

Workers are defined in `config/workers.json` and managed by the Engine's `WorkerManager`. There are three worker types:

| Type | Lifecycle | Examples |
|------|-----------|---------|
| **long-running** | Always-on process | email-manager, discord-bot |
| **hybrid** | Independent app + Engine-scheduled tasks | wordpress-manager |
| **task** | On-demand subprocess via `claude -p` | reviewer, builder, researcher, etc. |

### Worker Registry

| Worker ID | Name | Type | Runtime | Managed By |
|-----------|------|------|---------|------------|
| email-manager | Email Manager | long-running | node | Engine (Popen, auto-restart) |
| discord-bot | Discord Bridge | long-running | node | systemd (`opai-discord-bot`) |
| wordpress-manager | WordPress Manager | hybrid | python | systemd (`opai-wordpress`) |
| project-reviewer | Project Reviewer | task | claude-cli | Engine (on-demand) |
| project-builder | Project Builder | task | claude-cli | Engine (on-demand) |
| researcher | Researcher | task | claude-cli | Engine (on-demand) |
| wiki-librarian | Wiki Librarian | task | claude-cli | Engine (cron, daily 4am) |
| self-assessor | Self Assessor | task | claude-cli | Engine (cron, daily 2am) |
| security-scanner | Security Scanner | task | claude-cli | Engine (cron, weekly Sunday 3am) |
| report-dispatcher | Report Dispatcher | task | claude-cli | Engine (after-squad) |
| browser-agent | Browser Agent | task | claude-cli | Engine (on-demand) |

### Managed Process (email-manager)

The email agent is the first worker converted from systemd to engine-managed:

- Spawned by Engine on startup via `Popen` (stdout/stderr captured)
- 500-line ring buffer for logs (queryable via `/api/workers/email-manager/logs`)
- Auto-restart on crash (respects `max_restarts: 5`, `restart_delay_sec: 30`)
- Vault credentials injected via `vault-env.sh` pre-spawn
- nvm PATH included in environment for Node.js runtime

Discord Bot remains on systemd due to event-driven WebSocket gateway complexity.

### Guardrails

Every worker has configurable guardrails defined in `workers.json`:

| Feature | Description |
|---------|-------------|
| **File access control** | Per-worker path restrictions, read-only enforcement, allowed-paths lists |
| **Approval gates** | Sensitive actions (send_email, deploy_production, write_file) create HITL tasks requiring human approval |
| **Rate limiting** | Sliding-window per-worker (20-500 actions/hour depending on worker) |
| **Prompt protection** | Workers with `prompt_protection: true` check vault for `WORKER_PROMPT` env key before falling back to file-based prompts |
| **Task worker limits** | max_turns, timeout_minutes, model selection per worker |

**Current guardrail stats:**
- 6 read-only workers (reviewers, researchers, scanners)
- 3 workers with approval-gated actions
- 4 rate-limited workers
- 4 prompt-protected workers (email-manager, discord-bot, wordpress-manager, forumbot)

---

## Dashboard

The Engine serves a 4-tab dark-themed SPA at `/engine/` (also accessible via `/tasks/` for backward compat).

### Tabs

| Tab | Subtabs | Content |
|-----|---------|---------|
| **Command Center** | -- | Stat cards (tasks, workers, uptime), activity feed, service health grid, quick action links |
| **Tasks** | All / Feedback / Audit | Task table with filtering, task detail modal (full lifecycle + actions). Feedback items with actionable buttons (Create Task, Run, Queue, Done, Dismiss) per item and count indicator. Audit records with token costs; clickable rows open session trace popup via modal. |
| **Workers** | Overview / Guardrails / Approvals | Worker cards with start/stop/restart/run actions; clickable cards open detail modal (worker info + recent logs). Guardrails display, pending approval management. |
| **System** | Health / Services / Logs / Suggestions / Settings | Service health, systemd control, log streaming, updater suggestions with per-suggestion Archive and Create Task buttons, execution + feedback settings |

### UI Details

- **Theme:** Dark (`--bg: #0a0a0f`, `--accent: #a855f7`), fonts Inter + JetBrains Mono
- **Dynamic modal:** Single reusable modal for task detail, audit trace, and worker detail (title changes per context)
- **Task detail modal:** Click any row for full metadata, agent response, routing config, action buttons (Cancel, Resubmit, Run Now)
- **Audit trace modal:** Step-by-step tool call trace with numbered steps, tool name, input/output, errors
- **Worker detail modal:** Parallel fetch of worker info + logs; shows name, type, status, port, runtime, PID, trigger, schedule, uptime, memory, description, config, logs
- **Feedback count indicator:** Shows "N items (X open, Y done)" summary
- **Feedback parser:** Multi-line aware (regex uses `[\s\S]+?` instead of `.+?` to handle descriptions spanning multiple lines)
- **Feedback item ID:** Items use `feedbackId` (camelCase) as primary identifier
- **Suggestion actions:** Archive (with confirmation dialog) and Create Task (creates task registry entry + HITL briefing)
- **Settings panel:** Auto-execute toggle, max parallel jobs, cooldown, feedback loop config, trusted senders
- **Responsive:** 768px tablet breakpoint, 640px mobile breakpoint
- **Keyboard shortcuts:** `1-4` tab switch, `r` refresh, `/` focus search, `Esc` close modal
- **WebSocket:** Live metrics via `/ws/stats`, log streaming via `/ws/logs`, auto-reconnect
- **Auth:** Loads `/auth/config` + `navbar.js` from Portal for consistent auth across tools
- **Total:** ~1968 lines across 3 files (HTML 258, CSS 810, JS 900)

---

## Vault Integration

Full details in `Library/opai-wiki/vault.md`. Summary of what v2 required:

| Metric | Count |
|--------|-------|
| Total secrets imported | 144 |
| Shared secrets | 4 (SUPABASE_*) |
| Service-specific secrets | 108 |
| Credential store entries | 32 |
| Services with vault pre-start | 24 (via `vault-env.sh`) |

**Encryption stack:** SOPS v3.9.4 + age v1.2.1 (AES-256-GCM per value). Decrypted values written to tmpfs (`$XDG_RUNTIME_DIR/opai-vault/`), never persisted to disk.

**Pre-commit hook** (`.git/hooks/pre-commit`): Blocks patterns including `sk_live_`, `sk_test_`, `whsec_`, `tskey-auth-`, `SUPABASE_SERVICE_KEY=ey`, `DISCORD_BOT_TOKEN=`.

**9 service .env files stubbed** with vault references (originals backed up as `.env.pre-vault`). 35 credential files from `notes/Access/` archived to `notes/Access/.archived/`.

---

## Caddy Routing (v2)

| Path | Destination | Notes |
|------|-------------|-------|
| `/engine/*` | Engine (8080) | Primary dashboard |
| `/tasks/*` | Engine (8080) | Backward compat (was TCP on 8081) |
| `/health` | Engine (8080) --> `/api/health/summary` | Global health aggregation |
| `/users/*` | Users (8084) | User management |
| `/files/*` | Files (8086) | File manager |
| `/team-hub/*` | Team Hub (8089) | Project management |
| `/wordpress/*` | WordPress (8096) | Site management |
| `/oc/*` | OC Broker (8106) | OpenClaw container management |
| `/monitor/*` | Redirect --> `/engine/#system` | Bookmark compat |
| `/brain/*`, `/bx4/*`, `/helm/*`, etc. | Redirect --> `/engine/` | v3 deferred services |
| `/chat/*`, `/agents/*`, `/orchestra/*`, etc. | Redirect --> `/engine/` | Archived services |
| `/*` (default) | Portal (8090) | Auth + admin dashboard |

The Caddyfile went from 30+ route blocks to ~12. No-cache headers on `/engine/` prevent stale dashboard HTML.

---

## Cleanup Results

### Services Archived (`Projects/OPAI/Archived/`)

| Service | Old Port | Reason |
|---------|----------|--------|
| Agent Studio (opai-agents) | 8088 | Replaced by Workers tab |
| Agent Orchestra | 8098 | Visualization merged into Workers |
| Bot Space | 8099 | Bot catalog merged into Workers |
| Chat web app | 8888 | CLI + Discord sufficient |
| Messenger | 8083 | Discord exists |
| Forum | 8087 | No community yet |
| Marketplace | -- | Premature |
| Terminal | 8082 | Use real terminal |
| Docs portal | 8091 | Static docs, can serve from engine |
| Benchmark | -- | Stale, incomplete |
| TUI Dashboard | -- | Merged into Engine System tab |

### Services Removed (deleted)

SCC IDE, Work Companion.

### Services Deferred to v3 (code kept in `tools/`, units stopped)

| Service | Port | Reason |
|---------|------|--------|
| opai-brain | 8101 | Knowledge management, not essential for v2 core |
| opai-bx4 | 8100 | Business intelligence, no active use |
| opai-helm | 8102 | 40% stubs, future product |
| opai-dam | 8104 | Phase 1 only, experimental |
| opai-marq | 8103 | App publisher, not actively publishing |
| opai-prd | -- | PRD pipeline |
| opai-forumbot | 8095 | No community yet |
| opai-billing | 8094 | No paying customers yet |
| opai-dev | 8085 | Browser IDE |

### Old Service Directories Deleted

`opai-monitor/`, `opai-tasks/`, `opai-orchestrator/` -- all code migrated into engine proper.

---

## Impact Metrics

| Metric | v1 | v2 | Change |
|--------|----|----|--------|
| systemd services | 28 | 10 | -64% |
| Listening ports | 20+ | 9 | -55% |
| Disk footprint | 1.9 GB | 665 MB | -65% |
| Dashboards | 6 | 1 (Command Center) | -83% |
| Agent roles (team.json) | 42 | 12 workers | -71% |
| Python files (core) | Scattered across 3 services | 30 in engine | Consolidated |
| Service runtimes | Node.js + Python (mixed) | Python only (engine) | Unified |
| Cron implementation | Node.js (custom) | Python croniter | Simplified |
| Auto-executor instances | 2 (race condition) | 1 | Fixed |

---

## Phase Summary

All five phases completed 2026-02-25.

| Phase | Name | Execution Order | Key Outcome |
|-------|------|-----------------|-------------|
| **2** | Vault Integration | 1st | 144 secrets encrypted, 24 services migrated, pre-commit hook, env files stubbed |
| **3** | Unified Engine | 2nd | 3 services merged into 1 FastAPI app, 30 Python files, all bridges migrated |
| **5** | Worker Runtime | 3rd | 12 workers in registry, guardrails system, email agent engine-managed, prompt protection |
| **4** | Dashboard | 4th | 4-tab dark SPA, task modal, settings, responsive, keyboard shortcuts |
| **1** | Cleanup | 5th | 28 --> 9 services, 11 archived, 9 deferred, Caddy/control.sh rewritten |

### Key Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Engine is Python FastAPI | Monitor and TCP were already Python; only Orchestrator was Node.js (rewritten to Python with croniter) |
| Phase order 2-->3-->5-->4-->1 | Each phase builds on the last; cleanup last so you know what is staying |
| Workers have guardrails | File access control, approval gates, rate limiting, prompt protection |
| Vault is foundation | Every service gets credentials from encrypted store, not .env files |
| One dashboard | Replaces 6 separate dashboards (Monitor, TCP, Agent Studio, Orchestra, TUI, Bot Space) |
| WordPress = dual-role | Independent app (portal tile, port 8096) + registered worker for Engine scheduling |
| Discord Bot stays on systemd | Event-driven WebSocket gateway too complex to convert to Popen; deferred to v3 |
| importlib bridge during transition | Avoided duplicating 3566 lines; migrated into engine proper after cutover validated |
| HELM + DAM = v3 | Not archived -- will return in version 3 when ready |

---

## opai-control.sh (v2)

The service control script was rewritten for v2:

```bash
./scripts/opai-control.sh {start|stop|restart|status|logs}
```

**Core services** (Caddy, Portal, Engine, Vault) are protected from accidental stop. The service list matches the 9 v2 units. Status output shows all services + timers with health indicators.

---

## Key Files

| Path | Purpose |
|------|---------|
| `tools/opai-engine/` | Engine source (30 Python files) |
| `tools/opai-engine/app.py` | FastAPI entry point |
| `tools/opai-engine/config.py` | All paths, service lists, constants |
| `tools/opai-engine/opai-engine.service` | systemd unit template |
| `tools/opai-engine/static/` | Dashboard UI (HTML + CSS + JS) |
| `tools/opai-engine/data/` | Runtime state files |
| `config/workers.json` | Worker registry (12 workers) |
| `config/orchestrator.json` | Scheduler config (15 cron schedules) |
| `config/Caddyfile` | Caddy reverse proxy config (v2) |
| `scripts/opai-control.sh` | Service control script (v2) |
| `tools/opai-vault/` | Encrypted credential store |
| `notes/Improvements/V2/` | Original phase plan docs |
| `notes/Improvements/V2/PROGRESS-LOG.md` | Detailed implementation log |

---

## Remaining Future Work

Low-priority items deferred beyond v2:

- [ ] Convert Discord Bot to engine-managed process (deferred -- event-driven gateway complexity)
- [ ] Remove plaintext .env files (when confidence in vault-only is high)
- [ ] Credential rotation schedule + pre-commit hardening
- [ ] v3 service consolidation for deferred services (Brain, Bx4, HELM, DAM, Marq, Billing, etc.)
- [ ] Multi-business HELM reactivation
- [ ] Engine WebSocket routes for standalone access (currently via `/engine/ws/*` path prefix)

---

## Gotchas

- **Engine port conflict**: Engine took port 8080 which was previously Monitor's port. Monitor must be stopped before Engine starts.
- **Vault EnvironmentFile path**: Must be `/run/user/1000/opai-vault/opai-engine.env` (not `/run/opai/`). Uses `%t` which expands to `$XDG_RUNTIME_DIR`.
- **SOPS encrypt must run from vault dir**: `.sops.yaml` config file not found from other directories. Always `cd tools/opai-vault && ~/bin/sops --encrypt --in-place data/secrets.enc.yaml`.
- **Caddy reload**: Must `systemctl --user reload opai-caddy` after config changes (fresh `start` may load cached config).
- **FastAPI route ordering**: Specific paths (`/api/workers/health`, `/api/workers/guardrails`) must be defined before parameterized (`/api/workers/{worker_id}`) in the router.
- **`/ws/claude` conflict**: Terminal (archived) used `/ws/claude` on port 8082. Engine WebSocket accessed via `/engine/ws/*` path prefix through Caddy.
- **FULL_HEIGHT_TOOLS**: `engine` added to the list in `navbar.js`. Without it, the dashboard layout breaks (flex: 1 has no effect, internal scrolling fails).
- **Task processor size**: `services/task_processor.py` is 3566 lines -- the largest single file in the engine. It handles the full task lifecycle and was migrated wholesale from opai-tasks.
- **send-email.js**: The engine is Python-only except for this Node.js helper (sends emails via the email agent's transport). Kept as-is because rewriting in Python has no benefit.
