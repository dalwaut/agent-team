# Scheduling Architecture

> Last updated: 2026-03-07 | Source: cross-system audit
> Major system doc (~400 lines)

## Overview

OPAI runs 30+ periodic tasks across 6 layers. This document is the single reference for understanding what runs when, where overlap exists, and why each layer exists.

**Design principle:** Centralize where possible (Engine), isolate where necessary (domain-specific schedulers), and maintain exactly one independent watchdog (Telegram) to detect Engine death.

---

## The 6-Layer Model

```
Layer 1: Engine Central Scheduler (orchestrator.json cron jobs)
   │      ↓ dispatches agents, squads, health checks
Layer 2: Engine Background Loops (async tasks: heartbeat, fleet, NFS, etc.)
   │      ↓ aggregation, dispatch, monitoring
Layer 3: Service-Specific Schedulers (WP, HELM, Brain, ForumBot)
   │      ↓ domain logic with own Supabase tables
Layer 4: Telegram Watchdog (Engine-dead detection only)
   │      ↓ independent /health ping + WP site checks
Layer 5: systemd Timers (OS-level, outside OPAI)
   │      ↓ Docker cleanup, git sync, farmOS
Layer 6: Claude Code /loop (dev-only, session-scoped)
         ↓ prototyping, debugging, temporary monitors
```

### Why 6 Layers?

- **Layer 1** (Engine Scheduler) is the central cron dispatcher — it reads `orchestrator.json` and fires tasks on schedule.
- **Layer 2** (Background Loops) are always-on async loops inside the Engine that aggregate, monitor, and dispatch in real-time.
- **Layer 3** (Service Schedulers) exist because WP/HELM/Brain/ForumBot each manage their own Supabase schedule tables with domain-specific logic (backup rollback, agent scripts, forum conditions). Centralizing these would create coupling without benefit.
- **Layer 4** (Telegram Watchdog) exists for one reason: the Engine cannot alert about its own death. Telegram independently pings `/health` to detect Engine crashes. Everything else (per-service alerts) comes from the Engine.
- **Layer 5** (systemd) handles OS-level tasks that should run even if OPAI is completely down.
- **Layer 6** (`/loop`) is a developer convenience — session-scoped, no persistence, no audit.

---

## Layer 1: Engine Central Scheduler

**File:** `tools/opai-engine/background/scheduler.py`
**Config:** `config/orchestrator.json` → `schedules`
**Check interval:** Every 60 seconds

The scheduler evaluates cron expressions and dispatches tasks. Resource-aware: defers jobs when CPU > 80% or memory > 85%. Parallel limit: 3 concurrent jobs (lightweight tasks bypass).

### Cron Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `health_check` | `*/5 * * * *` | Service health sweep |
| `task_process` | `*/15 * * * *` | Task registry auto-execution |
| `feedback_process` | `*/5 * * * *` | Feedback loop intake |
| `feedback_act` | `*/15 * * * *` | Act on approved feedback |
| `user_sandbox_scan` | `*/5 * * * *` | Scan user sandboxes for pending tasks |
| `workspace_mention_poll` | `*/2 * * * *` | Poll Google Docs @agent mentions |
| `workspace_chat_poll` | `*/2 * * * *` | Poll Google Chat for commands |
| `coedit_activity_check` | `*/2 * * * *` | Check co-edit session activity + timeouts |
| `knowledge_refresh` | `30 2 * * *` | Brain knowledge base refresh (daily 2:30 AM) |
| `daily_agent_newsletter` | `0 7 * * *` | Generate + send daily newsletter (7 AM) |
| `daily_evolve` | `0 2 * * *` | Self-evolution pipeline (daily 2 AM) |
| `workspace_audit` | `0 9 * * 1` | Weekly workspace audit (Mondays 9 AM) |
| `knowledge_sync` | `0 18 * * *` | Knowledge sync squad (daily 6 PM) |
| `dep_scan_daily` | `0 6 * * *` | Dependency scan (daily 6 AM) |
| `secrets_scan_daily` | `0 7 * * *` | Secrets scan (daily 7 AM) |
| `security_quick` | `0 8 * * 1` | Security audit (Mondays 8 AM) |
| `incident_check` | `0 */4 * * *` | Incident detector (every 4 hours) |
| `a11y_weekly` | `0 10 * * 2` | Accessibility audit (Tuesdays 10 AM) |
| `context_harvest` | `0 */4 * * *` | Context harvester worker (every 4 hours) |
| `workspace_folder_audit` | `0 23 * * *` | Google Drive folder audit (daily 11 PM) |
| `email_check` | DISABLED | Email monitoring (disabled per request) |

