# Usage Throttling & Task Prioritization
> Last updated: 2026-02-20 | Source: `tools/opai-monitor/session_collector.py`, `tools/opai-monitor/routes_api.py`

## Overview

Claude Max has rolling usage limits tracked across two windows: a 5-hour session window and a 7-day weekly window. When limits approach capacity, system tasks must be throttled to preserve quota for interactive and user-requested work. The OPAI Monitor tracks these limits in real-time via the Anthropic OAuth API and exposes them through the **Current Usage** panel and the `/api/claude/plan-usage` REST endpoint. Agents and operators should check before spawning automated work.

The Monitor's **Current Usage** panel (panel `panel-usage-meters`) displays all four usage metrics with block-character progress bars and color-coded thresholds, refreshed every 15 seconds from the Anthropic API.

## Usage Tiers

| Tier | Session (5h) | Weekly (7d) | Policy |
|------|-------------|-------------|--------|
| **Green** | < 50% | < 50% | Normal. All system tasks run freely. |
| **Yellow** | 50-70% | 50-70% | Caution. Prefer Sonnet for automated tasks. Batch non-urgent work. |
| **Orange** | 70-85% | 70-85% | Throttle. Defer non-urgent system tasks (wiki sweeps, hygiene, email scans). Prioritize interactive. |
| **Red** | > 85% | > 85% | Critical. Queue ALL automated tasks. Only user-requested and interactive work. |
| **Maxed** | 100% | N/A | Session limit hit. Requests throttled by Anthropic until 5h window slides. Wait or use extra usage. |

## Task Priority Classes

| Priority | Examples | When to Defer |
|----------|----------|---------------|
| **P0 — Interactive** | User chat, Discord bot, active dev sessions | Never |
| **P1 — Requested** | User explicitly asked to run a squad/task | Never (user decided to spend quota) |
| **P2 — Scheduled** | Orchestrator squads, feedback processor, email checker | Defer at Orange (70%+) |
| **P3 — Background** | Wiki sweeps, workspace hygiene, updater scans | Defer at Yellow (50%+) |
| **P4 — Bulk** | Full workspace audit, onboarding, bulk operations | Only run at Green (< 50%) |

## Plan Usage API Response Structure

`GET /api/claude/plan-usage` (Monitor, proxied at `/monitor/api/claude/plan-usage`):

```json
{
  "session": {
    "label": "Current session",
    "utilization": 0.34,
    "resetsAt": "2026-02-19T18:00:00Z"
  },
  "weekAll": {
    "label": "Current week (all models)",
    "utilization": 0.52,
    "resetsAt": "2026-02-23T00:00:00Z"
  },
  "weekSonnet": {
    "label": "Current week (Sonnet only)",
    "utilization": 0.21,
    "resetsAt": "2026-02-23T00:00:00Z"
  },
  "weekOpus": {
    "label": "Current week (Opus only)",
    "utilization": 0.41,
    "resetsAt": "2026-02-23T00:00:00Z"
  },
  "extraUsage": {
    "label": "Extra usage",
    "isEnabled": true,
    "monthlyLimit": 5000,
    "usedCredits": 123,
    "utilization": 0.025
  },
  "fetchedAt": "2026-02-19T14:30:00.000Z"
}
```

**Key fields:**
- `utilization` — float from 0.0 to 1.0+ (can exceed 1.0 if limit was exceeded)
- `resetsAt` — ISO timestamp when the window resets
- `extraUsage.monthlyLimit` / `usedCredits` — in cents (divide by 100 for dollars)

**Data source**: Fetched from `https://api.anthropic.com/api/oauth/usage` using the OAuth access token stored at `~/.claude/.credentials.json`. Implemented in `session_collector.py:get_plan_usage()`. Server-side cache: 15 seconds.

## Model Routing Strategy

When usage is elevated, route automated tasks to cheaper models to preserve Opus capacity for interactive work.

| Scenario | Model Choice | Rationale |
|----------|-------------|-----------|
| Weekly all-models < 50% | Opus (default) | Plenty of capacity |
| Weekly all-models 50-70%, Sonnet < 30% | Route automated tasks to Sonnet | Preserve Opus for interactive |
| Weekly all-models > 70% | Route ALL non-interactive to Sonnet | Opus for user work only |
| Sonnet also > 70% | Haiku for simple tasks | Last resort before throttling |

**Note on Haiku**: Research (`Research/feedback-fixer-optimization-plan.md`) shows Haiku cannot complete implementation tasks — it explores but never edits. Haiku is only suitable for classification, classification, and simple text tasks.

## How to Check Before Running Tasks

### From a script or agent

```bash
# Returns JSON with utilization percentages
curl -s http://127.0.0.1:8080/api/claude/plan-usage
```

### From Python (internal services)

```python
import httpx
resp = httpx.get("http://127.0.0.1:8080/api/claude/plan-usage")
data = resp.json()
session_pct = data["session"]["utilization"]
week_pct = data["weekAll"]["utilization"]
```

