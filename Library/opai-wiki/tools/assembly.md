# Assembly Line — End-to-End Autonomous Build Pipeline

**Version:** v3.7
**Status:** Live
**Port:** 8080 (Engine module — no separate service)
**Last Updated:** 2026-03-05

---

## Overview

The Assembly Line is an on-demand pipeline that takes an idea, PRD, spec, task, or project and drives it through evaluation, planning, building, review, iteration, and shipping — fully autonomously with two human gates. It chains existing OPAI primitives (PRDgent, Fleet Coordinator, worker dispatch, browser automation) into a single end-to-end flow.

**Input**: An idea, PRD text, spec, task ID, or project ID
**Output**: Built project with DELIVERY.md, screenshots, and usage guide

### Design Principles

- **Not a background loop** — triggered on-demand via API or Telegram
- **Reuses existing systems** — no duplication of PRDgent, Fleet, workers, or browser
- **Two human gates** — plan approval and ship approval (with optional auto-ship)
- **Restart resilient** — state persisted to JSON, resumes on Engine restart
- **Max 3 review-fix iterations** — prevents infinite loops

---

## Architecture

```
                    Idea / PRD / Spec / Task ID / Project ID
                              │
                    ┌─────────v──────────┐
                    │  PHASE 0: INTAKE   │  PRDgent evaluate + PRD generate
                    └─────────┬──────────┘
                              │
                    ┌─────────v──────────┐
                    │  PHASE 1: PLAN     │  AI-generated SPEC.md + scaffold
                    └─────────┬──────────┘
                              │
                     ═══HUMAN GATE═══     Telegram approve/reject buttons
                              │
                    ┌─────────v──────────┐
                    │  PHASE 2: BUILD    │  Fleet dispatches project-lead
                    └─────────┬──────────┘
                              │
                    ┌─────────v──────────┐
                    │  PHASE 3: REVIEW   │  Fleet dispatches project-reviewer
                    └─────────┬──────────┘
                              │
                         P0/P1 found?
                        /           \
                      yes            no
                      │               │
            ┌─────────v──────────┐    │
            │  PHASE 4: ITERATE  │    │  Fix → rebuild → re-review (max 3)
            └─────────┬──────────┘    │
                      │               │
                      └───────┬───────┘
                              │
                    ┌─────────v──────────┐
                    │  PHASE 5: SHIP     │  Screenshots, delivery package
                    └─────────┬──────────┘
                              │
                     ═══SHIP GATE═══      (optional auto-ship)
                              │
                         COMPLETED
```

