# OPAI System Wiki

Living architecture documentation for OPAI internal tools and systems. Maintained by the `wiki_librarian` agent.

## Index

### Core — Platform Foundation

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [Auth & Network](core/auth-network.md) | Supabase JWT auth (ES256/HS256), Caddy reverse proxy (HTTPS-first, HTTP→HTTPS redirect), Tailscale VPN, NFS, role-based access, AI lock enforcement, RLS helper functions (`get_my_role()`), service key fast-path for internal calls | 2026-02-23 |
| [Portal](core/portal.md) | Public landing page, login, role router, onboarding wizard, admin dashboard (v2: 16 tiles — 9 active + 7 v3-deferred with dashed border/opacity/badge, health from `/engine/api/`, toolbar: search/sort/view toggle/save layout, drag-to-reorder, grid/list view, localStorage persistence), Pages Manager (WordPress-style table list, unified editor, file browser, registry, routes, Traefik deploy, archive versioning) | 2026-02-25 |
| [Orchestrator](core/orchestrator.md) | Central daemon: scheduling, service health, task routing, HITL briefings, sandbox scanning, feedback auto-actor (v2: merged into Engine) | 2026-02-25 |
| [Services & systemd](core/services-systemd.md) | v2: 9 systemd services + 3 timers, opai-control.sh, port map, vault env injection | 2026-02-25 |
| [Shared Navbar](core/navbar.md) | Self-injecting navigation bar: back button, recent tools tracking, role-aware icon strip | 2026-02-16 |
| [Files](core/opai-files.md) | Sandboxed file manager with Obsidian-like knowledge features: wikilinks, backlinks, knowledge graph, rich markdown, content search, quick switcher, AI instruct | 2026-02-16 |

