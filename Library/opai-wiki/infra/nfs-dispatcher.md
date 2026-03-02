# NFS Drop-Folder Dispatcher (v3.5)

> Last updated: 2026-03-02 | Source: `tools/opai-engine/background/nfs_dispatcher.py`, `tools/opai-engine/routes/nfs.py`

## Overview

The NFS dispatcher bridges the OPAI Engine to external ClaudeClaw worker machines via a file-based communication protocol. Task tracking lives in [Team Hub](../tools/team-hub.md) (the single source of truth), while NFS handles **execution context** — the files, code, and workspace that remote workers need to do actual work.

**Design principle**: Team Hub tracks *what* needs doing; NFS delivers *how* to do it. A worker picks up a context bundle from its inbox, does the work, and drops the result in its outbox. The dispatcher polls for completed work and feeds results back to Team Hub.

| Property | Value |
|----------|-------|
| **Background task** | `nfs_dispatcher.run()` inside Engine |
| **Poll interval** | 30s (configurable) |
| **Base path** | `/workspace/users/_clawbots/` |
| **Admin HITL path** | `/workspace/users/_admin/hitl/` |
| **State file** | `tools/opai-engine/data/nfs-dispatcher-state.json` |
| **Config** | `config/orchestrator.json` → `nfs_dispatcher` |
| **Worker registry** | `config/workers.json` → `nfs-external` |

## Architecture

```
Engine (NFS Dispatcher)                   NFS Mount                    External Worker
─────────────────────                     ──────────                   ────────────────
dispatch_to_nfs()  ──→  inbox/{task-id}/context.json    ←── worker picks up READY
                        inbox/{task-id}/workspace/           sentinel, reads context,
                        inbox/{task-id}/READY                executes task

poll_outboxes()    ←──  outbox/{task-id}/result.json    ←── worker writes output,
                        outbox/{task-id}/output/             drops DONE sentinel
                        outbox/{task-id}/DONE

collect_result()   ──→  Update Team Hub item status
                        Archive to worker/logs/
                        Send Telegram notification
```

### Admin HITL Sync

