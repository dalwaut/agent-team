# Telegram Bridge — OPAI Communication Hub

> **Status**: Phases 1-5 Complete (2026-03-02, v3.5 HITL buttons + escalation)
> **Port**: 8110
> **Path**: `tools/opai-telegram/`
> **Service**: `opai-telegram`
> **Bot**: `@OPAIAssistantBot`

---

## Overview

grammY-based Telegram bot serving as the primary OPAI communication channel. Webhook-driven, multi-user, multi-conversation with tiered memory, fast-path API routing for common queries, and Claude Code CLI for open-ended AI conversation.

**Key capabilities:**
- Multi-conversation isolation (per chat:topic:user sessions)
- Custom RBAC (owner/admin/member/viewer)
- Forum topic workspace scoping
- Fast-path intent routing (Team Hub, WordPress) — sub-second responses
- Claude CLI slow path for open-ended questions — fire-and-forget pattern
- Inline keyboard confirmation gates for destructive actions
- YouTube URL detection with transcript + action buttons
- Assistant mode: selective topic coordinator (OP trigger, work detection, canned quick replies)
- Multi-step Team Hub task creation with inline keyboards
- Morning briefing (8 AM) with visual bars, phone formatting, per-site WordPress
- Proactive service/WordPress health alerts (state-change only)
- Secure file delivery (/file command with directory whitelist + blocked patterns)
- Mini Apps: embedded web apps inside Telegram (WordPress Manager live)
- Mini App auth bridge: initData HMAC validation + tdesktop fallback + session tokens
- Mini App API proxy to internal services (WP, Team Hub)
- Job tracking with restart recovery
- Autonomous execution: `/danger` command + "Run Dangerously" inline button on plan-like responses (owner-only, confirmation gate, git backup option, audit trail)
- Worker approval gate: `/approve` command with inline approve/deny keyboards, HITL 5-button gate (Run/Approve/Dismiss/Reject/Picked up in GC) with 15-min escalation
- Claude usage monitoring: `/usage` with visual progress bars
- 2nd Brain access: `/brain` search, save, inbox, suggestions
- Task registry management: `/tasks` summary, list, complete, cancel
- AI log analysis: `/review` fire-and-forget Claude diagnostic

---

## Architecture

```
Telegram API (webhook POST)
    |
    v
Express server (port 8110)
    |
    v
grammY bot middleware chain
    +-- whitelist check (reject unknown users)
    +-- logging middleware
    |
    v
Handler Router (order matters)
    |
    +-- Commands (/start, /help, /wp, /hub, /topic, etc.)
    +-- Callback queries (inline keyboard buttons)
    +-- Free-text messages:
    |     0. Pending task input? -> multi-step creation flow
    |     1. Assistant mode ON? -> selective coordinator (own routing)
    |     2. YouTube URL? -> transcript + action buttons
    |     3. Team Hub intent? -> direct API (sub-second)
    |     4. WordPress intent? -> direct API (sub-second)
    |     5. Claude CLI (fire-and-forget background processing)
    |
    v
Response Router
    +-- Edit ack message with result
    +-- Chunk if > 4,096 chars
    +-- Markdown with plain-text fallback
```

### Webhook Flow

```
Telegram -> opai.boutabyte.com/telegram/webhook
                |
          BB VPS Caddy (reverse proxy via Tailscale)
                |
          OPAI Server Caddy
                |
          localhost:8110 (Express)
                |
          POST /telegram/webhook -> grammY webhookCallback
```

**Critical design**: The webhook handler must respond quickly (grammY has a 10-second timeout). Claude CLI takes 10-60+ seconds. Solution: fire-and-forget pattern — send acknowledgment message, return from middleware immediately, process Claude in background using `bot.api` (not `ctx`).

---

## File Structure

```
tools/opai-telegram/
  index.js                  # Entrypoint: bot setup, middleware, Express server, Mini App routes
  set-webhook.js            # One-time: register webhook + bot commands with BotFather
  access-control.js         # Custom RBAC: roles, whitelist, workspace scoping, assistant mode
  assistant-mode.js         # Selective topic coordinator: classifier, canned responses, coordinator Claude
  conversation-state.js     # Tiered memory: 5-state machine, ring buffer, digests
  claude-handler.js         # Claude CLI invocation, prompt building, session resume, dangerous mode
  alerts.js                 # Proactive alerts: service health, WordPress, morning briefing
  file-sender.js            # Secure file delivery: whitelisted directories, blocked patterns
  job-manager.js            # Async job tracking, restart recovery
  engine-api.js             # Shared HTTP helpers for Engine (8080) and Brain (8101) APIs
  teamhub-fast.js           # Direct Team Hub API for instant task/note/idea queries
  wordpress-fast.js         # Direct WordPress API for site management
  mini-app-auth.js          # Mini App auth: initData HMAC validation, session tokens, middleware
  mini-app-proxy.js         # Mini App API proxy to internal services (WP, Team Hub)
  .env                      # Configuration (bot token, webhook, ports, keys)
  package.json              # Dependencies
  handlers/
    commands.js             # All slash commands (27+), /apps Mini App launcher
    messages.js             # Free-text routing: pending tasks, YouTube, fast paths, Claude
    callbacks.js            # Inline keyboard handlers: confirm, YouTube, WordPress, email, hub tasks, danger runs, approvals, HITL
    utils.js                # logAudit(), logDangerousRun() helpers
  mini-apps/
    wordpress.html          # WordPress Manager SPA (site list, detail, updates, backups)
  data/
    roles.json              # Persisted user roles + topic-workspace bindings
    persona.json            # Active bot personality
    scopes/                 # Per-conversation state files (ring buffers, sessions, digests)
    danger-audit.json       # Audit log for dangerous runs (last 200 entries)
    jobs/
      active-jobs.json      # Job tracker (running, completed, failed, interrupted)
```

### Dependencies

```json
{
  "grammy": "^1.35.0",
  "@grammyjs/auto-retry": "^2.0.0",
  "@grammyjs/runner": "^2.0.0",
  "express": "^4.21.0",
  "dotenv": "^16.4.0"
}
```

---

## Configuration (.env)

| Key | Example | Purpose |
|-----|---------|---------|
| `TELEGRAM_BOT_TOKEN` | `8589704285:AAG...` | Bot token from @BotFather |
| `WEBHOOK_SECRET` | hex string | Webhook signature validation |
| `WEBHOOK_URL` | `https://opai.boutabyte.com/telegram/webhook` | Full webhook endpoint |
| `PORT` | `8110` | Express server port |
| `OPAI_ROOT` | `/workspace/synced/opai` | Workspace root |
| `CLAUDE_TIMEOUT` | `300000` | Claude CLI timeout (ms, default 5 min) |
| `OWNER_USER_ID` | `1666403499` | Auto-owner role (Dallas) |
| `ADMIN_GROUP_ID` | `-5111777503` | WautersEdge supergroup |
| `ALERT_THREAD_ID` | (numeric) | Forum topic for alerts/briefings (optional — defaults to General if unset). Use `/topicid` in the target topic to get the ID. |
| `SUPABASE_SERVICE_KEY` | `eyJ...` | For WordPress API auth |