### Tools — Platform Applications

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [2nd Brain](tools/brain.md) | Cognitive layer: Library (notes/concepts/questions), Inbox (quick capture), Canvas (spatial board), Research (AI synthesis), Graph (D3 force layout). Phase 7: Smart Suggestions engine (Claude Haiku semantic matching across all tabs). Block editor (Editor.js), version snapshots, agent scheduler, tier-gated AI features. Port 8101 | 2026-02-23 |
| [HELM](tools/helm.md) | Autonomous business runner: given any business plan → bootstraps + operates full presence. Multi-tenant, Stripe integration, credential vault, CEO-gate for financials, Discord bridge per business. Port 8102 | 2026-02-22 |
| [Bx4 Business Bot](tools/bx4.md) | AI business intelligence: 4 wings (Financial/Market/Social/Operations), budget-aware Green Filter, 4-layer Claude prompts, Triage Mode, multi-tenant via `bx4_company_access`. 19 Supabase tables. Port 8100 | 2026-02-22 |
| [DAM Bot](tools/dam-bot.md) | Do Anything Mode — meta-orchestrator: takes any goal, decomposes via Claude, executes via agents/squads/tools, tiered approval gates, self-improvement engine (Phase 4). 9 tables (`dam_` prefix). Port 8104. Uses shared Claude wrapper | 2026-02-24 |
| [Marq](tools/marq.md) | App store publisher agent: pre-submission checks (31 automated, 5 categories), metadata editor with char counts, submission workflow, score ring + grouped report view, review monitoring, rejection-to-task relay via TeamHub. 12 tables (`mrq_` prefix), multi-app. Port 8103 | 2026-02-23 |
| [Bot Space](tools/bot-space.md) | Bot catalog, credit system, cron scheduler: admin bots (Email Agent, Forum Bot) + user bots (email-agent-user), setup wizard with live test, `bot_space_catalog/installations/runs/credit_transactions` tables, FastAPI port 8099 | 2026-02-21 |
| [Chat](tools/chat.md) | AI chat with Claude + Gemini Flash, voice-to-text mic input, simple mode, file uploads with malicious content scanning, **Mozart Mode** (musical AI personality), AI lock security, conversation history | 2026-02-16 |
| [Terminal & Claude Code](tools/terminal.md) | PTY-backed web terminals: bash shell + Claude Code CLI via xterm.js + WebSocket | 2026-02-14 |
| [Billing](tools/billing.md) | Stripe billing: dual-Supabase (OPAI auth + BB2.0 data), product/price CRUD, checkout sessions, webhook lifecycle, subscription management, auto-provisioning queue, public landing site on BB VPS | 2026-02-17 |
| [Marketplace](tools/marketplace.md) | BoutaByte catalog integration, tier-based access, admin controls | 2026-02-16 |
| [Team Hub](tools/team-hub.md) | ClickUp-style task/project management: workspaces, folders, lists, board/list/calendar views, markdown description, @mention, item actions, settings modal, ClickUp import, dashboards, Discord integration, registry task migration with `registry:` traceability tags. **v3.5: OPAI Workers workspace** — single source of truth for agent/system tasks, HITL decisions, and proactive suggestions. Engine creates/updates items via internal API | 2026-03-02 |
| [PRD Pipeline](tools/prd-pipeline.md) | Product idea evaluation + project scaffolding: **PRDgent** agent scores ideas across 5 criteria (market demand, differentiation, feasibility, monetization, timing), verdicts (good/not_ready/poor), CSV/Google Sheets/JSON import, human approve/reject gate, Move to Project creates `Projects/<slug>/` with full doc scaffold (README + PRD.md + 4 subdirs). Uses shared Claude wrapper | 2026-02-24 |
| [TUI Dashboard](tools/tui-dashboard.md) | Terminal-based admin dashboard (Textual 8.x): live Claude plan usage bars + threshold alerts, system resource gauges (CPU/mem/disk/net), process task manager with kill command, Claude process classifier. No server/port — runs in any terminal | 2026-02-23 |
| [SCC IDE](tools/scc-ide.md) | Native Linux desktop app (Electron 31 + React + TS + Tailwind). 3-panel layout, 72-plugin panel, 26-squad runner, HITL watcher, thinking display, conversation management, vision/image pipeline | 2026-02-22 |
| [OPAIxClaude](tools/opai-agent.md) | Standalone Claude Code desktop wrapper. White UI, accent #4a56e6. 2-panel layout, parallel conversations, branch-based self-improvement loop, GitHub PAT integration | 2026-02-22 |
| [Task Control Panel](tools/task-control-panel.md) | Internal system task management: My Queue (HITL review from Team Hub + 5 other sources), Feedback tab, Audit tab, Token Budget, Heartbeat Control Panel, agent execution with auto-delegation flow, CC "Needs Attention" widget, action items API (v3.5: merged into Engine, Team Hub backbone) | 2026-03-02 |
| [Docs Portal](tools/docs.md) | Auto-updating docs portal: wiki-sourced, role-filtered, content-sanitized, fuzzy search, background watcher | 2026-02-15 |

### Agents — Framework & Management

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [Agent Framework](agents/agent-framework.md) | team.json (42 roles, 26 squads), runner scripts, builder agent, prompt system, report flow, per-agent tuning (model/turns/context), token optimization | 2026-02-20 |
| [Agent Studio](agents/agent-studio.md) | Visual agent management: create/edit agents (with per-agent model/turns/context tuning), squad builder, scheduler, workflows, AI flow builder, interactive onboarding guide with inline agent creation | 2026-02-19 |
| [Agent Orchestra](agents/agent-orchestra.md) | Musical concert hall UI for the agent system: SVG orchestra pit (row-band layout, programme dimming), 3-level navigation (Orchestra→Section→Musician), Composition Studio (visual flow editor), full TERM_MAP of 14 musical↔technical terms, standalone FastAPI tool on port 8098 | 2026-02-21 |
| [wshobson Agents](agents/wshobson-agents.md) | 72-plugin marketplace integration: 3 installed plugins, 90 Path B skill injections across 30 prompts, 15 new batch agents (4 phases), 45 total roles, 26 squads, coverage scorecard, batch install script | 2026-02-28 |

