# Claude Code `/loop` Cron Feature

> Last updated: 2026-03-07 | Utility-tier doc

## Overview

Claude Code includes a built-in `/loop` slash command that creates cron-scheduled prompts. It uses the `CronCreate` tool internally to register a recurring task that re-invokes Claude with a given prompt on a schedule.

**Key characteristics:**
- Minimum interval: 1 minute
- Maximum lifetime: 3 days (auto-expires)
- Session-scoped: dies when the Claude Code session ends
- No audit trail, no fleet integration, no persistence across restarts

## When to Use `/loop` vs Engine Scheduler

| Criteria | `/loop` (Dev Tool) | Engine Scheduler (Production) |
|----------|-------------------|-------------------------------|
| **Persistence** | Session-scoped, lost on exit | Survives restarts, state in `engine-state.json` |
| **Minimum interval** | 1 minute | 1 minute (cron `* * * * *`) |
| **Max lifetime** | 3 days | Indefinite |
| **Audit trail** | None | Full audit via `tasks/audit.json` |
| **Fleet integration** | None | Worker dispatch, resource gating, parallel limits |
| **Configuration** | Interactive CLI | `config/orchestrator.json` |
| **Monitoring** | Manual (check terminal) | Heartbeat, Telegram alerts, dashboard |
| **Use case** | Prototyping, debugging, one-off dev tasks | Production monitoring, scheduled agents, business ops |

## Use Cases in OPAI

1. **Prototyping new schedules** — test a cron pattern before adding it to `orchestrator.json`
2. **Lightweight dev automation** — "every 5 minutes, check if my build passed"
3. **Debugging** — "every minute, tail the last 5 lines of the engine log and tell me if errors appear"
4. **Temporary monitors** — watch a metric during a deploy, auto-expires after 3 days

## What `/loop` is NOT

- NOT a replacement for the Engine scheduler — no persistence, no fleet, no audit
- NOT suitable for anything that must survive a session restart
- NOT visible to other agents, workers, or the heartbeat
- NOT integrated with Team Hub, Telegram alerts, or any OPAI subsystem

## Relationship to OPAI Scheduling

`/loop` sits as **Layer 6** in the [Scheduling Architecture](scheduling-architecture.md) — a developer convenience layer that exists entirely outside OPAI's production scheduling infrastructure. Think of it as `watch` or `crontab -e` for Claude Code sessions.

## Limitations

- No error recovery — if the prompt fails, it just runs again next interval
- No resource awareness — doesn't check CPU/memory before running
- No deduplication — can overlap with Engine schedules if you're not careful
- No notification routing — output stays in the terminal
- Session-scoped — closing the terminal kills all loops

## See Also

- [Scheduling Architecture](scheduling-architecture.md) — full 6-layer model
- [Heartbeat](heartbeat.md) — production monitoring loop
- [Fleet Coordinator](fleet-action-items.md) — production work dispatch
