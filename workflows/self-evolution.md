---
description: How the agent team detects gaps in its own capabilities and safely evolves itself.
---

# Self-Evolution Workflow

The agent team can identify its own blind spots and propose new agents, prompts, and workflows.

## How It Works

### 1. Run the Evolve Squad
```powershell
.\.agent\scripts\run_squad.ps1 -Squad "evolve"
```

This runs the **self_assessment** meta-agent, which:
- Reads team.json (current roster)
- Reads all prompt_*.txt files (current capabilities)
- Reads .agent/reports/latest/ (quality of recent output)
- Produces a gap analysis with fully specified new agent proposals

### 2. Review the Proposal
The self-assessment report lands in `.agent/reports/<date>/self_assessment.md`.

It contains:
- **Coverage gaps**: what the team can't currently analyze
- **Prompt quality scores**: which prompts need improvement
- **New agent specs**: complete prompt text ready to copy into a new file
- **Workflow suggestions**: new squads or execution patterns

### 3. Human Review (Required)
**The system proposes. A human approves.** This is the safety boundary.

Before adding any new agent, verify:
- [ ] The proposed prompt doesn't grant destructive capabilities (file deletion, deployment, git push)
- [ ] The prompt file name follows the `prompt_<name>.txt` convention
- [ ] The agent is added to team.json with correct metadata
- [ ] The agent is assigned to appropriate squads
- [ ] A test run produces useful output

### 4. Apply Changes

To add a proposed agent:

```powershell
# 1. Create the prompt file (from self_assessment report's FULL PROMPT TEXT)
#   .agent/scripts/prompt_<new_agent>.txt

# 2. Add to team.json roles section

# 3. Add to relevant squads in team.json

# 4. Test it
.\.agent\scripts\run_agents_seq.ps1 -Filter "<new_agent>"

# 5. Verify the report is useful (>1KB, actionable findings)
```

### 5. Continuous Improvement Loop

```
Run Evolve Squad
    |
Review self_assessment.md
    |
Approve / Reject / Modify proposals
    |
Add new agents -> Update team.json
    |
Run the relevant squad with new agent
    |
Evaluate output quality
    |
(repeat monthly or after major changes)
```

## Safety Guardrails

1. **No auto-apply**: The self-assessment agent can PROPOSE but never directly create files or modify team.json
2. **Read-only agents**: All agents use `claude -p` (pipe mode) which outputs to stdout -- they cannot modify the codebase
3. **Human gate**: Every new agent must be reviewed before being added to the roster
4. **Prompt auditing**: The self-assessment agent evaluates ALL prompts, including its own, for safety and quality
5. **Rollback**: Since reports are timestamped, you can always compare before/after to see if a change improved output quality

## When to Run Evolve

- After adding a major new feature area (new tech, new integration)
- After noticing repeated manual work that an agent could automate
- Monthly as part of project health checks
- When agent reports consistently miss important issues
- When the project's tech stack changes significantly
