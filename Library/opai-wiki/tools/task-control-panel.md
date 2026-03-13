# Task Control Panel
> Last updated: 2026-03-05 | Source: `tools/opai-engine/`

> **v2 MIGRATION (2026-02-25)**: The Task Control Panel has been **merged into the [OPAI Engine](opai-v2.md)** at `tools/opai-engine/` on port **8080**. The standalone `tools/opai-tasks/` directory has been deleted. All task management, feedback, audit, and the Monitor sub-module are now served by the engine. See [OPAI v2](opai-v2.md).
>
> **Engine equivalents**:
> - `services.py` (3566 lines) → `services/task_processor.py`
> - `routes_api.py` → `routes/tasks.py` + `routes/feedback.py` + `routes/audit.py`
> - Port 8081 → port 8080 (engine)
> - `opai-tasks` systemd unit → `opai-engine`

## Overview

FastAPI web application providing the **internal system task management** UI with agent execution, delegation, HITL review, email integration, and archival. This is the operator-facing control panel for OPAI system tasks — distinct from [Team Hub](team-hub.md) which handles user-facing project management. Tasks without an explicit agent assignment are auto-classified and routed to the best agent/squad via work-companion.

**Key distinction**: Team Hub = ClickUp replacement for users/teams. Task Control Panel = internal system for orchestrator tasks, agent dispatching, HITL gates.

## Architecture

```
Browser (static/app.js) → FastAPI (routes_api.py) → services.py → task registry
                                                  → auto_route_task() → work-companion (Node.js)
                                                  → claude -p (agent execution)
                                                  → run_squad.sh (squad execution)
                                                  → send-email.js (email delegation)

Orchestrator ──→ processTaskRegistry() ──→ HITL briefings (reports/HITL/)
                                        ──→ auto-execute eligible tasks

My Queue (Human View) ──→ HITL briefings + propose-mode tasks + overdue items
                       ──→ inline approve/reject/defer/reassign actions
```

- **Backend**: FastAPI (Python) with Uvicorn on port 8081
- **Frontend**: Vanilla JS SPA served from `static/`
- **Storage**: JSON files (`registry.json`, `archive.json`)
- **Auto-executor**: Background loop (30s interval) launches eligible agent-assigned tasks. Uses 9-state Prefect-style status model: `pending → scheduled → running → completed / failed / timed_out`. Queued feedback-fix tasks and evolution-plan tasks always run regardless of global `auto_execute` setting. Health-tier audit entries are written each cycle when tasks are launched.
- **Auto-routing**: Tasks created without an agent are immediately classified via work-companion and assigned the best agent/squad
- **UpdaterAgent**: Runs as a background task during TCP's FastAPI lifespan (started at app startup, cancelled on shutdown). Scans `tools/`, `team.json`, `scripts/` every 5 minutes for system changes and writes suggestions to `tools/opai-monitor/data/updater-suggestions.json`
- **Auto-executor loop**: Internal to TCP (30s interval), started as a background task during lifespan. No longer requires an external cron job or separate process — TCP owns the full execution lifecycle
- **Stale job cleanup**: On startup, the lifespan handler scans the task registry for jobs stuck in `running` or `in_progress` status and resets them to `pending`. This prevents zombie tasks from blocking the executor after a crash or restart
- **Auth**: Supabase JWT (primary) with legacy bearer token fallback
- **Three views**: "All Tasks" (full table), "My Queue" (human-actionable items), and "Feedback" (browse/act on user feedback)

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-tasks/app.py` | FastAPI entrypoint, lifespan (startup cleanup, auto-executor loop) |
| `tools/opai-tasks/config.py` | Path constants, env vars, Supabase config |
| `tools/opai-tasks/routes_api.py` | All REST API endpoints, auth (Supabase JWT + legacy bearer) |
| `tools/opai-tasks/services.py` | Business logic: registry I/O, auto-routing, agent execution, archival |
| `tools/opai-tasks/send-email.js` | Node.js bridge to email-checker's SMTP sender |
| `tools/opai-tasks/static/app.js` | Frontend: task table, My Queue view, Feedback view, modals, agent picker, squad runner, HITL response, detail panel |
| `tools/opai-tasks/static/index.html` | Dashboard HTML with view tabs (All Tasks / My Queue / Feedback) |
| `tools/opai-tasks/static/style.css` | Styling (view tabs, queue cards, HITL briefing cards, feedback cards) |
| `tasks/registry.json` | Active task storage (37 tasks: 6 system, 31 work) |
| `tasks/archive.json` | Archived tasks |
| `scripts/migrate-registry-to-hub.py` | Migration script: registry work tasks → Team Hub workspaces |
| `scripts/test-agent-task-flow.sh` | E2E test: registry, HITL, APIs, migration, orchestrator |

## Configuration

| Setting | Env Var | Default |
|---------|---------|---------|
| Host | `OPAI_TASKS_HOST` | `0.0.0.0` |
| Port | `OPAI_TASKS_PORT` | `8081` |
| Legacy auth token | `OPAI_TASKS_TOKEN` | (none — no legacy auth) |
| Supabase URL | `SUPABASE_URL` | (required for JWT auth) |
| Supabase anon key | `SUPABASE_ANON_KEY` | (required for JWT auth) |
| Supabase JWT secret | `SUPABASE_JWT_SECRET` | (required for JWT auth) |

Auto-executor settings in `config/orchestrator.json` → `task_processor`:
- `auto_execute`: false (default) — require human approval before running agent tasks
- `queue_enabled`: true (default) — global queue on/off; when false stops ALL execution including feedback-fix
- `max_parallel_jobs`: 3
- `max_squad_runs_per_cycle`: 2
- `cooldown_minutes`: 30
- `feedback_autofix_threshold`: `"HIGH"` (default) — controls which severity levels trigger auto-fix (see [Feedback System](feedback-system.md))
- `trusted_senders`: list of email addresses that bypass the approval gate (auto-approved on creation)

## Auto-Routing

When a task is created without an assignee or agentConfig, `auto_route_task()` runs automatically:

1. Calls work-companion's `classifyTask()` with the task title + description
2. Gets routing recommendation via `routeTask()` (squads, agents, mode)
3. Validates the recommended agent/squad exists in `team.json`
4. Sets `assignee` to `"agent"` or `"human"` based on routing mode
5. Populates `agentConfig` with `agentId`, `agentType`, `agentName`

This can also be triggered manually via `POST /api/tasks/{id}/auto-route` or the "Auto (let system decide)" option in the agent picker UI.

## API / Interface

### Auth
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/config` | GET | Return Supabase config for frontend auth initialization |

