# OPAI System Wiki

Living architecture documentation for OPAI internal tools and systems. Maintained by the `wiki_librarian` agent.

## Index

### Core — Platform Foundation

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [Auth & Network](core/auth-network.md) | Supabase JWT auth (ES256/HS256), Caddy reverse proxy (HTTPS-first, HTTP→HTTPS redirect), Tailscale VPN, NFS, role-based access, AI lock enforcement, RLS helper functions (`get_my_role()`), service key fast-path for internal calls, **Engine auth hardening** (40 endpoints across 8 route modules require admin auth) | 2026-03-05 |
| [Portal](core/portal.md) | Public landing page, login, role router, onboarding wizard, admin dashboard (18 tiles — 11 active + 7 v3-deferred with dashed border/opacity/badge, health from `/engine/api/`, toolbar: search/sort/view toggle/save layout, drag-to-reorder, grid/list view, localStorage persistence), Pages Manager (WordPress-style table list, unified editor, file browser, registry, routes, Traefik deploy, archive versioning) | 2026-03-05 |
| [Orchestrator](core/orchestrator.md) | Unified Engine (port 8080, FastAPI v3.5.0): 28 route modules, 12+ async background tasks (scheduler, health, fleet coordinator, NFS dispatcher, heartbeat, assembly, process sweeper, etc.), shared singletons (WorkerManager, FleetCoordinator, AssemblyPipeline), resource-aware scheduling, HITL briefings, **endpoint security** (40 endpoints across 8 modules require admin auth, 3 intentionally public) | 2026-03-05 |
| [Services & systemd](core/services-systemd.md) | v3.5: 12 systemd services + 3 timers (vault, caddy, portal, engine, brain, files, team-hub, users, wordpress, oc-broker, browser, discord-bot), opai-control.sh, port map, vault env injection, dependency pinning (35 packages across 6 tools) | 2026-03-05 |
| [Shared Navbar](core/navbar.md) | Self-injecting navigation bar: back button, recent tools tracking, role-aware icon strip | 2026-02-16 |
| [Files](core/opai-files.md) | Sandboxed file manager with Obsidian-like knowledge features: wikilinks, backlinks, knowledge graph, rich markdown, content search, quick switcher, AI instruct | 2026-02-16 |

