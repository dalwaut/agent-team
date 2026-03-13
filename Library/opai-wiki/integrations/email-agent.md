# OPAI Email Agent
> Last updated: 2026-03-06 (v9 — Labels pipeline, ARL loop prevention, draft-first ARL, Mark as Spam, IMAP label sync) | Source: `tools/opai-email-agent/`

Multi-account autonomous email agent. Monitors **all enabled accounts simultaneously** each cycle, classifies, labels (IMAP Gmail labels), drafts, and (optionally) auto-sends responses. Each account has its own mode, whitelist, blacklist, permissions, credentials, and voice profile. **Day-of-only by default**: only fetches today's unseen emails unless explicitly asked to pull all (prevents 54K+ email fetches on large inboxes). Full account lifecycle: create via onboarding, configure credentials in sidebar, delete with confirmation. Strict whitelist ensures only approved senders are interacted with. CLI tool for on-demand email checking from Claude Code.

> **v2 (2026-02-25)**: The email agent is now an **engine-managed process**. Instead of running as a standalone systemd service (`opai-email-agent`), it is spawned directly by the Engine's WorkerManager via `subprocess.Popen`. Benefits: unified log capture (500-line ring buffer), auto-restart on crash, vault env injection, start/stop from dashboard Workers tab. The `opai-email-agent.service` systemd unit has been disabled.

> **v5 (2026-02-27)**: Added **Blacklist** (immediate IMAP trash move), **Trash Classification** (manual trash + AI auto-trash with 48h delay), **Custom Classifications** (user-created categories with pattern learning), **Recompose** (re-draft with guidance, saves to Gmail Drafts), and **Needs Action** system (move to folder, scheduled delete, forward, TeamHub task creation). All per-account.

**Agent Response Loop (ARL)**: Whitelisted emails to `agent@paradisewebfl.com` trigger an autonomous research pipeline — intent parsing, skill execution (shell commands + Claude CLI), response synthesis, and auto-reply. 5-minute reply window with 30s fast-poll for follow-up conversations. Pluggable skills system with 19 built-in skills across 5 types (direct, claude, structured, gated, context-loader). Structured skills handle complex multi-step workflows: task creation, PRD intake, file management, report generation, **transcript processing**, and **template-based email sending** (proposals, follow-ups, status updates, meeting requests). TUI dashboard for monitoring and skills management.

> **v6 (2026-03-02)**: Added **Transcript Agent** (process meeting transcripts → multi-type action items → approval gate → execute), **MIME attachment download** (base64/quoted-printable content extraction from raw source), **multi-type action items** (task/quote/research/follow_up/email), **Team Hub workspace search + creation** endpoints, stale proposal cleanup (7-day TTL).

> **v7 (2026-03-03)**: **Approval-only pipeline** — all modes (suggestion/internal/auto) now queue drafts for human approval, never auto-send. **Queue overhaul**: Save to Drafts (Gmail IMAP), model selection (Haiku/Sonnet), length option (simple/long), edit/cancel without page refresh, deduplication, error feedback with toast notifications. **Inbox isolation**: queued emails hidden from Inbox tab until sent or rejected. **Voice profiles**: 3 account-specific voice files with strict plain-text/no-markdown rules. **Phantom email filter**: silently skips emails with no sender address. `callHaiku` renamed to `callModel` with model parameter.

> **v8 (2026-03-05)**: **Inbox Cleanup** — new product-grade view for bulk inbox triage. Full IMAP scan of all emails (not day-of-only), domain-based smart folder categorization (promos/newsletters/social/never-opened/old), 3-panel layout (folder sidebar + email list + preview), bulk trash/archive/flag with optimistic UI and 60s undo window, **agentic AI search** (natural language → structured filters via Claude), paginated email list with checkboxes, elevated dark theme with glassmorphism. View toggle switches between Live Monitor and Cleanup modes. Scan results cached in-memory with disk-persisted summary.

> **v9 (2026-03-06)**: **Tags→Labels rename** — all references to "tags" renamed to "labels" across the entire codebase to match Gmail terminology. `VALID_TAGS`→`VALID_LABELS`, `applyTagsToAccount`→`applyLabelsToAccount`, `caps.tag`→`caps.label`, config permissions `tag`→`label`. Backward compat: classifier still outputs `tags` alias. **ARL loop prevention** — 5-layer defense against AI self-reply loops: (1) universal AI-sent detection gate (Step 0.5, all accounts), (2) file-persisted sent tracker (`data/ai-sent-tracker.json`, 7-day TTL, 500 cap), (3) `X-OPAI-ARL-Sent` header on all AI-sent emails, (4) reply chain depth check (>3 Re:), (5) thread dedup (1 reply/hr/thread). **Draft-first ARL** — ARL saves draft to IMAP Drafts before sending; auto-sends only if account mode is internal/auto with `send=true`. **ARL classification** — ARL pipeline now runs classification + IMAP labeling (Step 0.5) before intent parsing. **Mark as Spam** action — Needs Action panel gains a "Mark as Spam" checkbox; executes IMAP move to `[Gmail]/Spam` + sender blacklist. **IMAP label sync** — manual classification now applies `OPAI/<ClassificationName>` as a Gmail label via IMAP, not just local display. **Action execution feedback** — assign endpoint returns `executedActions[]` with success/failure per action; UI shows toast with results and live-refreshes the card (no page reload). **Known user fallback** — ARL defaults to `research` skill for recognized users when no intent detected.

**Port**: 8093
**Route**: `/email-agent/`
**Service**: Engine-managed (spawned by WorkerManager)

---

## Architecture

```
opai-email-agent (persistent service :8093)
  ├─ index.js              — Entry: agent loop + audit server + SSE broadcast wiring
  │                           ETIMEOUT/EPIPE/ECONNRESET handled as transient (no crash)
  │                           ARL fast-poll watcher: enters 30s poll when conversations active
  ├─ agent-core.js         — Pipeline: fetch → gate → classify → act
  │                           Multi-account: iterates ALL enabled accounts per cycle
  │                           Day-of-only: { seen: false, since: today } by default
  │                           Step 0.5: Universal AI-sent detection gate (all accounts)
  │                           File-persisted sent tracker: loadSentTracker/saveSentTracker/recordSentId
  │                           MIME attachment download: downloadAttachments() (base64/QP decoding)
  │                           Transcript detection: detectAndSaveTranscripts() → notes/Transcripts|Recordings/
  │                           ARL intercept: checks shouldProcessArl() before normal pipeline
  │                           Account-aware: getCredentialsForAccount(), setEnvBridgeForAccount()
  │                           processEmail() extracted for per-email pipeline
  │                           Phantom email filter: silently skips emails with no fromAddress
  │                           markEmailSeen(), storeEmailMeta(), pruneOldProcessed()
  │                           fetchThreadEmail(), addAlert(), loadAlerts()
  ├─ arl-engine.js         — ARL pipeline orchestrator: parseIntent → match skills →
  │                           executePlan → synthesize response → draft-first → send reply → track conversation
  │                           shouldProcessArl() gate (ARL enabled + paradise account)
  │                           Step 0.5: Classify + IMAP label before intent parsing
  │                           Draft-first: saves to IMAP Drafts before auto-send
  │                           Known user fallback: defaults to 'research' skill for recognized users
  │                           synthesizeResponse() via Claude CLI (haiku model)
  │                           sendArlReply() checks result.success before recording as sent
  │                           Fallback response if synthesis fails
  ├─ arl-intent-parser.js  — Two-tier intent detection:
  │                           1. Pending transcript approval check (pre-scan, 0.95 confidence)
  │                           2. Regex scan against skill intentPatterns (zero AI cost)
  │                           3. Structured context extraction (Context:, Goal:, Fix:, Diagnose:)
  │                           Domain extraction for dns-lookup skill
  │                           Confidence: 0.6 single match → 0.95 with Goal/Context blocks
  │                           HIGH_PRIORITY_SKILLS: 8 skills checked first (includes transcript)
  ├─ arl-skill-runner.js   — Skill execution engine:
  │                           "direct" = shell command via execSync (zero AI cost)
  │                           "claude" = prompt piped to `claude -p` via spawn
  │                           "structured" = multi-step handlers (create-task, prd-intake,
  │                             manage-files, generate-report, process-transcript, approve-transcript)
  │                           "gated" = Telegram approval gate (system-change)
  │                           "context-loader" = chain context injection (remember-context)
  │                           executePlan() runs direct first (fast), then claude (slow)
  │                           thRequest() helper for TH internal API calls
  │                           CRUD: addSkill(), toggleSkill(), deleteSkill()
  ├─ arl-conversation.js   — Active conversation tracker (5-min TTL):
  │                           In-memory Map: sender → { threadId, lastActivity, turns }
  │                           hasActiveConversations() triggers fast-poll mode
  │                           Persistent ARL log (data/arl-log.json)
  ├─ arl-skills.json       — Skills config: 19 built-in + custom skills
  │                           arlEnabled, defaultModel, plannerModel, maxSkillsPerRequest
  │                           replyWindowMinutes (5), fastPollSeconds (30)
  ├─ user-resolver.js      — Maps email senders to OPAI user profiles
  │                           USER_MAP: { email → userId, name, role, workspace, defaultTeamHubWs }
  │                           canPerform(user, action): permission check per skill
  │                           getWorkspaceId(), getUserId(): TH scoping
  ├─ whitelist-gate.js     — Sender whitelist enforcement + addToWhitelist()
  │                           checkSenderForAccount() for multi-account pipelines
  │                           Mutual exclusion: addToWhitelist() removes from blacklist
  ├─ blacklist-gate.js     — Sender blacklist enforcement (mirrors whitelist-gate pattern)
  │                           checkBlacklistForAccount() → { blocked, reason }
  │                           addToBlacklist() removes from whitelist (mutual exclusion)
  │                           Data stored in data/classifications.json per account
  ├─ classification-engine.js — Custom classifications, trash patterns, auto-trash scheduling
  │                           Trash: manual[], auto[] (48h delay), patterns { senders, domains }
  │                           Custom: user-created categories with assignments + understandings
  │                           Pattern learning: sender/domain/tag frequency → auto-suggestions
  │                           Scheduled deletes: cron-processed in runCycle()
  ├─ mode-engine.js        — Mode logic (suggestion/internal/auto) + hot-reload interval
  │                           getEnabledAccounts() — all accounts with valid creds + enabled flag
  │                           getCapabilitiesForAccount() — mode∩perms for specific account
  ├─ action-logger.js      — Action log, daily rotation, archive index, date queries
  ├─ feedback-engine.js    — Typed feedback rules → injected into draft prompts
  ├─ cleanup-scanner.js    — Inbox Cleanup engine: IMAP bulk scan, domain categorization,
  │                           smart folder counts, paginated email listing, full body preview,
  │                           bulk trash/archive/flag (batched IMAP moves, max 50/batch),
  │                           undo stack (last 10 ops, 60s window), agentic AI search
  │                           (Claude via Anthropic/OpenRouter → structured filter groups),
  │                           in-memory cache per accountId, disk-persisted summaries
  ├─ audit-server.js       — Express REST API + SSE broadcast + groupActions helper
  │                           ARL API: /api/arl/config, /api/arl/toggle, /api/arl/skills,
  │                           /api/arl/skills/:id/toggle, /api/arl/conversations, /api/arl/history
  │                           Blacklist API: /api/blacklist, /api/blacklist/add, /api/blacklist/remove
  │                           Trash API: /api/trash, /api/trash/pending, /api/trash/:id/override
  │                           Classifications API: /api/classifications (CRUD + assign/unassign)
  │                           Recompose API: /api/recompose (re-draft with guidance → Gmail + queue)
  │                           Cleanup API: /api/cleanup/* (scan, status, folders, emails, preview,
  │                           trash, archive, flag, undo, search) — 12 endpoints
  ├─ cli-check.js          — CLI email checker (on-demand, any account, search, read)
  ├─ config.json           — Multi-account config: accounts[], enabled, mode, permissions, whitelist
  ├─ .env                  — Legacy IMAP/SMTP creds (envPrefix accounts); new accounts store creds inline
  ├─ static/               — Inbox-style moderation UI
  │    ├─ index.html       — Full layout, modals (compose, classify-test, recompose), all CSS
  │    │                      Blacklist sidebar, Pending Trash section, Classifications sidebar
  │    │                      View toggle (Live/Cleanup), Cleanup 3-panel layout + stats bar
  │    │                      CSS: .label-pill (was .tag-pill), .outcome-labeled (was .outcome-tagged)
  │    ├─ js/app.js        — Live view UI logic: SSE client, alert banner, inbox, queue,
  │    │                      activity, feedback, compose, classify-test, bulk actions,
  │    │                      blacklist/trash/classify buttons on email cards,
  │    │                      classify dropdown with label input + needs action panel
  │    │                      (Mark as Spam, Move to Folder, Delete After, Forward, Create Task),
  │    │                      recompose with draft guidance modal,
  │    │                      live card refresh + toast after classification (no page reload)
  │    ├─ js/cleanup.js    — Cleanup view: scan flow, folder sidebar, email list with
  │    │                      checkboxes + hover actions, preview panel, bulk operations,
  │    │                      agentic search with grouped results, pagination, selection,
  │    │                      confirm modal, toast with undo, SSE listeners, optimistic UI
  │    └─ css/cleanup.css  — Elevated dark theme for cleanup view: glassmorphism,
  │                           gradient avatars, category pills, skeleton loading,
  │                           3-panel responsive layout (sidebar/list/preview),
  │                           responsive breakpoints at 1100/900/700px
  └─ data/                 — Persistent state
       ├─ action-log.json       — Current day's log (auto-rotated at midnight)
       ├─ agent-state.json      — Kill flag, rate limit counters, timestamps
       ├─ feedback.json         — Feedback rules + draft corrections
       ├─ approval-queue.json   — Drafts awaiting human approval (with uid + folder)
       ├─ processed.json        — Dedup tracker: { entries: [{id, processedAt}] }
       ├─ alerts.json           — Urgent/attention email alerts (dismissible)
       ├─ email-meta.json       — Email metadata store (body preview, attachments)
       ├─ classifications.json  — Per-account: blacklist, trash patterns, custom classifications
       ├─ ai-sent-tracker.json  — File-persisted AI-sent email tracker (7-day TTL, 500 cap)
       ├─ arl-log.json          — ARL execution history (persistent, capped at 200)
       ├─ cleanup-summary-{accountId}.json — Persisted scan summary (folder counts, top 50 senders)
       ├─ pending-transcripts/  — Transcript proposals awaiting approval
       │    └─ ta-{timestamp}.json — { id, status, sender, analysis, thWorkspace, ... }
       └─ logs/                 — Archived daily logs
            ├─ YYYY-MM-DD.json  — One file per day
            └─ index.json       — Fast date→count lookup (O(1) date queries)

opai-arl-tui/ (TUI dashboard — no service/port, local terminal app)
  ├─ app.py               — Textual 8.x TUI: 4 tabs (Status, Skills, Activity, Conversations)
  │                          Keybinds: r=refresh, t=toggle ARL, e/d=enable/disable skill, x=delete
  │                          Auto-refresh every 5s, reads local JSON + API
  └─ launch.sh            — `python3 app.py`
```

