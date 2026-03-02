# Orchestrator
> Last updated: 2026-03-02 | Source: `config/orchestrator.json`, `tools/opai-engine/background/`

> **v2 MIGRATION (2026-02-25)**: The standalone orchestrator has been **merged into the [OPAI Engine](opai-v2.md)**. All scheduling, health monitoring, task routing, and feedback processing now runs as Python background tasks inside `tools/opai-engine/background/`. The Node.js daemon at `tools/opai-orchestrator/` has been deleted. The `opai-orchestrator` systemd unit no longer exists. See [OPAI v2](opai-v2.md) for the current architecture.
>
> **Engine equivalents**:
> - `index.js` setInterval loops → `background/scheduler.py` (async Python scheduler)
> - Service health checks → `background/service_monitor.py`
> - Resource monitoring → `background/resource_monitor.py`
> - Task processing → `services/task_processor.py`
> - Stale job sweeper → `background/stale_job_sweeper.py`
> - Sandbox scanning → `background/sandbox_scanner.py`
> - Feedback triggers → `background/feedback_loop.py`

## Overview

Central daemon that coordinates all OPAI subsystems. Handles cron-based scheduling, service health monitoring with auto-restart, resource-aware task execution, and task registry processing with intelligent routing.

## Architecture

```
Main Loop (Node.js daemon)
  ├─ setInterval(checkScheduledTasks, 60s)    → email checks, squad runs, task processing
  ├─ setInterval(monitorAllServices, 300s)    → systemctl health queries, auto-restart
  ├─ setInterval(checkResources, 30s)         → CPU/memory via top
  ├─ setInterval(saveState, 300s)             → persist to orchestrator-state.json
  └─ setInterval(sweepStaleJobs, 120s)        → auto-clear zombie jobs older than 20m
```

- **Non-blocking**: All spawned processes are async/Promise-based
- **Resource-aware**: Defers tasks when CPU > 80% or memory > 85%
- **Job timeouts**: Email checks timeout at 5 min, agent squads at 15 min, sandbox tasks at 5 min (configurable)
- **Stale job sweeper**: Every 2 minutes, auto-clears zombie jobs using two-tier logic:
  - **Batch jobs** (email_check, agent_squad, user_sandbox): swept if older than 20 minutes
  - **Interactive sessions** (ide_session, terminal, claude_session): only swept after 20 min of **no user interaction** (`lastActivity` tracking) — never by age alone
