# Playbook: GEO Audit & Optimization Service

**Status:** Idea
**Category:** Agency / Marketing
**Source:** [Claude Code Just KILLED All Marketing Agencies — Zubair Trabzada](https://www.youtube.com/watch?v=Uyf8ehWyLto)
**Date Added:** 2026-02-28

---

## What Is It

A done-for-you Generative Engine Optimization (GEO) service. Audit any business website for AI search visibility (ChatGPT, Perplexity, Gemini, Google AI Overviews, Bing Copilot), deliver a scored report with critical findings, and sell optimization services to fix the gaps. GEO is the next evolution of SEO — instead of optimizing for Google's search index, you optimize for AI systems that recommend, cite, and surface businesses in conversational search.

---

## Market Opportunity

| Metric | Value |
|--------|-------|
| Projected market size | $7B (next 2-3 years) |
| AI search traffic growth | 500% year-over-year |
| Marketer awareness | Only ~23% are thinking about GEO |
| Competition | Very low — GEO is brand new, agencies are just waking up to it |
| Timing | Early mover advantage — this is where SEO was in 2005 |

**Why now:** Every business that has a website (all of them) needs GEO optimization. Most don't know it exists yet. First movers who can explain the problem AND fix it will capture the market.

---

## How It Works

### Phase 1: Audit (automated, ~60 seconds)

Run a multi-agent GEO audit on the target website:

1. **Discovery** — Fetch homepage, detect business type, crawl key pages
2. **5 Parallel Sub-Agent Analysis:**
   - **AI Citability** — Can AI systems quote/cite this content? Are content blocks structured for extraction?
   - **Brand Authority** — Wikipedia presence, review sites (G2, Trustpilot), social proof, LinkedIn followers
   - **Technical GEO Infrastructure** — `llms.txt` file (spec-compliant?), `robots.txt` AI crawler policy, server-side rendering vs JS-only
   - **Content Quality** — Depth, specificity, freshness, FAQ coverage, comparison content
   - **Schema Markup** — SoftwareApplication, FAQ, Person, Offer, Organization schemas
3. **Aggregate Scoring** — Overall score (0-100) + per-category scores + per-AI-platform readiness

### Phase 2: Report (automated, ~30 seconds)

Generate a polished PDF deliverable with:
- Overall GEO score with visual gauges
- Per-category breakdown with bar charts
- Per-AI-platform readiness (ChatGPT, Perplexity, Gemini, Google AI Overviews, Bing Copilot)
- Critical findings ranked by severity
- Prioritized action plan (quick wins this week, medium-term this month, strategic this quarter)

### Phase 3: Outreach (semi-automated)

- Send the free PDF audit report to the business
- Email: "I ran an AI visibility report on your website — you're scoring 38/100. AI search engines aren't recommending you. Want to hop on a quick call?"
- Value-first approach: the free report IS the sales pitch

### Phase 4: Optimization (service delivery)

For paying clients, implement the action plan:
- Fix `llms.txt` and `robots.txt` configuration
- Add/fix schema markup
- Restructure content for AI citability
- Ensure server-side rendering of key pages (pricing, features, FAQ)
- Build comparison and FAQ content
- Monitor and re-audit monthly

---

## Revenue Model

| Tier | Price | Scope | Margin |
|------|-------|-------|--------|
| Free audit | $0 | PDF report only — lead generation | N/A |
| Quick Fix | $500-1,000 | Implement quick wins (llms.txt, robots.txt, basic schema) | ~95% (automated) |
| Full Optimization | $2,000-5,000 | Complete GEO overhaul — all findings addressed | ~80% |
| Monthly Retainer | $500-1,500/mo | Ongoing monitoring, re-audits, content optimization | ~85% |

**Unit economics:** Audit costs ~$0.10 in Claude tokens. Report generation is free. Delivery is mostly automated. This is a high-margin service.

---

## Tools & Infrastructure Needed

### Already Exists in OPAI

| Tool | How It's Used |
|------|---------------|
| Agent Framework (42 roles, 26 squads) | GEO audit maps to a squad with 5 parallel agents + manager |
| Claude Code CLI (`claude -p`) | Powers the audit agents |
| HELM | Business orchestration — manages the service delivery lifecycle |
| WordPress + Avada | HELM already manages client WordPress sites — optimization applies directly |
| Email Agent | Outreach delivery |
| TeamHub | Track client projects and optimization tasks |
| Billing/Stripe | Invoice clients |

### Needs Building

| Component | Effort | Description |
|-----------|--------|-------------|
| GEO audit squad | Medium | 5 agent prompts + squad config in team.json |
| PDF report generator | Medium | Reusable PDF generation capability (benefits all OPAI reporting) |
| GEO scoring engine | Low | Codify the 5-dimension scoring methodology |
| Website crawler/fetcher | Low | Fetch and parse target websites (Playwright or curl-based) |
| Client portal view | Low | HELM dashboard showing audit results per business |
| Outreach templates | Low | Email templates for the free audit outreach |

---

## OPAI/HELM Integration

**HELM is the natural home for this service.** The flow:

1. HELM identifies target businesses (manual input or automated prospecting)
2. HELM runs GEO audit squad on each target's website
3. HELM generates PDF report
4. HELM sends outreach email via Email Agent
5. On client response: HELM creates TeamHub project, assigns optimization tasks
6. HELM implements optimizations on WordPress sites it manages (or provides instructions for non-managed sites)
7. HELM re-audits monthly, sends progress reports
8. HELM invoices via Stripe

**Roadmap alignment:**
- v3 "Felix" — HELM runs this as internal capability for HELM-managed businesses
- v4 "Open Doors" — HELM offers this as a paid agency service to external clients

---

## Sales Motion

1. **Identify targets** — Local businesses, SaaS companies, e-commerce sites. Anyone with a website.
2. **Run free audit** — Automated, costs nothing
3. **Send value-first email** — PDF report attached, specific findings mentioned
4. **Call-to-action** — "Want to hop on a quick call to discuss improvements?"
5. **Close** — Show the action plan, quote the optimization package
6. **Deliver** — Implement fixes, re-audit, show score improvement
7. **Retain** — Monthly retainer for ongoing optimization and monitoring

---

## Key GEO Checks (Scoring Methodology)

### AI Citability (0-100)
- Content structured in quotable blocks?
- Clear definitions, stats, comparisons AI can extract?
- FAQ sections with direct Q&A format?
- Unique data/research AI would want to cite?

### Brand Authority (0-100)
- Wikipedia page exists?
- G2/Trustpilot/review site presence and ratings?
- LinkedIn follower count and activity?
- Press mentions and backlink profile?
- Social proof signals?

### Technical GEO (0-100)
- `llms.txt` file exists and is spec-compliant?
- `robots.txt` allows AI crawlers (GPTBot, ClaudeBot, PerplexityBot)?
- Key content server-side rendered (not JS-only)?
- Pricing/features accessible without JavaScript execution?
- Fast page load for crawler access?

### Content Quality (0-100)
- Depth and specificity of content?
- Freshness (recently updated)?
- Comparison content ("X vs Y")?
- How-to and tutorial content?
- Industry-specific expertise signals?

### Schema Markup (0-100)
- Organization schema?
- SoftwareApplication / Product schema?
- FAQ schema?
- Person schema (team/founders)?
- Offer/pricing schema?
- Review/rating schema?

---

## Risks & Gotchas

- **GEO is new** — best practices are still evolving, scoring methodology may need updates
- **AI platform differences** — what works for ChatGPT may not work for Perplexity; need per-platform tuning
- **Client expectations** — GEO improvements take time to reflect in AI search results (no instant gratification)
- **Measurement** — hard to prove ROI directly (AI search doesn't have analytics like Google Search Console)
- **Market education** — many businesses don't know GEO exists; outreach needs to educate AND sell

---

## Competitive Landscape

- Very few agencies offer GEO specifically (most are still pure SEO)
- Some SEO tools are adding "AI visibility" features (Semrush, Ahrefs) but not as standalone services
- First-mover advantage is real — the agencies that position now will own the market
- OPAI/HELM advantage: fully automated audit + delivery = 95%+ margins vs manual agencies at 40-60%
