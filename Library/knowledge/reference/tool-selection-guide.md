# OPAI Tool Selection Guide

> **Purpose:** When you have a task, this guide tells you which OPAI tool, agent, or squad to use.
> For agents (HELM, DAM, business_analyst, etc.) and humans deciding "where does this go?"
> **Last updated:** 2026-03-05

---

## Quick Decision Tree

```
What kind of task is it?
│
├─ BUILD something new
│   ├─ Full product (idea → ship) ──────── Assembly Line (/assembly via Telegram or API)
│   ├─ Implement a specific feature ────── Builder agent (./scripts/run_builder.sh)
│   ├─ Evaluate an idea first ──────────── PRD Pipeline (port 8097, or PRDgent agent)
│   └─ Generate images/visuals ─────────── Studio (port 8108)
│
├─ MANAGE ongoing operations
│   ├─ Track tasks/projects ────────────── Team Hub (port 8089)
│   ├─ Monitor system health ───────────── Engine dashboard (port 8080)
│   ├─ Manage WordPress sites ──────────── OP WordPress (port 8096)
│   ├─ Handle email operations ─────────── Email Agent (port 8093)
│   ├─ Manage credentials/secrets ──────── Vault (port 8105)
│   ├─ File management ─────────────────── Files (via Portal)
│   └─ User administration ─────────────── Users (port 8084)
│
├─ RESEARCH or ANALYZE
│   ├─ Knowledge/notes management ──────── Brain (port 8101)
│   ├─ Business intelligence ───────────── Bx4 (port 8100)
│   ├─ Market/competitor research ──────── HELM (port 8102) + business_analyst agent
│   ├─ Code quality audit ─────────────── audit squad (./scripts/run_squad.sh -s "audit")
│   ├─ Security review ────────────────── secure squad (./scripts/run_squad.sh -s "secure")
│   ├─ Deep-dive any topic ────────────── rd_analyst agent or R&D squad
│   └─ YouTube/Instagram content ───────── Brain (research tab) + YouTube/Instagram MCP
│
├─ COMMUNICATE
│   ├─ Primary comms (alerts, commands) ── Telegram (port 8110)
│   ├─ Discord community ──────────────── Discord Bridge
│   ├─ Email outreach/responses ────────── Email Agent
│   └─ Newsletters ────────────────────── Engine daily_agent_newsletter cron
│
├─ RUN A BUSINESS autonomously
│   ├─ Full business operation ─────────── HELM (port 8102)
│   ├─ App store publishing ────────────── Marq (port 8103)
│   ├─ Invoice/billing ────────────────── Billing (Stripe integration)
│   └─ Any arbitrary goal ─────────────── DAM Bot (port 8104)
│
└─ AUTOMATE a browser task
    └─ Web scraping / interaction ──────── Browser (port 8107, Playwright)
```

---

## Tool-by-Tool Reference

### Core Platform

| Tool | When to Use | When NOT to Use |
|------|-------------|-----------------|
| **Engine** (8080) | System health, worker management, heartbeat control, fleet coordination, action items | Direct task management (use Team Hub) |
| **Portal** (8090) | Login, dashboard navigation, pages management | Anything beyond navigation |
| **Team Hub** (8089) | Task/project tracking, sprint planning, HITL decisions, agent task assignment | Code execution (use Builder), research (use Brain) |
| **Telegram** (8110) | Quick commands, HITL approvals, alerts, on-the-go management | Long-form content creation, complex workflows |
| **Vault** (8105) | Store/retrieve credentials, environment variables, API keys | Storing non-secret configuration (use config files) |

### Tools & Agents

| Tool | When to Use | When NOT to Use |
|------|-------------|-----------------|
| **Brain** (8101) | Knowledge capture, research synthesis, concept mapping, YouTube/Instagram analysis | Task tracking (use Team Hub), business operations (use HELM) |
| **HELM** (8102) | Autonomous business operation, content calendars, competitor research, revenue strategy | Internal OPAI development tasks (use Builder/squads) |
| **Bx4** (8100) | Financial analysis, market intelligence, social analytics, operations metrics | Simple lookups (use Brain), task management (use Team Hub) |
| **DAM** (8104) | Complex multi-step goals with no clear tool, meta-orchestration | Simple tasks with a clear tool assignment |
| **Marq** (8103) | App store submissions, metadata management, review monitoring | Non-app-store publishing tasks |
| **PRD Pipeline** (8097) | Evaluating product ideas, scoring viability, creating project scaffolds | Implementing features (use Builder after PRD approves) |
| **Studio** (8108) | Image generation, visual editing, canvas work | Text content (use Brain or HELM), video (not supported yet) |
| **Assembly Line** | End-to-end autonomous builds (idea through ship) | Quick fixes (use Builder), research-only (use Brain) |
| **Billing** | Stripe product/price management, checkout, subscriptions | Internal cost tracking (manual), non-Stripe payments |

