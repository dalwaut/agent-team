# Feedback System
> Last updated: 2026-02-25 (v2 engine dashboard interactivity) | Source: `tools/feedback-processor/index.js`, `tools/feedback-processor/feedback-actor.js`, `tools/opai-portal/app.py`, `tools/opai-portal/static/js/navbar.js`, `tools/opai-engine/services/task_processor.py`, `tools/opai-engine/static/js/app.js`

In-app feedback collection, classification, improvement pipeline, agent-first execution, and self-healing loop for all OPAI tools.

## Overview

Users click a feedback button in the shared navbar (present on every tool page). Feedback is captured, classified by severity/category via Claude CLI, checked against wiki docs for duplicates, and organized into per-tool improvement files. HIGH and MEDIUM severity items are automatically promoted to tasks in the central registry. All feedback items are browsable and actionable via the **agent-first** Feedback tab in the [Engine dashboard](opai-v2.md).

**Agent-first model**: Two primary actions on any feedback item:
- **Run** — creates task + launches `feedback_fixer` agent immediately (`mode: "execute"`)
- **Queue** — creates task for the 30s auto-execute cycle (`mode: "queued"`, runs regardless of global `auto_execute` setting)

Humans add context or dismiss — they don't manually create tasks or assign agents as separate steps.

## Architecture

```
Navbar Feedback Button → POST /api/feedback → feedback-queue.json
                                            → Feedback-{Tool}.md (instant write, MEDIUM default)
                                                     ↓ (every 5 min)
                                              feedback-processor
                                                ├─ Classify (Claude CLI)
                                                ├─ Wiki check (grep + Claude verify)
                                                ├─ Update Feedback-{Tool}.md (dedup-aware, refines classification)
                                                └─ Append FEEDBACK-IMPROVEMENTS-LOG.md
                                                     ↓ (every 15 min)
                                              feedback-actor (reads feedback_autofix_threshold)
                                                ├─ Scan items at/above threshold in Feedback-*.md
                                                ├─ Auto-route via work-companion (classify + route)
                                                └─ At threshold → mode: "execute" + feedback-fixer agent
                                                     ↓
                                              Engine Dashboard — Feedback Tab
                                                ├─ [Create Task] → POST /api/feedback/action {action: "create-task"}
                                                ├─ [Run] → POST /api/feedback/action {action: "run"}
                                                ├─ [Queue] → POST /api/feedback/action {action: "queue"}
                                                ├─ [Done] → POST /api/feedback/action {action: "mark-done"}
                                                ├─ [Dismiss] → POST /api/feedback/action {action: "dismiss"}
                                                ├─ (Also available via API: add-context, change-severity, re-evaluate)
                                                └─ State chips: Running (spinner) / Queued / IMPLEMENTED
                                                     ↓ (auto-execute cycle, 30s)
                                              Queued tasks picked up
                                                └─ feedback-fix + mode:"queued" → _run_feedback_fix_threaded()
                                                     ↓ (on task completion)
                                              Feedback loop closure
                                                ├─ Validate output (no false positives)
                                                └─ Auto-mark feedback as IMPLEMENTED in Feedback-*.md
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-portal/static/js/navbar.js` | Feedback button + modal UI in shared navbar |
| `tools/opai-portal/app.py` | `POST /api/feedback` endpoint with rate limiting |
| `notes/Improvements/feedback-queue.json` | Feedback intake queue (JSON) |
| `notes/Improvements/FEEDBACK-IMPROVEMENTS-LOG.md` | Append-only rolling changelog |
| `notes/Improvements/Feedback-{Tool}.md` | Per-tool feedback files (created dynamically) |
| `tools/feedback-processor/index.js` | Classification + wiki-check + file management |
| `tools/feedback-processor/feedback-actor.js` | Scans HIGH/MEDIUM items, creates registry tasks |
| `config/orchestrator.json` | Schedules: `feedback_process: "*/5 * * * *"`, `feedback_act: "*/15 * * * *"` |
| `tools/opai-orchestrator/index.js` | `runFeedbackProcess()` + `runFeedbackAct()` spawns both processors. v2: orchestrator scheduling merged into `tools/opai-engine/background/scheduler.py` |
| `tools/opai-engine/services/task_processor.py` | `parse_feedback_files()`, `feedback_action()`, `_run_feedback_fix()` — backend for Feedback tab + fixer execution (v2: replaces `tools/opai-tasks/services.py`) |
| `scripts/prompt_feedback_fixer.txt` | Agent role prompt for the feedback fixer (scoping rules, workflow, output format) |
| `team.json` | `feedback_fixer` agent registration (category: execution) |
| `tools/opai-engine/routes/tasks.py` + `routes/feedback.py` | `GET /api/feedback`, `POST /api/feedback/action` — REST endpoints (v2: replaces `tools/opai-tasks/routes_api.py`) |

