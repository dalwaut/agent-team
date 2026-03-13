# Agent Feedback Loops
> Last updated: 2026-03-07 | Source: `tools/opai-engine/routes/agent_feedback.py`, `tools/opai-engine/background/feedback_loop.py`, `scripts/post_squad_hook.py`, `scripts/run_squad.sh`

Structured learning system that allows agents to compound knowledge across runs. Agents emit feedback at end of reports, Engine stores it in Supabase, and the squad runner injects relevant hints into future runs.

## Overview

Previously, agents ran cold every time — a security agent that discovered "always check webhook HMAC signatures" lost that insight on the next run. The feedback loop fixes this:

1. **Emit**: Agents include a `<!-- FEEDBACK {...} -->` block at the end of their reports
2. **Capture**: `post_squad_hook.py` extracts the JSON and POSTs it to Engine
3. **Store**: Engine persists to `engine_agent_feedback` table (Supabase) with confidence scoring
4. **Inject**: On next run, `run_squad.sh` fetches relevant hints and prepends them to the agent prompt
5. **Decay**: Background loop decays stale hints (30+ days untouched) and deactivates low-confidence items

**Distinct from [Feedback System](feedback-system.md)**: That system handles *user* feedback (UI button clicks, feature requests). This system handles *agent-to-agent* learning (inter-run knowledge transfer). Different table, different routes, different purpose.

## Architecture

```
Agent runs → emits <!-- FEEDBACK {...} --> in report
                        |
post_squad_hook.py extracts JSON, POSTs to Engine
                        |
Engine stores in engine_agent_feedback (Supabase)
                        |
Next squad run → run_squad.sh fetches hints via GET, prepends to prompt
                        |
background/feedback_loop.py decays stale confidence daily
                        |
heartbeat.py includes feedback stats in pulse data
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-engine/routes/agent_feedback.py` | REST API — CRUD + stats + gaps endpoints |
| `tools/opai-engine/background/feedback_loop.py` | 24h confidence decay loop |
| `tools/opai-engine/background/heartbeat.py` | Includes feedback stats in pulse summary |
| `scripts/post_squad_hook.py` | Extracts `<!-- FEEDBACK -->` from reports, POSTs to Engine |
| `scripts/run_squad.sh` | `build_prompt()` fetches hints, prepends to agent prompt |
| `scripts/prompt_*.txt` | 5 prompts have feedback emission instructions (security, self_assessment, accuracy, tools_monitor, researcher) |
| `config/supabase-migrations/046_engine_agent_feedback.sql` | Table DDL + indexes + RLS |

## Data Model

### Supabase Table: `engine_agent_feedback`

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid (PK) | Auto-generated |
| `agent_role` | text | Agent name (e.g., `security`, `self_assessment`) |
| `domain` | text (nullable) | Optional topic grouping |
| `feedback_type` | text | `retrieval_hint`, `missing_context`, or `correction` |
| `content` | text | The actual insight (1-2 sentences) |
| `source_run` | text | Squad/report path reference |
| `confidence` | float | 0.0–1.0, starts at 0.5, boosted by reinforcement, decayed by staleness |
| `use_count` | int | Times this hint was served to an agent |
| `success_count` | int | Times explicitly reinforced (via PATCH /reinforce) |
| `active` | boolean | False = deactivated (decayed below 0.2 or manually disabled) |
| `created_at` | timestamptz | Creation time |
| `updated_at` | timestamptz | Last modification |

**Indexes:**
- `idx_agent_feedback_lookup` — `(agent_role, domain, active, confidence DESC)` — primary query path
- `idx_agent_feedback_type` — `(feedback_type, active)` — for gaps/corrections queries

**RLS:** Service role full access only. No user-facing access — this is system infrastructure.

### Feedback Types

| Type | Meaning | Example |
|------|---------|---------|
| `retrieval_hint` | Strategy that proved useful | "Check `config/workers.json` for managed worker health — it's faster than parsing service logs" |
| `missing_context` | Knowledge gap the agent couldn't fill | "No documentation exists for the NFS dispatcher error codes" |
| `correction` | Factual error found in existing docs | "wiki says Brain runs on port 8100 but it actually runs on 8101" |

## API Endpoints

All routes prefixed `/api/`. Write endpoints require admin auth.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/agent-feedback` | List items. Filters: `role`, `domain`, `type`, `active`, `limit` |
| POST | `/api/agent-feedback` | Create item. Required: `agent_role`, `feedback_type`, `content` |
| PATCH | `/api/agent-feedback/{id}/reinforce` | Increment `success_count`, boost confidence by 0.05 (cap 1.0) |
| PATCH | `/api/agent-feedback/{id}/deactivate` | Set `active=false` |
| GET | `/api/agent-feedback/stats` | Summary: total active, count by type, avg confidence |
| GET | `/api/agent-feedback/gaps` | All active `missing_context` items |

### Example Requests

```bash
# Create a hint
curl -X POST http://localhost:8080/api/agent-feedback \
  -H "Content-Type: application/json" \
  -d '{"agent_role":"security","feedback_type":"retrieval_hint","content":"Always check webhook HMAC signatures in opai-telegram"}'

# List hints for security agent
curl "http://localhost:8080/api/agent-feedback?role=security&active=true"

# View knowledge gaps
curl http://localhost:8080/api/agent-feedback/gaps

