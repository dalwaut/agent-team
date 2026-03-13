# OPAI Agent Framework + wshobson Integration — Context Document
> For AI assistants and professionals working on the OPAI agent system.
> Last updated: 2026-02-20

---

## What Is the Agent Framework?

OPAI's agent system is a **multi-agent orchestration framework (v1.3.0)** that runs named squads of AI agents via the Claude Code CLI. It is the analytical and execution backbone of OPAI — responsible for code audits, security reviews, feature planning, auto-fixes, wiki maintenance, incident detection, and more.

**Design principle**: Most agents are **read-only** — they analyze the codebase and produce markdown reports to stdout. These reports drive human decisions. The **builder** agent is the exception: it receives a plan/spec and implements changes directly.

---

## Core Files

| File | Purpose |
|------|---------|
| `team.json` | Agent roster (42 roles) + squad definitions (26 squads) |
| `scripts/run_squad.sh` | Main runner: resolve squad → spawn parallel agents → collect reports |
| `scripts/run_builder.sh` | Builder runner: task spec → direct codebase implementation |
| `scripts/run_agents.sh` | Run all agents in parallel (no squad grouping) |
| `scripts/run_agents_seq.sh` | Run agents sequentially with `--filter` |
| `scripts/run_auto.sh` | Executor: reads reports → generates plan → applies fixes |
| `scripts/preflight.sh` | Environment validation before run |
| `scripts/prompt_*.txt` | Individual agent system prompts (one `.txt` per role, 42 total) |
| `reports/<date>/` | Timestamped reports from each squad run |
| `reports/latest/` | Most recent copy of each agent's report + `.manifest.json` |
| `reports/HITL/` | Items needing human decision |
| `reports/Archive/` | Fully processed/archived reports |
| `config/orchestrator.json` | Global defaults (model, max_turns, token budget) |

---

## Execution Model

```
run_squad.sh -s <squad>
  ├─ preflight.sh (validate env: claude CLI, jq, prompt files)
  ├─ Read team.json → resolve agents → separate parallel vs last
  ├─ Phase 1: Launch parallel agents (max 4 concurrent)
  │     └─ mktemp prompt → pipe to claude -p → write report
  ├─ Phase 2: Run sequential ("last") agents
  │     └─ manager, executors, dispatcher (read Phase 1 reports)
  └─ Copy reports → reports/latest/ + write .manifest.json
```

- **Stateless**: All run via `claude -p --output-format text`, stdout only
- **Temp file prompts**: Avoids shell quoting issues (`/tmp/claude_prompt_*.XXXXXX`)
- **Smart caching**: Skips agents with existing reports >1000B (override with `--force`)
- **Rate limiting**: 3-second sleep between sequential agents
- **Max concurrency**: 4 parallel agents at once

---

## Agent Roster (42 Roles)

### Leadership
| Agent | Category | Run Order | Purpose |
|-------|----------|-----------|---------|
| `manager` | leadership | last | Consolidates all reports, builds prioritized implementation plan |

### Quality Agents (Parallel)
| Agent | Purpose |
|-------|---------|
| `reviewer` | Code quality, consistency, patterns |
| `accuracy` | Calculations, data transforms, date/time logic |
| `health` | Performance, dead code, unused dependencies |
| `security` | OWASP audit, auth, secrets, injection + STRIDE/PCI/Stripe |
| `ux_reviewer` | Loading/error/empty states, WCAG 2.1 AA |
| `test_writer` | Coverage gaps, test specifications |
| `perf_profiler` | Sync I/O in async, unthrottled concurrency, missing pagination |
| `a11y_auditor` | WCAG 2.1 AA: contrast, keyboard nav, focus, ARIA, forms |
| `api_designer` | REST naming, HTTP methods, status codes, pagination, error schema |

### Security Agents (Parallel)
| Agent | Purpose |
|-------|---------|
| `dep_scanner` | CVE scan across npm/pip manifests, abandoned packages |
| `secrets_detector` | Pattern scan for API keys, tokens, credentials in code + git history |
| `threat_modeler` | STRIDE at all trust boundaries, attack trees, control validation |
| `db_auditor` | RLS coverage, migration safety, N+1, PostgreSQL-specific patterns |
| `api_contract_checker` | Auth on all routes, Pydantic validation, mobile API compliance |
| `mobile_auditor` | AsyncStorage token storage, hardcoded secrets, deep links, EAS hygiene |
| `cicd_auditor` | GitHub Actions SHA pinning, systemd hardening, Caddy headers |
| `docker_auditor` | Container privilege, dangerous mounts, secrets in images |

