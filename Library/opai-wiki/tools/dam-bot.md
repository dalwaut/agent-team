# DAM Bot — Do Anything Mode

> Meta-orchestrator: takes any goal and executes it end-to-end with minimal human intervention.

| Field | Value |
|-------|-------|
| Port | `8104` |
| Path | `/dam/` |
| Service | `opai-dam` |
| Tool Dir | `tools/opai-dam/` |
| Migration | `034_dam_bot.sql`, `035_dam_model_preference.sql` |
| Version | 1.0.0 (Phase 1 MVP) |

---

## What DAM Bot Does

Unlike HELM (specialized for business ops) or the squad system (batch agent runs), DAM Bot is a **meta-orchestrator**:

1. Takes any goal — text description, PRD ID, business plan, or structured brief
2. Uses Claude to decompose it into an executable plan tree (phases → steps → sub-steps)
3. Executes the plan step-by-step, delegating to existing OPAI agents, squads, and tools
4. Pauses at approval gates for human review of risky actions
5. Tracks everything in Supabase with full audit trail
6. (Future) Self-improves by detecting capability gaps and proposing new skills

---

## Architecture

```
Portal /dam/  ·  Mobile App  ·  Discord
                │
                ▼
  ┌────────────────────────────────┐
  │   DAM Bot — FastAPI :8104      │
  │                                │
  │  Planner ─► Pipeline Engine    │
  │              │                 │
  │    ┌─────────┼─────────┐      │
  │    ▼         ▼         ▼      │
  │  Hooks   Executor   Approval  │
  │    │         │       Gate     │
  │    ▼         ▼                │
  │  Skills   Agent Bridge        │
  └──────┬───────┬────────────────┘
         │       │
    ┌────┤       ├────────────┐
    ▼    ▼       ▼            ▼
  Tools  OPAI   HELM      Self-Improve
         Agents  (business  (Phase 4)
         (42+)   bootstrap)
```

---

## Core Systems

### Planner Engine (`core/planner.py`)
- Claude-powered goal decomposition
- Input: user goal + context (available agents, squads, tools)
- Output: hierarchical plan tree with typed steps
- Plans are versioned — revisions create new versions, old ones deactivated
- Prompt template: `scripts/prompt_dam_planner.txt`

### Pipeline Engine (`core/pipeline.py`)
- Sequential step execution with dependency tracking
- For each step: check deps → check approval → execute → log → broadcast
- Pauses at approval gates, resumes after approval/rejection
- Stalled session detection (>30 min timeout)
- TCP integration — sessions post to Task Registry

### Approval Gate (`core/approval_gate.py`)
- Tiered HITL system controlled by per-session `autonomy_level` (1-10)
- Action categories: read, sandbox_write, external_api_write, purchase, content_publish, large_financial, irreversible
- Default autonomy: 7 (confirms external writes, auto-approves sandbox ops)
- Broadcasts to Portal UI + Discord

| Action Type | Autonomy 1-3 | 4-6 | 7-8 (default) | 9-10 |
|-------------|--------------|-----|----------------|------|
| Reads/analysis | Auto | Auto | Auto | Auto |
| Sandbox writes | Confirm | Auto | Auto | Auto |
| External API writes | Confirm | Confirm | Confirm | Auto |
| Purchases | Confirm | Confirm | Confirm | Confirm |
| Content publishing | Confirm | Confirm | Confirm | Auto |
| Large financial (>$100) | CEO-gate | CEO-gate | CEO-gate | CEO-gate |
| Irreversible | Block | Block | CEO-gate | CEO-gate |

### Agent Bridge (`core/agent_bridge.py`)
- Spawns agents via `claude -p` subprocess (same pattern as TCP auto-executor)
- Accepts optional `model` param — maps short names (haiku/sonnet/opus) to full model IDs and passes `--model` flag
- Runs squads via `run_squad.sh`
- Removes `CLAUDECODE` env var to allow nested Claude spawns

### Claude AI Caller (`core/ai.py`)
- Delegates to shared wrapper (`tools/shared/claude_api.py`) — see [MCP Infrastructure](mcp-infrastructure.md)
- Preserves `call_claude()` interface for all callers (planner, executor, etc.)
- CLI mode (default): `claude -p` subprocess via subscription
- API mode (dormant): Anthropic SDK with optional PTC, activates if `ANTHROPIC_API_KEY` is set
- Also exports `call_claude_ptc` for future batch workloads

