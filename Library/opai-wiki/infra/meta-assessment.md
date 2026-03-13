# Meta-Assessment: Second-Order Self-Improvement Loop

> Last updated: 2026-03-05 | Source: `tools/opai-engine/background/scheduler.py`, `scripts/prompt_meta_assessment.txt`

> Assesses whether the assessment system itself is functioning — not what's broken, but whether the system that finds and fixes broken things is working.

**Owner:** Self-assessment pipeline
**Frequency:** Nightly (Phase 3.5 of `daily_evolve` at 2am)
**Depends on:** `daily_evolve` pipeline, fleet coordinator, task registry

---

## Problem Statement

The `daily_evolve` pipeline is a first-order loop: find problems → fix problems. But if the loop itself is broken (executor hits max turns, security agent produces 384 bytes, fleet wastes 70% of dispatches), then every finding is thrown away. You need a second-order loop that checks whether the first-order loop is actually landing fixes.

The existing self-assessment (`prompt_self_assessment.txt`) does this partially — it reads state files and produces a report. But it doesn't:
- Cross-validate agents against each other
- Measure token efficiency
- Audit prompt quality
- Check memory staleness
- Follow the decision tree to prioritize what to fix first

This document defines the complete methodology.

---

## The Six-Phase Diagnostic

### Phase 1: Fix Pipeline Verification (P0)

**Question:** Are fixes being applied?

**Read:**
1. `reports/latest/executor_safe.md` — fixes planned
2. `reports/latest/executor_safe_result.md` — fixes applied
3. `tools/opai-engine/data/engine-state.json` → `scheduler.last_run.apply_fixes`

**If result says "Reached max turns":** The entire self-improvement loop is a no-op. Every finding from every agent is being discarded. Fix the executor's `--max-turns` value in `scheduler.py` before doing anything else.

**Root causes:**
- `--max-turns` too low for fix count (check `scheduler.py`)
- Fix targets files at wrong paths (line numbers shifted since report was generated)
- Agent spent turns reading context instead of applying (prompt too broad)

### Phase 2: Cross-Validation

**Question:** Are agents producing consistent, quality output?

| Check | Method |
|-------|--------|
| Security vs Reviewer overlap | Both scan for security issues. If security.md < 2KB but reviewer.md found 20+ critical security issues, security agent is broken. |
| Report size consistency | Any report < 1KB is likely truncated. Compare to historical sizes. |
| Executor references valid findings | Executor_safe should reference finding IDs from source reports. Missing references = hallucination. |
| Fleet completions update registry | Every dispatch should eventually update a task. Orphaned dispatches = eval pipeline broken. |

### Phase 3: Token Efficiency

**Question:** How much work is being thrown away?

**Read:** `tools/opai-engine/data/fleet-state.json` → `recent_completions`

**Metrics:**
- `success_rate = score_above_0.6 / total_completions` — target > 70%
- `max_turns_failure_rate = max_turns_errors / total_completions` — target < 30%

**If max_turns > 30%:** Worker turn limits in `config/workers.json` are too low. Increase or add task decomposition via `project-lead` worker.

**Observed pattern:** `project-lead` workers (decompose first) score 1.0 consistently. Direct-execution workers (project-builder, project-reviewer) fail at 60%+ rates. Lesson: always decompose before dispatch.

### Phase 4: Queue Throughput

**Question:** Is deferred work being processed?

**Read:** `tasks/queue.json`, `tasks/registry.json`

| Metric | Healthy | Unhealthy |
|--------|---------|-----------|
| Queue completed count | > 0 | 0 (write-only queue) |
| Queue items > 7 days old | < 3 | Growing backlog |
| Registry: created / completed (7d) | < 2.0 | > 2.0 (throughput declining) |
| Failed tasks with retry_count=0, age > 3d | 0 | Any (no retry mechanism) |

### Phase 5: Prompt Quality

**Question:** Are agent prompts causing output failures?

**For each `scripts/prompt_*.txt`:**

| Red Flag | Threshold |
|----------|-----------|
| Line count | > 100 lines → agent wastes turns digesting context |
| "Enhanced Knowledge" sections | Any → reference material bloats prompt, doesn't improve output |
| No output format spec | → inconsistent reports that downstream can't parse |
| No scope boundaries | → agent wanders codebase, runs out of turns |
| No success criteria | → agent keeps exploring indefinitely |

**Key insight:** Prompt length inversely correlates with output quality past ~60 lines. Academic reference sections are the worst offenders — they feel helpful but consume turns without improving the scan.