---

## Access Control (access-control.js)

### Four-Tier RBAC

| Role | Admin | Approve | Chat | ViewLogs | ManageRoles | ManageTopics |
|------|-------|---------|------|----------|-------------|-------------|
| `owner` | Y | Y | Y | Y | Y | Y |
| `admin` | Y | Y | Y | Y | N | Y |
| `member` | N | N | Y | N | N | N |
| `viewer` | N | N | N | Y | N | N |

**Owner privilege**: `OWNER_USER_ID` from env gets automatic `owner` role with no DB entry needed.

### Workspace Scoping

Forum topics can be bound to Team Hub workspaces via `/topic bind <wsId> [name]`. When a topic is bound:
- Members with workspace access can chat in that topic
- Claude prompts prioritize Team Hub context
- Fast-path queries scope to that workspace

### Key Functions

```javascript
getUserRole(userId)                           // -> 'owner'|'admin'|'member'|'viewer'|null
hasPermission(userId, permission)             // -> boolean
isWhitelisted(userId)                         // -> boolean
setUserRole(userId, role, { workspaces, name })
hasWorkspaceAccess(userId, workspaceId)       // -> boolean
setTopicScope(chatId, threadId, wsId, wsName) // Bind topic to workspace
getTopicScope(chatId, threadId)               // -> { workspaceId, workspaceName }
getAssistantMode(chatId, threadId)            // -> boolean
setAssistantMode(chatId, threadId, enabled)   // Toggle assistant mode for topic
```

**Storage**: `data/roles.json`

---

## Conversation State (conversation-state.js)

### 5-State Time Machine

Each conversation scope transitions through states based on idle time:

```
NEW --> ACTIVE (<5min) --> IDLE (5min-2hr) --> COLD (2hr-7d) --> EXPIRED (7d+)
```

| State | Context Injected | --resume | Token Cost |
|-------|-----------------|----------|------------|
| **NEW** | Nothing | No (fresh) | 0 |
| **ACTIVE** | Nothing (Claude has it) | Yes | 0 |
| **IDLE** | Last 3 messages (thin recap) | Yes | ~100-200 |
| **COLD** | Digest summary + last exchange | Yes | ~200-400 |
| **EXPIRED** | Digest only | No (fresh) | ~200-400 |

**Key insight**: During ACTIVE bursts (the most common case), zero context tokens are wasted.

### Scope Key Format

```
{chatId}:{threadId|'general'}:{userId}
```

- Private DMs: `userId:general:userId`
- Group chat: `groupId:general:userId`
- Forum topic: `groupId:topicId:userId`

### Ring Buffer + Digest

- Stores max 10 recent messages per scope
- Auto-generates digest when messages roll off the buffer
- Digest = topic-starting questions + first sentences of bot responses
- Generated locally (no AI calls)

### API

```javascript
getContextStrategy(scopeKey)    // -> { contextBlock, useResume, sessionId, state }
recordMessage(scopeKey, role, username, content)
updateSessionId(scopeKey, id)
clearScope(scopeKey)
getScopeData(scopeKey)          // -> { state, messageCount, lastActivity, ... }
setScopeTopic(scopeKey, topic)  // Name the conversation
listActiveScopes()              // -> [{ scopeKey, state, messageCount, ... }]
buildScopeKey(chatId, threadId, userId)
```

**Storage**: `data/scopes/{chatId}-{threadId}-{userId}.json`

---

## Claude CLI Handler (claude-handler.js)

### Invocation

```javascript
spawn(CLAUDE_BIN, [
  '-p',
  '--output-format', 'json',
  '--permission-mode', 'acceptEdits',
  ...(useResume && sessionId ? ['--resume', sessionId] : []),
], { cwd: OPAI_ROOT, env: cleanEnv })
```

- Writes prompt to temp file, pipes to stdin
- Parses JSON response: `{ result, session_id, is_error }`
- Updates conversation state with new `session_id`
- Removes `CLAUDECODE` env var to prevent nested detection

### Dangerous Mode (askClaudeDangerous)

Autonomous execution with full permissions — no human gate, no tool restrictions:

```javascript
spawn(CLAUDE_BIN, [
  '-p',
  '--output-format', 'json',
  '--dangerously-skip-permissions',
  ...(useResume && sessionId ? ['--resume', sessionId] : []),
], { cwd: OPAI_ROOT, env: cleanEnv, timeout: 600000 })
```

- 10-minute timeout (vs 5 min for normal)
- No `--permission-mode` or `--tools` flags — full access to Bash, file ops, MCP
- Wraps instruction in an autonomous execution prompt with guidelines:
  - Execute completely, don't ask for clarification
  - Try to fix errors and continue
  - No git push/branch delete/destructive git ops unless explicitly instructed
  - Report results as concise summary
- Accepts `conversationContext` (recent chat history) for background on the task
- Returns same `{ text, sessionId }` shape as `askClaude()`
- Owner-only (enforced at command/callback level, not in this module)

### Prompt Building (buildPrompt)

4-path logic based on role and workspace context:

| Scenario | Primary Context | Secondary |
|----------|----------------|-----------|
| Admin + workspace topic | Team Hub (workspace) | Full OPAI system |
| Admin + DM/unbound | Full OPAI system | - |
| Member + workspace topic | Team Hub only | - |
| Member + DM | Team Hub (general) | - |

---

## Fast Paths (Sub-Second Responses)

### Team Hub Fast Path (teamhub-fast.js)

Bypasses Claude CLI for common workspace queries via direct HTTP to Team Hub API (`http://127.0.0.1:8089/api/internal/*`).

**Detected intents:**

| Pattern | Intent | API Call |
|---------|--------|---------|
| "latest tasks", "my tasks", "show tasks" | `latest_tasks` | `list-items?workspace_id=X&limit=30` (filter type=task, show 5) |
| "todos", "to-do" | `todos` | `list-items?status=open,todo,in_progress&limit=10` |
| "overdue" | `overdue` | `list-items` (filter by due_date < now) |
| "latest notes", "my notes" | `latest_notes` | `list-items` (filter type=note) |
| "latest ideas" | `latest_ideas` | `list-items` (filter type=idea) |
| "status", "overview", "what's happening" | `overview` | `list-items` (grouped summary) |
| "search X", "find X" | `search` | `search-items?q=X` |

**Workspace resolution**: Uses bound workspace from topic, falls back to default "Dallas's Space" (`80753c5a-beb5-498c-8d71-393a0342af27`). Workspace cache refreshed every 5 minutes.

