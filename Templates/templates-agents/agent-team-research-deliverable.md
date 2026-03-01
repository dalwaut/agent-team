# Agent Team Template: Research & Deliverable Builder

> **Pattern:** Sequential handoff (research → analysis → production)
> **Agents:** 3 (Researcher, Analyst/Writer, Designer/Formatter)
> **Execution:** Pipeline — each agent waits for the prior one to complete
> **Token cost:** ~150K

---

## When to Use

- Creating investor pitch decks from raw research
- Building strategy documents or whitepapers
- Producing sales presentations from market data
- Any pipeline where research feeds writing feeds formatting

---

## Team Composition

| Role | Responsibility | Depends On | Output |
|------|---------------|------------|--------|
| Researcher | Deep research and fact gathering | None | Structured research brief |
| Slide Writer / Analyst | Structure narrative from research | Researcher | Outlined deliverable with key messages |
| Designer / Formatter | Final formatting and polish | Slide Writer | Production-ready deliverable |

---

## Prompt Template

```
Create an agent team to research and build a [DELIVERABLE TYPE] on [TOPIC].

This is a sequential pipeline — each teammate waits for the prior one to finish.

Spawn 3 teammates:

1. **Researcher**: Investigate [TOPIC] thoroughly. Cover:
   - [RESEARCH AREA 1]
   - [RESEARCH AREA 2]
   - [RESEARCH AREA 3]
   Compile findings into a structured research brief with sections, key data
   points, and source citations. Include a "Key Findings" summary at the top.
   Save output to: [OUTPUT_DIR]/research-brief.md

2. **Slide Writer**: Wait for the Researcher to complete their brief.
   Read the research brief and structure it into a [10-12] section outline:
   - Opening hook / problem statement
   - Market context / opportunity
   - [SPECIFIC SECTIONS FOR YOUR DELIVERABLE]
   - Key takeaways
   - Call to action / next steps
   Each section should have: headline, 2-3 bullet points, supporting data.
   Save output to: [OUTPUT_DIR]/outline.md

3. **Designer**: Wait for the Slide Writer to complete the outline.
   Take the outline and produce the final [DELIVERABLE TYPE]:
   - Apply consistent formatting (headers, bullets, emphasis)
   - Add transition language between sections
   - Ensure data visualization suggestions where applicable
   - Include speaker notes or annotations
   Save output to: [OUTPUT_DIR]/final-[DELIVERABLE].md

Require plan approval before the Researcher begins investigating.
After all teammates finish, provide a brief summary of the deliverable and
any areas that may need human review.
```

---

## Variants

### Investor Pitch Deck
Replace `[TOPIC]` with company/product, research areas with market size + competition + financials.

### Whitepaper
Extend Researcher scope, add a 4th agent (Editor) for citations and peer-review quality.

### Sales Presentation
Focus Researcher on prospect-specific data, Slide Writer on pain points → solution → ROI.

---

## Expected Output

```
[OUTPUT_DIR]/
├── research-brief.md     # Raw research with citations
├── outline.md            # Structured narrative outline
└── final-deliverable.md  # Production-ready document
```