**State persistence:** `tools/opai-engine/data/engine-state.json` — tracks `last_run_at` per job to prevent double-execution on restart.

---

## Layer 2: Engine Background Loops

**Directory:** `tools/opai-engine/background/`

Always-on async loops started at Engine boot. Each runs independently with its own interval.

| Loop | File | Interval | Purpose |
|------|------|----------|---------|
| Heartbeat | `heartbeat.py` | 30 min | Aggregate snapshots, change detection, stall recovery, proactive intelligence, daily notes |
| Fleet Coordinator | `fleet_coordinator.py` | 5 min | Work dispatch, worker mail, hierarchical delegation, auto-review |
| NFS Dispatcher | `nfs_dispatcher.py` | 30 sec | External ClaudeClaw worker communication via NFS drop-folders |
| Service Monitor | `service_monitor.py` | 5 min | Individual service health checks |
| Resource Monitor | `resource_monitor.py` | 30 sec | CPU/memory tracking, resource gating |
| Auto-Executor | `worker_manager.py` | 30 sec | Worker health checks, auto-restart |
| Process Sweeper | `process_sweeper.py` | 5 min | Orphan Claude process cleanup |
| Bottleneck Detector | `bottleneck_detector.py` | 6 hours | Approval pattern analysis, auto-approve suggestions |
| Consolidator | `consolidator.py` | Daily 1 AM | Memory consolidation + pruning |
| NotebookLM Sync | `notebooklm_sync.py` | Daily | Wiki sync to NotebookLM (optional) |
| Chat Fast Loop | `workspace_chat.py` | 30 sec | Google Chat message polling (optional) |
| Notifier | `notifier.py` | On-demand | Telegram Bot API notifications (called by heartbeat, fleet, etc.) |

**Key relationship:** The heartbeat is an **aggregation layer** — it reads from the scheduler, worker manager, task registry, and session collector. It does not duplicate their work; it synthesizes their state into snapshots and detects patterns.

See also: [Heartbeat](heartbeat.md), [Fleet Coordinator](fleet-action-items.md), [NFS Dispatcher](nfs-dispatcher.md)

---

## Layer 3: Service-Specific Schedulers

Four services run their own schedulers because they manage domain-specific Supabase tables with custom execution logic. These are NOT duplicating Engine functionality — they handle work the Engine has no visibility into.

### WordPress Scheduler

**File:** `tools/opai-wordpress/services/scheduler.py`
**Table:** `wp_schedules` (Supabase)
**Tick:** 60 seconds

Manages per-site backup, health check, and update schedules. Features: per-site locking, 3-pronged health checks (connector + homepage + REST API), pre-backup before updates, auto-rollback on post-update health failure.

### WordPress Agent Scheduler

**File:** `tools/opai-wordpress/services/agent_scheduler.py`
**Table:** `wp_agents` (Supabase)
**Tick:** 60 seconds

Manages WP-specific agents (broken-link scanner, etc.). Per-agent locking, cron-driven.

### HELM Scheduler

**File:** `tools/opai-helm/core/scheduler.py`
**Table:** `helm_business_schedule` (Supabase)
**Tick:** 60 seconds

Autonomous business automation: `content_generate`, `report_weekly`, `stripe_sync`, `site_health_check`, `hitl_expiry`, `social_stats_sync`. Per-business cron expressions (default: every 6 hours).

### Brain Scheduler

**File:** `tools/opai-brain/scheduler.py`
**Table:** `brain_schedule` (Supabase)
**Tick:** 60 seconds

