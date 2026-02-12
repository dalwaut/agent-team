# CLAUDE.md — OPAI Workspace Instructions

## What Is OPAI

OPAI (Obsidian Projects + Agent Intelligence) is the **master agentic workspace**. It is NOT a deployable application. It is the source framework containing:

1. The **Agent Team** multi-agent orchestration framework (v1.3.0)
2. An **Obsidian vault** with 30+ active software projects
3. AI agent context management (gemini-scribe)
4. IDE configuration (Cursor rules, quick references)
5. MCP server configs (Hostinger, Supabase)
6. n8n workflow library (100+ templates)
7. Research archives and client project folders

This workspace **manages other projects**. Do not treat it as a target codebase.

---

## Directory Map

| Path | Purpose |
|------|---------|
| `scripts/` | 6 PowerShell runners + 22 agent prompt files (`.txt`) |
| `workflows/` | Workflow docs: delegate-analysis, self-evolution, portability |
| `Templates/` | Specialist templates (Expo, Supabase, n8n) + project/agent/github templates |
| `Obsidian/Projects/` | 30+ active project folders using diamond workflow |
| `gemini-scribe/` | AI session management: AGENTS.md, Agent-Sessions/, Prompts/ |
| `Cursor/` | IDE rules (`1_RULES.txt`), quick reference, specialized rules |
| `mcps/` | MCP configs for Hostinger and Supabase |
| `Library/` | Knowledge base: n8n workflows (100+), Patterns/, Solutions/, References/, Stack/ |
| `Research/` | Topic research (GEO_Optimization, Lead Generation, Hostinger Migration, etc.) |
| `Agents/` | 3 legacy shell scripts (general-research, idea-verifier, project-initializer) |
| `Clients/` | Client project folders (Lace&Pearl, Westberg) |
| `Documents/` | Artistatlg documents |
| `Agent-Profiles/` | Agent capability profiles (reserved, currently empty) |
| `config/` | Global configuration (reserved, currently empty) |
| `logs/` | System-wide logs |
| `notes/` | Personal notes, credentials (`Access/`), dev references, inbox (`Review/`) |
| `tasks/` | Global task queues + `queue.json` deferred operations |
| `tools/` | File Structure.md, setup templates, email-checker, work-companion, discord-bridge, wp-agent |
| `reports/` | Agent reports: timestamped dirs, `latest/`, `HITL/` (human review), `Archive/` |

---

## Agent Team Framework

### Key Files

| File | Purpose |
|------|---------|
| `team.json` | Agent roster: 22 roles, 16 squads, 7 specialist templates (v1.3.0) |
| `scripts/run_squad.ps1` | Main entry point — run named squads from team.json |
| `scripts/preflight.ps1` | Environment validation (claude CLI, prompt files, directories) |
| `scripts/familiarize.ps1` | First-run project scanner (builds project_context.md) |
| `scripts/run_auto.ps1` | Auto-executor (safe/full modes) |
| `scripts/run_agents.ps1` | Run all agents in parallel |
| `scripts/run_agents_seq.ps1` | Run agents sequentially with `-Filter` |
| `setup.ps1` | Install framework into a target project as `.agent/` |
| `scripts/onboard_project.ps1` | Onboard external projects (or auto-queue if unavailable) |
| `scripts/process_queue.ps1` | Process deferred operations from `tasks/queue.json` |

### Agents (22 Roles)

