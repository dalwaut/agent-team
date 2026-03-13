# Client Onboarding Checklist

> **Purpose:** Step-by-step checklist for onboarding a new client into the OPAI/HELM ecosystem.
> Used by HELM, business agents, and human operators during client intake.
> **Last updated:** 2026-03-05

---

## Overview

This checklist covers the full journey from initial lead contact through active service delivery. Each phase has required steps, responsible tools, and verification criteria. Skip phases that do not apply to the service being delivered.

---

## Phase 1: Lead Qualification (Day 0)

**Owner:** HELM + human (sales call)
**Tools:** Brain (research), Bx4 (analysis), Email Agent (outreach)

- [ ] **1.1** Research the prospect
  - Company website, social media, industry
  - Use Brain research tab or `business_analyst` agent
  - Document findings in Brain as a node

- [ ] **1.2** Identify service fit
  - Which OPAI services match their needs?
  - Refer to `Library/helm-playbooks/` for available offerings
  - Cross-reference with `tool-selection-guide.md`

- [ ] **1.3** Qualify budget and timeline
  - Are they in the right revenue range for our services?
  - Refer to `agency-pricing-framework.md` for pricing tiers
  - Do they have realistic timeline expectations?

- [ ] **1.4** Send initial outreach or respond to inbound
  - Use Email Agent for templated outreach
  - Include: value proposition, relevant case study or audit sample
  - For GEO service: send free automated audit report

- [ ] **1.5** Log lead in Team Hub
  - Create item in the appropriate workspace
  - Status: `Lead`
  - Tags: service type, source, priority

**Exit criteria:** Prospect responds with interest, discovery call scheduled.

---

## Phase 2: Discovery & Proposal (Days 1-3)

**Owner:** HELM + human (consulting)
**Tools:** Team Hub, Brain, HELM

- [ ] **2.1** Conduct discovery call
  - Use `Templates/helm-business-brief.md` as question framework
  - Capture: pain points, current tools, goals, budget, decision timeline
  - Record notes in Brain or Team Hub item

- [ ] **2.2** Prepare proposal
  - Select service tier from pricing framework
  - Customize scope based on discovery findings
  - Include: deliverables, timeline, price, payment terms
  - Use HELM to draft proposal content

- [ ] **2.3** Internal review (human gate)
  - Review pricing against cost model
  - Verify we can deliver within timeline
  - Check for conflicts with existing clients

- [ ] **2.4** Send proposal
  - Email Agent sends polished proposal
  - Include: scope document, pricing, terms, next steps
  - Set follow-up reminder in Team Hub (3 business days)

- [ ] **2.5** Update Team Hub status
  - Status: `Proposal Sent`
  - Add proposal details and pricing to item

**Exit criteria:** Client accepts proposal, verbal or written agreement.

---

## Phase 3: Contract & Payment (Days 3-7)

**Owner:** Human (legal/financial) + Billing tool
**Tools:** Billing (Stripe), Vault, Team Hub

- [ ] **3.1** Generate contract/agreement
  - Use service-specific contract template
  - Include: scope, deliverables, timeline, payment terms, termination clause
  - Include AI disclosure clause (HELM operates with AI, client acknowledges)

- [ ] **3.2** Set up Stripe billing
  - Create customer in Stripe via Billing tool
  - Create product/price matching the proposal
  - Generate checkout link or invoice
  - For retainers: set up recurring subscription

- [ ] **3.3** Collect signed agreement
  - Digital signature via email or document signing tool
  - Store signed copy in client's Google Drive folder

- [ ] **3.4** Process initial payment
  - Verify payment received in Stripe
  - Send receipt/confirmation via Email Agent

- [ ] **3.5** Update Team Hub
  - Status: `Contracted`
  - Link to Stripe customer ID
  - Set project start date

**Exit criteria:** Signed contract + first payment received.

---

## Phase 4: Environment Setup (Days 7-10)

**Owner:** HELM + human (technical)
**Tools:** Vault, Team Hub, WordPress, Google Workspace

- [ ] **4.1** Create client workspace
  - Team Hub: Create workspace or folder for client
  - Google Drive: Create shared drive (if not exists)
  - Brain: Create client knowledge node

- [ ] **4.2** Collect and store credentials
  - Use `Templates/helm-business-brief.md` Section 14 (Access & Credentials)
  - Store ALL credentials in Vault with `client/<client-slug>/` prefix
  - NEVER store credentials in plain text, Team Hub, or Brain
  - Verify access works for each credential

