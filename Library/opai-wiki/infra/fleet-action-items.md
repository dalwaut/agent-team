# Fleet Coordinator & Action Items API (v3.5 + Swarm)

> Last updated: 2026-03-05 | Source: `tools/opai-engine/background/fleet_coordinator.py`, `tools/opai-engine/services/worker_mail.py`, `tools/opai-engine/routes/action_items.py`

## Overview

The fleet coordinator and action items API form the **work dispatch and visibility backbone** of OPAI. The fleet coordinator identifies work, routes it to the right worker, and tracks execution. The action items API aggregates everything that needs human attention into a single prioritized feed — the "My Queue" that replaces scattered HITL briefing files.

**Key shift (v3.5)**: [Team Hub](../tools/team-hub.md) is now the **single source of truth** for task tracking. Both humans and agents interact through the same system. HITL items become Team Hub items with `status: awaiting-human`, visible in the Engine dashboard, Telegram, and Team Hub UI simultaneously.

**Swarm enhancements (v3.6)**: Five additions transform OPAI from a flat fleet dispatch model into a true swarm:

| Feature | Description |
|---------|-------------|
| **Worker Mail** | SQLite-backed inter-worker messaging with Team Hub mirroring |
| **Pre-Task Priming** | Workers start with operational journal + unread mail context |
| **Hierarchical Delegation** | Lead workers decompose complex tasks, dispatch sub-workers |
| **Auto-Review Pipeline** | Builder completions auto-trigger reviewer before finalization |
| **Self-Improvement Loop** | Workers propose new tasks discovered during runs (human gate) |

| Component | File | Purpose |
|-----------|------|---------|
| Fleet Coordinator | `background/fleet_coordinator.py` | Work identification, routing, dispatch, delegation, review, proposals |
| Worker Mail | `services/worker_mail.py` | SQLite mail system + Team Hub mirror |
| Mail API | `routes/mail.py` | REST endpoints for mail debugging |
| Action Items API | `routes/action_items.py` | Aggregation, priority scoring, action execution |
| Action Items UI | `static/index.html` + `static/js/app.js` | My Queue tab + CC widget |
| NFS Dispatcher | `background/nfs_dispatcher.py` | Remote worker dispatch via drop-folders |

## Architecture

```
                        ┌─────────────────────────┐
                        │     Action Items API     │
                        │  GET /api/action-items   │
                        └───────────┬─────────────┘
                                    │ aggregates from
                 ┌──────────────────┼──────────────────┐
                 │                  │                   │
    ┌────────────▼───┐   ┌────────▼────────┐   ┌─────▼──────────┐
    │   Team Hub     │   │   Guardrails    │   │   Heartbeat    │
    │ awaiting-human │   │   pending       │   │   stalled      │
    │ blocked        │   │   approvals     │   │   workers      │
    │ review         │   │                 │   │                │
    └────────────────┘   └────────────────┘   └────────────────┘
                 │                                     │
    ┌────────────▼───┐                   ┌────────────▼──────────┐
    │ NFS Dispatcher │                   │  Updater Suggestions  │
    │ stale tasks    │                   │  pending items        │
    │ unhealthy wkrs │                   │                       │
    └────────────────┘                   └───────────────────────┘

                     ┌─────────────────────────────────┐
                     │        Worker Mail System        │
                     │      (SQLite: data/mail.db)      │
                     ├─────────────────────────────────┤
                     │  @coordinator ← dispatch reqs    │
                     │  @coordinator ← task proposals   │
                     │  worker ↔ worker messages        │
                     │  @all / @builders / @leads       │
                     │  Team Hub mirror (escalation,    │
                     │    error, worker_done, new_task) │
                     └─────────────────────────────────┘
```

---

## Fleet Coordinator

### Main Cycle (every 5 minutes)