### Intelligent Model Routing
DAM Bot assigns the right Claude model to each step based on task complexity.

**Session-level model selector** (dropdown in New Session modal):
- **Auto (Recommended)** — Planner analyzes each step and assigns haiku/sonnet/opus based on complexity
- **Haiku** — Force all steps to Haiku (fast/cheap)
- **Sonnet** — Force all steps to Sonnet (balanced)
- **Opus** — Force all steps to Opus (maximum capability)

Stored as `model_preference` TEXT column on `dam_sessions` (default `"auto"`). Migration: `035_dam_model_preference.sql`.

**Model resolution cascade** (evaluated per step at execution time):
1. Step config `model` field (planner-assigned in auto mode)
2. Session `model_preference` (if not "auto")
3. Agent-level `model` from `team.json`
4. System default: `"sonnet"`

**Planner model assignment** (auto mode only):
| Intensity | Model | Examples |
|-----------|-------|----------|
| Low | `haiku` | File reads, classification, tagging, formatting, status checks |
| Medium | `sonnet` | Standard code gen, analysis, bug fixes, content writing, API integration |
| High | `opus` | Architecture design, complex refactors, security audits, strategic planning |

Planner outputs `"model"` and `"model_reason"` in each step's `config` JSONB. The UI shows color-coded model badges (green=Haiku, blue=Sonnet, purple=Opus) next to each step, with model_reason as tooltip.

### Executor (`core/executor.py`)
- Dispatches steps based on `step_type`: agent_run, squad_run, tool_call, skill_call, hook
- `resolve_model()` implements the 4-level model cascade
- Caches `team.json` agent roles for agent-level model lookup
- tool_call and skill_call are Phase 2/3 stubs
- Results stored in `dam_steps.result` JSONB column (includes `model` field)

### Scheduler (`core/scheduler.py`)
- Runs every 30s (configurable via `DAM_SCHEDULER_TICK`)
- Checks for stalled sessions (>30 min in executing state)
- Auto-expires approvals pending >24h

---

## Database (9 tables, `dam_` prefix)

Migrations: `034_dam_bot.sql` (schema), `035_dam_model_preference.sql` (model routing).

| Table | Purpose |
|-------|---------|
| `dam_sessions` | Top-level goal/conversation (`model_preference` TEXT: auto/haiku/sonnet/opus) |
| `dam_plans` | Decomposed plans (versioned) |
| `dam_steps` | Individual execution steps |
| `dam_approvals` | Pending human approvals |
| `dam_skills` | Skill library (Phase 3) |
| `dam_skill_runs` | Skill execution tracking |
| `dam_hooks` | Pipeline middleware (Phase 3) |
| `dam_session_logs` | Live session log stream |
| `dam_improvement_requests` | Self-improvement queue (Phase 4) |

RLS via `dam_has_access(session_id)` — same `SECURITY DEFINER` pattern as HELM/Bx4.

---

## API Endpoints

### Sessions
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List sessions (filter: `?status=`) |
| GET | `/api/sessions/:id` | Get session detail |
| POST | `/api/sessions` | Create session `{title, goal, autonomy_level, model_preference}` |
| PATCH | `/api/sessions/:id` | Update session fields |
| DELETE | `/api/sessions/:id` | Delete session (cascades) |
| POST | `/api/sessions/:id/cancel` | Cancel running session |

### Plans
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plans/:session_id` | List plan versions |
| GET | `/api/plans/:session_id/active` | Get active plan |
| POST | `/api/plans/:session_id/generate` | Generate plan via Claude |
| POST | `/api/plans/:session_id/revise` | Revise plan `{feedback}` |

### Steps & Execution
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/steps/:session_id` | List steps for active plan |
| GET | `/api/steps/detail/:step_id` | Get step detail |
| POST | `/api/steps/:session_id/execute` | Start/resume pipeline |

### Approvals
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/approvals` | List pending approvals |
| GET | `/api/approvals/all` | List all approvals |
| POST | `/api/approvals/:id/approve` | Approve |
| POST | `/api/approvals/:id/reject` | Reject |

### Scheduler
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/scheduler/settings` | Runtime scheduler state `{tick_seconds, paused}` |
| PUT | `/api/scheduler/settings` | Update tick interval / pause (body: `{tick_seconds?, paused?}`) |