### Decision logic

```python
if session_pct > 0.85 or week_pct > 0.85:
    # RED: queue the task, don't run now
    pass
elif session_pct > 0.70 or week_pct > 0.70:
    # ORANGE: only P0/P1 tasks; route P2 to Sonnet if needed
    pass
elif session_pct > 0.50 or week_pct > 0.50:
    # YELLOW: prefer Sonnet for automated work
    pass
else:
    # GREEN: run freely
    pass
```

## Monitor Dashboard — Current Usage Panel

The **Current Usage** panel (`panel-usage-meters`) in the Monitor dashboard shows all four limits with block-character progress bars (▓) and color-coded thresholds:

| Bar | Source field | Threshold Colors |
|-----|-------------|-----------------|
| Current session | `session.utilization` | Green < 50%, Orange 50-85%, Red > 85% |
| Week (all models) | `weekAll.utilization` | Green < 50%, Orange 50-85%, Red > 85% |
| Week (Sonnet) | `weekSonnet.utilization` | Green < 50%, Orange 50-85%, Red > 85% |
| Extra usage ($) | `extraUsage.utilization` | Green < 50%, Orange 50-85%, Red > 85% |

Hover tooltips show: utilization %, availability, exact reset time, time remaining, and context about throttling behavior at that level. Panel refreshes every 15 seconds.

## Extra Usage as Safety Net

Extra usage (`extra_usage.is_enabled: true`) provides pay-per-use overflow when included limits are exhausted:
- Configured limit: `monthly_limit` cents (e.g., 5000 = $50.00/month)
- Tracked as `used_credits` / `monthly_limit`
- Resets on the 1st of each month
- When extra usage limit is also reached, ALL Claude API requests stop until the monthly reset

Configure the extra usage limit at [claude.ai/settings](https://claude.ai/settings).

## Concurrency Limit

A separate local constraint: maximum **20 concurrent Claude sessions** (`config.MAX_CONCURRENT_SESSIONS = 20`). This is a practical limit on OPAI Server, not an Anthropic-enforced limit.

Monitored by `session_collector.get_concurrency_snapshot()` — counts running `claude` / `claude-code` processes via psutil. Status levels:
- `ok` — < 14 active processes
- `warning` — 14-17 active processes
- `critical` — 18+ active processes

The concurrency snapshot is shown in the Monitor's **Claude Status** panel and included in the `/api/claude/usage` response.

## Integration Points

| Component | Current Behavior | Recommended Improvement |
|-----------|-----------------|------------------------|
| **Orchestrator** | Spawns squads on schedule | Check plan usage before spawning; skip P3/P4 at Orange+ |
| **Discord Bot** | Always runs (P0) | Could warn admin in channel if usage is Red |
| **Feedback Processor** | P2 scheduled task (every 5 min) | Should check and skip cycle at Orange+ |
| **Email Checker** | P2 scheduled task | Should check and skip cycle at Orange+ |
| **Wiki Librarian** | P3 background | Only run at Green/Yellow |
| **Monitor** | Displays real-time usage | Could trigger Discord alert at Red threshold crossing |
| **Feedback Fixer** | Uses Sonnet by default | Token Budget modal controls model; auto-switches if budget exhausted |

## Key Limits (Claude Max, as of Feb 2026)

- **Session window**: 5-hour rolling
- **Weekly window**: 7-day rolling
- **Separate Sonnet cap**: Independent from all-models cap (usually higher)
- **Separate Opus cap**: Tracked separately in `weekOpus`
- **Extra usage**: Monthly spending cap (configurable at claude.ai/settings)
- **Local concurrency**: 20 concurrent sessions (OPAI Server constraint)

## Operator Playbook

### When you see Red (>85%)

1. Open Monitor → Current Usage panel to confirm
2. Stop any running non-urgent squads (Kill All Agents button in Monitor)
3. Wait for 5h session window to slide, or switch to a different user account
4. If extra usage is enabled and unused, it can absorb overflow automatically

### When you see Orange (70-85%)

1. Pause scheduled orchestrator runs (disable cron temporarily in Monitor → Task Queue settings)
2. Route pending feedback fixer tasks to Sonnet via Token Budget modal in Task Control Panel
3. Process only P0/P1 priority work until usage drops

### When usage is Green but climbing fast

1. Check concurrency snapshot — too many parallel agents consume quota quickly
2. Lower `max_squad_runs_per_cycle` in orchestrator.json
3. Increase `cooldown_minutes` between squad runs

## See Also

- [Monitor](monitor.md) — Dashboard panels: Current Usage, Claude Status, Claude Details
- [Feedback System](feedback-system.md) — Token Budget settings, model selection for feedback fixer
- [Orchestrator](orchestrator.md) — Squad scheduling (should integrate throttling checks)
- [Services & systemd](services-systemd.md) — How scheduled tasks are triggered
- [Agent Framework](agent-framework.md) — Per-agent model/turns tuning fields