### Tools — Platform Applications

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [2nd Brain](tools/brain.md) | Cognitive layer: Library (notes/concepts/questions), Inbox (quick capture), Canvas (spatial board), Research (AI synthesis), Graph (D3 force layout). Phase 7: Smart Suggestions engine (Claude Haiku semantic matching across all tabs). Block editor (Editor.js), version snapshots, agent scheduler, tier-gated AI features. [NotebookLM](integrations/notebooklm.md) integration: research pre-analysis, YouTube/Instagram offload, deliverables (podcasts, guides, quizzes). Port 8101 | 2026-03-05 |
| [HELM](tools/helm.md) | Autonomous business runner: given any business plan → bootstraps + operates full presence. Multi-tenant, Stripe integration, credential vault, CEO-gate for financials, Discord bridge per business. [NotebookLM](integrations/notebooklm.md) integration: report pre-analysis + audio briefings, content topic research, competitor research. Playbook library (4 playbooks: GEO Audit, AIOS Consulting, Customer Onboarding, Affiliate Revenue). Port 8102 | 2026-03-05 |
| [Bx4 Business Bot](tools/bx4.md) | AI business intelligence: 4 wings (Financial/Market/Social/Operations), budget-aware Green Filter, 4-layer Claude prompts, Triage Mode, multi-tenant via `bx4_company_access`. 19 Supabase tables. Port 8100 | 2026-02-22 |
| [DAM Bot](tools/dam-bot.md) | Do Anything Mode — meta-orchestrator: takes any goal, decomposes via Claude, executes via agents/squads/tools, tiered approval gates, self-improvement engine (Phase 4). 9 tables (`dam_` prefix). Port 8104. Uses shared Claude wrapper | 2026-02-24 |
| [Marq](tools/marq.md) | App store publisher agent: pre-submission checks (31 automated, 5 categories), metadata editor with char counts, submission workflow, score ring + grouped report view, review monitoring, rejection-to-task relay via TeamHub. 12 tables (`mrq_` prefix), multi-app. Port 8103 | 2026-02-23 |
| [Bot Space](tools/bot-space.md) | Bot catalog, credit system, cron scheduler: admin bots (Email Agent, Forum Bot) + user bots (email-agent-user), setup wizard with live test, `bot_space_catalog/installations/runs/credit_transactions` tables, FastAPI port 8099 | 2026-02-21 |
| [Chat](tools/chat.md) | AI chat with Claude + Gemini Flash, voice-to-text mic input, simple mode, file uploads with malicious content scanning, **Mozart Mode** (musical AI personality), AI lock security, conversation history | 2026-02-16 |
| [Terminal & Claude Code](tools/terminal.md) | PTY-backed web terminals: bash shell + Claude Code CLI via xterm.js + WebSocket | 2026-02-14 |
| [Billing](tools/billing.md) | Stripe billing: dual-Supabase (OPAI auth + BB2.0 data), product/price CRUD, checkout sessions, webhook lifecycle, subscription management, auto-provisioning queue, public landing site on BB VPS | 2026-02-17 |
| [Marketplace](tools/marketplace.md) | BoutaByte catalog integration, tier-based access, admin controls | 2026-02-16 |
| [Team Hub](tools/team-hub.md) | ClickUp-style task/project management: workspaces, folders, lists, board/list/calendar views, markdown description, @mention, item actions, settings modal, ClickUp import, dashboards, Discord integration, registry task migration with `registry:` traceability tags. **v3.5: OPAI Workers workspace** — single source of truth for agent/system tasks, HITL decisions, and proactive suggestions. Engine creates/updates items via internal API. **Notifications**: assignment/update/mention/reminder/automation triggers, dismissable + clickable dropdown, live home tile sync on due_date changes. **Agent bridge**: `teamhub_client.py` shared client, internal `/add-comment` now parses @mentions, post-squad hook creates Team Hub tasks from findings. **Data quality**: status normalization (6 canonical values), 100% workspace description coverage | 2026-03-05 |
| [PRD Pipeline](tools/prd-pipeline.md) | Product idea evaluation + project scaffolding: **PRDgent** agent scores ideas across 5 criteria (market demand, differentiation, feasibility, monetization, timing), verdicts (good/not_ready/poor), CSV/Google Sheets/JSON import, human approve/reject gate, Move to Project creates `Projects/<slug>/` with full doc scaffold (README + PRD.md + 4 subdirs), **inline file picker** (browse `Research/PRD/`, preview + load `.md/.txt/.json/.docx` into editor). Uses shared Claude wrapper | 2026-03-02 |
| [TUI Dashboard](tools/tui-dashboard.md) | Terminal-based admin dashboard (Textual 8.x): live Claude plan usage bars + threshold alerts, system resource gauges (CPU/mem/disk/net), process task manager with kill command, Claude process classifier. No server/port — runs in any terminal | 2026-02-23 |
| [SCC IDE](tools/scc-ide.md) | Native Linux desktop app (Electron 31 + React + TS + Tailwind). 3-panel layout, 72-plugin panel, 26-squad runner, HITL watcher, thinking display, conversation management, vision/image pipeline | 2026-02-22 |
| [OPAIxClaude](tools/opai-agent.md) | Standalone Claude Code desktop wrapper. White UI, accent #4a56e6. 2-panel layout, parallel conversations, branch-based self-improvement loop, GitHub PAT integration | 2026-02-22 |
| [Task Control Panel](tools/task-control-panel.md) | Internal system task management: My Queue (HITL review from Team Hub + 5 other sources), Feedback tab, Audit tab, Token Budget, Heartbeat Control Panel, agent execution with auto-delegation flow, CC "Needs Attention" widget, action items API (v3.5: merged into Engine, Team Hub backbone). **Performance**: parallel API calls (action-items, health probes, front-end `Promise.allSettled`), async auth bootstrap — dashboard load ~928ms→~300-450ms | 2026-03-05 |
| [Docs Portal](tools/docs.md) | Zero-process static SPA: Caddy-served wiki browser with marked.js rendering, Fuse.js search, hash routing, offline manifest generator. No backend — zero RAM, zero processes. Anonymous access (no login required) — any user on Tailscale can read docs | 2026-03-05 |
| [n8n-Forge Pipeline](tools/n8n-forge.md) | Interactive n8n-to-product pipeline: 3-phase skill (Design → Prototype → Convert), `forge` squad (7-agent quality gate), n8n specialist prompt, node-mapping reference (25+ nodes → Python/Node.js), Team Hub client (`teamhub_client.py`), post-squad hook bridge, project scaffold template | 2026-03-04 |
| [Studio](tools/studio.md) | AI image generation + editing suite: Gemini-powered generation (50/day limit + override), Fabric.js canvas (layers, shapes, text), import/paste/drop, project organization. Phase 1 live; phases 2-6 planned (processing, presets, bulk export, recipes). Port 8108 | 2026-03-02 |
| [Assembly Line](tools/assembly.md) | End-to-end autonomous build pipeline: idea → PRD → SPEC → build → review → iterate → ship. 6-phase state machine, two human gates (plan + ship), Fleet Coordinator dispatch, max 3 review iterations, restart resilient. Triggered via API or Telegram `/assembly`. Engine module (port 8080) | 2026-03-05 |
| [React Doctor](tools/react-doctor.md) | Static anti-pattern scanner (60+ rules, health score 0-100) for React/React Native projects. Claude Code skill (`/react-doctor`) + audit squad agent. CLI: `npx -y react-doctor@latest <path> --verbose`. Report-only | 2026-03-09 |
| [React Scan](tools/react-scan.md) | Runtime performance profiler — visual re-render detection. Dev overlay in opai-agent + CLI scanner (`scripts/react-scan.sh`). Tree-shaken from production builds | 2026-03-09 |
| [React Grab](tools/react-grab.md) | AI context selection — hover any React element + Ctrl+C to copy component source for agents. Dev overlay in opai-agent + on-demand MCP server. 3x faster agent responses | 2026-03-09 |
| [Pencil.dev](tools/pencil.md) | Agent-driven visual design tool (Figma-like): text prompts → editable UI designs via MCP. 7 tools (`batch_design`, `get_screenshot`, etc.), 4 UI kits (Shadcn, Lunaris, Halo, Nitro), `.pen` JSON export. Desktop app + auto-MCP. Bridges blueprint wireframes → coded UIs | 2026-03-10 |
| [Eliza Hub](tools/eliza-hub.md) | ElizaOS autonomous agent runtime: hybrid architecture (ElizaOS core + Claude CLI), two-service design (Bun/TS :8085 + FastAPI :8083), 3 custom plugins, 3 deployed characters (OP-Worker, Support Agent, Content Writer), Telegram bot (`@Opaielizabot`) with `/switch` multi-agent support, runtime-only mode (no Supabase required), 7-step wizard, knowledge branches, audit. Accent #00d4aa | 2026-03-12 |

