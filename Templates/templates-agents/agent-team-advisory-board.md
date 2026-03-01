# Agent Team Template: AI Advisory Board

> **Pattern:** Parallel perspectives → moderator synthesis
> **Agents:** 5 (Market Researcher, Financial Modeler, Devil's Advocate, Competitive Strategist, Audience Analyst)
> **Execution:** All agents analyze simultaneously, then lead moderates consensus

---

## When to Use

- Strategic business decisions (enter a market, launch a product, pivot)
- Investment or acquisition evaluation
- Product strategy and roadmap decisions
- Risk assessment from multiple angles
- "Should we do X?" questions that need rigorous multi-perspective analysis

---

## Team Composition

| Role | Perspective | Focus |
|------|------------|-------|
| Market Researcher | Market opportunity | TAM, trends, timing, demand signals |
| Financial Modeler | Financial viability | Revenue model, unit economics, ROI, break-even |
| Devil's Advocate | Risk and failure modes | What could go wrong, hidden assumptions, biases |
| Competitive Strategist | Competitive landscape | Defensibility, differentiation, market dynamics |
| Audience Analyst | Customer/user perspective | Needs, willingness to pay, adoption barriers |

---

## Prompt Template

```
Create an agent team to serve as an AI Advisory Board for the following
strategic question:

"""
[STRATEGIC QUESTION — e.g., "Should we launch a B2B SaaS product for
AI-powered inventory management targeting mid-market retailers?"]
"""

Context:
- Company: [YOUR COMPANY / SITUATION]
- Resources available: [BUDGET, TEAM, TIMELINE]
- Current position: [RELEVANT BACKGROUND]

Spawn 5 teammates:

1. **Market Researcher**: Analyze the market opportunity:
   - Total addressable market (TAM) and serviceable market (SAM)
   - Market trends and growth trajectory
   - Timing analysis — is this the right moment?
   - Demand signals and unmet needs
   - Regulatory or macro factors
   Verdict: Bull case, base case, bear case with probabilities.
   Save to: [OUTPUT_DIR]/market-analysis.md

2. **Financial Modeler**: Assess financial viability:
   - Revenue model options and recommended approach
   - Unit economics (CAC, LTV, margins)
   - Investment required and runway implications
   - Break-even timeline under optimistic/realistic/pessimistic scenarios
   - Comparison to alternative uses of the same resources
   Verdict: Go/no-go with financial confidence level.
   Save to: [OUTPUT_DIR]/financial-model.md

3. **Devil's Advocate**: Challenge the premise:
   - What are the hidden assumptions in this plan?
   - Top 5 failure modes and their likelihood
   - What would make you NOT do this?
   - Cognitive biases that might be influencing the decision
   - Historical examples of similar ventures that failed and why
   Verdict: Strongest argument against, and what evidence would change your mind.
   Save to: [OUTPUT_DIR]/devils-advocate.md

4. **Competitive Strategist**: Evaluate competitive dynamics:
   - Who are the existing players and what are they doing?
   - Barriers to entry and defensibility
   - Differentiation opportunity (what can we do that others can't?)
   - Likely competitive response if we enter
   - Partnership or acquisition alternatives
   Verdict: Competitive advantage assessment (strong/moderate/weak).
   Save to: [OUTPUT_DIR]/competitive-strategy.md

5. **Audience Analyst**: Represent the customer perspective:
   - Who exactly is the target customer? (persona)
   - What is their current pain and how are they solving it today?
   - Willingness to pay and price sensitivity
   - Adoption barriers and switching costs
   - What would make them choose us over alternatives?
   Verdict: Product-market fit assessment (strong/moderate/weak signal).
   Save to: [OUTPUT_DIR]/audience-analysis.md

Coordination rules:
- All 5 advisors work independently to avoid groupthink
- Each advisor MUST provide a clear verdict, not just analysis
- The Devil's Advocate should explicitly challenge at least one point from
  each other advisor
- Share insights with each other after initial analysis to identify blind spots

After all advisors complete their analysis, synthesize into a Board Decision:
- Consensus view (if any)
- Minority opinions and dissent
- Key uncertainties that need resolution
- Recommended next steps (go / no-go / investigate further)
- Top 3 risks and mitigations
Save to: [OUTPUT_DIR]/board-decision.md
```

---

## Customization Options

- **Add Technical Advisor**: Feasibility, build vs buy, tech stack risks
- **Add Legal/Compliance**: Regulatory risk, IP concerns, liability
- **Reduce to 3 agents**: Market + Financial + Devil's Advocate for simpler decisions
- **Shift domain**: Works for product decisions, hiring, partnerships, M&A — just adjust the advisor roles

---

## Expected Output

```
[OUTPUT_DIR]/
├── market-analysis.md        # Market opportunity assessment
├── financial-model.md        # Financial viability and projections
├── devils-advocate.md        # Counter-arguments and risk analysis
├── competitive-strategy.md   # Competitive landscape and positioning
├── audience-analysis.md      # Customer perspective and PMF signal
└── board-decision.md         # Synthesized recommendation
```
