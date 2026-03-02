# CLAUDE.md — OPAI Workspace Instructions

> **Design principle:** This file is kept minimal. Detailed docs live in `Library/opai-wiki/` — read them on demand, not upfront.

## What Is OPAI

OPAI (Orchestrated Projects + Agent Intelligence) is the **master agentic workspace**. It is NOT a deployable application. It manages other projects via a multi-agent orchestration framework (v1.3.0), an Obsidian vault with 30+ active projects, n8n workflows, MCP configs, and research archives.

---

## Directory Map (compact)

| Path | Purpose |
|------|---------|
| `scripts/` | Agent runners + 25 prompt files (`.txt`) |
| `tools/` | OPAI Server tools (orchestrator, monitor, tasks, portal, etc.) |
| `Library/opai-wiki/` | **System wiki** — architecture docs for all internal tools |
| `Projects/` | 30+ active project folders (diamond workflow) |
| `Templates/` | Project, agent, and stack templates |
| `tasks/` | Global task registry + `queue.json` deferred ops |
| `reports/` | Agent reports: `<date>/`, `latest/`, `HITL/`, `Archive/` |
| `config/` | Global config (`orchestrator.json`, etc.) |
| `notes/` | Organized notes: `daily/`, `ideas/`, `plans/`, `feedback/`, `personal/`, `drafts/`, `Archive/` |
| `Library/knowledge/` | Structured reference — **index at `Library/knowledge/REFERENCE-INDEX.md`** (read on demand, not upfront) |
| `Library/helm-playbooks/` | **Business playbook library** — validated revenue models HELM can autonomously research, plan, build, and operate |
| `logs/` | System-wide logs |

Other: `workflows/`, `Cursor/`, `mcps/`, `gemini-scribe/`, `Clients/`, `Research/`, `Documents/`

---

## Deep-Dive Docs (read on demand)

| Topic | Wiki File |
|-------|-----------|
| Agent Framework (42 roles, 26 squads, execution model) | `Library/opai-wiki/agents/agent-framework.md` |
| Agent Orchestra | `Library/opai-wiki/agents/agent-orchestra.md` |
| Agent Studio | `Library/opai-wiki/agents/agent-studio.md` |
| Discord Bot | `Library/opai-wiki/integrations/discord-bridge.md` |
| Telegram Bridge | `Library/opai-wiki/integrations/telegram-bridge.md` |
| Services (systemd) | `Library/opai-wiki/core/services-systemd.md` |
| Orchestrator | `Library/opai-wiki/core/orchestrator.md` |
| Auth & Network | `Library/opai-wiki/core/auth-network.md` |
| Portal / Dashboard | `Library/opai-wiki/core/portal.md` |
| Monitor | `Library/opai-wiki/infra/monitor.md` |
| Feedback System | `Library/opai-wiki/infra/feedback-system.md` |
| Sandbox System | `Library/opai-wiki/infra/sandbox-system.md` |
| Usage Throttling | `Library/opai-wiki/infra/usage-throttling.md` |
| User Controls | `Library/opai-wiki/infra/user-controls.md` |
| Vault | `Library/opai-wiki/infra/vault.md` |
| Browser Automation | `Library/opai-wiki/infra/browser-automation.md` |
| Heartbeat (v3.5) + Proactive Intelligence | `Library/opai-wiki/infra/heartbeat.md` |
| Fleet Coordinator & Action Items (v3.5) | `Library/opai-wiki/infra/fleet-action-items.md` |
| NFS Drop-Folder Dispatcher (v3.5) | `Library/opai-wiki/infra/nfs-dispatcher.md` |
| Headless Display | `Library/opai-wiki/infra/headless-display.md` |
| Task Control Panel | `Library/opai-wiki/tools/task-control-panel.md` |
| Billing / Stripe | `Library/opai-wiki/tools/billing.md` |
| Dev IDE (OP IDE) | `Library/opai-wiki/infra/dev-ide.md` |
| Marketplace | `Library/opai-wiki/tools/marketplace.md` |
| Team Hub | `Library/opai-wiki/tools/team-hub.md` |
| 2nd Brain | `Library/opai-wiki/tools/brain.md` |
| HELM | `Library/opai-wiki/tools/helm.md` |
| Docs Portal | `Library/opai-wiki/tools/docs.md` |
| Forum Bot | `Library/opai-wiki/integrations/forumbot.md` |
| OP WordPress | `Library/opai-wiki/integrations/op-wordpress.md` |
| Email Agent | `Library/opai-wiki/integrations/email-agent.md` |
| TUI Dashboard | `Library/opai-wiki/tools/tui-dashboard.md` |
| Wiki index (all topics) | `Library/opai-wiki/README.md` |

---

## Quick Commands

```bash
# Service control (all OPAI services)
./scripts/opai-control.sh {start|stop|restart|status|logs}

# Run a squad
./scripts/run_squad.sh -s "audit"

# Builder: implement from inline task
./scripts/run_builder.sh -t "Add dark mode to Monitor" --context tools/opai-monitor

# Supabase SQL
./scripts/supabase-sql.sh "SELECT count(*) FROM profiles"
```

Full squad/agent command reference: `Library/opai-wiki/agents/agent-framework.md`

---

## Tech Stack

Expo (React Native), Vite, Supabase, Stripe, n8n, WordPress + Avada, Hostinger, PowerShell, TypeScript

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

## Quick Reference Files

| What | Where |
|------|-------|
| Conventions | `CONVENTIONS.md` |
| Framework docs | `README.md` |
| Agent roster + squads | `team.json` |
| **Reference library index** | **`Library/knowledge/REFERENCE-INDEX.md`** — lookup for all how-tos, guides, API refs, external tool docs. Read this FIRST when asked about a reference topic. |
| Cursor IDE rules | `Cursor/1_RULES.txt` |
| Tech stack reference | `Cursor/QUICK_REFERENCE.txt` |
| Useful commands | `Useful Commands.md` |
