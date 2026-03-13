---
description: Structured iteration loop for building visual projects (games, UIs, apps) with AI agents. Plan → Implement → Visual Test → Learn.
source: https://www.youtube.com/watch?v=wn4CLCNdujs (Chong-U — AI Oriented Dev)
---

# Structured Build Loop

> Last updated: 2026-03-10

A repeatable workflow for building visual, asset-heavy projects (games, dashboards, apps) using AI agents. Each feature goes through a tight cycle: catalog assets → plan → implement → visual QA → capture learnings → commit.

## Core Principles

1. **Asset index is the single source of truth** — AI never traverses the filesystem blind. A canonical manifest tells it what exists, where, and how it's structured.
2. **Plan before code** — Every feature starts with a thinking/reasoning pass that asks clarifying questions. No coding until the plan is approved.
3. **Model routing** — Match the model to the task type. Don't use a coding model for creative writing or a creative model for implementation.
4. **Configurable over hardcoded** — Features should be data-driven (config files, JSON) so content can be iterated without code changes.
5. **Visual QA via automation** — Use Playwright/browser automation to screenshot application states and catch visual bugs programmatically.
6. **Learnings compound** — After each cycle, capture what worked, what broke, and what was fixed. Future cycles benefit from accumulated knowledge.

## The Loop

```
┌─────────────────────────────────────────────────┐
│  1. CATALOG  ─→  Update asset index             │
│  2. PLAN     ─→  Plan feature (clarifying Qs)   │
│  3. IMPLEMENT ─→ Build from plan                 │
│  4. TEST     ─→  Visual QA (Playwright)          │
│  5. FIX      ─→  Iterate on bugs (screenshots)   │
│  6. LEARN    ─→  Write learnings + save prompts  │
│  7. COMMIT   ─→  Clean commit, move to next      │
└─────────────────────────────────────────────────┘
```

Each step has a corresponding prompt template in `scripts/`.

## Step Details

### Step 1: Catalog Assets (`prompt_asset_index.txt`)

Before building anything, ensure the AI knows what assets exist. The asset index is a JSON manifest mapping every asset to its location, type, dimensions, and metadata.

**When to run:** At project start, and whenever new assets are added (sprites, images, audio, config files).

**Output:** `asset-index.json` in the project root.

**Key fields per asset:**
- `path` — relative file path
- `type` — category (sprite, portrait, audio, config, animation, texture)
- `dimensions` — width × height (for images)
- `metadata` — frame counts, directions, animation states, format-specific data

### Step 2: Plan Feature (`prompt_plan_feature.txt`)

Enter plan mode. Describe the feature with reference images/screenshots if visual. The agent must ask clarifying questions before producing a plan.

**Model routing:** Use a high-reasoning or thinking model. In OPAI context, this maps to Claude with extended thinking or a reasoning-focused model.

**Output:** A structured plan saved to `plans/<feature-name>.md` containing:
- Summary of what will be built
- Clarifying questions asked + answers received
- Implementation steps (ordered)
- Files to create/modify
- Test criteria
- Edge cases considered

**Critical rule:** Never skip plan mode for non-trivial features. The clarifying questions phase catches misunderstandings that would otherwise waste an entire implementation cycle.

### Step 3: Implement Feature (`prompt_implement_feature.txt`)

Switch to a coding-optimized model. Reference the saved plan, the asset index, and accumulated learnings. Implement strictly what the plan describes.

**Model routing:** Use the strongest available coding model.

**Input context:**
- The plan file from Step 2
- `asset-index.json` for asset references
- `learnings/` folder for accumulated knowledge
- Relevant source files identified in the plan

**Output:** Working code changes. The agent should run a build/compile check before reporting completion.

### Step 4: Visual QA (`prompt_visual_qa.txt`)

Use Playwright (via `opai-browser` or direct) to visually test the implemented feature. The agent navigates to the relevant application state, takes screenshots at key moments, and analyzes them for visual bugs.

**When to use:** Any feature with visual output — UI changes, game features, layout modifications, animation systems.

