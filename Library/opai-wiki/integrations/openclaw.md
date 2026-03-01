# OpenClaw — Techniques & OPAI Integration Strategy

> **Status**: Research / Pre-Implementation
> **Created**: 2026-02-25
> **Source**: [Nat Eliason / Peter Yang — "Full Tutorial: Use OpenClaw to Build a Business That Runs Itself"](https://youtu.be/nSBKCZQkmYw)
> **Related**: `Research/open-claw-integration-plan.md` (containerization architecture), `notes/Improvements/authenticated-channel-layers.md`

---

## 1. What Is OpenClaw

OpenClaw is a framework that turns Claude Code into a **persistent, autonomous agent** you control via Telegram (or other chat interfaces). It adds three core capabilities missing from vanilla Claude Code:

1. **Persistent memory** across sessions
2. **Cron jobs** for scheduled/proactive behavior
3. **Heartbeat** — periodic self-check that keeps long-running work alive

Nat Eliason's bot "Felix" demonstrates the ceiling: an autonomous agent that builds products, manages Twitter, handles crypto, processes sales — generating $3,500+ in its first week.

---

## 2. Key Techniques from Felix (Mapped to OPAI)

### 2.1 Authenticated vs Information Channels

**Felix's approach**: All input is classified into two layers:
- **Authenticated command channel** — Only Nat's physical device via Telegram can issue commands. This is the *only* way to control Felix.
- **Information channel** — Twitter mentions, emails, web data = read-only context. Prompt injections from Twitter are ignored because they aren't authenticated input.

**OPAI mapping**: See `notes/Improvements/authenticated-channel-layers.md`. Our Discord bridge, Portal, mobile app, and email agent all need this same separation. Critical for OpenClaw deployment where bots have Stripe keys, API access, and system control.

**Implementation priority**: HIGH — must be in place before giving any ClawBot financial or deployment access.

| Felix | OPAI Equivalent | Status |
|-------|----------------|--------|
| Telegram (authenticated) | Discord admin channel + device auth | Planned |
| Twitter mentions (info) | Discord public channels, email, web | Planned |
| Device-locked control | Device token registry | Planned |

### 2.2 Three-Layer Memory System

**Felix's approach** (Thiago Forte PARA-based):

| Layer | Purpose | Contents |
|-------|---------|----------|
| **Life Directory** (Knowledge Graph) | Facts about entities | Projects, people, resources, relationships |
| **Daily Notes** | What happened today | Active projects, conversations, decisions, blockers |
| **Tacit Knowledge** | How I operate | Preferences, patterns, lessons from mistakes, security rules, trusted channels |

Plus:
- **QMD** (Quick Markdown) — fast indexed search across all markdown files, replaces default Claude memory lookup
- **Nightly consolidation cron** — at 2am, reviews ALL conversations from the day, extracts important info, updates all three layers, re-indexes

**OPAI mapping**:

| Felix Layer | OPAI Equivalent | Current State | Gap |
|-------------|----------------|---------------|-----|
| Life Directory | `Library/opai-wiki/` + MEMORY.md | Exists but manual | Need auto-update from conversations |
| Daily Notes | `logs/` + orchestrator state | Partial — logs exist, no structured daily note | Need daily note generation |
| Tacit Knowledge | `CLAUDE.md` + conventions | Exists but static | Need dynamic learning from corrections |
| QMD search | Grep + Glob across workspace | Manual tool calls | Need indexed search (QMD or equivalent) |
| Nightly consolidation | Orchestrator heartbeat | Orchestrator runs but doesn't consolidate memory | Need memory consolidation cron |

**Implementation plan**:
- [ ] Add `memory/daily/` directory for auto-generated daily notes
- [ ] Add nightly cron in orchestrator: review day's sessions → update wiki + MEMORY.md
- [ ] Evaluate QMD or build equivalent indexed markdown search
- [ ] Add tacit knowledge file that updates from corrections/preferences

### 2.3 Multi-Threaded Conversations

**Felix's approach**: Telegram group chats with the bot create separate conversation threads. Each thread = separate Claude session with isolated context. Felix can work on 5 things simultaneously:
- EasyClaw development
- Twitter management
- iOS app build
- Polylog editor
- Ad-hoc bug fixes

**OPAI mapping**: Our Discord bridge already supports per-channel sessions. Extend to:

| Felix | OPAI Equivalent | Status |
|-------|----------------|--------|
| Telegram group threads | Discord channels per topic | Partial — exists but not formalized |
| Isolated sessions per thread | `session-manager.js` per channel | Exists |
| 5 concurrent workstreams | Multiple agent sessions | Exists via orchestrator |

**Gap**: We don't have a formal "create a new workstream" flow. Need a `/workstream` command that creates a Discord channel + dedicated session + tracked context.

### 2.4 Heartbeat + Proactive Cron Jobs

**Felix's approach**:
- **Heartbeat** (every 30 min): Checks daily note for open projects. If a session should be running and isn't → restart it. If finished → report to Nat.
- **Twitter crons** (6-8/day): Check mentions, draft tweets, report engagement
- **Sales cron**: Daily Stripe sales summary
- **Memory consolidation cron**: Nightly at 2am

**OPAI mapping**:

| Felix Cron | OPAI Equivalent | Status |
|------------|----------------|--------|
| Heartbeat (check open work) | Orchestrator heartbeat | Exists — extend to check agent sessions |
| Twitter crons | N/A (no social media agent yet) | Future — HELM Phase 4 |
| Sales reporting | HELM Stripe sync | Stub exists, not wired |
| Memory consolidation | — | Not built |
| Proactive tweeting | — | Future via HELM social |

**Key insight**: The heartbeat checking daily notes for stalled work is the most impactful pattern. Our orchestrator should:
1. Maintain a "running work" registry (what agents are doing)
2. Heartbeat checks registry every 30 min
3. Stalled work → auto-restart or alert
4. Completed work → notify admin via Discord

### 2.5 Delegation to Sub-Agents (RALPH Loops)

**Felix's approach**: For big programming tasks, Felix doesn't do the work directly. Instead:
1. Writes a PRD for the task
2. Spawns a Codex session in a **RALPH loop** (Read-Act-Log-Plan-Heal)
3. Monitors the session via heartbeat
4. Reports completion to Nat

Critical fixes Nat discovered:
- **Don't spawn in `/tmp`** — gets cleaned out, kills long sessions
- **Track spawned sessions in daily notes** — so heartbeat knows what to check
- **Auto-restart failed sessions** — don't wait for human to notice

**OPAI mapping**: This is exactly what DAM Bot is designed for:

| Felix Pattern | OPAI Equivalent | Status |
|--------------|----------------|--------|
| PRD → Codex delegation | DAM Bot plan tree → agent execution | Phase 1 complete |
| RALPH loops | Squad execution with retry | Partial |
| Session tracking in daily notes | `dam_steps` table | Exists |
| Heartbeat monitoring | DAM scheduler (stall detection) | Exists (30 min timeout) |
| Don't use /tmp | Agent workspaces in `Projects/` | Already correct |

### 2.6 Progressive Access Expansion

**Felix's approach** — don't give everything at once:
1. **Week 1**: Memory system + basic conversations
2. **Week 2**: GitHub access → can build and push code
3. **Week 3**: Vercel + Railway → can deploy
4. **Week 4**: Stripe (isolated account) → can handle payments
5. **Week 5**: Twitter (own account) → can post publicly
6. **Always**: Separate accounts from personal. Felix has his own Twitter, Stripe, email, crypto wallet.

**OPAI mapping for OpenClaw rollout**:
1. Memory + knowledge base (Brain integration)
2. Code workspace (sandbox provisioning)
3. Deployment access (Vercel/Railway/Hostinger via HELM)
4. Stripe (HELM business Stripe, isolated)
5. Social (HELM Phase 4)
6. Always: per-client isolated credentials via Vault

### 2.7 Bottleneck Removal Philosophy

**Nat's core principle**: *"Can I remove this bottleneck for you? Is there a way I can make it so that you never have to ask me this again?"*

Every time Felix asks for permission or help:
1. Solve the immediate problem
2. Ask: can I automate this away permanently?
3. If yes → give access / create automation / remove the gate

**OPAI mapping**: This should be a design principle for all OPAI agents:
- Track repeated HITL approvals → suggest auto-approval rules
- Track repeated "I need X access" → suggest credential grants
- Track repeated manual steps → suggest cron jobs or automations
- CEO-gate (HELM) should shrink over time, not grow

---

## 3. Architecture Comparison

```
Felix (OpenClaw)                    OPAI (Current)
─────────────────                   ──────────────
Mac Mini (dedicated)                OPAI Server (VPS)
Telegram (chat interface)           Discord Bridge + Portal
Single Claude Code session          25+ services + orchestrator
Markdown files (memory)             Wiki + MEMORY.md + Supabase
Cron jobs (built-in)                Orchestrator heartbeat + Bot Space
Heartbeat (built-in)                Orchestrator (needs extension)
1 bot, 1 user                      Multi-user, multi-agent
Manual Stripe setup                 Billing service + HELM
No containerization                 Docker containers (planned)
```

**OPAI advantage**: We already have the infrastructure Felix built manually (orchestrator, monitoring, billing, multi-agent). What we lack is the **memory consolidation** and **proactive heartbeat** patterns that make Felix feel autonomous.

**Felix advantage**: Simplicity. One bot, one user, tight feedback loop. OPAI's complexity (25+ services) means we need more structure around these patterns.

---

## 4. Implementation Roadmap (Post-OpenClaw Integration)

### Phase 0: Memory Foundation (Do First)
- [ ] Implement 3-layer memory: wiki (knowledge graph), daily notes, tacit knowledge
- [ ] Build nightly consolidation cron in orchestrator
- [ ] Evaluate QMD vs custom indexed search
- [ ] Test with OPAI Bot (Discord bridge) as first consumer

### Phase 1: Authenticated Channels (Do First)
- [ ] Implement authenticated vs information channel classification
- [ ] Device-specific auth for command layer
- [ ] Apply to Discord bridge, then extend to all surfaces

### Phase 2: Enhanced Heartbeat
- [ ] Running work registry (what agents/sessions are active)
- [ ] Heartbeat checks registry every 30 min
- [ ] Auto-restart stalled sessions
- [ ] Notify admin on completion/failure
- [ ] Track in daily notes

### Phase 3: Sub-Agent Delegation
- [ ] PRD-driven delegation (DAM Bot + Codex-style)
- [ ] RALPH loop pattern for long-running builds
- [ ] Session persistence (not /tmp)
- [ ] Heartbeat monitoring of delegated work

### Phase 4: Progressive Autonomy
- [ ] Bottleneck tracking (what does the bot ask for repeatedly?)
- [ ] Auto-approval suggestion engine
- [ ] Credential expansion workflow
- [ ] Autonomy level tuning per ClawBot instance

### Phase 5: OpenClaw Container Integration
- [ ] Per-client ClawBot containers (see `Research/open-claw-integration-plan.md`)
- [ ] Each container gets memory system, heartbeat, cron jobs
- [ ] OPAI backbone manages lifecycle, billing, monitoring
- [ ] Knowledge base upload + indexing

---

## 5. Critical Takeaways for OPAI

1. **Memory is the #1 unlock** — Not more tools, not more access. A good memory system that consolidates daily conversations into searchable knowledge transforms a chatbot into an autonomous agent.

2. **Heartbeat + daily notes = proactivity** — The bot doesn't wait to be told. It checks what it should be doing and does it. This is the gap between our current orchestrator (reactive) and Felix (proactive).

3. **Authenticated channels are non-negotiable** — Before giving any bot financial or deployment access, it MUST differentiate between "this is my owner commanding me" and "this is information from the world."

4. **Start simple, expand access gradually** — Don't give a ClawBot everything on day one. Memory first, then code, then deploy, then money, then public presence.

5. **Remove bottlenecks, don't add gates** — Every HITL approval should be viewed as a temporary measure. The goal is to make the bot capable enough that the gate can be removed.

6. **Separate accounts always** — Bots get their own Stripe, their own Twitter, their own email. Never share credentials with the owner's personal accounts.

---

## 6. Tools & References

| Tool | Purpose | URL |
|------|---------|-----|
| OpenClaw | Claude Code ↔ Telegram bridge + cron + heartbeat | github.com/nichochar/open-claw |
| QMD | Fast markdown file indexing/search | Toby (Shopify) — integrated into Claude |
| Felix Craft | Felix's product hub | felixcraft.ai |
| Easy Claw | Hosted Felix instance platform | easyclaw.ai |
| PARA Method | Thiago Forte's organizational system | fortelabs.com |
| Banker Bot | Ethereum token creation + fee splitting | Twitter/X bot |

---

*This document is a living reference. Update as OpenClaw techniques are implemented in OPAI.*