## Data Flow

### Feedback Submission
1. User clicks feedback button (message-bubble icon, right side of navbar)
2. Modal opens with tool name auto-detected from URL
3. User types feedback text and submits
4. `POST /api/feedback` validates, rate-limits (5/min per IP), appends to `feedback-queue.json`
5. **Instant write**: Portal also writes the entry directly to `Feedback-{Tool}.md` (severity defaults to MEDIUM, category to "uncategorized") — makes it visible in the Task Control Panel immediately
6. User sees "Thanks!" flash confirmation

### Feedback Processing (every 5 min via orchestrator)
1. Reads `feedback-queue.json` for items with `status: "new"`
2. **Classify**: Sends feedback to Claude CLI, gets `{severity, category}` JSON
3. **Wiki check**: Extracts keywords (local, no LLM), greps against tool's wiki file(s), if match found sends excerpt to Claude for yes/no verification
4. If feature already exists: marks item `"null"`, logs as duplicate, skips
5. **Dedup-aware write**: If the entry already exists in `Feedback-{Tool}.md` (from instant write), updates severity/category in-place. Otherwise writes new entry.
6. Appends outcome to `FEEDBACK-IMPROVEMENTS-LOG.md`
7. Cleans up completed/null items from queue

## Data Structures

### Queue Item
```json
{
  "id": "fb_1708099200000_abc12",
  "tool": "chat",
  "page_path": "/chat/",
  "user_text": "I wish this app had dark mode",
  "user_id": "optional-uuid",
  "user_email": "optional",
  "timestamp": "2026-02-16T18:00:00.000Z",
  "severity": null,
  "category": null,
  "status": "new",
  "wiki_match": null,
  "processor_notes": null,
  "files_modified": []
}
```

### Severity Levels
- **HIGH**: Crash, unusable state, data loss, broken core function
- **MEDIUM**: Usable but missing expected functionality
- **LOW**: Works fine, user wants a specific enhancement

### Categories
`bug-fix`, `feature-request`, `ux-improvement`, `performance`, `accessibility`, `content`, `integration`, `documentation`

### Status Flow
`new` → `classified` → `complete` (or `null` if already exists in wiki)

### Feedback Parser

Parser lives in `services/task_processor.py:parse_feedback_files()`.

- Reads all `notes/Improvements/Feedback-*.md` files
- Regex uses `[\s\S]+?` for the description group (NOT `.+?`) to handle multi-line descriptions where text wraps across lines
- Newlines in multi-line descriptions are collapsed to spaces via `re.sub(r'\s*\n+\s*', ' ', ...)`
- Each item returns: `feedbackId` (camelCase), `tool`, `severity`, `category`, `description`, `timestamp`, `implemented`, `file`
- **JS field name**: Frontend code must reference `f.feedbackId` (not `f.id` or `f.feedback_id`) — this is the camelCase key returned by the parser

## Wiki Comparison (Token-Smart)

1. **Keyword extraction** (local): Strip stop words, take top 5 meaningful words
2. **Tool-to-wiki mapping**: Static lookup in processor (e.g., `chat` → `chat.md`)
3. **Targeted grep**: `grep -i -C 2 <keyword> <wiki-file>` — never reads whole files
4. **Verification** (1 Claude call): If grep matches, asks Claude "Does this already exist?" → yes/no
5. **Decision**: Yes → mark `"null"`, skip. No → proceed normally.

