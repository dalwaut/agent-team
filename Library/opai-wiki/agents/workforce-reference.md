# OPAI Workforce Reference

> Complete reference for every entity in the OPAI workforce: agents, squads, workers, specialist templates, and swarm capabilities.

**Last Updated**: 2026-03-05
**UI**: Engine Dashboard > Workers > Roster tab
**API**: `GET /engine/api/workers/roster`

---

## Overview

OPAI's workforce is a multi-layered system of autonomous entities that collaborate to manage 38+ projects, run business operations, and maintain internal infrastructure.

```
┌─────────────────────────────────────────────────────────┐
│                    SWARM LAYER                          │
│  (Worker Mail, Pre-Task Priming, Hierarchical           │
│   Delegation, Auto-Review, Self-Improvement)            │
├─────────────────────────────────────────────────────────┤
│                 FLEET COORDINATOR                       │
│  (Dispatch, routing, category matching, action items)   │
├──────────────┬───────────────────┬──────────────────────┤
│  WORKERS     │  SQUADS           │  AGENTS              │
│  (15 managed │  (29 compositions │  (48 specialized     │
│   processes) │   of agents)      │   AI roles)          │
├──────────────┴───────────────────┴──────────────────────┤
│              SPECIALIST TEMPLATES (7)                   │
│  (Reusable prompt bases for project-specific agents)    │
└─────────────────────────────────────────────────────────┘
```

**Counts**: 48 agents | 29 squads | 15 workers | 7 templates | 5 swarm capabilities

---

## Agents (48)

Agents are specialized AI roles defined in `team.json`. Each has a prompt file, category, and run order. They execute via `claude -p` (CLI, read-only, stdout-only).

### By Category

#### Quality (10)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `reviewer` | CR | Code Reviewer | Reviews code changes for quality, consistency, patterns | parallel |
| `accuracy` | AC | Accuracy Auditor | Audits calculations, data transformations, date/time logic | parallel |
| `health` | HL | Codebase Health Auditor | Performance bottlenecks, dead code, unused dependencies | parallel |
| `test_writer` | TE | Test Engineer | Identifies untested paths, writes test specs | parallel |
| `ux_reviewer` | UX | UX Reviewer | Loading states, error handling, empty states, accessibility | parallel |
| `perf_profiler` | PP | Performance Profiler | Sync I/O in async, unbounded concurrency, memory leaks | parallel |
| `api_designer` | AD | API Design Reviewer | REST naming, HTTP methods, status codes, pagination | parallel |
| `a11y_auditor` | A1 | Accessibility Auditor | WCAG 2.1 AA: contrast, keyboard nav, ARIA, labels | parallel |
| `llm_engineer` | LE | LLM Application Specialist | RAG pipelines, prompt engineering, embeddings, evaluation | parallel |
| `frontend_auditor` | FR | Frontend Code Quality | React patterns, state management, Tailwind, responsive | parallel |

#### Security (7)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `security` | SC | Security Analyst | Auth flows, API key exposure, injection vectors, OWASP | parallel |
| `dep_scanner` | DS | Dependency Scanner | Unpinned versions, vulnerable packages, supply chain | parallel |
| `secrets_detector` | SD | Secrets Detector | Committed credentials, API keys, tokens, env hygiene | parallel |
| `threat_modeler` | TH | Threat Modeler | STRIDE methodology, trust boundaries, attack trees | parallel |
| `db_auditor` | DB | Database Security Auditor | RLS coverage, SQL injection, connection string security | parallel |
| `api_contract_checker` | AC | API Contract Checker | Auth coverage, HTTP methods, validation, CORS, rate limiting | parallel |
| `docker_auditor` | DK | Docker Security Auditor | Dockerfiles, compose configs, privilege escalation, mounts | parallel |

#### Operations (7)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `github` | GH | GitHub Operations Manager | Versioning, branching, PRs, issues, releases | parallel |
| `notes_curator` | NC | Notes Curator | Scans notes/, classifies files, proposes organization | parallel |
| `library_curator` | LC | Library Curator | Maintains Library/ knowledge base, indexes content | parallel |
| `workspace_steward` | WS | Workspace Steward | Project compliance, file hygiene, naming conventions | parallel |
| `email_manager` | EM | Email Manager | Reads email data, produces task lists, tracks drafts | parallel |
| `tools_monitor` | TM | Tools Monitor | Health of all tools/ and mcps/, config validation | parallel |
| `node_updater` | NU | Node Update Specialist | Safe Node.js/npm/dependency upgrades with rollback | parallel |
| `wiki_librarian` | WK | Wiki Librarian | Reviews changes, produces wiki updates | parallel |
| `incident_responder` | IR | Incident Responder | Service logs, auth anomalies, disk pressure, triage | parallel |