### Integrations — External Systems & Bridges

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [Discord Bridge](integrations/discord-bridge.md) | Discord bot bridging messages to Claude Code CLI, per-guild isolation, admin/team bot access control, workspace AI with MCP tools | 2026-02-17 |
| [Telegram Bridge](integrations/telegram-bridge.md) | **Phases 1-5 Live** — grammY Telegram bot, primary comms channel. Multi-conversation isolation, custom RBAC, 5-state memory, fast-path routing, Claude CLI fire-and-forget, inline keyboards, 24+ commands, assistant mode, morning briefing, Mini Apps (WordPress Manager via auth bridge + API proxy), file delivery. **v3.5: 5-button HITL gate** (Run/Approve/Dismiss/Reject/GC) with 15-min escalation, Team Hub UUID routing. Port 8110 | 2026-03-02 |
| [Email Agent](integrations/email-agent.md) | Persistent autonomous email agent (v5): multi-account monitoring, whitelist + **blacklist** (mutual exclusion), 3-mode, **trash classification** (manual + AI auto-trash 48h delay + rescue), **custom classifications** with pattern learning (understandings → auto-suggestions), **Recompose** (re-draft with guidance → Gmail Drafts), **Needs Action** (move/delete/forward/TeamHub task), ARL, CLI checker, inbox-style UI, feedback loop. Port 8093 | 2026-02-27 |
| [Email Checker](integrations/email-checker.md) | IMAP email fetcher with classification, task extraction, response drafting | 2026-02-14 |
| [OP WordPress](integrations/op-wordpress.md) | Multi-site WordPress management (ManageWP replacement): multi-strategy connector deployment, **Push OP**, self-healing connection retry agent, per-site method pinning, WooCommerce, site-specific AI Agents UI, task logging to registry/audit | 2026-02-19 |
| [farmOS](integrations/farmos.md) | Morning Dew Homestead farm management: Drupal 11 on BB VPS (Docker + Traefik), PostgreSQL 16, JSON:API + OAuth2, custom free satellite map layers, vault-stored credentials | 2026-02-26 |
| [OpenClaw](integrations/openclaw.md) | Techniques from Nat Eliason's "Felix" autonomous agent: 3-layer memory, authenticated vs information channels, heartbeat proactivity, RALPH loop delegation, progressive access expansion, nightly memory consolidation. Full mapping to OPAI systems | 2026-02-25 |
| [OpenClaw Broker & Runtime](integrations/openclaw-broker.md) | OpenClaw container system: access manifest, vault broker, Docker container runtime, kill switch, port allocation (9001-9099), ClawBot image, full audit trail. Port 8106. See also [OpenClaw](integrations/openclaw.md) | 2026-02-26 |
| [YouTube Transcriber](integrations/youtube-transcriber.md) | Global shared capability: fetch, summarize, and act on YouTube video transcripts. Shared Python/JS libraries, integrated into Discord, Chat, Brain, PRD Pipeline. Claude Code MCP for interactive use | 2026-02-24 |
| [Forum Bot](integrations/forumbot.md) | AI content generation pipeline: Claude CLI drafts, post type templates, cron scheduler with conditions, admin SPA (generate/review/publish), forum integration | 2026-02-17 |
| [Forum](integrations/forum.md) | Reddit-style dev forum: posts, comments, votes, reactions, polls, code snippets, categories | 2026-02-15 |
| [Messenger](integrations/messenger.md) | Internal team messaging: DMs, groups, reactions, file sharing, presence, floating widget | 2026-02-14 |

