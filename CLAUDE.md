# CLAUDE.md — OPAI Workspace Instructions

> **Design principle:** This file is kept minimal. Detailed docs live in `Library/opai-wiki/` — read them on demand, not upfront.

## What Is OPAI

OPAI (Orchestrated Projects + Agent Intelligence) is an **autonomous, self-managing agentic workspace** running on a dedicated VPS. It consolidates 22 tools under a unified **Engine** (port 8080) with a 13-worker Claude Code fleet, proactive heartbeat, memory consolidation, fleet coordination, and NFS-based external worker dispatch. It manages 38+ projects, business operations via HELM, and all internal infrastructure. Currently at **v3.5 "Felix"** — autonomous operations with internal workforce. Next: v4 "Open Doors" (revenue).

---

## Directory Map

| Path | Purpose |
|------|---------|
| `tools/` | 22 active OPAI tools + shared libraries (see Active Tools below) |
| `scripts/` | Agent runners, prompt files (80+), service control, utilities |
| `config/` | `orchestrator.json`, `workers.json`, `Caddyfile`, MCP profiles, service templates |
| `Library/opai-wiki/` | **System wiki** — 72 docs across core/tools/agents/integrations/infra/plans |
| `Library/knowledge/` | Reference library — **index at `Library/knowledge/REFERENCE-INDEX.md`** |
| `Library/helm-playbooks/` | Business playbook library for HELM autonomous operation |
| `Projects/` | 38 active project folders |
| `Templates/` | Project, agent, and stack templates |
| `tasks/` | Task registry + `queue.json` deferred ops + audit logs |
| `reports/` | Agent reports: `<date>/`, `latest/`, `HITL/`, `Archive/` |
| `notes/` | `daily/`, `ideas/`, `plans/`, `feedback/`, `personal/`, `drafts/`, `Archive/` |
| `logs/` | System-wide logs |

Other: `workflows/`, `mcps/`, `Clients/`, `Research/`, `Documents/`

---

## Active Tools

### Core Services

| Tool | Port | Purpose |
|------|------|---------|
| `opai-engine` | 8080 | **Unified Engine** — tasks, monitor, orchestrator, heartbeat, fleet, NFS, workers |
| `opai-portal` | 8090 | Public portal + dashboard + Pages Manager |
| `opai-team-hub` | 8082 | Task/project management (ClickUp-style, v3.5 backbone) |
| `opai-telegram` | 8110 | Primary comms — Telegram bridge + assistant mode |
| `opai-vault` | 8105 | Encrypted credential management |

### Tools & Agents

| Tool | Port | Purpose |
|------|------|---------|
| `opai-brain` | 8101 | 2nd Brain — knowledge graph + research |
| `opai-helm` | 8102 | Autonomous business runner |
| `opai-marq` | 8103 | App store publisher agent |
| `opai-dam` | 8104 | Do Anything Mode — meta-orchestrator |
| `opai-bx4` | 8100 | Business intelligence bot |
| `opai-prd` | — | PRD Pipeline — idea evaluation (PRDgent) |
| `opai-studio` | 8108 | AI image generation + editing suite |
| `opai-billing` | — | Stripe billing (v4 target) |
| `opai-users` | — | User management service |

### Integrations

| Tool | Port | Purpose |
|------|------|---------|
| `opai-wordpress` | 8096 | Multi-site WordPress management |
| `opai-email-agent` | 8093 | Multi-account email agent |
| `opai-browser` | 8107 | Browser automation via Playwright |
| `opai-files` | — | Sandboxed file manager |
| `opai-forumbot` | — | AI content generation for forums |
| `discord-bridge` | — | Discord bot → Claude CLI |
| `open-claw` | — | ClawBot container system (broker + runtime) |

### Other

| Tool | Purpose |
|------|---------|
| `opai-agent` | Standalone Claude Code desktop wrapper |
| `opai-dev` / `scc-ide` | OP IDE — browser-based + native desktop IDE |
| `opai-arl-tui` | TUI dashboard |
| `shared/` | Shared Python/JS libraries (`claude_api.py`, `auth.py`, etc.) |