```python
async def _cycle():
    _check_active_dispatches()      # Monitor running work
    _poll_dispatch_mail()            # v3.6: Read lead worker dispatch requests
    _process_task_proposals()        # v3.6: Handle worker task proposals
    _mail.flush_mirrors()            # v3.6: Post mirrored messages to Team Hub
    signals = _gather_signals()      # Heartbeat + registry + suggestions
    work_items = _identify_work()    # Rule-based detection
    for item in work_items:
        worker = _route_work(item)   # Category + keyword + lead routing
        _dispatch(worker, item)      # Launch worker, track in state
    _update_queue_depth()            # Report metrics
```

### Signal Sources

| Source | What It Provides |
|--------|-----------------|
| Heartbeat snapshot | Worker health, resource state, active sessions |
| Task registry | Pending/approved tasks from `tasks/registry.json` |
| Bottleneck suggestions | Auto-detected workflow bottlenecks |
| Team Hub | Items in "assigned" or "in-progress" status |
| Worker Mail (v3.6) | Dispatch requests from lead workers, task proposals |

### Work Identification (Rule-Based)

| Signal | Triggers |
|--------|----------|
| Approved tasks ready for dispatch | Task status = `approved`, not already dispatched |
| High-priority tasks waiting too long | Priority >= high, age > `escalation_threshold_hours` |
| Stale tasks | Age > `stale_task_threshold_hours`, no assignee |
| Heartbeat unhealthy items | Service/worker in unhealthy state |
| Mail dispatch requests (v3.6) | Lead workers request sub-worker spawning |
| Task proposals (v3.6) | Workers discover tasks during runs → `proposed` status (human gate) |

### Routing Logic (Priority Order)

1. **Explicit `agent_type`** from task routing metadata
2. **Lead worker delegation (v3.6)** — routes to `project-lead` when:
   - Task description > 500 characters, OR
   - Task has `routing.use_lead = true`
3. **Category-based** from `orchestrator.json` → `fleet_coordinator.routing`:
   ```json
   {
     "code_review": "project-reviewer",
     "code_build": "project-builder",
     "research": "researcher",
     "security": "security-scanner",
     "wiki_update": "wiki-librarian",
     "default": "self-assessor"
   }
   ```
4. **Context-aware keyword matching** against worker `intent.capabilities`
5. **Fallback** to default worker (self-assessor)

### Dispatch Tracking

Each dispatch creates a record:

```python
{
    "dispatch_id": "fd-20260302-001-project-bu",
    "worker_id": "project-builder",
    "task_id": "t-20260302-001",
    "teamhub_item_id": "uuid",
    "started_at": "ISO timestamp",
    "workspace": "/workspace/local/agent-workspaces/...",
    "title": "Task description"
}
```

### Team Hub Integration (v3.5)

On dispatch:
- Creates or updates Team Hub item with `status: in-progress`
- Records `teamhub_item_id` in dispatch record

On completion:
- Updates Team Hub item to `status: review` (or `done` if auto-approve)
- Adds comment with agent output summary
- Sends Telegram notification

### Post-Completion Processing (v3.6)

After a worker completes, `_run_and_track()` performs:

1. **Parse `DISPATCH:` lines** from output → send as `dispatch` mail to `@coordinator`
2. **Parse `PROPOSE_TASK:` lines** from output → send as `new_task` mail to `@coordinator`
3. **Auto-review check** — if worker is in `auto_review_workers`, trigger reviewer
4. **Parent notification** — if this was a sub-worker, send `worker_done` mail to parent lead

### Configuration

`config/orchestrator.json` → `fleet_coordinator`:

```json
{
  "fleet_coordinator": {
    "enabled": true,
    "interval_minutes": 5,
    "max_concurrent_dispatches": 3,
    "auto_dispatch_approved": true,
    "escalation_threshold_hours": 1,
    "stale_task_threshold_hours": 24,
    "routing": { ... },
    "delegation": {
      "enabled": true,
      "max_delegation_depth": 2,
      "lead_workers": ["project-lead"],
      "sub_worker_timeout_minutes": 20
    },
    "review_pipeline": {
      "enabled": true,
      "auto_review_workers": ["project-builder"],
      "reviewer_worker": "project-reviewer"
    }
  }
}
```

