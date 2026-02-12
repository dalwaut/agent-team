# OPAI Ideas & Roadmap

> **How this document works:** Drop raw ideas into the **Inbox** section below. When reviewed, each idea gets fleshed out with description, feasibility, difficulty, dependencies, and suggested approach — then moved into the appropriate category further down. The Inbox should be empty after each review pass.

---

## Inbox

<!-- Drop raw ideas here. Format: just a title and a sentence or two. -->
<!-- Example: -->
<!-- ### My New Idea -->
<!-- Brief description of what I want. -->



---

## Difficulty & Feasibility Key

| Rating | Difficulty | Meaning |
|--------|-----------|---------|
| 1 | Trivial | A few hours, no new dependencies |
| 2 | Easy | 1-2 days, straightforward implementation |
| 3 | Moderate | 3-5 days, some architectural decisions needed |
| 4 | Hard | 1-2 weeks, significant design and integration work |
| 5 | Major | 2+ weeks, multiple systems, potential infrastructure changes |

| Feasibility | Meaning |
|-------------|---------|
| High | Can be done with current tools and knowledge |
| Medium | Requires some research or new tooling |
| Low | Requires significant infrastructure, budget, or external services |

---
# Ideas

## Bot Ideas

These ideas relate to the Discord Bridge bot (`tools/discord-bridge/`) and its interaction model.

---

### 2. Delegated Processing / Multi-Node Execution

**Status:** Proposed
**Difficulty:** 5 (Major)
**Feasibility:** Medium
**Category:** Infrastructure / Scaling

**Description:**
Enable the OPAI system to distribute work across multiple machines on the network. When a request comes in (via Discord, CLI, or future UI), a dispatcher evaluates the task and routes it to an available worker node. Each node runs its own Claude CLI instance and reports results back to the dispatcher, which aggregates and delivers the response.

**What it solves:**
- Single-machine bottleneck (one Claude session at a time)
- Long-running tasks blocking the bot for other users
- No parallelism for multi-agent squad runs across machines

**Suggested approach:**
1. **Phase 1 — Simple queue + worker model:**
   - Central task queue (Redis, SQLite, or even a shared JSON file on network drive)
   - Worker script that polls the queue, runs Claude CLI, writes result back
   - Dispatcher in the bot checks for completed results
   - Start with 2 nodes: primary (current PC) + one secondary

2. **Phase 2 — Smart routing:**
   - Task classification (quick query vs. deep analysis vs. code generation)
   - Route by estimated complexity and node availability
   - Health monitoring per node (CPU, active sessions, last heartbeat)

3. **Phase 3 — Full mesh:**
   - Any node can accept work and delegate to others
   - Shared knowledge base (Library/ synced via git or Syncthing)
   - Centralized logging to a single dashboard

**Dependencies:** Second machine with Claude CLI access (Pro Max subscription is per-account, works from any device), network file sharing or message broker, queue system

**Risks:**
- Claude Pro Max may have undocumented concurrent session limits
- Network latency adds overhead for small queries
- Shared state management becomes complex quickly

**Effort estimate:** Phase 1: ~1 week. Phase 2: ~1 week. Phase 3: ~2 weeks.

---

## System Ideas

These ideas relate to the OPAI infrastructure, hosting, and system architecture.

---

### 6. Linux Server — OPAI Central Hub

**Status:** Proposed — **NEXT PRIORITY**
**Difficulty:** 3 (Moderate — server already exists and is stable)
**Feasibility:** High
**Category:** Infrastructure / DevOps

**Server:** Local physical Ubuntu LTS server, already running and stable for months. 100% local — no VPS, no cloud hosting.

**Description:**
Migrate the OPAI system from the current Windows desktop to the existing local Ubuntu server, which becomes the **central hub** for all OPAI operations. This isn't just a "move the bot" migration — the server becomes the brain: the place where all work is performed or offloaded to, where automated processes run 24/7, and where event-driven and time-triggered activities fire without human intervention. The Discord bot runs indefinitely, email checks happen on schedule, folder watchers trigger agent actions, and the Frontend Dashboard (#7) provides a management UI accessible on the local network (and optionally over the internet via `boutabyte.cloud`).

