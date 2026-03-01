# TCP Redesign — Unified OPAI Command Center

> **Status:** Planning (2026-02-22)
> **Owner:** Dallas
> **Scope:** Task Control Panel + Audit System + Monitor Merger
> **Affected Services:** opai-tasks, opai-monitor, all OPAI tools (audit integration)

---

## Executive Summary

The Task Control Panel (TCP) is being redesigned from a task management tool into the **unified OPAI command center** — the single dashboard that houses tasks, audit logs, feedback, HITL queue, and system health. This document is the authoritative spec for the redesign.

### Core Principles

1. **Tasks = actionable work only.** If nobody needs to do something, it's not a task — it's an audit entry.
2. **Audit = universal heartbeat.** Every OPAI service logs significant events. If entries stop, the system is broken.
3. **Status tells you what's happening.** No ambiguity — each status has exactly one meaning.
4. **Easy to integrate.** Adding audit logging to a new service should be a 5-line function call.

---

## 1. Status Model Migration

### Current → Proposed

| Current Status | Disposition | New Status |
|----------------|-------------|------------|
| `pending` | Keep (narrowed) | `pending` — needs human review/approval |
| `approved` | **Replace** | `scheduled` — approved, waiting for execution slot |
| `in_progress` | **Rename** | `running` — agent actively working |
| `delegated` | **Eliminate** | (was a bug — squads now set `running`) |
| `completed` | Keep | `completed` — finished successfully |
| `rejected` | **Rename** | `cancelled` — human cancelled the task |
| `failed` | Keep (clarified) | `failed` — agent error (code-level) |
| — | **New** | `awaiting_retry` — failed, will retry automatically |
| — | **New** | `timed_out` — exceeded timeout window |
| — | **New** | `paused` — waiting for human input mid-run |

### New State Machine (9 states)

```
                    ┌────────────────────────────────┐
                    │          pending                │
                    │  (needs human review/approval)  │
                    └──────────┬───────────┬──────────┘
                               │           │
                       approve │           │ cancel
                               ▼           ▼
                    ┌──────────────┐  ┌───────────┐
                    │  scheduled   │  │ cancelled │ (terminal)
                    │  (in queue,  │  └───────────┘
                    │   waiting    │
                    │   for slot)  │
                    └──────┬──────┘
                           │ slot available
                           ▼
                    ┌──────────────┐
                    │   running    │◄──────────────────┐
                    │  (agent      │                    │
                    │   working)   │                    │
                    └──┬───┬───┬──┘                    │
                       │   │   │                       │
             success ──┘   │   └── timeout             │
                           │                           │
                 ┌─────────▼──────────┐                │
                 │                    │                 │
            ┌────▼────┐         ┌────▼─────┐    ┌──────┴──────┐
            │completed│         │  failed  │───▶│awaiting     │
            │         │         │          │    │  _retry     │
            └─────────┘         └──────────┘    └──────┬──────┘
             (terminal)          (terminal if          │
                                  max retries)   ┌─────▼──────┐
                                                 │ scheduled  │
                                ┌──────────┐     │ (re-queue) │
                                │timed_out │     └────────────┘
                                └──────────┘
                                 (terminal)
```

### State Definitions

| Status | Type | Meaning | Who Sets It | Next States |
|--------|------|---------|-------------|-------------|
| `pending` | Non-terminal | Needs human review or approval before running | Task creation (mode=propose) | scheduled, cancelled |
| `scheduled` | Non-terminal | Approved, in queue, waiting for execution slot | Approval action, bypass rules, auto-execute eligibility | running, cancelled |
| `running` | Non-terminal | Agent or squad is actively executing | Auto-execute cycle, manual run | completed, failed, timed_out, paused |
| `paused` | Non-terminal | Agent needs human input mid-execution | Future: interrupt() pattern | running (resume), cancelled |
| `awaiting_retry` | Non-terminal | Failed but will automatically retry | Failure with retries remaining | scheduled (retry), failed (max retries) |
| `completed` | Terminal | Finished successfully | Agent exit code 0, manual complete | (archive after 30s) |
| `failed` | Terminal | Agent finished with error, no retries left | Agent exit code ≠ 0, max retries hit | (manual resubmit → pending) |
| `timed_out` | Terminal | Exceeded configured timeout window | Timeout watchdog | (manual resubmit → pending) |
| `cancelled` | Terminal | Human decided not to run this task | Manual cancel/reject | (none) |