# Reinforce a useful hint
curl -X PATCH http://localhost:8080/api/agent-feedback/{id}/reinforce
```

## Feedback Emission (Agent Side)

Five high-frequency prompts currently include the emission block:
- `scripts/prompt_security.txt`
- `scripts/prompt_self_assessment.txt`
- `scripts/prompt_accuracy.txt`
- `scripts/prompt_tools_monitor.txt`
- `scripts/prompt_researcher.txt`

### Emission Format

Agents append this HTML comment at the end of their report:

```
<!-- FEEDBACK
{
  "hints": ["investigation strategies that proved useful"],
  "missing": ["information you needed but couldn't find in the docs"],
  "corrections": ["any outdated or wrong info you found in wiki/docs"]
}
-->
```

Rules enforced by the prompt:
- Only include items with genuine confidence
- Empty arrays are fine — don't force feedback
- Keep each item to 1-2 sentences
- `hints` = what would help the agent next time it runs the same task
- `missing` = knowledge gaps that should be documented
- `corrections` = specific factual errors with file/doc citation

### Adding to More Prompts

To enable feedback for another agent, append the feedback emission block from any of the 5 existing files to the end of its `scripts/prompt_*.txt` file. The post-hook extraction is prompt-agnostic — it looks for `<!-- FEEDBACK {...} -->` in any report.

## Hint Injection (Squad Runner Side)

`scripts/run_squad.sh` injects hints in two places:

1. **`build_prompt()`** (used by `run_agent()` for sequential/direct runs)
2. **`write_tmux_agent_script()`** (used for tmux parallel runs)

Both paths:
1. `curl` the Engine API for active hints matching the agent name
2. Format as a "Previous Run Insights" section
3. Prepend before the prompt file content

Hints are presented as suggestions, not commands:
```
## Previous Run Insights
(Learned from past runs — use as starting context, not gospel)

- Always check webhook HMAC signatures in opai-telegram (confidence: 0.75)
- config/workers.json health field is more reliable than service logs (confidence: 0.5)

---
```

If Engine is unreachable or returns no hints, the prompt proceeds normally (graceful degradation).

## Confidence Decay

**File:** `tools/opai-engine/background/feedback_loop.py`

Registered as `feedback-decay` background task in Engine's lifespan.

| Parameter | Value |
|-----------|-------|
| Cycle interval | 24 hours |
| Staleness threshold | 30 days since `updated_at` |
| Decay amount | 0.05 per cycle |
| Deactivation threshold | Below 0.2 confidence |
| Startup delay | 5 minutes |

Decay ensures the feedback table doesn't accumulate stale hints forever. Reinforcement (via `/reinforce` endpoint) counteracts decay by boosting confidence by 0.05 per call.

**Lifecycle:**
- New hint: confidence 0.5
- Reinforced 3 times: confidence 0.65
- Untouched for 60 days (2 decay cycles): confidence 0.55
- Untouched for 360 days (12 cycles): confidence < 0.2 → deactivated

## Heartbeat Integration

The heartbeat `_build_snapshot()` includes an `agent_feedback` section in the pulse summary:

```json
{
  "agent_feedback": {
    "active_hints": 42,
    "recent_24h": 3,
    "gaps": 7,
    "corrections": 2
  }
}
```

This is a lightweight single-query aggregation (httpx sync client, 5s timeout). Failures are silently caught — feedback stats are informational, not critical.

## Post-Hook Extraction

**File:** `scripts/post_squad_hook.py`

Two functions added:

1. **`extract_agent_feedback(report_text)`** — regex `<!-- FEEDBACK\s*(\{.*?\})\s*-->` with `re.DOTALL`, returns parsed dict or None
2. **`submit_agent_feedback(squad, agent_role, feedback, report_path)`** — POSTs each item to Engine via `urllib.request` (no `requests` dependency needed)

Integration point: runs after `parse_reports()`, before audit entry writing. Non-fatal — wrapped in try/except. If Engine is down, feedback is silently skipped.

Type mapping:
| JSON key | `feedback_type` |
|----------|-----------------|
| `hints` | `retrieval_hint` |
| `missing` | `missing_context` |
| `corrections` | `correction` |

## Rollout Plan

**Phase 1 (current):** 5 high-frequency prompts enabled. Validate that agents actually emit useful feedback and that hint injection doesn't confuse them.

**Phase 2 (after validation):** Roll out to remaining `scripts/prompt_*.txt` files. Append the same feedback emission block.

**Phase 3 (future):** Add `use_count` tracking — when a hint is served, increment its counter. Correlate with report quality to measure feedback effectiveness.

## Dependencies

- **Supabase** (`engine_agent_feedback` table) — migration `046`
- **Engine** (port 8080) — routes + background decay loop
- **Squad runner** (`scripts/run_squad.sh`) — hint injection
- **Post-hook** (`scripts/post_squad_hook.py`) — feedback extraction + submission
- **Agent prompts** (`scripts/prompt_*.txt`) — emission instructions

## Cross-References

- [Agent Framework](../agents/agent-framework.md) — squad runner, prompt system, agent tuning
- [Feedback System](feedback-system.md) — *user* feedback (UI), distinct from *agent* feedback (this doc)
- [Heartbeat](heartbeat.md) — pulse summary includes feedback stats
- [Orchestrator / Engine](../core/orchestrator.md) — route registration, background task
- [Fleet Coordinator](fleet-action-items.md) — work dispatch context (future: inject feedback into fleet priming)