**What it solves:**
- Bot goes offline when the PC sleeps or reboots
- Windows-specific issues (path handling, PowerShell quirks, `&` in paths)
- No proper process supervision (currently using a .bat restart loop)
- Can't run scheduled agent tasks overnight or unattended
- No event-driven automation (file changes, new emails, webhook triggers)
- No always-on interface for remote management
- Work is tied to a single desktop session

**Vision — The OPAI Server Hub:**

The server is the **always-on operations center**. It handles three categories of work:

1. **Persistent Services** (run forever):
   - Discord bot — indefinite uptime, handles conversations + task routing
   - Frontend Dashboard (#7) — web UI at `boutabyte.cloud` for management
   - Approval server — email draft review UI
   - WP-Agent API — WordPress management endpoints

2. **Scheduled Triggers** (cron / systemd timers):
   - Email check — every 15-30 min across 4 accounts, auto-classify + extract tasks
   - Queue processor — periodically retry blocked/queued operations
   - Agent health checks — daily system health audit
   - Report generation — scheduled squad runs (e.g., nightly `audit` on key projects)
   - Library sync — pull latest n8n workflows, update indexes

3. **Event-Driven Automation** (file watchers / webhooks):
   - **Folder watchers** — monitor key directories for changes and trigger actions:
     - `tasks/queue.json` changes → auto-process new queue items
     - `reports/HITL/` new files → notify via Discord that human review is needed
     - `Obsidian/Projects/*/Agent-Tasks/` → pick up new agent tasks
     - Incoming file drops (e.g., client uploads) → classify and route
   - **Webhook receivers** — accept triggers from external services:
     - GitHub webhooks → trigger review/audit squads on push
     - n8n webhook callbacks → process completed workflow results
     - Hostinger deployment events → post-deploy checks

**Discord as the Remote Interface:**
Discord becomes the primary remote command channel — not just for chat, but for:
- Direct conversations with Claude (current `!@` prefix)
- Task delegation (`!@ task: ...`) from anywhere
- System monitoring (`!@ status`, `!@ jobs`)
- Email management (`!@ check email`, `!@ approve`)
- **Future: Group/team use** — extend bot to handle multiple users, role-based permissions, team channels for different projects

**Suggested approach:**

1. **Phase 1 — Core migration (~3-5 days):**
   - Server is already running Ubuntu LTS — no OS install needed
   - Install Node.js 20 LTS, Python 3.12+, Claude CLI
   - Clone/rsync OPAI workspace to the server
   - Port critical PowerShell scripts to bash (or install PowerShell Core)
   - Set up systemd services: Discord bot, email manager, approval server
   - Verify Claude CLI authentication and session management on Linux
   - Set up Syncthing or git sync for Obsidian vault ↔ desktop (notes remain editable locally)

2. **Phase 2 — Automation layer (~1 week):**
   - systemd timers for: email check (15min), queue processor (30min), daily health audit
   - File watchers via `inotifywait` (inotify-tools) or Node.js `chokidar`:
     - Watch `tasks/queue.json` → auto-trigger `process_queue`
     - Watch `reports/HITL/` → Discord notification
   - Webhook endpoint (Express or Caddy) for GitHub + n8n callbacks
   - Centralized logging: `journalctl` + log rotation for all services

3. **Phase 3 — Dashboard integration (~2 weeks, overlaps with #7):**
   - Deploy Frontend Dashboard — accessible on LAN immediately
   - Optional: expose via `boutabyte.cloud` with Caddy reverse proxy + auto-SSL (requires port forwarding or tunnel)
   - Connect dashboard to live data: task registry, agent status, logs, email queue
   - Replace port 3847 approval UI with integrated dashboard panel

4. **Phase 4 — Hardening:**
   - Firewall (ufw): restrict to necessary ports
   - If exposed to internet: Fail2ban for SSH, Caddy auto-SSL, rate limiting
   - Automated backups (daily rsync to second location or NAS)
   - Health monitoring: simple uptime checks, disk space alerts via Discord

5. **Phase 5 — User Personas & Delegated Access (~1-2 weeks):**
   All access is powered by one Claude Max subscription on the server. This phase adds a permission layer so multiple people can use the system with scoped access — no extra API costs.

   - **User personas** — each user gets a profile defining:
     - Identity: name, Discord ID, dashboard login
     - Role: `admin` (full control), `developer` (agents + tasks + projects), `viewer` (read-only dashboards + reports), `client` (scoped to their project only)
     - Allowed agents/squads: whitelist which agents a user can trigger
     - Allowed projects: restrict visibility to specific `Obsidian/Projects/` folders
     - File access: which directories they can read/browse through the dashboard
     - System control: can they start/stop services, process queues, approve emails?

   - **Access channels** — permissions enforced across all interfaces:
     - **Discord:** Identify users by Discord ID. Bot checks persona before executing commands. Clients get a project-specific channel, devs get full `!@` access, viewers get read-only responses.
     - **Dashboard (#7):** JWT login per user. UI panels show/hide based on role. API endpoints enforce persona permissions server-side.
     - **CLI (future):** SSH users mapped to personas, restricted to allowed scripts/agents.

   - **Persona config** — stored in `config/users.json` or similar:
     ```
     {
       "dallas": { "role": "admin", "discord_id": "...", "access": "all" },
       "dev1":   { "role": "developer", "projects": ["BoutaChat", "ByteSpace"], "agents": ["reviewer", "test_writer"] },
       "client1": { "role": "client", "projects": ["Lace & Pearl"], "agents": [], "view_only": true }
     }
     ```

   - **Delegation flow:**
     - Admin assigns tasks to specific users or to agents on their behalf
     - Developers can trigger squads on their allowed projects — Claude executes via the single server CLI session
     - Clients can view project status, reports, and task progress — but can't trigger agents or access other projects
     - All requests funnel through the same Claude Max subscription — the server is the single execution point

   - **Audit trail:** Every action logged with who requested it, what persona was used, and what was accessed

**Dependencies:** Claude CLI Linux installation (officially supported), SSH access to local server, `boutabyte.cloud` DNS control (optional, for remote access)

**Risks:**
- PowerShell scripts need porting to bash (or use pwsh on Linux) — mitigated by gradual port
- Obsidian vault sync needs a solution (Syncthing recommended — bidirectional, real-time)
- Claude Pro Max session from Linux may require re-authentication — test early
- Claude CLI competes across sessions — bot should be the primary CLI user on the server
- Phase 5: Claude CLI is single-session — concurrent user requests need queuing (job-manager pattern already exists)

**Effort estimate:** Phase 1: ~3-5 days. Phase 2: ~1 week. Phase 3: ~2 weeks (parallel with #7). Phase 4: ~2-3 days. Phase 5: ~1-2 weeks.

---

### 7. Frontend Dashboard UI — OPAI Control Center

**Status:** Proposed — builds on #6 (server hub)
**Difficulty:** 4 (Hard)
**Feasibility:** High (upgraded from Medium — server hub makes this straightforward)
**Category:** UX / System Management

**Description:**
A web-based dashboard for managing the entire OPAI system, hosted on the local Ubuntu server. Accessible immediately on the LAN, and optionally exposed to the internet at **`boutabyte.cloud`** for remote access. This is the visual control center that sits on top of the Linux server hub (#6). It provides real-time visibility into running agents, task queues, system health, logs, email management, and a direct Claude chat interface. Discord handles mobile/remote conversations and quick commands; the dashboard handles structured data, approvals, and deep management.

**What it solves:**
- No visibility into what agents are doing without reading log files
- Discord is the only interface (limited formatting, no structured data display)
- No way to kill a runaway task, view queue status, or monitor system health at a glance
- Email approval UI is a separate port 3847 process — should be unified
- Can't share system status with team members who aren't on Discord
- No structured project overview across 30+ active projects

**Suggested approach:**

1. **Tech stack:**
   - **Frontend:** React + Vite + Tailwind (matches existing expertise) or Next.js for SSR
   - **Backend:** Express.js API server reading from OPAI data files (co-hosted on the Linux server)
   - **Real-time:** WebSocket (Socket.io) for live log streaming, agent status, and file watcher events
   - **Auth:** JWT auth with secure login — this faces the public internet
   - **Domain:** `boutabyte.cloud` (primary) or `hub.boutabyte.cloud` (subdomain)

2. **Core panels:**
   - **Dashboard:** System health (CPU, memory, disk, uptime), active services status, recent reports summary
   - **Agents:** Running/queued/completed agents, kill switch, log viewer per run, squad launcher
   - **Tasks:** Unified task registry (`tasks/registry.json`), filter by assignee/project/priority, delegate to agents, escalate to human
   - **Email:** Full email manager UI — replaces port 3847 approval server. Classified emails, pending drafts, approve/edit/reject, send. Across all 4 accounts.
   - **Reports:** Browse `reports/` directory, view latest, HITL items needing human review with inline action buttons
   - **Chat:** Direct Claude interaction (browser-based, bypasses Discord), conversation history, session management
   - **Logs:** Live-tail of all service logs with filtering (bot, email, agents, system)
   - **Projects:** List of 30+ managed projects, status overview, quick actions (run audit, view tasks, open in Obsidian)
   - **Settings:** Service control (start/stop/restart services), watcher config, schedule config

3. **Deployment (integrated with #6):**
   - Runs as a systemd service on the local Ubuntu server
   - Accessible on LAN immediately (e.g., `http://server-ip:3000`)
   - Optional internet exposure: Caddy reverse proxy + `boutabyte.cloud` DNS + auto-SSL
   - Same server as all other OPAI services — zero additional cost

**Dependencies:** Linux server hub (#6) operational. Optional: `boutabyte.cloud` DNS + port forwarding/tunnel for remote access

**Risks:**
- Scope creep — MVP first, iterate. Don't build all panels at once.
- Security surface — JWT auth + rate limiting + firewall. No exposed internal endpoints.
- Maintenance burden — keep it a thin layer over existing data files, not a separate data store

**Effort estimate:** MVP (dashboard + tasks + logs + email): ~2 weeks. Full version with all panels: ~4-6 weeks. Overlaps with #6 Phase 3.

---

# Priority Matrix

| # | Idea | Diff. | Feasibility | Impact | Status |
|---|------|-------|-------------|--------|--------|
| 6 | Linux Server — OPAI Central Hub | 3 | High | Critical | **NEXT** — server exists, just needs OPAI deployed |
| 7 | Frontend Dashboard (boutabyte.cloud) | 4 | High | High | Builds on #6, Phase 3 overlap. MVP after server stable |
| 2 | Delegated Processing / Multi-Node | 5 | Medium | Medium | **Future** — multi-machine parallelism, needs #6 first |

---

# Completed Ideas

### #3 — Async Response Queue
**Completed:** 2026-02-11
**Location:** `tools/discord-bridge/index.js`, `tools/discord-bridge/job-manager.js`
**Notes:** Non-blocking message handler (fire-and-forget), job tracking in `data/active-jobs.json`, restart recovery, 15-min timeout (up from 5 min), `!@ status` command.

### #1 — Bot Character / Persona System
**Completed:** 2026-02-11
**Location:** `tools/discord-bridge/persona.js`, `tools/discord-bridge/persona.json`
**Notes:** 3 presets (professional, casual, playful), rotating processing messages, persona-driven errors/ack/timeouts, `!@ persona` switch command.

### #5 — Work Companion / Task Router Agent
**Completed:** 2026-02-11
**Location:** `tools/work-companion/index.js`, `tools/work-companion/routes.json`
**Notes:** Keyword-based classifier (13 task types incl. email_task + communication), maps to squads/agents, queues to `tasks/queue.json`, Discord `!@ task:` command, standalone CLI. Integrated with email manager for automatic email-to-task routing.

### #4 — Email Checker / Task Extractor → Email Manager & Task Creator
**Completed:** 2026-02-11
**Location:** `tools/email-checker/` (index.js, classifier.js, response-drafter.js, sender.js, supabase-sync.js, approval-server.js, approval-ui/)
**Notes:** Full email management system with 4 accounts (Gmail + Hostinger). IMAP via imapflow, Claude CLI (Haiku) for task extraction + classification + response drafting. Three-step response loop: Draft → Critique → Refine. HTML approval UI on port 3847, Discord approval commands (`!@ email tasks`, `!@ email drafts`, `!@ approve/reject`). Nodemailer SMTP sending with thread continuity. Optional Supabase persistence (`em_*` tables). Work-companion integration for task routing. OPAI `email_manager` agent + `email` squad added to team.json.
