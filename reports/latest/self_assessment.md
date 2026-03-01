# OPAI Self-Assessment Report

**Date:** 2026-02-24
**Assessor:** Manual (Claude Code session)
**Previous Assessment:** 2026-02-22

## Evolution Applied (Safe Mode)

| Fix | File | Change | Status |
|-----|------|--------|--------|
| Remove `dam_session_monitor` schedule | `config/orchestrator.json` | Deleted orphan schedule entry with no handler | APPLIED + VERIFIED (0 warnings post-restart) |
| Fix git-sync SIGPIPE | `scripts/daily-git-push.sh` | Store `git status` output before piping to `head` | APPLIED + VERIFIED (dry-run passes with 249 files) |
| Restart orchestrator | `opai-orchestrator.service` | Picked up clean config | APPLIED |

---

## Progress Since Last Assessment (2026-02-22)

| Prior Finding | Status | Notes |
|--------------|--------|-------|
| P0: `claude` not on PATH in systemd | **OPEN** | Still blocks all automated squad runs |
| P0: `brain_researcher` prompt missing | **OPEN** | `brain` squad remains broken |
| P0: `self_assessment` prompt wrong paths | **FIXED** | No more `.agent/` prefix in prompt |
| P0: 5 scheduled jobs never fire | **PARTIAL** | Cron entries exist but automation still blocked by PATH issue |
| P1: No `apply_fixes.sh` for executor blocks | **OPEN** | executor_safe still generates fix blocks with no parser |
| P1: `report_dispatcher` bottleneck (16 squads) | **OPEN** | Architectural — needs design decision |
| `auto_safe` squad ran successfully (Feb 23) | **NEW** | Produced 5 reports: accuracy, health, security, executor_safe, reviewer |
| Report count grew from 7 to 13 in latest/ | **IMPROVED** | More comprehensive coverage |

---

## 1. SYSTEM HEALTH SUMMARY

| Component | Status | Last Seen | Notes |
|-----------|--------|-----------|-------|
| Orchestrator | OK | 2026-02-24T10:10 | Running since Feb 13, stable main loop |
| Email Agent (autonomous) | OK | 2026-02-24T21:53 | Processing emails, whitelist gate working |
| Email Checker (timer) | FAILED | 2026-02-24T16:02 | IMAP ETIMEOUT — continuous failure since Feb 13 (11 days) |
| Discord Bridge | OK | Active service | Guild logs show activity |
| Monitor | OK | Scan at 15:58 today | Last scan completed, known_components populated |
| Task Control Panel | OK | Active service | 29 tasks in registry |
| Portal | OK | Active service | — |
| Chat | OK | Active service | — |
| Billing | OK | Active service | — |
| Brain | OK | Active service | Port 8101 |
| Bx4 | OK | Active service | Port 8100 |
| DAM | OK | Active service | Port 8104 |
| HELM | OK | Active service | Port 8102 |
| Marq | OK | Active service | Port 8103 |
| Orchestra | OK | Active service | Port 8098 |
| Bot Space | OK | Active service | Port 8099 |
| Git Sync (timer) | FAILED | 2026-02-23T23:00 | Exit 141 (SIGPIPE) — daily commits not landing |
| Evolve Loop | Enabled (config) | Never fires | `claude` PATH issue blocks execution |
| Self-Assessment | Enabled (config) | Never fires | Same PATH issue |
| `dam_session_monitor` | BROKEN | Every 2 min | Scheduled but no handler — 720+ WARNs/day |

**Service Summary:** 31 active, 2 failed (`opai-email`, `opai-git-sync`), 2 inactive timers (cleanup, journal)

---

## 2. RECENT RUN ANALYSIS

### Last Squad Run: `auto_safe` (2026-02-23)

| Agent | Status | Report Size |
|-------|--------|-------------|
| accuracy | success | 31,097B |
| health | success | 531B |
| security | success | 500B |
| executor_safe | success | 485B |
| reviewer | skipped (cached) | 18,572B |

Duration: 948s. All agents completed. No failures.

### Report Freshness

| Report | Modified | Age (days) | Status |
|--------|----------|------------|--------|
| accuracy.md | Feb 23 | 1 | Fresh |
| health.md | Feb 23 | 1 | Fresh |
| security.md | Feb 23 | 1 | Fresh |
| executor_safe.md | Feb 23 | 1 | Fresh |
| reviewer.md | Feb 23 | 1 | Fresh |
| _run_summary.md | Feb 23 | 1 | Fresh |
| dep_scanner.md | Feb 20 | **4** | Stale |
| secrets_detector.md | Feb 20 | **4** | Stale |
| incident_responder.md | Feb 21 | **3** | Stale |
| report_dispatcher.md | Feb 21 | **3** | Stale |
| tools_monitor.md | Feb 21 | **3** | Stale |
| self_assessment.md | Feb 22 | 2 | Replaced by this report |
| evolve_safe_plan.md | Feb 22 | 2 | Applied |