Reuses modules from `../email-checker/` as libraries:
- `classifier.js` — AI classification via Claude CLI (Haiku model)
- `response-drafter.js` — 3-step draft-critique-refine loop (returns responseId string). `callModel(prompt, timeout, model)` supports Haiku and Sonnet. `draftResponse()` accepts `opts = { model }`.
- `sender.js` — SMTP send, IMAP draft save/remove, label application (`applyLabelsToAccount`), moveToTrash, moveToFolder, forwardEmail, markAsSpam

---

## Three Operating Modes

| Mode | Classify | Label (IMAP) | Draft | Send |
|------|----------|------------|-------|------|
| **Suggestion** | Yes | Yes | No | No |
| **Internal** | Yes | Yes | Yes (to queue) | No |
| **Auto** | Yes | Yes | Yes (to queue) | No — queued for approval |

- Default mode is **Suggestion** (safety first)
- Admin must explicitly opt into Internal or Auto via the segmented mode control
- **All modes queue drafts for human approval** — no mode auto-sends. The Approve & Send button on the Queue tab is the only way to send.
- Mode buttons have hover tooltips explaining each mode's capabilities
- IMAP labels are applied in all modes (non-destructive metadata) via Gmail's `X-GM-LABELS` extension
- Changing `checkIntervalMinutes` in Settings **hot-reloads** the agent loop — no restart needed

---

## Multi-Account System

The Email Agent monitors **all enabled accounts simultaneously** each cycle. Each account has independent:
- Mode (suggestion/internal/auto)
- Permissions (granular autonomy controls)
- Whitelist (domains + addresses)
- Voice profile (for AI drafting personality)
- IMAP/SMTP credentials (inline or via envPrefix)
- **`enabled`** flag (default `true`) — set `false` to exclude from monitoring without deleting

The `activeAccountId` controls which account the **UI focuses on** (settings, whitelist edits, compose). The monitoring loop ignores it — it checks all enabled accounts with valid credentials.

### Accounts in config.json

```json
{
  "activeAccountId": "acc-paradise",
  "accounts": [
    {
      "id": "acc-paradise",
      "name": "Paradise Web Agent",
      "email": "agent@paradisewebfl.com",
      "envPrefix": "AGENT",
      "mode": "suggestion",
      "permissions": { "classify": true, "label": true, ... },
      "whitelist": { "domains": [...], "addresses": [...] },
      "voiceProfile": "paradise-web-agent",
      "imapFolders": ["INBOX"],
      "enabled": true,
      "needsSetup": false
    }
  ]
}
```

### Enabled Account Resolution (`getEnabledAccounts()`)

An account is included in the monitoring cycle when ALL of:
1. `needsSetup` is NOT `true`
2. `enabled` is NOT `false`
3. Has valid IMAP credentials (inline `imap.pass` or env var `${envPrefix}_IMAP_PASS`)

### Credential Resolution Order
1. **Inline credentials** — `account.imap.pass` / `account.smtp.pass` (accounts created via UI)
2. **Environment variables** — `${envPrefix}_IMAP_HOST`, `${envPrefix}_IMAP_PASS`, etc. (legacy/existing accounts)
3. **Fallback** — `AGENT_IMAP_*` / `AGENT_SMTP_*` (ultimate fallback)

### Account API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/accounts` | GET | List all accounts (passwords sanitized) |
| `/api/accounts` | POST | Create new account |
| `/api/accounts/active` | GET | Get active account |
| `/api/accounts/active` | POST | Switch active account (restarts agent loop) |
| `/api/accounts/:id` | PATCH | Update account settings |
| `/api/accounts/:id` | DELETE | Delete account (cannot delete last) |
| `/api/accounts/:id/permissions` | PATCH | Update granular permissions |
| `/api/accounts/:id/test-connection` | POST | Test IMAP connection |

### Account Picker (UI)

`+` button next to "Email Agent" header title. Click to show dropdown with:
- **Create New** button at top
- List of all accounts with name, email, mode badge
- Active account highlighted with accent border
- `needsSetup` accounts show orange "Setup" badge
- Click any account to switch (restarts agent loop)

### Onboarding Flow (4 steps)

1. **Welcome** — How Email Agent works (3 modes, whitelist, granular controls)
2. **Account Details** — Name, email, voice profile
3. **Server Settings** — IMAP (host/port/user/pass) + SMTP (host/port/user/pass). Gmail defaults pre-filled.
4. **Review & Create** — Summary + create. Starts in Suggestion mode.

### Controls Sidebar (Right Panel)

The **Controls** button (header) opens a right sidebar with:

1. **Active Account** card — name, email, connection status (green dot = connected, orange dot = needs setup)
2. **Test Connection** / **Delete** buttons — row of two: test verifies IMAP credentials, delete removes the account (confirmation modal, cannot delete last account, auto-switches to next)
3. **Email Server Credentials** — expandable section for IMAP + SMTP config:
   - **Auto-expands** with orange highlight border for `needsSetup` accounts
   - **Collapsed** with "Edit" toggle for configured accounts
   - Fields: IMAP host/port/user/pass, SMTP host/port/user/pass
   - Gmail accounts show App Password hint with direct link to Google's App Passwords page
   - "Save Credentials" (save only) and "Save & Test" (save then test IMAP) buttons
   - Smart password handling: blank fields preserve existing passwords (never accidentally wiped)
4. **Operating Mode** — 3-button selector (Suggestion/Internal/Auto) with description
5. **Autonomy Controls** — 6 toggle switches:
   - Classify Emails, Label Emails, Organize Inbox, Draft Responses, Send Emails, Move Emails
   - Each toggle shows label, description, and on/off switch
   - **Mode gating**: toggles not available in current mode are greyed out and disabled
   - Shows "Requires Internal mode or higher" / "Requires Auto mode" hints on locked toggles
6. **Agent Settings** — Check interval, rate limit, voice profile, lookback window

**Effective capability** = `MODE_CAPABILITIES[mode][action] AND account.permissions[action]`

Pre-configured accounts:
- `acc-paradise` — Paradise Web Agent (agent@paradisewebfl.com) — fully connected, enabled
- `acc-dalwaut` — Dallas Personal (dalwaut@gmail.com) — connected, enabled
- `acc-artist` — Artist Personal (artistatlg@gmail.com) — needs setup, disabled

---

## Whitelist (Non-Bypassable)

**Domains** (all addresses at these domains are allowed):
- `paradisewebfl.com`, `boutabyte.com`, `boutacare.com`
- `wautersedge.com`, `evergladesit.com`, `visitevergladescity.com`
- `morningdewhomestead.com`, `shopholisticmedicine.com`

**Specific addresses**: `dalwaut@gmail.com`, `artistatlg@gmail.com`

Non-whitelisted emails are classified and logged as "skipped" but **never** responded to.

### Adding to the Whitelist

Two ways:
1. **UI** — Expand any skipped email card → "Whitelist this sender?" row → `+ Address` or `+ @domain` → confirmation modal → persisted to `config.json` immediately, no restart.
2. **API** — `POST /api/whitelist/add` with `{ address }` or `{ domain }`.

**Mutual exclusion**: Adding to whitelist automatically removes the same address/domain from blacklist (and vice versa).

---

## Blacklist (Immediate Trash)

Per-account sender blocking. Blacklisted emails are moved to IMAP Trash immediately — no classification, no processing.

### Data Storage

Stored in `data/classifications.json` → `accounts[accountId].blacklist`:

```json
{
  "blacklist": {
    "domains": ["spammer.com"],
    "addresses": ["junk@example.com"]
  }
}
```

### How It Works

1. **Pipeline Step 0** — `checkBlacklistForAccount()` runs before ARL, whitelist gate, and classification. If sender matches, `moveToTrash()` executes via IMAP, action is logged as `blacklist`, and the email is marked processed.
2. **Mutual exclusion** — Blacklisting a whitelisted sender removes them from whitelist. Whitelisting a blacklisted sender removes them from blacklist.

### UI

- **Blacklist button** on every email card in the action bar (red, next to Trash and Classify)
- **Blacklist sidebar section** in Controls (between Whitelist and Agent Settings) — shows domain/address chips with `×` remove buttons, add-domain and add-address inputs

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/blacklist` | Get blacklist for active account |
| `POST` | `/api/blacklist/add` | Add `{ address }` or `{ domain }` |
| `POST` | `/api/blacklist/remove` | Remove `{ address }` or `{ domain }` |

---

## Trash Classification

Two-tier trash system: **manual** (immediate) and **auto** (48h delay with rescue window).

### Manual Trash

User clicks **Trash** button on email card → confirmation modal → `POST /api/trash` → email immediately moved to IMAP Trash via `moveToTrash()`. Sender/domain pattern recorded for learning.

### Auto-Trash (Pattern Learning)

The system learns from manual trash actions. When a sender has been trashed **3+ times** or a domain **5+ times**, new emails from them are auto-queued for trash with a **48-hour delay** before IMAP move.

Pattern data in `data/classifications.json`:

```json
{
  "trash": {
    "manual": [{ "id": "mt-...", "emailId": "...", "sender": "...", "trashedAt": "..." }],
    "auto": [{ "id": "at-...", "emailId": "...", "sender": "...", "moveAfter": "2026-02-29T...", "overridden": false, "movedToTrash": false }],
    "patterns": {
      "senders": { "spam@example.com": { "count": 5, "lastSeen": "..." } },
      "domains": { "example.com": { "count": 8, "lastSeen": "..." } }
    }
  }
}
```

### Auto-Trash Pipeline

1. **Step 2.5** in `processEmail()` — after classification, `checkTrashPatterns()` evaluates sender count / domain count. If above threshold → `autoTrash()` creates an entry with `moveAfter = now + 48h`.
2. **runCycle() post-loop** — `getReadyToMove()` finds entries past the 48h delay + not overridden → IMAP move + `markAutoTrashMoved()`.

### Rescue (Override)

During the 48h window, user can click **Rescue** on any pending auto-trash entry → `POST /api/trash/:id/override` → marks `overridden: true`, decrements pattern counts (unlearning).

### Undo Manual Trash

`POST /api/trash/undo` → removes from manual trash list, resets email outcome to `skipped`.

### Trash API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/trash` | Manual trash + immediate IMAP move |
| `POST` | `/api/trash/undo` | Undo manual trash |
| `GET` | `/api/trash/pending` | Pending auto-trash entries (not overridden, not moved) |
| `POST` | `/api/trash/:id/override` | Rescue auto-trash entry (cancel move, unlearn pattern) |

