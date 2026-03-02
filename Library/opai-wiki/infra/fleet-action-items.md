# Fleet Coordinator & Action Items API (v3.5)

> Last updated: 2026-03-02 | Source: `tools/opai-engine/background/fleet_coordinator.py`, `tools/opai-engine/routes/action_items.py`

## Overview

The fleet coordinator and action items API form the **work dispatch and visibility backbone** of OPAI v3.5. The fleet coordinator identifies work, routes it to the right worker, and tracks execution. The action items API aggregates everything that needs human attention into a single prioritized feed — the "My Queue" that replaces scattered HITL briefing files.

**Key shift (v3.5)**: [Team Hub](../tools/team-hub.md) is now the **single source of truth** for task tracking. Both humans and agents interact through the same system. HITL items become Team Hub items with `status: awaiting-human`, visible in the Engine dashboard, Telegram, and Team Hub UI simultaneously.

| Component | File | Purpose |
|-----------|------|---------|
| Fleet Coordinator | `background/fleet_coordinator.py` | Work identification, routing, dispatch, completion tracking |
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
```

## Fleet Coordinator

### Main Cycle (every 5 minutes)

```python
async def _cycle():
    _check_active_dispatches()     # Monitor running work
    signals = _gather_signals()     # Heartbeat + registry + suggestions
    work_items = _identify_work()   # Rule-based detection
    for item in work_items:
        worker = _route_work(item)  # Category + keyword routing
        _dispatch(worker, item)     # Launch worker, track in state
    _update_queue_depth()           # Report metrics
```

### Signal Sources

| Source | What It Provides |
|--------|-----------------|
| Heartbeat snapshot | Worker health, resource state, active sessions |
| Task registry | Pending/approved tasks from `tasks/registry.json` |
| Bottleneck suggestions | Auto-detected workflow bottlenecks |
| Team Hub | Items in "assigned" or "in-progress" status |

### Work Identification (Rule-Based)

| Signal | Triggers |
|--------|----------|
| Approved tasks ready for dispatch | Task status = `approved`, not already dispatched |
| High-priority tasks waiting too long | Priority >= high, age > `escalation_threshold_hours` |
| Stale tasks | Age > `stale_task_threshold_hours`, no assignee |
| Heartbeat unhealthy items | Service/worker in unhealthy state |

### Routing Logic (Priority Order)

1. **Explicit `agent_type`** from task routing metadata
2. **Category-based** from `orchestrator.json` → `fleet_coordinator.routing`:
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
3. **Context-aware keyword matching** in title/description
4. **Fallback** to `project-builder`

### Dispatch Tracking

Each dispatch creates a record:

```python
{
    "dispatch_id": "uuid",
    "worker_id": "project-builder",
    "task_id": "t-20260302-001",
    "teamhub_item_id": "uuid",    # v3.5: Team Hub integration
    "started_at": "ISO timestamp",
    "workspace": "/workspace/local/agent-workspaces/...",
    "status": "running"
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
    "routing": { ... }
  }
}
```

### State Persistence

Saved to `data/fleet-state.json`:
- `active_dispatches` — Currently running work
- `completion_history` — Last 100 completions
- `queue_depth` — Current pending work count
- `stats` — Dispatch count, completion count, error count

---

## Action Items API

### Endpoint: `GET /api/action-items`

Aggregates actionable items from 6 sources into one priority-scored list:

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
| `tools/opai-engine/background/fleet_coordinator.py` | Work identification, routing, dispatch, completion (~450 lines) |
| `tools/opai-engine/routes/action_items.py` | Aggregation API, action execution, dispatch (~400 lines) |
| `tools/opai-engine/routes/nfs.py` | NFS-specific API endpoints (~65 lines) |
| `tools/opai-engine/static/index.html` | My Queue tab HTML + CC widget |
| `tools/opai-engine/static/js/app.js` | Action items rendering + interaction |
| `tools/opai-engine/static/style.css` | Action item card + badge styles |
| `tools/opai-engine/data/fleet-state.json` | Fleet coordinator persisted state |

## Dependencies

- **Reads**: [Team Hub](../tools/team-hub.md) internal API, guardrails, heartbeat snapshot, updater suggestions, [NFS Dispatcher](nfs-dispatcher.md)
- **Writes**: Team Hub items (status updates, comments), fleet state, NFS inboxes
- **Notifies**: [Telegram](../integrations/telegram-bridge.md) via notifier.py (HITL buttons, completions)
- **Called by**: Engine dashboard UI, Telegram callback handlers, NFS admin response polling
- **Dispatches to**: Worker Manager (local agents), [NFS Dispatcher](nfs-dispatcher.md) (remote workers)