### Bypass Paths (system-generated tasks skip pending)

Tasks from trusted sources go directly to `scheduled`:
- `source: "feedback"` + action "run"/"queue"
- `source: "evolution-plan"` or `"self-assessment"`
- `source: "discord"` (admin channel)
- Trusted email senders (from `orchestrator.json`)

### Mode Simplification

Modes no longer overlap with status. Each mode describes **intent**, not state:

| Mode | Meaning | Initial Status |
|------|---------|----------------|
| `propose` | Needs human approval before running | `pending` |
| `execute` | Ready to auto-run when slot available | `scheduled` (bypass approved) |
| `queued` | Always runs next cycle regardless of auto_execute | `scheduled` (bypass approved) |
| `log` | No execution — audit entry only, no task created | (no task) |

### Migration Steps

1. Rename `in_progress` → `running` everywhere
2. Rename `rejected` → `cancelled` everywhere
3. Replace `approved` → `scheduled` (same semantics, clearer name)
4. Remove `delegated` — squad tasks now set `running` directly, completion callback sets `completed`/`failed`
5. Add `awaiting_retry` — failed tasks with retries left transition here instead of reverting to `pending`
6. Add `timed_out` — configurable timeout per task (default: 10 minutes for agents, 30 minutes for squads)
7. Add `paused` — future use for mid-execution HITL interrupts
8. Update all status checks in: `services.py`, `routes_api.py`, `app.js`, `index.html`, `style.css`
9. Update all external writers: `post_squad_hook.py`, `orchestrator/index.js`, `feedback-processor`

---

## 2. Task List Cleanup — Actionable Only

### What IS a Task (stays on main list)

| Source | Example | Why It's Actionable |
|--------|---------|---------------------|
| Evolution fix | "Fix .gitignore line 47" | Agent needs to change code |
| Feedback fix | "Fix Forum search button" | Agent needs to fix a bug |
| Email task | "Review client request" | Human needs to respond |
| Manual task | "Add dark mode to Monitor" | Human/agent needs to build |
| Discord task | "Deploy staging" | Agent needs to execute |
| Agent report finding | "Security: exposed API key" | Human needs to review/fix |

### What is NOT a Task (audit only)

| Event | Current Behavior | New Behavior |
|-------|-----------------|--------------|
| Self-assessment completed | Creates run-tracking task | Audit entry only (tier: execution) |
| Evolution plan generated | Creates run-tracking task | Audit entry only (tier: execution) |
| Push OP Connector ran | Creates task + audit | Audit entry only (tier: system) |
| Feedback processor scanned | No tracking | Audit entry (tier: system) |
| Email agent IMAP scan | No tracking | Audit entry (tier: system) |
| Service health change | No tracking | Audit entry (tier: health) |
| Auto-execute cycle summary | No tracking | Audit entry (tier: health) |
| Bot Space cron dispatch | No tracking | Audit entry (tier: system) |
| Brain curator/linker ran | No tracking | Audit entry (tier: system) |

### Rule

> If the event's only outcome is "it ran and here's what happened" → **audit entry**.
> If the event produces work that needs human or agent action → **task** (and also an audit entry for the execution).

---

## 3. Unified Audit System

### Tiered Audit Records

All audit entries share a common base schema with tier-specific extensions:

```
TIER 1: execution    — Agent/squad runs (highest detail)
TIER 2: system       — Service operations, automated processes
TIER 3: health       — Heartbeat, uptime, resource alerts
```

### Universal Audit Record Schema

```json
{
  "id": "audit-YYYYMMDD-RRR-TTTTTT",
  "timestamp": "ISO 8601",
  "tier": "execution | system | health",
  "service": "opai-tasks | opai-wordpress | opai-monitor | ...",
  "event": "squad-run | push-op | health-check | imap-scan | ...",
  "status": "completed | failed | partial | skipped",
  "duration_ms": 3000,

  "summary": "Human-readable one-liner",

  "details": {
    // Tier 1 (execution) — agent run details
    "taskId": "t-YYYYMMDD-NNN",
    "agentId": "feedback-fixer",
    "agentType": "agent | squad | claude-direct",
    "agentName": "Feedback Fixer",
    "model": "sonnet | opus | haiku | squad",
    "tokensInput": 27,
    "tokensOutput": 267,
    "tokensCacheRead": 726951,
    "tokensTotal": 824735,
    "costUsd": 0.0,
    "numTurns": 3,
    "reportFile": "/path/to/report.md",
    "sessionId": "session-abc123",
    "isError": false,
    "errorMessage": null,

    // Tier 1 squad-specific
    "squadName": "evolve",
    "agentsRun": ["self_assessment", "executor_safe"],
    "totalFindings": 3,
    "totalActions": 2,
    "reportDir": "/workspace/reports/2026-02-22",

    // Tier 2 (system) — operation details
    "itemsProcessed": 5,
    "itemsCreated": 2,
    "itemsSkipped": 3,

    // Tier 3 (health) — health event details
    "serviceStatus": "up | down | degraded",
    "previousStatus": "up",
    "metric": "memory_percent",
    "value": 92.5,
    "threshold": 90
  }
}
```