Total Claude calls per item: 1 (classify) + 0-1 (verify) = 1-2 calls with small prompts.

## Configuration

### Rate Limiting
- 5 submissions per 60 seconds per IP (in-memory, resets on portal restart)
- Max 2000 characters per feedback text

### Orchestrator Schedules
In `config/orchestrator.json`:
```json
"feedback_process": "*/5 * * * *",
"feedback_act": "*/15 * * * *"
```

### Token Optimization (Feedback Fixer)

The feedback fixer went through significant research and iteration to find the right cost/completion tradeoff. Full research log: `Research/feedback-fixer-optimization-plan.md`.

#### Model Selection

| Model | Runs | Completion Rate | Avg Tokens/Run | Notes |
|-------|------|-----------------|----------------|-------|
| **Haiku** | 6 | **0%** | 756K | Explores but never edits — too weak for implementation tasks |
| **Sonnet (unoptimized)** | 19 | 89% | 2,014K | Works but expensive |
| **Sonnet (Phase 1 optimized)** | ongoing | ~90% | ~340K | Current default |

**Key finding**: Haiku cannot complete implementation tasks. It will spend all turns exploring and never make edits. Always use sonnet for the feedback fixer.

#### CLI Overhead Reduction

Every `claude -p` call includes internal system context. Measured overhead by configuration:

| CLI Configuration | System Tokens per Call |
|---|---|
| Default (all tools + CLAUDE.md loaded) | 39,625 |
| `--tools "Read,Edit,Grep"` + `--setting-sources user` | 21,926 |
| + `--system-prompt` custom mini prompt | 15,430 |
| Only 1 tool + custom system prompt | **14,007 (CLI floor)** |
| Direct Anthropic API (Phase 2, not yet implemented) | ~500–1,000 |

The `--setting-sources user` flag prevents loading CLAUDE.md and MEMORY.md (~14KB of workspace context) — saves ~3,500 tokens/turn. The `--system-prompt` flag replaces the full internal system prompt with a compact, focused instruction. Combined: 40K → 15K per call (-63%).

#### `--tools` vs `--allowedTools` Discovery

**Critical gotcha**: `--allowedTools` does NOT restrict tools — it only pre-approves them for auto-use. With `--dangerously-skip-permissions`, this meant Bash was still available and agents would call `find` via Bash despite it not being in the allowed list.

**Fix**: Always use `--tools` (not `--allowedTools`) to actually restrict available tools. The fixer runs with `--tools Read,Edit,Write,Glob,Grep` — Bash is not available.

#### Session JSONL Extraction

When an agent ends its session with a tool call instead of a text message, `claude -p --output-format json` returns an empty `result` field. The fixer now handles this by:

1. Finding the session JSONL file at `~/.claude/projects/<project-dir>/<session-id>.jsonl`
2. Extracting all Edit/Write tool calls and any agent text messages
3. Building a synthetic report from those extracted actions

This means even if the agent doesn't produce a text summary, the system still captures what edits were actually made. See `_extract_edits_from_session()` and `find_session_for_audit()` in `services.py`.

#### Turn Count Findings

| Max Turns | Outcome | Tokens |
|-----------|---------|--------|
| 3 | Ran out mid-explore, no edits | 68K |
| 5 | Multiple Greps burned turns, no edits | 180K |
| 7 | Edits on turns 7-8, no room for summary | 290K |
| **10 (current)** | **Explore T1-4, edit T5-8, summary T9-10** | **~340K** |

Agents naturally use 4-5 turns exploring (Grep + Read) before editing. The system prompt says "ONE Grep only" but agents sometimes run 2-4 Greps. With 10 turns there is enough room for exploration + multiple edits + text summary.

#### Agent Role Prompt (`scripts/prompt_feedback_fixer.txt`)

The feedback fixer role prompt has been simplified to a compact, turn-budget-aware instruction:

