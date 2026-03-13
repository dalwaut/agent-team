# Structured Build Loop

> Last updated: 2026-03-10 | Source: `workflows/structured-build-loop.md`, `scripts/prompt_*.txt`

A repeatable 7-step agent workflow for building visual, asset-heavy projects (games, dashboards, apps, landing pages). Extracted from analysis of a real game dev workflow (FFT-style tactics game built in 7 days with Claude Code + Codex).

**Source video**: [Chong-U — I Vibe Coded a Final Fantasy Tactics Game in 7 Days](https://www.youtube.com/watch?v=wn4CLCNdujs)

---

## Overview

Most agent build failures come from the same root causes: the agent doesn't know what assets exist, it starts coding without a plan, it can't verify visual output, and lessons are lost between sessions. The Structured Build Loop solves all four.

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

Each step has a dedicated prompt template. The loop runs per-feature — one feature at a time, fully completed before starting the next.

---

## The Seven Steps

### Step 1: Catalog Assets

**Prompt**: `scripts/prompt_asset_index.txt`

Before building, ensure the AI knows what exists. The agent scans all asset directories and produces a canonical `asset-index.json` manifest.

**Why this matters**: Without an asset index, the AI traverses the filesystem on every request — wasting tokens and risking hallucinated paths. The index is the single source of truth for asset locations, types, dimensions, frame counts, and metadata.

**Output**: `asset-index.json` at project root with structure:
```json
{
  "version": 1,
  "generated": "2026-03-10T...",
  "project": "project-name",
  "totalAssets": 47,
  "categories": { "sprites": [...], "portraits": [...] },
  "assets": [
    {
      "id": "hero-idle-south",
      "path": "public/sprites/hero-idle.png",
      "type": "sprite",
      "format": "png",
      "dimensions": { "width": 256, "height": 256 },
      "metadata": { "frameCount": 8, "directions": ["south","north","east","west"] },
      "tags": ["hero", "player", "idle"]
    }
  ]
}
```

**When to re-run**: Every time new assets are added to the project.

### Step 2: Plan Feature

**Prompt**: `scripts/prompt_plan_feature.txt`

Enter plan mode. Describe the feature (with reference images if visual). The agent **must** ask 2-5 clarifying questions before producing a plan. No coding happens until the plan is approved.

**Why clarifying questions are mandatory**: They catch misunderstandings that would otherwise waste an entire implementation cycle. Questions cover placement decisions, config vs hardcoding, interaction with existing systems, edge cases, and UX flow.

**Model routing**: Use a high-reasoning or thinking model. Planning benefits from deeper analysis, not faster generation.

**Output**: `plans/<feature-name>.md` with summary, Q&A, ordered implementation steps, files to modify, assets required, test criteria, and edge cases.

**Critical rule from source workflow**: The plan must be detailed enough that a different agent could implement it without further questions.

### Step 3: Implement Feature

**Prompt**: `scripts/prompt_implement_feature.txt`

Switch to a coding-optimized model. The agent reads the saved plan, the asset index, and accumulated learnings, then implements exactly what the plan describes.

**Model routing**: Use the strongest available coding model.

**Key constraints**:
- Implement ONLY what the plan describes — no bonus features
- If the plan has a flaw, STOP and report — don't improvise
- Config files over hardcoded values
- Match existing code style exactly
- Run a build check before reporting completion

### Step 4: Visual QA

**Prompt**: `scripts/prompt_visual_qa.txt`

Use Playwright (via `opai-browser` port 8107 or direct) to visually test the feature. The agent navigates to the feature, takes 4-8 screenshots at key states, and analyzes each for visual bugs.

**Bug categories checked**:
- Positioning & layout (overlaps, clipping, z-order, alignment)
- Content & data (missing elements, wrong data, truncation)
- Interaction & animation (stuck frames, offset click targets)
- Styling (color mismatches, missing effects, inconsistency)

**Output**: Structured QA report with screenshots, bug descriptions by severity, and test criteria pass/fail results.

**If bugs found**: Loop back to Step 3 (Fix) with the report as context. Maximum 3 fix iterations before escalating to higher reasoning or human review.

### Step 5: Fix Bugs (Iterative)

No separate prompt — uses the implementation prompt with the QA report as additional context.

**Escalation path**: If 2-3 attempts fail on the same bug, escalate:
1. Increase reasoning level (e.g., extra-high)
2. Switch to a different model
3. Flag for human review

**Key insight from source**: Spatial/dynamic positioning bugs (e.g., speech bubbles following characters during camera rotation) often need higher reasoning because they involve coordinate system transformations the coding model doesn't naturally reason about.

### Step 6: Write Learnings

**Prompt**: `scripts/prompt_write_learnings.txt`

After the feature works, capture what happened: what worked, what broke, root causes, reusable patterns, gotchas, and model-specific notes.

**Output**: `learnings/<feature-name>.md` + prompt archive in `prompts/<feature-name>/`.

**Critical rule**: Focus on root causes, not symptoms. "The bubble was misaligned" is useless. "Position was calculated from viewport center instead of character world-space projected to screen coordinates" is useful.

### Step 7: Commit

Clean conventional commit. One feature per commit. Include learnings and prompt files.

---

## Model Routing

A core insight from the source workflow: different task types perform better with different model strengths.

| Task Type | Best Model Profile | Why |
|-----------|-------------------|-----|
| Asset cataloging | Vision + reasoning | Needs to see images and understand structure |
| Feature planning | High reasoning / thinking | Clarifying questions, architectural decisions |
| Implementation | Coding-optimized | Speed + code accuracy |
| Creative writing | Claude Opus | Better narrative, less formulaic dialogue |
| Art generation | Image model (Gemini, DALL-E) | Domain-specific capability |
| Bug fixing (simple) | Coding model | Straightforward patches |
| Bug fixing (complex spatial) | Extra-high reasoning | Coordinate transforms, dynamic positioning |
| Visual QA | Vision-capable | Screenshot analysis |

**OPAI integration**: Engine worker assignment can route tasks by type. Tag tasks in the dispatch payload and let `FleetCoordinator` select the appropriate worker.

---

## Key Patterns

### Asset Index as Context Anchor

The asset index solves the "cold start" problem where agents don't know what's available. It's analogous to:
- `manifest.json` in opai-docs (maps wiki files for the SPA)
- `team.json` in the agent framework (maps agents/squads for the runner)
- `asset-index.json` for any visual project

**Pattern**: For any project with discoverable resources (assets, components, endpoints, configs), create a machine-readable manifest that agents reference instead of scanning.

### Configurable-First Design

The source workflow consistently pushes content into config/data files rather than hardcoding in source. This means:
- Dialogue, text, labels → JSON config files
- Layout values, positions → config objects
- Asset paths → asset index references
- Feature flags → config toggles

**Why**: Content iteration doesn't require code changes. Agents can modify behavior by editing data files, which is safer and more reviewable than code patches.

### Queue and Interrupt (Multi-Feature Parallelism)

The source workflow demonstrates running multiple features simultaneously by queuing messages for after the current task completes, or interrupting to redirect the current task.

**OPAI parallel**: Fleet Coordinator already supports multiple concurrent workers. Each worker can run its own build loop independently. The learnings folder becomes a shared knowledge base.

### Playwright as Universal Visual Tester

Browser automation isn't just for web app testing — it works for any application with visual output rendered in a browser (games, dashboards, canvas apps). The agent:
1. Navigates to the right state
2. Screenshots
3. Analyzes the screenshot
4. Reports bugs with visual evidence

**OPAI integration**: `opai-browser` (port 8107) already provides Playwright job queue. The `prompt_visual_qa.txt` template is designed to work with it.

---

## Prompt Templates

| File | Step | Purpose |
|------|------|---------|
| `scripts/prompt_asset_index.txt` | 1. Catalog | Scan project → build `asset-index.json` |
| `scripts/prompt_plan_feature.txt` | 2. Plan | Plan with mandatory clarifying questions → `plans/*.md` |
| `scripts/prompt_implement_feature.txt` | 3. Implement | Build from approved plan, reference index + learnings |
| `scripts/prompt_visual_qa.txt` | 4. Test | Playwright screenshots → visual bug report |
| `scripts/prompt_write_learnings.txt` | 6. Learn | Root-cause learnings → `learnings/*.md` + prompt archive |

All prompts follow OPAI conventions: read `.agent/project_context.md` if present, reference the workflow doc, include model routing guidance.

---

## OPAI Integration Points

### Builder Script Extension

```bash
# Standard builder (existing)
./scripts/run_builder.sh -t "Add dark mode" --context tools/opai-brain

# Structured build loop (future extension)
./scripts/run_builder.sh --loop \
  --plan "Add cut scene system" \
  --context Projects/game-project \
  --asset-index Projects/game-project/asset-index.json \
  --visual-qa "http://localhost:3000"
```

### Engine Worker Task Dispatch

```json
{
  "type": "structured_build",
  "feature": "portrait-system",
  "project_path": "Projects/game-project",
  "steps": ["catalog", "plan", "implement", "visual_qa", "learn"],
  "model_routing": {
    "catalog": "vision",
    "plan": "reasoning",
    "implement": "coding",
    "visual_qa": "vision",
    "learn": "coding"
  }
}
```

### Squad Definition (Future)

```json
{
  "name": "build_loop",
  "description": "Structured build loop for visual features",
  "agents": ["asset_cataloger", "feature_planner", "implementer", "visual_qa", "learning_writer"],
  "sequential": true,
  "handoff_files": ["asset-index.json", "plans/*.md", "qa/*.png", "learnings/*.md"]
}
```

### Assembly Line Compatibility

The build loop is a micro-version of the [Assembly Line](../tools/assembly.md) pipeline. Assembly handles idea→ship; the build loop handles a single feature within that pipeline. They nest naturally:

```
Assembly Line (macro)
  Phase 3: Build
    → Structured Build Loop (micro) per feature
      Step 1: Catalog
      Step 2: Plan
      Step 3: Implement
      Step 4: Visual QA
      Step 5: Fix
      Step 6: Learn
      Step 7: Commit
```

---

## Anti-Slop Rules (Build Loop Specific)

1. **No plan, no code** — If the plan isn't written to a file, it doesn't exist
2. **No skipping visual QA for UI features** — "It compiles" ≠ "it works"
3. **Root causes in learnings** — Symptoms are useless; root causes compound
4. **Config over hardcode** — If it could change, it goes in a data file
5. **Asset index stays current** — New asset without index update = broken contract

---

## Future: Game Dev Agent Role

This workflow provides the foundation for a dedicated Game Dev agent in `team.json`:

```json
{
  "name": "game_dev",
  "description": "Builds game features using the structured build loop",
  "model": "opus",
  "max_turns": 30,
  "prompt_file": "scripts/prompt_game_dev.txt",
  "context_files": ["asset-index.json", "learnings/COMMON.md"],
  "workflow": "structured-build-loop",
  "capabilities": ["planning", "implementation", "visual_qa", "learning_capture"]
}
```

The agent would orchestrate the full 7-step loop internally, calling sub-prompts for each step. This is not yet implemented — the current workflow is designed for human-driven or squad-driven execution.

---

## Key Files

| File | Purpose |
|------|---------|
| `workflows/structured-build-loop.md` | Master workflow document |
| `scripts/prompt_asset_index.txt` | Asset catalog prompt |
| `scripts/prompt_plan_feature.txt` | Feature planning prompt |
| `scripts/prompt_implement_feature.txt` | Implementation prompt |
| `scripts/prompt_visual_qa.txt` | Visual QA prompt |
| `scripts/prompt_write_learnings.txt` | Learning capture prompt |

---

## Dependencies

- [Agent Framework](agent-framework.md) — prompt system, runner scripts, squad definitions
- [Assembly Line](../tools/assembly.md) — macro build pipeline (build loop nests inside Phase 3)
- [Fleet Coordinator](../infra/fleet-action-items.md) — worker dispatch for parallel feature builds
- [Browser Automation](../infra/browser-automation.md) — Playwright visual QA via opai-browser
- [Feedback System](../infra/feedback-system.md) — learnings feed into broader feedback loops
