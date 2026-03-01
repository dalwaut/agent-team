# Agent Team Template: Marketing Campaign Launch

> **Pattern:** Hybrid wave (parallel creative → sequential QA)
> **Agents:** 4 (Email Marketer, Social Media Manager, Ad Copywriter, Landing Page Creator)
> **Execution:** Wave 1: parallel content creation. Wave 2: cross-review for consistency.

---

## When to Use

- Product or feature launches requiring multi-channel assets
- Seasonal marketing campaigns
- Event promotion across channels
- Brand campaigns with unified messaging

---

## Team Composition

| Role | Deliverable | Platform |
|------|------------|----------|
| Email Marketer | Email sequence (3-5 emails) | Email / newsletter |
| Social Media Manager | Social posts for 2-3 platforms | LinkedIn, Twitter/X, Instagram |
| Ad Copywriter | Ad copy for 2-3 channels | Google Ads, Meta Ads, LinkedIn Ads |
| Landing Page Creator | Landing page copy and structure | Web |

---

## Prompt Template

```
Create an agent team to produce a complete marketing campaign for:

Campaign: [CAMPAIGN NAME]
Product/Service: [WHAT YOU'RE PROMOTING]
Target audience: [WHO — demographics, psychographics, pain points]
Key message: [CORE VALUE PROPOSITION — 1-2 sentences]
Campaign dates: [START - END]
Brand voice: [TONE — e.g., professional but approachable, bold and direct]
CTA: [PRIMARY CALL TO ACTION — e.g., "Start free trial", "Book a demo"]

Spawn 4 teammates:

1. **Email Marketer**: Create a 3-email nurture sequence:
   - Email 1 (Day 0): Awareness — introduce the problem and hint at solution
   - Email 2 (Day 3): Value — showcase benefits with proof points
   - Email 3 (Day 7): Conversion — urgency + clear CTA
   For each email: subject line, preview text, body, CTA button text.
   Before writing, identify 3 compelling insights from the campaign brief.
   Save to: [OUTPUT_DIR]/email-sequence.md

2. **Social Media Manager**: Create social media content:
   - LinkedIn: 2 posts (1 thought leadership, 1 product-focused)
   - Twitter/X: 3 tweets (1 announcement, 1 benefit-focused, 1 social proof)
   - Instagram: 1 caption + image concept
   Include hashtag strategy and posting schedule.
   Before writing, identify 3 compelling insights from the campaign brief.
   Save to: [OUTPUT_DIR]/social-media.md

3. **Ad Copywriter**: Create advertising copy:
   - Google Search Ads: 3 responsive ad variations (headlines + descriptions)
   - Meta/Facebook Ads: 2 ad variations (primary text + headline + description)
   - LinkedIn Ads: 1 sponsored content ad
   Include targeting suggestions and A/B test recommendations.
   Before writing, identify 3 compelling insights from the campaign brief.
   Save to: [OUTPUT_DIR]/ad-copy.md

4. **Landing Page Creator**: Design the campaign landing page:
   - Hero section: headline, subheadline, CTA
   - Problem/solution section
   - Features/benefits (3-5 key points)
   - Social proof section (testimonial placeholders)
   - FAQ section (3-5 anticipated questions)
   - Final CTA section
   Include wireframe description and copy for each section.
   Before writing, identify 3 compelling insights from the campaign brief.
   Save to: [OUTPUT_DIR]/landing-page.md

Coordination rules:
- All 4 teammates create content in parallel (Wave 1)
- After Wave 1, each teammate reviews ONE other teammate's work for:
  - Brand voice consistency
  - Messaging alignment (same key benefits highlighted)
  - CTA consistency (driving to same action)
  - No contradictory claims
- Share review feedback with each other
- Revise if inconsistencies found

After all teammates finish, produce a Campaign Launch Checklist:
- All assets listed with status
- Messaging consistency audit
- Suggested launch timeline
- Any gaps that need human creative input
Save to: [OUTPUT_DIR]/launch-checklist.md
```

---

## Customization Options

- **Add PR agent**: Press release, media pitch, talking points
- **Add video scriptwriter**: YouTube ad script, product demo script
- **Reduce scope**: Drop Ad Copywriter for organic-only campaigns
- **Add analytics agent**: UTM strategy, tracking plan, KPI definitions

---

## Expected Output

```
[OUTPUT_DIR]/
├── email-sequence.md     # 3-email nurture sequence
├── social-media.md       # Multi-platform social content
├── ad-copy.md            # Paid advertising copy
├── landing-page.md       # Landing page copy and structure
└── launch-checklist.md   # Campaign readiness audit
```