### Infra — Infrastructure, Monitoring & Security

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [OPAI v2 — "The Operator"](infra/opai-v2.md) | **Complete (2026-02-25)** — 28→9 services, unified Engine (port 8080), WorkerManager (12 workers), 4-tab interactive dashboard, vault integration (144 secrets) | 2026-02-25 |
| [Vault](infra/vault.md) | Encrypted credential management: SOPS+age encrypted store (276 secrets), AI-safe credential broker, CLI tools (`vault-cli.sh`), 24 systemd services migrated with tmpfs injection, MCP wrapper, audit logging. **Per-user vault** (`/vault/my/`): standalone SPA with Supabase JWT + per-user PIN auth (bcrypt, 5-attempt lockout), AES-256-GCM per-user encryption, isolated from admin vault. Port 8105 | 2026-02-28 |
| [Sandbox System](infra/sandbox-system.md) | NAS-backed user sandboxes: NFS mount, provisioning, onboarding wizard, per-user agents | 2026-02-15 |
| [MCP Infrastructure](infra/mcp-infrastructure.md) | **Profile-based launch system**: 4 profiles (`slim`/`browser`/`wordpress`/`full`) via `--mcp-config` + launch scripts, subagent workers (`.claude/agents/`), master catalog (`config/mcp-all.json`: 11 servers, ~114 tools), tool optimization (`input_examples` -35% cost), shared Claude wrapper, benchmark harness. PTC dormant (no API key) | 2026-02-28 |
| [Feedback System](infra/feedback-system.md) | In-app feedback collection, classification, wiki dedup, per-tool improvement files, auto-task creation, Engine dashboard Feedback tab, token optimization | 2026-02-25 |
| [Monitor](infra/monitor.md) | Web dashboard: system metrics, plan usage (Anthropic API), Claude status, logs, reports, aggregated health API (v2: merged into Engine) | 2026-02-25 |
| [Usage Throttling](infra/usage-throttling.md) | Plan usage limits, task prioritization tiers, model routing strategy, throttling thresholds | 2026-02-19 |
| [User Controls](infra/user-controls.md) | User management, invite, permissions, sandbox provisioning, network lockdown | 2026-02-16 |
| [Browser Automation](infra/browser-automation.md) | Headless Playwright via Claude CLI: job queue API (submit/list/cancel), named session persistence, temp MCP config generation, admin auth, localhost-only. Port 8107 | 2026-02-27 |
| [Heartbeat](infra/heartbeat.md) | **v3.5** — Proactive 30-min background loop: aggregates workers/tasks/sessions/resources into snapshots, detects changes (completions/failures/stalls), auto-restarts crashed managed workers, sends Telegram alerts with HITL escalation (15-min timer), generates daily notes with AI summary, runs **proactive intelligence** (overdue detection, stall detection, pattern recognition, idle worker alerts). Port 8080 (Engine) | 2026-03-02 |
| [Fleet Coordinator & Action Items](infra/fleet-action-items.md) | **v3.5** — Work dispatch backbone: identifies work from signals (heartbeat, registry, Team Hub), routes to workers via category/keyword matching, tracks execution, Team Hub integration. Action Items API aggregates 6 sources into priority-scored feed. Engine "My Queue" tab + CC widget. HITL items are Team Hub items with inline Telegram actions | 2026-03-02 |
| [NFS Drop-Folder Dispatcher](infra/nfs-dispatcher.md) | **v3.5** — File-based communication with external ClaudeClaw workers via NFS. Inbox/outbox with READY/DONE sentinels, worker health monitoring, admin HITL sync (renders .md briefings for GravityClaw, polls .response files), Team Hub status updates. Base path: `/workspace/users/_clawbots/` | 2026-03-02 |
| [Headless Display](infra/headless-display.md) | Virtual desktop at 2560x1440 with no physical monitor: NVIDIA ConnectedMonitor + MetaModes, RustDesk remote access, SSH/Tailscale recovery. HP Z420 + GTX 980 | 2026-02-28 |
| [OP IDE](infra/dev-ide.md) | Browser IDE (Theia): per-project workspaces, built-in AI assistant, extension library, Docker lifecycle | 2026-02-15 |

### Plans — Roadmaps, Procedures & Reference

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [TCP Redesign Plan](plans/tcp-redesign.md) | **Active plan** — Unified OPAI Command Center: 9-state Prefect-style status model, tiered audit system, Monitor merger into Health tab, actionable-only task list | 2026-02-22 |
| [Invite & Onboarding Flow](plans/invite-onboarding-flow.md) | End-to-end: admin invite, Supabase email, PKCE verification, 5-step wizard, sandbox provisioning | 2026-02-15 |
| [Mobile App](plans/mobile-app.md) | React Native/Expo admin companion: 5-tab layout (Home, Tasks, Chat, Monitor, Command), hierarchical task navigation, WS chat streaming, Supabase auth, dark theme | 2026-02-19 |
| [Website Backup](plans/website-backup.md) | SOP for full site backups: FTP/SSH/crawl priority order, DB export methods, WordPress restoration, gotchas | 2026-02-17 |
| [Troubleshooting](plans/troubleshooting.md) | Hard-won fixes: electron-vite stale `.js` artifact, Electron single-instance lock, "nothing changed" diagnosis checklist, Python UTC timestamps, Supabase RLS recursion, Email IMAP fetch, systemd PATH, Email DNS fix | 2026-02-24 |
| [OPAI Evolution Plan](plans/opai-evolution.md) | **Strategic roadmap** — v2 "The Operator" (current, consolidated infra + ClawBot foundation), v3 "Felix" (autonomous OPAI, proactive heartbeat, memory consolidation, HELM activation), v4 "Open Doors" (revenue — HELM businesses, agency services, ClawBot beta). Timeline, exit criteria, key decisions | 2026-02-27 |