### State Persistence

Saved to `data/fleet-state.json`:
- `active_dispatches` — Currently running work
- `recent_completions` — Last 100 completions
- `queue_depth` — Current pending work count
- `stats` — Dispatch count, completion count, error count (daily reset)

---

## Worker Mail System (v3.6)

SQLite-backed inter-worker messaging enabling true swarm communication.

### Database

`tools/opai-engine/data/mail.db` (WAL mode):

```sql
CREATE TABLE messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_worker     TEXT NOT NULL,
    to_worker       TEXT NOT NULL,     -- worker ID or group address
    type            TEXT NOT NULL,     -- status|question|result|error|dispatch|worker_done|escalation|new_task
    protocol        TEXT DEFAULT 'mail',
    subject         TEXT NOT NULL,
    body            TEXT DEFAULT '',
    thread_id       INTEGER,           -- NULL=new thread, else references messages.id
    dispatch_id     TEXT,
    teamhub_item_id TEXT,
    read            INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### Group Addresses

| Address | Resolves To |
|---------|-------------|
| `@all` | All registered workers |
| `@builders` | Task workers with `read_only = false` |
| `@leads` | Workers with `delegation_capable = true` |
| `@coordinator` | Fleet coordinator (special — reads directly in cycle) |

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/mail/inbox/{worker_id}` | Check inbox (query: `unread_only`, `limit`) |
| `GET` | `/api/mail/message/{msg_id}` | Read single message (marks as read) |
| `GET` | `/api/mail/thread/{thread_id}` | Read entire thread |
| `POST` | `/api/mail/send` | Send message (body: `SendRequest`) |
| `POST` | `/api/mail/reply/{msg_id}` | Reply to message (inherits thread) |
| `GET` | `/api/mail/stats` | Message counts per worker + totals |

### Team Hub Mirror

Messages of these types with `teamhub_item_id` set are auto-posted as Team Hub comments:
- `escalation`
- `error`
- `worker_done`
- `new_task`

Mirror flush happens once per fleet coordinator cycle.

### Mail Cleanup

Called daily from heartbeat — deletes messages older than 30 days.

---

## Pre-Task Context Priming (v3.6)

Workers start every task with situational awareness injected into their prompt.

### Journal Prime

Source: `data/journal-latest.json` (from context harvester worker)

Injected as:
```
--- OPERATIONAL CONTEXT ---
[operational summary from context harvester, capped at 2000 chars]
--- END OPERATIONAL CONTEXT ---
```

### Mail Prime

Source: Worker's unread inbox (up to 10 messages)

Injected as:
```
--- WORKER MAIL (unread) ---
[status] from=project-reviewer subject="Review passed"
  Review of auth module passed with 2 minor suggestions...
[dispatch] from=@coordinator subject="New task assigned"
  Sub-worker project-builder dispatched for...
--- END WORKER MAIL ---
```

Both blocks are injected in `WorkerManager._load_prompt()` after the intent block and before task context.

---

## Hierarchical Delegation (v3.6)

Lead workers analyze complex tasks, decompose them, and request sub-worker dispatches via mail.

### Architecture

```
Fleet Coordinator (top-level orchestrator)
    │
    ├── Routes complex tasks to project-lead
    │
    └── project-lead (Lead Worker)
            │
            ├── Analyzes task complexity
            ├── Outputs DISPATCH: lines
            │
            └── Fleet Coordinator reads @coordinator mail
                    │
                    ├── Spawns sub-workers (project-builder, researcher, etc.)
                    └── Sends worker_done mail back to lead on completion
```

### Lead Worker: `project-lead`

Registered in `config/workers.json` with `delegation_capable: true`:

