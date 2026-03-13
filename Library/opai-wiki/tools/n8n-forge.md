# n8n-Forge Pipeline
> Last updated: 2026-03-04 | Source: `~/.agents/skills/n8n-forge/`, `team.json` (forge squad), `scripts/prompt_n8n_specialist.txt`, `tools/shared/teamhub_client.py`, `scripts/post_squad_hook.py`

Interactive pipeline for designing n8n workflows, prototyping them on our self-hosted instance, then converting the workflow JSON into fully standalone applications. Leverages n8n as a rapid prototyping layer while producing production code with zero n8n dependency — sidestepping the internal-only licensing restriction.

## Overview

| Property | Value |
|----------|-------|
| **Skill** | `/n8n-forge` (interactive, 3-phase) |
| **Squad** | `forge` (7 agents — post-build quality gate) |
| **Specialist** | `prompt_n8n_specialist.txt` (on-demand) |
| **Project Template** | `Templates/templates-projects/n8n_workflow_struucture/` |
| **n8n Instance** | boutabyte.com (self-hosted, internal-only) |
| **MCP Tools** | `search_workflows`, `execute_workflow`, `get_workflow_details` |
| **Team Hub Client** | `tools/shared/teamhub_client.py` |
| **Node Mapping** | `~/.agents/skills/n8n-forge/references/node-mapping.md` |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  1. IDEATE                                              │
│     prdgent (scoring) + business_analyst + /blueprint   │
├─────────────────────────────────────────────────────────┤
│  2. DESIGN + PROTOTYPE  (/n8n-forge — Phase A+B)        │
│     Map workflow → Design n8n nodes → Push to n8n       │
│     Test in n8n → Export JSON                           │
├─────────────────────────────────────────────────────────┤
│  3. CONVERT + BUILD  (/n8n-forge — Phase C)             │
│     n8n JSON → standalone app code (Python/Node.js)     │
│     + /blueprint → /dashboard-ui → /react:components    │
├─────────────────────────────────────────────────────────┤
│  4. REVIEW  (forge squad)                               │
│     reviewer + security + test_writer + api_designer    │
│     + frontend_auditor + ux_reviewer → manager          │
├─────────────────────────────────────────────────────────┤
│  5. SHIP  (existing ship squad)                         │
│     health + security + dep_scanner + cicd_auditor      │
│     + content_curator + github → manager                │
└─────────────────────────────────────────────────────────┘
```

## Three Phases

### Phase A — Design

Interactive workflow specification within the conversation:

1. **Define the product** — what it does, who it's for, trigger type, inputs, outputs, core logic
2. **Map the workflow** — ASCII blueprint of the node graph (triggers → processing → decisions → outputs)
3. **Check existing patterns** — search `Library/n8n/Workflows/` and live n8n instance via MCP
4. **Create project scaffold** — from `Templates/templates-projects/n8n_workflow_struucture/`
5. **Write plan.md** — node-by-node specification with credentials and error handling

### Phase B — Prototype

Build and test in n8n using MCP tools:

1. **Search existing workflows** — `mcp__claude_ai_n8n__search_workflows`
2. **Design workflow JSON** — nodes, connections, parameters
3. **Execute and test** — `mcp__claude_ai_n8n__execute_workflow` with test data
4. **Iterate** — adjust nodes based on test results
5. **Export** — save finalized JSON to `workflow.json`

### Phase C — Convert

Transform n8n workflow JSON into standalone application code:

1. **Analyze workflow** — map each node to code equivalent (see node-mapping reference)
2. **Generate app structure** — entry point, routes, service modules, config
3. **Wire up logic** — implement exact n8n node logic in Python/Node.js
4. **Add production concerns** — error handling, retries, logging, input validation
5. **Generate credentials checklist** — all API keys, env vars, setup steps needed

## Key Files

| File | Purpose |
|------|---------|
| `~/.agents/skills/n8n-forge/SKILL.md` | Core skill definition — 3 phases, rules, integration points |
| `~/.agents/skills/n8n-forge/references/node-mapping.md` | n8n node → Python/Node.js code equivalents (25+ node types) |
| `~/.claude/skills/n8n-forge` | Symlink for Claude Code skill discovery |
| `scripts/prompt_n8n_specialist.txt` | Generalized n8n specialist agent prompt |
| `team.json` → `forge` squad | Post-build quality gate squad definition |
| `tools/shared/teamhub_client.py` | Shared Team Hub client for agent ↔ Team Hub communication |
| `Templates/templates-projects/n8n_workflow_struucture/` | Project scaffold with plan.md, workflow.json, converted/, review.md |

## Forge Squad

Post-build quality gate. Runs after Phase C conversion to validate the standalone code.

| Phase | Agents | Purpose |
|-------|--------|---------|
| **1 (parallel)** | `reviewer` | Code quality, patterns, consistency |
| **1 (parallel)** | `security` | Auth, injection, OWASP top 10 |
| **1 (parallel)** | `test_writer` | Test coverage, test specs |
| **1 (parallel)** | `api_designer` | API design quality (if applicable) |
| **1 (parallel)** | `frontend_auditor` | UI quality (if applicable) |
| **1 (parallel)** | `ux_reviewer` | UX patterns, empty states, error handling |
| **2 (last)** | `manager` | Consolidated report + prioritized action items |

**Dynamic pool** adds: `accuracy`, `perf_profiler`, `llm_engineer`

```bash
# Run forge quality gate
./scripts/run_squad.sh -s forge --context Projects/<name>/converted