- **Human-in-the-loop**: Defaults to `propose` mode — writes HITL briefings for non-trivial tasks
- **Zero production deps**: Only uses Node.js built-ins + system utilities

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-orchestrator/index.js` | Main application (~1030 lines): scheduling, health, task processing, feedback processor + actor, job management |
| `config/orchestrator.json` | Schedules, resource limits, service config, task processor settings, API config |
| `tools/opai-orchestrator/data/orchestrator-state.json` | Persistent state: active jobs, scheduled task times, service health, stats |
| `logs/orchestrator.log` | Activity log (console + file) |

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
| `resources` | `max_parallel_jobs` | `3` | Max concurrent executions |
| `task_processor` | `auto_execute` | `false` | Don't auto-run without approval |
| `task_processor` | `cooldown_minutes` | `30` | Min time between task re-triggers |
| `api` | `port` | `3737` | API port (reserved, not fully implemented) |

## Scheduled Task Types

| Schedule | Action | Spawns |
|----------|--------|--------|
| `email_check` | Fetch & classify emails | `node tools/email-checker/index.js --check` |
| `workspace_audit` | Full workspace analysis | `bash scripts/run_squad.sh -s workspace` |
| `knowledge_sync` | Knowledge management | `bash scripts/run_squad.sh -s knowledge` |
| `health_check` | Service health monitoring | `systemctl --user is-active opai-*` |
| `task_process` | Task registry processing | Auto-route → HITL briefings → optional squad triggers |
| `user_sandbox_scan` | Scan user sandbox queues | Read `/workspace/users/*/tasks/queue.json`, execute pending tasks within sandbox |
| `feedback_process` | Classify and file user feedback | `node tools/feedback-processor/index.js` |
| `feedback_act` | Create tasks for HIGH/MEDIUM feedback | `node tools/feedback-processor/feedback-actor.js` |
| `dep_scan_daily` | Daily dependency vulnerability scan | `bash scripts/run_squad.sh -s dep_scan` |
| `secrets_scan_daily` | Daily secrets/credential leak scan | `bash scripts/run_squad.sh -s secrets_scan` |
| `security_quick` | Quick security posture check | `bash scripts/run_squad.sh -s security_quick` |
| `incident_check` | Incident detection and response check | `bash scripts/run_squad.sh -s incident` |
| `a11y_weekly` | Weekly accessibility audit | `bash scripts/run_squad.sh -s a11y` |

The five security and accessibility squads (`dep_scan_daily`, `secrets_scan_daily`, `security_quick`, `incident_check`, `a11y_weekly`) run on cron schedules defined in `orchestrator.json`. The daily scans run overnight, `security_quick` runs every few hours, `incident_check` runs frequently for early detection, and `a11y_weekly` runs once per week. Each spawns the corresponding squad via `run_squad.sh`.

## Task Registry Processing

When the task processor runs (every 15 min):

1. **Auto-route orphaned tasks** — Tasks with no assignee get classified via work-companion (`classifyTask` → `routeTask`)
2. **Write HITL briefings** — Pending tasks with `mode: 'propose'` get a briefing written to `reports/HITL/{taskId}.md`
3. **Optional auto-execute** — If `auto_execute: true` and task is agent-assigned with safe mode, trigger squad run

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

Written to `reports/HITL/{taskId}.md`. Consumed by the [Task Control Panel](task-control-panel.md) My Queue view for human review (approve/reject/defer/reassign).

### Task Categories

The registry holds two types of tasks:
- **System tasks** (6): Internal OPAI tasks that stay in the registry for agent execution and lifecycle testing
- **Work tasks** (31): Client/project tasks migrated to [Team Hub](team-hub.md) workspaces via `scripts/migrate-registry-to-hub.py`, tagged with `registry:{task_id}` for traceability

### Known Gap

Squad runs (`runAgentSquad()`) currently don't receive task context (task ID, description). The squad executes generically without knowing which registry task triggered it. This means agent reports are not automatically linked back to specific tasks.

## How to Use

```bash
# Service management
systemctl --user start opai-orchestrator
systemctl --user status opai-orchestrator
journalctl --user -u opai-orchestrator -f

# View state
cat tools/opai-orchestrator/data/orchestrator-state.json | jq .stats
```

## User Sandbox Scanning

Every 5 minutes, `scanUserSandboxes()` checks for pending tasks in user sandbox queues:

1. Reads `/workspace/users/*/tasks/queue.json` for `pending` tasks
2. Validates against per-user limits from `config/sandbox.json`
3. Checks global `max_parallel_jobs: 3` (user jobs share this pool)
4. Picks up task → sets `in_progress` → creates central registry entry (`source: "user-sandbox"`)
5. Executes within user's sandbox directory (isolated)
6. Writes reports to user's `reports/` dir, updates both queues

See [Sandbox System](sandbox-system.md) for full sandbox architecture.

## Dependencies

- **Monitors**: [Discord Bridge](discord-bridge.md) (critical), [Email Checker](email-checker.md), task processor
- **Spawns**: [Agent Framework](agent-framework.md) (`run_squad.sh`), [Email Checker](email-checker.md) (`index.js --check`), [Feedback System](feedback-system.md) (`feedback-processor/index.js` + `feedback-actor.js`)
- **Scans**: [Sandbox System](sandbox-system.md) (`/workspace/users/*/tasks/queue.json` every 5 min)
- **Reads**: `config/orchestrator.json`, `tasks/registry.json`
- **Writes**: `orchestrator-state.json`, `logs/orchestrator.log`, `reports/HITL/*.md`
- **Consumed by**: [Task Control Panel](task-control-panel.md) — My Queue reads HITL briefings, HITL respond endpoint updates registry and archives briefings
- **Uses**: work-companion for task classification/routing
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-engine` service)

## v3.5 Configuration Additions

The following sections were added to `config/orchestrator.json` for the v3.5 "Team Hub Backbone" phase:

### `fleet_coordinator` — Work Dispatch

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

### `proactive_intelligence` — Pattern Detection

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

### `nfs_dispatcher` — NFS Drop-Folder Communication

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

### `bottleneck_detector` — Approval Bottleneck Detection

Tracks approval patterns and flags workflow bottlenecks. Runs every 6 hours.

```json
"bottleneck_detector": {
    "enabled": true,
    "interval_hours": 6,
    "approval_threshold": 10,
    "lookback_days": 7
}
```

### `command_channels` — Trust Model

Defines per-channel trust levels for incoming commands. Channels can be `command` (auto-execute), `proposal` (create task for review), or `context` (read-only).

See `config/orchestrator.json` for the full trust configuration.