Knowledge graph agents: `curator`, `linker`, `library_sync`. Per-agent cron (default: daily 9 AM). 10-minute timeout per agent.

### ForumBot Scheduler

**File:** `tools/opai-forumbot/scheduler.py`
**Table:** `forumbot_schedules` (Supabase)
**Tick:** 60 seconds

Forum post generation with condition evaluation (`git_commits`, `weekday`, `service_restart`). Auto-publish or draft modes.

### Why These Stay Separate

These schedulers are correctly isolated:
1. **Different data sources** — each queries its own Supabase table, not `orchestrator.json`
2. **Domain logic** — WP backup rollback, HELM Stripe sync, Brain agent timeout, ForumBot conditions — none of this belongs in the Engine
3. **Failure isolation** — a WP scheduler crash doesn't affect HELM or Brain
4. **No overlap** — Engine scheduler handles OPAI-internal tasks; service schedulers handle service-specific work

---

## Layer 4: Telegram Watchdog

**File:** `tools/opai-telegram/alerts.js`
**Purpose:** Independent Engine-death detection

### What It Does

1. **Engine watchdog** — pings `http://127.0.0.1:8080/health` every 5 minutes. If unreachable for 10+ minutes, alerts via Telegram. Sends recovery alert when Engine comes back.
2. **WordPress site health** — polls `http://127.0.0.1:8096/api/sites` every 10 minutes for site status changes. The Engine doesn't directly monitor WP sites (it monitors the WP *service*, not individual *sites*).
3. **Morning briefings** — 8 AM system/personal/team briefings. Unique to Telegram, no Engine equivalent.

### What It Does NOT Do

Per-service state-change monitoring (e.g., "Brain went from healthy to unreachable") is handled by the Engine's heartbeat + notifier. Telegram does NOT independently track individual service states — that would be redundant.

### Why the Watchdog Exists

The Engine cannot alert about its own death. If `opai-engine` crashes, the heartbeat, notifier, and all background loops stop. Telegram's independent `/health` ping is the only way to detect this. This is the **sole justification** for Telegram having its own polling loop.

### Watchdog Design

```
Every 5 minutes:
  1. Ping http://127.0.0.1:8080/health (lightweight, 2ms)
  2. If unreachable:
     - Start 10-min grace period (prevents flapping alerts)
     - After grace period: send "Engine unreachable" alert
  3. If reachable after being down:
     - Send "Engine recovered" alert
     - Clear grace timer
```

See also: [Telegram Bridge](../integrations/telegram-bridge.md)

---

## Layer 5: systemd Timers

**Directory:** `config/service-templates/`

OS-level timers that run independently of OPAI. These handle infrastructure tasks that should execute even if the Engine is completely down.

| Timer | Schedule | Purpose |
|-------|----------|---------|
| `opai-docker-cleanup.timer` | Daily 3:00 AM | Clean up Docker containers |
| `opai-git-sync.timer` | Daily 11:00 PM | Push git changes to remote |
| `opai-farmos-sync.timer` | Sundays 4:00 AM | farmOS weekly sync + backup |

---

## Layer 6: Claude Code `/loop`

**Tool:** `CronCreate` (built into Claude Code CLI)
**Scope:** Session-only, dev convenience

See [Claude Code /loop Cron Feature](claude-loop-cron.md) for details.

Not part of production scheduling. No persistence, no audit, no fleet integration. Think of it as `watch` for Claude Code sessions.

---

## Overlap Analysis

### Resolved: Engine Heartbeat vs Telegram Alerts

**Before (v3.5):** Both the Engine (heartbeat + notifier) and Telegram (alerts.js) independently tracked per-service health states and sent alerts. This was redundant — two systems watching the same services, sending duplicate notifications.

**After (consolidation):** Telegram's `checkServiceHealth()` was simplified to watchdog-only:
- **Kept:** Engine reachability check (lines 126-165 equivalent) — the watchdog function
- **Removed:** `/api/health/summary` polling and per-service state-change tracking — this duplicated Engine's heartbeat + notifier
- **Kept:** WordPress site health (`checkWordPressHealth()`) — Engine monitors the WP service process, not individual sites
- **Kept:** Morning briefings — unique to Telegram, no Engine equivalent