### Shared Audit Helper

A lightweight Python module that any OPAI service can import:

```python
# tools/shared/audit.py
# Usage from any service:
from shared.audit import log_audit

log_audit(
    tier="system",
    service="opai-wordpress",
    event="push-op",
    status="completed",
    summary="Push OP v2.1.3 — 4/5 sites updated",
    duration_ms=12000,
    details={"sites_total": 5, "sites_pushed": 4, "sites_error": 1}
)
```

The helper:
1. Generates audit ID (`audit-YYYYMMDD-RRR-TTTTTT`)
2. Adds timestamp
3. Appends to `tasks/audit.json` with file locking
4. Manages overflow to `tasks/audit-archive.json` (max 2000 records)

### Audit Tab UI Upgrades

- **Tier filter buttons**: Execution | System | Health | All
- **Service dropdown**: Filter by originating service
- **Date range picker**: Filter by time window
- **Status filter**: completed / failed / partial
- **Search**: Full-text search across summaries
- **Detail drill-down**: Click any entry for full details
- **Heartbeat indicator**: "Last audit entry X seconds ago" — if stale, system may be down

---

## 4. Monitor Merger into TCP

### Overview

Monitor (port 8080, ~3,600 LOC Python + ~2,800 LOC frontend) merges into TCP (port 8081) as a **Health tab**. Monitor's draggable panels, resource displays, Claude usage tracking, WebSocket streaming, and service control all remain intact within the TCP shell.

### What Moves

| Monitor Component | Lines | Destination | Notes |
|-------------------|-------|-------------|-------|
| `collectors.py` | 455 | `tools/opai-tasks/collectors.py` | System stats, agent detection, service statuses |
| `session_collector.py` | 821 | `tools/opai-tasks/session_collector.py` | Claude usage tracking, Anthropic API |
| `updater.py` | 354 | `tools/opai-tasks/updater.py` | System change detector |
| `log_reader.py` | 138 | `tools/opai-tasks/log_reader.py` | Log aggregation |
| `services.py` (monitor) | 312 | Merge into `tools/opai-tasks/services.py` | Service control, agent kill, queue process |
| `routes_api.py` (monitor) | 506 | `tools/opai-tasks/routes_monitor.py` | New router mounted under `/api/monitor/` |
| `routes_users.py` | 664 | `tools/opai-tasks/routes_users.py` | User management (keep as-is) |
| `routes_ws.py` | 112 | `tools/opai-tasks/routes_ws.py` | WebSocket endpoints |
| Frontend panels | ~2,800 | New Health tab content in TCP | Draggable panels, charts, modals |

### URL Structure (post-merge)

```
/tasks/                     → TCP main page (existing)
/tasks/api/...              → Task API (existing)
/tasks/api/monitor/...      → Monitor API endpoints (new prefix)
/tasks/api/users/...        → User management endpoints
/tasks/ws/stats             → System stats WebSocket
/tasks/ws/agents            → Running agents WebSocket
/tasks/ws/logs              → Log stream WebSocket
/tasks/ws/claude            → Claude usage WebSocket
```

### Frontend Tab Structure (post-merge)

```
┌──────┐ ┌──────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐
│Tasks │ │Audit │ │Feedback│ │My Queue│ │  Health  │ │ Settings │
│      │ │      │ │        │ │ (HITL) │ │(Monitor) │ │          │
└──────┘ └──────┘ └────────┘ └────────┘ └──────────┘ └──────────┘

Health tab contains Monitor's panels:
├── System Stats (CPU, RAM, Disk, Network, Load, Swap)
├── Claude Usage & Status (plan usage meters, sessions, dashboard)
├── Running Agents (live process list)
├── Services (systemd status grid with start/stop/restart)
├── Squad Status (active jobs)
├── Log Viewer (real-time stream)
├── Reports Browser
├── Quick Actions (kill agents, start services, emergency stop)
├── User Controls (invite, manage, lockdown)
└── System Changes (updater suggestions)

All panels remain draggable within the Health tab.
Save Layout persists per-tab.
```