### Agents — Framework & Management

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [Agent Framework](agents/agent-framework.md) | team.json (43 roles, 27 squads), runner scripts, builder agent, prompt system, report flow, per-agent tuning (model/turns/context), token optimization, forge squad (n8n-forge quality gate), meta-assessment second-order loop | 2026-03-05 |
| [Workforce Reference](agents/workforce-reference.md) | Complete roster: 48 agents (by category), 29 squads, 15 workers, 7 specialist templates, 5 swarm capabilities (Worker Mail, Pre-Task Priming, Hierarchical Delegation, Auto-Review, Self-Improvement). Relationship diagram, quick reference commands. UI: Engine > Workers > Roster tab | 2026-03-05 |
| [Agent Studio](agents/agent-studio.md) | Visual agent management: create/edit agents (with per-agent model/turns/context tuning), squad builder, scheduler, workflows, AI flow builder, interactive onboarding guide with inline agent creation | 2026-02-19 |
| [Agent Orchestra](agents/agent-orchestra.md) | Musical concert hall UI for the agent system: SVG orchestra pit (row-band layout, programme dimming), 3-level navigation (Orchestra→Section→Musician), Composition Studio (visual flow editor), full TERM_MAP of 14 musical↔technical terms, standalone FastAPI tool on port 8098 | 2026-02-21 |
| [wshobson Agents](agents/wshobson-agents.md) | 72-plugin marketplace integration: 3 installed plugins, 90 Path B skill injections across 30 prompts, 15 new batch agents (4 phases), 45 total roles, 26 squads, coverage scorecard, batch install script | 2026-02-28 |
| [Structured Build Loop](agents/structured-build-loop.md) | 7-step agent workflow for visual projects (games, dashboards, apps): asset catalog → plan (mandatory clarifying Qs) → implement → Playwright visual QA → fix → learnings capture → commit. Model routing guide (reasoning for planning, coding for implementation, vision for QA). 5 prompt templates. Nests inside Assembly Line Phase 3. Foundation for future Game Dev agent role | 2026-03-10 |