```
You are a code editor. You receive feedback and implement the fix.

TURN BUDGET: You have 10 tool rounds total.
- Turn 1: ONE Grep to find the relevant code (use a broad regex).
- Turn 2: Read the relevant section (use offset+limit, NOT the whole file).
- Turns 3-8: Edit the files. You MUST make your first Edit by turn 3.
- Turn 9: Any final edits or verification reads.
- Turn 10: RESERVED for your text summary. Do NOT use a tool on turn 10.

HARD RULES:
- ONE Grep only. If your first Grep misses, Read the file index instead of Grepping again.
- Always Read with offset+limit — never read a full file.
- NEVER use Bash.
- Your VERY LAST message MUST be a text summary of changes (not a tool call).
- If you end on a tool call instead of text, the run is considered FAILED.

Output format for your final text message:
## Changes Applied
- `file` — what changed
```

This role prompt replaces the previous system-level `_MINI_SYSTEM` inline prompt approach. The role prompt enforces turn budget discipline explicitly (Grep on T1, Read on T2, Edit by T3, text summary on T10).

A `--system-prompt` can still be passed inline by `_build_feedback_fix_prompt()` in `services.py` when additional task-specific context is needed (`_MINI_SYSTEM` defined there for single-task mode, `_MINI_SYSTEM_BATCH` for batch mode).

### Token Budget Settings

Stored in `config/orchestrator.json` under `task_processor`:

| Setting | Default | Purpose |
|---------|---------|---------|
| `feedback_fixer_model` | `"sonnet"` | Default Claude model for feedback fixer |
| `feedback_fixer_max_turns` | `10` | Max agentic turns per fixer execution |
| `daily_token_budget_enabled` | `true` | Enable/disable daily token budget cap |
| `daily_token_budget` | `5000000` | Daily token limit (input + output combined) |