### Dependencies to Add to TCP

```
psutil>=6.0.0       # System monitoring (already in Monitor)
aiofiles>=24.1.0    # Async file I/O (already in Monitor)
httpx>=0.24.0       # Anthropic API calls (already in Monitor)
```

### Migration Steps

1. Copy Monitor's Python modules into TCP tool directory
2. Mount Monitor routes as new router with `/api/monitor/` prefix
3. Add WebSocket routes to TCP's app
4. Start Monitor's background tasks (updater, log collection) in TCP's lifespan
5. Create Health tab in TCP frontend — embed Monitor's HTML panels
6. Copy Monitor's JS functions into TCP's app.js (namespaced)
7. Connect WebSockets to new TCP-based endpoints
8. Update Caddy: remove `/monitor/` proxy, TCP serves everything
9. Update systemd: disable `opai-monitor.service`
10. Update Monitor health checks: TCP now responds at both `/health` and `/api/monitor/health`
11. Update all references to Monitor endpoints across other tools

### What Changes for Users

- `/monitor/` URL redirects to `/tasks/` Health tab
- All functionality preserved — same panels, same controls, same WebSocket updates
- Single service instead of two

---

## 5. Service Audit Integration Plan

Each OPAI service adds audit logging using the shared helper:

| Service | Events to Log | Tier | Priority |
|---------|---------------|------|----------|
| **opai-tasks** | Task status changes, auto-execute cycle runs, agent launches | execution, health | Phase 1 |
| **opai-wordpress** | Push OP runs (already does), backup events, update checks | system | Phase 2 |
| **opai-email-agent** | IMAP scans (emails found/processed), action executions | system | Phase 2 |
| **opai-bot-space** | Cron dispatches, bot runs, credit transactions | system | Phase 3 |
| **opai-brain** | Curator runs, linker runs, research completions | system | Phase 3 |
| **opai-bx4** | Analysis runs, report generations, scheduler executions | execution | Phase 3 |
| **opai-orchestra** | Composition runs, flow executions | execution | Phase 3 |
| **opai-prd** | PRD evaluations, idea imports | system | Phase 3 |
| **opai-billing** | Subscription events, webhook receipts | system | Phase 3 |
| **opai-team-hub** | Space operations, message activity summaries | system | Phase 4 |
| **opai-docs** | Doc rebuilds, watcher triggers | health | Phase 4 |
| **opai-discord-bot** | Command executions, session starts | system | Phase 4 |
| **opai-orchestrator** | Cycle summaries, scheduled squad triggers, evolution runs | execution, health | Phase 1 |

### Integration Pattern (per service)

```python
# 1. Add to service's requirements or sys.path
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from audit import log_audit

# 2. Log events at key points
log_audit(
    tier="system",
    service="opai-email-agent",
    event="imap-scan",
    status="completed",
    summary="Scanned 3 accounts — 2 new emails found",
    details={"accounts_scanned": 3, "emails_found": 2, "emails_processed": 2}
)
```

---

## 6. Implementation Phases

### Phase 1: Status Model + Audit Foundation (Week 1)

**Goal:** Clean status model, shared audit helper, task list shows only actionable items.

- [ ] Create `tools/shared/audit.py` — universal audit helper
- [ ] Migrate status names in `services.py` (delegated→running, approved→scheduled, rejected→cancelled)
- [ ] Add `awaiting_retry`, `timed_out` status handling to auto-execute cycle
- [ ] Add timeout watchdog to running tasks (configurable per agentType)
- [ ] Update `create_tasks_from_plan_steps()` — evolution tasks go to `scheduled` directly
- [ ] Stop creating run-tracking tasks for self-assessment/evolution — audit only
- [ ] Update `post_squad_hook.py` — use shared audit helper, stop creating run-tracking tasks
- [ ] Update `orchestrator/index.js` — use audit-only for evolution runs, no more task+audit double-write
- [ ] Update Push OP — audit only, no task creation
- [ ] Update frontend: status badges, filter options, batch edit options
- [ ] Update CSS: color scheme for new statuses
- [ ] Test all task lifecycles end-to-end