# Dynamic mode
./scripts/run_squad.sh -s forge --dynamic --context "Converted email pipeline app"
```

## n8n Specialist Agent

Generalized agent prompt at `scripts/prompt_n8n_specialist.txt`. Not added to any squad — called on-demand like `prdgent`. Capabilities:

- Understands all n8n node types (Core, Integration, AI/LLM)
- Knows our n8n instance, existing 7 workflows, 100+ exported templates
- Designs workflow blueprints with ASCII node graphs
- Analyzes exported JSON and explains node-by-node
- Proposes automation opportunities for any codebase/project
- 6 design patterns: API Gateway, Data Pipeline, Event Handler, Batch Processor, AI Pipeline, Error-Safe Wrapper

## Node Mapping Reference

The skill includes a comprehensive code mapping at `references/node-mapping.md` covering:

| Category | Nodes |
|----------|-------|
| **Triggers** | Webhook, Schedule, Email (IMAP) |
| **Data Processing** | Set, Code, Merge, Split Out, Aggregate |
| **Logic** | IF, Switch, Wait, Loop |
| **HTTP** | HTTP Request, Respond to Webhook |
| **Integrations** | Supabase, Gmail, Slack, Discord, Telegram, Google Sheets, Airtable, Stripe, OpenAI/Claude |
| **Error Handling** | Retry with backoff, error notification pattern |
| **Credentials** | Full env variable → Python package mapping table |

Each node includes both Python (FastAPI/Flask) and Node.js (Express) equivalents.

## Team Hub Integration

### TeamHubClient (`tools/shared/teamhub_client.py`)

Synchronous Python client wrapping Team Hub's internal API for agent use:

```python
from shared.teamhub_client import TeamHubClient, DALLAS_UUID

th = TeamHubClient()

# Create task
task = th.create_task(
    title="[FORGE] Review email pipeline",
    priority="high",
    assignee_id=DALLAS_UUID,
)

# Add progress comment
th.add_comment(task["id"], "Phase A complete. Workflow designed.")

# Mention Dallas for HITL input
th.mention_dallas(task["id"], "Need input on pricing model")

# Create subtask
subtask = th.create_subtask(task["id"], "[Design] Workflow specification")

