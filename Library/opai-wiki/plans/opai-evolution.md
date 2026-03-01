# OPAI Evolution Plan — v2 through v4

> **Created**: 2026-02-27 | **Status**: Active strategic document
> **Purpose**: Grounding context for positioning, conversations, and sprint planning.
> **Rule**: Update this doc when a version ships or scope changes. This is the source of truth for "where are we and where are we going."

---

## Version Summary

| Version | Codename | Core Theme | Status |
|---------|----------|------------|--------|
| **v2** | "The Operator" | Consolidated infrastructure + ClawBot foundation | **Live** (polish remaining) |
| **v3** | "Felix" | Autonomous OPAI — proactive, self-managing, family/business hub | **Phase 3.5 shipped** |
| **v4** | "Open Doors" | Revenue — OPAI-powered services for external users/clients | Planned |

### The One-Sentence Pitch Per Version

- **v2**: OPAI is a reliable, lean server that manages itself.
- **v3**: OPAI thinks for itself — it checks on work, learns from mistakes, and runs your businesses while you sleep.
- **v4**: Other people pay you because OPAI does things they can't do themselves.

---

## v2 — "The Operator" (CURRENT)

### What It Is

The infrastructure consolidation that took 28 services down to 10, introduced a unified Engine, vault-backed secrets, a worker runtime with guardrails, and the OpenClaw container system. This is the foundation everything else builds on.

### Completed

| Milestone | Details |
|-----------|---------|
| Unified Engine | 3 services (Orchestrator + Monitor + TCP) merged into one. Port 8080, 30 Python files, 20+ endpoints |
| Vault integration | 144 secrets, SOPS+age, tmpfs injection, pre-commit hook, 24 services migrated |
| Worker runtime | 12 workers registered, guardrails (file access, approval gates, rate limiting), prompt protection |
| Dashboard | 4-tab Engine UI (Command Center, Tasks, Workers, System), task modal, settings, keyboard shortcuts |
| Service cleanup | 28 → 10 services, 1.9GB → 665MB memory, 20+ → 8 ports |
| OpenClaw Broker | Port 8106, instance CRUD, vault bridge, container runtime, kill switch, credential audit trail |
| LLM Proxy | Containers call `claude -p` through broker. No API keys in containers. Rate limiting, semaphore (3 concurrent) |
| ClawHub Marketplace | Skill catalog synced to `ch_skills`, dual install (OC instances + Claude Code) |
| Container Auth | Per-instance callback tokens, SHA-256 hash verification |
| NAS Architecture | Design approved: Model A (internal workforce), Model B (user-attached), shared drive, manager bot |
| Telegram Bridge | Phases 1-4A live. Primary comms channel. Mini App auth bridge, WordPress Mini App |

### Remaining v2 Work (finish before v3)

| Task | Effort | Notes |
|------|--------|-------|
| Migrate bridged modules cleanup | 0.5 day | Delete old service dirs (opai-monitor, opai-tasks, opai-orchestrator) |
| Re-enable Brain service | 0.5 day | Was v3-deferred but already re-enabled for Phase 8.1 — verify stable |

**Deferred to future** (OC containers — subscription porting complexity):
- Build ClawBot Docker image, provision test container, NAS workspace mode, shared drive infra, manager bot instance. These are replaced by the native CC workforce (Phase 3.5) which uses `claude -p` processes directly.

**v2 is "done" when**: Engine manages all workers, vault-backed secrets, and dashboard operational. Container-based workforce replaced by native CC workforce in v3.5.

---

## v3 — "Felix" (NEXT MAJOR)

### What It Is

OPAI becomes an autonomous, proactive system — the Felix-class agent for your family and business. Instead of waiting for commands, it checks what needs doing, does it, learns from the results, and only bothers you when it genuinely needs a decision. This is the version where OPAI stops being a tool suite and starts being a digital team member.

### Why v3 Before Revenue

1. **The subscription advantage**: All v3 work runs on your existing Claude CLI subscription. Zero API cost. This is the thing competitors can't copy — they pay per token.
2. **The compound effect**: Every autonomous improvement OPAI makes to itself or your businesses saves you time tomorrow. Revenue features are linear; autonomy is exponential.
3. **The demo effect**: When you eventually show OPAI to clients (v4), they need to see a system that genuinely works autonomously — not a dashboard with stubs.