### Task CRUD
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tasks` | GET | List tasks (filters: status, priority, assignee, project, source, search; sort by: id, priority, deadline; dir: asc/desc — default: `id desc` = newest first) |
| `/api/tasks` | POST | Create task (auto-routes if no assignee/agent specified) |
| `/api/tasks/{id}` | GET | Get single task |
| `/api/tasks/{id}` | PATCH | Update task (auto-sets `routing.mode=execute` when delegating to agent) |
| `/api/tasks/{id}` | DELETE | Delete task |
| `/api/tasks/summary` | GET | Counts by status, priority, project |

### Agent Execution
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tasks/{id}/run` | POST | Trigger squad execution (proxies to monitor) |
| `/api/tasks/{id}/run-agent` | POST | Run specific agent on task (builds prompt → `claude -p`) |
| `/api/tasks/{id}/auto-route` | POST | Auto-classify and assign best agent/squad via work-companion |
| `/api/agents/validate` | POST | Validate agent/squad exists in team.json |
| `/api/agents` | GET | List all agent roles + squads with descriptions for UI picker |

### Task Lifecycle
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tasks/{id}/complete` | POST | Mark completed |
| `/api/tasks/{id}/reject` | POST | Mark rejected (accepts optional `{reason}` body → stored as `rejectionReason`) |
| `/api/tasks/{id}/delegate` | POST | Delegate to person/agent (optional email) |
| `/api/tasks/{id}/auto-archive` | POST | Archive completed task with agent report |
| `/api/tasks/batch` | POST | Batch operations (complete, reject, delete, update) |

### HITL (Human-in-the-Loop)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/hitl` | GET | List HITL briefing files (auto-archives orphans whose tasks are gone) |
| `/api/hitl/{filename}` | GET | Read HITL briefing content (markdown) |
| `/api/hitl/{filename}/archive` | POST | Archive HITL briefing to `reports/Archive/` |
| `/api/hitl/{filename}/respond` | POST | Full HITL response (see below) |

**`POST /api/hitl/{filename}/respond`** — Accepts JSON body:
- `action`: `run` | `queue` | `approve` | `dismiss` | `reject` | `reassign`
- `notes`: optional human notes saved to task
- `squad`: squad name for approve action (default: from briefing recommendation)
- `assignee`: target assignee for reassign action

Actions:
- **run**: Launches feedback fixer (feedback tasks) or squad (other tasks) immediately, archives briefing
- **queue**: Sets mode→queued for auto-execute cycle pickup (≤30s), archives briefing
- **approve**: Sets mode→execute, triggers specific squad via monitor proxy, archives briefing
- **dismiss**: Rejects task (if exists), stores notes as `rejectionReason`, archives briefing — safe for orphan briefings
- **reject**: Sets status→rejected, stores notes as `rejectionReason`, archives briefing
- **reassign**: Changes assignee, if agent→sets mode to execute, archives briefing

### Feedback
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/feedback` | GET | Parsed feedback items from `Feedback-*.md` files + summary stats + enriched task cross-refs (`taskStatus`, `taskAgent`) |
| `/api/feedback/action` | POST | Act on feedback item (body: `{feedbackId, action, agentId?, agentType?, extraData?}`) |
| `/api/audit/{audit_id}/trace` | GET | Step-by-step tool call trace from session JSONL for a specific audit record |

Feedback actions: `run` (create task + launch fixer immediately), `queue` (create task for auto-execute cycle pickup), `add-context` (append notes to feedback line), `change-severity` (move feedback between HIGH/MEDIUM/LOW sections), `re-evaluate` (AI evaluation against current app state), `create-task` (legacy), `mark-done`, `dismiss`

### Archive & Reference
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/archive` | GET/POST/DELETE | List, archive, restore, or delete archived tasks |
| `/api/archive/restore` | POST | Restore archived tasks to active |
| `/api/contacts` | GET | Contact registry |
| `/api/projects` | GET | Project/client folder names |
| `/api/email-accounts` | GET | Configured email accounts |

### Attachments & Plans
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tasks/{id}/attachments` | POST | Add file attachment |
| `/api/tasks/{id}/attachments/{index}` | DELETE | Remove attachment |
| `/api/tasks/{id}/plan` | POST | Save plan file and attach to task |
| `/api/files/read` | GET | Read file content (path safety enforced) |

### Heartbeat Control (Proxy)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/heartbeats` | GET | Fan out to all 9 tool schedulers, return aggregated `{tool: {tick_seconds, paused, status}}` |
| `/api/heartbeats` | PUT | Accept `{tool: {tick_seconds?, paused?}}` map, fan out PUT to each tool's `/api/scheduler/settings` |

Proxied tools: `forumbot` (8095), `brain` (8101), `bot-space` (8099), `bx4` (8100), `helm` (8102), `marq` (8103), `wordpress` (8096), `docs` (8091), `dam` (8104). Internal fan-out uses service key auth (service-to-service).