# Mark complete
th.complete(subtask["id"])
```

**Methods:**

| Method | Purpose |
|--------|---------|
| `create_task()` | Create task with title, description, priority, source, assignee, parent |
| `add_comment()` | Add comment with optional @mention parsing |
| `assign()` | Assign user to task |
| `update_status()` | Change status (open/in_progress/review/completed) |
| `update_task()` | Update any field (title, description, priority, due_date) |
| `mention_dallas()` | Convenience: add comment with `@[Dallas](uuid)` mention |
| `create_subtask()` | Create child task under parent |
| `complete()` | Mark task as completed |

### Post-Squad Hook Bridge

`scripts/post_squad_hook.py` now mirrors squad findings to Team Hub:

1. Creates a parent task: `[SQUAD_NAME] Agent findings — YYYY-MM-DD`
2. Adds per-agent comments with P0/P1/P2 action items
3. P0 findings trigger `@[Dallas]` mention → notification
4. Runs alongside existing `tasks/registry.json` entries (backward-compatible)

### Internal Endpoint Fix

The `/api/internal/add-comment` endpoint now calls `_parse_mentions()` from `routes_comments.py`, enabling agents to trigger real notifications when using `@[Name](uuid)` syntax in comments. Previously, mention parsing only ran on the authenticated `/api/items/{id}/comments` route.

## Project Scaffold

```
Projects/<product-name>/
├── Dev-Plan/
│   └── plan.md              ← Phase A: workflow design doc
├── Codebase/
│   └── main.json            ← Phase B: exported n8n workflow JSON
├── Notes/
│   └── overview.md          ← Pipeline progress tracker
├── Research/
│   └── sources.md           ← Existing patterns referenced
├── Review-log/
│   └── review.md            ← Phase 4: forge squad output
├── Agent-Tasks/
│   └── tasks.yaml           ← Agent work items
├── Ag-Build-Tasks/
│   └── build.yaml           ← Builder agent tasks
├── Debug-log/
│   └── debug.log            ← Testing/debug output
└── GEMINI.md                ← Project overview
```

Additional directories created during conversion:
```
├── converted/               ← Phase C: standalone app code
│   ├── app.py / index.js    ← Entry point + routes
│   ├── config.py / .env     ← Environment variables
│   ├── services/            ← One module per workflow segment
│   ├── requirements.txt     ← Python deps
│   └── .env.example         ← Credential template
└── SPEC.md                  ← Product spec (from SPEC template)
```

## Skill Integration

| Scenario | Companion Skill |
|----------|----------------|
| Product needs a UI | `/blueprint` → `/dashboard-ui` or `/react:components` |
| Evaluating idea first | PRDgent via PRD Pipeline |
| React component generation | `/react:components` |
| shadcn/ui components | `/shadcn-ui` |
| Full release pipeline | `forge` squad → `ship` squad |

## How to Use

### Quick Start

```bash
# In conversation:
# "Let's forge an n8n workflow for [idea]"
# "Convert this n8n workflow to an app"
# → Triggers /n8n-forge skill

# Run quality gate after conversion:
./scripts/run_squad.sh -s forge --context Projects/<name>/converted

# Full pipeline: forge → ship
./scripts/run_squad.sh -s forge --context Projects/<name>/converted
./scripts/run_squad.sh -s ship --context Projects/<name>/converted
```

### End-to-End Flow

1. **Ideate**: Use PRDgent to score the idea, `/blueprint` to wireframe any UI
2. **Design**: `/n8n-forge` Phase A — define product, map workflow, create scaffold
3. **Prototype**: `/n8n-forge` Phase B — build in n8n, test, export JSON
4. **Convert**: `/n8n-forge` Phase C — transform to standalone Python/Node.js app
5. **Review**: Run `forge` squad — automated quality gate
6. **Ship**: Run `ship` squad — pre-release checks, then deploy

## Dependencies

| Dependency | Purpose |
|------------|---------|
| n8n MCP tools | Interact with live n8n instance |
| Team Hub (port 8089) | Task tracking and HITL notifications |
| Claude Code CLI | Agent execution via `run_squad.sh` |
| `tools/shared/teamhub_client.py` | Agent → Team Hub bridge |
| `tools/shared/audit.py` | Audit logging |
| `Library/n8n/Workflows/` | Existing workflow JSON library |

## Rules

1. **n8n is internal-only** — never expose to customers or include in final product
2. **Standalone = zero n8n dependency** — converted code must run independently
3. **Test before converting** — validate the n8n workflow works before Phase C
4. **Blueprint first** — use ASCII wireframes for any UI components
5. **Anti-slop** — if conversion produces bad code, fix the workflow design, don't patch output
6. **Credentials via env** — never hardcode API keys or secrets
7. **One workflow = one product** — keep scope tight per forge run