---

## Brand Metaphor — The Musical Framework

OPAI describes its agentic system through a **symphony metaphor** — making it intuitive, memorable, and distinct from every other AI platform.

| Music Term | OPAI Equivalent | Why It Maps |
|------------|-----------------|-------------|
| **Composer** | Creators (Dallas, team) | Write the scores — prompts, squad configs, workflows |
| **Score** | Prompts, squad definitions, workflows | The written instructions that define what gets played |
| **Conductor** | Orchestrator (`opai-orchestrator`) | Reads the score, cues each section, controls tempo — doesn't play every instrument |
| **Players** | Agents | Specialists on their instruments — follow the score but bring their own expertise |
| **Ensemble** | Squad | A string quartet for a quick audit, a full orchestra for a release |
| **Rehearsal** | Dry run / safe mode | Practice before opening night |
| **Performance** | Reports | What the audience (you) actually hears and evaluates |
| **HITL Gate** | Composer reviewing rehearsal | Review the recording before opening night |

**Why this matters**: Everyone else talks pipelines, DAGs, chains. OPAI talks **composition, performance, and artistry** — memorable and deeply human. This is the storytelling language used in documentation, landing pages, and team communication.

**Scaling analogy**: A composer can write for a solo, a chamber group, or a full symphony — just like you scale from a single agent to a 6-agent squad.

---

## Knowledge Architecture

OPAI's knowledge lives in a **three-tier system**:

```
┌─────────────────────────────────────────────┐
│  MEMORY.md (Claude Code auto-loaded)        │
│  ~/.claude/projects/.../memory/MEMORY.md    │
│  - Slim index (~200 lines)                  │
│  - Topic → wiki file pointers               │
│  - Key facts (Supabase ID, service cmds)    │
│  - Common gotchas (prevent mistakes)         │
│  - Musical Framework (brand identity)        │
└──────────────────┬──────────────────────────┘
                   │ references
                   ▼
┌─────────────────────────────────────────────┐
│  Library/opai-wiki/ (Universal knowledge)   │
│  - 56 system architecture docs              │
│  - 6 subfolders: core/tools/agents/         │
│    integrations/infra/plans/                │
│  - Read by agents, orchestrator, docs portal│
│  - Single source of truth                   │
│  - Pulled in on-demand, not always loaded   │
└──────────────────┬──────────────────────────┘
                   │ supports
                   ▼
┌─────────────────────────────────────────────┐
│  Library/knowledge/ (Structured reference)  │
│  - concepts/ — patterns, theories, context  │
│  - reference/ — dev commands, APIs, guides  │
│  - Pulled in on-demand by agents            │
└─────────────────────────────────────────────┘
```

**Principle**: MEMORY.md stays lean (index + essentials). Detailed docs live in `Library/opai-wiki/` where all OPAI systems can access them — agents, orchestrator, docs portal, wiki librarian. No duplication.

---

## How This Wiki Works

- **Source of truth**: Always the actual source code and config files
- **Update trigger**: Run the `wiki` squad after system changes, or assign `wiki_librarian` to a task
- **Format**: Each entry follows a standard template (Overview, Architecture, Key Files, Configuration, API, How to Use, Dependencies)
- **Cross-references**: Entries link to each other when systems interact
- **Memory integration**: MEMORY.md indexes this wiki — detailed knowledge lives here, not in the memory file
- **Subfolder structure**: `core/` (platform foundation), `tools/` (applications), `agents/` (framework), `integrations/` (external bridges), `infra/` (infrastructure), `plans/` (roadmaps & procedures)
