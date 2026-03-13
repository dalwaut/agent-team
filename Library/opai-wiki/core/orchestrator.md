# Orchestrator (Engine)
> Last updated: 2026-03-05 | Source: `tools/opai-engine/app.py`, `config/orchestrator.json`, `tools/opai-engine/background/`

> **v2 MIGRATION (2026-02-25)**: The standalone Node.js orchestrator has been **merged into the OPAI Engine**. All scheduling, health monitoring, task routing, and feedback processing now runs as Python async background tasks inside `tools/opai-engine/background/`. The Node.js daemon at `tools/opai-orchestrator/` has been deleted. The `opai-orchestrator` systemd unit no longer exists. See [OPAI v2](opai-v2.md) for the migration details.

## Overview

The OPAI Engine (`tools/opai-engine/`, port 8080) is the unified core daemon that coordinates all OPAI subsystems. It runs as a single FastAPI application (v3.5.0) with 12+ async background tasks handling: cron-based scheduling, service health monitoring, resource tracking, task processing, heartbeat, fleet coordination, NFS dispatch, assembly pipeline, memory consolidation, bottleneck detection, process sweeping, and stale job cleanup.

## Architecture

```
Engine (FastAPI + Uvicorn, port 8080)
  ├── 29 route modules (health, tasks, workers, fleet, assembly, mail, agent-feedback, etc.)
  ├── WebSocket streams (real-time dashboard updates)
  └── 12+ async background tasks:
      ├── scheduler (60s)            → cron-based task dispatch
      ├── service-monitor (300s)     → HTTP health probes + systemctl checks
      ├── auto-executor (30s)        → auto-run approved tasks
      ├── resource-monitor (30s)     → CPU/memory tracking
      ├── updater (300s)             → component scanning + suggestions
      ├── stale-sweeper (120s)       → zombie job cleanup
      ├── worker-health (60s)        → managed worker process health
      ├── heartbeat (1800s)          → aggregation, detection, notifications
      ├── bottleneck-detector (6h)   → approval pattern analysis
      ├── fleet-coordinator (5m)     → work dispatch + Team Hub integration
      ├── nfs-dispatcher (30s)       → NFS drop-folder worker comms
      ├── process-sweeper (300s)     → orphan Claude process cleanup
      ├── feedback-decay (24h)       → agent feedback confidence decay
      ├── notebooklm-sync (daily)    → wiki sync to NotebookLM (optional)
      └── chat-fast-loop (30s)       → Google Chat message polling (optional)
```

- **Async Python**: All background loops are `asyncio.create_task()` coroutines
- **Resource-aware**: Defers tasks when CPU > 80% or memory > 85%
- **Stale job sweeper**: Every 2 minutes, auto-clears zombie jobs using two-tier logic
- **Process sweeper**: Kills orphan Claude CLI processes older than configurable threshold
- **Human-in-the-loop**: Defaults to `propose` mode -- writes HITL briefings for non-trivial tasks
- **Managed workers**: Engine spawns and manages child processes (email-agent) via WorkerManager

### Shared Instances

The Engine creates several shared singleton objects at startup that are wired together:

```python
worker_manager = WorkerManager()
worker_mail = WorkerMail()
bottleneck_detector = BottleneckDetector()
fleet_coordinator = FleetCoordinator(worker_manager, scheduler, worker_mail)
nfs_dispatcher = NfsDispatcher(fleet_coordinator)
assembly_pipeline = AssemblyPipeline(fleet_coordinator, worker_manager, worker_mail)
```

### Route Modules (28)

