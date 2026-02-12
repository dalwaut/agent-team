# Agent Team v1.3.0

A multi-agent orchestration framework that runs a team of specialized [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents against any codebase. Each agent has a focused role — code reviewer, security analyst, feature architect — and produces a structured markdown report. A manager agent consolidates everything into a prioritized implementation plan.

The system can **assess its own gaps** and propose new agents via a self-evolution workflow.

---

## Quick Start

```powershell
# 1. Clone into your project as .agent/
git clone https://github.com/dalwaut/agent-team.git .agent

# 2. See available squads
.\.agent\scripts\run_squad.ps1 -List

# 3. Run a full codebase audit
.\.agent\scripts\run_squad.ps1 -Squad "audit"

# 4. Read the reports
ls .\.agent\reports\latest\
```

Or use the setup script to install into any project:

```powershell
git clone https://github.com/dalwaut/agent-team.git agent-team-src
.\agent-team-src\setup.ps1 -Target "C:\path\to\your\project"
```

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` in PATH)
- PowerShell 5.1+ (Windows) or PowerShell 7+ (cross-platform)
- Git (for the GitHub agent)
- `gh` CLI (optional, for GitHub operations)

---

## Architecture

```
.agent/
├── team.json                    # Agent roster (22 roles, 16 squads)
├── setup.ps1                    # Install framework into any project
├── scripts/
│   ├── preflight.ps1            # Environment validation
│   ├── run_squad.ps1            # Run a named squad from team.json
│   ├── run_agents.ps1           # Run all agents in parallel
│   ├── run_agents_seq.ps1       # Run all agents sequentially
│   ├── familiarize.ps1          # First-run project scanner
│   ├── onboard_project.ps1      # Onboard external projects
│   ├── process_queue.ps1        # Process deferred operations
│   └── prompt_*.txt             # 22 agent prompt files
├── workflows/
│   ├── delegate-analysis.md     # Main workflow documentation
│   ├── self-evolution.md        # How the system improves itself
│   ├── portability.md           # How to adapt for different projects
│   ├── project-onboarding.md    # External project onboarding
│   └── agentic-file-system-management.md
├── Templates/
│   ├── prompt_*.txt             # 7 specialist templates
│   ├── templates-projects/      # Project scaffolding templates
│   ├── templates-agents/        # Agent creation templates
│   └── templates-github/        # GitHub templates (PR, issue)
└── reports/
    ├── <date>/                  # Timestamped report directories
    └── latest/                  # Most recent run
```

---

## The Team — 22 Agents

All 22 agents ship with the framework. Use only the ones you need — activate agents by including them in your squad definitions in `team.json`.

### Core Quality Agents

| Agent | Role | What It Does |
|-------|------|-------------|
| `reviewer` | Code Reviewer | Quality, consistency, error handling, type safety |
| `accuracy` | Accuracy Auditor | Calculations, data transformations, date/time logic |
| `health` | Health Auditor | Performance, dead code, unused deps, bundle size |
| `security` | Security Analyst | OWASP audit, auth, secrets, injection vectors |
| `test_writer` | Test Engineer | Coverage gaps, test specs, scaffolding |
| `ux_reviewer` | UX Reviewer | Loading/error/empty states, accessibility, consistency |

### Planning Agents

| Agent | Role | What It Does |
|-------|------|-------------|
| `features` | Feature Architect | Architecture plans for new features |
| `integration` | Integration Architect | Cross-project and third-party integration blueprints |
| `researcher` | Tech Researcher | Dependency health, tech radar, best practices |

### Operations Agents

| Agent | Role | What It Does |
|-------|------|-------------|
| `github` | GitHub Ops Manager | Versioning, PRs, issues, releases, CI/CD, repo hygiene |
| `content_curator` | Content Curator | Changelogs, app store copy, social posts, SEO |
| `notes_curator` | Notes Curator | Scans notes/, classifies files, proposes organization |
| `library_curator` | Library Curator | Maintains knowledge base, indexes content, finds gaps |
| `project_onboarder` | Project Onboarder | Discovers and onboards external projects; queues when blocked |
| `workspace_steward` | Workspace Steward | Structure compliance, file hygiene, naming conventions |
| `email_manager` | Email Manager | Email triage, task extraction, response draft tracking |

### Leadership & Orchestration

| Agent | Role | What It Does |
|-------|------|-------------|
| `manager` | Project Manager | Reads all reports, builds prioritized implementation plan |
| `report_dispatcher` | Report Dispatcher | Extracts actions from reports, generates agent instructions + HITL briefings |

### Execution Agents

| Agent | Role | What It Does |
|-------|------|-------------|
| `executor_safe` | Executor (Safe) | Auto-apply only non-breaking fixes |
| `executor_full` | Executor (Full) | Auto-apply all improvements including structural changes |

### Meta Agents

| Agent | Role | What It Does |
|-------|------|-------------|
| `familiarizer` | Project Familiarizer | One-time scan: detects stack, customizes all agents |
| `self_assessment` | Self-Assessment | Detects team gaps, proposes new agents |

### Specialist Templates (7)

Found in `Templates/`. Copy into `scripts/` and add to `team.json` to activate:

| Template | For Projects Using |
|----------|-------------------|
| `prompt_expo_expert.txt` | Expo / React Native |
| `prompt_supabase_expert.txt` | Supabase |
| `prompt_n8n_connector.txt` | n8n automation |
| `prompt_wordpress_expert.txt` | WordPress / WooCommerce |
| `prompt_fusion_builder.txt` | Avada Fusion Builder |
| `prompt_page_designer.txt` | Page layout design |
| `prompt_design_reviewer.txt` | Design quality review |

---

## Squads — 16 Presets

Squads group agents into task-specific teams. Run any squad with `run_squad.ps1 -Squad "<name>"`.

### Codebase Squads

| Squad | Agents | Use Case |
|-------|--------|----------|
| `familiarize` | familiarizer | First-run onboarding — detects stack, generates project_context.md |
| `audit` | accuracy, health, security, ux_reviewer, manager | Full codebase health check |
| `plan` | features, integration, researcher, manager | Feature planning and architecture |
| `review` | reviewer, accuracy, test_writer, github, manager | Post-change code review |
| `ship` | health, security, test_writer, content_curator, github, manager | Pre-release checks |
| `release` | github, content_curator, test_writer, security, manager | Version bump + publish |

### Automation Squads

| Squad | Agents | Use Case |
|-------|--------|----------|
| `auto_safe` | accuracy, health, security, reviewer, executor_safe | Audit then auto-fix safe changes only |
| `auto_full` | accuracy, health, security, reviewer, ux_reviewer, executor_full | Audit then auto-fix everything |

### Workspace Squads

| Squad | Agents | Use Case |
|-------|--------|----------|
| `knowledge` | notes_curator, library_curator, report_dispatcher | Organize notes + library |
| `dispatch` | report_dispatcher | Process reports into instructions + HITL briefings |
| `onboard` | project_onboarder, report_dispatcher | Discover + onboard external projects |
| `hygiene` | workspace_steward, report_dispatcher | File cleanup, naming, compliance |
| `workspace` | notes_curator, library_curator, workspace_steward, report_dispatcher | Full workspace audit |
| `email` | email_manager, report_dispatcher | Email triage + task extraction |

### Meta Squads

| Squad | Agents | Use Case |
|-------|--------|----------|
| `evolve` | self_assessment | Self-improvement: assess gaps, propose new agents |

---

## Usage

```powershell
# List squads
.\.agent\scripts\run_squad.ps1 -List

# Run a squad
.\.agent\scripts\run_squad.ps1 -Squad "audit"

# Skip preflight checks
.\.agent\scripts\run_squad.ps1 -Squad "audit" -SkipPreflight

# Run specific agents only
.\.agent\scripts\run_agents_seq.ps1 -Filter "accuracy,health"

# Force re-run (ignore existing reports)
.\.agent\scripts\run_squad.ps1 -Squad "audit" -Force

# Limit concurrency
.\.agent\scripts\run_squad.ps1 -Squad "audit" -MaxParallel 2

# Auto-fix (safe mode)
.\.agent\scripts\run_auto.ps1 -Mode safe

# Self-evolution
.\.agent\scripts\run_squad.ps1 -Squad "evolve"

# Onboard an external project
.\.agent\scripts\onboard_project.ps1 -Source "C:\path\to\project" -Name "MyProject"

# Process deferred queue
.\.agent\scripts\process_queue.ps1
.\.agent\scripts\process_queue.ps1 -List
```

---

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

---

## Self-Evolution

```powershell
.\.agent\scripts\run_squad.ps1 -Squad "evolve"
```

The `self_assessment` meta-agent reads the entire framework and outputs:
- Coverage gap analysis
- Prompt quality scores
- Complete new agent specs with ready-to-use prompt text
- Workflow improvement suggestions

**A human must review and approve** before changes are applied. See [self-evolution.md](workflows/self-evolution.md).

---

## How It Works

1. Prompts are piped via temp files (not CLI args) to avoid shell quoting issues
2. Reports are UTF-8 no BOM via .NET `UTF8Encoding($false)`
3. Parallel agents run first (up to `max_parallel: 4`), then `run_order: "last"` agents
4. Reports are timestamped (`reports/YYYY-MM-DD/`) with a `latest/` copy
5. All agents are read-only — `claude -p` pipe mode, stdout only

---

## Adding a Specialist

```powershell
# 1. Copy a template
cp .agent\Templates\prompt_expo_expert.txt .agent\scripts\prompt_expo_expert.txt

# 2. Edit to match your project

# 3. Add to team.json roles + squads

# 4. Test
.\.agent\scripts\run_agents_seq.ps1 -Filter "expo_expert"
```

---

## Deferred Operations Queue

When resources are unavailable (locked paths, missing drives, network issues), operations are automatically queued instead of blocking. Key principle: **queue, don't block — document state and move on.**

```powershell
.\scripts\process_queue.ps1 -List      # Show pending items
.\scripts\process_queue.ps1             # Process all queued items
.\scripts\process_queue.ps1 -DryRun    # Preview what would be processed
```

---

## Customization

### Activating Optional Agents

Not every project needs all 22 agents. To activate an agent:

1. Ensure its prompt file exists in `scripts/` (all 22 ship by default)
2. Add it to a squad in `team.json` under `squads`
3. Or create a custom squad with just the agents you need

### Creating Custom Squads

Add to the `squads` object in `team.json`:

```json
{
  "my_squad": {
    "agents": ["reviewer", "security", "manager"],
    "description": "Quick security-focused review"
  }
}
```

### Creating New Agents

Use the templates in `Templates/templates-agents/`:

1. Copy the agent prompt template
2. Write the prompt following existing patterns
3. Add the role to `team.json`
4. Add to relevant squads

---

## License

MIT