### Not Overlap: Service-Specific Schedulers

WP/HELM/Brain/ForumBot schedulers are NOT redundant with the Engine scheduler. They manage different data (own Supabase tables), execute different logic (domain-specific), and have different failure domains. See [Layer 3](#layer-3-service-specific-schedulers) for details.

### Not Overlap: systemd Timers

systemd timers handle OS-level tasks that must run even if OPAI is down. They're infrastructure, not application scheduling.

---

## Complete Interval Reference

Sorted by frequency:

| Interval | System | Task |
|----------|--------|------|
| 30 sec | Engine | NFS Dispatcher polling |
| 30 sec | Engine | Resource Monitor |
| 30 sec | Engine | Worker health checks |
| 30 sec | Engine | Google Chat fast loop |
| 60 sec | Engine | Scheduler cron check |
| 60 sec | WP | Schedule executor tick |
| 60 sec | WP | Agent scheduler tick |
| 60 sec | HELM | Business scheduler tick |
| 60 sec | Brain | Agent scheduler tick |
| 60 sec | ForumBot | Schedule tick |
| 60 sec | Telegram | Briefing hour check |
| 2 min | Engine | Google Docs @mention poll |
| 2 min | Engine | Google Chat poll |
| 2 min | Engine | Co-edit activity check |
| 5 min | Engine | Service health check |
| 5 min | Engine | Fleet Coordinator |
| 5 min | Engine | Process Sweeper |
| 5 min | Engine | Feedback process |
| 5 min | Engine | User sandbox scan |
| 5 min | Telegram | Engine watchdog ping |
| 10 min | Telegram | WordPress site health |
| 15 min | Engine | Task processor |
| 15 min | Engine | Feedback act |
| 30 min | Engine | Heartbeat |
| 4 hours | Engine | Incident check |
| 4 hours | Engine | Context harvest |
| 6 hours | Engine | Bottleneck detector |
| Daily | Engine | Newsletter (7 AM), evolve (2 AM), knowledge (2:30 AM, 6 PM), dep scan (6 AM), secrets (7 AM), Drive audit (11 PM) |
| Daily | Engine | Heartbeat daily note (11:55 PM), consolidation (1 AM) |
| Daily | systemd | Docker cleanup (3 AM), git sync (11 PM) |
| Weekly | Engine | Workspace audit (Mon 9 AM), security (Mon 8 AM), a11y (Tue 10 AM) |
| Weekly | systemd | farmOS sync (Sun 4 AM) |

---

## Configuration Reference

All Engine scheduling is configured in `config/orchestrator.json`:

| Section | Controls |
|---------|----------|
| `schedules` | Cron expressions for Layer 1 jobs |
| `heartbeat` | Interval, stall threshold, daily note timing |
| `proactive_intelligence` | PI check interval, detection thresholds |
| `fleet_coordinator` | Dispatch interval, routing rules |
| `nfs_dispatcher` | Poll interval, heartbeat stale threshold |
| `process_sweeper` | Sweep interval, min age, max kills |
| `bottleneck_detector` | Check interval |
| `resources` | CPU/memory thresholds, parallel job limit |
| `consolidator` | Hour/minute for daily consolidation |

Service-specific schedulers are configured via their own Supabase tables (not `orchestrator.json`).

---

## See Also

- [Heartbeat](heartbeat.md) — Layer 2 aggregation loop
- [Fleet Coordinator & Action Items](fleet-action-items.md) — Layer 2 work dispatch
- [NFS Dispatcher](nfs-dispatcher.md) — Layer 2 external worker bridge
- [Orchestrator (Engine)](../core/orchestrator.md) — Engine architecture
- [Services & systemd](../core/services-systemd.md) — Layer 5 timer details
- [Telegram Bridge](../integrations/telegram-bridge.md) — Layer 4 watchdog context
- [Claude Code /loop](claude-loop-cron.md) — Layer 6 dev tool