### v3 Phases

#### Phase 3.0 — Proactive Heartbeat (**SHIPPED 2026-02-28**)

**The single most impactful change.** OPAI stops waiting and starts checking.

| Component | What It Does | Where It Lives |
|-----------|-------------|----------------|
| Running Work Registry | Tracks what agents/sessions/ClawBots are actively doing | `tools/opai-engine/background/heartbeat.py` |
| 30-minute heartbeat | Scans registry for stalled, completed, or failed work | Engine background task (8th of 8) |
| Daily Note generation | Auto-summarizes what happened today: tasks completed, errors, decisions needed | `notes/daily/YYYY-MM-DD.md` (auto-generated at 23:55) |
| Stall detection + restart | Managed workers unhealthy for 2+ cycles → auto-restart (up to max_restarts) | Heartbeat logic |
| Completion notification | Finished work → alert via Telegram Bot API (direct, no Telegram service dependency) | `background/notifier.py` |
| API | `/api/heartbeat/latest`, `/daily-notes`, `/trigger` | `routes/heartbeat.py` |

**Implementation**: 4 new files (~750 lines), 3 modified files. Engine bumped to v3.0.0. Snapshot tracks 29 work items across workers, tasks, scheduler jobs, and Claude sessions. State persists across restarts via `data/heartbeat-state.json`. Full wiki: [`Library/opai-wiki/infra/heartbeat.md`](../infra/heartbeat.md).

**Success criteria**: You wake up and check Telegram. OPAI has already told you: "3 tasks completed overnight, 1 needs your decision, all services healthy."

**Depends on**: v2 Engine background tasks (already have the scheduler infrastructure)

#### Phase 3.1 — Memory Consolidation (**SHIPPED 2026-02-28**)

**OPAI remembers what happened and learns from it.**

| Component | What It Does | Where It Lives |
|-----------|-------------|----------------|
| Nightly consolidation cron | At 2am: review all sessions/conversations/logs from the day | Engine scheduler |
| Wiki auto-update | Extract stable facts → update `Library/opai-wiki/` entries | `wiki_librarian` worker |
| MEMORY.md pruning | Move stale entries to topic files, keep index lean | Consolidation job |
| Tacit knowledge file | Dynamic file of learned preferences: "Dallas prefers X", "always do Y before Z" | `memory/tacit-knowledge.md` |
| Correction tracking | When you correct OPAI, log the correction and the lesson | Tacit knowledge updates |

**Success criteria**: After a week of normal use, OPAI has auto-updated 5+ wiki entries and the tacit knowledge file reflects 3+ learned preferences without you manually writing them.

**Depends on**: Phase 3.0 (daily notes provide the raw material for consolidation)

#### Phase 3.2 — Authenticated Command Channels (**SHIPPED 2026-02-28**)

**Hard distinction between "this is Dallas commanding me" and "this is information from the world."**

