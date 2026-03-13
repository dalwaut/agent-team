# Playbook: GEO Audit & Optimization Service

**Status:** Draft
**Category:** Agency / Marketing
**Source:** [Claude Code Just KILLED All Marketing Agencies — Zubair Trabzada](https://www.youtube.com/watch?v=Uyf8ehWyLto)
**Date Added:** 2026-02-28
**Last Updated:** 2026-03-05 (upgraded from Idea to Draft)

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

**Pricing methodology:** See `Library/knowledge/reference/agency-pricing-framework.md` for full framework.

---

## Tools & Infrastructure Needed

### Already Exists in OPAI

| Tool | How It's Used |
|------|---------------|
| Agent Framework (43 roles, 27 squads) | GEO audit maps to a squad with 5 parallel agents + manager |
| Claude Code CLI (`claude -p`) | Powers the audit agents |
| HELM | Business orchestration — manages the service delivery lifecycle |
| WordPress + Avada | HELM already manages client WordPress sites — optimization applies directly |
| Email Agent | Outreach delivery |
| TeamHub | Track client projects and optimization tasks |
| Billing/Stripe | Invoice clients |
| Browser (Playwright) | Website crawling and rendering for audit |
| Brain | Store GEO knowledge, audit findings, optimization patterns |
| Studio | Generate report visuals if needed |

### Needs Building

| Component | Effort | Description | Implementation Phase |
|-----------|--------|-------------|---------------------|
| GEO audit squad | Medium | 5 agent prompts + squad config in team.json | Phase 1 |
| Website crawler module | Low | Fetch and parse target websites (Playwright-based) | Phase 1 |
| GEO scoring engine | Low | Codify the 5-dimension scoring methodology as Python module | Phase 1 |
| HTML report generator | Medium | Reusable HTML-to-PDF report generation capability | Phase 2 |
| Outreach email templates | Low | Email templates for the free audit outreach | Phase 2 |
| GEO API endpoint | Low | Engine route to trigger audit via API | Phase 2 |
| Telegram /geo command | Low | Trigger audit from Telegram | Phase 3 |
| Client dashboard view | Medium | HELM dashboard showing audit results per business | Phase 3 |
| Monthly re-audit cron | Low | Scheduled re-audit for retainer clients | Phase 3 |

---

## Implementation Plan

### Phase 1: Core Audit Engine (Week 1-2)

**Goal:** Run a GEO audit on any URL and get a scored JSON result.

#### Step 1: Create GEO Agent Prompts (Day 1-2)

Create 5 specialist agent prompts in `scripts/`:

| Prompt File | Agent Role | Input | Output |
|------------|------------|-------|--------|
| `prompt_geo_citability.txt` | GEO Citability Analyst | Website HTML/content | Score 0-100 + findings array |
| `prompt_geo_authority.txt` | GEO Authority Analyst | Website URL + search results | Score 0-100 + findings array |
| `prompt_geo_technical.txt` | GEO Technical Analyst | robots.txt, llms.txt, page source | Score 0-100 + findings array |
| `prompt_geo_content.txt` | GEO Content Quality Analyst | Page content + metadata | Score 0-100 + findings array |
| `prompt_geo_schema.txt` | GEO Schema Analyst | Page source (JSON-LD, microdata) | Score 0-100 + findings array |

**Prompt template structure (each agent):**
```
You are a GEO (Generative Engine Optimization) specialist analyzing [DIMENSION].

INPUT: Website content/data provided below.
TASK: Score this website 0-100 on [DIMENSION] for AI search engine visibility.

OUTPUT FORMAT (strict JSON):
{
  "dimension": "[DIMENSION]",
  "score": <0-100>,
  "findings": [
    {"severity": "critical|warning|info", "finding": "...", "recommendation": "..."}
  ],
  "platform_notes": {
    "chatgpt": "...",
    "perplexity": "...",
    "gemini": "..."
  }
}

SCORING RUBRIC:
- 0-20: Not visible to AI search engines
- 21-40: Minimal visibility, major gaps
- 41-60: Partial visibility, important improvements needed
- 61-80: Good visibility, optimization opportunities exist
- 81-100: Excellent AI search presence

[DETAILED CHECKS FOR THIS DIMENSION]
```

**Resource estimate:** 2-4 hours to write and test all 5 prompts.

#### Step 2: Create GEO Manager Agent (Day 2)

Create `prompt_geo_manager.txt`:
- Reads all 5 sub-agent scores
- Calculates weighted overall score (equal weighting initially)
- Aggregates findings by severity (critical first)
- Produces per-AI-platform readiness assessment
- Generates prioritized action plan (quick wins / medium-term / strategic)

**Output format:** Structured JSON with overall score, per-dimension scores, aggregated findings, and action plan.

**Resource estimate:** 1-2 hours.

#### Step 3: Register GEO Squad in team.json (Day 2)

```json
"geo_audit": {
  "description": "GEO audit: 5 parallel dimension analysts + manager aggregator. Run on any website URL.",
  "agents": [
    "geo_citability",
    "geo_authority",
    "geo_technical",
    "geo_content",
    "geo_schema",
    "geo_manager"
  ]
}
```

Also register the 6 new agent roles in the `roles` section of `team.json`.

**Resource estimate:** 30 minutes.

#### Step 4: Build Website Crawler Module (Day 3-4)

Create `tools/shared/geo_crawler.py`:

```python
# Responsibilities:
# 1. Fetch homepage HTML (via Playwright for JS-rendered sites)
# 2. Extract: title, meta description, h1-h6 headings, paragraph text
# 3. Fetch /robots.txt and /llms.txt (or /.well-known/llms.txt)
# 4. Extract JSON-LD and microdata schema markup
# 5. Check key pages: /pricing, /about, /faq, /features (if they exist)
# 6. Detect CMS (WordPress, Shopify, Webflow, etc.)
# 7. Return structured dict with all extracted data
```

**Implementation notes:**
- Use Browser tool (opai-browser, port 8107) for Playwright access
- Fallback to `httpx` for sites where Playwright is overkill
- Cache results for 24 hours (same URL = same data)
- Respect robots.txt (do not crawl disallowed paths)
- Timeout: 30 seconds per page, 2 minutes total

**Resource estimate:** 4-6 hours (including testing on diverse sites).

#### Step 5: Build GEO Scoring Engine (Day 4-5)

Create `tools/shared/geo_scoring.py`:

```python
# Responsibilities:
# 1. Accept raw agent output (5 dimension scores + findings)
# 2. Calculate weighted overall score
# 3. Normalize scores across dimensions
# 4. Classify findings by priority
# 5. Generate per-platform readiness (ChatGPT, Perplexity, Gemini, etc.)
# 6. Return structured GEO report data

# Weighting (adjustable):
WEIGHTS = {
    "citability": 0.25,    # Most important — can AI quote you?
    "authority": 0.20,     # Are you trusted?
    "technical": 0.20,     # Can AI crawlers access you?
    "content": 0.20,       # Is your content deep and useful?
    "schema": 0.15         # Do you have structured data?
}
```

**Resource estimate:** 2-3 hours.

#### Phase 1 Exit Criteria
- [ ] Can run `./scripts/run_squad.sh -s "geo_audit" -i "https://example.com"` and get a scored JSON result
- [ ] All 5 dimensions produce consistent, reproducible scores
- [ ] Scoring engine produces overall score + prioritized action plan
- [ ] Tested on 5+ real websites across different industries

---

### Phase 2: Report Generation & Outreach (Week 3-4)

**Goal:** Generate professional PDF reports and send them via email.

#### Step 6: Build HTML Report Template (Day 1-3)

Create `tools/opai-helm/templates/geo-report.html`:
- Professional branded template (BoutaByte / Paradise Web branding)
- Overall score with visual gauge (SVG donut chart)
- 5 dimension scores with bar charts
- Per-AI-platform readiness indicators (green/yellow/red)
- Critical findings table with severity badges
- Prioritized action plan (3 tiers: this week, this month, this quarter)
- Footer: contact info, call-to-action, branding

**Tech:** Jinja2 template + inline CSS (for PDF compatibility).

**Resource estimate:** 4-6 hours for design + implementation.

#### Step 7: Build PDF Generator (Day 3-4)

Create `tools/shared/pdf_generator.py`:
- Accept HTML string, output PDF bytes
- Use `weasyprint` or `playwright` PDF generation (Playwright preferred — already installed)
- Reusable for ALL OPAI reporting (not just GEO)
- A4 format, print-optimized CSS

```python
async def generate_pdf(html_content: str, output_path: str = None) -> bytes:
    """Generate PDF from HTML using Playwright."""
    # Use existing opai-browser Playwright instance
    # page.set_content(html) -> page.pdf()
```

**Dependency:** `pip install weasyprint` OR use Playwright's built-in PDF (zero new deps).

**Resource estimate:** 2-3 hours.

#### Step 8: Create Outreach Email Templates (Day 4)

Create 3 email templates in `tools/opai-email-agent/templates/`:

1. **Cold outreach with free report**
   ```
   Subject: Your website's AI visibility score: {score}/100
   Body: [Personalized intro, key findings, PDF attached, CTA for call]
   ```

2. **Follow-up (no response after 5 days)**
   ```
   Subject: Quick question about {business_name}'s AI presence
   Body: [Lighter touch, reference original report, single CTA]
   ```

3. **Conversion email (after call)**
   ```
   Subject: Your GEO optimization plan — {business_name}
   Body: [Proposal summary, pricing, next steps]
   ```

**Resource estimate:** 1-2 hours.

#### Step 9: Create Engine API Endpoint (Day 5)

Add `tools/opai-engine/routes/geo.py`:

```python
# POST /api/geo/audit
# Body: {"url": "https://example.com", "email": "optional@email.com"}
# Response: {"audit_id": "...", "status": "queued"}

# GET /api/geo/audit/{audit_id}
# Response: {"status": "complete", "scores": {...}, "report_url": "..."}

# POST /api/geo/report/{audit_id}
# Generate and return PDF report

# POST /api/geo/send/{audit_id}
# Send report via Email Agent to specified email
```

**Resource estimate:** 3-4 hours.

#### Phase 2 Exit Criteria
- [ ] Can generate professional PDF from audit results
- [ ] PDF looks polished (branded, visual, actionable)
- [ ] API endpoint works: submit URL → get audit → generate PDF → send email
- [ ] Tested end-to-end: URL in, email with PDF out
- [ ] Outreach templates reviewed and approved

---

### Phase 3: Automation & Client Management (Week 5-6)

**Goal:** HELM can autonomously prospect, audit, and onboard GEO clients.

#### Step 10: Add Telegram /geo Command (Day 1)

Add to `tools/opai-telegram/handlers/commands.js`:
```
/geo <url> — Run GEO audit, return summary, offer to send full PDF
/geo report <url> — Generate and send PDF to owner's email
/geo send <url> <email> — Run audit and email the report
```

**Resource estimate:** 2 hours.

#### Step 11: Build Client Dashboard in HELM (Day 2-4)

Add GEO section to HELM dashboard (`tools/opai-helm/static/`):
- List of audited sites with scores and dates
- Click to view full report
- Re-audit button (triggers new audit, compares scores)
- Client status tracking (lead, contacted, proposal, active, churned)
- Revenue tracking per client

**Supabase tables needed:**
```sql
CREATE TABLE geo_audits (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    url TEXT NOT NULL,
    overall_score INTEGER,
    scores JSONB,
    findings JSONB,
    report_html TEXT,
    report_pdf_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES profiles(id)
);

CREATE TABLE geo_clients (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    business_name TEXT NOT NULL,
    url TEXT,
    contact_email TEXT,
    contact_name TEXT,
    status TEXT DEFAULT 'lead',
    tier TEXT,
    mrr NUMERIC DEFAULT 0,
    last_audit_id UUID REFERENCES geo_audits(id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

**Resource estimate:** 6-8 hours.

#### Step 12: Monthly Re-Audit Cron (Day 5)

Add to Engine scheduler (`tools/opai-engine/background/scheduler.py`):
- For each active GEO retainer client: run audit on 1st of month
- Compare new score to previous score
- Generate comparison report (before/after)
- Send to client via Email Agent
- Alert HELM if score dropped (may need intervention)

**Resource estimate:** 2-3 hours.

#### Phase 3 Exit Criteria
- [ ] Telegram `/geo` command works end-to-end
- [ ] HELM dashboard shows client pipeline
- [ ] Monthly re-audit runs automatically for retainer clients
- [ ] Score comparison reports generated
- [ ] Full pipeline tested: prospect → audit → outreach → convert → deliver → retain

---

## Resource Summary

| Phase | Duration | Human Hours | New Code (est. lines) | New Dependencies |
|-------|----------|-------------|----------------------|------------------|
| Phase 1: Core Engine | 2 weeks | 15-20 hours | ~800-1,200 | None |
| Phase 2: Reports & Outreach | 2 weeks | 12-18 hours | ~600-900 | weasyprint (optional) |
| Phase 3: Automation | 2 weeks | 12-16 hours | ~500-800 | None |
| **Total** | **6 weeks** | **39-54 hours** | **~1,900-2,900** | **0-1** |

### Team Hub Tasks (to create when implementation starts)

1. Write GEO agent prompts (5 dimension + 1 manager)
2. Register GEO squad in team.json
3. Build geo_crawler.py shared module
4. Build geo_scoring.py shared module
5. Test squad on 5+ real websites
6. Design HTML report template
7. Build PDF generator (shared module)
8. Create outreach email templates (3)
9. Build Engine /api/geo/ routes
10. Test end-to-end: URL → PDF → email
11. Add Telegram /geo command
12. Build HELM GEO dashboard
13. Create Supabase migration (geo_audits, geo_clients)
14. Build monthly re-audit cron
15. Run on 10 real prospects as validation

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

**Client onboarding:** Follow `Library/knowledge/reference/client-onboarding-checklist.md`
**Pricing:** Follow `Library/knowledge/reference/agency-pricing-framework.md`
**Delivery:** Follow `Library/knowledge/reference/service-delivery-workflow.md`

---

## Key GEO Checks (Scoring Methodology)

### AI Citability (0-100, weight: 25%)
- Content structured in quotable blocks?
- Clear definitions, stats, comparisons AI can extract?
- FAQ sections with direct Q&A format?
- Unique data/research AI would want to cite?

### Brand Authority (0-100, weight: 20%)
- Wikipedia page exists?
- G2/Trustpilot/review site presence and ratings?
- LinkedIn follower count and activity?
- Press mentions and backlink profile?
- Social proof signals?

### Technical GEO (0-100, weight: 20%)
- `llms.txt` file exists and is spec-compliant?
- `robots.txt` allows AI crawlers (GPTBot, ClaudeBot, PerplexityBot)?
- Key content server-side rendered (not JS-only)?
- Pricing/features accessible without JavaScript execution?
- Fast page load for crawler access?

### Content Quality (0-100, weight: 20%)
- Depth and specificity of content?
- Freshness (recently updated)?
- Comparison content ("X vs Y")?
- How-to and tutorial content?
- Industry-specific expertise signals?

### Schema Markup (0-100, weight: 15%)
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
- **PDF generation dependency** — weasyprint can be heavy; prefer Playwright PDF as zero-dep alternative
- **Rate limiting** — if running many audits in parallel, Claude token budget per hour may become a constraint

---

## Competitive Landscape

- Very few agencies offer GEO specifically (most are still pure SEO)
- Some SEO tools are adding "AI visibility" features (Semrush, Ahrefs) but not as standalone services
- First-mover advantage is real — the agencies that position now will own the market
- OPAI/HELM advantage: fully automated audit + delivery = 95%+ margins vs manual agencies at 40-60%

---

## Validation Milestones

Before going live with paying clients:

1. **Internal validation** — Run GEO audit on all 4 managed WordPress sites. Verify scores are accurate and actionable.
2. **Blind test** — Audit 10 random business websites across different industries. Have a human verify scores make sense.
3. **Report quality** — Show PDF report to 3 non-technical people. Can they understand the findings and action plan?
4. **Outreach test** — Send free audit to 20 prospects. Track open rate, response rate, and conversion to call.
5. **Delivery test** — For 2-3 free or discounted clients, implement optimizations. Re-audit and verify score improvement.

**Go/no-go criteria:**
- Audit produces consistent, defensible scores (human agrees with score +/- 10 points)
- PDF report is professional enough to send to a business owner
- At least 20% of outreach recipients respond
- Optimization implementation measurably improves scores
