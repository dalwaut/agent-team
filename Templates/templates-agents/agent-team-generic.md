# Agent Team Template: Generic / Custom

> **Pattern:** Configurable — select parallel, sequential, or hybrid
> **Agents:** 3-5 (define based on task)
> **Execution:** Choose the model that fits your task

---

## When to Use

- Any task that doesn't fit the other 6 specific templates
- Custom team compositions for unique workflows
- Experimentation with agent team patterns
- One-off tasks that need multi-perspective analysis

---

## Choosing Your Pattern

| Pattern | Use When | Example |
|---------|----------|---------|
| **Parallel** | Agents can work independently on different aspects | Research, review, content creation |
| **Sequential Handoff** | Each step depends on the prior one | Research → writing → editing pipeline |
| **Parallel → Synthesis** | Independent research needs unified output | Competitive analysis, advisory boards |
| **Hybrid Wave** | Creative work + quality review | Campaign creation, multi-deliverable projects |
| **Sub-agent + Team** | Need discovery before team build | Complex builds needing initial recon |

---

## Prompt Template

```
Create an agent team to [TASK DESCRIPTION].

Context:
"""
[RELEVANT BACKGROUND, DATA, OR REQUIREMENTS]
"""

Goal: [SPECIFIC DELIVERABLE OR OUTCOME]

Spawn [N] teammates:

1. **[ROLE NAME]**: [SPECIFIC RESPONSIBILITIES]
   - [Key focus area 1]
   - [Key focus area 2]
   - [Key focus area 3]
   [DEPENDENCY: "Wait for [other agent] to complete" OR "Work independently"]
   Save output to: [OUTPUT_DIR]/[filename].md

2. **[ROLE NAME]**: [SPECIFIC RESPONSIBILITIES]
   - [Key focus area 1]
   - [Key focus area 2]
   - [Key focus area 3]
   [DEPENDENCY]
   Save output to: [OUTPUT_DIR]/[filename].md

3. **[ROLE NAME]**: [SPECIFIC RESPONSIBILITIES]
   - [Key focus area 1]
   - [Key focus area 2]
   - [Key focus area 3]
   [DEPENDENCY]
   Save output to: [OUTPUT_DIR]/[filename].md

[ADD MORE AGENTS AS NEEDED — recommended max: 5]

Coordination rules:
- [HOW AGENTS SHARE INFORMATION]
- [QUALITY GATES: "Before [action], each teammate should [condition]"]
- [CONFLICT RESOLUTION: "If agents disagree, [approach]"]
- [OUTPUT FORMAT: "Use standardized format for comparability"]

[CHOOSE ONE:]
- [PARALLEL]: "All teammates work independently and simultaneously"
- [SEQUENTIAL]: "Teammates work in order, each waiting for the prior one"
- [SYNTHESIS]: "After all teammates finish, synthesize findings into [deliverable]"
- [HYBRID]: "Wave 1: [agents] work in parallel. Wave 2: [agents] review/build on Wave 1"

Require plan approval before teammates start [building/writing/implementing].

After all teammates finish:
- [FINAL SYNTHESIS INSTRUCTIONS]
- [WHAT TO FLAG FOR HUMAN REVIEW]
Save final output to: [OUTPUT_DIR]/[final-deliverable].md
```

---

## Design Checklist

Before launching a custom team, verify:

- [ ] **3-5 agents** — sweet spot for cost vs. value
- [ ] **Clear roles** — each agent has distinct, non-overlapping responsibility
- [ ] **Defined outputs** — each agent knows what file to produce and in what format
- [ ] **Dependencies explicit** — sequential steps clearly state "wait for X"
- [ ] **Quality gates** — conditions that must be met before proceeding
- [ ] **Inter-agent communication** — "share insights to avoid overlap"
- [ ] **Synthesis step** — final comparison/unification of outputs
- [ ] **Human review flags** — what needs human attention before using outputs

---

## Quick Prompt Fragments

### Force communication
```
Share insights with each other to ensure no overlap or contradiction.
```

### Quality gate
```
Before writing, each teammate should identify 3 compelling insights from the source material.
```

### Human-in-the-loop
```
Require plan approval before they start building.
```

### Postmortem synthesis
```
After all teammates finish, compare angles and flag where findings contradict.
```

### Sequential dependency
```
Wait for the Researcher to complete their brief before starting your section.
```

### Conflict resolution
```
If you disagree with another teammate's analysis, document the disagreement
with supporting evidence rather than silently overriding.
```

### File ownership
```
Each teammate owns their assigned files exclusively. Do not modify files
assigned to other teammates.
```

---

## Anti-Patterns to Avoid

| Problem | Fix |
|---------|-----|
| >5 agents | Combine roles or split into 2 sequential teams |
| No output format | Specify file format and structure for each agent |
| Agents editing same files | Assign file ownership explicitly |
| No synthesis step | Always add a final comparison/unification agent or step |
| Vague roles | Each agent needs 3+ specific focus areas |
| No gates | Add "before X, do Y" conditions to prevent premature work |