### Planning Agents (Parallel)
| Agent | Purpose |
|-------|---------|
| `features` | Architecture plans for new features + FastAPI/security requirements |
| `integration` | Cross-project integration blueprints |
| `researcher` | Libraries, APIs, best practices research |

### Execution Agents
| Agent | Purpose |
|-------|---------|
| `executor_safe` | Auto-apply only non-breaking fixes |
| `executor_full` | Auto-apply all improvements |
| `builder` | Receives task spec and implements changes directly in codebase |
| `feedback_fixer` | Implements targeted fixes from user feedback items |
| `cd` | Generates complete source code for projects/features (stdout) |

### Operations Agents (Parallel)
| Agent | Purpose |
|-------|---------|
| `wiki_librarian` | Maintains `Library/opai-wiki/` docs |
| `notes_curator` | Organizes `notes/` folder |
| `library_curator` | Maintains `Library/` knowledge base |
| `workspace_steward` | Structure compliance, file hygiene |
| `tools_monitor` | Tools/MCPs health audit |
| `email_manager` | Email task lists, pending response drafts |
| `node_updater` | Safe Node.js/npm/dependency upgrades with rollback |
| `project_onboarder` | Discover and onboard external projects |
| `incident_responder` | Service log anomalies, auth patterns — HITL always |

### Meta / Research
| Agent | Purpose |
|-------|---------|
| `familiarizer` | First-run project scan, generates `project_context.md` |
| `self_assessment` | Detects team gaps, proposes new agents |
| `prdgent` | PRD Pipeline evaluator — scores product ideas |
| `problem_solver` | Analyzes vague tasks, researches context, proposes solutions |
| `report_dispatcher` | Classifies actions, generates HITL briefings |

---

## Per-Agent Tuning Fields

Each agent in `team.json` supports:

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `model` | string | `""` (inherit) | `haiku` / `sonnet` / `opus` — or empty to inherit from global config |
| `max_turns` | integer | `0` (unlimited) | Caps agentic turns to control cost |
| `no_project_context` | boolean | `false` | When `true`, skips loading CLAUDE.md + MEMORY.md (~3,500 token save) |

**Configured via**: Agent Studio UI (model picker, max turns input, context toggle) OR directly in `team.json`.

**Token optimization strategy**:
- Use `haiku` for simple single-file agents
- Use `sonnet` for security/code analysis
- Use `opus` for threat modeling and architectural decisions
- Set `no_project_context: true` for agents that don't need workspace-wide context

---

## Squad Definitions (26 Squads)

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
| `evolve` | self_assessment | Assess gaps, propose new agents |
| `dispatch` | report_dispatcher | Process/classify pending reports |
| `build` | builder | Implement a task/feature |
| `auto_safe` | accuracy, health, security, reviewer, executor_safe | Auto-fix safe changes |
| `auto_full` | accuracy, health, security, reviewer, ux_reviewer, executor_full | Auto-fix everything |
| `familiarize` | familiarizer | First-run onboarding |

---

## Report Flow

```
Agents → stdout → reports/<date>/ + reports/latest/
                              ↓
              Report Dispatcher reads latest/
                              ↓
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
 AGENT-READY            HUMAN-REQUIRED           BLOCKED
 (next squad run)       → reports/HITL/          (wait for deps)
                              ↓
                   Human reviews in Task Control Panel
                   (approve / reject / defer / reassign)
                              ↓
                   Processed → reports/Archive/
```

---

## Builder Agent

The builder is the **only write-access agent**. All others are read-only.

```bash
# From a markdown spec file
./scripts/run_builder.sh specs/add-attachments.md

# Inline task description
./scripts/run_builder.sh -t "Add a delete button to HITL briefings"

# From task registry
./scripts/run_builder.sh --task TASK-042

# Options
--dry-run         # Generate plan only, no file changes
--context PATH    # Scope hint — focus exploration on a directory
--yes / -y        # Skip confirmation prompt
```

**Safety boundaries**: Won't touch `.env`, credentials, DB schemas, auth flows, CI/CD configs.

---

## wshobson/agents Integration

