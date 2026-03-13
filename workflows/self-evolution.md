---
description: How OPAI detects system gaps and safely self-evolves via the daily_evolve automation.
---

# Self-Evolution Workflow

> Last updated: 2026-03-05 | Source: `tools/opai-engine/background/scheduler.py`

OPAI runs a consolidated daily evolution pipeline (`daily_evolve`) at **2am** that audits the system, auto-applies safe fixes, assesses operational health, verifies the assessment pipeline itself, and emails a consolidated report.

## Daily Evolve Pipeline

Scheduled via `config/orchestrator.json` → `"daily_evolve": "0 2 * * *"`.

### Phase 1: Auto-Safe Squad

Runs the `auto_safe` squad (`accuracy`, `health`, `security`, `reviewer`, `executor_safe`):
- Audits system accuracy, health, and security posture
- `executor_safe` produces a fix plan for pre-approved safe changes (formatting, config typos, missing imports, dead code)
- Reports land in `reports/<date>/` and `reports/latest/`
- `post_squad_hook.py` fires (creates tasks, sends standard email + Telegram)

### Phase 2: Apply Safe Fixes

Reads `reports/latest/executor_safe.md` and feeds it to `claude -p` with a constrained apply prompt:
- Only applies fixes listed in the plan (no improvisation)
- Allowed tools: `Read`, `Edit`, `Glob`, `Grep`, `Bash(git diff:*)`
- Saves result to `reports/<date>/executor_safe_result.md`

### Phase 3: Evolve Squad (Self-Assessment + Meta-Assessment)

Runs the `evolve` squad (`self_assessment`, `meta_assessment` agents):
- **Self-assessment**: Evaluates system health, configuration drift, agent coverage gaps
- Produces `self_assessment.md` with P0/P1/P2 action items
- Items requiring human approval are flagged

### Phase 3.5: Meta-Assessment (Second-Order Loop)

Runs after self-assessment to verify the assessment pipeline itself:
- Checks whether Phase 2 fixes actually landed (or hit max_turns)
- Cross-validates agent outputs (e.g., security.md vs reviewer.md)
- Measures fleet token efficiency (success rate, max_turns failures)
- Audits prompt quality (length, output format, scope boundaries)
- Produces `meta_assessment.md` — see [Meta-Assessment](Library/opai-wiki/infra/meta-assessment.md)

### Phase 4: Consolidated Email

Sends a single HTML email to `Dallas@paradisewebfl.com` with two sections:
- **Green — "Applied (Safe)"**: Each fix that was auto-applied (file, action, status)
- **Orange — "Needs Your Approval"**: P0/P1/P2 items from self-assessment

Status badges at top: Assessment PASS/FAIL, Safe Fixes APPLIED/SKIPPED, count needing approval.

### Pre-Phase: Report Cleanup

Before Phase 1, archives report directories older than 14 days to `reports/Archive/`.

## Manual Runs

```bash
# Run just the auto_safe squad
./scripts/run_squad.sh -s auto_safe --skip-preflight

# Run just the evolve squad (self-assessment)
./scripts/run_squad.sh -s evolve --skip-preflight

# The full daily_evolve pipeline runs automatically at 2am
# To test manually, temporarily set the cron to "*/5 * * * *" in orchestrator.json
```

## Safety Guardrails

1. **Two-tier automation**: `executor_safe` only proposes pre-screened non-breaking fixes; `executor_full` requires explicit human enablement
2. **Read-only agents**: All agents except executor_safe/executor_full use `claude -p` (pipe mode) — stdout only, no file modifications
3. **Human gate**: Self-assessment proposes improvements; humans approve via email or Task Control Panel
4. **Constrained apply**: Phase 2 runs `claude -p` with limited tool access — no git push, no service restarts, no destructive operations
5. **Rollback**: Reports are timestamped; `git diff` output is captured in executor_safe_result.md

## Configuration

In `config/orchestrator.json`:

```json
"evolve": {
    "enabled": true,
    "daily_evolve": {
        "frequency_type": "daily",
        "frequency_value": 1,
        "time_hour": 2,
        "time_minute": 0,
        "phases": ["auto_safe", "apply_fixes", "evolve", "meta_assess", "email"],
        "report_retention_days": 14
    }
}
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-engine/background/scheduler.py` | `_daily_evolve()` implementation (5 phases) |
| `config/orchestrator.json` | Schedule + evolve config |
| `scripts/run_squad.sh` | Squad runner (called by Phase 1 + 3) |
| `scripts/post_squad_hook.py` | Post-squad tasks + email + Telegram |
| `scripts/prompt_self_assessment.txt` | Self-assessment agent prompt |
| `scripts/prompt_meta_assessment.txt` | Meta-assessment agent prompt (Phase 3.5) |
| `reports/latest/executor_safe.md` | Current fix plan (Phase 1 output) |
| `reports/latest/executor_safe_result.md` | Apply result (Phase 2 output) |
| `reports/latest/self_assessment.md` | Health report (Phase 3 output) |
| `reports/latest/meta_assessment.md` | Pipeline verification report (Phase 3.5 output) |

## Dependencies

- [Agent Framework](../Library/opai-wiki/agents/agent-framework.md) — squad definitions (auto_safe, evolve)
- [Heartbeat](../Library/opai-wiki/infra/heartbeat.md) — separate 30-min proactive system (not part of daily_evolve)
- [Fleet Coordinator](../Library/opai-wiki/infra/fleet-action-items.md) — may dispatch fixes identified by daily_evolve
- SMTP credentials from `tools/opai-email-agent/.env`
