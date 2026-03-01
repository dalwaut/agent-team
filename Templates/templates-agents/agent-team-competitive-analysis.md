# Agent Team Template: Competitive Intelligence Report

> **Pattern:** Parallel collectors → unified analyst
> **Agents:** 4-5 (Platform Analysts + Synthesis Lead)
> **Execution:** All analysts research in parallel, then lead synthesizes

---

## When to Use

- Market research and competitive positioning
- Vendor or tool evaluation and selection
- Industry landscape mapping
- Feature comparison across competing products

---

## Team Composition

| Role | Responsibility | Output |
|------|---------------|--------|
| Analyst 1 | Deep-dive on Competitor A | Standardized competitor profile |
| Analyst 2 | Deep-dive on Competitor B | Standardized competitor profile |
| Analyst 3 | Deep-dive on Competitor C | Standardized competitor profile |
| Analyst 4 | Deep-dive on Competitor D | Standardized competitor profile |
| Synthesis Lead | Compare all profiles, identify patterns | Unified intelligence report |

---

## Prompt Template

```
Create an agent team to produce a competitive intelligence report on
[MARKET/CATEGORY].

Competitors to analyze:
1. [COMPETITOR A]
2. [COMPETITOR B]
3. [COMPETITOR C]
4. [COMPETITOR D]

Our position: [BRIEF DESCRIPTION OF YOUR PRODUCT/SERVICE]

Spawn 5 teammates:

1. **[COMPETITOR A] Analyst**: Research [COMPETITOR A] thoroughly. Use web search
   to gather current data. Produce a standardized profile covering:
   - Product overview and core value proposition
   - Key features and capabilities
   - Pricing model and tiers
   - Target market and customer segments
   - Strengths (3-5 specific advantages)
   - Weaknesses (3-5 specific gaps)
   - Recent developments (last 6 months)
   - Market positioning
   Save to: [OUTPUT_DIR]/profile-[competitor-a].md

2. **[COMPETITOR B] Analyst**: [Same structure as above for Competitor B]
   Save to: [OUTPUT_DIR]/profile-[competitor-b].md

3. **[COMPETITOR C] Analyst**: [Same structure as above for Competitor C]
   Save to: [OUTPUT_DIR]/profile-[competitor-c].md

4. **[COMPETITOR D] Analyst**: [Same structure as above for Competitor D]
   Save to: [OUTPUT_DIR]/profile-[competitor-d].md

5. **Synthesis Lead**: Wait for all 4 analysts to complete their profiles.
   Then produce a unified competitive intelligence report:
   - Executive summary (1 paragraph)
   - Feature comparison matrix (table format)
   - Pricing comparison table
   - Strength/weakness heatmap (which competitors excel where)
   - Market positioning map (describe quadrant placement)
   - Opportunities: gaps in the market we can exploit
   - Threats: areas where competitors are pulling ahead
   - Strategic recommendations (3-5 actionable items)
   Save to: [OUTPUT_DIR]/competitive-intelligence-report.md

Coordination rules:
- All 4 analysts work independently and in parallel
- Use the SAME standardized format so profiles are directly comparable
- Synthesis Lead should compare angles and flag where analysts found
  contradictory information
- If an analyst cannot find reliable data for a section, mark it as
  "[DATA NEEDED]" rather than speculating

After the Synthesis Lead finishes, provide the executive summary and
top 3 strategic recommendations.
```

---

## Customization Options

- **Fewer competitors**: Drop to 3 analysts for a focused comparison
- **Add market analyst**: Extra agent researching industry trends, TAM/SAM/SOM
- **Add customer voice**: Agent researching customer reviews and sentiment for each competitor
- **Vertical focus**: Narrow analyst scope to specific verticals or use cases

---

## Expected Output

```
[OUTPUT_DIR]/
├── profile-competitor-a.md             # Individual competitor profile
├── profile-competitor-b.md             # Individual competitor profile
├── profile-competitor-c.md             # Individual competitor profile
├── profile-competitor-d.md             # Individual competitor profile
└── competitive-intelligence-report.md  # Unified analysis with recommendations
```