### Integrations — External Systems & Bridges

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [Discord Bridge](integrations/discord-bridge.md) | Discord bot bridging messages to Claude Code CLI, per-guild isolation, admin/team bot access control, workspace AI with MCP tools | 2026-02-17 |
| [Telegram Bridge](integrations/telegram-bridge.md) | **Phases 1-5 Live** — grammY Telegram bot, primary comms channel. Multi-conversation isolation, custom RBAC, 5-state memory, fast-path routing, Claude CLI fire-and-forget, inline keyboards, 24+ commands, assistant mode, morning briefing, Mini Apps (WordPress Manager via auth bridge + API proxy), file delivery. **v3.5: 5-button HITL gate** (Run/Approve/Dismiss/Reject/GC) with 15-min escalation, Team Hub UUID routing. Port 8110 | 2026-03-05 |
| [Email Agent](integrations/email-agent.md) | Persistent autonomous email agent (v8): multi-account monitoring, whitelist + blacklist, 3-mode, trash classification, custom classifications with pattern learning, Recompose, Needs Action, ARL (19 built-in skills, 5 types, incl. template-based sending), **Transcript Agent** (MIME attachment download, multi-type action items [task/quote/research/follow_up/email], TH workspace integration, approval gate), 5 voice profiles, 6 email templates, CLI checker, inbox-style UI, feedback loop, cleanup scanner. Port 8093 | 2026-03-05 |
| [Email Checker](integrations/email-checker.md) | IMAP email fetcher with classification, task extraction, response drafting | 2026-02-14 |
| [OP WordPress](integrations/op-wordpress.md) | Multi-site WordPress management (ManageWP replacement): multi-strategy connector deployment, **Push OP**, self-healing connection retry agent, per-site method pinning, WooCommerce, site-specific AI Agents UI, task logging to registry/audit, CORS hardening (explicit origins), dependency pinning (8 packages) | 2026-03-05 |
| [farmOS](integrations/farmos.md) | Morning Dew Homestead farm management: Drupal 11 on BB VPS (Docker + Traefik), PostgreSQL 16, JSON:API + OAuth2, custom free satellite map layers, vault-stored credentials | 2026-02-26 |
| [OpenClaw](integrations/openclaw.md) | Techniques from Nat Eliason's "Felix" autonomous agent: 3-layer memory, authenticated vs information channels, heartbeat proactivity, RALPH loop delegation, progressive access expansion, nightly memory consolidation. Full mapping to OPAI systems | 2026-02-25 |
| [OpenClaw Broker & Runtime](integrations/openclaw-broker.md) | OpenClaw container system: access manifest, vault broker, Docker container runtime, kill switch, port allocation (9001-9099), ClawBot image, full audit trail. Port 8106. See also [OpenClaw](integrations/openclaw.md) | 2026-02-26 |
| [YouTube Transcriber](integrations/youtube-transcriber.md) | Global shared capability: fetch, summarize, and act on YouTube video transcripts. Shared Python/JS libraries, integrated into Discord, Chat, Brain, PRD Pipeline. Claude Code MCP for interactive use | 2026-02-24 |
| [Instagram Scraper](integrations/instagram-scraper.md) | Instagram reel scraper + analyzer. Three modes: Build (tutorial extraction with frames + Vision), Intel (content strategy), and **Visual Analysis** (Playwright browser scrubbing → screenshot frames → object ID + materials breakdown). Shared Python/JS libraries, integrated into Telegram, Brain. Claude Code MCP + Playwright MCP. Shares Supadata transcript pool with YouTube | 2026-03-03 |
| [NotebookLM](integrations/notebooklm.md) | Shared capability for offloading research/analysis to Google NotebookLM (Gemini RAG). Shared library (`tools/shared/nlm.py`), wrap-and-fallback pattern (Claude CLI fallback on every call). Integrated into Brain (research, YouTube, Instagram, AI summarize, deliverables), HELM (reports, content, competitors), Engine (admin API, wiki sync). ~60-70% token savings on research tasks + new deliverable types (podcasts, study guides, quizzes, slide decks) | 2026-03-05 |
| [Google Workspace](integrations/google-workspace.md) | **Phases 1-3 Live** — agent@paradisewebfl.com as real team collaborator. Drive/Gmail/Docs/Sheets/Chat API via OAuth2. Phase 1: read-only observer + folder audit + **differential Drive scanner** (Changes API delta tracking, `drive_scan_changes` MCP tool, `scripts/drive-scanner.py` CLI, auto-updates `ParadiseWebFL-Structure.md` changelog). Phase 2: @agent doc comment commands (10 commands), Google Chat poller. Phase 2.5: intent router + 7 skill handlers (file search, research docs, TeamHub CRUD), gap detection, daily newsletter. Phase 3: **Co-Editor** — activity-gated direct doc editing, session join/leave, 10-min human activity timeout, revision-based detection, Claude-planned edit operations via Docs API batchUpdate. Trust model: domain-gated, system queries Dallas-only | 2026-03-05 |
| [Forum Bot](integrations/forumbot.md) | AI content generation pipeline: Claude CLI drafts, post type templates, cron scheduler with conditions, admin SPA (generate/review/publish), forum integration | 2026-02-17 |
| [Forum](integrations/forum.md) | Reddit-style dev forum: posts, comments, votes, reactions, polls, code snippets, categories | 2026-02-15 |
| [Messenger](integrations/messenger.md) | Internal team messaging: DMs, groups, reactions, file sharing, presence, floating widget | 2026-02-14 |

