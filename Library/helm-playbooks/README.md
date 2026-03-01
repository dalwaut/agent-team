# HELM Business Playbooks

> **Purpose:** Curated library of validated business models, service offerings, and revenue strategies that HELM can autonomously research, plan, and execute.

## How HELM Uses This Library

When instructed to "plan and build a business," HELM follows this pipeline:

```
1. Browse playbooks in this folder
2. Evaluate each against market conditions (web research, trend data)
3. Cross-reference with existing OPAI infrastructure (what's already built)
4. Score and rank opportunities (market size, effort, alignment, timing)
5. Present top candidates for approval (CEO-gate for financial decisions)
6. Upon approval: plan → build → launch → operate autonomously
```

## Playbook Entry Format

Each playbook is a self-contained brief. HELM reads these to understand what a business/service IS, how to deliver it, and what infrastructure is needed.

### Required Sections

| Section | Purpose |
|---------|---------|
| **What Is It** | One-paragraph description of the service/product |
| **Market Opportunity** | Size, growth rate, timing, competition level |
| **How It Works** | Step-by-step delivery method — what HELM actually does |
| **Revenue Model** | Pricing, margins, billing frequency, upsells |
| **Tools & Infrastructure** | What's needed to deliver — existing OPAI tools, new builds, third-party services |
| **OPAI/HELM Integration** | What already exists, what needs building, estimated effort |
| **Source** | Where the idea came from (video, research, manual input) |
| **Status** | `Idea` > `Researched` > `Ready to Build` > `Active` > `Retired` |

### Optional Sections

| Section | Purpose |
|---------|---------|
| **Sales Motion** | How to acquire customers (outreach, lead gen, inbound) |
| **Deliverables** | What the customer receives (reports, websites, dashboards, etc.) |
| **Risks & Gotchas** | What could go wrong, dependencies, market risks |
| **Competitive Landscape** | Who else does this, how we differentiate |
| **Implementation Phases** | If complex, break into buildable phases |

## Playbook Index

| Playbook | Status | Category | Revenue Potential |
|----------|--------|----------|-------------------|
| [GEO Audit & Optimization Service](geo-audit-service.md) | Idea | Agency / Marketing | High ($1K-5K/client) |
| [AIOS Consulting & Vertical Packages](aios-consulting-service.md) | Idea | Consulting | Very High ($8K-30K/client + $1.5K-5K/mo retainer) |

---

## Categories

- **Agency / Marketing** — Services sold to businesses (audits, optimization, content)
- **SaaS / Product** — Recurring software products HELM builds and operates
- **Commerce** — Physical or digital product sales via managed storefronts
- **Content / Media** — Revenue from content creation, publishing, monetization
- **Consulting** — High-touch advisory services with AI-powered delivery

## Adding New Playbooks

1. Create `<slug>.md` in this folder using the format above
2. Add a row to the Playbook Index table in this README
3. Set status to `Idea` initially
4. When R&D is complete, update to `Researched` with findings
5. When implementation plan exists, update to `Ready to Build`
6. HELM promotes to `Active` when the business is live and operating