### Integrations

| Tool | When to Use | When NOT to Use |
|------|-------------|-----------------|
| **Email Agent** (8093) | Multi-account email monitoring, classification, response drafting, transcript processing | Marketing email campaigns (use HELM + email platform) |
| **OP WordPress** (8096) | WordPress site management, plugin updates, content deployment, WooCommerce | Non-WordPress sites, pure HTML/static sites |
| **Browser** (8107) | Web scraping, form automation, screenshot capture, testing | API-available data (use direct API calls instead) |
| **Discord Bridge** | Discord community management, bot commands | Primary comms (use Telegram) |
| **Forum Bot** | Automated forum content generation | Manual forum posting |

---

## Agent & Squad Selection

### "I need a code review"

| Scope | Use This |
|-------|----------|
| Quick review of recent changes | `review` squad |
| Full codebase audit | `audit` squad |
| Security-focused review | `secure` squad |
| Pre-release checks | `ship` squad |
| Accessibility audit | `a11y` squad |
| Mobile app review | `mobile` squad |

### "I need something built"

| Scope | Use This |
|-------|----------|
| Single feature/fix with clear spec | Builder agent (`./scripts/run_builder.sh -t "task"`) |
| Full product from idea | Assembly Line (`/assembly` via Telegram) |
| Converted n8n workflow | n8n-Forge pipeline then `forge` squad |
| Feature architecture planning | `plan` squad |

### "I need research"

| Scope | Use This |
|-------|----------|
| Topic deep-dive with implementation brief | `rd` squad (R&D Analyst) |
| Business/market analysis | `business_analyst` agent |
| Product idea evaluation | `prdgent` agent (via PRD Pipeline) |
| Technical library/API research | `researcher` agent |
| Competitive landscape | HELM + `business_analyst` |

### "I need operations/maintenance"

| Scope | Use This |
|-------|----------|
| Workspace hygiene | `hygiene` or `workspace` squad |
| Dependency updates | `dep_scan` squad or `node_update` squad |
| Secrets scan | `secrets_scan` squad |
| Email triage | `email` squad |
| Wiki updates | `wiki` squad |
| Incident investigation | `incident` squad |
| Self-improvement | `evolve` squad |

---

## Multi-Tool Workflow Patterns

### Client Onboarding
```
HELM (intake) → Vault (credentials) → Team Hub (project) → WordPress (site setup) → Email Agent (welcome)
```

### Content Creation
```
Brain (research) → Studio (visuals) → HELM (schedule) → WordPress (publish) → Email Agent (newsletter)
```

### Idea to Revenue
```
PRD Pipeline (evaluate) → Assembly (build) → Team Hub (track) → Billing (monetize) → HELM (operate)
```

### Incident Response
```
Engine heartbeat (detect) → Telegram (alert) → Team Hub (track) → Builder (fix) → wiki squad (document)
```

---

## Common Mistakes

| Mistake | Better Approach |
|---------|----------------|
| Using DAM Bot for simple tasks | Use the specific tool directly |
| Using Brain for task tracking | Use Team Hub — Brain is for knowledge, not tasks |
| Using Telegram for complex workflows | Start in Telegram, but the work happens in the relevant tool |
| Running `audit` squad for a quick fix | Use Builder agent for targeted fixes |
| Building from scratch when n8n-Forge exists | Check if an n8n workflow covers the use case first |
| Using Browser for API-available data | Direct API calls are faster, cheaper, and more reliable |
| Asking HELM to do OPAI internal development | HELM is for business operations, not platform development |

---

## Quick Command Reference

```bash
# Run a specific squad
./scripts/run_squad.sh -s "audit"
./scripts/run_squad.sh -s "secure"
./scripts/run_squad.sh -s "review"

# Run the builder on a specific task
./scripts/run_builder.sh -t "Add dark mode to Brain" --context tools/opai-brain

# Run Supabase SQL
./scripts/supabase-sql.sh "SELECT count(*) FROM profiles"

# Service control
./scripts/opai-control.sh {start|stop|restart|status|logs}

# Assembly Line (via Telegram)
/assembly <idea description>
```