### WordPress Fast Path (wordpress-fast.js)

Direct calls to OP WordPress API (`http://127.0.0.1:8096/api`) with Supabase service key auth.

**Free-text intent detection:**

| Pattern | Intent |
|---------|--------|
| "site status", "website health" | `wp_sites` |
| "pending updates", "plugin updates" | `wp_updates_all` |
| "backup list", "show backups" | `wp_backups` |

**`/wp` command (admin-only):**

| Subcommand | Action |
|------------|--------|
| `/wp sites` | List connected sites with status |
| `/wp status <site>` | Detailed site info + pending updates |
| `/wp updates` | Update summary across all sites |
| `/wp updates <site>` | Updates for specific site |
| `/wp update <site>` | Apply all updates (inline keyboard confirmation) |
| `/wp backup <site>` | Create backup (full/database options via keyboard) |
| `/wp backups <site>` | List backups |
| `/wp posts <site>` | Recent posts |
| `/wp plugins <site>` | Active/inactive plugin list |
| `/wp logs <site>` | Recent execution logs |

Site names support partial matching (e.g., "wauters" matches "WautersEdge").

---

## Message Handler Flow (handlers/messages.js)

```
User sends text message (not a / command)
    |
    v
0. Pending task creation? -> handlePendingTaskInput() -> consume input -> return
    |  (title, description, or custom due date step)
    |
    v
1. Resolve workspace from topic binding (if in forum topic)
    |
    v
1b. Assistant mode ON for this topic? -> handleAssistantMessage() -> return
    |  (own 5-tier classification + routing, see Assistant Mode section)
    |
    v
2. YouTube URL detected? -> handleYouTubeUrl() (transcript + buttons) -> return
    |
    v
3. Resolve workspace ID from topic binding (for fast-path scoping)
    |
    v
4. Team Hub intent detected? -> handleIntent() -> instant reply -> return
    |  (falls through to Claude if API returns null)
    |
    v
5. WordPress intent detected? -> handleWpIntent() -> instant reply -> return
    |  (falls through to Claude if API returns null)
    |
    v
6. Claude slow path:
   a. getContextStrategy(scopeKey) -> state, contextBlock, useResume, sessionId
   b. recordMessage()
   c. Send ack message (content-aware: "Checking tasks...", "Hey there...", etc.)
   d. Fire-and-forget: processClaude(bot, {...}) -> runs in background
   e. Return immediately (webhook responds)
```

### processClaude() — Background Processor

```
1. Create job (job-manager)
2. Start progress interval (every 15s):
   - "Working on it..."
   - "Still working... (30s)"
   - "Deeper analysis in progress... (45s)"
   - "This one's taking a bit... (75s)"
   - "Almost there... (105s)"
3. Build prompt via buildPrompt()
4. Call askClaude({ prompt, scopeKey, useResume, sessionId })
5. Clear progress interval
6. Record bot response in ring buffer
7. Split message into chunks (4096 char limit)
8. Edit ack message with first chunk
9. Send remaining chunks as new messages
```

Uses `bot.api` (not `ctx`) because `ctx` is gone after the webhook returns.

### Plan Detection + "Run Dangerously" Button

After Claude responds, `processClaude()` checks if the response looks like a plan/proposal using a 4-signal heuristic:

| Signal | Criteria |
|--------|----------|
| Numbered list | 3+ items matching `^\s*\d+[.\)]` |
| Plan keywords | "here's a plan", "I'll need to", "steps:", "implementation:", etc. |
| File paths | 2+ path segments with optional extension (`/foo/bar.js`) |
| Structured content | >1000 chars with code blocks or bullet lists |

Must match **at least 2** signals and be **>500 chars**. When detected AND the user is the owner AND the response fits in a single message chunk, a "Run Dangerously" inline button is appended:

```
[Run Dangerously]  (callback: danger:run:{chatId}:{msgId})
```

The full Claude response is cached in `dangerResponseCache` Map (30-min TTL) keyed by `chatId:msgId` so the callback handler can retrieve it later.

---

## Assistant Mode (assistant-mode.js)

An admin toggle (`/topic assistant on`) that transforms the bot from "respond to everything" into a **selective project coordinator** for workspace-bound forum topics.

### Activation

```
/topic bind <wsId> [name]     # Must bind workspace first
/topic assistant on            # Enable selective mode
/topic assistant off           # Back to full-response mode
/topic assistant reset         # Clear shared assistant buffer
/topic assistant               # Show current status
```

### Message Classification (5-Tier, Regex-Only)

| Tier | Trigger | Bot Action |
|------|---------|------------|
| `op` | `OP ...`, `hey op`, `yo op`, or @bot mention | Full response (fast-path then Claude) |
| `work` | Work keywords (task, deadline, blocker, sprint, etc.) | Full response (fast-path then Claude) |
| `quick` | Greetings, thanks, farewells | Instant canned response (random pick) |
| `unsure` | Short (<4 words) with `?`, no work keywords | Nudge response (rate-limited: 1/user/5min) |
| `silent` | Everything else | No response (absorbed into buffer) |

**OP trigger**: Start-of-message only (`/^OP[\s,:!]/i`) — avoids false positives on words like "OPTION", "OPERATOR".

**Work keywords**: `task|deadline|status|update|blocker|sprint|overdue|milestone|progress|assign|priority|due|blocked|standup|backlog|release|deploy|bug|issue|ticket|done|complete|in.progress|review|merge|ship|estimate|roadmap|goal|action.item|follow.up|sync`

### Routing Flow

```
User message in assistant-mode topic
    |
    v
Record to shared buffer (chatId:threadId:assistant) AND per-user buffer
    |
    v
Classify message -> tier
    |
    +-- op/work:
    |     1. Strip "OP" prefix if present
    |     2. Try Team Hub fast-path (detectIntent -> handleIntent)
    |     3. If fast-path returns null -> Claude fire-and-forget
    |        (coordinator persona prompt, NOT admin prompt)
    |
    +-- quick:
    |     -> Random canned response (greeting/thanks/farewell)
    |
    +-- unsure:
    |     -> Nudge "Say OP if you need me!" (rate-limited)
    |
    +-- silent:
          -> No response (message recorded to buffers only)
```

### Coordinator Prompt

When Claude is invoked in assistant mode, it uses a **coordinator persona** (not admin):
- Friendly project coordinator, addresses people by name
- Knows the bound workspace's tasks/notes/ideas via Team Hub API
- Keeps responses under 3000 chars
- Shared conversation history from the topic buffer (all users visible)

### Shared Buffer

Scope key: `chatId:threadId:assistant` (all users in the topic share one conversation context). Per-user buffers are also maintained so context survives if assistant mode is turned off.

### Log Prefix

`[TG] [ASST]` — assistant mode operations, `[TG] [ASST] [FAST]` — assistant fast-path hits.

---