---

## Custom Classifications (Pattern Learning)

User-created categories with automatic pattern learning. Assign emails to classifications → system builds "understandings" → suggests classifications for future emails.

### Data Model

```json
{
  "custom": [
    {
      "id": "cls-abc",
      "name": "Newsletters",
      "color": "#0984e3",
      "createdAt": "...",
      "assignments": [
        { "emailId": "<msg>", "sender": "news@example.com", "subject": "Weekly", "labels": ["newsletter"], "assignedAt": "..." }
      ],
      "understandings": [
        { "type": "sender", "value": "news@example.com", "confidence": 0.8, "matchCount": 3 },
        { "type": "domain", "value": "example.com", "confidence": 0.6, "matchCount": 2 },
        { "type": "tag", "value": "newsletter", "confidence": 0.5, "matchCount": 2 }
      ]
    }
  ]
}
```

### Understanding Types

| Type | Source | Threshold |
|------|--------|-----------|
| `sender` | Sender address frequency across assignments | 2+ occurrences |
| `domain` | Domain frequency across assignments | 2+ occurrences |
| `tag` | AI-generated label frequency across assignments | 2+ occurrences |

**Confidence** = `matchCount / totalAssignments`. Suggestions require confidence ≥ 0.3.

### How It Works

1. **Assign** — User assigns email to a classification (via Classify dropdown or suggestion pill click)
2. **Rebuild** — `rebuildUnderstandingsInPlace()` recalculates all sender/domain/tag patterns from assignments
3. **Suggest** — **Step 3.5** in `processEmail()` calls `suggestClassifications()` which checks all classification understandings against the current email's sender, domain, and labels
4. **Display** — Suggestion pills appear on email cards (color-coded, shows confidence %). Click to assign.

### Classify Dropdown (UI)

Click **Classify** button on email card → dropdown menu with:
1. **Label input** — type a name + Enter or `+` button → creates classification on the fly if new, then assigns
2. **Existing classifications** — list of all classifications with color dots. Click to assign.
3. **Needs Reply** checkbox — flags email as needing a reply
4. **Needs Action** expandable panel (see below)

### Needs Action System

When classifying, user can attach actions to the assignment:

| Action | Description | Execution |
|--------|-------------|-----------|
| **Mark as Spam** | Move to `[Gmail]/Spam` + blacklist sender | Immediate via `markAsSpam()` + `addToBlacklist()` |
| **Move to Folder** | IMAP move to specified folder (creates if needed) | Immediate via `moveToFolder()` |
| **Delete After** | Schedule deletion after N days/weeks/months | Cron via `scheduleDelete()`, processed each `runCycle()` |
| **Forward To** | Forward email to an address | Immediate via `forwardEmail()` (sends as .eml attachment) |
| **Create TeamHub Task** | Create a task linked to the email | `POST /hub/api/internal/create-item` on localhost:8089 |

Actions are collected from the expandable panel checkboxes/inputs and sent with the assign request. The server executes them immediately (spam/move/forward/task) or schedules them (delete). The response includes an `executedActions[]` array with success/failure status for each action — the UI displays results as a toast notification.

### IMAP Label Sync (Classification → Gmail)

When an email is classified (either via the pipeline or manually), the classification name is applied as a Gmail label under the `OPAI/` namespace:

- Classification "Newsletters" → Gmail label `OPAI/Newsletters`
- Classification "Client Work" → Gmail label `OPAI/Client-Work`

This uses `applyLabelsToAccount()` which supports three label types:
1. **Standard labels** — mapped via `LABEL_DISPLAY_MAP` (e.g., `internal` → `OPAI/Internal`)
2. **Pre-formatted labels** — strings starting with `OPAI/` pass through directly
3. **Custom labels** — any other string gets auto-prefixed with `OPAI/` and capitalized

Gmail auto-creates labels on first use. Non-Gmail IMAP servers use keyword flags as fallback.

### Undo Classification

Hoverable `×` button on the classification badge → `POST /api/classifications/:id/unassign` → resets outcome to `skipped`, logs `classify-undo` action, re-renders action bar.

### Classification API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/classifications` | Get all classifications for active account |
| `POST` | `/api/classifications` | Create `{ name, color }` |
| `DELETE` | `/api/classifications/:id` | Delete classification |
| `POST` | `/api/classifications/:id/assign` | Assign email + execute actions |
| `POST` | `/api/classifications/:id/unassign` | Unassign email (undo) |

---

## Recompose (Re-Draft with Guidance)

Recompose lets the admin re-run the draft pipeline for any email with optional guidance text to shape the response.

### Flow

1. User clicks **Recompose** button (green, available on all email states)
2. Modal with textarea: "Draft guidance — e.g. 'Politely decline, suggest next week instead...'"
3. Confirm → `POST /api/recompose` with `{ emailId, sender, subject, draftGuidance }`
4. Server:
   - Prepends `[DRAFT GUIDANCE FROM ADMIN: ...]` to email body
   - Appends feedback context from active rules
   - Calls `draftResponse()` (3-step: initial → critique → refine via Claude)
   - **Draft stays local** — NOT pushed to Gmail until user clicks Save to Drafts
   - Adds to approval queue → appears in Queue tab
   - Logs `draft` action → appears in email's activity timeline
5. Draft is visible in Email Agent Queue tab only (local until explicitly saved or sent)

### Queue Actions

| Button | Action |
|--------|--------|
| **Approve & Send** | Sends via SMTP as a reply in the email thread (In-Reply-To/References headers), marks source `\Seen`. On failure: reverts to pending, shows error toast. |
| **Save to Drafts** | Saves draft to Gmail Drafts folder via IMAP. Shows "Saved to Gmail Drafts" badge on card. Does NOT send. |
| **Edit** | Inline textarea editing. Save & Exit saves locally (status → `edited`). Cancel restores original. Page does NOT refresh during editing. |
| **Regenerate** | Modal with guidance textarea + model selector (Haiku/Sonnet) + length option (Simple 1-2 paragraphs / Detailed 3-5 paragraphs). Calls `draftResponse()` with selected model. |
| **Reject** | Removes from queue immediately. |

### Double-Submit Prevention

- `confirmModal()` nulls the callback before execution
- Confirm button shows "Working..." + disabled state during processing
- Modal always closes (even on API error) via try/catch guard

---

## Pipeline (per cycle)

```
runCycle(options)
├─ pruneOldProcessed()            — expire entries >90 days old, migrate legacy format
├─ getEnabledAccounts()           — all accounts with valid creds + enabled=true
├─ For EACH enabled account (sequential):
│    ├─ getCapabilitiesForAccount(account)  — mode ∩ permissions
│    ├─ fetchEmails(account, {dayOnly})     — IMAP UNSEEN + SINCE today (default)
│    │    Search: { seen: false, since: todayMidnight }
│    │    Pass fetchAll:true to skip date filter (e.g. manual pull-all)
│    └─ For each email → processEmail(email, account, mode, caps):
│         ├─ Step 0: storeEmailMeta()          — persist from/subject/body/uid/folder
│         ├─ Step 0: checkBlacklistForAccount() — blocked → moveToTrash + mark processed + return
│         ├─ Step 0.5: AI-sent detection gate (universal, all accounts)
│         │    Check X-OPAI-ARL-Sent header + file-persisted sent tracker
│         │    If AI-sent → skip (prevent inter-account loops)
│         │    If human email from managed account → continue normally
│         ├─ Skip if already in processed.json (dedup by messageId)
│         ├─ ARL intercept (if enabled + paradise account)
│         │    ├─ Step 0.5: Classify + IMAP label (before intent parsing)
│         │    ├─ Parse intent (or fallback to 'research' for known users)
│         │    ├─ Execute skills → synthesize response
│         │    ├─ Save draft to IMAP Drafts folder
│         │    └─ If internal/auto + send=true → auto-send; else → queue for approval
│         ├─ Step 1: checkSenderForAccount()   — account-specific whitelist gate
│         ├─ Step 2: Classify (AI via Claude CLI, Haiku model)
│         │    └─ If urgency=urgent or needsUserAttention → addAlert()
│         ├─ Step 2.5: checkTrashPatterns()    — sender 3+ / domain 5+ → autoTrash (48h delay)
│         ├─ Step 3: Label (IMAP Gmail labels via setEnvBridgeForAccount())
│         ├─ Step 3.5: suggestClassifications() — check understandings → store suggestions in meta
│         ├─ Mode check:
│         │    ├─ Suggestion: log suggestion, mark processed, done
│         │    ├─ Internal: fetchThreadEmail(id, account) → draft → queue
│         │    └─ Auto: fetchThreadEmail() → draft → rate-limit → send or queue
│         │         └─ On send: markEmailSeen(uid, folder, account) → mark processed
│         └─ Log action with [AccountName] prefix in reasoning
│         └─ ALL outbound AI emails tagged with X-OPAI-ARL-Sent header
│              + recorded in file-persisted sent tracker
├─ Process delayed auto-trash moves (entries past 48h, not overridden)
│    └─ For each ready entry: moveToTrash(uid, folder) → markAutoTrashMoved()
├─ Process scheduled deletions (entries past deleteAt)
│    └─ For each ready entry: moveToTrash(uid, folder) → markDeleteExecuted()
└─ broadcastSSE('cycle', {processed, skipped, errors}) — notify all SSE clients
```

### Day-of-Only Fetching (Performance Critical)

By default, `fetchEmails()` uses `{ seen: false, since: todayMidnight }` to only fetch unseen emails received today. This prevents catastrophic performance on large inboxes (e.g. 60K+ emails in dalwaut Gmail was fetching 54K+ emails per cycle, taking 37+ minutes and causing IMAP timeouts).

- **Default**: `dayOnly: true` — IMAP search: `UNSEEN SINCE <today>`
- **Override**: `runCycle({ fetchAll: true })` or CLI `--all` flag — IMAP search: `UNSEEN` (no date filter)
- The IMAP `SINCE` criterion uses date-only (no time), so today at midnight local time is used
- Combined with `processed.json` dedup tracker, this catches all new emails without re-processing

After a successful send (auto or queue-approved), the source email is marked `\Seen` in Gmail IMAP so the unseen count drops correctly.

### Thread Context (fetchThreadEmail)

When an email has an `inReplyTo` header, `agent-core.js` opens a second IMAP connection, searches INBOX by Message-ID, and fetches the previous email's body. The text (first 1,000 chars) is injected into the draft prompt as `--- PREVIOUS MESSAGE ---`. Silently skips on any IMAP error — never blocks the pipeline.

### Processed.json — Age Expiry

Format changed from `{ ids: [] }` (legacy) to `{ entries: [{id, processedAt}] }`. On each cycle start, `pruneOldProcessed()` removes entries older than 90 days. Legacy format is migrated on first write. Capped at 2,000 entries as a hard ceiling.

---

## Email Metadata Store (`data/email-meta.json`)

Every processed email gets a lightweight metadata record stored **before** any pipeline steps — including skipped emails.

```json
{
  "<message-id>": {
    "messageId": "<message-id>",
    "from": "Display Name <addr@example.com>",
    "fromAddress": "addr@example.com",
    "to": "agent@paradisewebfl.com",
    "subject": "Subject line",
    "date": "2026-02-21T14:00:00.000Z",
    "bodyPreview": "First 600 characters of plain text body...",
    "attachments": ["invoice.pdf", "contract.docx"],
    "storedAt": "2026-02-21T14:00:01.000Z"
  }
}
```