```json
{
  "project-lead": {
    "guardrails": {
      "read_only": true,
      "delegation_capable": true,
      "max_turns": 20,
      "timeout_minutes": 15,
      "model": "sonnet",
      "max_sub_workers": 3
    }
  }
}
```

### DISPATCH Output Format

Lead workers output structured dispatch requests:

```
DISPATCH: worker=project-builder title="Implement X" description="..." priority=normal
DISPATCH: worker=researcher title="Investigate Y" description="..." priority=high
```

Key-value parsing supports both `key=value` and `key="quoted value"` formats.

### Dispatch Mail Flow

1. Lead worker completes → `_run_and_track()` parses `DISPATCH:` lines
2. Each line is sent as `type=dispatch` mail to `@coordinator`
3. Next fleet cycle → `_poll_dispatch_mail()` reads @coordinator inbox
4. Verifies sender has `delegation_capable: true` guardrail
5. Checks delegation depth < `max_delegation_depth` (default 2)
6. Dispatches sub-worker via existing `_dispatch_work()`
7. Sends confirmation mail back to lead
8. On sub-worker completion → sends `worker_done` mail to parent lead

### Depth Limiting

Prevents runaway delegation chains:
- Coordinator → Lead = depth 1
- Lead → Sub-worker = depth 2
- Sub-worker → further dispatch = **REJECTED** (depth 2 >= max 2)

---

## Auto-Review Pipeline (v3.6)

Builder completions auto-trigger reviewer before task finalization.

### Flow

```
project-builder completes (evaluation passes)
    │
    ├── Writes builder-output.md to workspace/context/
    │
    └── Runs project-reviewer on same workspace
            │
            ├── PASS → task status = "completed"
            │   └── Telegram: [BUILD+REVIEW PASS]
            │
            └── FAIL → task status = "review" (HITL needed)
                └── Telegram: [BUILD+REVIEW FAIL]
```

### Configuration

```json
"review_pipeline": {
    "enabled": true,
    "auto_review_workers": ["project-builder"],
    "reviewer_worker": "project-reviewer"
}
```

Only triggers when:
- Worker is in `auto_review_workers` list
- Builder completed with passing evaluation
- `review_pipeline.enabled = true`

### Builder Output Injection

The builder's output summary is written to `workspace/context/builder-output.md` so the reviewer can read it. The review task context includes `review_mode: auto-review` and `builder_worker`, `builder_dispatch_id`, `builder_elapsed_min` fields.

---

## Self-Improvement Loop (v3.6)

Workers can propose new tasks discovered during their runs, subject to human approval.

### PROPOSE_TASK Output Format

Any worker can include this in their output:

```
PROPOSE_TASK: title="Fix auth session timeout bug" reason="Found expired sessions during security scan" priority=high
```

### Processing Flow

1. Worker output parsed for `PROPOSE_TASK:` lines in `_run_and_track()`
2. Each proposal sent as `type=new_task` mail to `@coordinator`
3. Fleet cycle → `_process_task_proposals()` reads proposals from mail
4. Creates registry entry with **`status: "proposed"`** (never auto-dispatched)
5. Creates Team Hub item with `[Proposed]` prefix for visibility
6. Sends Telegram notification with **Approve / Dismiss** buttons
7. Sends confirmation mail back to proposing worker

### Human Gate

Proposed tasks use `status: "proposed"` in the registry. The fleet coordinator's `_identify_work()` only picks up tasks with `status in ("approved", "pending")`, so proposed tasks are **never auto-dispatched**. A human must:
- Click "Approve" in Telegram, OR
- Change status in Team Hub, OR
- Approve via the Engine dashboard

### Prompt Injection

All workers receive this in their intent block:

```
Self-improvement: If you discover a new task, bug, or improvement
during your work, you can propose it by including this line in your output:
  PROPOSE_TASK: title="..." reason="..." priority=normal
Proposed tasks go through human approval before execution.
```

---

## Action Items API

### Endpoint: `GET /api/action-items`

