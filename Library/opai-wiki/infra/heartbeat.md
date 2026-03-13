# Proactive Heartbeat (v3.5)

> Last updated: 2026-03-12 (PI: disabled TeamHub item creation, fixed recursive self-feeding bug) | Source: `tools/opai-engine/background/heartbeat.py`

## Overview

The heartbeat is a background loop inside the Engine that transforms OPAI from a reactive tool suite into a proactive team member. Every 30 minutes it aggregates work items from all tracking systems, detects changes (completions, failures, stalls), auto-recovers crashed workers, sends Telegram alerts, generates daily notes, checks HITL escalation timers, and runs **proactive intelligence** — detecting actionable patterns without being asked.

**Success criteria**: You wake up, check Telegram, and OPAI has already told you: "3 tasks completed overnight, 1 needs your decision, all services healthy, and I noticed 2 items are overdue — want me to auto-route them?"

## Architecture

The heartbeat is one of 12+ background tasks in the Engine. It is primarily an **aggregation layer** — it reads from existing systems, detects patterns, and takes corrective action (stall recovery, proactive suggestions, HITL escalation).

```
Engine Background Tasks (12+ total)
├── scheduler (60s)           ← heartbeat READS active_jobs, last_run
├── service-monitor (300s)
├── auto-executor (30s)
├── resource-monitor (30s)    ← heartbeat READS cpu/memory state
├── updater (300s)
├── stale-sweeper (120s)
├── worker-health (60s)       ← heartbeat READS worker health/status
├── bottleneck-detector (6h)  ← detects approval/workflow bottlenecks
├── fleet-coordinator (5m)    ← work dispatch + Team Hub integration
├── nfs-dispatcher (30s)      ← NFS drop-folder worker communication
├── process-sweeper (300s)    ← orphan Claude process cleanup
├── heartbeat (1800s)         ← aggregates, detects, notifies, proactive intelligence
├── notebooklm-sync (daily)   ← wiki sync to NotebookLM (optional)
└── chat-fast-loop (30s)      ← Google Chat message polling (optional)
```

### What Shares the 30-Minute Interval

Two things fire on the 30-minute mark:

| System | Mechanism | What It Does |
|--------|-----------|-------------|
| **email_check** | Cron schedule (`*/30 * * * *` in `orchestrator.json`) | Scheduler dispatches email checker (`node index.js --check`) |
| **heartbeat** | Async loop (`interval_minutes: 30` in `orchestrator.json`) | Builds snapshot, detects changes, sends notifications |

These are independent — the scheduler runs email_check via cron matching, while the heartbeat runs its own `asyncio.sleep()` loop. They may not fire at exactly the same second, but both target the 30-minute cadence.