- Attachment names extracted from `Content-Disposition: attachment` headers in raw IMAP source — no files downloaded
- Capped at 500 entries (oldest evicted by `storedAt`)
- `backfilled: true` flag on entries populated from action log (no body/attachments)
- Queried by UI via `GET /api/email-meta/:messageId` (messageId URL-encoded)

---

## Alert System (`data/alerts.json`)

When the classifier returns `urgency: 'urgent'` or `needsUserAttention: true`, `addAlert()` creates an entry in `alerts.json`:

```json
{
  "alerts": [
    {
      "id": "alert-1708123456789-ab12",
      "emailId": "<message-id>",
      "sender": "client@example.com",
      "subject": "URGENT: Server down",
      "reason": "Urgent email detected",
      "labels": ["urgent", "client"],
      "priority": "high",
      "dismissed": false,
      "createdAt": "2026-02-21T14:00:00.000Z"
    }
  ]
}
```

- Undismissed alerts render as a persistent red banner above the inbox on page load and after every SSE cycle event
- Each alert is individually dismissible via `×` button → `POST /api/alerts/:id/dismiss`
- Capped at 100 entries

---

## Audit/Moderation UI

Accessible at `/email-agent/`. Dark-themed SPA matching OPAI design system.

### Layout

1. **Header bar** (sticky):
   - Left: "Email Agent" title + **Account Picker** (`+` button with active email, dropdown on click)
   - Center: **Segmented mode control** with color-coded active state (blue/yellow/green), capability dots, and hover tooltips per mode
   - Right: Check Now (spinner), **Compose**, **Test Classify**, **Controls** (opens right sidebar), Kill/Resume
   - Header background turns dark red when agent is killed

2. **Stats strip**: emails today, drafts pending, auto-sends, rate limit (dot changes green → yellow → red), last action timestamp

3. **Alert banner** (below stats strip, hidden when empty): Red-bordered dismissible banner listing urgent/attention emails. Refreshes after every SSE push.

4. **Tab bar** (4 tabs): Inbox · Queue · Activity · Feedback

5. **Controls sidebar**: Slides in from right. Contains account info + delete, credential setup (auto-expands for unconfigured accounts), mode selector, autonomy toggles, and agent settings. Saves hot-reload the agent loop if interval changed.

### Date Navigator (Inbox + Activity tabs)

`← YYYY-MM-DD →` arrow controls page through archived days. Both Inbox and Activity respect the selected date. Data is fetched from corresponding archive files. Available dates from `GET /api/logs/dates` (powered by `data/logs/index.json` — O(1) lookup).

### Inbox Tab

**Inbox filter dropdown** + **search input** — both routed through `applyInboxFilter()`:
- Dropdown values (`classify`, `label`, `draft`, `send`, `skip`) map to outcome strings (`classified`, `labeled`, `draft`, `sent`, `skipped`)
- Search filters by sender or subject
- **Hide Skipped** button (top-right of filter bar) — client-side filter, hides all skipped cards from the current view

Actions grouped by `emailId` into email cards. Each card shows avatar, sender name + address, subject, label pills, outcome badge, action count. Click to expand →

**Expanded card sections (in order):**

1. **Email Content panel** — collapsible, lazy-loaded from `/api/email-meta/:messageId`
   - Shows: From · To · Subject · Date · Body preview (first 600 chars with scroll) · Attachment chips (📎 filename, name only — no download)
   - "Loading..." shown on first expand, then cached — no repeat fetches
   - Falls back to "Content not available" if metadata missing

2. **Action timeline** — colored dot per action, reasoning at each step
   - `classify` actions: shows label pills extracted from classification (not raw JSON)
   - `suggest` actions: shows agent's decision text / summary (not raw JSON)
   - `draft` actions: shows draft guidance and preview
   - `blacklist`, `manual-trash`, `auto-trash`, `trash-undo`, `classify-undo` actions: shows reasoning
   - Other actions: shows full details JSON

3. **Draft preview** (if draft exists)

4. **Action bar** (unprocessed / skipped / un-classified emails):
   - **Blacklist** (red) → confirm modal → IMAP trash + blacklist add
   - **Trash** (red) → confirm modal → IMAP trash + pattern learn
   - **Classify** → dropdown with label input, existing classifications, Needs Reply, Needs Action panel (Mark as Spam, Move to Folder, Delete After, Forward, Create Task)
   - **Recompose** (green) → guidance modal → re-draft → Gmail + queue

5. **Whitelist row** (skipped cards only): `+ Address` | `+ @domain` | `Recompose`

6. **Feedback form** + **Recompose button** (pipeline-processed cards: classified/tagged/draft/sent/error):
   - Left: type dropdown + text input → `Save`
   - Right: Recompose button

7. **Recompose only** (trashed / custom-classified cards): bottom-right Recompose button

**Outcome badges** support hoverable `×` for undo on trashed and custom-classified states → clicking resets to `skipped` and re-renders the action bar.

**Classification suggestion pills** appear below the action bar when `classificationSuggestions` exist in email metadata — color-coded, shows confidence %, click to assign.

### Label Pill Color Map

| Label Pattern | Color |
|-------------|-------|
| urgent, priority | Red |
| client, customer | Blue |
| internal, team | Purple |
| invoice, billing | Green |
| newsletter, marketing | Gray |
| task, action | Orange |
| informational | Teal |
| default/other | Slate |

### Outcome Badges

| Outcome | Color | Badge | Undo |
|---------|-------|-------|------|
| Skipped | Gray | `Skipped` | — |
| Classified | Blue | `Classified` | — |
| Labeled | Purple | `Labeled` | — |
| Draft Pending | Yellow | `Draft` | — |
| Sent | Green | `Sent` | — |
| Error | Red | `Error` | — |
| Blacklisted | Red | `Blacklisted` | — |
| Trashed | Red | `Trashed` | Hoverable `×` → undo trash |
| Auto-Trash | Yellow | `Auto-Trash` | Rescue from pending trash |
| cls:Name | Blue + color dot | Classification name | Hoverable `×` → unassign |

Outcome priority (highest wins): skip(1) < blacklisted/trashed/auto-trash(2) < classify(3) < label(4) < draft(6) < send(7) < error(8). Undo actions (`trash-undo`, `classify-undo`) always reset to `skipped`.

### Queue Tab

Split-view cards: left = email summary, right = draft. Actions: **Approve & Send** · **Save to Drafts** · **Edit** (inline textarea) · **Regenerate** · **Reject**.

**Clear All** button (top-right) rejects all pending items at once via `POST /api/bulk/clear-queue`.

- Fetches both `pending` and `edited` items (Save & Exit sets status to `edited`)
- **Inbox isolation**: emails with pending/edited queue items are hidden from the Inbox tab — they live exclusively in the Queue until sent or rejected
- **Deduplication**: `addToQueue()` checks for existing pending item with same `emailId` before creating a new entry; updates draft content if found
- **Edit-safe refresh**: uses cached `_queueItems` array + separate `renderQueue()` function — page never refreshes or fetches while user is editing a draft
- **Error feedback**: Approve & Send shows toast notification on SMTP failure and reverts item to pending
- **Save to Drafts**: pushes draft to Gmail Drafts folder via IMAP APPEND with In-Reply-To/References headers for thread continuity. Shows "Saved to Gmail Drafts" badge.
- **Regenerate**: modal with guidance text + model selector (Haiku/Sonnet) + length selector (Simple/Detailed). Button shows "Regenerating..." during processing.

### Activity Tab

Compact timeline rows with colored action dots. Respects date navigator. **Date dividers** separate entries by day (e.g. "Fri, Feb 21"). Click to expand: full reasoning, details, existing feedback, feedback input.

### Feedback Tab

**Add Rule form**: type dropdown (General / Tone & Style / Routing / CC Rules / Always Respond / Never Respond) + text input + Add Rule button.

**Rule list**: each rule shows a colored type badge + comment text + optional sender scope + date + Deactivate button.

Type badges color-coded: Tone (purple), Routing (blue), CC (teal), Always Respond (green), Never Respond (red).

### Compose Modal

Header button "Compose" opens a full compose form: To · Subject · Body → Send calls `POST /api/compose` → logs a `send` action.

### Test Classify Modal

Header button "Test Classify" opens a popup: From · Subject · Body (optional) → Classify calls `POST /api/classify-test` → displays tag pills + priority/urgency/requiresResponse inline in the modal.

### Real-Time Push (SSE)

`EventSource` connects to `GET /api/events` on page load. On `cycle` event (fired after every agent cycle or Check Now), the UI automatically refreshes emails, queue, activity, alerts, and status. Polling intervals (status: 15s, emails/queue: 60s) run as fallback in case SSE drops.

---

## Feedback System

Admin feedback creates persistent typed rules injected into all future draft prompts.

### Rule Types

| Type | Prompt Label | Use Case |
|------|-------------|----------|
| `tone` | TONE & STYLE | Adjust formality, word choice, length |
| `routing` | ROUTING | Direct certain emails to specific teams |
| `cc` | CC RULES | Always/never CC specific addresses |
| `always-respond` | ALWAYS RESPOND | Override no-response classification |
| `never-respond` | NEVER RESPOND | Block responses to certain senders |
| `general` | GENERAL RULES | Catch-all for other instructions |

### Prompt Injection Format

```
--- ADMIN FEEDBACK (follow all of these) ---

TONE & STYLE:
- Keep responses under 3 sentences [for client@example.com]
- Never use exclamation marks

ROUTING:
- Invoice emails should reference the accounting team

DRAFT CORRECTIONS (learn from these patterns):
- Was: "Thank you for your message. We will get back to..."
  Now: "Thanks for reaching out! I'll handle this by..."

--- END FEEDBACK ---
```

Rules grouped by type. Sender-scoped rules show `[for sender@domain.com]` annotation. Last 5 relevant draft corrections included below rules.

### Feedback Sources

1. **Card feedback form** — type selector + comment on any expanded inbox card
2. **Activity feedback form** — feedback input on expanded activity rows
3. **Feedback tab** — global rules with type selector
4. **Draft corrections** — auto-recorded when admin edits a queue draft before approving

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Service health check |
| GET | `/api/status` | Mode, killed, stats, settings, rateLimit, uptime |
| GET | `/api/mode` | Current mode + capabilities |
| POST | `/api/mode` | Set mode `{ mode }` |
| GET | `/api/settings` | Agent settings |
| PATCH | `/api/settings` | Update settings — hot-reloads interval if changed |
| GET | `/api/logs/dates` | All available dates + today (from archive index) |
| GET | `/api/emails` | Actions grouped by emailId — `?date=YYYY-MM-DD`. Filters out emails with pending/edited queue items (inbox isolation). |
| GET | `/api/actions` | Flat action log — `?limit=&filter=&date=` |
| GET | `/api/actions/:id` | Single action detail |
| POST | `/api/actions/:id/feedback` | Add typed feedback to action `{ comment, type, sender }` |
| GET | `/api/email-meta/:messageId` | Email metadata (from, subject, body preview, attachments) |
| GET | `/api/queue` | Approval queue — `?status=pending` or `?status=edited` |
| POST | `/api/queue/:id/approve` | Approve and send via SMTP. On failure: reverts to pending, returns error. |
| POST | `/api/queue/:id/reject` | Reject draft |
| POST | `/api/queue/:id/edit` | Edit draft text, records correction (status → `edited`) |
| POST | `/api/queue/:id/save-draft` | Save draft to Gmail Drafts via IMAP APPEND |
| POST | `/api/queue/:id/regenerate` | Re-draft with `{ draftGuidance, model, length }` — model: haiku/sonnet, length: simple/long |
| GET | `/api/feedback` | All feedback rules + corrections |
| POST | `/api/feedback` | Add rule `{ comment, type, sender, actionId }` |
| POST | `/api/feedback/:id/deactivate` | Deactivate a rule |
| GET | `/api/alerts` | Undismissed alerts |
| POST | `/api/alerts/:id/dismiss` | Dismiss an alert |
| POST | `/api/compose` | Send ad-hoc email `{ to, subject, body }` |
| POST | `/api/classify-test` | Test classify `{ from, subject, body }` → returns classification |
| POST | `/api/bulk/clear-queue` | Reject all pending queue items |
| GET | `/api/events` | SSE stream — emits `cycle` event after each agent run |
| POST | `/api/kill` | Kill agent loop |
| POST | `/api/resume` | Resume agent |
| GET | `/api/stats` | Today's stats |
| GET | `/api/whitelist` | Current whitelist |
| POST | `/api/whitelist/add` | Add `{ address }` or `{ domain }` |
| GET | `/api/blacklist` | Current blacklist |
| POST | `/api/blacklist/add` | Add `{ address }` or `{ domain }` (removes from whitelist) |
| POST | `/api/blacklist/remove` | Remove `{ address }` or `{ domain }` |
| POST | `/api/trash` | Manual trash → immediate IMAP move + pattern learn |
| POST | `/api/trash/undo` | Undo manual trash → reset to skipped |
| GET | `/api/trash/pending` | Pending auto-trash entries (48h window) |
| POST | `/api/trash/:id/override` | Rescue auto-trash (cancel move, unlearn pattern) |
| GET | `/api/classifications` | All custom classifications for account |
| POST | `/api/classifications` | Create `{ name, color }` |
| DELETE | `/api/classifications/:id` | Delete classification |
| POST | `/api/classifications/:id/assign` | Assign email + apply IMAP label + execute actions → returns `executedActions[]` |
| POST | `/api/classifications/:id/unassign` | Unassign (undo classification) |
| POST | `/api/recompose` | Re-draft with guidance → local draft + approval queue (no Gmail push) |
| POST | `/api/check-now` | Trigger immediate cycle + SSE broadcast |
| GET | `/api/auth/config` | Supabase config for frontend |
| POST | `/api/cleanup/scan` | Start inbox scan `{ includeSpam, includeTrash, maxAge }` |
| POST | `/api/cleanup/cancel` | Cancel active scan |
| GET | `/api/cleanup/status` | Scan state (active, progress, error, hasCachedData) |
| GET | `/api/cleanup/folders` | Folder counts for account |
| GET | `/api/cleanup/emails` | Paginated emails `?category=&page=&pageSize=&sortBy=` |
| GET | `/api/cleanup/preview/:uid` | Full email body + attachments `?folder=` |
| POST | `/api/cleanup/trash` | Bulk trash `{ uids, folder }` |
| POST | `/api/cleanup/archive` | Bulk archive `{ uids, folder }` |
| POST | `/api/cleanup/flag` | Bulk flag `{ uids, folder }` |
| POST | `/api/cleanup/undo` | Undo last operation (60s window) |
| POST | `/api/cleanup/search` | Agentic AI search `{ query }` |

