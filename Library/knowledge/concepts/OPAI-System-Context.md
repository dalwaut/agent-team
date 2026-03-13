# OPAI — System Context Document
> For AI assistants and professionals onboarding to the OPAI platform.
> Last updated: 2026-02-20

---

## What Is OPAI?

**OPAI (Orchestrated Projects + Agent Intelligence)** is a private, self-hosted, multi-agent AI operations platform. It is the administrative backbone for managing 30+ active projects, coordinating AI agents, hosting internal tools, and serving a growing user base via a SaaS model.

OPAI is **not a deployable app product** — it is the platform *that builds and manages* other products. Think of it as the mission control center: an Obsidian-style project vault, an AI agent orchestra, a suite of self-hosted web tools, and a full SaaS billing/auth stack all unified under one domain.

**Public entry point**: `https://opai.boutabyte.com`
**Infrastructure**: Hostinger KVM4 VPS (`72.60.115.74`), Synology NAS (NFS sandboxes), Tailscale VPN, Supabase cloud auth + DB, Caddy reverse proxy.

---

## The Musical Framework (Brand Metaphor)

OPAI's agent system is described through a **symphony metaphor**:

| Music Term | OPAI Equivalent |
|------------|-----------------|
| Composer | Creators (Dallas, team) — write prompts, configs |
| Score | Prompt files, squad definitions, workflows |
| Conductor | Orchestrator daemon — schedules, routes, cues |
| Players | Agents — AI specialists on their instruments |
| Ensemble | Squad — a defined group of agents for a specific purpose |
| Rehearsal | Dry run / safe mode |
| Performance | Reports — what you evaluate |
| HITL Gate | Human review before applying changes |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│  opai.boutabyte.com  (BB VPS Caddy → Tailscale)      │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  OPAI Server (Linux VPS, systemd services)   │   │
│  │                                              │   │
│  │  Orchestrator ─── schedules, routes, HITL   │   │
│  │  Agent Framework ── Claude CLI squads        │   │
│  │  25+ internal tools (web UIs + APIs)         │   │
│  │  Discord Bot ── admin commands via Discord   │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌─────────────────┐   ┌─────────────────────────┐  │
│  │  Supabase Cloud │   │  NAS (NFS Sandboxes)    │  │
│  │  Auth + DB      │   │  /workspace/users/*/    │  │
│  └─────────────────┘   └─────────────────────────┘  │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  Mobile App (Expo / React Native)                    │
│  iOS + Android + Web — admin companion               │
│  Connects via REST + WebSocket to opai.boutabyte.com │
└──────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile | Expo ~54 / React Native 0.81, TypeScript, Zustand 5, Expo Router 6 |
| Web Frontend | Vite, vanilla JS/HTML for most tool UIs |
| Backend / APIs | Python (FastAPI), Node.js |
| Auth | Supabase (ES256 JWT), RLS policies, role-based (`admin`, `user`) |
| Database | Supabase PostgreSQL |
| Hosting | Hostinger KVM4 VPS, Caddy reverse proxy |
| Tunnel/VPN | Tailscale |
| CMS | WordPress + Avada (managed via OPAI WordPress tool) |
| Automation | n8n (internal-only, Docker on BB VPS) |
| AI | Claude Code CLI (Anthropic), Gemini Flash |
| Storage | NFS-mounted NAS for user sandboxes |
| Services | 25 systemd user services + 4 timers |

---

## Core Systems

### 1. Agent Framework (`scripts/`, `team.json`)

The heart of OPAI. 42 named agent roles organized into 26 squads. Agents run as `claude -p` (Claude Code CLI, non-interactive, stdout only). Most are **read-only** — they analyze and produce markdown reports. The **builder** agent is the exception and can write to the codebase.

**Key files**:
- `team.json` — roster of all 42 agents + 26 squad definitions
- `scripts/run_squad.sh` — main runner: resolve squad → spawn parallel agents → collect reports
- `scripts/prompt_*.txt` — individual agent prompts (one `.txt` per role)
- `reports/latest/` — most recent report from each agent
- `reports/HITL/` — items requiring human decision

**Execution model**:
1. Phase 1: Up to 4 agents run in parallel
2. Phase 2: Sequential agents run last (e.g., `manager`, `report_dispatcher`)
3. Reports written to `reports/<date>/` and copied to `reports/latest/`
4. Dispatcher classifies actions → HITL briefings for human approval

**Per-agent tuning** (via `team.json`):
- `model`: `haiku` / `sonnet` / `opus` (or inherit from global config)
- `max_turns`: cap agentic turns to save tokens
- `no_project_context`: skip loading CLAUDE.md + MEMORY.md (~3,500 token save)

**Sample squads**:
- `audit` — full codebase health check (accuracy, health, security, UX, DB, perf)
- `plan` — feature planning with security threat modeling
- `ship` — pre-release gate
- `secure` — full weekly security sweep
- `build` — single builder agent implements a task spec
- `incident` — log anomaly detection, runs every 4h

### 2. Orchestrator (`tools/opai-orchestrator/index.js`)

Node.js daemon. The conductor. Runs as `opai-orchestrator` systemd service.

**Responsibilities**:
- Cron scheduling (cron strings in `config/orchestrator.json`)
- Service health monitoring + auto-restart every 5 min
- Resource-aware task deferral (CPU > 80%, memory > 85%)
- Task registry processing every 15 min
- HITL briefing generation (writes to `reports/HITL/`)
- Feedback processing every 5 min (classify → auto-create tasks)
- User sandbox scanning every 5 min

**Default schedules**:
- Email check: every 30 min
- Knowledge sync: daily 6 PM
- Workspace audit: Monday 9 AM
- Incident squad: every 4h

### 3. Web Tools (`tools/`)

25 systemd-managed services. Each tool is a self-contained FastAPI or Node app with its own static frontend.

| Tool | Path | Purpose |
|------|------|---------|
| Portal | `tools/opai-portal/` | Auth dashboard, 21 admin tiles, Pages Manager |
| Chat | `tools/opai-chat/` | AI chat (Claude + Gemini), Mozart Mode, WebSocket streaming |
| Monitor | `tools/opai-monitor/` | Health dashboard, metrics, Claude usage, logs |
| Tasks / TCP | `tools/opai-tasks/` | Task Control Panel: My Queue (HITL), Feedback, Audit tab |
| Team Hub | `tools/opai-teamhub/` | ClickUp-style project/task management |
| Agent Studio | `tools/opai-agents/` | Visual agent editor, squad builder, scheduler |
| WordPress | `tools/opai-wordpress/` | Multi-site WP management (ManageWP replacement) |
| Email Agent | `tools/email-agent/` | Autonomous inbox manager |
| Billing | `tools/opai-billing/` | Stripe subscriptions, dual-Supabase, landing page |
| Files | `tools/opai-files/` | Sandboxed file manager with wikilinks + knowledge graph |
| Discord Bridge | `tools/discord-bridge/` | Discord ↔ Claude CLI bot |
| OP IDE | Theia-based | Browser IDE with per-project workspaces |
| Docs Portal | `tools/opai-docs/` | Auto-updating docs from wiki files |
| Forum | `tools/opai-forum/` | Reddit-style dev forum |
| Messenger | `tools/opai-messenger/` | Internal DMs + groups |
| Marketplace | `tools/opai-marketplace/` | BoutaByte catalog + tier-based access |
| Orchestrator | `tools/opai-orchestrator/` | Central daemon (described above) |

### 4. Mobile App (`Projects/OPAI Mobile App/opai-mobile/`)

Expo / React Native admin companion. iOS + Android + Web.

**5 tabs**: Home, Tasks, Chat, Monitor, Command (admin-gated)
**6 Zustand stores**: auth, dashboard, chat, tasks, command, monitor
**Auth**: Supabase JWT → `expo-secure-store` → auto-refresh on 401
**Chat**: WebSocket streaming at `wss://opai.boutabyte.com/ws/chat`
**Tasks**: Hierarchical navigation — Spaces → Folders → Lists → Items

### 5. Authentication & Access

- **Supabase auth** with ES256 JWT, role-based (`admin` / `user`)
- **RLS** enforced via `get_my_role()` SECURITY DEFINER function (prevents recursion)
- **Caddy** reverse proxy at BB VPS routes public traffic to OPAI Server via Tailscale
- **AI lock** — optional security mode blocking all AI tools for a user
- **Sandboxes** — NFS-mounted per-user isolated workspace at `/workspace/users/<id>/`

### 6. Knowledge System (`Library/opai-wiki/`)

Two-tier documentation:
1. `MEMORY.md` — slim index, always loaded into Claude Code context
2. `Library/opai-wiki/*.md` — 23+ detailed system docs, read on demand

Wiki maintained by `wiki_librarian` agent (part of `wiki` and `knowledge` squads). Auto-updates triggered by running the `wiki` squad after system changes.

### 7. Feedback System

In-app feedback → classified by `feedback_processor` (every 5 min) → HIGH/MEDIUM items become tasks (every 15 min) → `feedback_fixer` agent implements targeted fixes → restart service → broadcast `system_update` via Supabase Realtime (shows refresh banner) → mark implemented → log to improvements log.

---

## Workflow: From Idea to Deployment

```
1. Idea captured → PRD Pipeline (PRDgent agent scores idea)
2. Approved → Project scaffold created in Projects/<slug>/
3. Feature planned → `plan` squad (features + researcher + threat_modeler + manager)
4. Implementation → Builder agent or manual development
5. Review → `review` or `audit` squad
6. Pre-release → `ship` squad (security + tests + content)
7. Deploy → restart systemd service / EAS build for mobile
8. Monitor → `incident` squad every 4h, Monitor dashboard
9. Feedback → feedback-to-fix loop (described above)
```

---

## Extensibility Points

### Adding New Agents
1. Add role entry to `team.json` (name, category, run_order, model, max_turns, prompt file path)
2. Create `scripts/prompt_<name>.txt`
3. Add to one or more squad definitions in `team.json`
4. Optionally add to Agent Studio UI squad builder

### Adding New Tools
1. Create `tools/opai-<name>/` directory with app + static frontend
2. Add systemd service file (`~/.config/systemd/user/opai-<name>.service`)
3. Add Caddy route in OPAI Server Caddyfile
4. Register in Portal dashboard tiles
5. Add to Monitor service list
6. Document in `Library/opai-wiki/<name>.md`

### Adding New Squads
1. Add entry to `squads` section in `team.json` with agent list
2. Squads are immediately available via `run_squad.sh -s <name>`
3. Can be scheduled in `config/orchestrator.json`

### wshobson Plugin Agents
OPAI integrates a 72-plugin marketplace via the wshobson Agents system. Currently 3 plugin groups installed:
- `agent-teams` — multi-reviewer reviews, parallel debugging, feature dev coordination
- `security-scanning` — SAST, STRIDE, attack trees, threat mitigation
- `full-stack-orchestration` — end-to-end feature development orchestration

These inject as Claude Code skills (slash commands) and as 12 new batch agents across 3 phases (security, infra, design). See `Library/opai-wiki/wshobson-agents.md` for the full reference.

### Mobile App Extension
- Add new screen → create file under `app/(tabs)/` (file-based routing via Expo Router)
- Add new tab → update `app/(tabs)/_layout.tsx`
- Add new store → create Zustand store in `stores/`, add types to `types/api.ts`
- Add API endpoint → update `constants/config.ts` + call via `lib/api.ts`

---

## Key Configuration Files

| File | Purpose |
|------|---------|
| `team.json` | Agent roster (42 roles), squad definitions (26 squads) |
| `config/orchestrator.json` | Schedules, resource limits, task processor settings |
| `CLAUDE.md` | Claude Code project instructions (workspace-wide) |
| `~/.claude/projects/.../memory/MEMORY.md` | Persistent AI memory index |
| `Library/opai-wiki/*.md` | 23+ detailed system architecture docs |

---

## Key Conventions

1. **Plan-Act** — Research → Plan → Build (never skip planning)
2. **Agent Safety** — Agents are read-only by default (`claude -p`, stdout only)
3. **Human Gate (HITL)** — Non-trivial changes require human approval via Task Control Panel
4. **Queue, Don't Block** — When resources unavailable, write to `tasks/queue.json` and move on
5. **Conventional Commits** — `feat:`, `fix:`, `docs:`, `chore:`, etc.
6. **n8n is internal-only** — Licensing restriction; never offered to customers
7. **Wiki updates** — Run `wiki` squad after any significant system change
8. **Token optimization** — Use `haiku` for simple agents, `no_project_context` where workspace context not needed

---

## Control Commands

```bash
# Service control (all 25 OPAI services)
./scripts/opai-control.sh {start|stop|restart|status|logs}

# Run an agent squad
./scripts/run_squad.sh -s "audit"
./scripts/run_squad.sh -s "secure"
./scripts/run_squad.sh --list          # see all 26 squads

# Builder agent (implement a feature)
./scripts/run_builder.sh -t "Add dark mode to Monitor"
./scripts/run_builder.sh specs/my-spec.md --dry-run

# Supabase SQL
./scripts/supabase-sql.sh "SELECT count(*) FROM profiles"
```

---

## Areas for New Feature Design

When designing new features, consider:

1. **Where does it live?** — New tool (`tools/`), new agent role (`team.json`), new mobile screen, or extension of an existing tool?
2. **Does it need a backend API?** — FastAPI (Python) or Node.js, served by systemd, proxied by Caddy
3. **Auth requirements** — Supabase JWT required for all user-facing APIs; `get_my_role()` for admin gates
4. **Agent integration** — Should agents audit/monitor/build this feature? Add to appropriate squads.
5. **HITL or automated?** — Does this require human approval, or can it run autonomously?
6. **Mobile companion** — Does it need a mobile screen? If so, which tab does it belong to?
7. **Documentation** — All new systems get a wiki doc in `Library/opai-wiki/`

---

*This document was generated from the OPAI system wiki and live codebase. For deeper detail on any system, refer to `Library/opai-wiki/<system>.md`.*