Aggregates actionable items from 6 sources into one priority-scored list. Team Hub queries run **in parallel** via `asyncio.gather()` (3 concurrent HTTP calls instead of sequential — ~250-450ms vs ~788ms).

| Source | Item Type | Base Score |
|--------|-----------|------------|
| Team Hub `awaiting-human` | `hitl_decision` | 80 |
| Team Hub `blocked` | `blocked_agent` | 75 |
| Team Hub `review` | `review_needed` | 65 |
| Guardrails pending approvals | `pending_approval` | 70 |
| Heartbeat stalled workers | `stalled_worker` | 75 (critical) / 50 |
| NFS stale tasks / unhealthy workers | `stalled_worker` | 75 / 60 |
| Updater suggestions | `suggestion` | 30 |

### Priority Scoring

Each item gets a `priority_score` (0-100) based on type + modifiers:

| Modifier | Bonus |
|----------|-------|
| High priority tag | +10 |
| Age > 30 minutes (HITL) | +10 |
| Age > 1 hour (approval) | +15 |
| Urgent priority | +15 |
| Critical service | +25 (stalled worker) |

### Response Format

```json
{
  "action_items": [
    {
      "id": "th:item-uuid",
      "type": "hitl_decision",
      "title": "Review API security changes",
      "priority": "high",
      "priority_score": 90,
      "created_at": "2026-03-02T10:00:00Z",
      "age_minutes": 45,
      "source": "fleet-coordinator",
      "assignee": "researcher",
      "actions": ["approve", "run", "dismiss", "reject", "gc"],
      "teamhub_item_id": "uuid",
      "content_preview": "First 200 chars of description..."
    }
  ],
  "summary": {
    "total": 5,
    "by_type": {
      "hitl_decision": 2,
      "review_needed": 1,
      "suggestion": 2
    }
  },
  "available_workers": [
    {
      "id": "project-builder",
      "name": "Project Builder",
      "type": "claude-agent",
      "status": "idle"
    },
    {
      "id": "nfs:test-nas-01",
      "name": "Test NAS Worker",
      "type": "nfs-external",
      "status": "healthy"
    }
  ]
}
```

### Endpoint: `POST /api/action-items/{item_id}/act`

Executes an action on an item. Routes through Team Hub for status updates.

| Action | Effect |
|--------|--------|
| `approve` | Team Hub status → `assigned`, ready for fleet dispatch |
| `run` | Team Hub status → `in-progress`, immediate fleet dispatch |
| `dismiss` | Team Hub status → `dismissed` |
| `reject` | Team Hub status → `dismissed` + rejection comment |
| `gc` | Acknowledge "picked up in GravityClaw" — no status change, comment added, escalation timer cleared |

All actions also call `acknowledge_hitl()` in the notifier to clear Telegram escalation timers.

### Endpoint: `POST /api/action-items/dispatch`

Manual dispatch of a Team Hub item to a specific worker:

```json
{
  "teamhub_item_id": "uuid",
  "worker_id": "project-builder",
  "instructions": "Optional extra context"
}
```

Supports both local workers (fleet coordinator) and NFS workers (nfs dispatcher), auto-detected by worker type.

---

## Engine Dashboard UI

### My Queue Tab

Three subtabs:

| Subtab | Content |
|--------|---------|
| **All Items** | Every action item, sorted by priority_score descending |
| **HITL Decisions** | Items of type `hitl_decision` only |
| **Agent Reviews** | Items of type `review_needed` only |

Each item renders as a card with:
- Type icon (decision/review/blocked/stalled/suggestion)
- Priority badge (urgent/high/medium/low)
- Age display ("5m ago", "2h ago")
- Action buttons (Approve, Run, Dismiss, Reject, GC depending on type)
- Click to expand → detail modal with full description + Team Hub comments