---

## Deep-Dive Docs (read on demand)

| Topic | Wiki File |
|-------|-----------|
| **Wiki index (all 72 docs)** | `Library/opai-wiki/README.md` |
| Strategic roadmap (v2→v3→v4) | `Library/opai-wiki/plans/opai-evolution.md` |
| Engine (unified core) | `Library/opai-wiki/core/orchestrator.md` |
| Portal / Dashboard | `Library/opai-wiki/core/portal.md` |
| Auth & Network | `Library/opai-wiki/core/auth-network.md` |
| Services (systemd) | `Library/opai-wiki/core/services-systemd.md` |
| Team Hub | `Library/opai-wiki/tools/team-hub.md` |
| HELM | `Library/opai-wiki/tools/helm.md` |
| 2nd Brain | `Library/opai-wiki/tools/brain.md` |
| Studio | `Library/opai-wiki/tools/studio.md` |
| Vault | `Library/opai-wiki/infra/vault.md` |
| Heartbeat + Proactive Intelligence | `Library/opai-wiki/infra/heartbeat.md` |
| Fleet Coordinator & Action Items | `Library/opai-wiki/infra/fleet-action-items.md` |
| NFS Dispatcher (external workers) | `Library/opai-wiki/infra/nfs-dispatcher.md` |
| Meta-Assessment (2nd-order loop) | `Library/opai-wiki/infra/meta-assessment.md` |
| Scheduling Architecture | `Library/opai-wiki/infra/scheduling-architecture.md` |
| Agent Framework (43 roles, 27 squads) | `Library/opai-wiki/agents/agent-framework.md` |
| Telegram Bridge | `Library/opai-wiki/integrations/telegram-bridge.md` |
| Discord Bot | `Library/opai-wiki/integrations/discord-bridge.md` |
| Email Agent | `Library/opai-wiki/integrations/email-agent.md` |
| OP WordPress | `Library/opai-wiki/integrations/op-wordpress.md` |
| Browser Automation | `Library/opai-wiki/infra/browser-automation.md` |
| Feedback System | `Library/opai-wiki/infra/feedback-system.md` |
| Agent Feedback Loops | `Library/opai-wiki/infra/agent-feedback-loops.md` |
| Sandbox System | `Library/opai-wiki/infra/sandbox-system.md` |
| Billing / Stripe | `Library/opai-wiki/tools/billing.md` |
| Dev IDE (OP IDE) | `Library/opai-wiki/infra/dev-ide.md` |

---

## Quick Commands

```bash
# Service control (all OPAI services)
./scripts/opai-control.sh {start|stop|restart|status|logs}

# Run a squad
./scripts/run_squad.sh -s "audit"

# Builder: implement from inline task
./scripts/run_builder.sh -t "Add dark mode to Brain" --context tools/opai-brain

# Supabase SQL
./scripts/supabase-sql.sh "SELECT count(*) FROM profiles"
```

Full squad/agent command reference: `Library/opai-wiki/agents/agent-framework.md`

---

## Tech Stack

Python (Flask), Node.js, Supabase, Stripe, Caddy, systemd, Claude Code CLI, MCP, n8n (internal-only), Expo (React Native), Vite, WordPress + Avada

---

## Proactive Workflow Intelligence

**Core mindset: "What can I do now so Dallas doesn't have to ask me to do this again?"**

Observe patterns in our sessions and act on them — but be selective. Only automate or anticipate things that are **repetitive, nuanced, or easy to forget**. Do NOT try to automate everything.

**When to act proactively:**
- After editing a tool/service file → restart the service without being asked
- After making code changes → check if wiki docs need a corresponding update
- After fixing a bug → check if the same pattern exists elsewhere in the codebase
- When creating/modifying a file → update any related config, registry, or index that references it
- When a task touches multiple services → check dependent services for breakage
- After implementing a feature → note if tests, types, or env vars also need updating

