# Service Delivery Workflow — Lead to Invoice

> **Purpose:** End-to-end workflow for delivering agency services through OPAI/HELM.
> Covers the full lifecycle: lead acquisition, scoping, delivery, invoicing, and retention.
> Used by HELM, business agents, and human operators.
> **Last updated:** 2026-03-05

---

## Workflow Overview

```
LEAD ──→ QUALIFY ──→ PROPOSE ──→ CONTRACT ──→ SETUP ──→ DELIVER ──→ INVOICE ──→ RETAIN
  │         │          │           │           │         │           │          │
  │         │          │           │           │         │           │          └─ Renewal
  │         │          │           │           │         │           └─ Stripe
  │         │          │           │           │         └─ HELM autonomous
  │         │          │           │           └─ Vault + integrations
  │         │          │           └─ Billing + contract
  │         │          └─ Pricing framework
  │         └─ Brain + Bx4 research
  └─ Inbound or outreach
```

---

## Stage 1: Lead Acquisition

### Inbound Leads
| Source | OPAI Tool | Auto-Processing |
|--------|----------|-----------------|
| Website contact form | Email Agent | Classify as lead, create Team Hub item |
| Email inquiry | Email Agent | Classify, draft response, flag for review |
| Telegram message | Telegram Bridge | Route to HELM if business inquiry |
| Referral | Manual | Log in Team Hub, credit referral source |

### Outbound Leads (HELM-driven)
| Method | OPAI Tool | Process |
|--------|----------|---------|
| GEO audit outreach | HELM + audit squad | Auto-audit target site, generate PDF, send via Email Agent |
| Content marketing | HELM + Brain + WordPress | Publish expertise content, capture leads via forms |
| Social outreach | HELM | Identify prospects, personalize outreach |
| Cold email | Email Agent + HELM | Templated sequence with personalization |

**Key rule:** Every lead gets logged in Team Hub within 24 hours with source attribution.

---

## Stage 2: Qualification

### Qualification Criteria

| Criterion | Method | Tool |
|-----------|--------|------|
| Budget fit | Discovery call or email exchange | Team Hub (notes) |
| Service fit | Match needs to playbooks | HELM + `Library/helm-playbooks/` |
| Technical fit | Can we integrate with their stack? | Brain research |
| Timeline fit | Can we deliver within their deadline? | Team Hub capacity check |
| Cultural fit | Will they trust AI-assisted delivery? | Human judgment |

### Scoring (HELM auto-scores when possible)

| Score | Meaning | Action |
|-------|---------|--------|
| 8-10 | Strong fit | Fast-track to proposal |
| 5-7 | Moderate fit | Schedule discovery call |
| 1-4 | Poor fit | Polite decline or refer elsewhere |

**Team Hub status:** `Lead` -> `Qualified` or `Disqualified`

---

## Stage 3: Scoping & Proposal

### Scoping Process

1. **Identify service package** from `Library/helm-playbooks/`
   - GEO Audit & Optimization
   - AIOS Consulting & Vertical Packages
   - WordPress Management
   - Content Marketing
   - Custom scope

2. **Determine tier** from `agency-pricing-framework.md`
   - Match client size, complexity, and budget to tier
   - Calculate cost basis (Claude tokens + server + human time)
   - Apply target margin

3. **Define deliverables**
   - Specific, measurable outputs per milestone
   - Timeline with phase gates
   - What is included vs. out of scope (explicit boundaries)

4. **Draft proposal**
   - HELM generates proposal from template
   - Sections: Executive Summary, Scope, Deliverables, Timeline, Pricing, Terms
   - Human reviews before sending

### Proposal Template Structure

```
1. Executive Summary (2-3 sentences — what we will do and the expected outcome)
2. Current State Assessment (what we found in research/audit)
3. Proposed Solution (service package + customizations)
4. Deliverables & Timeline (table: milestone, deliverable, date)
5. Investment (pricing table: item, price, frequency)
6. Terms (payment terms, cancellation, IP ownership)
7. Next Steps (how to proceed)
```

**Team Hub status:** `Qualified` -> `Proposal Sent`

---

## Stage 4: Contract & Payment

### Contract Elements

| Element | Source |
|---------|--------|
| Scope of work | From proposal |
| Payment terms | Net 15 or Net 30, per pricing framework |
| Cancellation clause | 30-day notice for retainers |
| IP ownership | Client owns deliverables, we retain methodology |
| AI disclosure | "Services are delivered using AI-assisted tools" |
| Confidentiality | Standard NDA terms |
| Liability cap | Limited to fees paid in prior 12 months |

### Payment Processing

```
Client accepts proposal
    │
    ├─ One-time project? ──→ Stripe invoice (50% upfront, 50% on completion)
    │
    └─ Retainer? ──────────→ Stripe subscription (monthly recurring)
```