| Channel | Classification | Auth Method |
|---------|---------------|-------------|
| Telegram (Dallas's device) | **Authenticated command** | Device token + Telegram user ID |
| Telegram (family group) | **Authenticated command** (scoped) | Group ID + user ID whitelist |
| Discord (admin channel) | **Authenticated command** | Guild + channel + role check |
| Discord (public channels) | **Information only** | Read context, never execute commands |
| Email (inbound) | **Information only** | Email agent classifies, never auto-executes |
| Web (Portal dashboard) | **Authenticated command** | Supabase JWT + admin role |
| ClawBot messages | **Information only** | Container callback token (read, don't obey) |

**The rule**: Only authenticated command channels can trigger actions that cost money, send messages externally, deploy code, or modify data. Everything else is context.

**Success criteria**: A prompt injection in a Discord message or email body cannot trigger OPAI to take any action. Only authenticated channels can.

**Implementation**: 2 new files (`services/command_gate.py`, `routes/command_channels.py`), 4 modified files. `CommandIntent` dataclass classifies trust per channel via `orchestrator.json` `command_channels` config. Three trust levels: `command` (auto-execute), `proposal` (requires approval), `context` (deny). Discord bridge passes `channelRole`/`guild_id`/`is_home_guild` metadata. Engine bumped to v3.2.0.

**Depends on**: Telegram Bridge (live), Discord Bridge (live) — both need auth layer additions

#### Phase 3.3 — Bottleneck Removal Engine (**SHIPPED 2026-02-28**)

**Track what you keep having to approve and suggest making it automatic.**

| Component | What It Does |
|-----------|-------------|
| Approval tracker | Log every HITL gate hit: what, when, who approved, how long it waited |
| Pattern detector | "Dallas has approved email-send 15 times this week with no rejections" |
| Auto-approval suggestions | Surface in Engine dashboard: "Suggest: auto-approve email-send for Email Agent?" |
| Graduated autonomy | Configurable per-worker: start at autonomy 3, suggest bumping to 5 after 30 clean approvals |
| Credential expansion suggestions | "Research worker has requested Stripe read access 4 times — grant it?" |

**The Nat Eliason principle**: *"Can I remove this bottleneck for you? Is there a way I can make it so that you never have to ask me this again?"*

**Success criteria**: After 2 weeks, OPAI surfaces 3+ auto-approval suggestions. After accepting them, the daily approval queue shrinks by 50%+.

**Implementation**: 3 new files (`services/approval_tracker.py`, `background/bottleneck_detector.py`, `routes/bottleneck.py`), 5 instrumented files. Persistent ring buffer (500 records) tracks all approval decisions across 3 gate points. Background detector runs every 6h with 3 pattern detectors (source auto-approve, worker action auto-approve, slow approval). Accept applies config changes (trust upgrades, gate removal) directly to `orchestrator.json`/`workers.json`. Dashboard subtab under System. Engine bumped to v3.3.0.

**Depends on**: Phase 3.0 (heartbeat tracks approvals), Engine guardrails (already built)

#### Phase 3.4 — HELM Activation

**HELM stops being 40% stubs and starts running a real business.**

| What | Current State | v3 Target |
|------|--------------|-----------|
| Business onboarding | 8-step wizard (built) | Working end-to-end with a real business |
| Content generation | Generates drafts (built) | Auto-publishes to WordPress via OP WordPress connector |
| Social media | `routes/social.py` empty, `jobs/social_post.py` missing | At least 1 platform posting (Twitter/X or LinkedIn) |
| Stripe revenue | Products/prices created (built) | Checkout flow live, webhooks processing |
| Weekly CEO report | Report format exists | Auto-generated every Monday, delivered via Telegram |
| Credential vault | Per-business Fernet encryption (built) | Self-healing on auth errors (built), tested with real creds |

**v3 target is ONE real business running through HELM**, not all features for all businesses. Pick the simplest one (a content site on Hostinger with Stripe checkout) and get it fully autonomous.

**Success criteria**: HELM publishes 2 blog posts/week, posts to 1 social platform, processes a Stripe payment, and sends a weekly summary — all without manual intervention.

**Depends on**: Phase 3.0 (heartbeat monitors HELM jobs), Phase 3.2 (CEO-gate via authenticated Telegram)

#### Phase 3.5 — Native CC Internal Workforce (**SHIPPED 2026-02-28**)

**The Engine becomes the fleet manager, using native `claude -p` processes.**

Architectural pivot: OC containers are deferred — porting the Claude subscription into containers required complex LLM proxy work. Instead, we extend the existing `claude -p` worker pattern (already running 6 task workers) into a coordinated workforce with workspace isolation.

| Component | What It Does | Where It Lives |
|-----------|-------------|----------------|
| Fleet Coordinator | Background loop (5min): gathers signals, identifies work, routes to workers | `background/fleet_coordinator.py` |
| Workspace Manager | Isolated per-worker directories on local NVMe (853GB) | `services/workspace_manager.py` |
| Fleet API | Status, history, manual dispatch, cancel, workspace stats | `routes/fleet.py` |
| Workspace-aware workers | Workers run in isolated dirs with injected context | `background/worker_manager.py` (extended) |

**How it works**: Fleet coordinator reads heartbeat + task registry + bottleneck suggestions every 5 minutes. Identifies approved tasks needing dispatch, matches them to workers via configurable routing map (`orchestrator.json`), creates isolated workspaces, dispatches via `worker_manager.run_task_worker()`, tracks completion, and updates task status.

**Key design decisions**:
- No separate "manager" instance — the Engine IS the manager
- Workers get isolated workspaces at `/workspace/local/agent-workspaces/{worker-id}/runs/{dispatch-id}/`
- Shared resources (CLAUDE.md, wiki, team.json) symlinked into workspaces
- Output collected to `reports/{date}/fleet/` and workspace cleaned up
- Rate limiting, concurrent dispatch limits (default 3), and stale dispatch detection
- Telegram notifications on completion/failure
- Manual override via `POST /api/fleet/dispatch`

**Implementation**: 3 new files (`services/workspace_manager.py`, `background/fleet_coordinator.py`, `routes/fleet.py`), 4 modified files (`config.py`, `orchestrator.json`, `worker_manager.py`, `app.py`). Engine bumped to v3.5.0.

**Success criteria**: Approved tasks get automatically dispatched to the right worker, run in isolated workspaces, output captured to reports, and Telegram notification sent. Manual dispatch works via API. Fleet status visible at `/api/fleet/status`.

**Depends on**: Phases 3.0-3.3 (heartbeat, task registry, command channels, bottleneck detection)

#### Phase 3.6 — Cross-System Intelligence

**OPAI connects the dots across its tools.**

| Connection | What It Does |
|-----------|-------------|
| Brain ↔ Daily Notes | Brain auto-ingests daily notes as research nodes |
| Email Agent → Team Hub | Actionable emails auto-create tasks (already partial — make reliable) |
| HELM → Team Hub | HELM actions create task registry entries (already planned — wire it) |
| Telegram → Everything | Any command via Telegram can trigger any OPAI action |
| Feedback → Fixes | Feedback auto-fixes ship without manual intervention (fixer model already exists) |

**Success criteria**: An email arrives with a client request → Email Agent classifies it → creates a Team Hub task → OPAI routes it to the right ClawBot or worker → work gets done → you get a Telegram summary. End-to-end.

### v3 Exit Criteria

v3 is "done" when:

1. OPAI sends you a morning briefing (Telegram) without being asked
2. At least 3 things happened overnight that OPAI handled autonomously
3. HELM runs one real business with weekly content + revenue tracking
4. Internal worker fleet (coordinator + task workers) handles delegated tasks autonomously
5. Memory consolidation has been running for 2+ weeks and the wiki is measurably better
6. You spend less time managing OPAI than OPAI saves you

---

## v4 — "Open Doors" (REVENUE)

### What It Is

OPAI-powered services for external users and clients. Not selling the system itself — selling what it produces. The key insight: **you don't sell the orchestra, you sell the concert tickets.**

### Revenue Streams (ordered by viability)

#### 4.1 — HELM Managed Businesses (Highest Priority)

OPAI runs businesses. The businesses make money. You keep the revenue minus hosting costs.

| Business Type | How HELM Runs It | Revenue Model |
|--------------|-----------------|---------------|
| Content/affiliate sites | WordPress + auto-content + SEO + social | Ad revenue, affiliate commissions |
| Digital product stores | WooCommerce + Stripe + email campaigns | Product sales |
| Client service businesses | Lead capture + email nurture + Stripe checkout | Service fees |
| SaaS micro-tools | Build with HELM + host on Hostinger (free) | Subscriptions |

**Cost structure**: Hostinger = free (agency plan). Claude = subscription (fixed). Stripe = 2.9% per transaction. Net margin: very high.

**First target**: One content site generating $500+/month passive income.

#### 4.2 — OPAI-Powered Agency Services (High Priority)

Sell OPAI's capabilities as done-for-you services.

| Service | What OPAI Does | What You Charge |
|---------|---------------|-----------------|
| AI customer support setup | OPAI deploys + trains a knowledge-base chatbot | $2,000-5,000 setup + $200-500/mo management |
| Content automation | HELM generates + publishes on their WordPress | $500-1,500/mo retainer |
| Business intelligence | Bx4 scans their market, competitors, financials | $1,000-3,000/engagement |
| System monitoring | OPAI monitors their infrastructure, alerts on issues | $200-800/mo |

**Key**: The client never touches OPAI. They get a dashboard (Portal Pages Manager can create per-client pages) and regular reports. All work happens internally.

#### 4.3 — ClawBot Personal Assistants (Model B) (Medium Priority)

Users get their own ClawBot in their NAS sandbox. This is where the v2 ClawBot infrastructure pays off, but repositioned:

- **BYOK model**: Client provides their own Anthropic API key. You charge for infrastructure only.
- **Alternatively**: OPAI proxies via CLI, metered per-message. Margin depends on subscription limits.
- **Pricing**: $29/79/149 per tier (already defined)

**Why medium priority**: This competes with commodity chatbot products. Viable but not the highest-margin play.

#### 4.4 — ClawHub Skill Marketplace (Lower Priority)

The skill marketplace already exists (`ch_skills`). Expand it:

- Free skills (attract users)
- Premium skills ($5-50 one-time or subscription)
- Custom skill development for clients
- Skill certification/verification (OPAI-verified badge)

**Why lower priority**: Needs a user base first. Build after 4.1-4.3 have traction.

### v4 Prerequisites (Must Be True Before Starting)

1. HELM has run at least one real business for 30+ days (v3.4)
2. Internal ClawBot team has been stable for 2+ weeks (v3.5)
3. Billing/Stripe integration is tested end-to-end (v2 billing service exists, needs real testing)
4. User onboarding flow works (Portal + sandbox provisioning)
5. At least one authenticated external user besides the admin team

### v4 Phases

#### Phase 4.0 — Billing Reactivation

Re-enable `opai-billing` service (v3-deferred). Test the full flow:

- Landing page (`opai.boutabyte.com/about`) → pricing → Stripe checkout
- Webhook processes payment → auto-provision user account + sandbox
- Welcome email + onboarding wizard
- Subscription management (upgrade/downgrade/cancel)

#### Phase 4.1 — First Paying Customer (HELM Business)

Launch one HELM-managed business and drive it to first revenue:

- Deploy site on Hostinger
- HELM manages content + social + email
- Stripe checkout live
- Track: time to first dollar, cost per dollar

#### Phase 4.2 — Agency Service Pilot

Offer one OPAI-powered service to one client:

- Client gets a Portal page with their dashboard
- OPAI handles the work internally
- You invoice monthly
- Track: delivery time, client satisfaction, margins

#### Phase 4.3 — ClawBot Beta (Model B)

Open ClawBot personal assistants to 3-5 beta users:

- Use BYOK or metered proxy
- NAS sandbox provisioning
- Per-user bot limits enforced
- Feedback collection → rapid iteration

### v4 Exit Criteria

v4 is "done" when:

1. At least $500/month recurring revenue from OPAI-powered activities
2. At least 1 paying external user (ClawBot or agency service)
3. Billing flow handles payments end-to-end without manual intervention
4. OPAI can onboard a new user from signup to working ClawBot in under 10 minutes

---

## Architecture Evolution Diagram

```
v2 "The Operator"                v3 "Felix"                      v4 "Open Doors"
──────────────────              ───────────────                  ─────────────────

  Engine (8080)                   Engine (8080)                    Engine (8080)
  ├─ Tasks                        ├─ Tasks                         ├─ Tasks
  ├─ Workers                      ├─ Workers                       ├─ Workers
  ├─ System                       ├─ System                        ├─ System
  └─ Command Center               ├─ Heartbeat Dashboard           ├─ Heartbeat Dashboard
                                  ├─ Memory/Learning View          ├─ Memory/Learning View
                                  └─ Autonomy Config               └─ Client Management

  OC Broker (8106)                OC Broker (8106)                 OC Broker (8106)
  ├─ Instance CRUD                ├─ Instance CRUD                 ├─ Instance CRUD
  ├─ Vault Bridge                 ├─ Vault Bridge                  ├─ Vault Bridge
  ├─ LLM Proxy                   ├─ LLM Proxy                    ├─ LLM Proxy
  └─ Runtime                      ├─ Runtime                       ├─ Runtime
                                  ├─ Fleet Manager (Manager bot)   ├─ Fleet Manager
                                  └─ Shared Drive Coordinator      ├─ Shared Drive Coordinator
                                                                   └─ Per-User Bot Provisioner

  [test containers]               [internal workforce]             [internal + client bots]
  └─ alpha-01 (test)              ├─ manager                       ├─ manager
                                  ├─ research-01                   ├─ research-01
                                  ├─ content-01                    ├─ content-01
                                  └─ monitor-01                    ├─ monitor-01
                                                                   ├─ denise-main (client)
                                                                   └─ client-X-bot (client)

  Telegram (commands)             Telegram (morning briefing)      Telegram (client channel)
  Discord (admin)                 Discord (alerts + info)          Discord (support)

  [no heartbeat]                  Heartbeat (30min cycle)          Heartbeat (30min cycle)
  [no memory consolidation]       Memory Consolidation (2am)       Memory Consolidation (2am)
  [no autonomy tracking]          Bottleneck Removal Engine        Bottleneck Removal Engine

  HELM (40% stubs)                HELM (1 live business)           HELM (multi-business)
  Brain (re-enabled)              Brain (auto-ingests daily notes) Brain (client knowledge)
  Billing (stopped)               Billing (tested, ready)          Billing (processing payments)
```

---

## Timeline Estimates

Not hard dates — effort estimates based on current velocity.

| Version | Phase | Effort | Cumulative |
|---------|-------|--------|------------|
| **v2 finish** | ClawBot image + test + NAS + Manager | 1-2 weeks | Weeks 1-2 |
| **v3.0** | Proactive heartbeat | 3-5 days | Week 3 |
| **v3.1** | Memory consolidation | 3-5 days | Week 4 |
| **v3.2** | Authenticated channels | 2-3 days | Week 4-5 |
| **v3.3** | Bottleneck removal | 2-3 days | Week 5 |
| **v3.4** | HELM activation (1 business) | 1-2 weeks | Weeks 6-7 |
| **v3.5** | ClawBot internal workforce | 1 week | Week 8 |
| **v3.6** | Cross-system intelligence | 1 week | Week 9 |
| **v4.0** | Billing reactivation | 2-3 days | Week 10 |
| **v4.1** | First revenue (HELM business) | 2-4 weeks | Weeks 11-14 |
| **v4.2** | Agency pilot | 1-2 weeks | Weeks 15-16 |
| **v4.3** | ClawBot beta | 1-2 weeks | Weeks 17-18 |

**Aggressive target**: v3 fully operational by end of April 2026. v4 first revenue by end of May 2026.

---

## Key Decisions to Make

| # | Decision | When | Options |
|---|----------|------|---------|
| 1 | Which business does HELM run first? | v3.4 start | Content site / digital product / service business |
| 2 | BYOK vs metered proxy for client ClawBots? | v4.3 | BYOK (simpler, lower margin) vs proxy (complex, higher margin, subscription gray area) |
| 3 | Family members as first beta users? | v4.3 | Denise + Caitlin test the personal assistant flow before strangers |
| 4 | Pricing finalization | v4.0 | $29/79/149 or different tiers based on v3 cost data |
| 5 | Open source any component? | v4+ | ClawBot image? ClawHub skills? Nothing? |

---

## What Each Version Means for Daily Life

### v2 (now)
You manage OPAI. You tell it what to do. It does it well. You check dashboards, approve tasks, restart services. OPAI is a powerful tool.

### v3 (next)
OPAI manages itself and briefs you. You wake up, check Telegram, see what happened overnight. You make decisions. OPAI handles everything else. OPAI is a team member.

### v4 (after)
OPAI makes money. HELM businesses generate revenue. Clients pay for services. You focus on strategy and family. OPAI is a business partner.

---

*This document is the strategic north star. Update it when versions ship, scope changes, or key decisions are made.*
