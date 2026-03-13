# Agent Framework
> Last updated: 2026-03-05 | Source: `team.json`, `scripts/run_squad.sh`, `scripts/run_builder.sh`, `scripts/prompt_*.txt`

## Overview

Multi-agent orchestration framework (v1.3.0) that runs named squads of AI agents via the Claude Code CLI. Most agents are read-only — they analyze code and produce markdown reports to stdout. Reports drive human decisions and automated execution. The **builder** agent is the exception: it receives a plan/spec and implements changes directly in the codebase.

## Architecture

```
run_squad.sh -s <squad>
  ├─ preflight.sh (validate env)
  ├─ Read team.json → resolve agents → separate parallel vs last
  ├─ Phase 1: Launch parallel agents (max 4 concurrent)
  │     └─ fetch hints → mktemp prompt → cat prompt | claude -p → write report
  ├─ Phase 2: Run sequential ("last") agents
  │     └─ manager, executors, dispatcher (read Phase 1 reports)
  ├─ Copy reports to reports/latest/ + write .manifest.json
  └─ post_squad_hook.py: extract <!-- FEEDBACK --> → Engine API
```

### Agent Feedback Loop

Agents compound knowledge across runs via the [Agent Feedback Loop](../infra/agent-feedback-loops.md) system. `build_prompt()` fetches relevant hints from Engine before each run, and `post_squad_hook.py` extracts structured feedback from reports after each run. 5 prompts currently emit feedback (security, self_assessment, accuracy, tools_monitor, researcher).

