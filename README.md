# OPAI — Orchestrated Projects + Agent Intelligence

An autonomous, self-managing infrastructure that runs a fleet of AI agents, manages 38+ projects, and operates business tools — all from a single VPS. Built on Claude Code CLI with a 13-worker fleet, proactive heartbeat, memory consolidation, and fleet coordination.

> **Current version:** v3.5 "Felix" — autonomous operations with internal workforce
>
> **Branches:** `main` (generic agent framework), `OPAI.v3` (full autonomous workspace)

---

## Architecture

```
OPAI Server (BB VPS) — Caddy reverse proxy → opai.boutabyte.com
│
├── Engine (port 8080)          ← Unified core: tasks, monitor, orchestrator,
│   ├── Heartbeat (30-min)        heartbeat, fleet coordinator, NFS dispatcher,
│   ├── Fleet Coordinator         proactive intelligence, worker management
│   ├── NFS Dispatcher
│   └── Memory Consolidator
│
├── Portal (8081)               ← Dashboard + Pages Manager
├── Team Hub (8082)             ← Project/task management (ClickUp-style)
├── Telegram (8110)             ← Primary comms + assistant mode
├── Vault (8105)                ← Encrypted credential store
│
├── Tools                       ← Brain, HELM, Marq, DAM, BX4, PRD, Billing
├── Integrations                ← WordPress, Email, Browser, Discord, OpenClaw
└── Workers (13)                ← Claude Code CLI agents (reviewers, builders, etc.)
```

---

## Quick Start

```bash
# Service control
./scripts/opai-control.sh {start|stop|restart|status|logs}

# Run an agent squad
./scripts/run_squad.sh -s "audit"

# Builder: implement a task
./scripts/run_builder.sh -t "Add feature X" --context tools/opai-brain

# Supabase SQL
./scripts/supabase-sql.sh "SELECT count(*) FROM profiles"
```

---

## Services (22 active tools)

### Core
| Service | Port | Role |
|---------|------|------|
| opai-engine | 8080 | Unified Engine — tasks, monitoring, orchestration, heartbeat, fleet |
| opai-portal | 8081 | Public portal + dashboard |
| opai-team-hub | 8082 | Task/project management |
| opai-telegram | 8110 | Telegram bridge + assistant |
| opai-vault | 8105 | Credential management |

### Tools & Agents
| Service | Port | Role |
|---------|------|------|
| opai-brain | 8101 | Knowledge graph + research |
| opai-helm | 8102 | Autonomous business runner |
| opai-marq | 8103 | App store publisher |
| opai-dam | 8104 | Do Anything Mode |
| opai-bx4 | 8100 | Business intelligence |
| opai-prd | — | PRD Pipeline (idea eval) |
| opai-billing | — | Stripe billing (v4) |
| opai-users | — | User management |

### Integrations
| Service | Port | Role |
|---------|------|------|
| opai-wordpress | 8096 | Multi-site WordPress |
| opai-email-agent | 8093 | Multi-account email |
| opai-browser | 8107 | Playwright automation |
| discord-bridge | — | Discord → Claude CLI |
| open-claw | — | ClawBot containers |
| opai-files | — | Sandboxed file manager |
| opai-forumbot | — | AI content generation |

### Dev Tools
| Service | Role |
|---------|------|
| opai-dev / scc-ide | OP IDE (browser + native) |
| opai-agent | Standalone Claude Code wrapper |
| opai-arl-tui | TUI dashboard |

---

## Agent Framework

**42 agent roles** organized into **26 squads** with specialized prompts. All agents run read-only via `claude -p` (pipe mode, stdout only).

### Worker Fleet (13 registered)

| Worker | Type | Role |
|--------|------|------|
| email-manager | Long-running | Email polling + triage |
| discord-bot | Long-running | Discord event handling |
| wordpress-manager | Hybrid | WordPress site management |
| project-reviewer | Task | Code review |
| project-builder | Task | Implementation |
| researcher | Task | Research + analysis |
| wiki-librarian | Task | Wiki maintenance (daily 4am) |
| self-assessor | Task | System self-assessment (daily 2am) |
| security-scanner | Task | Security audit (weekly) |
| report-dispatcher | Task | Report → action items |
| browser-agent | Task | Browser automation |
| context-harvester | Task | Context extraction (every 4h) |
| project-lead | Task | Delegation-capable lead |

### Key Squads

| Squad | Use Case |
|-------|----------|
| `audit` | Full codebase health check |
| `plan` | Feature planning |
| `review` | Post-change review |
| `ship` | Pre-release checks |
| `auto_safe` | Audit + auto-fix safe changes |
| `knowledge` | Notes + library organization |
| `evolve` | Self-improvement assessment |

Full reference: `Library/opai-wiki/agents/agent-framework.md`

---

## v3.5 "Felix" — What's Shipped

| Phase | Feature | Status |
|-------|---------|--------|
| 3.0 | Proactive Heartbeat — 30-min loop, stall detection, Telegram alerts | Shipped |
| 3.1 | Memory Consolidation — nightly wiki updates from activity | Shipped |
| 3.2 | Authenticated Command Channels — trust levels per channel | Shipped |
| 3.3 | Bottleneck Removal Engine — approval pattern detection | Shipped |
| 3.4 | HELM Activation — 1 real business target | In Progress |
| 3.5 | Native CC Workforce — fleet coordinator, workspace isolation | Shipped |
| 3.6 | Cross-System Intelligence — connect dots across tools | Planned |

**Next:** v4 "Open Doors" — revenue via HELM businesses, agency services, ClawBot beta.

Full roadmap: `Library/opai-wiki/plans/opai-evolution.md`

---

## Tech Stack

Python (Flask), Node.js, Supabase (Postgres + Auth + RLS), Stripe, Caddy, systemd, Claude Code CLI, MCP (11 servers), n8n (internal-only), Expo (React Native), Vite, WordPress + Avada

---

## Documentation

| Resource | Location |
|----------|----------|
| System wiki (71 docs) | `Library/opai-wiki/` |
| Reference library | `Library/knowledge/REFERENCE-INDEX.md` |
| HELM playbooks | `Library/helm-playbooks/` |
| Agent instructions | `CLAUDE.md` |
| Worker registry | `config/workers.json` |
| Orchestrator config | `config/orchestrator.json` |
| MCP catalog | `config/mcp-all.json` |
| v2 progress log | `notes/v2/PROGRESS-LOG.md` |

---

## License

MIT