### Infra — Infrastructure, Monitoring & Security

| Entry | Description | Last Updated |
|-------|-------------|-------------|
| [OPAI v2 — "The Operator"](infra/opai-v2.md) | **Complete (2026-02-25)** — 28→9 services, unified Engine (port 8080), WorkerManager (12 workers), 4-tab interactive dashboard, vault integration (144 secrets) | 2026-02-25 |
| [Vault](infra/vault.md) | Encrypted credential management: SOPS+age encrypted store (276 secrets), AI-safe credential broker, CLI tools (`vault-cli.sh`), 24 systemd services migrated with tmpfs injection, MCP wrapper, audit logging. **Per-user vault** (`/vault/my/`): standalone SPA with Supabase JWT + per-user PIN auth (bcrypt, 5-attempt lockout), AES-256-GCM per-user encryption, isolated from admin vault. Security audit (2026-03-05): `migrate_credentials.py` gitignored, Stripe test key remediated. Port 8105 | 2026-03-05 |
| [Sandbox System](infra/sandbox-system.md) | NAS-backed user sandboxes: NFS mount, provisioning, onboarding wizard, per-user agents | 2026-02-15 |
| [MCP Infrastructure](infra/mcp-infrastructure.md) | **Profile-based launch system**: 4 launch profiles + 4 internal profiles, **Supabase Local MCP** (vault-backed PATs, multi-project: opai/bb2/apps-internal, 8 tools, replaced Anthropic-hosted), subagent workers (`.claude/agents/`), master catalog (`config/mcp-all.json`: 15 servers, ~113 tools incl. Pencil.dev), tool optimization (`input_examples` -35% cost), shared Claude wrapper. PTC dormant (no API key) | 2026-03-10 |
| [Feedback System](infra/feedback-system.md) | In-app feedback collection, classification, wiki dedup, per-tool improvement files, auto-task creation, Engine dashboard Feedback tab, token optimization | 2026-02-25 |
| [Monitor](infra/monitor.md) | Web dashboard: system metrics, plan usage (Anthropic API), Claude status, logs, reports, aggregated health API (v2: merged into Engine) | 2026-02-25 |
| [Usage Throttling](infra/usage-throttling.md) | Plan usage limits, task prioritization tiers, model routing strategy, throttling thresholds | 2026-02-19 |
| [User Controls](infra/user-controls.md) | Standalone admin panel (port 8084): user invite/edit/deactivate, per-user app + agent access, AI lock management, hard delete, sandbox provisioning, network lockdown kill switch, dynamic app registry from tools/ scan | 2026-03-05 |
| [Browser Automation](infra/browser-automation.md) | Headless Playwright via Claude CLI: job queue API (submit/list/cancel), named session persistence, temp MCP config generation, admin auth, localhost-only. Port 8107 | 2026-02-27 |
| [Heartbeat](infra/heartbeat.md) | **v3.5** — Proactive 30-min background loop: aggregates workers/tasks/sessions/resources into snapshots, detects changes (completions/failures/stalls), auto-restarts crashed managed workers, sends Telegram alerts with HITL escalation (15-min timer), generates daily notes with AI summary, runs **proactive intelligence** (overdue detection, stall detection, pattern recognition, idle worker alerts). Port 8080 (Engine) | 2026-03-02 |
| [Fleet Coordinator & Action Items](infra/fleet-action-items.md) | **v3.5 + Swarm** — Work dispatch backbone + swarm enhancements: worker mail (SQLite inter-worker messaging + Team Hub mirror), pre-task context priming (journal + mail), hierarchical delegation (project-lead decomposes → sub-workers via `DISPATCH:` output), auto-review pipeline (builder → reviewer auto-chain), self-improvement loop (`PROPOSE_TASK:` → human-gated registry). Category/keyword routing, Team Hub integration, Action Items API (6 sources → priority-scored feed), "My Queue" tab, HITL with Telegram actions | 2026-03-02 |
| [NFS Drop-Folder Dispatcher](infra/nfs-dispatcher.md) | **v3.5** — File-based communication with external ClaudeClaw workers via NFS. Inbox/outbox with READY/DONE sentinels, worker health monitoring, admin HITL sync (renders .md briefings for GravityClaw, polls .response files), Team Hub status updates. Base path: `/workspace/users/_clawbots/` | 2026-03-02 |
| [Meta-Assessment](infra/meta-assessment.md) | **v3.5** — Second-order self-improvement loop: verifies whether the `daily_evolve` fix pipeline actually lands fixes, cross-validates agent outputs, measures fleet token efficiency, audits prompt quality. Phase 3.5 of daily_evolve (runs after evolve squad, before email). 6-phase diagnostic with decision tree | 2026-03-05 |
| [File Sync & Storage](infra/file-sync.md) | Synology Drive sync (session 3 blacklist, state file exclusion), NFS v4.1 mount (separate — `/workspace/users/`), TailSync archived (883K inotify watches, 3.4GB RAM drain), performance tuning results, temporary rescan monitor (heartbeat-integrated Telegram notifications) | 2026-03-05 |
| [Headless Display](infra/headless-display.md) | Virtual desktop at 2560x1440 with no physical monitor: NVIDIA ConnectedMonitor + MetaModes, RustDesk remote access, SSH/Tailscale recovery. HP Z420 + GTX 980 | 2026-02-28 |
| [Agent Feedback Loops](infra/agent-feedback-loops.md) | Agent-to-agent learning system: agents emit `<!-- FEEDBACK -->` blocks in reports, post-hook extracts + stores in Supabase (`engine_agent_feedback`), squad runner injects hints into future prompts, 24h confidence decay, heartbeat stats. 6 API endpoints. Distinct from UI Feedback System. 5 prompts enabled (security, self_assessment, accuracy, tools_monitor, researcher) | 2026-03-07 |
| [Scheduling Architecture](infra/scheduling-architecture.md) | 6-layer scheduling model: Engine Central Scheduler (21 cron jobs) → Engine Background Loops (12+ async tasks) → Service-Specific Schedulers (WP, HELM, Brain, ForumBot) → Telegram Watchdog → systemd Timers → Claude Code `/loop`. Complete interval inventory, overlap analysis, consolidation decisions | 2026-03-07 |
| [Claude Code /loop Cron](infra/claude-loop-cron.md) | Claude Code `/loop` slash command: session-scoped cron prompts (1-min minimum, 3-day expiry). Dev tool for prototyping schedules, debugging, temporary monitors. NOT a production scheduling replacement | 2026-03-07 |
| [Vercel Demo Platform](infra/vercel-demo-platform.md) | Ephemeral Vercel deploys for customer demos: CLI script + Engine API + Telegram `/demo` command, max 3 active, 48h TTL, auto-sweep, Telegram notifications. Hobby plan — disposable staging only | 2026-03-04 |
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