### Phase 2: Audit Tab Upgrade + Service Integration Wave 1 (Week 2)

**Goal:** Tiered audit view, first services writing audit entries.

- [x] Audit tab: add tier filter buttons (Execution / System / Health / All)
- [x] Audit tab: add service dropdown filter
- [x] Audit tab: add heartbeat indicator ("last entry X ago")
- [x] Audit tab: detail panel shows tier-appropriate fields
- [x] Add audit writes to: opai-email-agent, opai-orchestrator (cycle summaries)
- [x] Add audit writes to: opai-tasks auto-execute cycle (health tier — "cycle ran, X tasks launched")
- [x] Verify WordPress push-op uses shared audit helper
- [x] Document audit integration pattern in wiki

### Phase 3: Monitor Merger (Week 3-4)

**Goal:** Monitor's full functionality lives inside TCP as the Health tab.

- [ ] Copy Monitor backend modules to TCP directory
- [ ] Mount Monitor routes under `/api/monitor/` prefix
- [ ] Add WebSocket routes to TCP app
- [ ] Create Health tab shell in TCP frontend
- [ ] Port Monitor's panel HTML into Health tab
- [ ] Port Monitor's JS functions (namespaced to avoid conflicts)
- [ ] Connect WebSockets to new endpoints
- [ ] Test: system stats, agents, logs, Claude usage, service control, user management
- [ ] Update Caddy routing (remove /monitor/ proxy)
- [ ] Disable opai-monitor systemd service
- [ ] Add redirect: `/monitor/` → `/tasks/#health`
- [ ] Update all cross-service references to Monitor endpoints

### Phase 4: Service Integration Wave 2 + Polish (Week 5)

**Goal:** All services write audit, documentation complete.

- [ ] Add audit writes to: opai-bot-space, opai-brain, opai-bx4, opai-orchestra
- [ ] Add audit writes to: opai-prd, opai-billing, opai-team-hub
- [ ] Add audit writes to: opai-docs, opai-discord-bot
- [ ] Verify heartbeat coverage — every service has at least one periodic audit entry
- [ ] Polish: consistent styling, responsive layout, keyboard navigation
- [ ] Update `Library/opai-wiki/task-control-panel.md` with new architecture
- [ ] Update `Library/opai-wiki/monitor.md` → mark as merged
- [ ] Update CLAUDE.md if needed
- [ ] Final end-to-end testing

---

## 7. Industry Comparison

Based on research of CrewAI, AutoGen/AG2, LangGraph, Prefect, Temporal, Airflow, n8n, and OpenAI Agents SDK:

### What OPAI Does Better Than Industry

| Strength | Details |
|----------|---------|
| **Multi-source task ingestion** | Email, Discord, feedback, agents, manual — no other framework has this breadth |
| **Bypass/approval rules** | Source-based auto-approval with trusted senders is more nuanced than any competitor |
| **Rich audit records** | Token tracking, cost estimation, agent roster, report links — far richer than most |
| **HITL with delegation** | Most systems have binary approve/reject. OPAI has delegation-aware approval |
| **Musical metaphor** | Memorable brand language that humanizes agentic ops |

### What OPAI Adopts From Industry

| Pattern | Source | How OPAI Uses It |
|---------|--------|-----------------|
| Expanded state model | Prefect (gold standard) | 9 states with clear transitions and terminal/non-terminal distinction |
| `awaiting_retry` state | Prefect, Airflow | Preserves retry context instead of silently reverting to pending |
| `timed_out` terminal state | Temporal, OpenAI | Prevents zombie tasks that sit forever |
| Tiered audit/observability | OpenTelemetry, LangSmith | Three-tier audit with execution/system/health categories |
| Completion callback | All mature systems | Background thread watches process, updates status on exit |
| Universal event logging | n8n hooks, OpenAI tracing | Every service writes to audit — single source of truth |

### What OPAI Defers (future consideration)

| Pattern | Source | Why Deferred |
|---------|--------|-------------|
| Two-level state model (type + name) | Prefect | Adds complexity; OPAI's 9 states are granular enough for now |
| Checkpoint/time-travel debugging | LangGraph | Requires significant infrastructure; current audit records suffice |
| OpenTelemetry export | SK, AutoGen | Nice-to-have; audit.json works well for single-server deployment |
| Guardrail validation on output | CrewAI | Could add later; current feedback loop serves similar purpose |
| Parallel guardrails | OpenAI Agents SDK | Not applicable to current execution model |