| Module | Prefix | Purpose |
|--------|--------|---------|
| `health` | `/api/health/*` | Service health summary, per-service probes, system stats |
| `monitor` | `/api/monitor/*` | Dashboard data: agents, logs, Claude sessions |
| `tasks` | `/api/tasks/*` | Task registry CRUD, execution, HITL routing |
| `feedback` | `/api/feedback/*` | User feedback collection and processing |
| `audit` | `/api/audit/*` | Audit log viewer |
| `suggestions` | `/api/suggestions/*` | Updater suggestions management |
| `users` | `/api/users/*` | User management, sandbox provisioning |
| `claude_usage` | `/api/claude/*` | Claude subscription usage tracking |
| `workers` | `/api/workers/*` | WorkerManager: managed process control, workforce roster (`/roster` — unified agents/squads/workers/templates/swarm) |
| `heartbeat` | `/api/heartbeat/*` | Heartbeat data, daily notes, manual trigger |
| `consolidator` | `/api/consolidator/*` | Memory consolidation status and trigger |
| `command_channels` | `/api/command-channels/*` | Trust-level command routing |
| `bottleneck` | `/api/bottleneck/*` | Bottleneck detection results |
| `fleet` | `/api/fleet/*` | Fleet coordinator state, dispatch history |
| `action_items` | `/api/action-items` | Aggregated priority-scored action feed |
| `nfs` | `/api/nfs/*` | NFS dispatcher state, worker status |
| `assembly` | `/api/assembly/*` | Assembly pipeline runs, phase control |
| `demos` | `/api/demos/*` | Vercel demo platform management |
| `mail` | `/api/mail/*` | Worker mail system debugging |
| `google_chat` | `/api/google-chat/*` | Google Chat webhook + polling |
| `notifications` | `/api/notifications/*` | Personal notification feed |
| `newsletter` | `/api/newsletter/*` | Feature announcement newsletter |
| `notebooklm` | `/api/notebooklm/*` | NotebookLM integration API |
| `ws_router` | `/ws/*` | WebSocket streams (stats, agents, logs, Claude) |

## Endpoint Security (2026-03-05)

All Engine route modules enforce admin authentication via `dependencies=[Depends(require_admin)]`. 40 endpoints across 8 route modules are protected:

| Module | Protected Endpoints | Notes |
|--------|---------------------|-------|
| `assembly` | 7 | All endpoints |
| `action_items` | 6 | All endpoints |
| `notebooklm` | 7 | All endpoints |
| `notifications` | 4 | All endpoints |
| `newsletter` | 4 | All endpoints |
| `mail` | 6 | All endpoints |
| `demos` | 4 | POST/PUT/DELETE only |
| `google_chat` | 2 | POST only |

**Intentionally public endpoints** (no auth required):
- `GET /api/demos/` — demo list (read-only, no sensitive data)
- `GET /api/nfs/*` — NFS monitoring (read-only status)
- `GET /api/google-chat/status` — chat poller status (read-only)