### GET /api/emails Response Shape

```json
{
  "emails": [
    {
      "emailId": "<message-id>",
      "sender": "dalwaut@gmail.com",
      "subject": "Re: Project Update",
      "date": "2026-02-21T15:40:39.000Z",
      "actions": [ /* chronological action entries */ ],
      "labels": ["client", "action-required"],
      "outcome": "draft",
      "draft": "Thank you for the update..."
    }
  ]
}
```

**Action priority**: skip(1) < blacklist/manual-trash/auto-trash(2) < classify(3) < label/suggest/organize(4) < queue(5) < draft(6) < send(7) < error(8). **Outcome priority** (separate): classified(0) < skipped(1) < blacklisted/trashed/auto-trash(2) < labeled(4) < draft(6) < sent(7) < error(8). Undo actions (`trash-undo`, `classify-undo`) always force outcome to `skipped`.

Label extraction handles: `details.classification.labels[]`, `details.classification.tags[]` (backward compat), `details.labels[]`, `details.tags[]`, `details.category`, string `details.classification`.

### GET /api/logs/dates Response Shape

```json
{
  "today": "2026-02-21",
  "dates": ["2026-02-21", "2026-02-19", "2026-02-18"]
}
```

Dates newest first. Today always included. Powered by `data/logs/index.json` — rebuilt automatically if missing.

---

## Action Logger — Daily Rotation & Archive Index

`action-log.json` is the live log for the current day. At midnight, `maybeRotate()` archives to `data/logs/YYYY-MM-DD.json`, updates `data/logs/index.json`, and resets the live file.

**Archive index** (`data/logs/index.json`): `{ "YYYY-MM-DD": count }`. Enables O(1) date list queries. Rebuilt from directory scan if missing or empty.

`getActions(limit, filter)` reads today first, then archives newest-first until limit is met — ensures UI always shows recent history regardless of rotation timing.

`getActionsForDate(date, filter)` reads a specific day.

`listAllDates()` / `listArchives()` both use the index with `rebuildIndex()` fallback.

---

## ARL Loop Prevention (5-Layer Defense)

When multiple managed accounts exist (e.g., agent@, dallas@, dalwaut@), AI auto-replies could trigger infinite loops: AI replies from account A → account B picks up the reply → AI replies back → infinite loop. The 5-layer defense stack prevents this:

| Layer | What | Scope | Persists? |
|-------|------|-------|-----------|
| **Step 0.5** | `X-OPAI-ARL-Sent` header check | All accounts | Yes (in email headers) |
| **Step 0.5** | File-persisted sent tracker (`data/ai-sent-tracker.json`) | All accounts | Yes (7-day TTL, 500 cap) |
| **Layer 3** | Reply chain depth (>3 `Re:` prefixes) | ARL accounts | N/A |
| **Layer 4** | Global rate limit (30/hr) | All ARL sends | In-memory (resets hourly) |
| **Layer 5** | Thread dedup (1 reply/hr per thread) | ARL accounts | In-memory (1hr TTL) |

### How Step 0.5 Works

Runs in `agent-core.js` `_processEmailInner()` for **ALL enabled accounts**, before any other processing:

1. Load all configured account emails from `config.json`
2. If sender is a managed account email:
   - Check raw email source for `X-OPAI-ARL-Sent: true` header
   - Check `data/ai-sent-tracker.json` for matching Message-ID or sender+subject key
   - If AI-sent detected → mark processed, log `ai-self-skip`, return `skipped`
   - If NOT AI-sent → human email between managed accounts, continue pipeline normally

### Sent Tracker (`data/ai-sent-tracker.json`)

```json
{
  "entries": [
    { "messageId": "<abc@paradisewebfl.com>", "key": "agent@pw|Re: test", "to": "dalwaut@gmail.com", "sentAt": "2026-03-06T..." }
  ]
}
```

- Written after every AI-sent email (ARL sends, approval queue sends, compose sends)
- Loaded on startup — survives restarts
- Pruned: entries older than 7 days removed on each write
- Capped at 500 entries

### X-OPAI-ARL-Sent Header

All outbound AI emails include `X-OPAI-ARL-Sent: true` as a custom header. This is the primary loop detection mechanism — persists in the email itself, requires no external state. Applied by:
- `sendArlReply()` in `arl-engine.js`
- Queue approval sends in `audit-server.js`
- Ad-hoc compose sends in `audit-server.js`

---

## Safety Guarantees

1. **Whitelist is non-bypassable** — gate runs before ANY action, including classification
2. **Blacklist overrides everything** — Step 0, runs before whitelist/ARL/classification
3. **AI-sent detection is universal** — Step 0.5 runs on ALL accounts, prevents inter-account AI loops
4. **Auto-trash has 48h delay** — user can rescue before IMAP move; override unlearns patterns
5. **Blacklist/whitelist mutual exclusion** — adding to one removes from the other
6. **Auto mode rate-limited** — default 5/hour, adjustable from UI without restart
7. **Kill button halts immediately** — in-memory flag, audit server stays alive
8. **Default is suggestion** — must explicitly opt into Internal or Auto
9. **Every action logged with reasoning** — full audit trail + daily archives
10. **Feedback loop** — admin comments become rules without code changes
11. **markEmailSeen is non-blocking** — IMAP failures never block a send
12. **fetchThreadEmail is non-blocking** — IMAP failures silently return null; draft proceeds without thread context
13. **storeEmailMeta is pre-gate** — even skipped/rejected emails get a metadata record
14. **SSE failures are silent** — `broadcastSSE` catches all write errors; a dropped client never affects the pipeline
15. **Gmail draft save is non-blocking** — `saveDraftToAccount()` failures are logged but don't block queue creation
16. **Recompose double-submit prevention** — modal callback nulled before execution, confirm button disabled during processing
17. **Draft-first ARL** — ARL saves draft to IMAP Drafts before sending; auto-send only if mode + permissions allow

---

## Configuration

### config.json