## Tool Status Reference

> Quick reference for what's running, what's deferred, and what was archived in v2/v3 restructuring.

### Active Services (v3.5)

| Service | Port | Status |
|---------|------|--------|
| Engine | 8080 | Core — orchestrator, workers, heartbeat, fleet |
| Portal | 8090 | Auth, dashboard, pages manager |
| Docs | 8091 | Zero-process static SPA wiki browser (Caddy-served) |
| Team Hub | 8089 | Task/project management, OPAI Workers workspace |
| Email Agent | 8093 | Autonomous email monitoring |
| Users | 8084 | User management, invite, permissions, network lockdown |
| Billing | 8094 | Stripe integration, public landing |
| PRD Pipeline | 8097 | Product idea evaluation + project scaffolding |
| Vault | 8105 | Encrypted credential management |
| WordPress | 8096 | Multi-site WordPress management |
| Telegram | 8110 | Primary comms, HITL gate |
| Brain | 8101 | Knowledge graph, library, research |
| Bx4 | 8100 | AI business intelligence |
| HELM | 8102 | Autonomous business runner (40% stubs) |
| Marq | 8103 | App store publisher agent |
| DAM | 8104 | Do Anything Mode meta-orchestrator |
| Browser | 8107 | Headless Playwright automation |
| OpenClaw Broker | 8106 | ClawBot container runtime |
| Studio | 8108 | AI image generation + editing |
| Eliza Runtime | 8085 | ElizaOS autonomous agent runtime |
| Eliza Hub | 8083 | ElizaOS management dashboard |
| Discord Bridge | — | Discord bot integration |
| Forum Bot | — | AI content generation |