Per-agent overrides in `team.json` take precedence over these defaults. See [Agent Framework — Agent Tuning Fields](agent-framework.md#agent-tuning-fields).

### Settings Sync

`team.json` is the **source of truth** for per-agent settings. Changes made in Agent Studio write to `team.json`. The Token Budget modal reads from `team.json` first (via `get_settings()` in `services.py`) and falls back to `orchestrator.json` defaults.

When `feedback_fixer` model or max_turns are updated anywhere, the change syncs bidirectionally:
- Agent Studio saves to `team.json` → `agent_manager.py:update_agent()` syncs `feedback_fixer_model` and `feedback_fixer_max_turns` to `orchestrator.json`
- Token Budget modal saves to `orchestrator.json` + `team.json` via `update_settings()`

Priority order: task-level override → `team.json` per-agent → `orchestrator.json` default

### Token Budget UI (Task Control Panel)

The Audit tab in the [Task Control Panel](task-control-panel.md) includes a **Token Budget** button (next to the Refresh button):

- **Modal contents**: Fetches fresh settings + live usage data on open
- **Usage bar**: Visual bar with percentage (green < 60%, orange 60-85%, red > 85%)
- **Configurable fields**: Budget toggle (on/off), budget limit, fixer model dropdown, max turns input
- **Badge**: The Token Budget button displays a live usage percentage badge, color-coded to match the bar

## Feedback Actor (Auto-Task Creation + Auto-Routing)

Every 15 minutes, `feedback-actor.js` scans for actionable feedback. Behavior is controlled by the **auto-fix threshold** setting.

### Auto-Fix Threshold

Stored in `config/orchestrator.json` → `task_processor.feedback_autofix_threshold`. Configurable via the Task Control Panel Feedback tab's Auto-fix dropdown.

| Threshold | Severities Processed | UI Color |
|-----------|---------------------|----------|
| `NONE` | None — actor exits immediately | Default/muted |
| `HIGH` (default) | HIGH only | Red |
| `MEDIUM` | HIGH + MEDIUM | Yellow |
| `LOW` | HIGH + MEDIUM + LOW | Blue |

### Actor Flow

1. Reads `feedback_autofix_threshold` from `config/orchestrator.json`
2. If `NONE`, exits immediately
3. Reads all `Feedback-*.md` files in `notes/Improvements/`
4. Parses items under all severity sections, filters to threshold level and above
5. Skips struck-through (implemented) items
6. For each item, checks `tasks/registry.json` for an existing task with matching `sourceRef.feedbackId`
7. If no task exists:
   - Creates one with priority: HIGH→`critical`, MEDIUM→`high`, LOW→`normal`
   - **Auto-routes** via work-companion (`classifyTask` + `routeTask`) to find best agent/squad
   - Sets `routing.type: "feedback-fix"` + `routing.mode: "execute"` (auto-run eligible)
   - If no agent matched via auto-route, assigns `feedback-fixer` agent directly

```bash
# Run manually
node tools/feedback-processor/feedback-actor.js
```

## Feedback Tab (Engine Dashboard — Agent-First)

The [Engine dashboard](opai-v2.md) includes a **Feedback** tab that provides an agent-first view of all feedback items. The primary action is **Run** — creating a task and launching a fixer agent in one click.

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/feedback` | GET | Returns all parsed feedback items + summary stats + task cross-refs (`taskStatus`, `taskAgent`) |
| `/api/feedback/action` | POST | Execute action on a feedback item (requires admin) |

### Actions

| Action | Body Fields | Effect |
|--------|-------------|--------|
| `run` | `agentId?`, `agentType?` | Creates task + resolves tool source dir + launches feedback fixer immediately |
| `queue` | — | Creates task in registry WITHOUT launching — picked up by the 30s auto-execute cycle. Uses `mode: "queued"` which runs regardless of global `auto_execute` setting. |
| `add-context` | `extraData.context` | Appends `**[Context: ...]**` to the feedback line in `Feedback-{Tool}.md` |
| `change-severity` | `extraData.severity` | Moves feedback line between severity sections (HIGH/MEDIUM/LOW) in `Feedback-{Tool}.md` |
| `re-evaluate` | — | AI evaluation of feedback against current app state via `claude -p` (60s timeout). Returns `{status, reason}` where status is `missing`, `unnecessary`, `implemented`, or `partial`. |
| `create-task` | `agentId?` | Creates a task in `registry.json` (legacy — use `run` or `queue` instead) |
| `mark-done` | — | Adds strikethrough + `**IMPLEMENTED**` marker to the line in `Feedback-{Tool}.md` |
| `dismiss` | — | Removes the line from `Feedback-{Tool}.md` entirely |

### Feedback Fixer Agent

Registered as `feedback_fixer` in `team.json` (category: execution, prompt: `scripts/prompt_feedback_fixer.txt`). This is a **dedicated implementation agent** — unlike audit/review agents, it directly edits source files.

#### Execution Modes

| Trigger | Mode | Behavior |
|---------|------|----------|
| **Run** button | `execute` | Creates task + launches `_run_feedback_fix_threaded()` immediately |
| **Queue** button | `queued` | Creates task only — auto-execute cycle picks it up within 30s |
| **feedback-actor** (HIGH) | `execute` | Auto-created task, auto-run eligible by auto-execute cycle |
| **feedback-actor** (MEDIUM) | `propose` | Auto-created task, waits for human review / manual Run |

Queued tasks (`mode: "queued"`) always run when a slot is available, **regardless of the global `auto_execute` setting**. They were explicitly queued by a human.

#### Prompt Composition

When triggered, `_build_feedback_fix_prompt()` assembles a prompt from multiple sources (~4.5KB total, down from ~7.8KB before token optimization):
1. **Agent role prompt** from `scripts/prompt_feedback_fixer.txt` (scoping rules, workflow, output format)
2. **Task context** (feedback text, severity, category, tool name)
3. **HITL/human notes** — instructions or reviewer notes attached to the task
4. **Safety rules** — never run systemctl, never delete files, code changes only
5. **Wiki hint path** — a reference path to the wiki doc (e.g., `Library/opai-wiki/team-hub.md`) that the agent can read if needed. Previously embedded the full wiki doc (~3KB) inline, which inflated every turn.
6. **Source directory** scoping — agent told to only modify files within the tool's directory

#### Execution Details

1. **Resolves tool directory**: Maps feedback tool name (e.g., "TeamHub") to source path (`tools/opai-team-hub`) via `_TOOL_DIR_MAP` in `services.py`
2. **Resolves wiki hint**: Maps tool to wiki doc via `_TOOL_WIKI_MAP` (e.g., "TeamHub" → `team-hub.md`) and includes a hint path in the prompt (agent reads if needed, not embedded inline)
3. **Resolves agent tuning**: Reads per-agent `model`, `max_turns`, and `no_project_context` from `team.json`. Falls back to `config/orchestrator.json` defaults (`feedback_fixer_model: "sonnet"`, `feedback_fixer_max_turns: 10`).
4. **Runs `claude -p --dangerously-skip-permissions --setting-sources user --tools Read,Edit,Write,Glob,Grep`** with the tool's directory as working directory (10-min timeout). The `--setting-sources user` flag skips loading CLAUDE.md and MEMORY.md (~14KB), saving ~3,500 tokens per turn. The `--tools` flag (not `--allowedTools`) actually restricts available tools — Bash is not included and cannot be invoked. Additional flags applied from agent tuning: `--model` and `--max-turns` if set.
5. **Validates output**: Checks agent response for failure indicators (e.g., "unable to proceed", "permission denied"). If the agent couldn't apply changes, the task reverts to `pending` instead of being marked completed.
6. **Saves report** to `reports/<date>/task-{id}-feedback-fix.md` with status label (COMPLETED or FAILED)
7. **Audit record**: Logs the resolved model to the task's audit trail. Falls back to the resolved `model` variable when Claude's JSON output doesn't include the model field.
8. **Closes the loop**: Auto-marks feedback as IMPLEMENTED — **only** when the fix was actually applied (validated in step 5)

Tool name → directory mapping (in `services.py:_TOOL_DIR_MAP`):
```
TeamHub     → opai-team-hub        Chat        → opai-chat
Files       → opai-files           Monitor     → opai-monitor
Tasks       → opai-tasks           Portal      → opai-portal
Agents      → opai-agents          Marketplace → opai-marketplace
Docs        → opai-docs            Forum       → opai-forum
ForumBot    → opai-forumbot        Billing     → opai-billing
Users       → opai-users           Dev         → opai-dev
Terminal    → opai-terminal        Messenger   → opai-messenger
Orchestrator → opai-orchestrator   EmailAgent  → opai-email-agent
WordPress   → opai-wordpress
```
Fuzzy fallback: if tool name isn't in the map, tries `opai-{lowercase(name)}`.

### Audit Trace

Every feedback fixer run writes an audit record to the task's `audit` array in `tasks/registry.json`. This allows post-run inspection of what model was used, how many tokens were consumed, and whether edits were actually made.

#### Audit Record Fields

| Field | Source | Notes |
|-------|--------|-------|
| `timestamp` | Run completion time | ISO 8601 |
| `model` | Resolved from `team.json` or `orchestrator.json` default | Falls back to resolved `model` variable when Claude's JSON output omits the field |
| `tokens_input` | Claude JSON output (`usage.input_tokens`) | Per-run, not cumulative |
| `tokens_output` | Claude JSON output (`usage.output_tokens`) | Per-run, not cumulative |
| `edits_made` | Extracted from session JSONL | Count of Edit/Write tool calls found |
| `session_id` | Claude session JSONL filename | Used by `find_session_for_audit()` to locate the JSONL |
| `status` | `"completed"` or `"failed"` | Failed = validation found failure indicators |

#### Session JSONL Fallback

When `claude -p --output-format json` returns an empty `result` (agent ended on a tool call rather than text), the audit system falls back to JSONL extraction:

1. `find_session_for_audit()` locates the most recent JSONL at `~/.claude/projects/<project-dir>/`
2. `_extract_edits_from_session()` parses the JSONL for `tool_use` entries with name `Edit` or `Write`
3. Any `assistant` text messages are also extracted as the synthetic report body
4. The audit record notes `"source": "jsonl_fallback"` when this path is taken

This ensures audit completeness even for sessions that terminate abnormally.

### Card State Rendering

Feedback cards render different UI based on the linked task's state:

| State | Card Renders |
|-------|-------------|
| `implemented` OR `taskStatus === "completed"` | Grayed out, strikethrough title, "IMPLEMENTED" chip, static severity chip |
| `taskId` + `taskStatus === "in_progress"` | Pulsing "Running" chip with spinner + agent name + "View Task" link |
| `taskId` + `taskStatus === "pending"` | "Queued" chip + agent name + "View Task" link |
| No task (default) | Severity dropdown + **Run** / **Queue** / **Add Context** / **Re-Evaluate** / Dismiss |

### Re-Evaluate Tags

After clicking Re-Evaluate, a colored tag appears in the card's meta row:

| Status | Tag | Tooltip Color | Meaning |
|--------|-----|--------------|---------|
| `missing` | Green "Missing" | Green box | Feature/fix is genuinely needed |
| `unnecessary` | Red "Un-Necessary" | Red box | Feature already exists or request invalid |
| `implemented` | Blue "Implemented" | Blue box | Has been built already |
| `partial` | Yellow "Partial" | Yellow box | Only partly addressed |

Tags persist across polling re-renders via `_feedbackEvaluations` memory map. The Re-Evaluate button pulses green while waiting for the AI response. Tags stay until Re-Evaluate is clicked again.

### UI Features

- **Summary cards**: Total, HIGH, MEDIUM, LOW, Implemented counts
- **Badge**: Tab badge shows total non-implemented feedback count (all severities), polled at configurable interval (default 10s)
- **Severity dropdown**: Per-card dropdown to reclassify between HIGH/MEDIUM/LOW (color-coded)
- **Auto-fix threshold**: Dropdown next to Refresh button — controls system-wide auto-fix level (Off/HIGH only/MEDIUM+/All). Individual options are color-coded (red/yellow/blue).
- **Polling settings** (gear button): Opens modal to configure poll interval (value + unit: seconds/minutes/hours/days) or switch to on-demand mode (manual Refresh only). Stored in `config/orchestrator.json` as `feedback_poll_interval` (seconds) and `feedback_poll_on_demand` (boolean). Minimum 5 seconds.
- **Filters**: Tool, Severity, Status (open/implemented/has-task)
- **Configurable polling** when feedback tab is active (default 10s, catches Running→Completed transitions)
- **Interaction guard**: Polling skips re-render when user has an open context textarea. Bypassed by explicit actions (Run, Queue, Save & Run, Refresh) via `force=true`.
- **Toast notifications**: "Agent launched for t-XXXXXXXX-NNN" on successful Run
- **Context box**: "Add Context" opens inline textarea. Draft text persists in `_feedbackContextDrafts` memory across cancels and re-renders. "Save & Run" saves context then launches fixer, card transitions to Running state. "Save Context" saves and collapses.
- **Evaluation persistence**: `_feedbackEvaluations` map re-applied after each polling refresh

## Standard Feedback-to-Fix Flow (Self-Healing)

### Automated Flow (Agent-First — Primary)

The feedback fixer agent handles steps 1-6 automatically when you click **Run**:

```
1. RUN    — Click "Run" in Feedback tab (or auto-executed for HIGH severity)
2. TASK   — Task created in registry with source: "feedback" + sourceRef.feedbackId
3. ROUTE  — Tool name resolved to source directory via _TOOL_DIR_MAP
4. FIX    — claude -p executes with implementation prompt (explore → plan → implement)
5. REPORT — Agent output saved to reports/<date>/task-{id}-feedback-fix.md
6. MARK   — On completion, feedback line auto-strikethrough + IMPLEMENTED in Feedback-*.md
```

Steps 4-6 happen automatically in a background thread. The Feedback tab polls every 10s and updates the card from "Running" → "IMPLEMENTED" in near-realtime.

**Remaining manual steps after agent completes:**
- **RESTART** — Restart the single affected service: `systemctl --user restart opai-{tool}` or `./scripts/opai-control.sh restart-one opai-{tool}`
- **NOTIFY** — Broadcast `system_update` via Supabase Realtime to open clients

> **CRITICAL SAFETY RULE**: Agents must NEVER run `opai-control.sh stop`, `opai-control.sh restart`, or mass `systemctl stop` commands. These are blocked in non-interactive shells. Always restart only the single service that was changed. Use `restart-one` or direct `systemctl --user restart opai-{tool}`.
- **LOG** — Append implementation record to `FEEDBACK-IMPROVEMENTS-LOG.md`

### Manual Flow (Fallback)

When the automated fixer can't fully resolve an item, or for changes requiring human judgment:

```
1. READ   — Check notes/Improvements/Feedback-{Tool}.md for new items
2. PLAN   — Assess the fix: backend already supports it? Frontend only? Both?
3. FIX    — Implement the change in the tool's source files
4. RESTART — Restart the affected service (systemctl --user restart opai-{tool})
5. NOTIFY — Broadcast a system_update via Supabase Realtime to all open clients
           curl -X POST "https://idorgloobxkmlnwnxbej.supabase.co/realtime/v1/api/broadcast" \
             -H "apikey: $SUPABASE_ANON_KEY" \
             -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
             -H "Content-Type: application/json" \
             -d '{"messages":[{"topic":"realtime:{channel}","event":"broadcast","payload":{"type":"broadcast","event":"system_update","payload":{"message":"..."}}}]}'
6. MARK   — Strike through the item in Feedback-{Tool}.md, mark as IMPLEMENTED
7. LOG    — Append implementation record to FEEDBACK-IMPROVEMENTS-LOG.md
```

Each tool with Supabase Realtime should listen for the `system_update` broadcast event and display a banner prompting users to refresh. This enables zero-downtime self-healing — fixes deploy and users are notified in real time.

### Feedback Loop Closure (Critical Missing Link — Now Automated)

Previously, when an agent completed a feedback-sourced task, the feedback item was **never** marked IMPLEMENTED — creating orphan items that looked actionable but had already been fixed.

Now, in `services.py:run_agent_task()` (line ~508) and `_run_feedback_fix()`, after a task with `source: "feedback"` completes:
1. Reads `sourceRef.feedbackId` from the task
2. Parses feedback files to find the matching item
3. Calls `_mark_feedback_implemented()` to add strikethrough + IMPLEMENTED marker

This closes the self-healing loop automatically — no manual step needed to mark feedback as done.

## Manual Operation

```bash
# Run feedback classifier manually
node tools/feedback-processor/index.js

# Run feedback actor (auto-task creation) manually
node tools/feedback-processor/feedback-actor.js

# Check queue
cat notes/Improvements/feedback-queue.json | jq '.items | length'

# View improvement log
cat notes/Improvements/FEEDBACK-IMPROVEMENTS-LOG.md

# Test feedback API
curl -s http://localhost:8080/api/feedback | python3 -m json.tool
```

## Dependencies

- **Portal** (`opai-portal`): Hosts the feedback submission API endpoint and serves the navbar
- **Engine scheduler** (`opai-engine/background/scheduler.py`): Triggers `feedback_process` (5 min) and `feedback_act` (15 min) on schedule
- **Engine** (`opai-engine`): Hosts the agent-first Feedback tab UI, feedback fixer agent, and action endpoints; reads/writes `Feedback-*.md` files
- **Claude CLI**: Used by processor for classification, wiki verification, and feedback fixer execution (`claude -p`)
- **work-companion** (`tools/work-companion/`): Used by feedback-actor for auto-routing tasks to agents/squads
- **Wiki files** (`Library/opai-wiki/`): Reference for duplicate detection
- **Task registry** (`tasks/registry.json`): Feedback actor creates tasks here; Task Control Panel cross-references; feedback loop closure writes IMPLEMENTED status back

## Cross-References

- [Engine Dashboard](opai-v2.md) — Feedback tab for browsing and acting on items
- [Engine scheduler](opai-v2.md) — Runs both `feedback_process` and `feedback_act` schedules
- [Services & systemd](services-systemd.md) — `opai-engine` service runs the actors