[wshobson/agents](https://github.com/wshobson/agents) is a 72-plugin marketplace providing 112 agents, 146 SKILL.md knowledge files, and 79 slash commands covering every software development domain. OPAI integrates via three paths.

**Repository location**: `mcps/wshobson-agents/`

### Integration Paths

| Path | Mechanism | Token Cost | Status |
|------|-----------|------------|--------|
| **A — Plugin Install** | `/plugin install <name>` → loads SKILL.md into session | High (per session) | 3 of 72 installed |
| **B — Skill Injection** | Extract SKILL.md content → bake into `scripts/prompt_*.txt` | Zero (baked permanently) | ✅ 17 skills injected |
| **C — New Batch Agents** | New prompt files + `team.json` registration as OPAI agents | Zero (baked permanently) | ✅ 12 new agents |

**Why B+C over A**: Path A loads skill content into every session even when not needed. With 72 plugins averaging 2-4KB each, auto-loading all would add 150-300KB to every session. Paths B+C pay cost only when the relevant agent runs.

---

### Installed Plugins (Path A — Use On Demand)

#### `agent-teams`
Parallel multi-agent coordination for code reviews, debugging, and feature development.

| Slash Command | What It Does |
|---------------|-------------|
| `/agent-teams:team-review` | Multi-reviewer parallel code review |
| `/agent-teams:team-debug` | Competing hypothesis debugging |
| `/agent-teams:team-feature` | Parallel feature development with file ownership |
| `/agent-teams:team-spawn` | Spawn preset team (review/debug/feature/security) |
| `/agent-teams:team-delegate` | Task delegation dashboard |
| `/agent-teams:team-status` | Show active team + progress |
| `/agent-teams:team-shutdown` | Gracefully shut down team |

#### `security-scanning`
Comprehensive security review tooling.

| Slash Command | What It Does |
|---------------|-------------|
| `/security-scanning:security-hardening` | Defense-in-depth hardening across all layers |
| `/security-scanning:security-sast` | SAST scan across multiple languages |

#### `full-stack-orchestration`
End-to-end feature development with gated phases.

| Slash Command | What It Does |
|---------------|-------------|
| `/full-stack-orchestration:full-stack-feature` | 9-phase gated feature: spec → DB → backend → frontend → testing → deploy |

---

### Path B: Skills Permanently Injected Into Agent Prompts

| Skill | → Agent Prompt | What It Adds |
|-------|----------------|-------------|
| `stride-analysis-patterns` | `prompt_security.txt` | STRIDE at each OPAI trust boundary |
| `attack-tree-construction` | `prompt_security.txt` | Attack path visualization + defense gap ID |
| `sast-configuration` | `prompt_security.txt` | Semgrep patterns, CWE/OWASP mapping |
| `threat-mitigation-mapping` | `prompt_security.txt` | Control validation, remediation priority |
| `stripe-integration` | `prompt_security.txt` | Webhook signature verification, PCI scoping |
| `pci-compliance` | `prompt_security.txt` | Currency handling, Stripe integer amounts |
| `security-requirement-extraction` | `prompt_features.txt` | Security requirements during feature planning |
| `fastapi-templates` | `prompt_features.txt` | FastAPI patterns, DI via Depends(), middleware |
| `postgresql` | `prompt_db_auditor.txt` | RLS audit, index strategy, N+1 detection |
| `wcag-audit-patterns` | `prompt_ux_reviewer.txt` | WCAG 2.1 AA checklist, contrast ratios |
| `multi-reviewer-patterns` | `prompt_reviewer.txt` | Structured finding format, severity calibration |
| `parallel-debugging` | `prompt_health.txt` | Competing hypothesis root cause framework |
| `task-coordination-strategies` | `prompt_manager.txt` | Dependency graph decomposition |
| `team-communication-protocols` | `prompt_report_dispatcher.txt` | HITL message type selection, approval patterns |
| `screen-reader-testing` | `prompt_a11y_auditor.txt` | Screen reader compatibility, landmark testing |
| `incident-runbook-templates` | `prompt_incident_responder.txt` | SEV1-SEV4 triage structure |
| `postmortem-writing` | `prompt_incident_responder.txt` | Postmortem trigger criteria and structure |

---

### Path C: New Batch Agents (12 New Roles)

#### Phase 1 — Security Agents

| Agent | Model | Squads | What It Audits |
|-------|-------|--------|---------------|
| `dep_scanner` | sonnet | audit, ship, secure, dep_scan | npm/pip CVEs, unpinned versions, abandoned packages, postinstall scripts |
| `secrets_detector` | sonnet | audit, ship, secure, secrets_scan | API key patterns, hardcoded IPs, .gitignore hygiene, git history scan |
| `threat_modeler` | **opus** | secure, plan | STRIDE at all trust boundaries, attack trees, control validation |
| `db_auditor` | sonnet | audit, secure, dep_scan | RLS coverage, migration destructive ops, FK indexes, PII columns, N+1 |
| `api_contract_checker` | sonnet | review, ship, secure, mobile | Auth on all routes, Pydantic validation, pagination, CORS, rate limiting |

#### Phase 2 — Performance & Infrastructure

| Agent | Model | Squads | What It Audits |
|-------|-------|--------|---------------|
| `perf_profiler` | sonnet | audit, ship, mobile | Sync I/O in async, missing pagination, unthrottled concurrency |
| `mobile_auditor` | sonnet | mobile | AsyncStorage secrets, deep link abuse, EAS config hygiene |
| `cicd_auditor` | sonnet | secure, ship | GitHub Actions SHA pinning, systemd hardening, Caddy security headers |
| `docker_auditor` | sonnet | secure | Container privilege escalation, dangerous mounts, secrets in images |

#### Phase 3 — Design & Reliability

| Agent | Model | Squads | What It Audits |
|-------|-------|--------|---------------|
| `api_designer` | sonnet | audit, review, ship | REST naming, HTTP methods, status codes, pagination, error schema |
| `a11y_auditor` | sonnet | a11y, audit | WCAG 2.1 AA: contrast, keyboard nav, focus rings, ARIA, form labels |
| `incident_responder` | sonnet | incident, tools | Log anomalies, orchestrator health, auth patterns — always HITL |

---

### On-Demand Plugins (Install When Needed)

```bash
# Core stack plugins (high priority)
/plugin install python-development       # FastAPI async patterns, Python anti-patterns
/plugin install database-design          # PostgreSQL RLS, migration safety
/plugin install payment-processing       # Stripe webhook verification, PCI
/plugin install javascript-typescript    # Node.js async, TypeScript advanced types
/plugin install backend-api-security     # API auth patterns, rate limiting
/plugin install comprehensive-review     # Multi-arch review (opus-class agents)
/plugin install application-performance  # Performance optimization, observability

# When working on mobile
/plugin install react-native             # Expo/React Native specialist, EAS patterns

# When working on PRD / marketing
/plugin install startup-business-analyst # Market sizing, financial modeling
/plugin install content-marketing        # Blog posts, SEO strategy
```

**Not relevant to OPAI stack**: Blockchain, Rust/Go (unless client project), PHP/Ruby, game development, JVM languages, quantitative trading.

---

## Commands

```bash
# List all squads
./scripts/run_squad.sh --list

# Run a squad
./scripts/run_squad.sh -s audit
./scripts/run_squad.sh -s secure
./scripts/run_squad.sh -s plan

# Force re-run (ignore cached reports)
./scripts/run_squad.sh -s audit --force

# Run specific agents only
./scripts/run_agents_seq.sh --filter "accuracy,health"

# Auto-fix (safe mode)
./scripts/run_auto.sh --mode safe

# Builder
./scripts/run_builder.sh -t "Add dark mode to Monitor"
./scripts/run_builder.sh -t "Add feature" --dry-run
./scripts/run_builder.sh -t "Add feature" --context tools/opai-monitor
```

---

## Extending the Agent System

### Add a New Agent
1. Create `scripts/prompt_<name>.txt` with the agent's system prompt
2. Add entry to `team.json` under `agents`:
   ```json
   {
     "name": "my_agent",
     "category": "quality",
     "run_order": "parallel",
     "model": "sonnet",
     "max_turns": 8,
     "no_project_context": false,
     "prompt_file": "scripts/prompt_my_agent.txt"
   }
   ```
3. Add to one or more squad definitions in `team.json`
4. (Optional) Configure via Agent Studio UI

### Add a New Squad
1. Add entry to `squads` section in `team.json`:
   ```json
   "my_squad": {
     "agents": ["agent1", "agent2", "report_dispatcher"],
     "description": "What this squad does"
   }
   ```
2. Immediately runnable via `./scripts/run_squad.sh -s my_squad`
3. (Optional) Schedule in `config/orchestrator.json`

### Inject a New wshobson Skill (Path B)
1. Browse `mcps/wshobson-agents/` for relevant SKILL.md files
2. Extract the knowledge relevant to an existing agent
3. Append to the corresponding `scripts/prompt_<name>.txt`
4. Test via `./scripts/run_squad.sh -s <squad> --force`