For GravityClaw (Dallas's personal ClaudeClaw instance on macOS), HITL items are synced to a separate admin directory:

```
Engine                          NFS                          GravityClaw
──────                          ───                          ───────────
sync_hitl_to_admin()  ──→  _admin/hitl/{item-id}.md    ←── reads briefing

poll_admin_responses() ←── _admin/hitl/{item-id}.response ←── writes decision
                            (approve|dismiss|run|reject)
                                                             auto-cleanup both files
```

## Directory Structure

### Per-Worker Layout

```
/workspace/users/_clawbots/{worker-slug}/
  inbox/                    # Engine drops execution context here
    {task-id}/
      context.json          # Team Hub item ID + execution instructions
      workspace/            # Files the worker needs access to
      READY                 # Sentinel file: "ready to pick up"
  outbox/                   # Worker writes results here
    {task-id}/
      result.json           # Output summary + Team Hub item ID
      output/               # Produced files
      DONE                  # Sentinel file: "ready to collect"
  status/
    heartbeat.json          # { alive: true, last_seen, current_task, load }
    capabilities.json       # Worker self-description + supported task types
  config/
    worker-profile.json     # Engine-written configuration
    CLAUDE.md               # Worker instructions (project-level)
  knowledge/                # Read-only shared knowledge (symlinks to Library/)
  logs/                     # Activity logs + completed task archives
```

### Admin HITL Directory

```
/workspace/users/_admin/hitl/
  {item-id}.md              # Rendered HITL briefing (markdown)
  {item-id}.response        # GC writes action: approve|dismiss|run|reject
```

### Context Bundle (`context.json`)

```json
{
  "task_id": "th:item-uuid",
  "teamhub_item_id": "uuid",
  "title": "Review API security audit",
  "description": "Full task description...",
  "priority": "high",
  "instructions": "Additional execution guidance",
  "dispatched_at": "2026-03-02T14:30:00Z",
  "dispatcher": "fleet-coordinator"
}
```

### Result Bundle (`result.json`)

```json
{
  "task_id": "th:item-uuid",
  "teamhub_item_id": "uuid",
  "status": "completed",
  "summary": "Found 3 issues, all patched...",
  "started_at": "2026-03-02T14:31:00Z",
  "completed_at": "2026-03-02T14:45:00Z",
  "output_files": ["report.md", "patch.diff"]
}
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-engine/background/nfs_dispatcher.py` | Core `NfsDispatcher` class (~380 lines): dispatch, poll, collect, health, HITL sync |
| `tools/opai-engine/routes/nfs.py` | API endpoints: status, history, workers, dispatch |
| `tools/opai-engine/data/nfs-dispatcher-state.json` | Persisted state (active tasks, collections, health, stats) |
| `config/orchestrator.json` → `nfs_dispatcher` | Runtime configuration |
| `config/workers.json` → `nfs-external` | Worker registry with per-worker capabilities |

## Configuration

### `config/orchestrator.json` → `nfs_dispatcher`

```json
{
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
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | true | Master switch |
| `poll_interval_seconds` | 30 | How often to scan outboxes + health |
| `base_path` | `/workspace/users/_clawbots` | Root for all NFS worker directories |
| `admin_hitl_path` | `/workspace/users/_admin/hitl` | Where HITL briefings sync for GravityClaw |
| `max_concurrent_nfs_tasks` | 5 | Global limit on active NFS dispatches |
| `heartbeat_stale_minutes` | 10 | Worker heartbeat freshness threshold |
| `hitl_sync_enabled` | true | Whether to sync HITL items to admin dir |
| `admin_response_poll` | true | Whether to poll for admin .response files |

### `config/workers.json` → `nfs-external`

```json
{
  "nfs-external": {
    "name": "NFS External Worker",
    "type": "nfs-external",
    "runtime": "claude-code-remote",
    "trigger": { "mode": "nfs-drop" },
    "nfs": {
      "base_path": "/workspace/users/_clawbots",
      "inbox_sentinel": "READY",
      "outbox_sentinel": "DONE",
      "heartbeat_file": "status/heartbeat.json",
      "capabilities_file": "status/capabilities.json"
    },
    "registered_workers": {
      "test-nas-01": {
        "name": "Test NAS Worker",
        "enabled": true,
        "capabilities": ["research", "code_review"],
        "max_concurrent": 1
      }
    }
  }
}
```

## Dispatcher Lifecycle

### Main Loop

```python
async def run():
    while True:
        await _poll_outboxes()          # Check for completed work
        await _check_worker_health()    # Read heartbeat.json files
        _check_active_tasks()           # Flag stale dispatches
        await _sync_hitl_to_admin()     # Render HITL items as .md
        await _poll_admin_responses()   # Check .response files
        _save_state()
        await asyncio.sleep(poll_interval)
```

### Dispatch Flow

1. `dispatch_to_nfs(worker_slug, teamhub_item_id, context)` called by fleet coordinator or API
2. Writes `context.json` to `inbox/{task_id}/`
3. Creates `READY` sentinel file
4. Updates Team Hub item status to `assigned`
5. Records active task in state

### Collection Flow

1. `_poll_outboxes()` scans all worker `outbox/` dirs for `DONE` sentinels
2. `_collect_result(worker_slug, task_id)` reads `result.json`
3. Updates Team Hub item (status → `review` or `done`, adds comment with summary)
4. Copies output files to `reports/latest/nfs-{worker}-{task_id}/`
5. Archives context+result to `worker/logs/{task_id}/`
6. Cleans up inbox and outbox
7. Sends Telegram notification

### HITL Sync Flow

1. `_sync_hitl_to_admin()` queries Team Hub for `awaiting-human` items in Workers workspace
2. For each item, renders a markdown briefing to `_admin/hitl/{item_id}.md`
3. Cleans up .md files for items no longer awaiting-human

### Admin Response Flow

1. `_poll_admin_responses()` scans for `.response` files
2. Reads action (approve/dismiss/run/reject)
3. Updates Team Hub item status accordingly
4. Cleans up both `.md` and `.response` files
5. Sends Telegram confirmation

## API Endpoints

All under `/api/nfs/`:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/nfs/status` | None | Current state: active tasks, worker health, cycle count, stats |
| GET | `/api/nfs/history` | None | Recent collection history (default 50) |
| GET | `/api/nfs/workers` | None | Health status of all registered NFS workers |
| POST | `/api/nfs/dispatch` | Admin | Manually dispatch task to NFS worker |

### Dispatch Request Body

```json
{
  "worker_slug": "test-nas-01",
  "teamhub_item_id": "uuid",
  "priority": "high",
  "instructions": "Optional additional context"
}
```

## Integration with Action Items

The NFS dispatcher surfaces two types of items in the [Action Items API](fleet-action-items.md):

1. **Stale NFS tasks** — Active dispatches exceeding 3x the heartbeat stale threshold (type: `stalled_worker`, priority_score: 75)
2. **Unhealthy NFS workers** — Workers with stale heartbeats or reported errors (type: `stalled_worker`, priority_score: 60)

These appear in the Engine dashboard "My Queue" tab and Command Center "Needs Your Attention" widget.

## State Persistence

State saved to `data/nfs-dispatcher-state.json` after every cycle:

- `active_tasks` — Currently dispatched tasks with worker, item_id, dispatched_at
- `collections` — Recent result collections (last 100)
- `worker_health` — Per-worker status from heartbeat.json
- `stats` — Dispatch count, collection count, error count
- `last_cycle` — Timestamp of last poll cycle

## Worker Setup (External Machine)

A ClaudeClaw worker machine needs:

1. **NFS mount** to `/workspace/users/_clawbots/{slug}/` (read-write)
2. **Claude Code CLI** installed
3. **Heartbeat process** writing `status/heartbeat.json` periodically
4. **Inbox watcher** polling for `READY` sentinels
5. **CLAUDE.md** in config/ with worker instructions

See [OPAI Evolution Plan](../plans/opai-evolution.md) for the Ubuntu Server 24.04 LTS worker OS specification.

## Dependencies

- **Reads**: `config/orchestrator.json`, `config/workers.json`, NFS filesystem
- **Writes**: NFS filesystem (inbox, admin HITL), state file, reports
- **Calls**: [Team Hub](../tools/team-hub.md) internal API (item CRUD, comments)
- **Called by**: [Fleet Coordinator](fleet-action-items.md) (dispatch), [Action Items API](fleet-action-items.md) (status queries)
- **Notifies**: [Telegram](../integrations/telegram-bridge.md) via notifier.py
- **Companion**: [Fleet Coordinator](fleet-action-items.md) — handles local workers; NFS dispatcher handles remote