---

## 3. ERROR ANALYSIS

### Orchestrator Log Patterns

**ERROR — Email Check IMAP Timeout (CRITICAL, RECURRING)**
```
[2026-02-24T10:01:28.277Z] [ERROR] Email check failed {"code":1,"duration":33323,
  "output":"ImapFlow.emitError ... code: 'ETIMEOUT'"}
```
- Occurs every 30 minutes (every `email_check` cycle)
- Duration: consistently ~33 seconds (connection timeout)
- Root cause: IMAP server at email provider is unreachable or blocking connections
- Impact: No automated email-to-task processing via the timer-based checker
- Note: The **Email Agent** (opai-email-agent, port-based) IS working — this is the legacy timer-based checker

**WARN — `dam_session_monitor` Unknown Handler (HIGH NOISE)**
```
[2026-02-24T10:10:55.824Z] [WARN] Unknown scheduled task: dam_session_monitor
```
- Fires every 2 minutes (per orchestrator.json `"dam_session_monitor": "*/2 * * * *"`)
- Handler does NOT exist in `tools/opai-orchestrator/index.js` (confirmed via grep)
- Generates ~720 WARN lines per day — pure log noise
- Impact: Fills orchestrator log, makes real errors harder to find

**ERROR — Email Service Restart Loop (Feb 13, RESOLVED)**
- Orchestrator log from Feb 13 shows continuous `email` and `task_processor` restart attempts
- `task_processor`: "Unit opai-task_processor.service not found" — this service was never created as a systemd unit (it's an internal orchestrator function per config)
- This loop has been resolved — current logs don't show these restart attempts

**WARN — System Resource Constraints (Feb 13, RESOLVED)**
- Feb 13 logs showed sustained CPU >80-97%
- Current system: load average 1.58, memory 12G/23G used (52%), swap 3.8G/8G
- Resources currently healthy

### Git Sync Failure
```
opai-git-sync: exit code 141 (SIGPIPE)
"Changes detected, preparing commit..."
```
- Timer fires at 23:00 daily
- Exit 141 = SIGPIPE — output piped to something that closed early
- Impact: Daily automatic git commits/pushes not happening

### Email Agent (opai-email-agent)
- Working correctly — processing emails, applying whitelist gate
- Most recent action: 2026-02-24T21:53 (today)
- All actions are `skip` for non-whitelisted senders — expected behavior

---

## 4. TASK QUEUE STATUS

### Registry (tasks/registry.json)

| Status | Count | Notes |
|--------|-------|-------|
| completed | 7 | 24% completion rate |
| failed | **13** | **45% failure rate — very high** |
| cancelled | 8 | 28% cancelled |
| pending | 1 | `t-20260220-010`: WordPress backup download auth bypass |
| **TOTAL** | **29** | |

- No tasks stuck in `in_progress` (good)
- 13 failed tasks: majority are email-sourced tasks that couldn't be processed (likely due to email checker IMAP failure)
- 1 pending task is a security finding — should be prioritized

### Deferred Queue (tasks/queue.json)

| ID | Priority | Description | Age |
|----|----------|-------------|-----|
| q-20260214-001 | CRITICAL | Mobile terminal input issues | 10 days |
| q-20260222-001 | Normal | Fix Grok idea generator | 2 days |

- 2 items in queue, 0 completed
- The critical mobile input issue has been queued for 10 days with no progress

---

## 5. CONFIGURATION DRIFT

### orchestrator.json Analysis

| Setting | Value | Status |
|---------|-------|--------|
| evolve.enabled | true | OK — but never fires (PATH issue) |
| self_assessment cron | `0 2 * * *` (2am daily) | OK schedule |
| evolution cron | `0 3 * * *` (3am daily) | OK schedule |
| dam_session_monitor | `*/2 * * * *` | **BROKEN — no handler exists** |
| task_processor service config | `type: "internal"` | **DRIFT** — config says internal but orchestrator tries to restart as systemd unit |
| email service | `restart_on_failure: false` | OK — matches timer-based design |
| max_cpu_percent | 80 | OK |
| max_parallel_jobs | 3 | OK |

### Key Drift Issues

1. **`dam_session_monitor`**: Added to `schedules` but never implemented in orchestrator source code
2. **`task_processor` service**: Config says `type: "internal"` but early logs show orchestrator tried `systemctl --user restart opai-task_processor` — the health check code doesn't respect the `type: "internal"` flag

---

## 6. AGENT COVERAGE GAPS

### GAP-01: `dam_session_monitor` Has No Handler
```
TOOL/AREA: Orchestrator scheduled task handling
RISK: 720+ WARN lines/day pollute logs; DAM session stale detection not working
SUGGESTED FIX: Either implement handler in orchestrator index.js or remove from schedules
```

### GAP-02: Git Sync Broken — No Automated Backups
```
TOOL/AREA: daily-git-push.sh / opai-git-sync service
RISK: Code changes not being committed/pushed automatically; potential data loss
SUGGESTED FIX: Debug SIGPIPE in daily-git-push.sh (likely a piped command issue)
```

### GAP-03: Email Checker IMAP Permanently Broken
```
TOOL/AREA: tools/email-checker (legacy timer-based)
RISK: Email-to-task pipeline via timer checker is dead
SUGGESTED FIX: Since email-agent (port 8101) works, consider deprecating the timer-based checker OR fix IMAP connectivity
```

### GAP-04: Automated Squads Still Cannot Run
```
TOOL/AREA: run_squad.sh / systemd PATH
RISK: All scheduled agent squads (evolve, self_assessment, dep_scan_daily, etc.) never fire
SUGGESTED FIX: Add nvm PATH to systemd service environment or use CLAUDE_BIN resolution
```

### GAP-05: `brain_researcher` Prompt Still Missing
```
TOOL/AREA: scripts/prompt_brain_researcher.txt
RISK: `brain` squad fails for this agent
SUGGESTED FIX: Create prompt file per PROPOSAL-01 in prior self_assessment
```

---

## 7. IMPROVEMENTS PROPOSED

```improvement
PRIORITY: critical
AREA: orchestrator.json
PROBLEM: dam_session_monitor scheduled every 2 min with no handler — 720+ WARNs/day
FIX: Remove "dam_session_monitor" from schedules until handler is implemented
MANUAL: no
```

```improvement
PRIORITY: critical
AREA: opai-git-sync / daily-git-push.sh
PROBLEM: Exit 141 (SIGPIPE) — daily commits failing
FIX: Debug the piped command in daily-git-push.sh; likely needs pipe error handling
MANUAL: yes
```

```improvement
PRIORITY: high
AREA: Credential exposure (8+ keys in source)
PROBLEM: Live Stripe keys, Supabase service keys, ClickUp API key, Tailsync token hardcoded
FIX: Rotate all credentials, move to .env files, add .env patterns to .gitignore
MANUAL: yes (rotation requires external service access)
```

```improvement
PRIORITY: high
AREA: run_squad.sh / systemd PATH
PROBLEM: claude CLI not on PATH for systemd-triggered runs
FIX: Add CLAUDE_BIN resolution at top of run_squad.sh
MANUAL: no
```

```improvement
PRIORITY: normal
AREA: Task registry health
PROBLEM: 45% failure rate (13/29 tasks failed)
FIX: Review and close/retry failed tasks; add task age monitoring
MANUAL: yes
```

```improvement
PRIORITY: normal
AREA: scripts/prompt_brain_researcher.txt
PROBLEM: Missing prompt file breaks brain squad
FIX: Create prompt per PROPOSAL-01 from prior assessment
MANUAL: no
```

---

## 8. ACTION ITEM SUMMARY

- P0: Remove `dam_session_monitor` from orchestrator.json (no handler, 720+ WARNs/day)
- P0: Fix git-sync SIGPIPE (daily backups not landing)
- P0: Rotate 8+ hardcoded credentials (Stripe, Supabase, ClickUp, Tailsync, Discord)
- P1: Fix `claude` PATH in run_squad.sh for automated squad runs
- P1: Investigate email checker IMAP ETIMEOUT (11 days continuous failure)
- P1: Review 13 failed tasks in registry — close or retry
- P2: Create `brain_researcher` prompt file
- P2: Implement or stub `dam_session_monitor` handler in orchestrator
- P2: Add .env patterns to root .gitignore (per prior executor_safe)
- P2: Fix `task_processor` health check to respect `type: "internal"` config flag

Critical: 3
High: 3

---

## 9. SELF-ASSESSMENT METADATA

**Files read during assessment:**
- `config/orchestrator.json`
- `tasks/registry.json`
- `tasks/queue.json`
- `tasks/audit.json`
- `logs/orchestrator.log` (first 500 lines + last 100 lines)
- `reports/latest/*.md` (13 files)
- `scripts/prompt_self_assessment.txt`
- `scripts/prompt_executor_safe.txt`
- `tools/opai-email-agent/data/action-log.json`
- `tools/discord-bridge/data/bot.log`
- `tools/opai-monitor/data/updater-state.json`
- `tools/opai-orchestrator/index.js` (grep for dam_session_monitor)
- systemd service status (all opai-* units)
- System resources (uptime, free, df)

**Files that could not be fully read:**
- `tasks/registry.json` — truncated at 60KB (parsed via Python script)
- `tools/opai-monitor/data/updater-state.json` — truncated at 50KB (header sufficient)
- `logs/orchestrator.log` — only first 500 + last 100 lines of a very large file

**Date/time:** 2026-02-24 ~10:15 CST
**Confidence:** HIGH — all key sources readable, live system state verified