**Process:**
1. Launch the application (or connect to running instance)
2. Navigate to the feature's trigger point
3. Interact as a user would (click buttons, wait for animations, scroll)
4. Take screenshots at 4-8 key states
5. Analyze each screenshot for: positioning errors, overlaps, alignment issues, missing elements, incorrect rendering
6. Report findings with specific bug descriptions and fix suggestions

**Output:** Screenshot files + bug report. If bugs found, loop back to Step 3 with the report as context.

### Step 5: Fix Bugs (Iterative)

If visual QA found issues, feed the screenshots and bug report back to the coding agent. Use higher reasoning if positional/dynamic bugs are tricky.

**Escalation path:** If 2-3 fix attempts fail on the same bug, escalate reasoning level or switch models. Some spatial/dynamic positioning bugs require deeper analysis.

### Step 6: Write Learnings (`prompt_write_learnings.txt`)

After the feature works correctly, capture everything learned:

**Output:** `learnings/<feature-name>.md` containing:
- What was built (1-2 sentence summary)
- What broke during implementation and why
- How it was fixed (root cause, not just symptoms)
- Reusable patterns discovered
- Gotchas for similar future work

Also archive the prompts used during this cycle to `prompts/<feature-name>/` for reproducibility.

### Step 7: Commit

Clean commit with conventional commit message. One feature per commit. Include the learnings and prompt files.

```bash
git add <changed files>
git commit -m "feat: implement <feature-name>"
```

## Model Routing Guide

| Task Type | Recommended Model | Why |
|-----------|-------------------|-----|
| Asset cataloging (multimodal) | Vision-capable + reasoning | Needs to see images, understand structure |
| Feature planning | High reasoning / thinking | Clarifying questions, architectural decisions |
| Coding / implementation | Coding-optimized | Speed + accuracy on code generation |
| Creative (dialogue, naming, narrative) | Claude Opus | Better creative writing, less formulaic |
| Art generation | Image model (Gemini, DALL-E, etc.) | Domain-specific |
| Bug fixing (simple) | Coding model | Straightforward patches |
| Bug fixing (spatial/dynamic) | Extra-high reasoning | Complex positional logic |
| Visual QA | Vision-capable | Screenshot analysis |

In OPAI, model routing can be handled by the Engine's worker assignment logic — tag tasks with their type and let the dispatcher select the appropriate worker/model.

## Prompt Templates

| Prompt File | Loop Step | Purpose |
|-------------|-----------|---------|
| `scripts/prompt_asset_index.txt` | 1. Catalog | Build/update canonical asset manifest |
| `scripts/prompt_plan_feature.txt` | 2. Plan | Plan feature with clarifying questions |
| `scripts/prompt_implement_feature.txt` | 3. Implement | Build from approved plan |
| `scripts/prompt_visual_qa.txt` | 4. Test | Playwright visual regression testing |
| `scripts/prompt_write_learnings.txt` | 6. Learn | Capture lessons + archive prompts |

## Integration with OPAI

### As a Builder Workflow

The `run_builder.sh` script can be extended to support this loop:

```bash
# Full structured build loop for a feature
./scripts/run_builder.sh --loop \
  --plan "Add dark mode toggle to Brain" \
  --context tools/opai-brain \
  --asset-index tools/opai-brain/asset-index.json \
  --visual-qa "http://localhost:8101"
```

### As Engine Worker Tasks

Each loop step can be dispatched as a worker task via the Engine:

```json
{
  "type": "structured_build",
  "feature": "Cut scene system",
  "project": "game-project",
  "steps": ["catalog", "plan", "implement", "visual_qa", "learn"],
  "model_routing": {
    "plan": "reasoning",
    "implement": "coding",
    "visual_qa": "vision"
  }
}
```

### With Fleet Coordinator

For parallel feature development, the fleet coordinator can assign different features to different workers, each running their own build loop independently. The learnings folder becomes a shared knowledge base across workers.

## Anti-Slop Rules (Specific to This Workflow)

1. **Never implement without a saved plan** — If the plan isn't written to a file, it doesn't exist.
2. **Never skip visual QA for UI features** — "It compiles" is not "it works."
3. **Never commit broken learnings** — Learnings must describe root causes, not symptoms.
4. **Never hardcode content that could be config** — Dialogue, text, asset paths, layout values → config files.
5. **Asset index must stay current** — If you add an asset, update the index in the same commit.
