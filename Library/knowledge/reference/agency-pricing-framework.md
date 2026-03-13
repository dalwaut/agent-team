# Agency Pricing Framework

> **Purpose:** Pricing methodology for OPAI/HELM agency services.
> Used by HELM, business_analyst agent, and human operators when quoting clients.
> Covers cost modeling, tiering, and competitive positioning.
> **Last updated:** 2026-03-05

---

## Pricing Philosophy

**Core principle:** Price based on **value delivered**, not hours worked. OPAI's AI-powered delivery means our cost basis is a fraction of traditional agencies. We price competitively against manual agencies while maintaining high margins because our delivery cost is low.

**Three anchors:**
1. **Client value** — What is the outcome worth to them? (hours saved, revenue generated, risk reduced)
2. **Market rate** — What do traditional agencies charge for equivalent services?
3. **Cost floor** — What does it actually cost us to deliver? (tokens + server + human time)

**Rule:** Never price below 3x cost floor. Target 5-10x for high-value services.

---

## Cost Model

### Fixed Costs (Monthly)

| Resource | Monthly Cost | Notes |
|----------|-------------|-------|
| Server (HP Z420 local) | ~$30 (electricity) | All services run locally |
| Claude Code subscription | $200 (Max plan) | Primary AI backbone |
| Supabase | $25 (Pro plan) | Database + auth |
| Caddy/Domain | ~$15 | Reverse proxy + domains |
| Synology NAS | ~$10 (electricity) | File storage + sync |
| **Total fixed** | **~$280/month** | |

### Variable Costs (Per-Client)

| Activity | Cost Per Unit | Notes |
|----------|-------------|-------|
| Claude API tokens (via CLI) | Included in subscription | Max plan = unlimited |
| GEO audit run | ~$0.10 | 5 agents, ~2K tokens each |
| Content generation (blog post) | ~$0.05-0.15 | Single Claude call |
| WordPress management (monthly) | ~$0 | Automated monitoring |
| Email operations (monthly) | ~$0 | Email Agent runs continuously |
| Human time (consulting/review) | $150/hour | Owner's time |
| Human time (technical work) | $100/hour | If manual intervention needed |

### Per-Client Cost Estimate

| Service | Monthly Delivery Cost | Primary Cost Driver |
|---------|----------------------|---------------------|
| GEO Audit (one-time) | $5-15 | Tokens + PDF generation |
| GEO Optimization (ongoing) | $10-30 | Content rewrites + monitoring |
| WordPress Management | $5-20 | Automated — mainly human review time |
| Content Marketing (4 posts/mo) | $10-30 | Generation + human review |
| AIOS Build (one-time) | $50-200 | Significant human consulting time |
| AIOS Retainer | $20-50 | Mostly automated maintenance |

**Key insight:** Most services cost $5-50/month to deliver. This enables 80-95% margins at market-rate pricing.

---

## Service Pricing Tiers

### Tier 1: Quick Wins ($200-$1,000 one-time)

**Target:** Small fixes, audits, one-off tasks.
**Margin:** 90-95%

| Service | Price Range | Deliverable |
|---------|-----------|-------------|
| GEO Audit Report | $0 (free) to $200 | PDF scored report — lead generation tool |
| Quick Fix Package | $200-500 | Implement 3-5 specific improvements (llms.txt, schema, robots.txt) |
| WordPress Health Check | $200-400 | Security scan, performance audit, update report |
| Content Audit | $300-500 | Review existing content, prioritize improvements |
| Email Setup Review | $200-400 | Email deliverability audit, configuration fixes |

### Tier 2: Standard Projects ($1,000-$5,000 one-time)

**Target:** Complete service packages, significant improvements.
**Margin:** 80-90%

| Service | Price Range | Deliverable |
|---------|-----------|-------------|
| Full GEO Optimization | $2,000-5,000 | Complete AI visibility overhaul |
| WordPress Site Rebuild | $2,000-4,000 | Theme optimization, content restructure, speed |
| Content Strategy Package | $1,500-3,000 | 3-month content calendar + 8 pieces |
| Email Marketing Setup | $1,000-2,500 | Welcome sequence, templates, automation |
| AIOS Audit Only | $2,000-3,000 | Scored business audit + architecture recommendation |

### Tier 3: Premium Projects ($5,000-$30,000 one-time)

**Target:** Full builds, enterprise deployments, multi-system work.
**Margin:** 70-80%

| Service | Price Range | Deliverable |
|---------|-----------|-------------|
| AIOS Full Build | $8,000-15,000 | Complete AI operating system for their business |
| AIOS Enterprise | $15,000-30,000 | Multi-department AIOS + complex integrations |
| Vertical AIOS Package | $5,000-10,000 | Pre-built industry template + customization |
| Full Digital Presence Build | $5,000-12,000 | Website + content + email + social + GEO |