- **Stateless agents**: All run via `claude -p --output-format text`, stdout only
- **Temp file prompts**: Avoids shell quoting issues (`/tmp/claude_prompt_*.XXXXXX`)
- **Smart caching**: Skips agents with existing reports >1000B (override with `--force`)
- **Rate limiting**: 3-second sleep between sequential agents
- **Per-agent tuning**: Each agent can override model, max turns, and project context loading (see [Agent Tuning Fields](#agent-tuning-fields))

## Key Files

| File | Purpose |
|------|---------|
| `team.json` | Agent roster (42 roles), squad definitions (26 squads), specialist templates |
| `scripts/run_squad.sh` | Main entry point — resolve squad, run agents, collect reports |
| `scripts/run_builder.sh` | Builder runner: takes a task spec and implements it via `claude -p` with write access |
| `scripts/run_agents.sh` | Run all agents in parallel (no squad grouping) |
| `scripts/run_agents_seq.sh` | Run agents sequentially with `--filter` |
| `scripts/run_auto.sh` | Executor wrapper: reads reports → generates plan → applies fixes |
| `scripts/preflight.sh` | Environment validation: claude CLI, jq, prompt files, directories |
| `scripts/familiarize.sh` | One-time project scan, generates `project_context.md` |
| `scripts/prompt_*.txt` | Individual agent prompts (one per role) |
| `scripts/prompt_composer.txt` | Dynamic mode composer prompt — selects relevant agents via haiku |
| `reports/<date>/` | Timestamped agent reports from each squad run |
| `reports/latest/` | Most recent copy of each report + `.manifest.json` |
| `reports/HITL/` | Items needing human decision (written by report_dispatcher) |
| `reports/Archive/` | Fully processed reports |

## Agent Roster

| Agent | Category | Run Order | What It Does |
|-------|----------|-----------|-------------|
| `manager` | leadership | last | Consolidates all reports, builds prioritized implementation plan |
| `reviewer` | quality | parallel | Code quality, consistency, patterns |
| `accuracy` | quality | parallel | Calculations, data transforms, date/time logic |
| `health` | quality | parallel | Performance, dead code, unused deps |
| `security` | quality | parallel | OWASP audit, auth, secrets, injection + STRIDE/PCI/Stripe (Path B injected) |
| `features` | planning | parallel | Architecture plans for new features + FastAPI/security requirements (Path B) |
| `integration` | planning | parallel | Cross-project integration blueprints |
| `researcher` | research | parallel | Libraries, APIs, best practices |
| `github` | operations | parallel | Versioning, PRs, issues, releases |
| `content_curator` | content | parallel | Changelogs, app store copy, SEO |
| `test_writer` | quality | parallel | Coverage gaps, test specs |
| `ux_reviewer` | quality | parallel | Loading/error/empty states, WCAG 2.1 AA (Path B injected) |
| `familiarizer` | meta | first | One-time scan, detects stack, customizes agents |
| `executor_safe` | execution | last | Auto-apply only non-breaking fixes |
| `executor_full` | execution | last | Auto-apply all improvements |
| `self_assessment` | meta | last | Detect team gaps, propose new agents |
| `meta_assessment` | meta | last | Second-order loop: verify fix pipeline, cross-validate agents, measure token efficiency, audit prompts (see [Meta-Assessment](../infra/meta-assessment.md)) |
| `notes_curator` | operations | parallel | Organize notes/ folder |
| `library_curator` | operations | parallel | Maintain Library/ knowledge base |
| `report_dispatcher` | orchestration | last | Extract actions, generate HITL briefings |
| `project_onboarder` | operations | parallel | Discover and onboard external projects |
| `workspace_steward` | operations | parallel | Structure compliance, file hygiene |
| `email_manager` | operations | parallel | Email task lists, pending response drafts |
| `tools_monitor` | operations | parallel | Tools/MCPs health audit |
| `wiki_librarian` | operations | parallel | System wiki maintenance (Library/opai-wiki/) |
| `node_updater` | operations | parallel | Safe Node.js/npm/dependency upgrades with rollback |
| `feedback_fixer` | execution | parallel | Implements targeted fixes from user feedback items |
| `builder` | execution | parallel | Receives a plan/spec and implements it directly in the codebase |
| `cd` | content | parallel | Generates complete source code for projects/features (stdout) |
| `prdgent` | research | parallel | PRD Pipeline evaluator — scores product ideas (not in squads) |
| `problem_solver` | research | parallel | Analyzes vague tasks, researches context, proposes solutions |
| **— Phase 1 Security (wshobson Path C) —** | | | |
| `dep_scanner` | security | parallel | CVE scan across npm/pip manifests, pinning, abandoned packages |
| `secrets_detector` | security | parallel | Pattern scan for API keys, tokens, credentials in code and git history |
| `threat_modeler` | security | parallel | STRIDE at all trust boundaries, attack trees, control validation |
| `db_auditor` | security | parallel | RLS coverage, migration safety, N+1, PostgreSQL-specific patterns |
| `api_contract_checker` | security | parallel | Auth on all routes, Pydantic validation, mobile API compliance |
| **— Phase 2 Infra (wshobson Path C) —** | | | |
| `perf_profiler` | quality | parallel | Sync I/O in async, unthrottled concurrency, missing pagination |
| `mobile_auditor` | security | parallel | AsyncStorage token storage, hardcoded secrets, deep links, EAS hygiene |
| `cicd_auditor` | security | parallel | GitHub Actions SHA pinning, systemd hardening, Caddy headers |
| `docker_auditor` | security | parallel | Container privilege, dangerous mounts, secrets in images |
| **— Phase 3 Design (wshobson Path C) —** | | | |
| `api_designer` | quality | parallel | REST naming, HTTP methods, status codes, pagination, error schema |
| `a11y_auditor` | quality | parallel | WCAG 2.1 AA: contrast, keyboard nav, focus, ARIA, forms, structure |
| `incident_responder` | operations | parallel | Service log anomalies, orchestrator health, auth patterns — HITL always |

## Agent Tuning Fields

Each agent in `team.json` supports per-role tuning fields that control model selection, turn limits, and context loading. These are configurable via the [Agent Studio](agent-studio.md) UI (model picker, max turns input, and project context toggle on the agent edit form) and are consumed by `run_agent_task()` and `_run_feedback_fix()` in the Task Control Panel backend.

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `model` | `string` | `""` (inherit from settings) | Claude model to use: `haiku`, `sonnet`, `opus`, or empty to inherit from `config/orchestrator.json` settings |
| `max_turns` | `integer` | `0` (unlimited) | Maximum agentic turns per execution. `0` means no limit. Reduces token consumption for simple tasks. |
| `no_project_context` | `boolean` | `false` | When `true`, adds `--setting-sources user` to the `claude -p` call, which skips loading `CLAUDE.md` and `MEMORY.md` (~14KB). Saves ~3,500 tokens per turn for agents that don't need workspace-wide context. |

### How Tuning Fields Are Used

1. **Agent Studio UI**: The agent edit form exposes a model dropdown (haiku/sonnet/opus/inherit), a max turns input, and a "Skip project context" toggle. `list_agents()` returns the `model` field so the UI correctly renders the current value.
2. **Task execution** (`run_agent_task()` in `tools/opai-tasks/services.py`): Reads the agent's tuning fields from `team.json` and appends the corresponding CLI flags (`--model`, `--max-turns`, `--setting-sources user`) to the `claude -p` invocation.
3. **Feedback fixer** (`_run_feedback_fix()` in `tools/opai-tasks/services.py`): Same resolution — the `feedback_fixer` agent's tuning fields in `team.json` are applied to its CLI call.
4. **Audit records**: The resolved `model` value is logged in the task's audit trail. Falls back to the resolved model variable when Claude's JSON output doesn't include a model field.

### Token Optimization Strategy

The tuning fields are part of a broader token optimization effort:

| Optimization | Savings | Where |
|-------------|---------|-------|
| `no_project_context` (`--setting-sources user`) | ~3,500 tokens/turn | Skips CLAUDE.md + MEMORY.md loading |
| Wiki context removed from feedback fixer prompt | ~3,200 tokens (one-time) | Was embedding 3KB wiki doc into every prompt; now just a hint path |
| Default `max_turns: 8` (was 15) | Caps runaway sessions | `config/orchestrator.json` → `task_processor.feedback_fixer_max_turns` |
| Default model `haiku` (was sonnet) | ~3-5x cheaper per turn | `config/orchestrator.json` → `task_processor.feedback_fixer_model` |
| Combined per-turn savings | ~4,250 tokens/turn | Across all optimizations |

## Squad Definitions

See [wshobson-agents.md](wshobson-agents.md) for the full squad reference with agent details. Summary:

| Squad | Key Agents | Use Case |
|-------|-----------|----------|
| `audit` | accuracy, health, security, ux_reviewer, dep_scanner, db_auditor, perf_profiler, a11y_auditor, api_designer, manager | Full codebase health check |
| `plan` | features, integration, researcher, threat_modeler, manager | Feature planning with security |
| `review` | reviewer, accuracy, api_designer, test_writer, github, manager | Post-change code review |
| `ship` | health, security, dep_scanner, api_contract_checker, perf_profiler, cicd_auditor, test_writer, content_curator, github, manager | Pre-release gate |
| `release` | github, content_curator, test_writer, security, manager | Version bump |
| `security_quick` | dep_scanner, secrets_detector, security, report_dispatcher | Daily fast security check |
| `secure` | dep_scanner, secrets_detector, threat_modeler, db_auditor, api_contract_checker, mobile_auditor, cicd_auditor, docker_auditor, security, report_dispatcher | Full weekly security sweep |
| `dep_scan` | dep_scanner, report_dispatcher | Daily CVE scan |
| `secrets_scan` | secrets_detector, report_dispatcher | Daily secrets detection |
| `mobile` | mobile_auditor, api_contract_checker, perf_profiler, report_dispatcher | Mobile app audit |
| `a11y` | a11y_auditor, report_dispatcher | Weekly WCAG review |
| `incident` | incident_responder, report_dispatcher | Every 4h — incident detection |
| `tools` | tools_monitor, incident_responder, report_dispatcher | Tools health audit |
| `workspace` | notes_curator, library_curator, workspace_steward, wiki_librarian, tools_monitor, report_dispatcher | Full workspace audit |
| `knowledge` | notes_curator, library_curator, wiki_librarian, report_dispatcher | Knowledge management |
| `wiki` | wiki_librarian, report_dispatcher | Update system wiki |
| `hygiene` | workspace_steward, report_dispatcher | File cleanup |
| `email` | email_manager, report_dispatcher | Email management |
| `node_update` | node_updater, tools_monitor, report_dispatcher | Safe dependency upgrades |
| `onboard` | project_onboarder, report_dispatcher | Onboard external projects |
| `evolve` | self_assessment, meta_assessment | Assess gaps + verify the assessment pipeline itself |
| `dispatch` | report_dispatcher | Process reports |
| `build` | builder | Implement a task/feature |
| `auto_safe` | accuracy, health, security, reviewer, executor_safe | Auto-fix safe changes |
| `auto_full` | accuracy, health, security, reviewer, ux_reviewer, executor_full | Auto-fix everything |
| `familiarize` | familiarizer | First-run onboarding |

## Report Flow

```
Agents produce reports → reports/<date>/ + reports/latest/
                              ↓
              Report Dispatcher reads latest/
                              ↓
            ┌─────────────────┼─────────────────┐
            ↓                 ↓                 ↓
     AGENT-READY        HUMAN-REQUIRED      BLOCKED
  (next squad run)     → reports/HITL/    (wait for deps)
                              ↓
                     Human reviews HITL/
                              ↓
                  Processed → reports/Archive/
```

## Builder Agent

The **builder** is the framework's implementation agent. Unlike audit/report agents (read-only, stdout), the builder receives a task spec and makes changes directly in the codebase via `claude -p` with write access.

### When to Use Builder vs Audit-Fix

| | Audit-Fix (`run_auto.sh`) | Builder (`run_builder.sh`) |
|---|---|---|
| **Who decides what to do?** | Agents discover issues | You provide the spec |
| **Input** | Codebase scan reports | A plan, spec, or task description |
| **Discovery step** | Required (run squad first) | Not needed |
| **Git operations** | Creates safety branch | None |
| **Scope** | Many small fixes across codebase | One focused task/feature |
| **When** | Periodic maintenance | On-demand, task-driven |

**Audit-Fix examples**: "Is our code secure?", "Clean up dead code", "Check accessibility"
**Builder examples**: "Add attachment downloads to email checker", "Add delete button to HITL briefings", "Build a settings page"

### Builder Workflow

```
Task spec (file, inline, or registry)
  → run_builder.sh parses input
  → Loads prompt_builder.txt + task spec
  → Pipes to claude -p (with write access)
  → Claude: Understand → Explore → Plan → Implement → Verify
  → Saves report to reports/<date>/builder_result_<slug>.md
  → User reviews changes via git diff
```

### Builder Input Methods

```bash
# From a markdown spec file
./scripts/run_builder.sh specs/add-attachments.md

# Inline task description
./scripts/run_builder.sh -t "Add a delete button to HITL briefings"

# From task registry
./scripts/run_builder.sh --task TASK-042
```

### Builder Options

| Flag | Purpose |
|------|---------|
| `--dry-run` | Generate implementation plan only, no file changes |
| `--context PATH` | Scope hint — focus exploration on a specific directory |
| `--yes` / `-y` | Skip confirmation prompt |

### Builder Safety Model

- **No git operations** — no branches, no commits, no pushes
- **Confirmation prompt** — asks before proceeding (skip with `--yes`)
- **Dry-run mode** — plan without touching files
- **Scoped boundaries** — won't modify .env, credentials, DB schemas, auth flows, CI/CD
- **Report output** — every run saves a full report to `reports/<date>/`

## How to Use

```bash
# List available squads
./scripts/run_squad.sh --list

# Run a squad
./scripts/run_squad.sh -s audit

# Skip preflight (from OPAI root)
./scripts/run_squad.sh -s audit --skip-preflight

# Run specific agents
./scripts/run_agents_seq.sh --filter "accuracy,health"

# Force re-run (ignore cached reports)
./scripts/run_squad.sh -s audit --force

# Auto-fix (safe mode)
./scripts/run_auto.sh --mode safe

# Builder: implement from a spec file
./scripts/run_builder.sh specs/my-feature.md

# Builder: inline task
./scripts/run_builder.sh -t "Add dark mode to Monitor"

# Builder: dry-run (plan only)
./scripts/run_builder.sh -t "Add dark mode" --dry-run

# Builder: with context scope
./scripts/run_builder.sh -t "Add attachment downloads" --context tools/email-checker
```

## Dynamic Mode

Dynamic mode adds a "composer" pre-step to squad runs — a cheap haiku Claude call that selects only the 3-5 most relevant parallel agents for the current task. Sequential/last agents (manager, report_dispatcher) are always kept. Everything else is backwards compatible.

### Flags

| Flag | Purpose |
|------|---------|
| `--dynamic` | Enable smart agent selection via composer |
| `--context "..."` | Task description for composer (what changed, what to focus on) |
| `--target <dir>` | Specific directory to focus analysis on |

### How It Works

1. Squad runner reads the squad's `dynamic_pool` from `team.json` (falls back to `agents` if no pool defined)
2. Filters out "last" agents — they're never candidates for removal
3. Calls `claude -p --model haiku` with `prompt_composer.txt` — passes candidate agents + descriptions, context, target, and recent `.manifest.json` report history
4. Parses the JSON array response, validates each agent exists in pool and count is 3-7
5. Rebuilds the parallel agent list with only the selected agents
6. On any failure (bad JSON, count out of range, CLI error), falls back to the full squad — zero risk

### Squads with Dynamic Pools

Dynamic pools are a superset of the squad's regular agents, giving the composer more options. Only squads with 6+ agents have pools:

| Squad | Base Agents | Pool Size | Pool Additions |
|-------|------------|-----------|----------------|
| `audit` | 12 | 19 | +api_contract_checker, docker_auditor, cicd_auditor, secrets_detector, threat_modeler, mobile_auditor, test_writer, reviewer |
| `secure` | 10 | 13 | +perf_profiler, accuracy, health, llm_engineer |
| `ship` | 10 | 14 | +accuracy, docker_auditor, secrets_detector, reviewer, frontend_auditor |
| `review` | 8 | 12 | +security, perf_profiler, db_auditor, ux_reviewer, a11y_auditor |
| `plan` | 6 | 7 | +prdgent, rd_analyst |
| `workspace` | 6 | 7 | +email_manager, project_onboarder |
| `forge` | 7 | 9 | +accuracy, perf_profiler, llm_engineer |

### Examples

```bash
# Dynamic audit focused on billing changes
./scripts/run_squad.sh -s audit --dynamic --context "New Stripe billing integration"

# Dynamic security scan targeting chat service
./scripts/run_squad.sh -s secure --dynamic --context "Post-deploy security check" --target tools/opai-chat

# Dynamic review after RLS policy changes
./scripts/run_squad.sh -s review --dynamic --context "PR: Added RLS policies" --target tools/opai-engine

# Classic mode — unchanged
./scripts/run_squad.sh -s audit
```

### Fallback Behavior

| Scenario | Behavior |
|----------|----------|
| Composer returns invalid JSON | Fall back to full squad, log warning |
| Composer returns <3 or >7 agents | Fall back to full squad |
| Composer returns unknown agent name | Filter it out; if remaining <3, fall back |
| Composer CLI call fails/times out | Fall back to full squad |
| `--dynamic` without `--context` | Works — composer gets "General run, no specific context" |
| `--dynamic` on small squad (<4 parallel) | Composer runs but likely returns all (minimal waste) |
| No `--dynamic` flag | Existing behavior, byte-for-byte unchanged |

### Token Impact

The composer call costs ~2K tokens (haiku). On a 12-agent squad, dynamic selection typically picks 3-5 agents, saving ~60-75% of tokens that would have been spent on irrelevant sonnet/opus agent runs (~100K+ tokens saved per run).

## Configuration (orchestrator.json)

Global defaults for agent execution live in `config/orchestrator.json` under `task_processor`:

| Setting | Default | Purpose |
|---------|---------|---------|
| `feedback_fixer_model` | `"haiku"` | Default model for feedback fixer agent (overridden by per-agent `model` in team.json) |
| `feedback_fixer_max_turns` | `8` | Default max turns for feedback fixer (overridden by per-agent `max_turns`) |
| `daily_token_budget_enabled` | `true` | Enable/disable the daily token budget cap |
| `daily_token_budget` | `5000000` | Daily token budget limit (input + output tokens combined) |

These settings are editable via the Token Budget modal in the [Task Control Panel](task-control-panel.md) Audit tab.

## Dependencies

- **CLI**: `claude` (Claude Code CLI via nvm), `jq` (JSON parsing)
- **Reads**: `team.json` (roster/squads), `scripts/prompt_*.txt` (agent prompts), `config/orchestrator.json` (tuning defaults)
- **Writes**: `reports/<date>/*.md`, `reports/latest/`, `reports/HITL/`
- **Called by**: [Orchestrator](orchestrator.md) (scheduled squads), [Task Control Panel](task-control-panel.md) (on-demand), [Monitor](monitor.md) (squad runs)
