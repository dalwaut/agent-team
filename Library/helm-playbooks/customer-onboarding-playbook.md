# Customer Onboarding Playbook

**Status:** Draft
**Category:** Consulting
**Revenue Potential:** $8K-30K initial + $1.5K-5K/month retainer
**Last updated:** 2026-03-05

---

## What Is It

Standard operating procedure for deploying AIOS consulting engagements to paying customers. Covers the full lifecycle from pre-sale qualification through 90-day success milestones. Designed for HELM to execute autonomously with CEO-gate on financial commitments and scope changes.

---

## Market Opportunity

- Businesses spending $5K-50K/month on manual operations that AI can automate
- Target verticals: agencies, property management, e-commerce, professional services
- Competition: traditional consulting ($200-500/hr), freelance automation ($50-150/hr)
- OPAI advantage: ongoing autonomous operation, not just one-time setup

---

## Pre-Sale Qualification

### Ideal Customer Profile

| Criteria | Must-Have | Nice-to-Have |
|----------|-----------|-------------|
| Monthly revenue | $50K+ | $200K+ |
| Team size | 3-50 | 10-30 |
| Tech stack | Web-based tools, email | Already using APIs/integrations |
| Pain point | Repetitive manual processes | Previous failed automation attempts |
| Budget | $8K+ initial | $15K+ initial |
| Decision maker | Direct access | Within 1 meeting |

### Disqualification Signals

- [ ] Budget under $5K
- [ ] No clear repetitive workflows to automate
- [ ] Expecting "set and forget" with no ongoing relationship
- [ ] Regulated industry requiring compliance we cannot provide (healthcare HIPAA, finance SOX)
- [ ] Unwilling to share workflow access/credentials

---

## Phase 1: Technical Assessment (Week 1)

### Discovery Call Checklist

1. [ ] Document current tech stack (CRM, email, project management, billing)
2. [ ] Map 3-5 most time-consuming workflows end-to-end
3. [ ] Identify data sources and destinations
4. [ ] Assess API availability for their tools
5. [ ] Estimate hours saved per workflow per month
6. [ ] Calculate ROI: (hours saved x hourly rate) vs. our fee

### Deliverable: Assessment Report

- Current state workflow diagrams
- Automation opportunity matrix (effort vs. impact)
- Recommended Phase 1 scope (2-3 highest-impact workflows)
- Pricing proposal with ROI justification
- Timeline estimate

**CEO-gate:** Pricing proposal requires approval before sending to customer.

---

## Phase 2: Deployment (Weeks 2-4)

### Environment Setup

1. [ ] Create customer workspace in Team Hub
2. [ ] Provision credentials in Vault (customer's API keys, logins)
3. [ ] Set up HELM business profile for the customer
4. [ ] Configure email agent accounts if applicable
5. [ ] Set up monitoring/alerting for customer workflows

### Build Sequence

1. [ ] Implement Workflow 1 (highest impact, lowest complexity)
2. [ ] Test in dry-run mode with customer data
3. [ ] Customer review and approval (HITL gate)
4. [ ] Go live on Workflow 1
5. [ ] Monitor for 48 hours, fix issues
6. [ ] Implement Workflows 2-3 (repeat cycle)

### Handoff Checklist

- [ ] All workflows documented (what it does, how to stop it, who to contact)
- [ ] Customer has access to monitoring dashboard
- [ ] Alert routing configured (failures notify customer + us)
- [ ] Runbook for common issues provided
- [ ] Emergency kill-switch explained and tested

---

## Phase 3: Training (Week 4)

### Training Sessions

1. [ ] **Overview session** (30 min) — What was built, how it works, where to see results
2. [ ] **Admin session** (30 min) — How to pause/resume, adjust parameters, read reports
3. [ ] **Escalation session** (15 min) — Who to contact, response times, what we monitor

### Training Materials

- [ ] Quick-start guide (1-page PDF)
- [ ] FAQ document
- [ ] Video walkthrough of dashboard (Loom or similar)

---

## Phase 4: Retainer (Ongoing)

### Monthly Retainer Includes

| Tier | Price | Includes |
|------|-------|----------|
| **Essential** | $1,500/mo | Monitoring, maintenance, 2 hours support, monthly report |
| **Growth** | $3,000/mo | Essential + 1 new workflow/month, priority support |
| **Enterprise** | $5,000/mo | Growth + unlimited workflows, dedicated Slack, SLA |

### Monthly Delivery

1. [ ] Automated performance report (HELM generates)
2. [ ] Review meeting (30 min, monthly)
3. [ ] Proactive optimization suggestions
4. [ ] Apply updates/fixes as needed

**CEO-gate:** Scope changes or new workflow requests exceeding retainer allocation.

---

## Success Metrics

### 30-Day Milestones

- [ ] All Phase 1 workflows live and stable
- [ ] Customer can access monitoring independently
- [ ] Zero critical failures in past 7 days
- [ ] Customer confirms time savings are as projected

### 60-Day Milestones

- [ ] Customer requests additional workflow automation (expansion signal)
- [ ] Monthly report shows measurable ROI
- [ ] Support tickets < 3 per month
- [ ] Customer provides testimonial or case study data

### 90-Day Milestones

- [ ] Retainer renewed (or upgraded)
- [ ] 3+ workflows running autonomously
- [ ] Customer NPS >= 8
- [ ] Case study written and published (with permission)

---

## Tools & Infrastructure

| Need | OPAI Tool | Status |
|------|-----------|--------|
| Customer workspace | Team Hub | Ready |
| Credential management | Vault | Ready |
| Business profile | HELM | Ready |
| Email automation | Email Agent | Ready |
| WordPress management | OP WordPress | Ready |
| Content generation | Brain + Studio | Ready |
| Monitoring | Engine heartbeat | Ready |
| Alerts | Telegram Bridge | Ready |
| Billing | Stripe (opai-billing) | v4 target |
| Customer portal | Portal (customer view) | v4 target |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Customer's tools lack APIs | Medium | High | Discover in assessment phase; reject if no API path |
| Scope creep | High | Medium | Document scope clearly; CEO-gate on changes |
| Customer churn at 90 days | Medium | High | Demonstrate ROI early; monthly check-ins |
| Security incident with customer data | Low | Critical | Vault isolation; customer credentials never in git |
| OPAI downtime affecting customer | Low | High | Heartbeat monitoring; 2-hour RTO |

---

## Source

Derived from OPAI v4 "Open Doors" revenue strategy (`Library/opai-wiki/plans/opai-evolution.md`) and existing client service patterns at Paradise Web.

---

## Ready for Review Checklist

- [x] All sections populated with actionable content
- [x] Pricing tiers defined with clear boundaries
- [x] Success metrics are measurable and time-bound
- [x] Tools mapped to OPAI capabilities with status
- [x] Risks identified with mitigations
- [ ] Pricing validated against market rates (needs Dallas review)
- [ ] Legal: service agreement template needed
- [ ] First pilot customer identified