### Tier 4: Retainers ($500-$5,000/month)

**Target:** Ongoing management, continuous optimization.
**Margin:** 85-95% (highest margin tier due to automation)

| Service | Monthly Price | Scope |
|---------|-------------|-------|
| WordPress Maintenance | $300-800/mo | Updates, monitoring, backups, minor edits |
| GEO Monitoring | $500-1,500/mo | Monthly re-audits, content optimization, reporting |
| Content Marketing | $1,000-3,000/mo | 4-8 pieces/month, social scheduling, newsletter |
| AIOS Retainer | $1,500-5,000/mo | Health checks, new workflows, support, evolution |
| Full-Service Package | $3,000-8,000/mo | WordPress + Content + GEO + Email + Reporting |

---

## Pricing Decision Matrix

Use this matrix when a client does not fit neatly into a standard package:

### Step 1: Estimate Value to Client

| Metric | Method |
|--------|--------|
| Time saved per month | Hours x their hourly rate |
| Revenue impact | % improvement x current revenue |
| Risk reduced | Cost of the problem if not fixed |
| Competitive advantage | What would they pay a competitor? |

### Step 2: Calculate Cost Floor

```
Cost Floor = (Human hours x $100-150/hr) + (Token cost) + (Integration setup time x $100/hr)
```

### Step 3: Set Price

```
Price = MAX(Cost Floor x 5, Market Rate x 0.7, Client Value x 0.1)
```

**Translation:**
- At minimum, charge 5x your cost
- Do not undercut market rate by more than 30%
- Do not charge more than 10% of the value delivered (keeps it a clear win for the client)

### Step 4: Select Payment Structure

| Project Size | Payment Structure |
|-------------|-------------------|
| Under $1,000 | 100% upfront |
| $1,000-$5,000 | 50% upfront, 50% on completion |
| $5,000-$15,000 | 40% upfront, 30% at midpoint, 30% on completion |
| Over $15,000 | 30% upfront, monthly milestone payments |
| Retainers | Monthly recurring (Stripe subscription) |

---

## Competitive Positioning

### Traditional Agency Rates (for comparison)

| Service | Traditional Agency | OPAI Price | Our Advantage |
|---------|-------------------|------------|---------------|
| SEO/GEO Audit | $1,500-5,000 | $0-500 | 95% cheaper (automated) |
| Website Management | $1,000-3,000/mo | $300-800/mo | 60-70% cheaper |
| Content Marketing | $3,000-8,000/mo | $1,000-3,000/mo | 60% cheaper |
| AI Consulting | $10,000-50,000 | $5,000-15,000 | 50-70% cheaper |
| Full Service | $8,000-20,000/mo | $3,000-8,000/mo | 60% cheaper |

**Positioning statement:** "Enterprise-quality AI-powered delivery at small business prices."

### When to Charge Premium

- Client is in a high-revenue vertical (legal, healthcare, finance)
- Engagement involves sensitive data or compliance requirements
- Client requires dedicated human support (not just HELM autonomous)
- Rush timeline (less than 2 weeks for a major project)
- Complex integrations with legacy systems

### When to Discount

- First client in a new vertical (case study value)
- Referral from existing client (10-15% referral discount)
- Annual prepayment (2 months free on 12-month retainer)
- Non-profit or community organization (30-50% discount, case-by-case)

---

## Pricing Gotchas

| Gotcha | Mitigation |
|--------|------------|
| Scope creep | Define scope explicitly in proposal. All additions are change orders at listed rates. |
| "Can you just add one more thing?" | Politely quote the addition. Never do free work beyond scope. |
| Client compares to freelancer rates | Emphasize: system, not person. 24/7 operation, multiple specialists, no sick days. |
| Underbidding to win the deal | Never. Low prices attract low-quality clients and set bad precedents. |
| Not accounting for human review time | Budget 2-4 hours/month human time per retainer client minimum. |
| Currency/tax differences | Always quote in client's local currency. Add tax note: "exclusive of applicable taxes." |

---

## References

| Document | Path |
|----------|------|
| HELM Playbooks | `Library/helm-playbooks/` |
| Client Onboarding Checklist | `Library/knowledge/reference/client-onboarding-checklist.md` |
| Service Delivery Workflow | `Library/knowledge/reference/service-delivery-workflow.md` |
| HELM Business Handoff | `Templates/helm-business-brief.md` |
| Tool Selection Guide | `Library/knowledge/reference/tool-selection-guide.md` |