**Card actions**: When an action is taken (approve, dismiss, etc.), the card **fades out and collapses** (350ms CSS transition on opacity + max-height) rather than triggering a full list re-render. The item is immediately removed from the in-memory cache, the count label and tab badge update, and remaining items slide up via flexbox gap. After animation completes (400ms), the DOM node is removed and the Command Center widget refreshes silently. If the list becomes empty, the empty state replaces it.

**Empty state**: "Nothing needs your attention right now" with checkmark icon.

**Tab badge**: Red notification count pill on the "My Queue" tab button, showing total action items count. Updates on every refresh.

### Command Center Widget

"Needs Your Attention" panel shows the top 5 items (by priority_score) in compact card format. Hidden when there are no items. "+ N more" link navigates to the My Queue tab.

### Auto-Refresh

Action items refresh on tab activation and on a periodic interval alongside other dashboard data.

---

## HITL Flow (End-to-End)

The full lifecycle of a human-in-the-loop decision:

```
1. Task processor creates HITL item
   → POST Team Hub /internal/create-item (status: awaiting-human, list: HITL Queue)
   → Team Hub item UUID returned

2. Notifier sends Telegram notification
   → 5-button inline keyboard: Run | Approve | Dismiss | Reject | Picked up in GC
   → Escalation timer starts (15 min)

3. NFS dispatcher syncs to admin directory (if enabled)
   → Writes _admin/hitl/{item-id}.md for GravityClaw

4. Item appears in Engine dashboard
   → My Queue tab (HITL Decisions subtab)
   → Command Center "Needs Your Attention" widget

5. Human takes action (via any channel):
   a) Telegram button → Engine /api/action-items/{id}/act
   b) Engine dashboard button → same API
   c) GravityClaw .response file → NFS dispatcher → same API
   d) Team Hub UI → status change directly

6. Team Hub item status updated
   → Escalation timer cleared
   → Telegram message edited with result
   → Fleet coordinator picks up approved items for dispatch
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-engine/background/fleet_coordinator.py` | Work identification, routing, dispatch, delegation, review pipeline, proposals |
| `tools/opai-engine/services/worker_mail.py` | SQLite mail system, group resolution, Team Hub mirroring |
| `tools/opai-engine/routes/mail.py` | REST API for mail (inbox, send, reply, thread, stats) |
| `tools/opai-engine/routes/action_items.py` | Aggregation API, action execution, dispatch |
| `tools/opai-engine/routes/nfs.py` | NFS-specific API endpoints |
| `tools/opai-engine/background/worker_manager.py` | Worker execution, prompt loading, context priming |
| `tools/opai-engine/data/mail.db` | SQLite message store (WAL mode, created at runtime) |
| `tools/opai-engine/data/fleet-state.json` | Fleet coordinator persisted state |
| `config/orchestrator.json` | Fleet config: delegation, review_pipeline, routing |
| `config/workers.json` | Worker registry (includes project-lead with delegation_capable) |
| `scripts/prompt_project_lead.txt` | Lead worker prompt with DISPATCH format instructions |
| `tools/opai-engine/static/index.html` | My Queue tab HTML + CC widget |
| `tools/opai-engine/static/js/app.js` | Action items rendering + interaction |
| `tools/opai-engine/static/style.css` | Action item card + badge styles |

## Dependencies

- **Reads**: [Team Hub](../tools/team-hub.md) internal API, guardrails, heartbeat snapshot, updater suggestions, [NFS Dispatcher](nfs-dispatcher.md), worker mail inbox
- **Writes**: Team Hub items (status updates, comments), fleet state, NFS inboxes, mail messages, task registry (proposals)
- **Notifies**: [Telegram](../integrations/telegram-bridge.md) via notifier.py (HITL buttons, completions, build+review results, task proposals)
- **Called by**: Engine dashboard UI, Telegram callback handlers, NFS admin response polling
- **Dispatches to**: Worker Manager (local agents), [NFS Dispatcher](nfs-dispatcher.md) (remote workers)
- **Primes from**: Context harvester journal, worker mail inbox