See [Multi-Account System](#multi-account-system) above for the full multi-account config format. Global settings at root level:

```json
{
  "activeAccountId": "acc-paradise",
  "accounts": [ ... ],
  "checkIntervalMinutes": 30,
  "rateLimitPerHour": 5,
  "lookbackMinutes": 60,
  "maxAutoSendsPerHour": 5
}
```

### .env (legacy / envPrefix accounts)
```
AGENT_IMAP_HOST=imap.gmail.com
AGENT_IMAP_PORT=993
AGENT_IMAP_USER=agent@paradisewebfl.com
AGENT_IMAP_PASS=<app-password>
AGENT_SMTP_HOST=smtp.gmail.com
AGENT_SMTP_PORT=465
AGENT_SMTP_USER=agent@paradisewebfl.com
AGENT_SMTP_PASS=<app-password>
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
PORT=8093
```

Accounts created via the UI store credentials inline in `config.json` and don't use `.env`. The `envPrefix` pattern is for the original Paradise account only.

---

## Infrastructure

- **Managed by**: OPAI Engine WorkerManager (spawned as subprocess, no systemd unit)
- Logs accessible via `/api/workers/email-manager/logs` (500-line ring buffer)
- **Caddy**: `/email-agent/` → `localhost:8093`
- **Portal**: Dashboard tile with health dot
- **Monitor**: Health check at port 8093
- **Control**: Start/stop/restart via engine Worker API or dashboard Workers tab

---

## Voice Profiles

Each account maps to a voice file via its `voiceProfile` config field. Located in `tools/email-checker/voices/`:

| File | Account(s) | Tone |
|------|-----------|------|
| `boutabyte-professional.txt` | Default / BoutaByte accounts | Professional, warm, service-oriented |
| `boutabyte-casual.txt` | BoutaByte informal contexts | Casual, approachable BoutaByte voice |
| `dallas-personal.txt` | acc-dalwaut, acc-dallas-pw | Casual, direct, personal (Dallas's voice) |
| `paradise-web-agent.txt` | acc-paradise | Friendly, service-focused (Paradise Web) |
| `client-update.txt` | Client-facing status updates | Polished, structured client communication |

All voice profiles enforce:
- **Plain text only** — no markdown, no bullet lists, no asterisks, no headers. Must look human-written in Gmail.
- 1-3 paragraphs depending on complexity
- No signature blocks (email client appends)
- Never reveals AI/automation

---

## Email Templates

Pre-built email templates for common business workflows, used by ARL structured skills. Located in `tools/email-checker/templates/`:

| Template | ARL Skill | Purpose |
|----------|-----------|---------|
| `proposal.txt` | `send-proposal` | Business/project proposals with scope and pricing |
| `follow-up-sequence.txt` | `send-follow-up` | Multi-touch follow-up sequences |
| `invoice-reminder.txt` | — | Invoice payment reminders |
| `project-status-update.txt` | `send-status-update` | Client project status reports |
| `meeting-request.txt` | `send-meeting-request` | Meeting scheduling requests |
| `onboarding-welcome.txt` | — | New client/user onboarding welcome |

Templates are combined with the active account's voice profile to produce consistent, on-brand emails. The 4 ARL-linked templates can be triggered via email to `agent@paradisewebfl.com` (intent-matched) or manually via the ARL skills API.

---

## Agent Response Loop (ARL)

Autonomous email-triggered research and response pipeline. When a whitelisted sender emails `agent@paradisewebfl.com`, ARL:

1. **Parses intent** — regex patterns match against skill `intentPatterns` + structured block extraction (`Context:`, `Goal:`, `Fix this:`, `Diagnose this:`)
2. **Matches skills** — maps intents to executable skills (direct commands + Claude CLI prompts)
3. **Executes plan** — runs matched skills sequentially (direct first for speed, then Claude)
4. **Synthesizes response** — Claude CLI (haiku model) combines all skill outputs into a professional email
5. **Sends reply** — SMTP via account credentials, marks original as read
6. **Tracks conversation** — 5-minute reply window; follow-ups re-enter the pipeline with context

### Skills System

Five skill types:
- **`direct`** — Shell commands (zero AI cost). E.g., `dig {{domain}} MX`, `systemctl --user list-units`, `journalctl`
- **`claude`** — Prompts piped to `claude -p --model <model> --output-format text`. Template placeholders: `{{sender}}`, `{{subject}}`, `{{body}}`, `{{domain}}`, `{{context}}`, `{{goal}}`
- **`structured`** — Multi-step handlers with internal API calls (prd-intake, create-task, manage-files, generate-report, process-transcript, approve-transcript)
- **`gated`** — Telegram approval gate before execution (system-change)
- **`context-loader`** — Loads prior email chain context (remember-context)

19 built-in skills:

| Skill | Type | Purpose |
|-------|------|---------|
| `diagnose` | claude | Analyze system issues, read logs, trace errors |
| `research` | claude | Research topics in OPAI codebase/wiki |
| `explain` | claude | Explain code, architecture, concepts |
| `codebase-search` | claude | Find files, functions, patterns |
| `service-status` | direct | Check systemd service health |
| `dns-lookup` | direct | Resolve DNS records (MX, A, NS, TXT) |
| `log-analysis` | direct | Recent error/warning log analysis |
| `prd-intake` | structured | Classify email as spec/brief, save to Research/, submit to PRD Pipeline |
| `create-task` | structured | Extract task details via Claude Haiku, POST to Team Hub |
| `manage-files` | structured | List/save files in user workspace |
| `generate-report` | structured | Generate and email status reports |
| `process-transcript` | structured | Analyze meeting transcripts, extract multi-type action items |
| `approve-transcript` | structured | Process approval/rejection of transcript action items |
| `send-proposal` | structured | Send a proposal email using the proposal template |
| `send-follow-up` | structured | Send follow-up sequence emails using the follow-up template |
| `send-status-update` | structured | Send project status update using the status update template |
| `send-meeting-request` | structured | Send meeting request using the meeting request template |
| `system-change` | gated | Queue system changes with Telegram approval |
| `remember-context` | context-loader | Load prior email chain for follow-up processing |

Custom skills added via API (`POST /api/arl/skills`) or directly in `arl-skills.json`. Built-in skills cannot be deleted.

### User Resolver (`user-resolver.js`)

Maps email senders to OPAI user profiles. Each recognized user gets a `userId`, `name`, `role`, `workspace`, and `defaultTeamHubWs`. The `canPerform(user, action)` function gates access to specific skills — all recognized users can use all structured skills; system-change always routes through the Telegram gate.

### Configuration (`arl-skills.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `arlEnabled` | `true` | Master on/off switch |
| `defaultModel` | `sonnet` | Default model for Claude skills |
| `plannerModel` | `haiku` | Model for response synthesis (cheap) |
| `maxSkillsPerRequest` | `5` | Max skills executed per email |
| `replyWindowMinutes` | `5` | Follow-up reply window |
| `fastPollSeconds` | `30` | Email check interval during active conversations |
| `globalTimeout` | `300` | Max total execution time (seconds) |

### Fast-Poll Mode

When ARL sends a reply, a 5-minute conversation window opens. During this window, `index.js` switches from the normal check interval (30min) to 30-second fast-poll. When all conversations expire, it returns to normal. The fast-poll watcher checks every 10s for active conversations via `hasActiveConversations()`.

### ARL API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/arl/config` | ARL configuration (enabled, model, timeouts) |
| `POST` | `/api/arl/toggle` | Enable/disable ARL `{ enabled: bool }` |
| `GET` | `/api/arl/skills` | List all skills |
| `GET` | `/api/arl/skills/:id` | Single skill detail |
| `POST` | `/api/arl/skills` | Add custom skill |
| `PATCH` | `/api/arl/skills/:id/toggle` | Enable/disable skill `{ enabled: bool }` |
| `DELETE` | `/api/arl/skills/:id` | Delete skill (non-builtIn only) |
| `GET` | `/api/arl/conversations` | Active reply windows |
| `GET` | `/api/arl/history` | ARL execution log |

### TUI Dashboard (`tools/opai-arl-tui/`)

Textual 8.x terminal app with 4 tabs:

| Tab | Content |
|-----|---------|
| **Status** | ARL on/off, models, config, agent uptime, recent activity log |
| **Skills** | DataTable of all skills. Keys: `e`=enable, `d`=disable, `x`=delete |
| **Activity** | ARL execution history (time, sender, skills, success, duration) |
| **Conversations** | Active reply windows (sender, turns, remaining time) |

Launch: `./tools/opai-arl-tui/launch.sh`
Global keys: `r`=refresh, `t`=toggle ARL, `1-4`=switch tabs, `q`=quit

---

## Transcript-to-Actionable-Items Agent

Email-triggered meeting transcript processor. Analyzes transcripts sent as attachments or inline text, extracts **multi-type action items**, maps to Team Hub workspaces, and sends approval summaries. Upon approval, executes each action by type. Runs entirely within the ARL skill system — no new services.

### Supported Action Types

| Type | Badge | On Approval |
|------|-------|-------------|
| `task` | `[T]` | Create Team Hub item (workspace → folder → list → item + comment) |
| `quote` | `[Q]` | Generate pricing quote/proposal via Claude Sonnet, email back |
| `research` | `[R]` | Run Claude research, email findings |
| `follow_up` | `[F]` | Create TH task with follow-up date |
| `email` | `[E]` | Draft email via Claude Haiku, queue for review in `approval-queue.json` |

### Data Flow

```
Email with transcript/recording attachment arrives
  → agent-core.js downloadAttachments() extracts MIME content
  → detectAndSaveTranscripts() saves to notes/Transcripts/ or notes/Recordings/
  → sets email._transcriptPath, forces ARL intent to "process-transcript"

ARL skill "process-transcript" fires:
  → Claude Sonnet analyzes transcript → structured JSON (overview + typed items)
  → Queries TH: GET /internal/search-workspaces?q={client_name}
  → Saves pending proposal to data/pending-transcripts/ta-{timestamp}.json
  → Returns typed approval summary (numbered items with [T]/[Q]/[R]/[F]/[E] badges)
  → ARL engine emails summary as reply

User replies "approve all" or "approve 1,3,5" or "reject":
  → arl-intent-parser.js detects pending approval (pre-regex scan)
  → ARL skill "approve-transcript" fires
  → For each approved item, dispatches by type:
    task/follow_up → TH create-folder + create-list + create-item + add-comment
    quote → Claude generates quote doc → included in confirmation email
    research → Claude researches topic → included in confirmation email
    email → Claude drafts → queued to approval-queue.json
  → Updates pending file status → "approved"
  → Sends confirmation email grouped by type
```

### MIME Attachment Download (`downloadAttachments()`)

Parses MIME boundary parts from raw email source. For each part with `Content-Disposition: attachment`:
- Extracts filename (supports `filename="..."`, `filename*=UTF-8''...`, unquoted)
- Extracts Content-Type and Content-Transfer-Encoding
- Decodes content: base64 → `Buffer.from(text, 'base64')`, quoted-printable → `=XX` hex decode

### Transcript Detection (`detectAndSaveTranscripts()`)

Checks each attachment against detection patterns:
- **Text files** (`.txt`, `.md`, `.pdf`, `.docx`): must have transcript keywords in filename OR email subject (`transcript`, `meeting`, `notes`, `minutes`, `recording`, `recap`)
- **Audio files** (`.m4a`, `.mp3`, `.wav`, `.ogg`, `.webm`, `.aac`): always detected, saved to `notes/Recordings/`

Saved with timestamp prefix: `{YYYY-MM-DDTHH-MM-SS}_{original_filename}`

Audio files currently return a "please provide text transcript" response — Whisper integration planned for future.

### Claude Analysis Prompt (process-transcript)

Uses Claude Sonnet with structured JSON extraction. Classifies each extracted item by type:
- **task**: concrete work (build, fix, update, create, deploy)
- **quote**: pricing, estimate, or proposal request
- **research**: information gathering, comparison, analysis
- **follow_up**: revisit/check back at future date
- **email**: contact/notify someone

Returns: `{ overview, client_name, participants, action_items[], key_decisions[] }`

Each action item includes: `type`, `title`, `description`, `priority`, `assignee_hint`, `due_hint`, `follow_up_hint`, `checklist[]`, `category`, `recipient_hint`, `pricing_details`, `research_question`

### Approval Summary Format

```
TRANSCRIPT ANALYSIS — Meeting with Acme Corp

Client: Acme Corp | TH Space: Acme Corp (existing)
Participants: Dallas, John, Sarah

=== 6 ACTION ITEMS ===

[1] [T] Build new landing page for spring campaign
    Priority: high | Assignee: Dallas | Due: March 15
    [ ] Design mockup  [ ] Implement  [ ] QA

[2] [Q] Generate hosting + maintenance quote for Acme
    Pricing mentioned: $150/mo hosting, $75/hr maintenance

[3] [R] Research competitor SEO strategies for Acme's market
    Question: What are top 3 competitors doing for local SEO?

[4] [F] Check back on DNS propagation for acme.com
    Follow-up: March 5

[5] [E] Send John the SSL certificate renewal instructions
    Recipient: john@acmecorp.com

[6] [T] Update WordPress plugins on acme.com
    Priority: medium | Assignee: Dallas

---
ACTIONS: Reply with one of:
  "approve all" — execute all items
  "approve 1,3,6" — execute specific items by number
  "reject" — discard all
  "edit" — reply with corrections
```

### Pending Proposals (`data/pending-transcripts/`)

Each proposal stored as `ta-{timestamp}.json`:

```json
{
  "id": "ta-1709337600000",
  "status": "pending_approval|approved|rejected",
  "sender": "dallas@paradisewebfl.com",
  "senderName": "Dallas",
  "userId": "1c93c5fe-...",
  "subject": "Meeting notes from Acme call",
  "messageId": "<msg-id>",
  "transcriptPath": "/workspace/synced/opai/notes/Transcripts/...",
  "analysis": { "overview": "...", "action_items": [...], ... },
  "thWorkspace": { "id": "...", "name": "Acme Corp" },
  "createdAt": "2026-03-02T...",
  "resolvedAt": "2026-03-02T...",
  "approvedIndices": [1, 3, 6],
  "results": { "tasks": [...], "quotes": [...], "research": [...], "emails": [...] }
}
```

Stale cleanup: files older than 7 days are auto-deleted on agent startup and every 6 hours.

### Team Hub Integration

Two new internal endpoints added to `routes_api.py`:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/internal/search-workspaces?q=<name>&limit=5` | Search workspaces by name (ilike) |
| `POST` | `/api/internal/create-workspace?name=<n>&owner_id=<id>&template=client` | Create workspace with template folders + default statuses |

Template folders:
- **client**: Meeting Action Items, Deliverables, Communications
- **project**: Tasks, Documentation, Research

On approval, the transcript agent creates a folder hierarchy: Workspace → "Meeting Action Items" folder → date-titled list → individual task items with context comments.

---

## Inbox Cleanup (v8)

Product-grade bulk inbox triage tool. Separate view from the daily Live Monitor — toggled via pill switch in the header. Scans **all** emails via IMAP (not day-of-only), categorizes into smart folders, and enables bulk trash/archive/flag operations that sync to real email accounts.

### View Toggle

Pill switch in the header bar: **Live** (default) | **Cleanup**. Switching to Cleanup hides the live stats strip and shows the cleanup view. Switching back restores the live view exactly as it was. State is independent — cleanup doesn't affect the live monitoring pipeline.

### Scan Flow

1. User clicks **Start Inbox Scan** (or **Rescan** in stats bar)
2. `POST /api/cleanup/scan` → `startScan()` launches background IMAP scan
3. IMAP connection opens, fetches envelope metadata (no body) for all emails since `maxAge` (default 5y)
4. Each email is categorized by domain, age, and read status
5. Progress broadcasts via SSE every 200 emails + 2s polling from frontend
6. On completion, results cached in-memory + summary persisted to disk
7. Frontend switches from scan animation to 3-panel layout with categorized folders

Scan options: Include Spam, Include Trash, Scan Depth (6 months / 1 year / 2 years / 5 years / 10 years).

### Smart Folder Categorization

Emails are categorized by domain analysis, not AI (zero cost):

| Category | Key | Rule |
|----------|-----|------|
| All Mail | `all` | Everything scanned |
| Inbox | `inbox` | Emails in INBOX folder |
| Promotions | `promos` | 60+ known promo domains (amazon, target, walmart, etc.) + subject keywords (sale, off, deal, coupon, promo, discount) |
| Newsletters | `newsletters` | 30+ known newsletter domains (substack, mailchimp, etc.) + subject keywords (newsletter, digest, weekly, roundup) |
| Social | `social` | 20+ social platform domains (facebook, linkedin, twitter, etc.) |
| Older than 6mo | `older-6m` | Date > 6 months ago |
| Older than 1yr | `older-1y` | Date > 1 year ago |
| Never Opened | `never-opened` | `\Seen` flag NOT set |

An email can belong to multiple categories (e.g., a promo email that's also never-opened appears in both folders).

### 3-Panel Layout

```
┌──────────┬─────────────────────────────────┬──────────────────┐
│ SIDEBAR  │  EMAIL LIST                     │  PREVIEW         │
│          │  ┌─ Search bar ───────────────┐ │                  │
│ All Mail │  │ 🔍 Search with AI...       │ │  From: ...       │
│ Inbox    │  └───────────────────────────┘ │  Subject: ...    │
│ Promos   │  [Quick filters: chips]        │  Date: ...       │
│ Newsltrs │  ┌─ Bulk bar ─────────────────┐ │                  │
│ Social   │  │ N selected [Trash][Archive]│ │  Body preview    │
│ ─────    │  └───────────────────────────┘ │                  │
│ >6 month │  ☐ 📧 sender@... Subject...   │  [Trash][Archive] │
│ >1 year  │  ☐ 📧 sender@... Subject...   │  [Flag]          │
│ Unopened │  ☐ 📧 sender@... Subject...   │                  │
│          │  [Pagination: ← 1 2 3 ... →]  │                  │
└──────────┴─────────────────────────────────┴──────────────────┘
```

- **Sidebar** (230px): folder list with emoji icons, email counts, active highlight
- **Email Panel** (flex): search bar + quick filter chips + bulk action bar + email list + pagination
- **Preview Panel** (380px): email metadata + body + action buttons. Hidden on screens < 900px.

### Email Row Features

Each row shows: checkbox, gradient avatar (color by category), sender name, subject (truncated), date (relative), category pill badge. On hover: quick action buttons appear (Trash, Archive, Flag).

### Selection & Bulk Actions

- **Individual selection**: checkbox per row
- **Select All**: selects all on current page
- **Bulk bar** (appears when 1+ selected): shows count + Trash / Archive / Flag / Select All buttons + Clear selection
- **Optimistic UI**: rows removed immediately on bulk action; reverted on failure
- Confirmation modal with "Don't ask again" checkbox (session-only)
- **Undo**: toast notification with "Undo" button, 60-second window

### Bulk IMAP Operations

All operations are real IMAP moves executed on the actual email account:

| Operation | IMAP Action | Batch Size |
|-----------|-------------|------------|
| **Trash** | `messageMove()` → `[Gmail]/Trash` | Max 50 UIDs per batch |
| **Archive** | `messageMove()` → `[Gmail]/All Mail` | Max 50 UIDs per batch |
| **Flag** | `messageFlagsAdd()` → `\Flagged` | Max 50 UIDs per batch |

Each operation creates an entry on the undo stack (max 10 operations, 60s expiry per entry). Undo reverses the IMAP move.

### Undo Stack

```javascript
_undoStack = [
  {
    type: 'trash',              // or 'archive', 'flag'
    uids: [12345, 12346, ...],  // UIDs that were moved
    fromFolder: 'INBOX',        // original folder
    toFolder: '[Gmail]/Trash',  // where they went
    accountId: 'acc-dalwaut',
    timestamp: 1709654400000,   // 60s expiry
  }
]
```

### Agentic Search

Natural language queries translated to structured filter criteria by Claude:

1. User types query (e.g., "subscription emails I never open from the last year")
2. `POST /api/cleanup/search` → `agenticSearch(query, accountId)`
3. Sends inbox metadata (total count, category counts, top senders) + query to Claude
4. Claude returns JSON filter groups:
   ```json
   [
     {
       "label": "Unopened subscription emails (last year)",
       "filters": { "read": false, "category": "newsletters", "olderThan": "1y" }
     }
   ]
   ```
5. Filters executed against cached scan data
6. Results displayed as grouped sections with per-group bulk actions (Trash All / Archive All)

Quick filter chips provide one-click searches: "Junk I can delete", "Old promos", "Dead newsletters", "Needs reply", "Stale notifications".

AI provider resolution: checks `ANTHROPIC_API_KEY` first (direct Anthropic API), falls back to `OPENROUTER_API_KEY`.

### Email Preview

Click any email row → preview panel shows:
- From, Subject, Date, Folder
- Full email body fetched via IMAP (`mailparser` for HTML→text conversion)
- Attachment list (name + size)
- Action buttons: Trash, Archive, Flag

### Stats Bar

Always visible at top of cleanup view:
- **Total**: scanned email count
- **Cleaned**: emails trashed/archived this session
- **Flagged**: emails flagged this session
- **Progress bar** (during scan): real-time percentage
- **Rescan** button: triggers new scan

### Cleanup API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/cleanup/scan` | Start inbox scan `{ includeSpam, includeTrash, maxAge }` |
| `POST` | `/api/cleanup/cancel` | Cancel active scan |
| `GET` | `/api/cleanup/status` | Scan state (active, progress, error, hasCachedData) |
| `GET` | `/api/cleanup/folders` | Folder counts `{ folders, scannedAt, totalEmails }` |
| `GET` | `/api/cleanup/emails` | Paginated emails `?category=&page=&pageSize=&sortBy=` |
| `GET` | `/api/cleanup/preview/:uid` | Full email body + attachments `?folder=` |
| `POST` | `/api/cleanup/trash` | Bulk trash `{ uids, folder }` → IMAP move |
| `POST` | `/api/cleanup/archive` | Bulk archive `{ uids, folder }` → IMAP move |
| `POST` | `/api/cleanup/flag` | Bulk flag `{ uids, folder }` → IMAP flag |
| `POST` | `/api/cleanup/undo` | Undo last operation (60s window) |
| `POST` | `/api/cleanup/search` | Agentic search `{ query }` → AI-filtered results |

All endpoints accept `accountId` via query param or request body (falls back to active account).

### Elevated Theme

The cleanup view uses an elevated dark theme (`cleanup.css`) distinct from the base app:
- **Background**: `#07080d` (deeper than base)
- **Surfaces**: `#0e1018` with glassmorphic borders (`rgba(255,255,255,0.06)`)
- **Accent**: `#7c6cf0` (purple) for active states, buttons, pills
- **Avatar gradients**: color-coded by category (pink=promo, blue=newsletter, green=social, purple=default)
- **Category pills**: accent-colored badges with transparent backgrounds
- **Skeleton loading**: shimmer animation matching row layout
- **Responsive**: preview hidden < 900px, sidebar hidden < 700px

### Cache Architecture

- **In-memory**: `_cache[accountId] = { emails[], scannedAt, folders{}, senderStats{} }` — full email metadata for the scanned account. Lost on service restart.
- **Disk**: `data/cleanup-summary-{accountId}.json` — folder counts + top 50 senders. Survives restarts for quick status display.
- Scan data persists across view switches (Live ↔ Cleanup) within the same service uptime.

### SSE Events

| Event | Data | When |
|-------|------|------|
| `cleanup-progress` | `{ processed, total, percent }` | Every 200 emails during scan |
| `cleanup-complete` | `{ total, folders }` | Scan finished |
| `cleanup-action` | `{ type, count }` | After bulk trash/archive |

---

## CLI Email Checker (`cli-check.js`)

On-demand email checking from Claude Code or terminal. Bypasses the agent service — connects directly via IMAP.

```bash
# Check all enabled accounts (today only)
node tools/opai-email-agent/cli-check.js

# Check specific account (matches on id, name, or email — partial, case-insensitive)
node tools/opai-email-agent/cli-check.js --account paradise
node tools/opai-email-agent/cli-check.js --account dalwaut

# Look back N days
node tools/opai-email-agent/cli-check.js --account paradise --days 7

# Fetch ALL unseen (no date filter)
node tools/opai-email-agent/cli-check.js --account paradise --all

# Search by sender name/address or subject
node tools/opai-email-agent/cli-check.js --account paradise --search "denise"
node tools/opai-email-agent/cli-check.js --search "delivery failure"

# Read full email body by UID
node tools/opai-email-agent/cli-check.js --account paradise --read 82
```

Output shows: UID, date, from, subject for each email. `--read` mode displays full headers + body text.

Account matching: `--account paradise` matches `acc-paradise` (id contains "paradise"). `--account dal` matches `acc-dalwaut`. `--account gmail` matches any account with "gmail" in the email.

---

## Dependencies on email-checker

Imports from `../email-checker/`:
- `classifier.js` — `classifyEmail(from, subject, body, accountName)`
- `response-drafter.js` — `draftResponse()` (returns responseId string), `getResponse()`, `loadResponses()`, `approveResponse()`
- `sender.js` — `sendResponse()`, `saveDraftToAccount()`, `removeDraftFromAccount()`, `applyTagsToAccount()`, `moveToTrash()`, `moveToFolder()`, `forwardEmail()`

These modules use env vars with different prefixes. `setEnvBridgeForAccount(account)` resolves credentials from the target account (inline or envPrefix) and maps them to standard env var names before calling shared modules. `setEnvBridge()` (no param) falls back to the active account for backwards compatibility with audit-server compose/approve actions.

**Important**: `draftResponse()` returns a **string** (responseId), not an object. Use `getResponse(responseId)` to get the full draft data (`{ refinedDraft, initialDraft, critique, subject, to, ... }`).

---

## Known Gotchas

- **Day-of-only is the default**: `fetchEmails()` uses `{ seen: false, since: todayMidnight }`. This prevents catastrophic performance on large inboxes (dalwaut Gmail: 60K total, 54K+ unseen → 37min cycles → ETIMEOUT crashes). Only use `fetchAll: true` when explicitly pulling all history.
- **IMAP SINCE is date-only**: The IMAP `SINCE` criterion ignores time — it uses the date portion only. `since: new Date()` with hours set to 0 gives today's emails. This is fine because `processed.json` dedup prevents re-processing.
- **IMAP two-step EPIPE**: Pass search criteria directly to `client.fetch({ seen: false, since: ... }, ...)`. Separate `client.search()` + `client.fetch(results)` races and crashes with EPIPE.
- **ETIMEOUT handling**: `index.js` catches `ETIMEOUT` as a transient error (alongside EPIPE/ECONNRESET/ECONNREFUSED). Without this, IMAP socket timeouts on large inboxes crash the entire process.
- **Multi-account log prefix**: All log actions include `[AccountName]` prefix in reasoning (e.g. `[Paradise Web Agent] Whitelist gate: ...`). Essential for distinguishing which account an action belongs to.
- **`activeAccountId` is UI-only**: The monitoring loop uses `getEnabledAccounts()`, not `activeAccountId`. Switching the active account in the UI does NOT change which accounts are monitored — it only changes which account's settings/compose/whitelist the UI shows.
- **processed.json format**: Now `{ entries: [{id, processedAt}] }`. Old `{ ids: [] }` migrated on first write. `isProcessed()` handles both formats during migration window.
- **email-meta.json backfill**: Pre-existing emails (before metadata store was added) have entries with `backfilled: true` and empty `bodyPreview`/`attachments`. Full data only on emails processed after 2026-02-21.
- **messageId URL encoding**: `GET /api/email-meta/:messageId` — message IDs contain `<`, `>`, `@`. Must be `encodeURIComponent()`-encoded by the client; server decodes with `decodeURIComponent()`.
- **Action log is day-scoped**: `getActions()` reads today first, then falls back to archives. "0 emails" in UI despite history = archive not being read. Never revert to today-only reads.
- **Classify details are objects not strings**: `details.classification` is `{tags:[], priority, urgency, ...}` — not a string. UI `renderActionDetails()` extracts tags/summary from this structure and renders pills, not raw JSON.
- **SSE reconnects automatically**: `EventSource` reconnects on drop. No manual retry needed. Polling (15s status, 60s emails/queue) serves as fallback if SSE is unavailable.
- **`draftResponse()` returns a string**: Returns `responseId` (string), NOT a draft object. Must call `getResponse(responseId)` to get `{ refinedDraft, initialDraft, critique, subject, to, ... }`. Treating the return as an object silently produces wrong data.
- **`saveDraftToAccount()` requires env bridge**: `setEnvBridgeForAccount(account)` must be called before `saveDraftToAccount()` since it reads `process.env.IMAP_*`. The env prefix parameter should be `''` (empty string) when env vars are already bridged.
- **Blacklist/whitelist mutual exclusion data split**: Whitelist lives in `config.json`, blacklist lives in `data/classifications.json`. The mutual exclusion functions cross-import to maintain consistency.
- **Settings drawer race**: `refreshStatus()` runs every 15s. Settings inputs are not overwritten while drawer is `.open` (guarded by `classList.contains('open')`).
- **Auto-refresh vs expanded state**: `loadEmails()` skips re-render when `_expandedEmail !== null`. `loadActivity()` skips when `_expandedActivity !== null`. `loadQueue()` skips when `_editingQueue` has entries. All preserved across refresh cycles.
- **interval hot-reload**: `PATCH /api/settings` calls `agentRef.restart()` only when `checkIntervalMinutes` actually changed. Other field changes don't restart the loop.
- **Whitelist add is live**: `POST /api/whitelist/add` writes `config.json` immediately. Effective on the next cycle — no restart.
- **Queue uid+folder required**: Items must store `uid` and `folder` at queue-time — not recoverable from message-ID alone. Both auto-send and approve paths use these for `markEmailSeen`.
- **Password preservation on PATCH**: `updateAccount()` preserves existing IMAP/SMTP passwords when the update payload omits `pass` or sends empty string. Frontend `_gatherCredFields()` only includes `pass` if the user typed something. Never accidentally wipes credentials.
- **Delete last account blocked**: Backend `deleteAccount()` returns false if `accounts.length <= 1`. Frontend also guards with an alert. Auto-switches `activeAccountId` to first remaining account after delete.
- **JSDoc comment gotcha**: Never put `*/` inside a `/** */` comment block (e.g., file paths with glob patterns). Closes the comment and causes SyntaxError. Use `//` line comments for paths.
- **Cleanup scan vs live fetch**: Cleanup scans ALL emails (envelope-only, since `maxAge`), while live monitoring uses day-of-only + UNSEEN. They are completely independent IMAP operations on separate connections.
- **Cleanup cache is accountId-scoped**: `_cache[accountId]` means switching accounts in the UI requires a new scan. The frontend reads `_activeAccountId` from app.js and passes it in all API calls.
- **Stale process holds port**: If the systemd service fails to bind port 8093 (e.g., stale orphan process), routes return 404 even though the code is correct. Check `ss -tlnp | grep 8093` and verify PID matches `systemctl --user show opai-email-agent --property=MainPID`. Kill stale process if mismatched.
- **Gmail folder names**: Cleanup uses `[Gmail]/Trash` and `[Gmail]/All Mail` for IMAP moves. These are Gmail-specific — other providers use different names (e.g., `Trash`, `Archive`). Currently hardcoded.
- **Agentic search requires API key**: `agenticSearch()` checks `ANTHROPIC_API_KEY` then `OPENROUTER_API_KEY`. Without either, falls back to basic keyword search (no AI grouping).
- **Undo expiry is server-side**: The 60s undo window is enforced in `cleanup-scanner.js` — expired entries return `{ error: 'Undo window expired' }`. The frontend toast auto-dismisses after ~8s but the backend window is 60s.

---

## Performance History

| Date | Change | Before | After |
|------|--------|--------|-------|
| 2026-02-24 | Day-of-only + multi-account | 54K emails / 37min cycle / ETIMEOUT crash | 23 emails / 1.5min for 2 accounts |

---

## Development State (2026-03-05)

### Feature Status

| Feature | Status | Notes |
|---------|--------|-------|
| Multi-account monitoring | **Complete** | 2 active accounts (Paradise, Dallas Personal) |
| Whitelist gate | **Complete** | Per-account, mutual exclusion with blacklist |
| Blacklist gate | **Complete** | Per-account, Step 0 in pipeline, IMAP trash move |
| Manual trash + Undo | **Complete** | Immediate IMAP move, pattern recording, undo support |
| Auto-trash (pattern learning) | **Complete** | Sender 3+/domain 5+ → 48h delay → IMAP move |
| Auto-trash rescue | **Complete** | Override in pending trash section, unlearns patterns |
| Custom classifications | **Complete** | Create/delete, assign/unassign, color-coded |
| Pattern learning (understandings) | **Complete** | Sender/domain/tag frequency → auto-suggestions |
| Classification suggestions | **Complete** | Suggestion pills on email cards, click to assign |
| Classify dropdown + tag input | **Complete** | Inline tag creation, existing classifications list |
| Needs Reply checkbox | **Complete** | Flags email in assignment |
| Needs Action panel | **Complete** | Move to folder, delete after N time, forward, TeamHub task |
| Recompose with guidance | **Complete** | Modal with textarea, re-drafts via Claude Haiku |
| Gmail draft save | **Complete** | Draft saved to Gmail Drafts via IMAP APPEND |
| Gmail draft cleanup on send | **Complete** | `removeDraftFromAccount()` after Approve & Send |
| Action bar / feedback bar swap | **Complete** | Correct bar shown based on email outcome state |
| Outcome badges with undo | **Complete** | Hoverable `×` for trashed/classified, resets to skipped |
| ARL (Agent Response Loop) | **Complete** | 19 skills (incl. 4 template-based send skills), 5-min conversations, fast-poll |
| Feedback system | **Complete** | 6 rule types, draft corrections, prompt injection |
| CLI checker | **Complete** | On-demand search/read from terminal |
| MIME attachment download | **Complete** | Base64/QP content extraction from raw email source |
| Transcript Agent | **Complete** | Multi-type action items, TH integration, approval gate |
| Audio recording detection | **Partial** | Files saved; Whisper transcription not yet integrated |
| Inbox Cleanup — scan + categorize | **Complete** | Full IMAP envelope scan, 8 smart folder categories |
| Inbox Cleanup — 3-panel UI | **Complete** | Sidebar, email list, preview panel, responsive |
| Inbox Cleanup — bulk operations | **Complete** | Trash/archive/flag with IMAP sync, optimistic UI |
| Inbox Cleanup — undo | **Complete** | Last 10 ops, 60s window, stack-based reversal |
| Inbox Cleanup — agentic search | **Complete** | Claude-powered NL → structured filters, grouped results |
| Inbox Cleanup — elevated theme | **Complete** | Glassmorphism dark theme, gradient avatars, category pills |
| Inbox Cleanup — view toggle | **Complete** | Live/Cleanup pill switch, independent state |

### Known Issues (Active)

- **Browser autofill on search**: Wrapped in `<form autocomplete="off">` — fragile, browsers may ignore. DO NOT remove the form wrapper.
- **Voice profile**: All 5 voice profiles now present (`boutabyte-professional`, `boutabyte-casual`, `dallas-personal`, `paradise-web-agent`, `client-update`). If a new account references a missing profile, the default `boutabyte-professional` is used.
- **Audio transcription**: Audio files (m4a/mp3/wav/ogg/webm/aac) are saved but require manual text transcript — Whisper integration planned.
- **Cleanup scan is per-account**: scan data cached by `accountId`. Switching accounts in the UI doesn't carry over scan results — must rescan for the new account.
- **Cleanup cache is in-memory**: scan results (full email list) are lost on service restart. Only the summary (folder counts + top senders) persists to disk.

### Recent Changes (v8 Session — 2026-03-05)

1. Created `cleanup-scanner.js` — IMAP bulk scan engine with domain categorization, in-memory cache, disk-persisted summaries
2. Added 8 smart folder categories: all, inbox, promos (60+ domains), newsletters (30+ domains), social (20+ domains), older-6m, older-1y, never-opened
3. Added bulk IMAP operations: `bulkTrash()`, `bulkArchive()`, `bulkFlag()` with batching (max 50 UIDs)
4. Added undo stack: last 10 operations, 60s expiry, `undoLastOperation()` reverses IMAP moves
5. Added agentic search: `agenticSearch()` → Claude NL parsing → structured filter groups → cached data query
6. Added `getEmailPreview()` with `mailparser` for full body + attachment extraction
7. Added 12 cleanup API routes to `audit-server.js` (`/api/cleanup/*`)
8. Created `static/js/cleanup.js` — full cleanup frontend: scan flow, folder sidebar, email list with selection, preview panel, bulk actions, agentic search, confirm modal, toast with undo
9. Created `static/css/cleanup.css` — elevated dark theme with glassmorphism, gradient avatars, category pills, skeleton loading, responsive breakpoints
10. Added view toggle (Live/Cleanup) to `index.html` header, wrapped existing content in `#live-view`
11. Added `mailparser` dependency to `package.json`
12. Added SSE events: `cleanup-progress`, `cleanup-complete`, `cleanup-action`

### Recent Changes (v6 Session — 2026-03-02)

1. Added `downloadAttachments()` to `agent-core.js` — MIME content extraction (base64/QP)
2. Added `detectAndSaveTranscripts()` — saves text to `notes/Transcripts/`, audio to `notes/Recordings/`
3. Added transcript detection hook in `processEmail()` pipeline (before ARL intercept)
4. Added `process-transcript` and `approve-transcript` skill definitions to `arl-skills.json`
5. Added both to `HIGH_PRIORITY_SKILLS` in `arl-intent-parser.js`
6. Added persistent approval detection (pre-regex scan for pending proposals)
7. Added `runProcessTranscriptSkill()` — Claude analysis, TH workspace search, proposal save, typed summary
8. Added `runApproveTranscriptSkill()` — dispatch by type (task/quote/research/follow_up/email)
9. Added `thRequest()` helper for TH internal API calls
10. Added `process-transcript` and `approve-transcript` to `canPerform()` in `user-resolver.js`
11. Added `GET /internal/search-workspaces` and `POST /internal/create-workspace` to Team Hub
12. Added stale proposal cleanup (7-day TTL) in `index.js`
13. Added `transcript-processing` capability to email-manager in `workers.json`

### Previous Changes (v5 Session — 2026-02-27)

1. Created `blacklist-gate.js` — mirrors whitelist pattern, mutual exclusion
2. Created `classification-engine.js` — trash tracking, custom classifications, pattern learning, scheduled deletes
3. Added `moveToTrash()`, `moveToFolder()`, `forwardEmail()` to `sender.js`
4. Added blacklist check (Step 0), trash pattern check (Step 2.5), classification suggestions (Step 3.5) to pipeline
5. Added delayed auto-trash processing and scheduled delete processing to `runCycle()`
6. Added 10+ new API endpoints (blacklist, trash, classifications, recompose)
7. Added Blacklist sidebar, Pending Trash section, Classifications sidebar to UI
8. Added Blacklist/Trash/Classify/Recompose buttons on email cards
9. Added classify dropdown with tag input + Needs Action panel (4 action types)
10. Fixed `draftResponse()` return type handling (string, not object)
11. Added `saveDraftToAccount()` call in recompose flow
12. Added `removeDraftFromAccount()` call in approve flow
13. Fixed modal double-submit prevention and guaranteed close
14. Fixed action bar / feedback bar swap based on email state changes

---

## Backlog

| Priority | Enhancement |
|----------|-------------|
| Medium | Whisper integration for audio transcript processing (m4a/mp3/wav → text) |
| ~~Medium~~ | ~~Dallas personal voice profile~~ — **Done** (5 voice profiles + 6 email templates shipped) |
| Medium | UI multi-account inbox view (show emails from all accounts, filtered by account) |
| Low | Transcript approval UI in audit-server (approve/reject from web, not just email) |
| Low | Pending trash count badge in controls sidebar |
| Low | Stats sparkline / 7-day trend in stats strip |
| Low | Multi-folder IMAP support for live view (currently INBOX only; cleanup scans all) |
| Low | Email search across all archived days (live view) |
| Medium | Cleanup: non-Gmail IMAP folder name resolution (currently hardcoded `[Gmail]/Trash`, `[Gmail]/All Mail`) |
| Medium | Cleanup: persistent scan results across service restarts (currently in-memory only) |
| Low | Cleanup: per-sender bulk actions ("delete all from this sender") |
| Low | Cleanup: export cleaned email stats / report |
| Low | Auto-suggest whitelist for repeated unknown senders |
| Low | Parallel account checking (currently sequential — low priority since cycles are fast now) |
