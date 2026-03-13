# Generative Engine Optimization (GEO)

**Date saved:** 2026-02-28
**Source:** [Zubair Trabzada — YouTube](https://www.youtube.com/watch?v=Uyf8ehWyLto)

---

## What Is GEO

Generative Engine Optimization (GEO) is the practice of optimizing websites and content to be discoverable, citable, and recommendable by AI search systems — ChatGPT, Perplexity, Google AI Overviews, Gemini, and Bing Copilot.

**GEO is to AI search what SEO is to Google search.**

Traditional SEO optimizes for search engine crawlers and ranking algorithms. GEO optimizes for large language models that read, summarize, and recommend content in conversational search.

---

## Why It Matters

- AI search traffic growing 500% year-over-year
- Projected $7B market in next 2-3 years
- Only ~23% of marketers are thinking about this
- A website can rank well on Google but be invisible to AI search
- AI platforms work differently from each other — a site might show up on ChatGPT but not Perplexity

---

## Key GEO Signals

### 1. AI Crawler Access
- `robots.txt` must allow AI crawlers: `GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended`
- `llms.txt` file — a spec-compliant markdown file describing the site for LLMs (similar to `robots.txt` but for AI)

### 2. Content Structure
- Content in quotable, extractable blocks (not walls of text)
- Clear definitions, statistics, comparisons
- FAQ format with direct Q&A
- Unique data and original research (AI prefers to cite primary sources)
- Comparison content ("X vs Y") — AI frequently answers comparison queries

### 3. Schema Markup
- Organization, Product/SoftwareApplication, FAQ, Person, Offer, Review schemas
- Structured data helps AI systems understand entity relationships
- Schema is the bridge between HTML content and AI comprehension

### 4. Server-Side Rendering
- Key content (pricing, features, FAQ) must be in the HTML, not loaded via JavaScript API calls
- AI crawlers generally don't execute JavaScript
- If pricing is behind a JS API call, AI literally cannot answer "How much does X cost?"

### 5. Brand Authority Signals
- Wikipedia page
- Review site presence (G2, Trustpilot, Capterra)
- LinkedIn follower count and activity
- Press mentions and backlinks
- Social proof that AI can verify and cite

---

## AI Platforms and How They Differ

| Platform | How It Sources | Notes |
|----------|---------------|-------|
| ChatGPT | Web browsing + training data + plugins | Cites sources, prefers structured content |
| Perplexity | Real-time web search + citations | Heavy citation focus, structured content wins |
| Google AI Overviews | Google index + knowledge graph | Schema markup matters most here |
| Gemini | Google search integration | Similar to AI Overviews, Google ecosystem |
| Bing Copilot | Bing index + web search | `llms.txt` and `robots.txt` important |

---

## The `llms.txt` Spec

A relatively new standard — a markdown file at the root of a website (`/llms.txt`) that describes the site for LLMs:

```markdown
# Site Name

> Brief description of what this site/company does

## Key Pages
- /pricing: Pricing plans and features
- /docs: Documentation
- /blog: Industry insights and tutorials

## Company Info
- Founded: 2020
- Headquarters: San Francisco, CA
- Industry: SaaS / Form Building
```

**Key requirement:** Must be spec-compliant markdown format, not just plain text.

---

## OPAI Context

- Full business playbook: `Library/helm-playbooks/geo-audit-service.md`
- HELM manages WordPress sites that should be GEO-optimized
- GEO audit is a candidate agency service for v4 revenue
- The scoring methodology (5 dimensions, 0-100) maps to OPAI's agent framework
