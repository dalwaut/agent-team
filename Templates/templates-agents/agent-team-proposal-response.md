# Agent Team Template: Proposal / RFP Response

> **Pattern:** Parallel research + sequential assembly
> **Agents:** 4 (RFP Analyst, Capability Researcher, Writer A, Writer B)
> **Execution:** Two waves — parallel research, then parallel writing
> **Token cost:** ~180K

---

## When to Use

- Responding to RFPs (Request for Proposals)
- Grant applications with multiple required sections
- Partnership or vendor proposals
- Formal bids that require both requirement analysis and capability matching

---

## Team Composition

| Role | Wave | Responsibility | Output |
|------|------|---------------|--------|
| RFP Analyst | 1 (parallel) | Parse requirements, scoring criteria, mandatory sections | Requirements matrix |
| Capability Researcher | 1 (parallel) | Audit company capabilities, past work, differentiators | Capability inventory |
| Writer A | 2 (parallel) | Draft technical/approach sections using Wave 1 outputs | Technical proposal sections |
| Writer B | 2 (parallel) | Draft management/qualifications sections using Wave 1 outputs | Management proposal sections |

---

## Prompt Template

```
Create an agent team to respond to the following RFP / proposal request.

RFP Document:
"""
[PASTE RFP CONTENT OR PROVIDE FILE PATH]
"""

Company context: [BRIEF DESCRIPTION OF YOUR COMPANY AND RELEVANT EXPERIENCE]
Deadline: [DATE]
Evaluation criteria: [IF KNOWN — e.g., technical approach 40%, experience 30%, cost 30%]

Spawn 4 teammates in two waves:

**Wave 1 — Research (parallel):**

1. **RFP Analyst**: Parse the RFP document and extract:
   - All mandatory requirements (must-have)
   - Evaluation criteria and scoring weights
   - Required sections and page limits
   - Key dates, submission format, questions
   - Compliance checklist
   Save to: [OUTPUT_DIR]/requirements-matrix.md

2. **Capability Researcher**: Audit our company capabilities:
   - Relevant past projects and case studies
   - Team qualifications and certifications
   - Technical capabilities matching RFP requirements
   - Differentiators and competitive advantages
   - Any gaps that need addressing
   Save to: [OUTPUT_DIR]/capability-inventory.md

**Wave 2 — Writing (parallel, depends on Wave 1):**

3. **Writer A**: Wait for both Wave 1 agents to finish. Using the requirements
   matrix and capability inventory, draft the technical sections:
   - Technical approach / methodology
   - Solution architecture
   - Implementation timeline
   - Risk mitigation
   Save to: [OUTPUT_DIR]/technical-sections.md

4. **Writer B**: Wait for both Wave 1 agents to finish. Using the requirements
   matrix and capability inventory, draft the management sections:
   - Company overview and qualifications
   - Team bios and org chart
   - Past performance / case studies
   - Quality assurance approach
   Save to: [OUTPUT_DIR]/management-sections.md

Coordination rules:
- Wave 2 agents MUST NOT start until both Wave 1 agents are complete
- Writers should cross-reference to avoid duplicating content
- Flag any RFP requirements that cannot be adequately addressed
- Maintain consistent terminology throughout

After all teammates finish, assemble a final proposal outline showing:
- All sections in order
- Compliance checklist (requirement → where addressed)
- Any gaps or areas needing human review
Save to: [OUTPUT_DIR]/proposal-assembly.md
```

---

## Customization Options

- **Add pricing agent**: 5th agent in Wave 2 for cost modeling and budget tables
- **Add editor**: 5th agent in Wave 3 for consistency review and compliance check
- **Single writer**: Merge Writer A + B for simpler proposals
- **Expand research**: Add a Competitor Researcher in Wave 1 to analyze likely competing bids

---

## Expected Output

```
[OUTPUT_DIR]/
├── requirements-matrix.md    # Parsed RFP requirements
├── capability-inventory.md   # Company capability audit
├── technical-sections.md     # Technical proposal content
├── management-sections.md    # Management proposal content
└── proposal-assembly.md      # Final assembly with compliance check
```