- [ ] **4.3** Configure HELM for client
  - Fill out HELM Business Handoff Document (`Templates/helm-business-brief.md`)
  - Set autonomy level, approval thresholds, reporting preferences
  - Configure brand voice and content guidelines

- [ ] **4.4** Connect integrations
  - WordPress: Add site to OP WordPress manager, deploy connector plugin
  - Email: Configure Email Agent for client accounts (if applicable)
  - Social: Set up any social platform API connections
  - Analytics: Connect Google Analytics or equivalent

- [ ] **4.5** Verify all connections
  - Test each integration end-to-end
  - Document any issues or workarounds
  - Confirm client-side access is working

- [ ] **4.6** Update Team Hub
  - Status: `Setup Complete`
  - Document all configured integrations
  - Set delivery milestone dates

**Exit criteria:** All integrations tested and working, HELM configured.

---

## Phase 5: Kickoff & Delivery Start (Day 10+)

**Owner:** HELM + human (relationship)
**Tools:** Team Hub, Telegram, Email Agent

- [ ] **5.1** Send kickoff communication
  - Welcome email with: timeline, first deliverables, communication preferences
  - Include: how to reach us, expected response times, escalation path

- [ ] **5.2** Deliver first quick win
  - Within first 48 hours of kickoff, deliver something tangible
  - Examples: audit report, quick fix, first content piece, site optimization
  - This builds trust and demonstrates value

- [ ] **5.3** Set up reporting cadence
  - Configure HELM reporting per client preferences (Section 15 of business brief)
  - First report due within 1 week of kickoff
  - Reports sent via Email Agent or as PDF attachment

- [ ] **5.4** Create recurring Team Hub tasks
  - Monthly health check
  - Quarterly review meeting
  - Invoice/billing reminders
  - Content calendar milestones (if applicable)

- [ ] **5.5** Activate HELM autonomous mode
  - Enable scheduled tasks for the client
  - HELM begins autonomous operations within defined parameters
  - Human reviews first 2-3 autonomous actions before full autonomy

- [ ] **5.6** Update Team Hub
  - Status: `Active`
  - First delivery logged
  - Recurring items scheduled

**Exit criteria:** Client has received first deliverable, HELM is operating.

---

## Phase 6: Ongoing Management

**Owner:** HELM (autonomous) + human (oversight)
**Tools:** HELM, Team Hub, Email Agent, Billing

- [ ] **6.1** Regular deliverables per contract scope
  - HELM handles content, optimization, monitoring per schedule
  - Human reviews flagged items and approval gates

- [ ] **6.2** Monthly health check
  - HELM generates performance report
  - Review KPIs against goals
  - Adjust strategy if needed

- [ ] **6.3** Quarterly business review
  - Scheduled call with client
  - Present ROI, results, recommendations
  - Discuss scope expansion or adjustments

- [ ] **6.4** Invoice management
  - Billing tool sends invoices per schedule
  - Monitor payment status
  - Follow up on overdue payments (Email Agent)

- [ ] **6.5** Renewal/upsell
  - 30 days before contract renewal: HELM prepares renewal proposal
  - Include results achieved and recommended next steps
  - Upsell additional services where appropriate

---

## Emergency Procedures

| Situation | Action |
|-----------|--------|
| Client website down | Immediate Telegram alert, WordPress health check, escalate to human |
| Payment failed/overdue | Email Agent sends reminder (day 3, 7, 14), human escalates at day 21 |
| Client requests scope change | Log in Team Hub, human reviews pricing impact, send updated proposal |
| Security incident | Rotate credentials in Vault, assess impact, notify client, document |
| Client wants to cancel | Human handles directly, never HELM. Process offboarding checklist |

---

## Offboarding Checklist (if client leaves)

- [ ] Export all client data and deliverables
- [ ] Revoke all credential access in Vault
- [ ] Remove client integrations from HELM
- [ ] Archive Team Hub workspace (do not delete)
- [ ] Send final invoice and close Stripe subscription
- [ ] Archive Google Drive folder
- [ ] Schedule 30-day follow-up (win-back opportunity)

---

## Templates & References

| Document | Path |
|----------|------|
| HELM Business Handoff | `Templates/helm-business-brief.md` |
| Service Delivery Workflow | `Library/knowledge/reference/service-delivery-workflow.md` |
| Agency Pricing Framework | `Library/knowledge/reference/agency-pricing-framework.md` |
| Tool Selection Guide | `Library/knowledge/reference/tool-selection-guide.md` |
| HELM Playbooks | `Library/helm-playbooks/` |