#### Research (4)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `researcher` | RS | Technical Researcher | Libraries, APIs, best practices, emerging patterns | parallel |
| `problem_solver` | PS | Problem Solver | Analyzes vague tasks, identifies unknowns, proposes solutions | parallel |
| `prdgent` | 🧪 | PRDgent | Product R&D evaluator — 5-criteria scoring (Sonnet, 3 turns) | parallel |
| `rd_analyst` | RN | R&D Analyst | Deep research from video intakes, queued ideas, system gaps | parallel |
| `business_analyst` | BA | Business & Market Analyst | Market sizing, competitive landscape, financial modeling | parallel |

#### Planning (2)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `features` | FA | Feature Architect | Architecture for new features with file-by-file specs | parallel |
| `integration` | IA | Integration Architect | Cross-project and third-party integration blueprints | parallel |

#### Execution (3)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `executor_safe` | E1 | Executor (Safe Mode) | Non-breaking fixes only: dead code, unused deps, console.log | last |
| `executor_full` | E2 | Executor (Full Mode) | All safe + structural: bug fixes, refactors, query optimization | last |
| `builder` | BL | Builder | Implements plans/tasks directly in codebase | parallel |
| `feedback_fixer` | 🔧 | Feedback Fixer | Targeted fixes from user feedback items (Sonnet, 10 turns) | parallel |

#### Content (2)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `content_curator` | CC | Content Curator | Changelogs, app store descriptions, social posts, docs | parallel |
| `cd` | Cd | Coder | Writes out code for desired project | parallel |

#### Orchestration (2)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `report_dispatcher` | RD | Report Dispatcher | Reads reports, extracts action items, generates HITL briefings | last |
| `dam_planner` | DM | DAM Planner | Decomposes goals into executable plan trees for DAM Bot | parallel |

#### Meta (3)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `familiarizer` | HI | Project Familiarizer | First-run scan, outputs customizations (interactive) | first |
| `self_assessment` | SA | Team Self-Assessment | Detects team gaps, proposes new agents/workflows | last |
| `meta_assessment` | MA | Meta-Assessment | Second-order loop: assesses the assessment system itself | last |

#### Leadership (1)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `manager` | PM | Project Manager | Consolidates findings, builds plans, prioritizes work | last |

#### Other (2)

| Key | Emoji | Name | Description | Run Order |
|-----|-------|------|-------------|-----------|
| `mobile_auditor` | MA | Mobile Security Auditor | Expo/React Native: storage, secrets, deep links, EAS | parallel |
| `cicd_auditor` | CI | CI/CD Security Auditor | GitHub Actions, systemd hardening, Caddy, deploy scripts | parallel |
| `project_onboarder` | OB | Project Onboarder | Discovers and onboards external projects with diamond workflow | parallel |

---

## Squads (29)

Squads are named compositions of agents that run together. Some include a `dynamic_pool` — a larger set that the fleet coordinator can select from based on task context.

| Squad | Agents | Pool | Description |
|-------|--------|------|-------------|
| `audit` | 12 | 18 | Full codebase audit (quality + security + frontend) |
| `plan` | 6 | 7 | Feature planning and architecture |
| `review` | 8 | 12 | Code review after changes |
| `ship` | 10 | 14 | Pre-release checks |
| `release` | 5 | — | Full release workflow |
| `auto_safe` | 5 | — | Audit then auto-apply safe-only fixes |
| `auto_full` | 6 | — | Audit then auto-apply all improvements |
| `evolve` | 2 | — | Self-improvement: assess gaps, then verify pipeline |
| `knowledge` | 4 | — | Organize notes, library, wiki, then dispatch |
| `dispatch` | 1 | — | Process reports, generate agent instructions |
| `onboard` | 2 | — | Discover and onboard external projects |
| `hygiene` | 2 | — | File cleanup, naming, structure compliance |
| `workspace` | 6 | 7 | Complete workspace audit |
| `email` | 2 | — | Email management and dispatch |
| `tools` | 3 | — | Tools ecosystem health |
| `incident` | 2 | — | Incident detection and triage |
| `a11y` | 2 | — | WCAG 2.1 AA accessibility audit |
| `wiki` | 2 | — | Post-implementation wiki update |
| `node_update` | 3 | — | Safe Node.js/npm upgrade cycle |
| `build` | 1 | — | Implement from plan/spec |
| `dep_scan` | 2 | — | Fast daily dependency vulnerability scan |
| `secrets_scan` | 2 | — | Fast daily secrets detection scan |
| `secure` | 10 | 13 | Full security suite (weekly/pre-release) |
| `mobile` | 5 | — | Mobile app audit |
| `security_quick` | 4 | — | Fast daily security check |
| `brain` | 3 | — | 2nd Brain maintenance |
| `rd` | 2 | — | R&D research deep-dive |
| `forge` | 7 | 9 | Post-build quality gate for n8n-forge pipeline |
| `familiarize` | 1 | — | First-run project onboarding |