**When NOT to act proactively:**
- Don't refactor code that wasn't part of the task
- Don't add features that weren't requested
- Don't auto-commit or push without being asked
- Don't "improve" working code you happen to read
- Don't create docs/files preemptively "just in case"

**Pattern memory:** When you notice Dallas repeatedly asking for the same follow-up step (e.g., "restart the service", "update the wiki", "check the logs"), internalize that as a pattern and start doing it automatically. Save confirmed patterns to `memory/MEMORY.md` so future sessions benefit.

**Human gate on workflow changes:** Proactive actions are limited to the **current task's scope** (e.g., restarting a service you just edited). Before making any **permanent addition or alteration to a workflow, convention, config, or process** — ask first. Propose the change, explain why, and wait for approval. One-off helpful actions are fine; baking something new into the system requires sign-off.

---

## Key Conventions

1. **Plan-Act Methodology** — Research first, plan second, build third
2. **Template-Driven** — Use `Templates/` for new projects and agents
3. **Agent Safety** — All agents run read-only (`claude -p`, stdout only)
4. **Human Gate** — Self-assessment proposes changes, humans approve them
5. **Conventional Commits** — `feat:`, `fix:`, `docs:`, `chore:`, etc.
6. **Branch Naming** — `feature/`, `bugfix/`, `hotfix/` prefixes
7. **Isolation** — Projects under `Projects/` are self-contained; agents respect boundaries
8. **Queue, Don't Block** — When resources unavailable, document to `tasks/queue.json` and move on
9. **n8n is internal-only** — licensing restriction, never offer to customers
10. **Wiki updates** — When user says "wiki" / "knowledgebase" → trigger full documentation sweep

---

## Anti-Slop Engineering

**Core belief:** Bad agent output is an engineering problem, not an LLM problem. The models are capable — quality comes from the guardrails, specs, and structure around them.

### Rules

1. **Never fix bad output** — If an agent produces slop, don't patch it. Diagnose the root cause (bad prompt? missing context? wrong scope?), fix the cause, and rerun from scratch. Dead code and band-aids compound.
2. **One agent, one task, one prompt** — A focused agent is a correct agent. Give each agent a single clear task with a single prompt. Don't overload scope.
3. **Specs leave no ambiguity** — Agent specs should include exact file paths, line numbers, code snippets, and explicit boundaries. Never let an agent infer your intent — spell it out.
4. **Blueprint before code** — For anything visual (UIs, dashboards, pages), create an ASCII wireframe first and iterate on it before writing implementation code. See `/blueprint` skill.
5. **Pit of success** — High-quality code in the codebase produces higher-quality agent output. Input tokens are effectively fine-tuning. Keep the codebase clean and agents will follow suit.
6. **Anti-mock testing** — Never mock what you can use for real. LLMs default to mocking everything — resist this. Tests should exercise actual code paths.
7. **Quality gates before handoff** — Before any agent hands work to the next agent (or to a human), all tests must pass, linting must pass, and the output must be verified. No slop propagation up the chain.
8. **Traceability** — Every agent action should be traceable: what agent, what changes, when, where. Reports and audit logs exist for this reason — use them.
9. **Hard blocks** — Agents should never `git push`, never write outside their scope, and scout/research agents should be read-only. Enforce via hooks and tool restrictions.
10. **An isolated agent is a safe agent** — Use worktrees or scoped file access to prevent agents from overwriting each other's work, especially in multi-agent runs.

---

## Quick Reference Files

| What | Where |
|------|-------|
| Conventions | `CONVENTIONS.md` |
| Agent roster + squads | `team.json` |
| **Reference library index** | **`Library/knowledge/REFERENCE-INDEX.md`** |
| Worker registry | `config/workers.json` |
| Orchestrator config | `config/orchestrator.json` |
| MCP catalog | `config/mcp-all.json` (11 servers, 4 profiles) |
| v2 progress log | `notes/v2/PROGRESS-LOG.md` |