---

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-engine/background/assembly.py` | Core `AssemblyPipeline` class — state machine, phase implementations |
| `tools/opai-engine/routes/assembly.py` | FastAPI API routes (`/api/assembly/*`) |
| `tools/opai-engine/config.py` | `ASSEMBLY_RUNS_FILE` path |
| `tools/opai-engine/data/assembly-runs.json` | Persisted run state (auto-created) |
| `config/orchestrator.json` → `"assembly"` | Pipeline configuration |
| `scripts/prompt_assembly_spec.txt` | Prompt for AI-generating SPEC.md |
| `scripts/prompt_assembly_fix.txt` | Prompt for converting review findings → fix specs |
| `scripts/prompt_assembly_delivery.txt` | Prompt for generating delivery packages |
| `tools/opai-telegram/handlers/commands.js` | `/assembly` Telegram command |
| `tools/opai-telegram/handlers/callbacks.js` | `asm:approve/reject/ship/abort` callback handlers |

---

## Configuration

In `config/orchestrator.json`:

```json
"assembly": {
    "enabled": true,
    "max_concurrent_runs": 2,
    "max_review_iterations": 3,
    "auto_ship": false,
    "spec_generator_model": "sonnet",
    "fix_generator_model": "sonnet",
    "delivery_packager_model": "sonnet",
    "screenshot_timeout_seconds": 30,
    "phase_timeout_minutes": {
        "intake": 10,
        "plan": 15,
        "build": 30,
        "review": 15,
        "iterate": 30,
        "ship": 15
    }
}
```

---

## Phase Details

### Phase 0 — Intake

Accepts 5 input types:

| Input Type | What Happens |
|-----------|-------------|
| `idea` | Generates PRD via `prompt_prdgent_prd.txt` (same as PRDgent) |
| `prd` | Validates PRD via `prompt_prdgent_validate.txt` |
| `spec` | Passes through directly to Phase 1 |
| `task_id` | Loads task from `tasks/registry.json` |
| `project_id` | Loads PRD.md from `Projects/<id>/` |

### Phase 1 — Plan

1. Generates project slug from PRD content
2. Calls `call_claude()` with `prompt_assembly_spec.txt` to generate full SPEC.md
3. Scaffolds project directory under `Projects/<slug>/`
4. Writes PRD.md, SPEC.md, DEV.md (from template)
5. Sends Telegram notification with **Approve Plan** / **Reject** inline buttons
6. Pauses until gate is approved

### Phase 2 — Build

1. Creates task in `tasks/registry.json` with `routing.agentType: "project-lead"`
2. Fleet Coordinator picks up the task on its next cycle and dispatches workers
3. Polls `fleet.state["recent_completions"]` for the build task completion
4. Timeout: 30 minutes (configurable)

### Phase 3 — Review

1. Creates review task with `routing.agentType: "project-reviewer"`
2. Fleet dispatches reviewer worker
3. Parses output for P0/P1/P2 findings
4. If P0/P1 found AND iterations < max → Phase 4 (Iterate)
5. If clean OR max iterations → Phase 5 (Ship)

### Phase 4 — Iterate

1. AI generates fix specifications from findings via `prompt_assembly_fix.txt`
2. Creates fix task with `routing.agentType: "project-lead"`
3. Fleet dispatches builder to apply fixes
4. Increments iteration counter
5. Routes back to Phase 3 (Review) for re-check

### Phase 5 — Ship

1. Captures screenshots via browser service (port 8107) — best-effort
2. Generates DELIVERY.md via `prompt_assembly_delivery.txt`
3. Writes DELIVERY.md to project directory
4. If `auto_ship` enabled → marks complete immediately
5. Otherwise sends **Ship It** / **Abort** buttons to Telegram
6. Pauses until gate is approved

---

## API Reference

All routes prefixed with `/api/assembly/`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/start` | Start new run `{input_type, input_text, input_ref?, auto_ship?, max_review_iterations?}` |
| `POST` | `/resume/{id}` | Resume a paused run |
| `POST` | `/abort/{id}` | Abort a run |
| `POST` | `/gate/{id}/{gate}` | Approve/reject gate `{action: "approve"\|"reject"}` — gate is `plan` or `ship` |
| `GET` | `/runs` | List runs `?status=running&limit=50` |
| `GET` | `/runs/{id}` | Get run details |
| `GET` | `/stats` | Pipeline statistics |

### Example: Start from idea

```bash
curl -s -X POST http://127.0.0.1:8080/api/assembly/start \
  -H "Content-Type: application/json" \
  -d '{"input_type": "idea", "input_text": "A CLI tool that converts markdown to HTML"}'
```

### Example: Start from existing PRD file

```bash
PRD=$(cat Projects/my-project/PRD.md)
curl -s -X POST http://127.0.0.1:8080/api/assembly/start \
  -H "Content-Type: application/json" \
  -d "{\"input_type\": \"prd\", \"input_text\": $(echo "$PRD" | jq -Rs .)}"
```

---

## Telegram Commands

| Command | Action |
|---------|--------|
| `/assembly <idea text>` | Start new run from idea |
| `/assembly prd` | Start from PRD (reply to message containing PRD) |
| `/assembly status` | Show pipeline stats |
| `/assembly list` | List recent runs (last 20) |
| `/assembly resume <id>` | Resume paused run |
| `/assembly abort <id>` | Abort run |

### Telegram Callbacks

| Pattern | Action |
|---------|--------|
| `asm:approve:<run_id>` | Approve plan gate → advance to Build |
| `asm:reject:<run_id>` | Reject plan → abort run |
| `asm:ship:<run_id>` | Approve ship gate → mark complete |
| `asm:abort:<run_id>` | Abort run from ship gate |

---

## Trigger Methods

### 1. From Claude Code (this conversation)

Brainstorm an idea, then fire it off:

```bash
curl -s -X POST http://127.0.0.1:8080/api/assembly/start \
  -H "Content-Type: application/json" \
  -d '{"input_type": "idea", "input_text": "..."}'
```

Reference an existing file:

```bash
curl -s -X POST http://127.0.0.1:8080/api/assembly/start \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
text = open('Projects/my-project/PRD.md').read()
print(json.dumps({'input_type': 'prd', 'input_text': text}))
")"
```

### 2. From Telegram

```
/assembly A markdown-to-HTML CLI tool with syntax highlighting
```

Or reply to a message containing a PRD:
```
/assembly prd
```

### 3. Programmatic (from other Engine modules)

```python
from background.assembly import AssemblyPipeline
# pipeline is available as assembly_pipeline in app.py
result = assembly_pipeline.create_run(
    input_type="idea",
    input_text="A REST API for managing bookmarks",
)
```

---

## Run State Model

```python
{
    "id": "asm-20260305-001",
    "status": "running|paused|completed|failed|aborted",
    "current_phase": 0-5,
    "phase_status": "evaluating|awaiting_plan_approval|building|reviewing|fixing|awaiting_ship_approval|shipped",
    "input_type": "idea|prd|spec|task_id|project_id",
    "input_text": "...",
    "artifacts": {
        "prd_text": "...",
        "evaluation": "...",
        "spec_path": "Projects/slug/SPEC.md",
        "project_path": "Projects/slug",
        "project_slug": "slug",
        "build_dispatches": [],
        "review_results": [],
        "fix_iterations": 0,
        "screenshots": [],
        "delivery_package": "..."
    },
    "gates": { "plan_approved": null|true, "ship_approved": null|true },
    "config": { "max_review_iterations": 3, "auto_ship": false },
    "phase_log": [{ "ts": "...", "phase": 0, "event": "...", "detail": "..." }],
    "created_at": "...",
    "updated_at": "...",
    "error": null
}
```

---

## Systems Reused (Not Rebuilt)

| Need | Existing System | How Assembly Uses It |
|------|----------------|---------------------|
| Idea evaluation | PRDgent prompts | `call_claude()` with same prompt files |
| PRD generation | `prompt_prdgent_prd.txt` | Same prompt via `call_claude()` |
| Spec validation | `prompt_prdgent_validate.txt` | Same prompt via `call_claude()` |
| Worker dispatch | Fleet Coordinator | Writes tasks to registry → fleet picks up |
| Build execution | project-lead + project-builder | Fleet dispatches (existing delegation) |
| Code review | project-reviewer worker | Fleet dispatches (existing auto-review) |
| Workspace isolation | Fleet workspace manager | Each dispatch gets isolated workspace |
| Notifications | Telegram bridge | `send_telegram()` / `send_telegram_with_buttons()` |
| Audit trail | `shared/audit.py` | `log_audit()` at every phase transition |
| Project scaffolding | `Templates/DEV.template.md` | Fills template for DEV.md |
| Screenshots | Browser service (port 8107) | HTTP request to Playwright endpoint |
| AI calls | `shared/claude_api.py` | `call_claude()` for spec/fix/delivery generation |

---

## Restart Resilience

- All run state persisted to `data/assembly-runs.json` after every state change
- On Engine startup, `assembly_pipeline.resume_active_runs()` scans for `status: "running"` runs
- Runs waiting on gates (`phase_status: "awaiting_*"`) stay paused — they resume when the gate callback fires
- Runs actively processing a phase are re-entered at their current phase

---

## Dependencies

- **Engine** (always running)
- **Fleet Coordinator** (for build/review dispatch)
- **Worker Manager** (worker availability)
- **Telegram** (for gate notifications — pipeline still works without it, just no buttons)
- **Browser service** (optional — screenshots are best-effort)
- **claude_api.py** (for AI calls in intake/plan/iterate/ship phases)