**Run a squad**: `./scripts/run_squad.sh -s "<squad_name>"`

---

## Workers (15)

Workers are managed processes defined in `config/workers.json`. The Engine's WorkerManager handles lifecycle, health checks, and scheduling.

### Long-Running (always active)

| Key | Name | Runtime | Trigger | Purpose |
|-----|------|---------|---------|---------|
| `email-manager` | Email Manager | node | internal-polling (30m) | Multi-account email monitoring + triage |
| `discord-bot` | Discord Bridge | node | event-driven | Discord community bridge |

### Hybrid (service + scheduled)

| Key | Name | Runtime | Port | Schedule | Purpose |
|-----|------|---------|------|----------|---------|
| `wordpress-manager` | WordPress Manager | python | 8096 | every 6h | Multi-site WordPress management |

### Task (on-demand / cron)

| Key | Name | Runtime | Trigger | Purpose |
|-----|------|---------|---------|---------|
| `project-reviewer` | Project Reviewer | claude-cli | manual / squad:audit | Code review for quality and correctness |
| `project-builder` | Project Builder | claude-cli | manual | Implement code from task specs |
| `researcher` | Researcher | claude-cli | manual | Deep research and technical analysis |
| `wiki-librarian` | Wiki Librarian | claude-cli | daily 4am | Maintain wiki accuracy |
| `self-assessor` | Self Assessor | claude-cli | daily 2am | Evaluate OPAI platform health |
| `meta-assessor` | Meta Assessor | claude-cli | after-squad:evolve | Verify self-improvement pipeline |
| `security-scanner` | Security Scanner | claude-cli | weekly Sunday 3am | Find vulnerabilities |
| `report-dispatcher` | Report Dispatcher | claude-cli | after-squad | Read reports, dispatch follow-ups |
| `browser-agent` | Browser Agent | claude-cli | manual | Browser-based research/automation |
| `context-harvester` | Context Harvester | claude-cli | every 4h | Synthesize operational context journal |
| `project-lead` | Project Lead | claude-cli | manual | Decompose tasks, coordinate sub-workers |

### NFS External

| Key | Name | Runtime | Trigger | Purpose |
|-----|------|---------|---------|---------|
| `nfs-external` | NFS External Worker | claude-code-remote | nfs-drop | Template for external ClawBot workers via NFS inbox/outbox |

---

## Specialist Templates (7)

Not active agents — reusable prompt bases that can be copied to `scripts/` and customized per project.

| Filename | Name | When to Use |
|----------|------|-------------|
| `prompt_expo_expert.txt` | Expo Expert | React Native / Expo mobile projects |
| `prompt_supabase_expert.txt` | Supabase Expert | Supabase schema, RLS, functions, auth |
| `prompt_n8n_specialist.txt` | n8n Specialist | n8n workflow design and optimization |
| `prompt_wordpress_expert.txt` | WordPress Expert | WordPress theme/plugin development |
| `prompt_fusion_builder.txt` | Fusion Builder | Avada Fusion Builder layouts |
| `prompt_page_designer.txt` | Page Designer | Landing page and marketing page design |
| `prompt_design_reviewer.txt` | Design Reviewer | UI/UX design review and feedback |

---

## Swarm Capabilities (5)

Swarm is **NOT a runnable command**. It is the runtime coordination layer implemented in the Fleet Coordinator (`tools/opai-engine/background/fleet_coordinator.py`) that enables workers to operate as a cohesive unit. These capabilities are always active during worker execution.

### 1. Worker Mail

SQLite-backed inter-worker messaging system mirrored to Team Hub. Workers exchange context, findings, and instructions asynchronously. Enables workers to leave messages for future workers without direct coupling.

**Implementation**: `fleet_coordinator.py` → `worker_mail` SQLite table + Team Hub API

### 2. Pre-Task Context Priming

