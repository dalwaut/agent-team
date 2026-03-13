# Playbook: AI Operating System Consulting & Vertical Packages

**Status:** Draft
**Category:** Consulting
**Source:** [I Built an AI Operating System in Claude Code (Here's How to Sell It) — Mansel Scheffel](https://www.youtube.com/watch?v=-GV1MRNB4hQ)
**Date Added:** 2026-02-28
**Last Updated:** 2026-03-05

---

## What Is It

A premium consulting service where HELM audits a business, identifies their operational constraints, and builds them a customized AI Operating System (AIOS) — a structured workspace where AI agents follow their exact processes, understand their business context, and operate autonomously. The client gets a fully configured system (agent roles, skills, integrations, dashboards), training for their team, and an optional retainer for ongoing maintenance and evolution. Think of it as "OPAI-as-a-Service" — we take the infrastructure we already run and deploy a tailored version for each client's business.

---

## Market Opportunity

| Metric | Value |
|--------|-------|
| Target market | SMBs and mid-market companies ($1M-$50M revenue) drowning in manual workflows |
| AI consulting market | $20B+ and growing 30%+ annually |
| Competition | Low for full-system AIOS — most agencies sell individual automations, not operating systems |
| Buyer pain | Teams repeat themselves constantly, workflows live in people's heads, no process structure around AI usage |
| Timing | Early — most businesses still use AI as a chatbot. The "operating system" framing is new and compelling |
| Moat | OPAI's 42-role agent framework, 26 squads, and full infrastructure stack would take competitors years to replicate |

**Why now:** Businesses know they need AI but don't know how to operationalize it. They've tried ChatGPT, maybe some automations, but nothing sticks because there's no system behind it. The ones who get a structured AIOS first will outperform their competitors dramatically. First consultants who can deliver this win the market.

---

## How It Works

### Phase 1: Business Audit (1-2 days)

HELM conducts a structured audit of the target business:

1. **Constraint mapping** — What are the bottlenecks? Where does the team waste time?
2. **Workflow discovery** — What processes live in people's heads? What's documented? What's automated already?
3. **Tool inventory** — What do they use today? (CRM, email, project management, comms, billing)
4. **Team assessment** — Who's technical? Who's a champion? Who's a skeptic?
5. **Integration requirements** — What systems need to talk to each other?
6. **Priority ranking** — Which problems, if solved, would have the highest impact?

**Deliverable:** Audit report with scored findings and recommended AIOS architecture.

### Phase 2: System Build (1-2 weeks)

Build their customized AIOS:

1. **Core configuration** — Business context, rules, guardrails, brand voice, operating procedures
2. **Agent roles** — Custom roles tailored to their business (e.g., "Sales Assistant", "Client Onboarding Coordinator", "Invoice Processor")
3. **Skills/workflows** — Self-contained workflows for their top-priority processes (email triage, lead research, content generation, report building, etc.)
4. **Integrations** — Connect to their existing tools (Gmail, Slack/Teams, CRM, project management, billing)
5. **Communication channel** — Telegram/Slack/Teams bot for on-the-go commands and alerts
6. **Dashboard** — Portal view for non-technical team members

### Phase 3: Training & Deployment (2-3 days)

1. **Technical team training** — How to maintain, extend, and debug the system
2. **End user training** — How to use the dashboard, trigger workflows, interpret outputs
3. **Champion identification** — Find 2-3 internal advocates who will drive adoption
4. **Skeptic conversion** — Demonstrate quick wins to hesitant team members
5. **Documentation handoff** — Their own wiki/handbook for the system

### Phase 4: Retainer & Evolution (ongoing)

1. **Monthly health check** — Is the system being used? What's working? What's not?
2. **New workflow builds** — Add skills as the business identifies new use cases
3. **Integration maintenance** — Handle API changes, new tools, broken connections
4. **Performance reporting** — Quantify time saved, tasks automated, ROI delivered
5. **Quarterly reviews** — Strategic planning session for next quarter's AI evolution

---

## Revenue Model

| Tier | Price | Scope | Margin |
|------|-------|-------|--------|
| Audit Only | $2,000-3,000 | Phase 1 — scored report + architecture recommendation | ~90% |
| Full Build | $8,000-15,000 | Phases 1-3 — audit, build, train, deploy | ~75% |
| Enterprise Build | $15,000-30,000 | Full build + multiple departments + complex integrations | ~70% |
| Monthly Retainer | $1,500-5,000/mo | Phase 4 — maintenance, new workflows, support | ~85% |
| Vertical Package | $5,000-10,000 | Pre-built industry AIOS + customization | ~80% |

**Unit economics:** HELM does 80%+ of the build work autonomously. The audit is partially automated (agent squads scan their existing tools, identify patterns). Training materials are templated. The high margins come from OPAI doing the heavy lifting while the human consultant focuses on relationship and strategy.

**Upsell path:** Audit → Full Build → Retainer → Additional departments → Vertical expansions → GEO optimization (cross-sell with GEO playbook)

---

## Vertical AIOS Packages

Pre-built industry templates that reduce build time from 2 weeks to 2-3 days:

| Vertical | Key Skills | Target Buyer |
|----------|-----------|--------------|
| **Real Estate** | Listing research, client follow-up, market reports, showing scheduler, contract drafts | Brokerages, property managers |
| **Legal** | Case research, document drafting, deadline tracking, client intake, billing summaries | Small/mid law firms |
| **Marketing Agency** | Content calendar, competitor analysis, client reporting, social scheduling, GEO audits | Agency owners |
| **E-commerce** | Inventory alerts, customer service triage, order tracking, review monitoring, pricing analysis | Shopify/WooCommerce stores |
| **Healthcare Practice** | Appointment reminders, patient follow-up, insurance verification, referral management | Clinics, dental offices |
| **Trades/Construction** | Job scheduling, estimate generation, material tracking, client updates, invoice processing | Contractors, builders |

Each vertical is a HELM playbook within this playbook — a pre-configured skill pack that gets customized per client.

---

## Tools & Infrastructure Needed

### Already Exists in OPAI

| Tool | How It's Used |
|------|---------------|
| Agent Framework (42 roles, 26 squads) | Core of every AIOS deployment — roles get customized per client |
| Claude Code CLI (`claude -p`) | Powers all agent execution |
| HELM | Orchestrates the entire service lifecycle (audit → build → deploy → maintain) |
| Telegram Bridge | Client communication channel (27+ commands, already built) |
| Email Agent v5 | Email triage/digest skill (ready to deploy) |
| Portal + Tool UIs | Dashboard for non-technical users |
| ClawHub Marketplace | Skill distribution and installation |
| TeamHub | Track client projects and deliverables |
| Billing/Stripe | Invoice clients |
| Vault | Securely store client credentials per-deployment |
| Templates/ | Project and agent templates for rapid client onboarding |

### Needs Building

| Component | Effort | Description |
|-----------|--------|-------------|
| Business audit squad | Medium | Agent squad that scans a business (website, tools, workflows) and produces a scored audit report |
| AIOS template generator | Medium | Takes audit output → generates customized CLAUDE.md, agent roles, skill files, folder structure |
| Client onboarding wizard | Low | Guided flow to collect business info, tool access, team roster |
| Vertical skill packs | Medium (per vertical) | Pre-built skill bundles for each industry vertical |
| ROI tracking dashboard | Low | Track time saved, tasks automated, dollars recaptured per client |
| White-label option | Low | Remove OPAI branding, use client's brand for their AIOS |

---

## OPAI/HELM Integration

**This is the most natural HELM service.** OPAI literally IS an AI Operating System. We're not building something new — we're packaging what already exists and deploying it for clients.

**The flow:**

1. HELM identifies target businesses (outreach, referrals, inbound from GEO-optimized content)
2. HELM runs business audit squad on the target
3. HELM generates audit report (PDF — cross-reference with PDF generation R&D)
4. Consultant presents findings, closes the deal
5. HELM generates customized AIOS from audit findings + vertical template
6. HELM deploys and configures integrations
7. Consultant runs training sessions (templated curriculum)
8. HELM enters retainer mode — monthly health checks, new workflow builds
9. HELM invoices via Stripe

**Roadmap alignment:**
- v3 "Felix" — HELM uses this internally (OPAI IS its own AIOS, prove the model works)
- v4 "Open Doors" — HELM offers this as a paid consulting service to external clients

---

## Sales Motion

1. **Lead generation** — Content marketing about "AI Operating Systems" (blog, YouTube, LinkedIn). GEO-optimized so AI search recommends us. Free audit reports as lead magnets (same pattern as GEO playbook).
2. **Free audit hook** — "I'll audit your business for AI readiness. Takes 60 seconds. Here's what I found." Send the PDF report.
3. **Discovery call** — Walk through findings. Identify their biggest pain point. Show how the AIOS solves it.
4. **Proof of concept** — Build one skill live on the call or in a follow-up session. "Watch me automate your email triage in 10 minutes."
5. **Proposal** — Customized scope based on audit. Tiered pricing (audit-only, full build, enterprise).
6. **Close** — Start with the full build. Retainer follows naturally once they see value.
7. **Expand** — Additional departments, new verticals, team growth = more seats and workflows.
8. **Referral engine** — Happy clients refer other businesses. Offer referral discount.

---

## Deliverables (What the Client Gets)

| Deliverable | Format |
|-------------|--------|
| Business audit report | PDF (scored, visual, branded) |
| Customized AIOS workspace | Configured folder structure + all files |
| Agent role definitions | Tailored to their business functions |
| Skill workflows | 5-15 automated workflows (based on tier) |
| Integration configs | Connected to their existing tools |
| Communication bot | Telegram/Slack/Teams bot for on-the-go access |
| Dashboard access | Portal view for non-technical team members |
| Training materials | Video walkthroughs + written guides |
| Monthly health reports | Usage stats, ROI tracking, recommendations |

---

## Risks & Gotchas

- **Change management is the hard part** — The technology works. Getting humans to trust and adopt it is the real challenge. Budget consulting time for this.
- **Client credential security** — Storing client API keys, OAuth tokens, etc. requires rock-solid vault infrastructure (OPAI Vault exists but needs per-client isolation).
- **Scope creep** — Clients will want "one more workflow" endlessly. Clear scope definitions in contracts are essential.
- **Claude Code subscription dependency** — Clients need their own Claude subscription ($20-200/mo). This is an external cost we don't control.
- **Support burden** — Broken integrations, API changes, user errors. Retainer pricing must account for support time.
- **Commoditization risk** — As AI tools improve, building an AIOS gets easier. Differentiate on domain expertise and relationship, not just the tech.
- **Legal/liability** — Clear contracts that the AIOS is a tool, not a replacement for professional judgment. Especially important in regulated verticals (legal, healthcare).

---

## Competitive Landscape

- **Traditional automation agencies** (Zapier/Make/n8n shops) — Sell individual automations, not operating systems. We're selling the whole orchestra, they're selling one instrument.
- **OpenClaw-based builders** — Exist but architecturally limited. Container overhead, no native skill system, harder to maintain.
- **AI consulting firms** (McKinsey, Accenture, Deloitte) — Enterprise-focused, $500K+ engagements. We target the SMB/mid-market they ignore.
- **Freelance prompt engineers** — Sell prompts, not systems. No infrastructure, no maintenance, no ongoing relationship.
- **OPAI advantage:** We have a production-grade AI operating system already running. We're not building from scratch per client — we're deploying a proven platform with customization. That's a massive time and quality advantage.

---

## Implementation Timeline

### Pre-Launch (Before First Client)

| Step | Owner | Duration | Status |
|------|-------|----------|--------|
| 1. Package audit as a repeatable process | HELM + Dallas | 3 days | Not started |
| 2. Build audit report template (PDF/HTML) | Builder agent | 2 days | Not started |
| 3. Create client onboarding wizard in Portal | Builder agent | 3 days | Not started |
| 4. Build 1 vertical skill pack (Marketing Agency) | HELM + Builder | 5 days | Not started |
| 5. Set up per-client Vault isolation | Builder agent | 1 day | Not started |
| 6. Write service agreement template | Dallas | 1 day | Not started |
| 7. Create pricing calculator (input: audit results -> scope -> price) | Builder agent | 2 days | Not started |
| 8. Build ROI tracking dashboard | Builder agent | 2 days | Not started |
| 9. First pilot client identified and approached | Dallas | 1 week | Not started |
| 10. Pilot engagement completed + case study | HELM + Dallas | 4 weeks | Not started |

**Estimated total pre-launch:** 6-8 weeks from start

### Per-Client Deployment (After System is Ready)

| Phase | Duration | Effort (hours) |
|-------|----------|----------------|
| Audit | 1-2 days | 4-8 hrs consulting + HELM automation |
| Build | 5-10 days | 8-16 hrs consulting + HELM builds autonomously |
| Train | 2-3 days | 6-10 hrs consulting |
| Handoff | 1 day | 2-4 hrs |
| **Total per client** | **2-3 weeks** | **20-38 hrs human time** |

---

## Concrete Next Steps (Priority Order)

1. **Validate pricing with 3 prospect conversations** — Share the audit concept with businesses Dallas already knows. Confirm willingness to pay $2K-3K for an audit alone.
2. **Build the audit squad** — Create an agent squad that scans a business website, identifies tools (via script tags, meta, etc.), and produces a scored report.
3. **Create the Marketing Agency vertical pack** — Most natural fit (Paradise Web already serves this market). 5-7 skills: content calendar, competitor alerts, client reporting, social scheduling, email triage.
4. **Run a pilot** — Offer a free or discounted audit to one real business. Use the results to refine the process and build the case study.
5. **Write the landing page** — GEO-optimized page explaining AIOS consulting. Deploy via Portal Pages Manager to opai.boutabyte.com.

---

## Ready for Review Checklist

- [x] Market opportunity validated (growing market, low competition at SMB level)
- [x] Revenue model defined with margins
- [x] Phase-by-phase delivery process documented
- [x] Tools mapped to OPAI capabilities
- [x] Risks identified with mitigations
- [x] Sales motion defined
- [x] Vertical packages identified (6 verticals)
- [x] Competitive landscape analyzed
- [x] Implementation timeline estimated
- [x] Concrete next steps prioritized
- [ ] Pricing validated with real prospects (needs Dallas)
- [ ] Legal: service agreement template drafted
- [ ] First pilot client identified
- [ ] Audit squad built and tested
- [ ] 1 vertical skill pack completed