---

## 8. Success Criteria

After full implementation:

1. **Main task list** shows only actionable items — no run-tracking entries, no system events
2. **Audit tab** shows all OPAI activity across all services — filterable by tier and service
3. **Health tab** provides full system monitoring — replaces standalone Monitor
4. **Every status** has one unambiguous meaning — no "pending but really scheduled" confusion
5. **Every OPAI service** writes to the audit log — the heartbeat is visible
6. **New services** can add audit logging with 5 lines of code
7. **No zombie tasks** — running tasks time out, failed tasks show retry state
8. **Single service** — TCP is the one dashboard for everything

---

## Appendix A: Files to Modify

### Phase 1 (Status + Audit Foundation)

| File | Changes |
|------|---------|
| `tools/shared/audit.py` | **New** — universal audit helper |
| `tools/opai-tasks/services.py` | Status renames, timeout watchdog, retry state, audit helper usage |
| `tools/opai-tasks/routes_api.py` | Status filter updates, batch edit updates |
| `tools/opai-tasks/static/app.js` | Status badges, filter options, mode labels |
| `tools/opai-tasks/static/index.html` | Filter dropdowns, batch edit options |
| `tools/opai-tasks/static/style.css` | New status colors/badges |
| `scripts/post_squad_hook.py` | Use shared audit helper, stop run-tracking tasks |
| `tools/opai-orchestrator/index.js` | Audit-only for evolution runs |
| `tools/opai-wordpress/services/task_logger.py` | Audit-only for push-op (no task) |

### Phase 3 (Monitor Merger)

| File | Changes |
|------|---------|
| `tools/opai-tasks/collectors.py` | **New** (from Monitor) |
| `tools/opai-tasks/session_collector.py` | **New** (from Monitor) |
| `tools/opai-tasks/updater.py` | **New** (from Monitor) |
| `tools/opai-tasks/log_reader.py` | **New** (from Monitor) |
| `tools/opai-tasks/routes_monitor.py` | **New** (Monitor API under /api/monitor/) |
| `tools/opai-tasks/routes_users.py` | **New** (from Monitor) |
| `tools/opai-tasks/routes_ws.py` | **New** (from Monitor) |
| `tools/opai-tasks/app.py` | Mount new routers, add WebSocket, add lifespan tasks |
| `tools/opai-tasks/static/index.html` | Health tab, Monitor panels |
| `tools/opai-tasks/static/app.js` | Monitor JS functions (namespaced) |
| `tools/opai-tasks/static/style.css` | Monitor panel styles |
| `config/Caddyfile` | Remove /monitor/ proxy |

---

## Appendix B: Current vs Proposed Comparison

### Task Registry (before)

```
44 tasks total:
  22 completed, 19 pending, 2 delegated, 1 rejected

Includes:
  ✅ Actionable fixes from evolution plan
  ✅ Feedback-sourced bug fixes
  ❌ Run-tracking entries ("[Self-Assessment completed]")
  ❌ System event entries (Push OP ran)
  ❌ Orphan tasks stuck in "delegated" forever
```

### Task Registry (after)

```
~25 tasks (actionable only):
  All pending/scheduled/running/completed/failed/cancelled

Only includes:
  ✅ Actionable fixes from evolution plan
  ✅ Feedback-sourced bug fixes
  ✅ Manual tasks
  ✅ Email-sourced tasks
  ✅ Discord-sourced tasks

NOT included (audit only):
  → Self-assessment runs → audit (tier: execution)
  → Evolution plan runs → audit (tier: execution)
  → Push OP events → audit (tier: system)
  → IMAP scans → audit (tier: system)
  → Health checks → audit (tier: health)
```

### Audit Log (before)

```
Writers: 4 services (post_squad_hook, orchestrator, TCP, wordpress)
Missing: email agent, bot space, brain, bx4, orchestra, prd, billing, docs, discord
Filtering: basic (agent, origin, date)
Tiers: none
```

### Audit Log (after)

```
Writers: ALL services (14+)
Tiers: execution, system, health
Filtering: tier, service, date range, status, full-text search
Heartbeat: visible "last entry X ago" indicator
Coverage: if a service runs, it appears in the audit log
```