Pre-existing modules (`health`, `tasks`, `workers`, `fleet`, `heartbeat`, etc.) already had auth via `get_current_user` or `require_admin`. The `nfs` dispatch endpoint was already protected; only GET monitoring endpoints remain public.

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-engine/app.py` | FastAPI entrypoint (~290 lines): imports 28 routers, wires 12+ background tasks in lifespan, shared instances |
| `tools/opai-engine/config.py` | Unified config (~310 lines): workspace paths, engine data files, health services map, systemd services list, orchestrator config loader |
| `config/orchestrator.json` | Schedules, resource limits, service config, task processor settings, fleet/heartbeat/NFS/evolve config |
| `tools/opai-engine/data/engine-state.json` | Persistent state: scheduler state, active jobs |
| `tools/opai-engine/data/fleet-state.json` | Fleet coordinator: active dispatches, history |
| `tools/opai-engine/data/heartbeat-state.json` | Heartbeat: cycle count, daily note date |
| `tools/opai-engine/data/assembly-runs.json` | Assembly pipeline: active build runs |

## Configuration

**`config/orchestrator.json`**:

| Section | Key | Value | Purpose |
|---------|-----|-------|---------|
| `schedules` | `email_check` | `*/30 * * * *` | Check email every 30 min |
| `schedules` | `workspace_audit` | `0 9 * * 1` | Monday 9 AM workspace audit |
| `schedules` | `knowledge_sync` | `0 18 * * *` | Daily 6 PM knowledge sync |
| `schedules` | `health_check` | `*/5 * * * *` | Service health every 5 min |
| `schedules` | `task_process` | `*/15 * * * *` | Process task registry every 15 min |
| `schedules` | `user_sandbox_scan` | `*/5 * * * *` | Scan user sandbox task queues |
| `schedules` | `feedback_process` | `*/5 * * * *` | Process user feedback queue (see [Feedback System](feedback-system.md)) |
| `schedules` | `feedback_act` | `*/15 * * * *` | Auto-create tasks for HIGH/MEDIUM feedback items |
| `sandbox` | `scan_root` | `/workspace/users` | NFS-mounted user sandbox root |
| `sandbox` | `max_user_jobs_parallel` | `2` | Max parallel sandbox jobs |
| `sandbox` | `timeout_seconds` | `300` | Sandbox job timeout |
| `resources` | `max_cpu_percent` | `80` | Defer tasks above this |
| `resources` | `max_memory_percent` | `85` | Defer tasks above this |
| `resources` | `max_parallel_jobs` | `3` | Max concurrent executions (**lightweight tasks bypass**: newsletter, health_check, pollers) |
| `task_processor` | `auto_execute` | `false` | Don't auto-run without approval |
| `task_processor` | `cooldown_minutes` | `30` | Min time between task re-triggers |

### Health Services Map

The Engine probes these services via HTTP `/health` endpoint:

| Service | Port |
|---------|------|
| engine | 8080 |
| portal | 8090 |
| files | 8086 |
| team-hub | 8089 |
| users | 8084 |
| wordpress | 8096 |
| vault | 8105 |
| browser | 8107 |
| brain | 8101 |
| studio | 8108 |

Systemd-only services (no HTTP endpoint): `opai-discord-bot`.

## Scheduled Task Types

| Schedule | Action | Spawns |
|----------|--------|--------|
| `email_check` | Fetch & classify emails | `node tools/email-checker/index.js --check` |
| `workspace_audit` | Full workspace analysis | `bash scripts/run_squad.sh -s workspace` |
| `knowledge_sync` | Knowledge management | `bash scripts/run_squad.sh -s knowledge` |
| `health_check` | Service health monitoring | HTTP probes + `systemctl --user is-active` |
| `task_process` | Task registry processing | Auto-route, HITL briefings, optional squad triggers |
| `user_sandbox_scan` | Scan user sandbox queues | Read `/workspace/users/*/tasks/queue.json`, execute pending |
| `feedback_process` | Classify and file user feedback | Background `feedback_loop.py` |
| `feedback_act` | Create tasks for HIGH/MEDIUM feedback | Background `feedback_loop.py` |
| `dep_scan_daily` | Daily dependency vulnerability scan | `bash scripts/run_squad.sh -s dep_scan` |
| `secrets_scan_daily` | Daily secrets/credential leak scan | `bash scripts/run_squad.sh -s secrets_scan` |
| `security_quick` | Quick security posture check | `bash scripts/run_squad.sh -s security_quick` |
| `incident_check` | Incident detection and response check | `bash scripts/run_squad.sh -s incident` |
| `a11y_weekly` | Weekly accessibility audit | `bash scripts/run_squad.sh -s a11y` |
| `daily_evolve` | Daily evolution pipeline (2am) | 5-phase: auto_safe -> apply fixes -> evolve -> meta-assessment -> email |
| `daily_agent_newsletter` | 7 AM Chat Agent newsletter | Feature announcements + activity + gaps (see [Google Workspace](../integrations/google-workspace.md)) |
| `workspace_mention_poll` | @agent doc comment poller (2min) | `background/workspace_mentions.py` |
| `workspace_chat_poll` | Google Chat message poller (2min) | `background/workspace_chat.py` |
| `coedit_activity_check` | Co-edit session timeout (2min) | Check Drive revisions, timeout inactive sessions |
| `context_harvest` | Context harvester (every 4h) | Worker-based context extraction |
| `workspace_folder_audit` | Nightly Google Workspace audit | `background/workspace_agent.py` |
| `knowledge_refresh` | Nightly business context rebuild (02:30) | `background/knowledge_refresher.py` |

The security squads run on cron schedules defined in `orchestrator.json`. The `daily_evolve` pipeline consolidates what was previously two separate schedules into a single 5-phase automation -- see [Self-Evolution Workflow](../../workflows/self-evolution.md) and [Meta-Assessment](../infra/meta-assessment.md).

## Task Registry Processing

When the task processor runs (every 15 min):

1. **Auto-route orphaned tasks** -- Tasks with no assignee get classified and routed
2. **Write HITL briefings** -- Pending tasks with `mode: 'propose'` get a briefing written to `reports/HITL/{taskId}.md`
3. **Optional auto-execute** -- If `auto_execute: true` and task is agent-assigned with safe mode, trigger squad run

### HITL Briefing Format

```markdown
# HITL Briefing: {task title}
- **Task ID**: t-YYYYMMDD-NNN
- **Priority**: high/normal/low
- **Source**: email/manual/monitor-updater
- **Description**: {task description}
- **Recommended Squad**: {squad name}
- **Routing Mode**: propose
## Run Command
bash scripts/run_squad.sh -s {squad}
```

Written to `reports/HITL/{taskId}.md`. Consumed by the Engine dashboard My Queue tab for human review (approve/reject/defer/reassign).

## How to Use

```bash
# Service management
systemctl --user start opai-engine
systemctl --user status opai-engine
journalctl --user -u opai-engine -f

# View scheduler state
cat tools/opai-engine/data/engine-state.json | jq .scheduler

# Restart via opai-control
./scripts/opai-control.sh restart engine
```

## Dependencies

- **Spawns**: [Agent Framework](agent-framework.md) (`run_squad.sh`), [Email Agent](../integrations/email-agent.md) (via WorkerManager)
- **Scans**: [Sandbox System](sandbox-system.md) (`/workspace/users/*/tasks/queue.json`)
- **Reads**: `config/orchestrator.json`, `tasks/registry.json`, `config/workers.json`
- **Writes**: `data/engine-state.json`, `data/fleet-state.json`, `data/heartbeat-state.json`, `reports/HITL/*.md`
- **Integrates with**: [Team Hub](../tools/team-hub.md) (internal API for task/item CRUD), [Telegram](../integrations/telegram-bridge.md) (notifications), [Google Workspace](../integrations/google-workspace.md) (Drive/Chat/Docs polling)
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-engine` service)

## v3.5 Configuration Additions

The following sections were added to `config/orchestrator.json` for the v3.5 "Team Hub Backbone" phase:

### `fleet_coordinator` -- Work Dispatch

Routes identified work to the right worker (local or NFS), tracks execution, integrates with Team Hub. See [Fleet Coordinator & Action Items](../infra/fleet-action-items.md).

```json
"fleet_coordinator": {
    "enabled": true,
    "interval_minutes": 5,
    "max_concurrent_dispatches": 3,
    "auto_dispatch_approved": true,
    "escalation_threshold_hours": 1,
    "stale_task_threshold_hours": 24,
    "routing": {
        "code_review": "project-reviewer",
        "code_build": "project-builder",
        "research": "researcher",
        "security": "security-scanner",
        "wiki_update": "wiki-librarian",
        "default": "self-assessor"
    }
}
```

### `proactive_intelligence` -- Pattern Detection

Heartbeat-driven detection of overdue items, stalled assignments, recurring patterns, and idle workers. See [Heartbeat](../infra/heartbeat.md).

```json
"proactive_intelligence": {
    "enabled": true,
    "check_interval_cycles": 3,
    "overdue_threshold_minutes": 60,
    "assigned_stall_minutes": 120,
    "idle_worker_minutes": 60,
    "pattern_detection_min_count": 3,
    "auto_act_enabled": false,
    "max_suggestions_per_cycle": 5
}
```

### `nfs_dispatcher` -- NFS Drop-Folder Communication

Bridges Engine to external ClaudeClaw workers via file-based inbox/outbox protocol. See [NFS Dispatcher](../infra/nfs-dispatcher.md).

```json
"nfs_dispatcher": {
    "enabled": true,
    "poll_interval_seconds": 30,
    "base_path": "/workspace/users/_clawbots",
    "admin_hitl_path": "/workspace/users/_admin/hitl",
    "max_concurrent_nfs_tasks": 5,
    "heartbeat_stale_minutes": 10,
    "hitl_sync_enabled": true,
    "admin_response_poll": true
}
```

### `evolve` -- Daily Evolution Pipeline

Consolidated automation that replaced separate `self_assessment` + `evolution` schedules. Runs at 2am via `daily_evolve` cron. See [Self-Evolution Workflow](../../workflows/self-evolution.md) and [Meta-Assessment](../infra/meta-assessment.md).

```json
"evolve": {
    "enabled": true,
    "daily_evolve": {
        "frequency_type": "daily",
        "frequency_value": 1,
        "time_hour": 2,
        "time_minute": 0,
        "phases": ["auto_safe", "apply_fixes", "evolve", "meta_assess", "email"],
        "report_retention_days": 14
    }
}
```

### `bottleneck_detector` -- Approval Bottleneck Detection

Tracks approval patterns and flags workflow bottlenecks. Runs every 6 hours.

```json
"bottleneck_detector": {
    "enabled": true,
    "interval_hours": 6,
    "approval_threshold": 10,
    "lookback_days": 7
}
```

### `process_sweeper` -- Orphan Process Cleanup

Kills orphan Claude CLI processes that exceed age/count thresholds. Configurable dry-run mode.

```json
"process_sweeper": {
    "enabled": true,
    "interval_seconds": 300,
    "min_age_seconds": 600,
    "max_kills_per_cycle": 10,
    "sigterm_wait_seconds": 5,
    "dry_run": false,
    "notify_on_kill": true
}
```

### `command_channels` -- Trust Model

Defines per-channel trust levels for incoming commands. Channels can be `command` (auto-execute), `proposal` (create task for review), or `context` (read-only).

See `config/orchestrator.json` for the full trust configuration.