### Phase 6: Memory Freshness

**Question:** Will stale memory mislead future sessions?

**For each `memory/*.md`:**
1. Verify key facts against current code/config
2. Check for removed/renamed tools or features
3. Check for missing features from latest version
4. Ensure MEMORY.md is under 200-line limit

**Priority:** MEMORY.md > system-catalog.md > gotchas.md > infrastructure.md (ordered by session impact).

---

## Decision Tree

```
Is the fix pipeline applying fixes?
├─ NO → P0: Fix executor (max_turns, prompt, schedule)
└─ YES →
   Are all agent reports > 1KB with structured output?
   ├─ NO → P0: Audit failing agent's prompt
   └─ YES →
      Is fleet success rate > 70%?
      ├─ NO → P1: Increase turn limits or add decomposition
      └─ YES →
         Is queue throughput > 0?
         ├─ NO → P1: Build dispatch or manually process
         └─ YES →
            Are memory files current?
            ├─ NO → P1: Audit and refresh
            └─ YES →
               Are failed tasks retried?
               ├─ NO → P2: Add retry logic
               └─ YES → System healthy — focus on features
```

---

## Key Principles

1. **Fix the loop before fixing the findings.** A broken pipeline means every finding is wasted.
2. **Cross-validate, never trust one source.** Divergent agent outputs = one is broken.
3. **Measure waste before adding capacity.** Fix success rate before adding workers.
4. **Shorter prompts produce better output** (past ~60 lines). Cut reference material.
5. **The queue is truth.** Growing queue + zero completions = write-only system.
6. **Memory compounds.** Stale memory sabotages every future session.

---

## Implementation

### Pipeline Integration (Phase 3.5 of daily_evolve)

The meta-assessment is wired into the nightly `daily_evolve` pipeline as **Phase 3.5**, running after the evolve squad (Phase 3) and before the consolidated email (Phase 4):

```
Phase 1: auto_safe squad → Phase 2: apply_fixes → Phase 3: evolve → Phase 3.5: meta_assess → Phase 4: email
```

Implementation in `scheduler.py` uses `asyncio.create_subprocess_exec` with:
- Model: `sonnet`
- Max turns: `20`
- Allowed tools: `Read`, `Glob`, `Grep` (read-only)
- Timeout: 600 seconds
- Output: `reports/<date>/meta_assessment.md` + `reports/latest/meta_assessment.md`

### Key Files

| File | Purpose |
|------|---------|
| `scripts/prompt_meta_assessment.txt` | Agent prompt (~100 lines) — 6-phase diagnostic |
| `tools/opai-engine/background/scheduler.py` | Phase 3.5 handler in `_daily_evolve()` |
| `config/orchestrator.json` | `evolve.daily_evolve.phases` includes `meta_assess` |
| `config/workers.json` | `meta-assessor` worker definition |
| `team.json` | `meta_assessment` role + `evolve` squad membership |
| `reports/latest/meta_assessment.md` | Latest output |
| `memory/meta-assessment-methodology.md` | Persistent diagnostic methodology and decision tree |

### Manual Run

```bash
# Run as part of evolve squad
./scripts/run_squad.sh -s evolve --skip-preflight

# The full daily_evolve pipeline runs automatically at 2am
```

### Future Integration Points

- The decision tree can be encoded into `fleet_coordinator.py` as pre-dispatch validation
- Could run as a standalone squad: `./scripts/run_squad.sh -s meta_assess`

---

## Historical Findings (for calibration)

| Date | Finding | Root Cause | Fix |
|------|---------|------------|-----|
| 2026-03-05 | executor_safe "Reached max turns (15)" — 0 fixes applied daily | `--max-turns 15` in scheduler.py too low for 25+ fix plans | Increase to 35 |
| 2026-03-05 | security.md only 384 bytes vs reviewer's 28KB | 186-line prompt with academic knowledge sections consumed all turns | Trim prompt to ~50 lines |
| 2026-03-05 | 7/11 fleet dispatches failed (max_turns) | project-reviewer at 15 turns, project-builder at 25 turns | Increase to 25 and 40 respectively |
| 2026-03-05 | Queue: 9 items, 0 completions ever | No dispatch mechanism reads queue.json | Queue is write-only — needs processing logic |
| 2026-03-05 | config.py PORT=8080 vs orchestrator.json api.port=3737 | Legacy value never updated after engine consolidation | Align to actual runtime port |