**Tools:** Billing tool (Stripe integration), Email Agent (send invoice/receipt)

**Team Hub status:** `Proposal Sent` -> `Contracted`

---

## Stage 5: Delivery

### Delivery Models

| Model | Description | HELM Role |
|-------|-------------|-----------|
| **Autonomous** | HELM operates within defined parameters, reports results | Primary operator |
| **Assisted** | HELM prepares, human reviews before each action | Draft + review cycle |
| **Guided** | Human directs, HELM executes specific tasks | Task executor |

### Delivery Cadence

| Service Type | Typical Cadence | Report Frequency |
|-------------|----------------|------------------|
| GEO Optimization | Weekly actions, monthly re-audit | Monthly |
| WordPress Management | Continuous monitoring, weekly updates | Bi-weekly |
| Content Marketing | 2-4 pieces/week, monthly calendar | Weekly |
| AIOS Build | Daily during build phase | Daily standup summary |
| AIOS Retainer | Monthly health check + new workflows | Monthly |

### Quality Gates

Every deliverable passes through:
1. **HELM auto-check** — Does it meet the spec? (automated)
2. **Human spot-check** — Random 20% review for first 30 days, then 10% (manual)
3. **Client acceptance** — Major milestones require client sign-off

### Escalation Triggers

| Trigger | Action |
|---------|--------|
| Deliverable rejected by client | Human reviews, adjusts scope or quality, re-delivers |
| HELM uncertain about brand voice | Flags to human before sending |
| Technical blocker | Log in Team Hub, escalate to human developer |
| Scope creep request | Document in Team Hub, quote as change order |

**Team Hub status:** `Contracted` -> `In Progress` -> milestones tracked

---

## Stage 6: Invoicing

### Invoice Schedule

| Type | Trigger | Tool |
|------|---------|------|
| Project milestone | Milestone completed + client accepted | Billing (Stripe invoice) |
| Monthly retainer | 1st of each month (auto) | Billing (Stripe subscription) |
| Change order | Approved scope change | Billing (Stripe invoice) |
| Final invoice | Project completion | Billing (Stripe invoice) |

### Payment Follow-up

| Day | Action | Tool |
|-----|--------|------|
| Day 0 | Invoice sent | Billing + Email Agent |
| Day 7 | Friendly reminder if unpaid | Email Agent (automated) |
| Day 14 | Second reminder | Email Agent (automated) |
| Day 21 | Human escalation | Telegram alert to owner |
| Day 30 | Service pause warning | Email Agent (human-approved) |

**Team Hub status:** milestones -> `Invoiced` -> `Paid`

---

## Stage 7: Retention & Growth

### Monthly Health Check (HELM automated)
- Review KPIs against goals
- Generate performance report
- Identify upsell opportunities
- Flag any risks or issues

### Quarterly Business Review (human + HELM)
- Present results (ROI, traffic, revenue impact)
- Review strategy alignment
- Propose next quarter's focus
- Discuss scope expansion

### Retention Signals

| Signal | Meaning | Action |
|--------|---------|--------|
| Client engagement increasing | Happy client | Propose expanded scope |
| Response times slowing | Losing interest | Schedule check-in call |
| Support tickets increasing | Something is wrong | Investigate root cause |
| Referring others | Very happy | Formalize referral program |
| Asking about cancellation | At risk | Human intervention immediately |

### Upsell Paths

```
GEO Audit ──→ Full GEO Optimization ──→ Content Marketing ──→ AIOS Build
WordPress Mgmt ──→ Content Marketing ──→ GEO Optimization ──→ AIOS Build
Any Service ──→ Additional sites/brands ──→ Retainer expansion
```

---

## Metrics to Track

| Metric | Target | Tool |
|--------|--------|------|
| Lead-to-proposal conversion | >30% | Team Hub |
| Proposal-to-close conversion | >40% | Team Hub |
| Time to first deliverable | <48 hours after kickoff | Team Hub |
| Client satisfaction (NPS) | >8/10 | Quarterly survey |
| Monthly recurring revenue (MRR) | Growing month-over-month | Billing (Stripe) |
| Client retention rate | >90% quarterly | Billing (Stripe) |
| Average revenue per client | >$2,000/month | Billing (Stripe) |

---

## References

| Document | Path |
|----------|------|
| Client Onboarding Checklist | `Library/knowledge/reference/client-onboarding-checklist.md` |
| Agency Pricing Framework | `Library/knowledge/reference/agency-pricing-framework.md` |
| Tool Selection Guide | `Library/knowledge/reference/tool-selection-guide.md` |
| HELM Business Handoff | `Templates/helm-business-brief.md` |
| HELM Playbooks | `Library/helm-playbooks/` |