### v3-Deferred (code exists, not actively developed)

| Tool | Reason | Expected Return |
|------|--------|-----------------|
| HELM businesses | No active business yet | v4 "Open Doors" |
| SCC IDE | Design complete, build not started | v4 |
| Mobile App | Plan exists, not started | v4 |

### Archived (v2 restructuring — code deleted)

| Tool | Was Port | Fate | Notes |
|------|----------|------|-------|
| opai-orchestrator | 3737 | Merged into Engine | Scheduling, health, routing now in Engine |
| opai-monitor | 8092 | Merged into Engine | Metrics, logs now in Engine health tab |
| opai-tasks (TCP) | 8094 | Merged into Engine | Task management now in Engine + Team Hub |
| opai-chat | 8888 | Archived | Replaced by Telegram + Discord bridges |
| opai-terminal | 8095 | Archived | Replaced by SCC IDE plan |
| opai-docs | — | **Rebuilt** | Zero-process static SPA (Caddy-served, no port) |
| opai-orchestra | 8098 | Archived | UI concept, not operational |
| opai-bot-space | 8099 | Archived | Bot catalog deferred |
| opai-marketplace | — | Archived | Marketplace deferred to v4 |
| opai-messenger | 8083 | Archived | Internal messaging deferred |
| opai-forum | 8087 | Archived | Forum deferred |
| opai-agents | 8088 | Archived | Replaced by Engine workers |
| opai-benchmark | — | Archived | Testing harness, not needed currently |
| opai-tui | — | Archived | Terminal dashboard, replaced by Telegram |

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
│  - 72 system architecture docs              │
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
│  - reference/ — 27 docs: dev commands, APIs,│
│    glossary, env vars, disaster recovery,   │
│    tool selection, troubleshooting guides    │
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
