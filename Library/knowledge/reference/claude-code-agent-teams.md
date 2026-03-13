# Claude Code Agent Teams — 7 Practical Use Case Patterns

> **Source:** "7 Things You Can Build with Claude Code Agent Teams" — Mark Kashef ([YouTube](https://www.youtube.com/watch?v=dlb_XgFVrHQ))
> **Supplemented with:** [Official Anthropic Docs](https://code.claude.com/docs/en/agent-teams)
> **Saved:** 2026-02-28

---

## Overview

Claude Code Agent Teams let you coordinate multiple Claude Code instances working together on a shared task. One session acts as team lead, spawning teammates that work independently in their own context windows while communicating via a shared task list and mailbox system.

This differs from **sub-agents** (Task tool): sub-agents work in parallel but don't communicate with each other — they only report back to the caller. Agent teams have full inter-agent messaging and shared coordination.

### When to Use Agent Teams vs Sub-Agents

| Factor | Sub-Agents (Task tool) | Agent Teams |
|--------|----------------------|-------------|
| Communication | Report results to caller only | Message each other directly |
| Coordination | Caller manages all work | Shared task list, self-coordination |
| Context | Own window; results summarized back | Own window; fully independent |
| Token cost | Lower | Higher (each teammate = separate instance) |
| Best for | Focused tasks where only result matters | Complex work requiring discussion/collaboration |

**Rule of thumb:** Use sub-agents for grunt work (research, verification). Use agent teams when agents need to share findings, challenge each other, and self-coordinate.

---

## Key Principles

1. **Explicit phrasing** — Say "create an agent team" or "spawn an agent team" (not just "spawn agents") to ensure Claude creates a team with inter-agent communication
2. **Team sizing** — Sweet spot is **3-5 agents** per team. Beyond that, diminishing returns and token waste. Aim for 5-6 tasks per teammate.
3. **Role specificity** — Define each agent's role, inputs, outputs, conditions, and output location
4. **Inter-agent communication** — Force it: "share insights with each other to ensure no overlap"
5. **Human-in-the-loop** — "Require plan approval before they start building" triggers the `ask_user_input` tool
6. **Conditions as gates** — "Before writing, each teammate should identify 3 compelling insights" prevents premature work
7. **Postmortem synthesis** — Always request a final summary comparing angles and flagging inconsistencies

---

## Execution Models

| Model | Description | Best For |
|-------|-------------|----------|
| **Parallel** | All agents work simultaneously on independent tasks | Research, review, content creation |
| **Sequential Handoff** | Each agent waits for the prior one to complete | Pipeline workflows (research → writing → design) |
| **Parallel → Synthesis** | Agents research independently, then a lead synthesizes | Competitive analysis, advisory boards |
| **Hybrid Wave** | Parallel creative wave followed by sequential QA/review | Campaign launches, multi-deliverable projects |
| **Sub-agent + Team Hybrid** | Sub-agents for recon/exploration, then agent team for build | Complex builds that need initial discovery |

---

## The 7 Use Cases

### 1. Content Repurposing Engine

**Pattern:** Parallel specialists → synthesizer
**Agents:** Blog Writer, LinkedIn Writer, Newsletter Writer, Twitter/X Writer
**Execution:** All 4 agents work in parallel on the same source content, each adapting it to their platform's format and conventions.

**Key prompt elements:**
- Provide the source content (article, transcript, notes)
- Each agent gets platform-specific constraints (character limits, tone, format)
- Agents share insights to ensure no overlap or contradiction
- Final synthesis compares all outputs for consistency

**When to use:** Repurposing a blog post, video transcript, or keynote into multi-platform content.

---

### 2. Research & Pitch Deck Builder

**Pattern:** Sequential handoff (research → slides → design)
**Agents:** Researcher, Slide Writer, Designer
**Execution:** Sequential pipeline — Researcher produces findings, Slide Writer structures the narrative, Designer formats the output.
**Token cost:** ~150K

**Key prompt elements:**
- Researcher: "Investigate [topic], compile findings into structured brief"
- Slide Writer: "Wait for research brief. Structure into 10-12 slide outline with key messages"
- Designer: "Wait for slide outline. Create final presentation with formatting guidance"
- Each agent explicitly waits for the prior one's output

**When to use:** Creating investor decks, sales presentations, internal strategy decks from raw research.

---

### 3. RFP / Proposal Response

**Pattern:** Parallel research → sequential assembly
**Agents:** RFP Analyst, Capability Researcher, Writer A, Writer B
**Execution:** Two waves — Wave 1: Analyst and Researcher work in parallel to parse requirements and gather company capabilities. Wave 2: Writers produce different proposal sections using the research.
**Token cost:** ~180K

**Key prompt elements:**
- Wave 1 (parallel): RFP Analyst parses the RFP requirements; Capability Researcher audits company assets
- Wave 2 (parallel, depends on Wave 1): Writers draft proposal sections using both inputs
- Final assembly: Lead synthesizes into cohesive proposal

**When to use:** Responding to RFPs, grant applications, partnership proposals.

---

### 4. Competitive Intelligence Report

**Pattern:** Parallel collectors → unified analyst
**Agents:** 4 Platform Analysts + Synthesis Lead
**Execution:** Each analyst independently researches one competitor/platform, then the Synthesis Lead produces a unified comparison report.

**Key prompt elements:**
- Each analyst gets one specific competitor to research
- Standardized output format (features, pricing, strengths, weaknesses, market position)
- Synthesis Lead compares all reports, identifies patterns, flags inconsistencies
- Postmortem: "Compare angles and flag where analysts disagree"

**When to use:** Market research, vendor evaluation, competitive positioning.

---

### 5. AI Advisory Board

**Pattern:** Parallel perspectives → moderator synthesis
**Agents:** Market Researcher, Financial Modeler, Devil's Advocate, Competitive Strategist, Audience Analyst
**Execution:** All 5 agents analyze the same business question from their unique perspective, then a moderator (the lead) synthesizes consensus and highlights disagreements.

**Key prompt elements:**
- Each agent has a distinct analytical lens
- Devil's Advocate specifically challenges assumptions
- Agents explicitly share insights and challenge each other
- Final output: consensus view + minority opinions + risk factors

**When to use:** Strategic decisions, product launches, market entry, investment evaluation.

---

### 6. Marketing Campaign Launch

**Pattern:** Hybrid wave (parallel creative → sequential QA)
**Agents:** Email Marketer, Social Media Manager, Ad Copywriter, Landing Page Creator
**Execution:** Wave 1: All agents create their deliverables in parallel. Wave 2: Cross-review for brand consistency, messaging alignment, and CTA coordination.

**Key prompt elements:**
- Shared brand guidelines and campaign brief as input
- Each agent creates platform-specific content
- Consistency review: "Before finalizing, each teammate reviews one other teammate's work for brand alignment"
- Gate: "Before writing, identify 3 compelling insights from the campaign brief"

**When to use:** Product launches, seasonal campaigns, multi-channel marketing pushes.

---

### 7. Personal AI Assistant (Technical Build)

**Pattern:** Sub-agent recon → agent team build
**Agents:** Sub-agent (repo analysis) + Architect, Telegram Bot Builder, Skill Router, Memory Manager, CLI Builder
**Execution:** First, a sub-agent explores the repo and maps the codebase. Then an agent team builds modules in parallel based on the analysis.
**Build time:** ~20-30 min

**Key prompt elements:**
- Sub-agent phase: "Explore the repository, identify structure, dependencies, and integration points"
- Agent team phase: Each agent owns a specific module/layer
- Plan approval: "Require plan approval before building"
- File ownership: Each agent owns distinct files to avoid conflicts

**When to use:** Building multi-module applications, microservices, plugin systems.

---

## Prompt Engineering Best Practices

### Structure
```
Create an agent team to [task description].

Spawn [N] teammates:
- [Role 1]: [specific responsibilities and focus area]
- [Role 2]: [specific responsibilities and focus area]
- [Role N]: [specific responsibilities and focus area]

Coordination rules:
- [How agents should share information]
- [What gates/conditions must be met]
- [Output format and location]

After all teammates finish, synthesize findings into [deliverable].
```

### Critical Phrases
- "Create an agent team" — ensures full team with communication (not just sub-agents)
- "Share insights with each other to ensure no overlap" — forces inter-agent coordination
- "Require plan approval before they start building" — triggers human-in-the-loop
- "Before writing, each teammate should identify [N] compelling insights" — quality gate
- "Wait for [agent] to complete before proceeding" — enforces sequential handoff
- "Compare angles and flag inconsistencies" — postmortem synthesis

### Anti-Patterns
- Spawning too many agents (>5) — diminishing returns, exponential token cost
- Not specifying output format — agents produce inconsistent deliverables
- No inter-agent communication instructions — agents work in silos
- Sequential tasks using parallel agents — wastes tokens on idle agents
- Same-file editing by multiple agents — causes overwrites and conflicts

---

## Integration with OPAI

OPAI's existing 42-role agent framework (`team.json`) already defines specialized roles. Agent teams complement this by enabling **runtime composition** — dynamically assembling teams from available roles for specific tasks.

**Mapping to OPAI patterns:**
- OPAI squads (26 predefined) → Static team compositions for known workflows
- Agent teams → Dynamic compositions for ad-hoc tasks
- The `/atb` skill bridges both: it selects the optimal pattern and spawns the team

**Templates:** Reusable prompt templates for each pattern live in `Templates/templates-agents/agent-team-*.md`.

---

## Quick Reference

| Use Case | Pattern | Agents | Template |
|----------|---------|--------|----------|
| Content Repurposing | Parallel + synthesis | 4 | `agent-team-content-repurposing.md` |
| Research & Pitch Deck | Sequential handoff | 3 | `agent-team-research-deliverable.md` |
| RFP / Proposal Response | Parallel → sequential | 4 | `agent-team-proposal-response.md` |
| Competitive Intelligence | Parallel → synthesis | 5 | `agent-team-competitive-analysis.md` |
| AI Advisory Board | Parallel perspectives → consensus | 5 | `agent-team-advisory-board.md` |
| Marketing Campaign | Hybrid wave | 4 | `agent-team-campaign-launch.md` |
| Generic / Custom | Configurable | 3-5 | `agent-team-generic.md` |