Additionally, `task_processor.cooldown_minutes: 30` is a **cooldown** (minimum gap between squad runs), not a trigger — it doesn't independently fire on the 30-minute mark.

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-engine/background/heartbeat.py` | Core `Heartbeat` class: loop, snapshot, change detection, stall recovery, proactive intelligence (~1000 lines) |
| `tools/opai-engine/background/notifier.py` | Telegram Bot API notifications: alerts, HITL buttons, escalation tracking |
| `tools/opai-engine/background/daily_note.py` | End-of-day note generation + AI summary |
| `tools/opai-engine/routes/heartbeat.py` | API endpoints (latest, daily-notes, trigger) |
| `tools/opai-engine/data/heartbeat-state.json` | Persisted state (survives restarts) |
| `tools/opai-engine/data/proactive-state.json` | Proactive intelligence state (dedup, patterns, last run) |
| `config/orchestrator.json` → `heartbeat` | Heartbeat runtime configuration |
| `config/orchestrator.json` → `proactive_intelligence` | PI thresholds and behavior |

## Configuration

In `config/orchestrator.json`:

```json
"heartbeat": {
    "interval_minutes": 30,
    "stall_threshold_minutes": 60,
    "daily_note_hour": 23,
    "daily_note_minute": 55,
    "notifications_enabled": true,
    "ai_summary_enabled": true,
    "max_notifications_per_cycle": 5,
    "hitl_thread_id": 112,
    "digest_interval_cycles": 6
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `interval_minutes` | 30 | How often the heartbeat runs |
| `stall_threshold_minutes` | 60 | Workers must be unhealthy for 2 consecutive snapshots (= 2x interval) before restart |
| `daily_note_hour/minute` | 23:55 | When to generate the daily note |
| `notifications_enabled` | true | Master switch for Telegram notifications |
| `ai_summary_enabled` | true | Whether daily notes get a Claude Haiku AI summary |
| `max_notifications_per_cycle` | 5 | Cap on items per Telegram message (batches beyond this) |
| `hitl_thread_id` | 112 | Telegram forum topic for HITL notifications |
| `digest_interval_cycles` | 6 | Cycles between activity digest messages |

### Proactive Intelligence Configuration

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

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | true | Master switch for proactive intelligence |
| `check_interval_cycles` | 3 | Run PI every N heartbeat cycles (= every 90 min at 30-min interval) |
| `overdue_threshold_minutes` | 60 | Flag unassigned Team Hub items older than this |
| `assigned_stall_minutes` | 120 | Flag assigned items with no progress after this long |
| `idle_worker_minutes` | 60 | Flag NFS workers idle longer than this when tasks are pending |
| `pattern_detection_min_count` | 3 | Minimum completions of same type before suggesting automation |
| `auto_act_enabled` | false | Whether PI can auto-act (currently proposal-only) |
| `max_suggestions_per_cycle` | 5 | Cap suggestions per PI run |

## Snapshot Data Model

Each heartbeat cycle produces a snapshot:

```python
{
    "snapshot_at": "ISO timestamp",
    "cycle_number": 48,
    "work_items": {
        "worker:email-manager": {"source": "worker", "status": "healthy", "managed": true, ...},
        "task:t-20260228-001": {"source": "task_registry", "status": "running", ...},
        "session:54321": {"source": "claude_session", "type": "interactive", ...},
        "scheduler:email_check-1709146800": {"source": "scheduler", "status": "running", ...}
    },
    "summary": {
        "total": 29, "healthy": 3, "running_tasks": 1,
        "completed_since_last": 3, "failed_since_last": 1, "stalled": 0,
        "active_sessions": 2, "cpu": 32.5, "memory": 58.1,
        "agent_feedback": {"active_hints": 42, "recent_24h": 3, "gaps": 7, "corrections": 2}
    },
    "changes": [
        {"type": "completed", "item": "task:t-20260228-001", "title": "..."},
        {"type": "stall_detected", "item": "worker:email-manager", "action": "restarted"}
    ]
}
```

**Data sources** (all read-only):

| Source | What It Reads | Key |
|--------|--------------|-----|
| Worker Manager | `get_status()`, `get_worker_detail()` | `worker:{id}` |
| Scheduler | `active_jobs`, `last_run` | `scheduler:{job_id}` |
| Task Registry | `tasks/registry.json` (non-terminal statuses) | `task:{id}` |
| Session Collector | `get_concurrency_snapshot()` | `session:{pid}` |
| Resource Monitor | `get_resource_state()` | CPU/memory in summary |
| Agent Feedback | `engine_agent_feedback` (Supabase) | `agent_feedback` in summary (active hints, 24h, gaps, corrections). See [Agent Feedback Loops](agent-feedback-loops.md) |

## Change Detection

The heartbeat diffs the current snapshot against the previous one:

| Change Type | Trigger | Action |
|-------------|---------|--------|
| `completed` | Item was in previous snapshot but gone from current (scheduler job finished, task completed) | Telegram notification |
| `failed` | Worker went healthy→unhealthy, or task status changed to failed | Telegram notification |
| `stall_detected` | Managed worker unhealthy for 2+ consecutive cycles; or task running for >2x stall_threshold | Auto-restart (managed) or escalation log |
| `restarted` | Auto-restart succeeded | Telegram notification + audit entry |

## Stall Recovery

Stall detection uses **consecutive unhealthy counts** tracked across cycles:

1. Worker reported unhealthy → increment counter
2. Counter reaches 2 (= 1 hour at 30-min interval) → check if auto-restartable
3. If managed + `restart_on_failure` + under `max_restarts` → call `worker_manager.restart_worker()`
4. If not auto-restartable or max restarts reached → log for manual review

All stall events create audit entries (`heartbeat:stall`, `heartbeat:restart`) with tier `health`.

## Telegram Notifications

The notifier sends messages directly via Telegram Bot API (no dependency on the Telegram service process).

**Token strategy** (graceful degradation):
1. Check env vars `TELEGRAM_BOT_TOKEN` + `ADMIN_GROUP_ID`
2. Fallback: read `tools/opai-telegram/.env`
3. If neither: heartbeat runs, notifications silently skipped

**Message formats:**

Completion batch:
```
OPAI Heartbeat — 3 completed

  Review Google Cloud credentials (12m)
  Weekly knowledge sync (8m)
  Email check — 48 clean cycles

3/3 healthy | CPU 32% | Mem 58%
```

Stall alert:
```
OPAI Heartbeat — 1 stalled, 1 restarted

  Email Manager — stalled
  Action: Auto-restarted (attempt 2/5)

3/3 healthy | CPU 32% | Mem 58%
```

## Daily Notes

At the configured time (default 23:55), the heartbeat triggers daily note generation:

1. Reads `tasks/audit.json` filtered to today
2. Reads `tasks/registry.json` for tasks updated today
3. Classifies into completed/failed/health events
4. Optionally generates AI summary via `call_claude()` with haiku model
5. Writes markdown to `notes/daily/YYYY-MM-DD.md`
6. Sends summary to Telegram

**Note template:**
```markdown
# OPAI Daily Note — February 28, 2026

> AI Summary: Productive day with 3 task completions...

## Work Summary
### Completed (3)
- [14:32] Review Google Cloud credentials (12m 34s)

### Failed (1)
- [02:43] MDH video review — exit code 1

## Service Health
All services healthy (3/3). No restarts.

## Heartbeat Stats
- Cycles: 48 | Health events: 2 | Restarts: 0
- CPU: 32% | Memory: 58%
- Active sessions: 2

## Decisions Needed
- MDH video review failed 3 times — review or re-assign?
```

## API Endpoints

All under `/api/heartbeat/`:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/heartbeat/latest` | None | Current snapshot |
| GET | `/api/heartbeat/daily-notes` | None | List available daily notes (last 30) |
| GET | `/api/heartbeat/daily-notes/{date}` | None | Read a specific note (YYYY-MM-DD) |
| POST | `/api/heartbeat/trigger` | Admin | Force an immediate cycle |

## State Persistence

State is saved to `data/heartbeat-state.json` after every cycle:

- `cycle_count` — total cycles since first run
- `daily_note_sent_date` — prevents duplicate daily notes
- `consecutive_unhealthy` — per-worker unhealthy streak counter
- `last_snapshot` — previous snapshot for change detection

This file survives engine restarts. On startup, the heartbeat restores its state and can immediately detect changes against the last known snapshot.

## Audit Trail

The heartbeat writes to `tasks/audit.json` using the shared `log_audit()` function:

| Event | Tier | When |
|-------|------|------|
| `heartbeat:cycle` | health | Every cycle — summary of items and changes |
| `heartbeat:stall` | health | Stall detected (managed or non-managed) |
| `heartbeat:restart` | health | Auto-restart attempted (success or failure) |

## Proactive Intelligence (v3.5)

The proactive intelligence subsystem runs inside the heartbeat loop every N cycles (default 3, = every 90 minutes). It answers the question: **"What should the system do that nobody has asked for?"**

### Detection Rules

| Rule | Query | Suggestion |
|------|-------|------------|
| **Overdue items** | Team Hub items with status `open` or `awaiting-human`, no assignee, older than threshold | "Auto-route to {best worker}" |
| **Stalled assignments** | Team Hub items with status `assigned` or `in-progress`, older than threshold | "Check on {assignee} or reassign" |
| **Recurring patterns** | Fleet coordinator completions grouped by worker — same worker completing 3+ of same type | "Create automation for {pattern}" |
| **Idle workers with pending work** | NFS workers reporting healthy + idle, while registry has pending tasks matching their capabilities | "Dispatch {task} to idle {worker}" |

**Self-referential skip**: Items whose title starts with `[PI]` are excluded from overdue/stall detection to prevent recursive self-feeding (a bug where PI-created items were re-detected as overdue, creating nested `[PI] Unassigned for 90m: [PI] Unassigned for 90m:` spam — fixed 2026-03-12).

### Suggestion Flow

```
PI Detection → Deduplicate (skip if already suggested in last 24h)
             → Log to proactive-state.json + audit log
             → Stored for human review (state file only)
```

Suggestions are **proposal-only** (`auto_act_enabled: false`) and are logged to `proactive-state.json` and the audit trail. They are **not** written to Team Hub as items — an earlier approach that created Team Hub "idea" items was disabled (2026-03-12) because it generated noise in workspaces. The `auto_act_enabled` flag is reserved for future low-risk auto-actions.

**Future direction**: Pattern detection should evolve from superficial agent-run counting ("worker X ran 3 times") to meaningful operational pattern recognition ("you've fixed this same problem repeatedly across clients"). This is v4 scope.

### State Persistence

`data/proactive-state.json` tracks:
- `last_run` — timestamp of last PI cycle
- `cycle_counter` — incremented each heartbeat, PI runs when divisible by `check_interval_cycles`
- `recent_suggestions` — dedup set (suggestion hashes with timestamps, pruned after 24h)
- `pattern_cache` — fleet coordinator completion patterns for trend detection

---

## HITL Escalation (v3.5)

The notifier tracks escalation timers for HITL items sent via Telegram. If a notification is not acknowledged within 15 minutes, an escalation reminder is sent.

### Escalation Flow

```
1. HITL notification sent → start escalation timer
2. Every heartbeat cycle → check_hitl_escalations()
3. If item not acknowledged within 15 min → send escalation reminder
4. If acknowledged (any button press, including "Picked up in GC") → clear timer
5. Prune entries older than 4 hours
```

### Acknowledgment Methods

| Method | Effect |
|--------|--------|
| Any Telegram button (Run, Approve, Dismiss, Reject) | Clear timer + execute action |
| "Picked up in GC" button | Clear timer only (no status change) |
| GravityClaw `.response` file | NFS dispatcher clears timer via action items API |
| Engine dashboard action | API clears timer |

### Notification Buttons (v3.5)

HITL notifications now include 5 action buttons in 3 rows:

```
Row 1: [▶️ Run]  [✅ Approve]
Row 2: [🗑️ Dismiss]  [❌ Reject]
Row 3: [💻 Picked up in GC]
```

Button callbacks route through the Engine action items API when the callback key is a Team Hub UUID (`hitl:{action}:{uuid}`), or through the legacy HITL endpoint for older file-based items (`hitl:{action}:{filename}`).

---

## Temporary Monitors

### Synology Rescan Monitor (added 2026-03-05)

Tracks Synology Drive rescan progress after blacklist filter changes. Sends to Server Status topic on the same digest cadence. Auto-stops when rescan finishes (no daemon activity for 5 min). See [File Sync & Storage](file-sync.md) for full context.

- `notifier.py` → `notify_synology_rescan()` — reads daemon log, calculates progress/ETA
- `heartbeat.py` → `_check_synology_rescan()` — fires on same `digest_interval_cycles`

Can be removed once rescan completes and the notification returns `None` consistently.

---

## Relationship to Telegram Watchdog

The heartbeat + notifier handle ALL per-service health alerts (service up/down transitions). Telegram's `alerts.js` is reduced to a **watchdog-only** role — it independently pings `/health` to detect if the Engine itself crashes (the one thing the Engine can't self-report). Per-service monitoring in Telegram was removed to eliminate redundancy. See [Scheduling Architecture](scheduling-architecture.md) for the full overlap analysis.

## What the Heartbeat Does NOT Touch

- **Telegram service** (`tools/opai-telegram/`) — heartbeat sends notifications via Bot API (independent of the Telegram service process). 8 AM morning briefings (system/personal/team) are handled by the Telegram service's `alerts.js`, not the heartbeat
- **Scheduler** — heartbeat reads but never writes to scheduler state
- **Worker manager** — reads status, only calls `restart_worker()` for stall recovery
- **Task registry** — read-only (proactive intelligence reads only)
- **Team Hub** — proactive intelligence reads items for overdue/stall detection (read-only; previously wrote "idea" items, disabled 2026-03-12)
- **Fleet coordinator** — PI reads completion history for pattern detection (read-only)
- **NFS dispatcher** — PI reads worker health for idle detection (read-only)

## Dependencies

- `httpx` (already an Engine dependency) — for Telegram API calls + Team Hub internal API
- `psutil` (already an Engine dependency) — via session collector
- `tools/shared/claude_api.py` — for AI daily note summaries (optional, graceful fallback)
- `tools/shared/audit.py` — for audit trail entries
- [Team Hub](../tools/team-hub.md) internal API — proactive intelligence reads/writes items
- [Fleet Coordinator](fleet-action-items.md) — PI reads completion history
- [NFS Dispatcher](nfs-dispatcher.md) — PI reads worker health
- [Notifier](fleet-action-items.md) — HITL escalation tracking (`check_hitl_escalations()`)