### Skills, Hooks, Improvements
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/skills` | List skills |
| POST | `/api/skills` | Create skill |
| GET | `/api/hooks` | List hooks |
| POST | `/api/hooks` | Create hook |
| GET | `/api/improvements` | List improvement requests |
| POST | `/api/improvements` | Create improvement request |

### Streaming
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stream/:session_id` | SSE stream (logs + step updates) |
| GET | `/api/stream/:session_id/logs` | Get logs (non-streaming) |

---

## File Structure

```
tools/opai-dam/
  app.py                    # FastAPI app + lifespan scheduler
  config.py                 # Env vars, paths, constants
  .env                      # Supabase keys (gitignored)
  requirements.txt
  routes/
    health.py   sessions.py   plans.py   steps.py
    approvals.py   skills.py   hooks.py
    improvements.py   stream.py
  core/
    planner.py          # Claude goal decomposition
    pipeline.py         # Step-by-step execution engine
    executor.py         # Step dispatch by type
    approval_gate.py    # Tiered HITL system
    agent_bridge.py     # claude -p / run_squad.sh interface
    skill_manager.py    # Skill CRUD + usage tracking
    ai.py               # Claude caller — delegates to shared wrapper (tools/shared/claude_api.py)
    supabase.py         # REST helpers (httpx)
    realtime.py         # Supabase Realtime + Discord broadcast
    scheduler.py        # Stall detection + approval expiry
  tools/                # Phase 2 tool implementations
  improve/              # Phase 4 self-improvement subsystem
  static/
    index.html   style.css   js/app.js
```

---

## Session Lifecycle

```
draft → planning → executing → completed
                            ↘ failed
              ↘ paused (awaiting approval) → executing (resumed)
                            ↘ cancelled
```

1. **draft**: Session created with title + goal
2. **planning**: Claude generates plan tree
3. **executing**: Pipeline runs steps sequentially
4. **paused**: Approval gate hit — waiting for human decision
5. **completed/failed**: All steps done / unrecoverable error
6. **cancelled**: User cancelled

---

## Integration Points

| System | Integration |
|--------|-------------|
| TCP | Sessions create task registry entries |
| HELM | Delegates business bootstrapping (Phase 2) |
| PRD Pipeline | Sessions can start from PRD IDs (Phase 2) |
| Orchestrator | `dam_session_monitor` schedule (every 2 min) |
| Agent System | `agent_bridge.py` spawns agents via `claude -p` |
| Shared Claude Wrapper | `core/ai.py` delegates to `tools/shared/claude_api.py` — see [MCP Infrastructure](mcp-infrastructure.md) |
| Audit | Shared `tools/shared/audit.py` logging |
| Discord | Approval + status notifications |

---

## Phase Roadmap

| Phase | Status | Scope |
|-------|--------|-------|
| 1 — MVP | **Complete** | Planning + execution + approvals + portal UI + TCP integration |
| 2 — Tools | Planned | Browser, API caller, file ops, HELM/PRD integration |
| 3 — Skills + Hooks | Planned | Skill library, hook middleware, admin UI |
| 4 — Self-Improvement | Planned | Gap detection → research → build → test → merge |
| 5 — Purchases | Planned | Domain/hosting purchase workflows, budget awareness |
| 6 — Discord + Mobile | Planned | Approval buttons, push notifications, voice input |
| 7 — Advanced | Planned | Sub-plans, parallel execution, session memory, templates |

---

## Deployment

```bash
# Install service
cp config/service-templates/opai-dam.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable opai-dam
systemctl --user start opai-dam

# Or via opai-control
./scripts/opai-control.sh restart

# Reload Caddy after Caddyfile changes
caddy reload --config /workspace/synced/opai/config/Caddyfile

# Apply migration
scripts/supabase-sql.sh < config/supabase-migrations/034_dam_bot.sql
```

---

## Common Gotchas

- **Port 8104**: DAM Bot uses 8104 (not 8103, which is Marq)
- **FULL_HEIGHT_TOOLS**: `dam` is in the navbar FULL_HEIGHT_TOOLS list — required for flex layout
- **CLAUDECODE env var**: Agent bridge removes this to allow nested `claude -p` spawns
- **Approval expiry**: Pending approvals auto-expire after 24h
- **Session stall**: Sessions stuck in `executing` for >30 min are auto-failed by scheduler