## Job Manager (job-manager.js)

Tracks async Claude CLI executions with restart recovery.

**Job lifecycle:** `running` -> `completed` | `failed` | `interrupted`

```javascript
createJob({ chatId, threadId, messageId, userId, query }) // -> jobId
completeJob(jobId)
failJob(jobId, errorMessage)
getActiveJobs()     // -> running jobs array
recoverJobs()       // Marks running -> interrupted, returns them
```

**Restart recovery**: On startup, any `running` jobs are marked `interrupted`. The bot sends a notification to the correct forum topic (using stored `threadId`): "Job interrupted by restart: '...' — please resend your request."

**Retention**: Completed/failed/interrupted jobs kept for 1 hour, then pruned.

**Storage**: `data/jobs/active-jobs.json`

---

## Proactive Alerts (alerts.js)

Three alert sources run on independent intervals. All alerts go to `ADMIN_GROUP_ID`. When `ALERT_THREAD_ID` is set in `.env`, alerts route to that specific forum topic instead of General — keeps status noise out of the main conversation.

### Alert Types

| Source | Interval | Trigger |
|--------|----------|---------|
| Service Health | 5 min | State-change only (healthy↔unreachable) |
| WordPress Health | 10 min | State-change only (healthy↔degraded↔offline) |
| Morning Briefing | 1 min check | Once daily at 8 AM local time |

**Design**: Service/WordPress alerts are **state-change detectors**, not periodic reports. They only fire when a service transitions between states (e.g., healthy → unreachable, offline → recovered). No hourly deadline alerts — task deadlines are exclusively in the morning briefing.

### Restart-Safe Briefing

On service restart, if `hour >= BRIEFING_HOUR` (8 AM), `lastBriefingDate` is pre-set to today so the briefing isn't re-sent mid-day. Only a fresh start before 8 AM will queue the briefing.

### Morning Briefing Format

Phone-optimized visual format with 4 sections:

```
☀️ Morning Briefing
Feb 26, 2026
━━━━━━━━━━━━━━━━━━

🖥 Services  ✅ All 10 healthy

━━━━━━━━━━━━━━━━━━

🌐 WordPress
  🟢 WautersEdge
     └ 📦 3 plugin updates
  ✅ BoutaByte

━━━━━━━━━━━━━━━━━━

📋 Tasks  12 open

🔴 Overdue (2)
  ⏰ Fix login bug on portal…
       Feb 12 · 14d late
  ⏰ Deploy staging build…
       Feb 20 · 6d late

🟡 Due Today (1)
  📌 Review PR #42

🔵 This Week (3)
  📅 Update wiki docs
       Feb 28

━━━━━━━━━━━━━━━━━━

⚙️ System
🟢 CPU    12%  ▰▱▱▱▱▱▱▱▱▱
🟢 Mem    45%  ▰▰▰▰▱▱▱▱▱▱
       7.2 / 15.6 GB
🟡 Disk   72%  ▰▰▰▰▰▰▰▱▱▱
       350G / 490G

📊 Load  0.42 0.38 0.35
⏱ Up 12 days, 3 hours
```

**Helpers**: `bar(pct)` → `▰▱` progress bar, `lvlIcon(pct)` → 🟢/🟡/🔴 at <60%/60-85%/85%+, `trunc(str, len)` → phone-width truncation, `fmtDate(iso)` → `Feb 12` format, `daysAgo(iso)` → integer days overdue.

**Blank section prevention**: Separator bars (`━━━`) only render when the section has content. If a service API is unreachable, the section is silently omitted.

### Key Functions

```javascript
startAlerts(bot, chatId, alertThreadId)  // Initialize alert system
stopAlerts()                              // Clear all timers
generateBriefing()                        // -> formatted briefing string (also used by /briefing command)
checkServiceHealth()                      // Poll engine /health/summary
checkWordPressHealth()                    // Poll WP API /api/sites
```

---

## Team Hub Task Creation (callbacks.js)

### Multi-Step Flow

`/hub task [title]` triggers an interactive task creation flow with inline keyboards:

```
/hub task Fix the login page
    |
    v
1. Priority picker (inline keyboard)
   [🔴 Critical] [🟠 High]
   [🟡 Medium]   [🟢 Low]
   [Cancel]
    |
    v
2. Due date picker (inline keyboard)
   [Today]      [Tomorrow]
   [This Friday] [Next Week]
   [Custom Date] [No Due Date]
   [Cancel]
    |  (Custom -> free-text input with flexible parsing)
    |
    v
3. Description prompt
   Type description text or [No Description] [Cancel]
    |
    v
4. Confirmation summary
   [Create Task] [Cancel]
    |
    v
5. POST to Team Hub /api/internal/create-item
```

If no title is given (`/hub task`), the flow starts at step 0 (free-text title input).

### State Management

- **`pendingTasks` Map**: Keyed by `{chatId}:{userId}`, stores current step + collected fields
- **10-minute auto-expiry**: Stale flows are cleaned up
- **Text intercept**: `handlePendingTaskInput()` is checked before all other message handlers — consumes user text for title, description, and custom date steps

### Flexible Date Parser

`parseFlexDate(input)` handles:
- ISO format: `2026-03-15`
- Month + day: `Mar 15`, `March 15`
- Day + month: `15 Mar`
- Relative: `today`, `tomorrow`, `in 3 days`, `in 2 weeks`
- Named: `next monday`, `next friday`

Returns `YYYY-MM-DD` string or `null` if unparseable.

### API Integration

Tasks are created via Team Hub internal API: `POST /api/internal/create-item?workspace_id=X&user_id=X&type=task&title=X&priority=X&...`