| Agent | Category | Run Order | What It Does |
|-------|----------|-----------|-------------|
| `manager` | leadership | last | Reads all reports, builds prioritized implementation plan |
| `reviewer` | quality | parallel | Code quality, consistency, patterns, error handling |
| `accuracy` | quality | parallel | Calculations, data transforms, date/time logic |
| `health` | quality | parallel | Performance, dead code, unused deps, bundle size |
| `security` | quality | parallel | OWASP audit, auth, secrets, injection vectors |
| `features` | planning | parallel | Architecture plans for new features |
| `integration` | planning | parallel | Cross-project and third-party integration blueprints |
| `researcher` | research | parallel | Dependency health, tech radar, best practices |
| `github` | operations | parallel | Versioning, PRs, issues, releases, CI/CD, repo hygiene |
| `content_curator` | content | parallel | Changelogs, app store copy, social posts, SEO |
| `test_writer` | quality | parallel | Coverage gaps, test specs, scaffolding |
| `ux_reviewer` | quality | parallel | Loading/error/empty states, accessibility, consistency |
| `familiarizer` | meta | first | One-time scan: detect stack, customize all agents |
| `executor_safe` | execution | last | Auto-apply only non-breaking fixes |
| `executor_full` | execution | last | Auto-apply all improvements |
| `self_assessment` | meta | last | Detect team gaps, propose new agents |
| `notes_curator` | operations | parallel | Scans notes/, classifies files, proposes organization ops |
| `library_curator` | operations | parallel | Maintains Library/ knowledge base, indexes content, finds gaps |
| `report_dispatcher` | orchestration | last | Reads reports, extracts actions, generates agent instructions + HITL briefings |
| `project_onboarder` | operations | parallel | Discovers, evaluates, onboards external projects; queues when blocked |
| `workspace_steward` | operations | parallel | Structure compliance, file hygiene, naming conventions, archival |
| `email_manager` | operations | parallel | Email account health, task lists by sender, pending response drafts, queue export |

### Squads (16 Groups)

| Squad | Agents | Use Case |
|-------|--------|----------|
| `familiarize` | familiarizer | First-run onboarding |
| `audit` | accuracy, health, security, ux_reviewer, manager | Full codebase health check |
| `plan` | features, integration, researcher, manager | Feature planning |
| `review` | reviewer, accuracy, test_writer, github, manager | Post-change review |
| `ship` | health, security, test_writer, content_curator, github, manager | Pre-release checks |
| `release` | github, content_curator, test_writer, security, manager | Version bump + publish |
| `auto_safe` | accuracy, health, security, reviewer, executor_safe | Audit then auto-fix safe changes |
| `auto_full` | accuracy, health, security, reviewer, ux_reviewer, executor_full | Audit then auto-fix everything |
| `evolve` | self_assessment | Self-improvement: assess gaps, propose agents |
| `knowledge` | notes_curator, library_curator, report_dispatcher | Organize notes/ + Library/, then dispatch actions |
| `dispatch` | report_dispatcher | Process reports, generate instructions + HITL briefings |
| `onboard` | project_onboarder, report_dispatcher | Discover + onboard external projects |
| `hygiene` | workspace_steward, report_dispatcher | File cleanup, naming, structure compliance |
| `workspace` | notes_curator, library_curator, workspace_steward, report_dispatcher | Full workspace audit |
| `email` | email_manager, report_dispatcher | Email management: check accounts, extract tasks, review pending responses |

### Execution Model

1. Prompts are piped to `claude -p --output-format text` via temp files (no shell quoting issues)
2. **Parallel agents** run first (up to `max_parallel: 4` concurrent)
3. **"last" agents** (manager, executors, dispatcher) run sequentially after reports exist
4. Reports written as UTF-8 no BOM to `reports/<date>/` with `latest/` copy
5. All agents are **read-only** — stdout only, no file modifications

### Report Flow

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

- **`reports/<date>/`** — Timestamped reports from each squad run
- **`reports/latest/`** — Most recent copy of each report (dispatcher reads these)
- **`reports/HITL/`** — Items needing human decision (dispatcher writes these)
- **`reports/Archive/`** — Fully processed reports (human moves after review)

### Running Squads

```powershell
# List available squads
.\scripts\run_squad.ps1 -List

# Run a squad
.\scripts\run_squad.ps1 -Squad "audit"

# Skip preflight (use when running from OPAI root in framework-mode)
.\scripts\run_squad.ps1 -Squad "audit" -SkipPreflight

# Run specific agents only
.\scripts\run_agents_seq.ps1 -Filter "accuracy,health"

# Force re-run (ignore existing reports)
.\scripts\run_squad.ps1 -Squad "audit" -Force

# Self-evolution
.\scripts\run_squad.ps1 -Squad "evolve"

# Auto-fix (safe mode)
.\scripts\run_auto.ps1 -Mode safe

# Familiarize a target project
.\scripts\familiarize.ps1

# Onboard an external project
.\scripts\onboard_project.ps1 -Source "D:\path\to\project" -Name "ProjectName"

# Process deferred queue
.\scripts\process_queue.ps1
.\scripts\process_queue.ps1 -List
.\scripts\process_queue.ps1 -DryRun
```