Before a worker runs, the fleet coordinator injects the operational journal and recent worker mail into the task context. This gives each worker situational awareness of what other workers have found and the current system state.

**Implementation**: `fleet_coordinator.py` → `prime_task_context()`

### 3. Hierarchical Delegation

The Project Lead worker can decompose complex tasks into sub-tasks and dispatch them to specialized sub-workers. Uses the `DISPATCH:` output protocol — the fleet coordinator parses worker output and routes sub-tasks automatically.

**Implementation**: `fleet_coordinator.py` → output parsing + `dispatch_sub_task()`

### 4. Auto-Review Pipeline

Builder workers automatically trigger reviewer workers on completion, creating a build→review chain without human intervention. The fleet coordinator detects builder completion and queues the appropriate reviewer.

**Implementation**: `fleet_coordinator.py` → `post_task_hooks`

### 5. Self-Improvement Loop

Workers can propose new tasks via the `PROPOSE_TASK:` output protocol. Proposals enter a human-gated queue (action items) before being added to the task registry. This allows the system to evolve based on what workers discover during execution.

**Implementation**: `fleet_coordinator.py` → output parsing + action items API

---

## How They Connect

```
          team.json                    config/workers.json
          ┌─────────┐                 ┌──────────────┐
          │ 48 Agents│                 │ 15 Workers   │
          │ 29 Squads│                 │              │
          │ 7 Templs │                 │ lifecycle    │
          └────┬─────┘                 │ health checks│
               │                       └──────┬───────┘
               │ defines roles                 │ manages processes
               ▼                               ▼
    ┌──────────────────────────────────────────────┐
    │           ENGINE (port 8080)                  │
    │  ┌────────────────────────────────────────┐   │
    │  │       FLEET COORDINATOR                │   │
    │  │  - Category/keyword routing            │   │
    │  │  - Dynamic pool selection              │   │
    │  │  - Action Items API (6 sources)        │   │
    │  │  - SWARM capabilities (5)              │   │
    │  └────────────┬───────────────────────────┘   │
    │               │                               │
    │  ┌────────────▼───────────────────────────┐   │
    │  │       WORKER MANAGER                   │   │
    │  │  - Start/stop/restart workers          │   │
    │  │  - Health check loop                   │   │
    │  │  - Auto-restart on failure             │   │
    │  │  - Task worker execution               │   │
    │  └────────────────────────────────────────┘   │
    └──────────────────────────────────────────────┘
                    │
                    ▼
    ┌──────────────────────────────────────────────┐
    │         EXECUTION TARGETS                    │
    │  - Claude CLI (claude -p)                    │
    │  - Python/Node processes                     │
    │  - NFS external workers                      │
    │  - Telegram HITL gate                        │
    │  - Team Hub (task backbone)                  │
    └──────────────────────────────────────────────┘
```

**Flow**: Human or system creates a task → Fleet Coordinator routes to appropriate worker(s) → Worker Manager executes → Swarm layer coordinates (mail, priming, delegation) → Results feed back to action items / Team Hub / reports.

---

## Quick Reference

```bash
# Run a squad
./scripts/run_squad.sh -s "audit"
./scripts/run_squad.sh -s "secure"

# Run builder with inline task
./scripts/run_builder.sh -t "Add dark mode to Brain" --context tools/opai-brain

# Check worker status
./scripts/opai-control.sh status

# Worker lifecycle (via API)
curl localhost:8080/api/workers                    # List all
curl localhost:8080/api/workers/roster             # Full roster
curl -X POST localhost:8080/api/workers/email-manager/restart

# Supabase SQL
./scripts/supabase-sql.sh "SELECT count(*) FROM profiles"
```

---

## Key Files

| File | Purpose |
|------|---------|
| `team.json` | Agent roles, squads, specialist templates |
| `config/workers.json` | Worker process definitions |
| `scripts/run_squad.sh` | Squad runner |
| `scripts/run_builder.sh` | Builder agent runner |
| `tools/opai-engine/background/fleet_coordinator.py` | Fleet coordination + swarm |
| `tools/opai-engine/background/worker_manager.py` | Worker lifecycle management |
| `tools/opai-engine/routes/workers.py` | Worker API endpoints (incl. `/roster`) |

---

## See Also

- [Agent Framework](agent-framework.md) — detailed prompt system, runner scripts, per-agent tuning
- [Fleet Coordinator & Action Items](../infra/fleet-action-items.md) — dispatch backbone + swarm details
- [Task Control Panel](../tools/task-control-panel.md) — Engine dashboard UI