| Constant | Value |
|----------|-------|
| `OWNER_SUPABASE_ID` | `1c93c5fe-d304-40f2-9169-765d0d2b7638` (Dallas) |
| `DEFAULT_WORKSPACE_ID` | `80753c5a-beb5-498c-8d71-393a0342af27` (Dallas's Space) |
| `HUB_BASE` | `http://127.0.0.1:8089/api/internal` |

### Callback Data

| Callback | Purpose |
|----------|---------|
| `hub:pri:{priority}` | Priority selection (critical/high/medium/low) |
| `hub:due:{choice}` | Due date (today/tmrw/fri/nxtw/custom/skip) |
| `hub:desc:skip` | Skip description |
| `hub:create` | Submit task to Team Hub |
| `hub:cancel` | Cancel flow |

---

## File Sender (file-sender.js)

Secure file delivery via Telegram with directory whitelist and blocked patterns.

**Allowed directories** (relative to OPAI_ROOT): `reports/latest`, `reports/HITL`, `notes/Improvements`, `notes/Posts`, `notes/YouTube`, `Library/opai-wiki`, `Templates`, `tasks`

**Blocked patterns**: `.env`, `.key`, `.pem`, `credential`, `secret`, `password`, `token`, `.ssh`, `vault.key`, `node_modules`, `.git`

**Safe extensions**: `.md`, `.txt`, `.json`, `.csv`, `.log`, `.html`, `.css`, `.js`, `.ts`, `.py`, `.sh`, `.yaml`, `.yml`, `.xml`, `.sql`, `.toml`, `.cfg`, `.ini`, `.pdf`, `.png`, `.jpg`

**Commands** (`/file`): `reports`, `report <name>`, `logs <service>`, `notes`, `note <path>`, `wiki`, `wiki <name>`, `tasks`, `get <path>`

Log files are generated via `journalctl` to a temp file with `cleanup: true` flag (auto-deleted after send). 50 MB Telegram file size limit.

---

## Mini App Infrastructure (Phase 4)

### Overview

Telegram Mini Apps are HTML/CSS/JS web apps embedded inside Telegram chat, using `telegram-web-app.js` for identity and theming. OPAI Mini Apps are served at `/telegram/mini-apps/` and authenticated via a self-contained auth bridge.

### Architecture

```
User taps web_app button (private chat only)
    |
    v
Telegram opens WebView with initData injection
    |
    v
Mini App HTML (served from /telegram/mini-apps/*.html)
    |
    v
POST /telegram/auth { initData | initDataUnsafe }
    |
    v
mini-app-auth.js
    +-- Validate HMAC-SHA256 signature (or fallback for tdesktop)
    +-- Map Telegram user -> OPAI role (access-control.js)
    +-- Issue session token (1h TTL, process-scoped secret)
    |
    v
Mini App makes API calls with Bearer token
    |
    v
mini-app-proxy.js
    +-- requireMiniAppAuth middleware (validates session)
    +-- requireAdmin middleware (for WP routes)
    +-- Strip /telegram/api/{backend}/ prefix
    +-- Forward to internal service with service-level auth
```

### Auth Flow (mini-app-auth.js)

**Primary path** (mobile, web): Telegram injects `initData` signed with bot token. Server validates HMAC-SHA256:
1. Parse `initData` as URLSearchParams, extract `hash`
2. Sort remaining params alphabetically, join with `\n`
3. `secretKey = HMAC-SHA256("WebAppData", botToken)`
4. `expected = HMAC-SHA256(secretKey, dataCheckString)`
5. Compare `hash === expected`
6. Check `auth_date` freshness (reject if >5 min old)

**Fallback path** (tdesktop): Telegram Desktop often sends empty `initData` but populates `initDataUnsafe` with user info. The server accepts this without signature verification — trust is based on the OPAI whitelist check + the proxy being localhost-only. Logged with `method: unsafe-fallback`.

**Session tokens**: `base64url(JSON payload) + "." + HMAC-SHA256(payload, SESSION_SECRET)`. Payload: `{ telegramId, role, name, iat, exp }`. `SESSION_SECRET` is random per process (tokens invalidate on restart). Stored in-memory Map with 10-minute cleanup cycle.

### API Proxy (mini-app-proxy.js)

Routes authenticated Mini App requests to internal OPAI services:

| Mini App Path | Backend | Auth Added |
|---------------|---------|------------|
| `/telegram/api/wp/*` | `127.0.0.1:8096/api/*` | Supabase service key (Bearer) |
| `/telegram/api/hub/*` | `127.0.0.1:8089/api/internal/*` | None (localhost) |

WordPress routes require admin role. Team Hub routes require any authenticated user.

The proxy forwards request body (POST/PUT/PATCH), pipes response back, handles errors (502 for backend unavailable, 504 for timeout).

### Express Routes (index.js)

```javascript
app.post('/telegram/auth', createAuthHandler(BOT_TOKEN));

const proxy = createProxyHandler();
app.get('/telegram/api/wp/*', requireMiniAppAuth, requireAdmin, proxy);
app.post('/telegram/api/wp/*', requireMiniAppAuth, requireAdmin, proxy);
app.get('/telegram/api/hub/*', requireMiniAppAuth, proxy);
app.post('/telegram/api/hub/*', requireMiniAppAuth, proxy);

app.use('/telegram/mini-apps', express.static('mini-apps/'));
```

### WordPress Mini App (mini-apps/wordpress.html)

Single-page app (~480 lines) embedded in Telegram WebView.

**Features:**
- Site list view: cards with status dots (green/amber/red), WP version, theme, update badge
- Site detail view: info grid (status, WP/PHP version, theme, plugins, updates), action buttons
- Apply All Updates: MainButton with progress indicator, sends `tg.sendData()` result to chat
- Create Backup: Full backup trigger with progress toast
- Telegram theme integration: CSS variables (`--tg-theme-bg-color`, `--tg-theme-text-color`, etc.)
- BackButton navigation (detail → list)
- XSS-safe: all user data escaped via `esc()` helper (DOM textContent)

**Auth handling:**
```javascript
// Sends initData (signed) or initDataUnsafe (tdesktop fallback)
if (tg.initData) payload.initData = tg.initData;
else if (tg.initDataUnsafe?.user) payload.initDataUnsafe = tg.initDataUnsafe;
```

### /apps Command

Launches Mini Apps. Due to Telegram limitations, `web_app` keyboard buttons only work in private chats:
- **Private chat**: Sends `ReplyKeyboardMarkup` with `web_app` URL buttons
- **Group/supergroup**: Sends inline button linking to `https://t.me/{bot}?start=apps` (deep link to DM)
- `/start apps` deep link handler shows the Mini App keyboard in DM

### Key Functions

```javascript
// mini-app-auth.js
validateInitData(initData, botToken)    // -> { valid, user?, error? }
createSession(telegramId, role, name)   // -> token string
validateSession(token)                  // -> { valid, session?, error? }
requireMiniAppAuth(req, res, next)      // Express middleware
requireAdmin(req, res, next)            // Express middleware
createAuthHandler(botToken)             // -> Express route handler

// mini-app-proxy.js
createProxyHandler()                    // -> Express route handler
```

### Log Prefix

`[TG] [AUTH]` — authentication events (session created, rejected, fallback used)
`[TG] [PROXY]` — proxy errors (backend unavailable, timeout)

---

## Inline Keyboards (handlers/callbacks.js)

### Confirmation Gates

Destructive actions go through a confirm/cancel flow:
```
Action request -> inline keyboard [Confirm] [Cancel]
  -> confirm:actionId -> execute
  -> cancel:actionId -> dismiss
```

Pending actions auto-expire after 5 minutes.

### YouTube Actions

When a YouTube URL is detected, the bot fetches the transcript and shows:
```
*Video Title*

[summary text...]

[Save to Notes] [Research] [Rewrite] [PRD Idea]
```

| Button | Callback | Action |
|--------|----------|--------|
| Save to Notes | `yt:save:{videoId}` | Saves to `notes/YouTube/YYYY-MM-DD - Title.md` |
| Research | `yt:research:{videoId}` | Claude deep analysis |
| Rewrite | `yt:rewrite:{videoId}` | Claude article rewrite |
| PRD Idea | `yt:prd:{videoId}` | Claude PRD extraction |

Video cache: 1 hour TTL (in-memory Map).

### WordPress Actions

| Button | Callback | Action |
|--------|----------|--------|
| Yes, update all | `wp:update-all:{siteId}` | POST `/sites/{id}/updates/all` |
| Full backup | `wp:backup:{siteId}:full` | POST `/sites/{id}/backups` |
| Database only | `wp:backup:{siteId}:database` | POST `/sites/{id}/backups` |
| Cancel | `wp:cancel:{siteId}` | Dismiss |

WordPress callbacks are admin-only.

### Email Actions

| Button | Callback | Action |
|--------|----------|--------|
| Approve | `email:approve:{id}` | Send draft |
| Reject | `email:reject:{id}` | Reject draft |

### Dangerous Run Actions

Owner-only autonomous execution flow with confirmation gate and optional git backup:

```
/danger <instruction>  OR  click "Run Dangerously" button
    |
    v
Confirmation Gate (inline keyboard):
  [Backup First]        <- git add -A, commit, push, then show confirm/cancel
  [Confirm]  [Cancel]
    |
    v
danger:confirm -> executeDangerousRun() (background, 10-min timeout)
    |
    v
Progress messages every 15s ("Autonomous execution in progress...", etc.)
    |
    v
Result: "DANGEROUS RUN COMPLETE" header + summary
```

| Button | Callback | Action |
|--------|----------|--------|
| Backup First | `danger:backup:{actionId}` | `git add -A && git commit && git push`, then show confirm/cancel |
| Confirm | `danger:confirm:{actionId}` | Fire `askClaudeDangerous()` in background |
| Cancel | `danger:cancel:{actionId}` | Dismiss |
| Run Dangerously | `danger:run:{cacheKey}` | Pull cached Claude response, show confirmation gate |

**`danger:backup` flow:**
1. `git status --porcelain` — check for uncommitted changes
2. If changes: `git add -A`, `git commit -m "chore: pre-danger backup (timestamp)"`, `git push`
3. If no changes: just `git push` (push any unpushed commits)
4. On success: show backup summary (files changed, commit hash), then send confirm/cancel gate
5. On failure: warn about failure, still offer "Confirm Anyway" / "Cancel"

**Pending actions**: `pendingDangerRuns` Map with 5-minute expiry. Stores: `instruction`, `conversationContext`, `scopeKey`, `chatId`, `threadId`, `userId`, `username`.

**Audit**: Every dangerous run is logged to `data/danger-audit.json` via `logDangerousRun()` — timestamp, userId, username, instruction, outcome, duration, error. Keeps last 200 entries.

### Team Hub Task Creation

See [Team Hub Task Creation](#team-hub-task-creation-callbacksjs) section above for the full multi-step flow with `hub:pri:*`, `hub:due:*`, `hub:desc:skip`, `hub:create`, `hub:cancel` callbacks.

---

## Commands Reference (handlers/commands.js)

### General

| Command | Access | Description |
|---------|--------|-------------|
| `/start` | All | Welcome message (role-aware) |
| `/help` | All | Command reference (role-filtered) |
| `/status` | All | Active Claude jobs |
| `/sessions` | All | List active conversation scopes |
| `/label <text>` | All | Name current conversation |
| `/reset` | All | Clear conversation context |
| `/config` | Admin | Chat configuration details |

### System (Admin)

| Command | Access | Description |
|---------|--------|-------------|
| `/services` | Admin | systemd service statuses (13 services) |
| `/health` | Admin | CPU, memory, disk, load, uptime |
| `/logs <service>` | Admin | Last 30 journal lines (vault, brain, oc, browser aliases added) |

### Work

| Command | Access | Description |
|---------|--------|-------------|
| `/task <text>` | Admin | Create task in `tasks/queue.json` |
| `/email check` | Admin | Trigger inbox check |
| `/email tasks` | Admin | Pending email-extracted tasks |
| `/email drafts` | Admin | Pending response drafts |
| `/email approve <id>` | Admin | Send approved draft |
| `/email reject <id>` | Admin | Reject draft |
| `/hub status` | All | Workspace overview |
| `/hub task [text]` | All | Multi-step task creation (priority, due date, description) |
| `/hub note <text>` | All | Add Team Hub note (via internal API) |
| `/hub idea <text>` | All | Log Team Hub idea (via internal API) |
| `/hub search <q>` | All | Search workspace |
| `/wp` | Admin | WordPress site management (see Fast Paths) |
| `/briefing` | Admin | On-demand morning briefing (services, sites, tasks, system) |
| `/file <sub>` | Admin | File manager (reports, logs, notes, wiki, tasks) |
| `/apps` | Admin | Launch Mini Apps (WordPress Manager; DM-only web_app buttons) |

### Autonomous (Owner)

| Command | Access | Description |
|---------|--------|-------------|
| `/danger <instruction>` | Owner | Execute instruction autonomously with full permissions |
| `/danger` | Owner | Execute last discussed plan from conversation context |

Both flows show a confirmation gate with **Backup First** (git commit+push) / **Confirm** / **Cancel** buttons before executing.

### Approvals (Admin)

| Command | Access | Description |
|---------|--------|-------------|
| `/approve` | Admin | List pending worker approvals |
| `/approve hitl` | Admin | List HITL briefings awaiting response (with Run/Dismiss buttons) |
| `/approve <id>` | Admin | View approval detail with inline Approve/Deny keyboard |

Worker approval callbacks: `appr:yes:<id>` → POST `/workers/approvals/{id}/approve`, `appr:no:<id>` → POST `/workers/approvals/{id}/deny`

HITL callbacks (v3.5 — 5 actions, Team Hub routed):
- `hitl:run:<key>` → Run immediately (dispatch to fleet)
- `hitl:approve:<key>` → Approve (status → assigned)
- `hitl:dismiss:<key>` → Dismiss (status → dismissed)
- `hitl:reject:<key>` → Reject (status → dismissed + comment)
- `hitl:gc:<key>` → "Picked up in GravityClaw" — acknowledge only, no status change, clears escalation timer

When `<key>` is a UUID, callbacks route through Engine `/api/action-items/{id}/act` → Team Hub. When `<key>` is a filename (legacy), callbacks route through Engine `/hitl/{file}/respond`. The bot detects UUID format via regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-/`).

HITL escalation: Unacknowledged notifications get reminder messages after 15 minutes (configurable). Any button press or GC acknowledgment clears the escalation timer. See [Heartbeat](../infra/heartbeat.md) for escalation details.

### Intelligence (Admin)

| Command | Access | Description |
|---------|--------|-------------|
| `/usage` | Admin | Claude plan utilization with visual progress bars (▰▱) |
| `/brain search <q>` | Admin | Search 2nd Brain nodes |
| `/brain save <text>` | Admin | Quick-capture text to Brain inbox |
| `/brain inbox` | Admin | List pending inbox items |
| `/brain suggest` | Admin | List pending AI suggestions |
| `/review [service]` | Admin | AI-powered log analysis (fire-and-forget via Claude) |

`/review` fetches last 100 journal lines, sends diagnostic prompt to Claude, edits ack message with analysis. Defaults to `opai-telegram` if no service specified.

### Task Registry (Admin)

| Command | Access | Description |
|---------|--------|-------------|
| `/tasks` | Admin | Summary by status (pending/scheduled/running/completed/failed/cancelled) |
| `/tasks list` | Admin | List pending tasks (ID, title, priority, source, date) |
| `/tasks complete <id>` | Admin | Mark task complete via Engine API |
| `/tasks cancel <id>` | Admin | Cancel task via Engine API |

### Configuration (Admin)

| Command | Access | Description |
|---------|--------|-------------|
| `/role list` | Owner | List all users + roles |
| `/role set <userId> <role> [name]` | Owner | Assign role |
| `/role remove <userId>` | Owner | Revoke access |
| `/topic bind <wsId> [name]` | Admin | Bind forum topic to workspace |
| `/topic info` | Admin | Show current topic binding |
| `/topic unbind` | Admin | Remove workspace binding |
| `/topic assistant on\|off` | Admin | Toggle assistant mode (selective coordinator) |
| `/topic assistant reset` | Admin | Clear shared assistant buffer |
| `/topicid` | All | Show current forum topic's thread ID (for `ALERT_THREAD_ID` config) |
| `/persona list` | Admin | Show personality options |
| `/persona set <name>` | Admin | Switch personality (professional/friendly/technical) |

---

## Deployment

### systemd Service

```ini
[Unit]
Description=OPAI Telegram Bot
After=network.target opai-caddy.service

[Service]
Type=simple
WorkingDirectory=/workspace/synced/opai/tools/opai-telegram
ExecStartPre=-/workspace/synced/opai/scripts/vault-env.sh opai-telegram
ExecStart=/home/dallas/.nvm/versions/node/v20.19.5/bin/node index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=/home/dallas/.nvm/versions/node/v20.19.5/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-/run/user/1000/opai-vault/opai-telegram.env

[Install]
WantedBy=default.target
```

### Caddy Route

```caddyfile
handle /telegram/* {
    reverse_proxy localhost:8110
}
```

### Health Endpoints

- `GET /health` -> `{ status: 'ok', service: 'opai-telegram', uptime: ... }`
- `GET /api/health` -> same (Monitor compatibility)

### Webhook Setup

```bash
node set-webhook.js   # Registers webhook URL + bot commands with Telegram
```

---

## Gotchas

- **grammY webhook 10-second timeout**: Middleware that blocks longer than 10s crashes Node. Claude CLI takes 10-60+ seconds. MUST use fire-and-forget pattern (send ack, return immediately, process in background).
- **Telegram bot privacy mode**: Bots in groups only receive `/commands` by default. Must be group admin OR disable privacy via BotFather to receive free text.
- **`bot.api` vs `ctx`**: After the webhook handler returns, `ctx` is gone. Background processing must use `bot.api.editMessageText(chatId, msgId, ...)` instead.
- **Team Hub API prefix**: Team Hub FastAPI has `prefix="/api"` on its router. Internal endpoints are at `/api/internal/*`, not `/internal/*`.
- **Team Hub list-items limit**: `limit=5` fetches 5 total items (all types). Client-side filtering for `type=task` may return fewer. Use `limit=30` and slice client-side.
- **Markdown parse failures**: Telegram's Markdown parser is strict. Always try `parse_mode: 'Markdown'` first, catch error, retry without parse_mode.
- **Job threadId**: Jobs store `threadId` so recovery notifications go to the correct forum topic, not General.
- **Restart-triggered briefing**: If `lastBriefingDate` is null on startup and the hour is past 8 AM, the briefing fires immediately. Fixed by pre-setting `lastBriefingDate` on startup when `hour >= BRIEFING_HOUR`.
- **Briefing UTC date rollover**: NEVER use `toISOString().split('T')[0]` for date comparison with `getHours()` — `toISOString()` returns UTC while `getHours()` returns local time. At 18:00 CST = midnight UTC, the UTC date rolls forward causing a false date mismatch. Fixed: use `localDateStr()` helper (`getFullYear()-getMonth()-getDate()`) for consistent local dates.
- **Blank briefing sections**: Separator bars (`━━━`) must be pushed *inside* content checks, not before them. Otherwise empty sections appear when APIs are unreachable.
- **Callback data 64-byte limit**: Telegram inline keyboard callback data has a 64-byte maximum. Keep callback patterns short (e.g., `hub:pri:high` not `hub:priority:high`).
- **Team Hub non-existent endpoints**: The old `/api/quick-add` endpoint never existed in Team Hub. Tasks must use `/api/internal/create-item` with query params (not JSON body).
- **Mini App `web_app` buttons: private chat only**: Telegram rejects `web_app` on both `InlineKeyboardButton` and `KeyboardButton` in group/supergroup chats ("web App buttons can be used in private chats only"). Solution: in groups, send an inline URL button with deep link `https://t.me/{bot}?start=apps`, then handle `/start apps` in DM to show the `web_app` keyboard.
- **tdesktop empty `initData`**: Telegram Desktop's WebView often provides empty `initData` (the signed string) while `initDataUnsafe` (unsigned JSON) has correct user info. Must implement fallback auth using `initDataUnsafe` for desktop compatibility. Log with `method: unsafe-fallback` for audit trail.
- **Mini App session tokens invalidate on restart**: `SESSION_SECRET` is random per process. Service restart = all Mini App sessions expire. This is acceptable for 1h-TTL tokens — users just re-open the Mini App.
- **Supergroup chat ID migration**: When a Telegram group enables forum topics, it upgrades to a supergroup with a **new chat ID**. Old ID stops working with "group chat was upgraded to a supergroup chat" + `migrate_to_chat_id`. Must update `ADMIN_GROUP_ID` in .env.

---

## Development

### Local (polling mode)

```bash
cd tools/opai-telegram
NODE_ENV=development node index.js
```

No HTTPS needed; uses long polling. Drops pending updates on start.

### Production (webhook)

```bash
systemctl --user start opai-telegram
# or
NODE_ENV=production node index.js
```

### Log Prefixes

| Prefix | Source |
|--------|--------|
| `[TG]` | General bot operations |
| `[TG] [FAST]` | Team Hub fast path |
| `[TG] [WP-FAST]` | WordPress fast path |
| `[TG] [ASST]` | Assistant mode operations |
| `[TG] [ASST] [FAST]` | Assistant mode fast-path hits |
| `[TG] [ALERT]` | Proactive alerts (service health, WordPress, briefing) |
| `[TG] [DANGER]` | Dangerous run operations (confirm, backup, execute, complete/error) |
| `[TG] [REVIEW]` | AI log review background errors |
| `[TG] [AUTH]` | Mini App authentication (session created, rejected, fallback) |
| `[TG] [PROXY]` | Mini App API proxy errors (backend unavailable, timeout) |
| `[TG] [ACTIVE]` / `[IDLE]` / `[COLD]` / `[EXPIRED]` | Claude slow path (state tag) |

### Debugging

```bash
journalctl --user -u opai-telegram -f          # Live logs
journalctl --user -u opai-telegram -n 50       # Last 50 lines
systemctl --user restart opai-telegram          # Restart
```

---

## Integration Points

| System | Protocol | Auth | Purpose |
|--------|----------|------|---------|
| Team Hub | HTTP `127.0.0.1:8089` | None (localhost) | Task/note/idea queries + task creation |
| Team Hub (Mini App) | HTTP proxy via `/telegram/api/hub/*` | Mini App session token | Mini App embedded access |
| OP WordPress | HTTP `127.0.0.1:8096` | Supabase service key (Bearer) | Site management |
| OP WordPress (Mini App) | HTTP proxy via `/telegram/api/wp/*` | Mini App session + service key | Mini App embedded access |
| OPAI Engine | HTTP `127.0.0.1:8080` | None (localhost) | Service health, approvals, tasks, usage, HITL |
| 2nd Brain | HTTP `127.0.0.1:8101` | Supabase service key (Bearer) | Search, inbox, suggestions |
| Claude Code CLI | Process spawn | Session resume | AI conversation + /review log analysis |
| Email Checker | File I/O + CLI | None | Inbox/draft management |
| YouTube Transcriber | Shared module | None | Video transcript extraction |
| Audit Logger | Module import | None | Event logging (optional) |

---

## Phases

### Completed

- **Phase 1** (2026-02-25): Core bot, webhook, Express, grammY, Claude CLI, conversation state, job tracking, restart recovery, basic commands, message chunking, progress updates, systemd service, Caddy routing
- **Phase 2** (2026-02-25): Custom RBAC, whitelist, forum topics, workspace binding, role-aware prompts, multi-user sessions
- **Phase 3** (2026-02-26): YouTube URL detection + action buttons, email commands, Team Hub fast-path (sub-second), WordPress fast-path + `/wp` command, inline keyboard confirmations, content-aware acknowledgments
- **Phase 3.5** (2026-02-26): Proactive alerts refactoring + Morning Briefing v2 + Multi-step task creation
  - Removed hourly deadline alerts (tasks only in morning briefing)
  - Morning briefing: visual progress bars (▰▱), color-coded thresholds (🟢/🟡/🔴), phone-optimized task display, per-site WordPress breakdown with tree-style details, "This Week" upcoming tasks
  - Restart-safe briefing (won't re-send on mid-day restart)
  - Multi-step `/hub task` creation: inline keyboard priority picker, due date picker (quick options + custom date), description prompt, confirmation summary — all via `pendingTasks` Map with 10-min auto-expiry
  - Flexible date parser (ISO, `Mar 15`, `in 3 days`, `next friday`, etc.)
  - Fixed `/hub note` and `/hub idea` to use Team Hub internal API (previously called non-existent endpoint)
  - Removed mini-app promotion from `/help`

- **Phase 4A** (2026-02-27): Mini App infrastructure
  - Auth bridge (`mini-app-auth.js`): initData HMAC-SHA256 validation, tdesktop `initDataUnsafe` fallback, process-scoped session tokens (1h TTL), `requireMiniAppAuth` + `requireAdmin` Express middleware
  - API proxy (`mini-app-proxy.js`): routes `/telegram/api/wp/*` → WP service (port 8096, service key auth), `/telegram/api/hub/*` → Team Hub (port 8089, no auth)
  - WordPress Mini App (`mini-apps/wordpress.html`): site list with status/update badges, detail view with info grid, Apply All Updates + Create Backup actions, Telegram theme integration
  - `/apps` command with private/group handling (web_app buttons DM-only, deep link for groups)
  - File sender (`file-sender.js`): secure file delivery with directory whitelist, blocked patterns, safe extensions, 50MB limit
  - `/briefing` and `/file` commands

- **Phase 4B** (2026-02-27): Autonomous Execution ("Run Dangerously")
  - `askClaudeDangerous()` in `claude-handler.js`: `--dangerously-skip-permissions`, 10-min timeout, autonomous prompt template
  - `/danger` command (owner-only): explicit instruction or pull from conversation context
  - Confirmation gate: Backup First (git add+commit+push) / Confirm / Cancel inline keyboard
  - Plan detection heuristic (`isPlanLikeResponse()`): 4-signal scoring, auto-injects "Run Dangerously" button on plan-like Claude responses
  - `dangerResponseCache` Map (30-min TTL) for button→response lookup
  - `pendingDangerRuns` Map (5-min expiry) for confirmation flow state
  - `executeDangerousRun()`: background processor with progress messages, job tracking
  - Audit logging: `logDangerousRun()` → `data/danger-audit.json` (last 200 entries)
  - Safety: owner-only, confirmation required, prompt forbids git push/branch delete unless instructed

- **Phase 5** (2026-02-27): Batch 2 Commands — Operational Mobile Access
  - Fixed `/services` list: 10 → 13 services (added vault, brain, oc-broker, browser, files, users)
  - Fixed `/logs` service map: added vault, brain, oc/oc-broker/openclaw, browser aliases
  - `/approve` command: list pending worker approvals, HITL briefings with Run/Dismiss inline keyboards, detail view with Approve/Deny gate
  - `/usage` command: Claude plan utilization with visual progress bars (▰▱), color-coded thresholds (🟢/🟡/🔴)
  - `/brain` command: search nodes, quick-capture to inbox, list inbox items, pending suggestions
  - `/tasks` command: task registry summary by status, list pending, complete/cancel tasks
  - `/review [service]` command: AI-powered log analysis — fetches 100 journal lines, fire-and-forget Claude diagnostic, edits ack with results
  - `engine-api.js`: shared HTTP helpers for Engine (port 8080) and Brain (port 8101) APIs (`engineGet`, `enginePost`, `brainGet`, `brainPost`)
  - `appr:*` and `hitl:*` callback handlers in callbacks.js
  - Updated `/help` with 3 new sections (Approvals, Intelligence, Task Registry)
  - Registered 5 new commands with Telegram API (25 → 27 total)

### Planned

- **Phase 6**: Team Hub Mini App (task board, quick add, workspace selector)
- **Phase 7**: Discord deprecation (feature parity audit, user migration)
