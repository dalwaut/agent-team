# Voice AI Receptionist — Service Playbook

**Status:** Draft (on-demand — deploy when a client requests it)
**Category:** Productized Service
**Revenue Potential:** $500-2,000/mo retainer per client + $2K-5K setup fee
**Last updated:** 2026-03-10
**Source:** [Vapi + Claude Code walkthrough](https://www.youtube.com/watch?v=QF7SREoOHP4) — Kacper Rutkiewicz

---

## What Is It

A 24/7 AI voice receptionist that answers inbound calls, qualifies leads, books appointments on the client's calendar, logs lead data to a CRM/sheet, and sends end-of-call reports via email. Built on **Vapi** (voice AI platform) with Claude Code orchestration. No hardware, no hiring, no training — the AI handles it from day one.

This is a **high-margin, low-maintenance productized service** ideal for local businesses that miss calls and lose leads. We build it once per client, charge monthly, and HELM monitors it.

---

## Market Opportunity

### Target Verticals

| Vertical | Pain Point | Avg. Ticket Value |
|----------|-----------|-------------------|
| Contractors (HVAC, roofing, decks) | Miss calls on job sites | $5K-50K per job |
| Dental / medical offices | Receptionist busy or after-hours | $200-2K per patient |
| Law firms | Intake calls missed evenings/weekends | $3K-50K per case |
| Property management | Tenant calls, showing requests | $1K-2K/mo per unit |
| Auto repair / service shops | Calls during peak hours | $500-3K per service |

### Unit Economics

| Item | Cost |
|------|------|
| Vapi per-minute cost | ~$0.05-0.10/min |
| Avg. call duration | 2-4 minutes |
| Avg. cost per call | $0.10-0.40 |
| Monthly call volume (typical SMB) | 100-500 calls |
| Our monthly cost per client | $10-200/mo |
| Client monthly fee | $500-2,000/mo |
| **Gross margin** | **80-95%** |

### Competition

- Human answering services: $1-2/min ($200-1,000/mo for basic coverage)
- Other AI receptionist services (Smith.ai, Ruby): $300-700/mo with less customization
- DIY Vapi: client would need dev skills + time — that's our value-add

---

## What We Deliver

### Per Client

1. Custom AI receptionist persona (name, voice, personality matched to their brand)
2. Business-specific system prompt (services, pricing, FAQs, qualifying questions)
3. Google Calendar integration (checks availability, books appointments)
4. Lead logging (Google Sheets or direct CRM integration)
5. End-of-call email reports with recording links
6. Dedicated phone number (Vapi-provisioned or port existing)
7. Transfer-to-human capability for complex calls
8. Monthly performance report

---

## Technical Architecture

```
Inbound Call → Vapi Phone Number → AI Assistant (Rachel/custom)
                                        ↓
                              Qualifying conversation
                                        ↓
                          ┌─────────────┼─────────────┐
                          ↓             ↓             ↓
                   Check Calendar   Log Lead    Transfer Call
                   Book Appt       (Sheets/CRM)  (to human)
                          ↓             ↓
                    Google Calendar  Google Sheets
                          ↓
                   End-of-Call Webhook → n8n → Email Report
```

### Vapi MCP Skills Used

| Skill | Purpose |
|-------|---------|
| `setup-api-key` | Initial Vapi configuration |
| `create-assistant` | Build the AI receptionist persona |
| `create-tool` | Calendar check, calendar book, lead log, transfer |
| `create-phone-number` | Provision and assign inbound number |
| `setup-webhook` | End-of-call data → n8n pipeline |
| `create-call` | Outbound test calls during QA |
| `create-squad` | Multi-agent routing (if needed for complex setups) |

### Infrastructure Requirements

| Need | Tool | Status |
|------|------|--------|
| Voice AI platform | Vapi (external) | Not yet installed |
| MCP integration | Vapi MCP + 8 skills | Not yet installed |
| Webhook processing | n8n (internal only) | Ready |
| Calendar integration | Google Calendar API | Ready |
| Lead storage | Google Sheets / Supabase | Ready |
| Email reports | Email Agent or n8n SMTP | Ready |
| Client monitoring | HELM | Ready |
| Credential storage | Vault | Ready |

---

## Build Phases (Per Client)

### Phase 1: Discovery & Setup (Day 1)

1. [ ] Discovery call — understand business, services, hours, qualifying criteria
2. [ ] Collect: business name, address, services list, pricing ranges, team names
3. [ ] Collect: Google Calendar access, preferred CRM/sheet, email for reports
4. [ ] Set up Vapi API key in Vault (one-time if first client)
5. [ ] Create client workspace in Team Hub

### Phase 2: Build Tools (Day 1-2)

1. [ ] Create Google Calendar check-availability tool
2. [ ] Create Google Calendar book-appointment tool
3. [ ] Create lead-logging tool (Sheets or CRM API)
4. [ ] Create transfer-to-human tool (client's real phone number)
5. [ ] Enable end-call function
6. [ ] Verify all tools in Vapi dashboard

### Phase 3: Build Assistant (Day 2)

1. [ ] Write system prompt with business context, qualifying questions, objection handling
2. [ ] Select voice (match brand — professional, friendly, authoritative)
3. [ ] Configure first message ("Thank you for calling [Business], this is [Name]...")
4. [ ] Set model (GPT-4.1 or Claude depending on performance)
5. [ ] Attach all tools to assistant
6. [ ] Create assistant via Vapi MCP

### Phase 4: Phone Number & Webhook (Day 2)

1. [ ] Provision Vapi phone number (or port client's existing number)
2. [ ] Assign phone number to assistant
3. [ ] Create webhook endpoint in n8n
4. [ ] Connect Vapi end-of-call webhook → n8n → email report
5. [ ] Configure email report template with client branding

### Phase 5: Testing & QA (Day 3)

1. [ ] Outbound test call (Vapi calls us)
2. [ ] Inbound test call (we call the number)
3. [ ] Verify calendar booking works
4. [ ] Verify lead logging works
5. [ ] Verify email report arrives with correct data
6. [ ] Edge cases: caller hangs up early, asks off-topic questions, requests transfer
7. [ ] Client reviews test call recordings and approves

### Phase 6: Go Live & Monitor (Day 3-4)

1. [ ] Client switches phone routing to Vapi number (or we port it)
2. [ ] Monitor first 24 hours of live calls
3. [ ] Fix any prompt issues (misspellings, wrong info, tone)
4. [ ] Set up HELM monitoring for call volume and failure alerts
5. [ ] Deliver quick-start guide to client

**Total build time: 3-4 days**

---

## Pricing

| Tier | Setup Fee | Monthly | Includes |
|------|-----------|---------|----------|
| **Starter** | $2,000 | $500/mo | 1 receptionist, basic qualifying, calendar booking, email reports |
| **Professional** | $3,500 | $1,000/mo | Starter + CRM integration, custom voice, transfer routing, monthly optimization |
| **Enterprise** | $5,000 | $2,000/mo | Professional + multi-department routing (squads), after-hours handling, bilingual, dedicated support |

All tiers include Vapi usage costs (passed through at cost or bundled with margin).

**CEO-gate:** Pricing needs validation against market rates before first client engagement.

---

## Ongoing Operations (HELM-managed)

### Monthly Tasks

- [ ] Review call analytics (volume, duration, outcomes)
- [ ] Identify prompt improvement opportunities (common failures, caller confusion)
- [ ] Apply prompt optimizations
- [ ] Generate monthly client report (calls handled, appointments booked, leads qualified)
- [ ] Invoice client via Stripe (when opai-billing is live)

### Alert Triggers

| Event | Action |
|-------|--------|
| Vapi service outage | Telegram alert → manual failover to client's cell |
| Call failure rate > 10% | Review logs, fix prompt or tool issues |
| Client reports bad call | Pull recording, diagnose, fix within 24 hours |
| Calendar integration breaks | Re-auth Google Calendar, notify client |

---

## Known Limitations & Watch-Outs

| Issue | Mitigation |
|-------|-----------|
| Voice AI occasionally misspells city/street names | Post-call data cleanup; add common local names to prompt context |
| Caller may ask questions outside scope | System prompt includes graceful deflection + transfer option |
| Vapi is a third-party dependency | Monitor their status page; have fallback routing to client's cell |
| Per-minute costs scale with volume | High-volume clients need Enterprise tier to maintain margin |
| n8n is internal-only (licensing) | All webhook processing stays on our infrastructure, never client-facing |
| First-generation prompts need iteration | Budget 2-3 prompt refinement cycles in first week |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Vapi price increase | Low | Medium | Monitor alternatives (Bland.ai, Retell); service is transferable |
| Client unhappy with voice quality | Medium | Medium | Offer voice selection; iterate on prompt tone in first week |
| Competitor undercuts pricing | Medium | Low | Our value is full-service (build + manage + optimize), not just the AI |
| Regulatory issues (call recording) | Low | High | Ensure client has proper disclosure; add "this call may be recorded" to greeting |
| High call volume exceeds margin | Low | Medium | Enterprise tier pricing; Vapi volume discounts |

---

## First Client Checklist

Before deploying to the first paying client:

- [ ] Vapi MCP installed in OPAI stack (`config/mcp-all.json`)
- [ ] Vapi API key stored in Vault
- [ ] n8n webhook template created and tested
- [ ] Email report template designed
- [ ] End-to-end test completed (call → qualify → book → log → email)
- [ ] Pricing validated by Dallas
- [ ] Service agreement template drafted
- [ ] Client onboarding questionnaire created
- [ ] HELM monitoring playbook configured

---

## Reference

- Video walkthrough: https://www.youtube.com/watch?v=QF7SREoOHP4
- Vapi docs + MCP setup: https://docs.vapi.ai
- Related playbook: `customer-onboarding-playbook.md` (for general onboarding process)
- Revenue strategy: `Library/opai-wiki/plans/opai-evolution.md` (v4 "Open Doors")
