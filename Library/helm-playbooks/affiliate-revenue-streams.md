# Playbook: Affiliate Revenue Streams

**Status:** Idea
**Category:** Passive Income / Affiliate
**Source:** Manual — ongoing collection of affiliate programs from tools we already use
**Date Added:** 2026-03-01

---

## What Is It

A portfolio of affiliate programs from developer tools, SaaS platforms, and APIs that OPAI/BoutaByte already uses or evaluates. Instead of just being a customer, we earn commissions by referring others — leveraging our content pipeline (blog, YouTube, social) to drive signups. HELM manages the tracking, content creation, and link placement autonomously.

## Market Opportunity

- **Size:** Developer tools affiliate market is massive — most SaaS companies offer 20-33% recurring commissions
- **Growth:** API/AI tool space is exploding; early affiliates capture recurring revenue as platforms scale
- **Timing:** Perfect — we're already evaluating and using these tools, creating content is low marginal cost
- **Competition:** Low barrier, but quality technical reviews stand out vs. generic listicles
- **Buyer Pain:** Developers and businesses need honest tool recommendations from people who actually use them

## How It Works

1. **Identify:** As we onboard new tools/APIs, check for affiliate programs
2. **Sign Up:** Register for affiliate programs, store tracking links in vault
3. **Create Content:** HELM generates honest reviews, tutorials, and comparison posts using our real experience
4. **Distribute:** Publish via blog, YouTube descriptions, social posts, email newsletters
5. **Track:** Monitor commissions dashboard, optimize top performers
6. **Scale:** Double down on high-converting programs, sunset low performers

## Revenue Model

- **Commission Type:** Recurring (20-33% of customer's monthly bill) or one-time bounties
- **Billing:** Monthly payouts from affiliate networks
- **Margins:** ~95% (content creation cost only)
- **Upsell:** Bundle affiliate content with our own consulting/services content
- **Compounding:** Recurring commissions grow as referred customers stay subscribed

## Active Affiliate Programs

| Program | Commission | Type | Status | Signup URL | Notes |
|---------|-----------|------|--------|------------|-------|
| **Supadata** | 33% recurring | API (YouTube transcripts) | Pending signup | [supadata.ai](https://supadata.ai) | We use their transcript API (100 free/month). Strong fit for dev tool content. |

## Pipeline (Programs to Evaluate)

| Tool | We Use It? | Likely Commission | Priority |
|------|-----------|-------------------|----------|
| Hostinger | Yes (HELM hosting) | 40-60% per sale | High |
| Supabase | Yes (core DB) | TBD | Medium |
| Stripe | Yes (billing) | Referral credits | Low |
| Claude/Anthropic | Yes (core AI) | TBD | Medium |
| n8n | Yes (internal only) | 20% recurring | Low (licensing constraint) |
| Netlify | Yes (deployments) | TBD | Medium |

## Tools & Infrastructure

- **Existing:** HELM content pipeline, blog (WordPress), YouTube channel, social accounts
- **Needed:** Affiliate link manager (could be a simple brain node or vault entries), commission tracking dashboard
- **Third-party:** Individual affiliate program dashboards

## OPAI/HELM Integration

- **Content generation:** HELM already generates blog posts and social content — add affiliate link injection
- **Vault:** Store affiliate tracking links and API keys in vault (per-program)
- **Brain:** Store reviews, comparison notes, and performance data as brain nodes
- **Tracking:** Monthly commission report as a HELM scheduled job

## Risks & Gotchas

- Must disclose affiliate relationships (FTC compliance)
- Don't let affiliate revenue bias tool recommendations
- Some programs have minimum payout thresholds
- Recurring commissions stop if referred customer churns
- n8n affiliate problematic due to internal-only licensing constraint

---

*Last updated: 2026-03-01*