### Settings
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/settings` | GET/POST | Read/update task processor settings |
| `/api/executor/status` | GET | Auto-executor state (running jobs, cycle info) |
| `/health` | GET | Health check |

### Monitor (Merged — Health Tab)

See the dedicated [Monitor Integration](#monitor-integration-health-tab) section below for full details on the merged Monitor sub-module, endpoints, and WebSocket streams.

Used by [Portal](portal.md) dashboard for health dots and system stats (via `/tasks/api/monitor/...` through Caddy).

## My Queue (Human View)

A dedicated tab showing only tasks that need human attention. Toggled via view tabs at the top of the page (All Tasks | My Queue). Badge shows the count of actionable items.

### Queue Sections (in priority order)

| Section | Criteria | Card Style |
|---------|----------|------------|
| **HITL Briefings** | Active `.md` files in `reports/HITL/` | Purple accent, inline briefing content |
| **Overdue** | `deadline < today` and status not completed | Red accent |
| **Needs Decision** | `routing.mode == 'propose'` (not already in HITL section) | Amber accent |
| **Assigned to You** | `assignee == 'human'` or `status == 'delegated'` | Blue accent |

### Orphan Briefing Cleanup

`list_hitl()` cross-references briefing filenames against `registry.json` task IDs. Briefings whose tasks no longer exist (deleted, migrated) are auto-archived to `reports/Archive/` — they never appear in the UI. This prevents "Task not found in registry" errors.

### HITL Card Features

Each HITL briefing card includes:
- Task metadata (title, priority, source, project)
- "Show Full Briefing" toggle — loads and renders the full markdown briefing inline
- Notes textarea — freeform human notes saved with the response
- **Action buttons** (standardized with Feedback tab):

| Button | Action | Effect |
|--------|--------|--------|
| **Run** | `run` | Launch feedback fixer or squad immediately |
| **Queue** | `queue` | Queue for auto-execute cycle (≤30s), archive briefing |
| **Run Squad** | `approve` | Pick a specific squad to run (prompts for choice) |
| **Dismiss** | `dismiss` | Archive briefing, reject task |

### Non-HITL Queue Cards

Overdue, propose-mode, and human-assigned cards use the same standardized actions:

| Button | Effect |
|--------|--------|
| **Run** | Launch feedback fixer (feedback tasks) or squad (other tasks) |
| **Queue** | Set `mode: "queued"` for auto-execute pickup |
| **Assign Agent** | Auto-route to best agent/squad via work-companion |
| **Dismiss** | Reject the task |

### DOM Behavior

- **No full re-renders**: Actions use card-level DOM manipulation via CSS class `fade-out` — 350ms opacity + max-height collapse animation, then DOM node removal after 400ms. Cache is updated immediately so counts/badges reflect the change before animation finishes.
- Remaining items slide up naturally via flexbox gap as the card collapses
- Empty state ("Nothing needs your attention right now") shows when queue reaches zero items
- Command Center widget refreshes silently after animation completes

## Feedback View (Agent-First)

A dedicated tab for browsing and acting on user feedback collected via the navbar button. Items are parsed from `notes/Improvements/Feedback-*.md` files and cross-referenced with the task registry. Uses an **agent-first** model where the primary action is **Run** — not manual task creation.

### Instant Feedback Visibility

When a user submits feedback via the navbar, the portal endpoint (`POST /api/feedback` in `opai-portal/app.py`) now writes the entry **directly to the `Feedback-{Tool}.md` file** in addition to the queue. This makes feedback appear in the Task Control Panel immediately — no 5-minute wait for the processor. The processor still runs later to refine classification (dedup-aware: updates in-place if the entry already exists).

### Summary Cards
Shows total, HIGH, MEDIUM, LOW, and Implemented counts at a glance.

### Badge
Tab badge shows total non-implemented feedback count (all severities). Polled every **10 seconds**.

### Filters
- **Tool**: Filter by originating tool (Chat, TeamHub, etc.)
- **Severity**: HIGH / MEDIUM / LOW
- **Status**: Open (no task, not implemented), Implemented, Has Task
- **Refresh**: Force-reloads data (bypasses interaction guard)

### Auto-Fix Threshold

A dropdown next to the Refresh button controls the system-wide auto-fix severity threshold:

| Setting | Effect | Dropdown Color |
|---------|--------|---------------|
| **Off** | Auto-fix disabled | Default/muted |
| **HIGH only** | Only HIGH severity auto-queued | Red |
| **MEDIUM+** | HIGH and MEDIUM auto-queued | Yellow |
| **All** | All severities auto-queued | Blue |

Persisted as `feedback_autofix_threshold` in `config/orchestrator.json` → `task_processor`. The feedback actor reads this setting to decide which severity levels to auto-create tasks for. Default: `HIGH`.

### Feedback Cards — State-Aware Rendering

Cards render different content based on linked task state:

| State | Renders |
|-------|---------|
| Implemented or task completed | Grayed out + "IMPLEMENTED" chip |
| Task in_progress | Pulsing "Running" chip + spinner + agent name + "View Task" |
| Task pending/delegated | "Queued" chip + agent name + "View Task" |
| No task (default) | **Run** / **Queue** / **Add Context** / **Re-Evaluate** / Dismiss |

### Severity Dropdown

Each non-implemented feedback card has a **severity dropdown** (replacing the static chip) allowing reclassification between HIGH, MEDIUM, and LOW. On change, the backend moves the feedback line between severity sections in the `Feedback-{Tool}.md` file. Color-coded: red (HIGH), orange (MEDIUM), blue (LOW).

### Action Buttons

- **Run**: Creates task + launches feedback fixer agent immediately (one click)
- **Queue**: Creates task in registry without launching — sits in queue for orchestrator pickup or manual Run later
- **Add Context**: Inline textarea to add notes before running (see Context Box below)
- **Re-Evaluate**: AI-powered evaluation against current app state (see Re-Evaluate below)
- **Dismiss**: Removes the feedback line from the file

### Context Box

"Add Context" opens an inline textarea with Save & Run, Save Context, and Cancel buttons:

- **Draft persistence**: Text is saved to memory on every keystroke via `_feedbackContextDrafts[feedbackId]`. Canceling or polling re-renders preserve the draft. Reopening "Add Context" restores previously typed text.
- **Save & Run**: Saves context to the feedback file, then launches the fixer agent. Card immediately re-renders to show Running status (uses `loadFeedback(true)` to force past the interaction guard).
- **Save Context**: Saves context, collapses textarea, card re-renders to normal action buttons.
- **Cancel**: Saves draft to memory, collapses textarea. Draft restored on next open.

### Re-Evaluate

The **Re-Evaluate** button triggers an AI evaluation of the feedback against the current state of the tool:

1. Button pulses green (`btn-evaluating` CSS class) while waiting for response
2. Backend (`_re_evaluate_feedback()` in `services.py`) gathers wiki docs + source file listing for the tool
3. Calls `claude -p` (60s timeout) with evaluation prompt
4. Returns one of four statuses:

| Status | Tag Color | Meaning |
|--------|-----------|---------|
| `missing` | Green | Feature/fix is genuinely needed and not yet present |
| `unnecessary` | Red | Feature already exists or request doesn't make sense |
| `implemented` | Blue | Has been built already |
| `partial` | Yellow | Only partly addressed |

5. A colored tag appears in the card's meta row with hover tooltip showing the AI's reasoning
6. Tooltip popup uses a **solid dark background** tinted to the tag color (dark green for Missing, dark red for Un-Necessary, dark blue for Implemented, dark amber for Partial) — defined via `.feedback-eval-tag.eval-{type}:hover::after` with solid hex backgrounds, never transparent
7. Tags persist across polling re-renders via `_feedbackEvaluations` memory map — stored until Re-Evaluate is clicked again

**Claude CLI path fallback**: The function catches `FileNotFoundError` and falls back to the absolute nvm path (`~/.nvm/versions/node/v20.19.5/bin/claude`) since systemd services don't have nvm in PATH.

### Polling & Interaction Safety

- **Configurable poll interval**: Default 10 seconds, adjustable via the **gear button** on the Feedback tab (see Polling Settings below)
- **On-demand mode**: Polling can be disabled entirely — only the manual Refresh button fetches data
- **Interaction guard**: Polling skips re-render when user has an open context textarea or focused input (prevents destroying mid-edit state). Bypassed by explicit actions (Run, Queue, Save & Run, Refresh button) via `force=true` parameter.
- **Evaluation persistence**: `_feedbackEvaluations` map re-applies stored eval tags after each polling refresh
- **Toast notifications**: Lightweight green toast on successful actions

### Polling Settings

The **gear button** (next to Refresh) opens a modal with two controls:

| Setting | Key | Default | Description |
|---------|-----|---------|-------------|
| Mode | `feedback_poll_on_demand` | `false` | Auto-poll (timed) or On-demand (manual Refresh only) |
| Poll Interval | `feedback_poll_interval` | `10` (seconds) | Number input + unit dropdown (seconds / minutes / hours / days) |

- Stored in `config/orchestrator.json` → `task_processor` (same as other TCP settings)
- Minimum interval: 5 seconds
- Changes take effect immediately without page reload — `setupFeedbackPolling()` recreates the timers
- The `loadSettings()` background refresh (every 30s) also syncs polling config if changed externally
- Both badge polling and tab content polling use the same interval
- In on-demand mode, both timers are cleared — only the Refresh button triggers data fetches

### Feedback Fixer Agent
Instead of routing through the agent framework (audit/review prompts), feedback items use a **direct `claude -p` fixer** that:
1. Maps tool name → source directory (e.g., "TeamHub" → `tools/opai-team-hub`)
2. Builds an implementation prompt (explore → identify → plan → implement → verify)
3. Runs with 10-minute timeout, tool dir as working directory
4. On completion: saves report + auto-marks feedback as IMPLEMENTED

See [Feedback System](feedback-system.md) for full details on the fixer agent, tool directory mapping, and the self-healing loop.

### Auto-Actor Integration
The [Feedback System](feedback-system.md) `feedback-actor.js` runs every 15 minutes. It reads the `feedback_autofix_threshold` setting to determine which severity levels to process. Items at or above the threshold get tasks auto-created and `mode: "execute"` (auto-run eligible). When threshold is `NONE`, the actor skips entirely.

## Audit Tab

The **Audit** tab provides a unified log of all OPAI system activity using a **three-tier audit model**. Every service writes audit entries using the shared audit module, creating a single source of truth for system observability.

### Tiered Audit Model

| Tier | Color | Purpose | Examples |
|------|-------|---------|----------|
| **execution** | Purple | Agent/squad runs, task processing | Feedback fixer runs, squad completions, email cycles |
| **system** | Orange | Service operations, config changes | Push OP, orchestrator jobs, evolution dry-runs |
| **health** | Green | Heartbeats, uptime, cycle summaries | Auto-execute cycle stats, service health checks |

### Tiered Record Schema (new format)

| Field | Description |
|-------|-------------|
| `id` | Unique audit ID (e.g. `audit-20260222-306-74310`) |
| `timestamp` | ISO UTC timestamp |
| `tier` | `"execution"`, `"system"`, or `"health"` |
| `service` | Originating service (e.g. `"opai-tasks"`, `"opai-wordpress"`) |
| `event` | Event type (e.g. `"email-cycle"`, `"push-op"`, `"auto-execute-cycle"`) |
| `status` | `"completed"`, `"failed"`, `"partial"`, `"skipped"` |
| `summary` | Human-readable one-liner |
| `duration_ms` | Execution duration in milliseconds |
| `details` | Tier-specific additional data (object) |

### Legacy Record Format

Older records (pre-Phase 2) use a flat format with fields like `taskId`, `agentId`, `origin`, `startedAt`, `tokensTotal`, `model`, etc. at the top level. The Audit tab and API handle both formats seamlessly.

### UI Features

- **Tier filter buttons**: All / Execution / System / Health — filter records by tier
- **Service dropdown**: Filter by originating service (auto-populated from data)
- **Heartbeat indicator**: Shows time since last audit entry with color coding (green < 1h, orange 1-6h, red > 6h)
- **Tier dots**: Small colored dots in each row indicate the record's tier
- **Detail panel**: Expands to show tier-appropriate fields with dynamic layout

### Integrating a New Service

To add audit logging to any OPAI service:

**Python services** — use the shared module directly:
```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from audit import log_audit