### Deferred Operations Queue

When resources are unavailable (locked paths, missing drives, network issues), operations are automatically queued to `tasks/queue.json` instead of blocking. Key principle: **queue, don't block — document state and move on.**

| Command | What It Does |
|---------|-------------|
| `.\scripts\process_queue.ps1 -List` | Show all pending/blocked queue items |
| `.\scripts\process_queue.ps1` | Process all queued items |
| `.\scripts\process_queue.ps1 -DryRun` | Preview what would be processed |
| `.\scripts\process_queue.ps1 -Type "project-onboard"` | Process only onboarding tasks |
| `.\scripts\onboard_project.ps1 -ProcessQueue` | Process onboarding-specific queue |

Queue states: `queued` → `in_progress` → `completed` (or `blocked` → retry → `failed` after 3 attempts)

---

## Tech Stack (Across Projects)

| Technology | Usage |
|-----------|-------|
| Expo (React Native) | Mobile/web apps (iOS, Android, Web) |
| Vite | Fast prototyping |
| Supabase | Database, auth, storage, realtime |
| Stripe | Payments and subscriptions |
| n8n | Self-hosted automation and backend workflows |
| WordPress + Avada | Websites and plugins |
| Hostinger | Hosting (with MCP integration) |
| PowerShell | Agent framework scripts |
| TypeScript | Primary language across projects |

---

## Project Workflow Pattern (Diamond)

Projects under `Obsidian/Projects/` follow a standardized diamond layout:

```
Research → Dev-Plan → Tasks → Build → Logs/Notes
```

Each project folder contains:

| Subfolder | Purpose | Primary Writer |
|-----------|---------|---------------|
| `Research/` | Sources, findings | Research Agent |
| `Dev-Plan/` | Plan documents | Project Manager Agent |
| `Agent-Tasks/` | Work items (YAML) | Any agent |
| `Codebase/` | Actual code | Coding Agent |
| `Notes/` | Project notes | All agents |
| `Review-log/` | Review entries | Review Agent |
| `Debug-log/` | Debug traces | Debugging Agent |

---

## Key Conventions

1. **Plan-Act Methodology** — Research first, plan second, build third
2. **Template-Driven** — Use `Templates/` for new projects and agents
3. **Agent Safety** — All agents run read-only (`claude -p`, stdout only)
4. **Human Gate** — Self-assessment proposes changes, humans approve them
5. **UTF-8 No BOM** — Reports use `.NET UTF8Encoding($false)`
6. **Timestamped Reports** — `reports/<date>/` with `latest/` copy
7. **Conventional Commits** — `feat:`, `fix:`, `docs:`, `chore:`, etc.
8. **Branch Naming** — `feature/`, `bugfix/`, `hotfix/` prefixes
9. **Isolation** — Projects under `Obsidian/Projects/` are self-contained; agents respect boundaries
10. **Queue, Don't Block** — When resources are unavailable, document state to `tasks/queue.json` and move on

---

## Quick Reference Files

| What | Where |
|------|-------|
| Naming & structure conventions | `CONVENTIONS.md` |
| Framework documentation | `README.md` |
| Agent roster and squads | `team.json` |
| File structure guide | `tools/File Structure.md` |
| Cursor IDE rules | `Cursor/1_RULES.txt` |
| Tech stack quick reference | `Cursor/QUICK_REFERENCE.txt` |
| AI agent context | `gemini-scribe/AGENTS.md` |
| Delegation workflow | `workflows/delegate-analysis.md` |
| Self-evolution workflow | `workflows/self-evolution.md` |
| Project onboarding workflow | `workflows/project-onboarding.md` |
| Deferred operations queue | `tasks/queue.json` |
| File system evolution | `workflows/agentic-file-system-management.md` |
| Portability guide | `workflows/portability.md` |
| PPOD site todos | `Notes.md` |
| Useful commands | `Useful Commands.md` |
