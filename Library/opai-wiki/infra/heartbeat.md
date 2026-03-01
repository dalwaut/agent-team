# Proactive Heartbeat (v3 Phase 3.0)

> Last updated: 2026-02-28 | Source: `tools/opai-engine/background/heartbeat.py`

## Overview

The heartbeat is a background loop inside the Engine that transforms OPAI from a reactive tool suite into a proactive team member. Every 30 minutes it aggregates work items from all tracking systems, detects changes (completions, failures, stalls), auto-recovers crashed workers, sends Telegram alerts, and generates daily notes.

**Success criteria**: You wake up, check Telegram, and OPAI has already told you: "3 tasks completed overnight, 1 needs your decision, all services healthy."

## Architecture

The heartbeat is the 8th background task in the Engine, sitting alongside the existing 7. It is a **pure aggregation layer** — it reads from existing systems without modifying them (except `restart_worker()` for stall recovery).

```
Engine Background Tasks (8 total)
├── scheduler (60s)           ← heartbeat READS active_jobs, last_run
├── service-monitor (300s)
├── auto-executor (30s)
├── resource-monitor (30s)    ← heartbeat READS cpu/memory state
├── updater (300s)
├── stale-sweeper (120s)
├── worker-health (60s)       ← heartbeat READS worker health/status
└── heartbeat (1800s)         ← aggregates, detects, notifies
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
| `tools/opai-engine/background/heartbeat.py` | Core `Heartbeat` class: loop, snapshot, change detection, stall recovery |
| `tools/opai-engine/background/notifier.py` | Telegram Bot API notifications via httpx |
| `tools/opai-engine/background/daily_note.py` | End-of-day note generation + AI summary |
| `tools/opai-engine/routes/heartbeat.py` | API endpoints (latest, daily-notes, trigger) |
| `tools/opai-engine/data/heartbeat-state.json` | Persisted state (survives restarts) |
| `config/orchestrator.json` → `heartbeat` | Runtime configuration |

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
    "max_notifications_per_cycle": 5
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
        "active_sessions": 2, "cpu": 32.5, "memory": 58.1
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

## What the Heartbeat Does NOT Touch

- **Telegram service** (`tools/opai-telegram/`) — zero changes. 8 AM briefing continues independently
- **Scheduler** — heartbeat reads but never writes to scheduler state
- **Worker manager** — reads status, only calls `restart_worker()` for stall recovery
- **Task registry** — read-only
- **Other background tasks** — all 7 existing tasks run unchanged

## Dependencies

- `httpx` (already an Engine dependency) — for Telegram API calls
- `psutil` (already an Engine dependency) — via session collector
- `tools/shared/claude_api.py` — for AI daily note summaries (optional, graceful fallback)
- `tools/shared/audit.py` — for audit trail entries