log_audit(
    tier="system",
    service="opai-my-service",
    event="my-operation",
    status="completed",
    summary="Operation completed — 5 items processed",
    duration_ms=1200,
    details={"items_processed": 5},
)
```

**Node.js services** — use `tools/shared/audit.js`:
```javascript
const { logAudit } = require('../shared/audit');

logAudit({
    tier: 'execution',
    service: 'opai-my-service',
    event: 'my-cycle',
    status: 'completed',
    summary: 'Cycle completed — 3 items processed',
    duration_ms: 5200,
    details: { itemsProcessed: 3 },
});
```

### Legacy Record Backfill

Records created before the tiered audit model (pre-Phase 4) lack a `tier` field. The `read_audit()` function in `services.py` normalizes these on read by assigning a tier based on the record's `origin`:
- `scheduled-squad`, `push-op` → `"execution"`
- Everything else → `"system"`

This makes all existing data appear correctly in the tier filter tabs without rewriting audit.json.

### Services Writing Audit

All OPAI services write tiered audit entries via the shared audit module (`tools/shared/audit.py` for Python, `tools/shared/audit.js` for Node.js). Both write to the same `tasks/audit.json` file.

| Service | Module | Tier(s) | Events |
|---------|--------|---------|--------|
| opai-tasks | `services.py` | health, execution | `auto-execute-cycle`, feedback fixer runs |
| opai-orchestrator | `index.js` | system | `email-check`, `feedback-cycle`, `feedback-act`, `evolution-dry-run` |
| opai-discord-bot | `index.js` | health, execution | `bot-started`, `claude-invocation` |
| opai-email-agent | `agent-core.js`, `index.js`, `audit-server.js` | health, execution, system | `agent-started`, `email-cycle`, `mode-change` |
| opai-wordpress | `task_logger.py`, `services/scheduler.py` | system, execution | `push-op`, `scheduled-task` |
| opai-bot-space | `scheduler.py` | execution | `bot-run` |
| opai-brain | `scheduler.py` | execution | `agent-run` |
| opai-bx4 | `core/scheduler.py` | execution | `scheduled-analysis` |
| opai-prd | `routes_api.py` | execution, system | `idea-evaluation`, `project-created` |
| opai-billing | `routes_webhooks.py` | system | `checkout-session-completed`, `invoice-payment-succeeded`, `invoice-payment-failed` |
| opai-team-hub | `routes_api.py`, `routes_spaces.py` | system | `task-created`, `task-update`, `space-created` |
| opai-docs | `app.py` | health | `docs-regenerated` |
| opai-forumbot | `scheduler.py` | system | `schedule-run` |
| post_squad_hook | `post_squad_hook.py` | execution | `squad-*` (all squad runs) |

### Token Budget Button

The **Token Budget** button (next to Refresh in the Audit tab header) opens a modal showing:
- **Usage bar**: Visual daily token usage (green < 60%, orange 60–85%, red > 85%)
- **Live badge**: Color-coded percentage shown on the button at all times
- **Configurable fields**: Budget toggle, budget limit, fixer model dropdown, max turns input
- Changes sync to both `team.json` (per-agent) and `config/orchestrator.json` (global defaults)

### Heartbeat Control Panel

The **Heartbeats** button (in the `audit-tier-bar`, next to the heartbeat indicator) opens a modal for centralized runtime control of all OPAI tool scheduler loops.

**UI layout:**
- Table with columns: Tool name, Status badge, Interval (seconds), Pause toggle
- Status badges: **Running** (green), **Paused** (amber), **Offline** (gray), **Error** (red)
- Interval input: number field (min 10, max 3600) showing current `tick_seconds`
- Pause toggle: small slider that sets `paused: true/false`
- **Save All** button: sends all changes in one `PUT /api/heartbeats` request

**How it works:**
1. Modal open → `GET /api/heartbeats` fans out to all 9 tool endpoints on localhost
2. Each tool responds with `{tick_seconds, paused}` or an error/unreachable status
3. User adjusts intervals and toggles, clicks Save All
4. `PUT /api/heartbeats` sends only changed tools as `{tool: {tick_seconds, paused}}` map
5. Changes take effect immediately (runtime state, not persisted across restart)

**Monitored tools:**

| Tool | Port | Default Tick | Scheduler File |
|------|------|-------------|----------------|
| forumbot | 8095 | 60s | `scheduler.py` |
| brain | 8101 | 60s | `scheduler.py` |
| bot-space | 8099 | 60s | `scheduler.py` |
| bx4 | 8100 | 300s | `core/scheduler.py` |
| helm | 8102 | 60s | `core/scheduler.py` |
| marq | 8103 | 60s | `core/scheduler.py` |
| wordpress | 8096 | 60s | `services/scheduler.py` |
| docs | 8091 | 300s | `app.py` (inline watcher) |
| dam | 8104 | 30s | `core/scheduler.py` |

**Not included:** orchestrator (Node.js, 5 separate intervals — needs separate design), email-agent (already has UI control).

**Per-tool pattern:** Each tool has module-level `_scheduler_tick` and `_scheduler_paused` variables with `get_scheduler_settings()` / `set_scheduler_settings()` functions. The scheduler loop reads these at each tick. Endpoints: `GET/PUT /api/scheduler/settings` (admin-only via `require_admin` or equivalent).

### Audit Trace — "Show Steps"

Each audit record in the expanded view has a **Show Steps** button that reveals the step-by-step trace of tool calls the agent made during that run.

**How it works:**
- Backend endpoint: `GET /api/audit/{audit_id}/trace`
- Pure file read — no AI involved
- Reads the session JSONL from `~/.claude/projects/<project-dir>/<session-id>.jsonl`
- Extracts all tool calls and agent text messages, groups by turn number

**Step icons:**
| Icon | Tool | Meaning |
|------|------|---------|
| 🔍 | Grep | Search for pattern in files |
| 📂 | Glob | List files by pattern |
| 📖 | Read | Read file content |
| ✏️ | Edit | Edit file (highlighted green — key action) |
| 📝 | Write | Write new file (highlighted green) |
| ⚠️ | Bash | Bash command (should not appear — Bash is blocked) |
| 💬 | text | Agent text output (highlighted blue/italic) |

**Reading the trace**: A healthy run looks like: T1 🔍 Grep → T2 📖 Read → T3-T8 ✏️ Edit × N → T9-T10 💬 text. If you see 3-4 Grep calls before any Edit, the agent over-explored and may have run out of turns.

**Troubleshooting via trace:**
- Many Greps before first Edit → agent is over-exploring; consider increasing max_turns
- No Edit steps at all → agent failed to implement; check if task scope was too broad
- Last step is a tool (no 💬 text) → agent ended on tool call; report was recovered via session extraction
- Empty trace → session JSONL not found (session ID may not be stored in the audit record)

## Monitor Integration (Health Tab)

The full [Monitor](monitor.md) is now permanently merged into TCP as a sub-module at `tools/opai-tasks/monitor/`. The standalone `opai-monitor` service on port 8080 is deprecated and no longer runs. All Monitor functionality is served by the TCP process (port 8081) and exposed through the **Health tab** in the TCP dashboard.

### How It Works

- Monitor routes are mounted under the `/api/monitor/` prefix within TCP's FastAPI app
- The Health tab in the TCP dashboard replaces the standalone Monitor UI entirely
- Caddy redirects `/monitor/` and `/monitor/*` to `/tasks/#health`, so bookmarks and existing links continue to work
- Configuration is inherited from TCP's `.env` -- no separate Monitor config is needed
- The UpdaterAgent (system change detection scanner) runs as a background task during TCP's FastAPI lifespan, scanning every 5 minutes

### REST Endpoints

All endpoints below are served by TCP on port 8081. No authentication is required for the health summary endpoint; all other endpoints require admin auth.

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/monitor/health/summary` | GET | Public | Probes all HTTP services + systemd-only units **in parallel** (`asyncio.gather`). Returns `{status, services}` with per-service health, uptime, and memory. 2s probe timeout via httpx |
| `/api/monitor/system/stats` | GET | Admin | CPU, memory, disk, load, network, swap, process count |
| `/api/monitor/system/services` | GET | Admin | All systemd unit statuses |
| `/api/monitor/system/services/{name}/{action}` | POST | Admin | Control service (start/stop/restart) |
| `/api/monitor/system/start-all` | POST | Admin | Start all enabled services |
| `/api/monitor/agents` | GET | Admin | Running claude processes |
| `/api/monitor/agents/{pid}` | GET | Admin | Detailed agent info (CPU, mem, cmdline, cwd, threads, FDs) |
| `/api/monitor/agents/{pid}/kill` | POST | Admin | Kill agent by PID |
| `/api/monitor/agents/kill-all` | POST | Admin | Emergency stop all agents |
| `/api/monitor/claude/usage` | GET | Admin | Live token usage (5s poll, 4s server-side cache) |
| `/api/monitor/claude/dashboard` | GET | Admin | Heavier aggregation: week totals, sessions by project, model breakdown |
| `/api/monitor/claude/sessions` | GET | Admin | Session index with pagination |
| `/api/monitor/claude/plan-usage` | GET | Admin | Live plan usage from Anthropic OAuth API (15s cache) |
| `/api/monitor/claude/status` | GET | Admin | Installation status: version, model, MCP servers, memory, settings (30s cache) |
| `/api/monitor/updater/suggestions` | GET | Admin | System change suggestions |
| `/api/monitor/updater/state` | GET | Admin | Updater agent state |
| `/api/monitor/updater/suggestions/{id}/archive` | POST | Admin | Suppress suggestion |
| `/api/monitor/updater/suggestions/{id}/task` | POST | Admin | Create task from suggestion |

### WebSocket Endpoints

WebSocket streams are served at the TCP root (not under `/api/monitor/`). Each stream pushes JSON data at a fixed interval.

| Path | Interval | Data |
|------|----------|------|
| `/ws/stats` | 2s | CPU, memory, disk, load, network |
| `/ws/agents` | 3s | Running claude processes |
| `/ws/logs` | 1s | Live log entries (journalctl + file tailing) |
| `/ws/claude` | 10s | Live usage data from `session_collector.get_live_usage()` |

### Probed Services (Health Summary)

The `/api/monitor/health/summary` endpoint probes all configured HTTP services **in parallel** using `asyncio.gather()` with a 2-second timeout per probe. Systemd-only service checks also run in parallel via `asyncio.to_thread()`. Results include status, uptime in seconds, and memory usage in MB per service. The parallel design was introduced in v3.5 to reduce response time from ~145ms (sequential) to ~40-80ms (parallel, bounded by slowest service).

### Key Files

| File | Purpose |
|------|---------|
| `tools/opai-tasks/monitor/routes_api.py` | REST API endpoints (prefix `/api/monitor`) |
| `tools/opai-tasks/monitor/routes_ws.py` | WebSocket streaming (stats, agents, logs) |
| `tools/opai-tasks/monitor/collectors.py` | Read-only data collection: system stats, agents, reports, services |
| `tools/opai-tasks/monitor/session_collector.py` | Claude Code usage data: live polling, dashboard aggregation |
| `tools/opai-tasks/monitor/services.py` | Mutating operations: kill agents, control services, run squads |
| `tools/opai-tasks/monitor/log_reader.py` | Log aggregation: ring buffer (500 lines), file tailing, journalctl |
| `tools/opai-tasks/monitor/updater.py` | System change detection (scans, diffs, suggestions) |
| `tools/opai-tasks/monitor/config.py` | Monitor-specific paths, env vars, service lists, WebSocket intervals |

See [Monitor](monitor.md) for the full standalone reference (dashboard panels, panel layout system, token counting details, updater internals).

## HITL Lifecycle

Full chain from task creation to completion:

```
1. Task enters registry (email/monitor/manual)
2. Orchestrator processTaskRegistry() runs (every 15 min)
3. Auto-routes orphaned tasks (classifyTask → routeTask)
4. propose-mode tasks → HITL briefing written to reports/HITL/{taskId}.md
5. My Queue shows HITL card with briefing content
6. Human reviews briefing, adds notes, clicks Approve/Reject/Defer
7. POST /api/hitl/{filename}/respond updates registry + triggers squad
8. Squad runs → agent produces report → task completed
```

HITL briefing format (written by orchestrator):
```markdown
# HITL Briefing: {task title}
- **Task ID**: t-YYYYMMDD-NNN
- **Priority**: high
- **Source**: email
- **Description**: ...
- **Recommended Squad**: plan
- **Routing Mode**: propose
## Run Command
bash scripts/run_squad.sh -s plan
```

## Registry Task Categories

| Category | Count | Location | Purpose |
|----------|-------|----------|---------|
| **System tasks** | 6 | `tasks/registry.json` | Internal OPAI tasks — agent-assigned or system-level |
| **Work tasks** | 31 | Migrated to Team Hub | Client/project tasks — viewable in Team Hub workspaces |

System task IDs: `t-001` (Claude Code migration), `t-018` (GCP credentials), `t-048` (ngrok upgrade), `t-050` (Supabase security), `t-058` (email checker), `t-20260213-001` (opai-chat integration).

### Registry → Team Hub Migration

`scripts/migrate-registry-to-hub.py` migrates work tasks to Team Hub:
- Maps project names to workspace IDs (Everglades-News → Paradise Web, BoutaCare → BoutaByte, etc.)
- Creates `team_items` in Supabase with full description, priority, due date
- Tags each item with `registry:{task_id}` for bidirectional traceability
- Dedup protection: re-running skips tasks whose tags already exist
- Usage: `python3 scripts/migrate-registry-to-hub.py` (dry run) or `--apply`

### E2E Test Script

`scripts/test-agent-task-flow.sh` validates the full lifecycle (16 checks):
- Registry integrity (task counts, system task presence)
- HITL briefings (directory, file count, propose-mode coverage)
- Task Control Panel endpoints (tasks, HITL, respond, summary)
- Team Hub migration (tag counts, workspace correctness, spot checks)
- Orchestrator config (schedule, auto_execute setting)
- Execution infrastructure (squad runner, reports, archive)

## How to Use

```bash
# Start the task panel
cd tools/opai-tasks && python3 app.py

# Or via systemd
systemctl --user start opai-tasks

# Access in browser
open http://localhost:8081

# Run E2E test
bash scripts/test-agent-task-flow.sh

# Migrate work tasks to Team Hub
python3 scripts/migrate-registry-to-hub.py --apply
```

**Task ID format**: `t-YYYYMMDD-NNN` (e.g., `t-20260214-001`) — also serves as the default sort key. Lexicographic `desc` order = newest first, same effective result as `createdAt desc` but on a visible column with a sort-arrow indicator.

**Task statuses**: `pending` → `approved` → `in_progress` → `completed` | `delegated` | `rejected`

**Approval gate**: Tasks from unknown sources enter as `pending` (mode=`propose`) and require human approval. The **Approve** button (detail panel / My Queue) sets `status: "approved"` + `routing.mode: "execute"` + timestamps `approvedAt` / `approvedBy`.

**Bypass rules** (tasks enter as `approved` automatically):
| Source | Rule | Audit Origin |
|--------|------|-------------|
| `discord` | Admin-only channel — always auto-approved | `discord-bypass` |
| `feedback` | System-generated feedback fix — always auto-approved | `feedback-fixer` |
| `email` + trusted sender | Trusted team emails — auto-approved | `trusted-email-bypass` |

Trusted senders configured in `config/orchestrator.json` → `task_processor.trusted_senders`.

**Queue toggle**: `queue_enabled` (default: `true`) — global pause for ALL queue processing. When OFF, stops even feedback-fix tasks. Independent from `auto_execute`. Toggle visible in TCP header.

**Routing modes** and what each means:
| Mode | Description | Runs When |
|------|-------------|-----------|
| `propose` | Needs human decision (HITL) | Never auto-runs |
| `execute` | Cleared to run | Auto-execute ON + task is approved/delegated |
| `queued` | Explicitly queued | Always (bypasses auto_execute, respects queue_enabled) |
| `auto_safe` | Low-risk, may run without full review | Auto-execute ON |

**Agent picker**: Shows all agents and squads with brief descriptions. "Auto (let system decide)" classifies the task and picks the best match.

### Agent Delegation Flow

When a user assigns an agent/squad in the detail panel and sets status to "delegated":

1. **PATCH endpoint** auto-sets `routing.mode = "execute"` and `routing.type = "agent-assigned"` when it detects `status: "delegated"` + `assignee: "agent"` + valid `agentConfig.agentId`
2. **Frontend** checks the auto-execute toggle after save:
   - **Auto-execute ON**: immediately calls `POST /api/tasks/{id}/run-agent` with the selected agent/squad — no 30s wait for the auto-executor cycle
   - **Auto-execute OFF**: shows toast informing user to enable auto-execute; task sits in registry until auto-execute is turned on or manually launched
3. **Auto-executor** (`services.py:auto_execute_cycle()`) picks up delegated tasks: eligible criteria expanded from just `status: "pending"` to also include `status: "delegated"` with `routing.mode == "execute"`
4. Toast notification confirms the action and whether the agent was launched

### Rejection Reasons

When rejecting a task, the user is prompted for an optional reason. Stored as `rejectionReason` on the task object in `registry.json`.

**Entry points that store `rejectionReason`:**
- `POST /tasks/{id}/reject` — accepts `{reason}` body
- `POST /tasks/batch` with `action: "reject"` — reads `reason` from `fields`
- `POST /hitl/{filename}/respond` with `action: "dismiss"` — stores `notes` as `rejectionReason`
- `POST /hitl/{filename}/respond` with `action: "reject"` — stores `notes` as `rejectionReason`

**UI display:**
- **Task table**: Rejected rows get a `row-rejected` CSS class (dimmed opacity). If `rejectionReason` exists, a `data-rejection-reason` attribute is set on the `<tr>`. A cursor-following red-bordered tooltip (`rejection-tooltip`) appears on hover and tracks the mouse until the cursor leaves the row.
- **Detail panel**: A red-bordered "Rejection Reason" section appears above Notes when viewing a rejected task with a `rejectionReason`.
- **Prompt on reject**: Both `quickAction('reject')` (detail panel) and `quickQueueAction(id, 'reject')` (My Queue) show a `prompt()` dialog for the reason. Cancel aborts the rejection. Empty reason is allowed.

### Squad Runner

The Squad Runner panel (sidebar) shows all squads from `team.json` with expandable agent details.

**Data source**: `GET /api/team/squads` returns each squad with:
- `name`, `description`, `agents` (ID list), `agentsDetail` (array of `{id, name, description}` pulled from `roles` in `team.json`)

**UI features:**
- Each squad row shows the squad name, agent count badge, and a **Run** button
- Squad description is displayed below the header in muted text
- Click the squad row header (or the expand arrow) to toggle the agent list
- Expand arrow (`&#9654;`) rotates 90 degrees when expanded (CSS transition)
- Each agent in the expanded list shows: agent name (blue, monospace) + description excerpt (muted, truncated with ellipsis)
- Agents are listed with a left border for visual hierarchy

**CSS classes:**
- `.squad-item` — flex column container
- `.squad-item-header` — clickable row with cursor pointer
- `.squad-expand-icon` — triangle arrow, rotates on `.expanded`
- `.squad-description` — muted description text
- `.squad-agents-detail` — hidden by default, shown when `.squad-item.expanded`
- `.squad-agent-item` — flex row per agent with left border
- `.squad-agent-name` — blue monospace agent name
- `.squad-agent-desc` — muted, ellipsis-truncated description

## Timestamps

All timestamps written by `services.py` and `routes_api.py` use **real UTC** via `datetime.now(timezone.utc).isoformat()` — producing e.g. `2026-02-21T22:25:30.123456+00:00`. The browser's `new Date(iso)` parses this correctly and `toLocaleString()` / `toLocaleTimeString()` converts to the user's local timezone for display.

> **Gotcha**: Do NOT use `datetime.now().isoformat() + "Z"` — the server runs in `America/Chicago` (CST/CDT), so `datetime.now()` returns local time. Appending `"Z"` falsely labels it as UTC; the browser then converts "UTC" to local, causing times to display 5–6 hours earlier than actual. Always use `datetime.now(timezone.utc)`.

The only exceptions (intentionally local time): `.strftime()` calls used for date-based file naming (`audit-YYYYMMDD`, task ID generation `t-YYYYMMDD-NNN`) and freeform report header text — these are for human-readable organization, not parsed timestamps.

## Performance Optimizations (2026-03-05)

The Command Center dashboard had a ~928ms total load time due to sequential API calls and blocking patterns. Four optimizations reduced this to ~300-450ms (bounded by the slowest backend call):

### 1. Parallel Action Items Queries

**File**: `routes/action_items.py` → `_gather_teamhub_items()`

The `/api/action-items` endpoint fetches from Team Hub for three statuses (`awaiting-human`, `blocked`, `review`). Previously these were sequential HTTP calls (~788ms total). Now uses `asyncio.gather()` to fire all three in parallel (~250-450ms, bounded by slowest query).

### 2. Parallel Front-End API Calls

**File**: `static/js/app.js` → `loadCommandCenter()`

The Command Center made 6 sequential `await fetchJSON()` calls (stats, tasks summary, workers, health, audit, action items). Now uses `Promise.allSettled()` so all fire concurrently. Total load = slowest single call instead of sum of all calls.

### 3. Parallel Health Probes

**File**: `routes/health.py` → `health_summary()`

The `/api/health/summary` endpoint probed 10+ HTTP services sequentially and ran `systemctl` checks one at a time. Now uses `asyncio.gather()` for all HTTP probes and `asyncio.to_thread()` for parallel systemd subprocess calls.

### 4. Async Auth Bootstrap

**File**: `static/index.html`

The auth config was fetched with a **synchronous XHR** (`xhr.open('GET', '/auth/config', false)`) which blocked page rendering. Replaced with an async `fetch()` that stores its promise as `window.OPAI_AUTH_READY`. The app.js auth init awaits this promise before calling `opaiAuth.init()`. The page renders immediately while the config loads in the background.

### Performance Impact

| Metric | Before | After |
|--------|--------|-------|
| `/api/action-items` | ~788ms | ~250-450ms |
| `/api/health/summary` | ~145ms | ~40-80ms |
| Front-end total (sequential) | ~928ms | ~300-450ms (parallel) |
| Auth bootstrap | Render-blocking sync XHR | Non-blocking async fetch |

## Dependencies

- **Reads**: `team.json`, `tasks/registry.json`, `tasks/archive.json`, `config/orchestrator.json`, `config/contacts.json`, `reports/HITL/*.md`, `notes/Improvements/Feedback-*.md`
- **Writes**: `tasks/registry.json`, `tasks/audit.json`, `tasks/archive.json`, `tasks/.registry.lock` (exclusive lock file — acquired by any service writing to registry/audit), `reports/<date>/task-*.md`, `reports/Archive/` (archived HITL briefings), `notes/Improvements/Feedback-*.md` (mark-done/dismiss actions)
- **External writers to registry**: `tools/opai-wordpress/services/task_logger.py` — writes Push OP run records using file locking on `tasks/.registry.lock`
- **Calls**: `claude -p` (agent execution + feedback fixer), `run_squad.sh` (squad execution), `send-email.js` (delegation), work-companion (auto-routing)
- **Embeds**: [Monitor](monitor.md) as sub-module (`tools/opai-tasks/monitor/`) — health, stats, agents, services, updater
- **Writes back**: `Feedback-*.md` files (strikethrough + IMPLEMENTED on task completion via feedback loop closure)
- **Auth**: Supabase JWT via `auth.py` (primary), legacy bearer token (fallback)
- **Python deps**: fastapi, uvicorn, httpx, python-dotenv

## Cross-References

- [Team Hub](team-hub.md) — User-facing project management; receives migrated work tasks via registry tags
- [Feedback System](feedback-system.md) — Source of feedback items; auto-actor creates tasks on 15-min schedule
- [Orchestrator](orchestrator.md) — Writes HITL briefings, processes task registry every 15 min
- [Monitor](monitor.md) — Squad run proxy target
- [Agent Framework](agent-framework.md) — Squad definitions, runner scripts
- [Services & systemd](services-systemd.md) — `opai-tasks` service management
