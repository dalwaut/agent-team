# OPAI Email Agent
> Last updated: 2026-02-27 (v5 — Blacklist, Trash, Classifications, Recompose) | Source: `tools/opai-email-agent/`

Multi-account autonomous email agent. Monitors **all enabled accounts simultaneously** each cycle, classifies, tags, drafts, and (optionally) auto-sends responses. Each account has its own mode, whitelist, blacklist, permissions, credentials, and voice profile. **Day-of-only by default**: only fetches today's unseen emails unless explicitly asked to pull all (prevents 54K+ email fetches on large inboxes). Full account lifecycle: create via onboarding, configure credentials in sidebar, delete with confirmation. Strict whitelist ensures only approved senders are interacted with. CLI tool for on-demand email checking from Claude Code.

> **v2 (2026-02-25)**: The email agent is now an **engine-managed process**. Instead of running as a standalone systemd service (`opai-email-agent`), it is spawned directly by the Engine's WorkerManager via `subprocess.Popen`. Benefits: unified log capture (500-line ring buffer), auto-restart on crash, vault env injection, start/stop from dashboard Workers tab. The `opai-email-agent.service` systemd unit has been disabled.

> **v5 (2026-02-27)**: Added **Blacklist** (immediate IMAP trash move), **Trash Classification** (manual trash + AI auto-trash with 48h delay), **Custom Classifications** (user-created categories with pattern learning), **Recompose** (re-draft with guidance, saves to Gmail Drafts), and **Needs Action** system (move to folder, scheduled delete, forward, TeamHub task creation). All per-account.

**Agent Response Loop (ARL)**: Whitelisted emails to `agent@paradisewebfl.com` trigger an autonomous research pipeline — intent parsing, skill execution (shell commands + Claude CLI), response synthesis, and auto-reply. 5-minute reply window with 30s fast-poll for follow-up conversations. Pluggable skills system with 7 built-in skills (diagnose, research, explain, codebase-search, service-status, dns-lookup, log-analysis). TUI dashboard for monitoring and skills management.

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
  │                           ARL intercept: checks shouldProcessArl() before normal pipeline
  │                           Account-aware: getCredentialsForAccount(), setEnvBridgeForAccount()
  │                           processEmail() extracted for per-email pipeline
  │                           markEmailSeen(), storeEmailMeta(), pruneOldProcessed()
  │                           fetchThreadEmail(), addAlert(), loadAlerts()
  ├─ arl-engine.js         — ARL pipeline orchestrator: parseIntent → match skills →
  │                           executePlan → synthesize response → send reply → track conversation
  │                           shouldProcessArl() gate (ARL enabled + paradise account)
  │                           synthesizeResponse() via Claude CLI (haiku model)
  │                           Fallback response if synthesis fails
  ├─ arl-intent-parser.js  — Two-tier intent detection:
  │                           1. Regex scan against skill intentPatterns (zero AI cost)
  │                           2. Structured context extraction (Context:, Goal:, Fix:, Diagnose:)
  │                           Domain extraction for dns-lookup skill
  │                           Confidence: 0.6 single match → 0.95 with Goal/Context blocks
  ├─ arl-skill-runner.js   — Skill execution engine:
  │                           "direct" = shell command via execSync (zero AI cost)
  │                           "claude" = prompt piped to `claude -p` via spawn
  │                           executePlan() runs direct first (fast), then claude (slow)
  │                           CRUD: addSkill(), toggleSkill(), deleteSkill()
  ├─ arl-conversation.js   — Active conversation tracker (5-min TTL):
  │                           In-memory Map: sender → { threadId, lastActivity, turns }
  │                           hasActiveConversations() triggers fast-poll mode
  │                           Persistent ARL log (data/arl-log.json)
  ├─ arl-skills.json       — Skills config: 7 built-in + custom skills
  │                           arlEnabled, defaultModel, plannerModel, maxSkillsPerRequest
  │                           replyWindowMinutes (5), fastPollSeconds (30)
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
  ├─ audit-server.js       — Express REST API + SSE broadcast + groupActions helper
  │                           ARL API: /api/arl/config, /api/arl/toggle, /api/arl/skills,
  │                           /api/arl/skills/:id/toggle, /api/arl/conversations, /api/arl/history
  │                           Blacklist API: /api/blacklist, /api/blacklist/add, /api/blacklist/remove
  │                           Trash API: /api/trash, /api/trash/pending, /api/trash/:id/override
  │                           Classifications API: /api/classifications (CRUD + assign/unassign)
  │                           Recompose API: /api/recompose (re-draft with guidance → Gmail + queue)
  ├─ cli-check.js          — CLI email checker (on-demand, any account, search, read)
  ├─ config.json           — Multi-account config: accounts[], enabled, mode, permissions, whitelist
  ├─ .env                  — Legacy IMAP/SMTP creds (envPrefix accounts); new accounts store creds inline
  ├─ static/               — Inbox-style moderation UI
  │    ├─ index.html       — Full layout, modals (compose, classify-test, recompose), all CSS
  │    │                      Blacklist sidebar, Pending Trash section, Classifications sidebar
  │    └─ js/app.js        — All UI logic: SSE client, alert banner, inbox, queue,
  │                           activity, feedback, compose, classify-test, bulk actions,
  │                           blacklist/trash/classify buttons on email cards,
  │                           classify dropdown with tag input + needs action panel,
  │                           recompose with draft guidance modal
  └─ data/                 — Persistent state
       ├─ action-log.json       — Current day's log (auto-rotated at midnight)
       ├─ agent-state.json      — Kill flag, rate limit counters, timestamps
       ├─ feedback.json         — Feedback rules + draft corrections
       ├─ approval-queue.json   — Drafts awaiting human approval (with uid + folder)
       ├─ processed.json        — Dedup tracker: { entries: [{id, processedAt}] }
       ├─ alerts.json           — Urgent/attention email alerts (dismissible)
       ├─ email-meta.json       — Email metadata store (body preview, attachments)
       ├─ classifications.json  — Per-account: blacklist, trash patterns, custom classifications
       ├─ arl-log.json          — ARL execution history (persistent, capped at 200)
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
- `response-drafter.js` — 3-step draft-critique-refine loop (returns responseId string)
- `sender.js` — SMTP send, IMAP draft save/remove, tag application, moveToTrash, moveToFolder, forwardEmail

---

## Three Operating Modes

| Mode | Classify | Tag (IMAP) | Draft | Send |
|------|----------|------------|-------|------|
| **Suggestion** | Yes | Yes | No | No |
| **Internal** | Yes | Yes | Yes (to queue) | No |
| **Auto** | Yes | Yes | Yes | Yes (rate-limited) |

- Default mode is **Suggestion** (safety first)
- Admin must explicitly opt into Internal or Auto via the segmented mode control
- Mode buttons have hover tooltips explaining each mode's capabilities
- IMAP tags are applied in all modes (non-destructive metadata)
- Auto mode is rate-limited (default 5 sends/hour, adjustable in Settings)
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
      "permissions": { "classify": true, "tag": true, ... },
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
   - Classify Emails, Tag Emails, Organize Inbox, Draft Responses, Send Emails, Move Emails
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
        { "emailId": "<msg>", "sender": "news@example.com", "subject": "Weekly", "tags": ["newsletter"], "assignedAt": "..." }
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
| `tag` | AI-generated tag frequency across assignments | 2+ occurrences |

**Confidence** = `matchCount / totalAssignments`. Suggestions require confidence ≥ 0.3.

### How It Works

1. **Assign** — User assigns email to a classification (via Classify dropdown or suggestion pill click)
2. **Rebuild** — `rebuildUnderstandingsInPlace()` recalculates all sender/domain/tag patterns from assignments
3. **Suggest** — **Step 3.5** in `processEmail()` calls `suggestClassifications()` which checks all classification understandings against the current email's sender, domain, and tags
4. **Display** — Suggestion pills appear on email cards (color-coded, shows confidence %). Click to assign.

### Classify Dropdown (UI)

Click **Classify** button on email card → dropdown menu with:
1. **Tag input** — type a name + Enter or `+` button → creates classification on the fly if new, then assigns
2. **Existing classifications** — list of all classifications with color dots. Click to assign.
3. **Needs Reply** checkbox — flags email as needing a reply
4. **Needs Action** expandable panel (see below)

### Needs Action System

When classifying, user can attach actions to the assignment:

| Action | Description | Execution |
|--------|-------------|-----------|
| **Move to Folder** | IMAP move to specified folder | Immediate via `moveToFolder()` |
| **Delete After** | Schedule deletion after N days/weeks/months | Cron via `scheduleDelete()`, processed each `runCycle()` |
| **Forward To** | Forward email to an address | Immediate via `forwardEmail()` (sends as .eml attachment) |
| **Create TeamHub Task** | Create a task linked to the email | `POST /hub/api/internal/create-item` on localhost:8089 |

Actions are collected from the expandable panel checkboxes/inputs and sent with the assign request. The server executes them immediately (move/forward/task) or schedules them (delete).

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
   - Calls `draftResponse()` (3-step: initial → critique → refine via Claude Haiku)
   - Calls `saveDraftToAccount()` → saves draft to **Gmail Drafts folder via IMAP**
   - Adds to approval queue → appears in Queue tab
   - Logs `draft` action → appears in email's activity timeline
5. Draft is now visible in:
   - Gmail app / webmail (as a draft ready to send)
   - Email Agent Queue tab (Approve & Send / Edit / Reject)

### Approve & Send

When admin approves from Queue tab:
1. Sends via SMTP
2. Marks source email as `\Seen` in IMAP
3. Removes the Gmail draft (cleanup via `removeDraftFromAccount()`)

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
│         ├─ Skip if already in processed.json (dedup by messageId)
│         ├─ ARL intercept (if enabled + paradise account)
│         ├─ Step 1: checkSenderForAccount()   — account-specific whitelist gate
│         ├─ Step 2: Classify (AI via Claude CLI, Haiku model)
│         │    └─ If urgency=urgent or needsUserAttention → addAlert()
│         ├─ Step 2.5: checkTrashPatterns()    — sender 3+ / domain 5+ → autoTrash (48h delay)
│         ├─ Step 3: Tag (IMAP labels via setEnvBridgeForAccount())
│         ├─ Step 3.5: suggestClassifications() — check understandings → store suggestions in meta
│         ├─ Mode check:
│         │    ├─ Suggestion: log suggestion, mark processed, done
│         │    ├─ Internal: fetchThreadEmail(id, account) → draft → queue
│         │    └─ Auto: fetchThreadEmail() → draft → rate-limit → send or queue
│         │         └─ On send: markEmailSeen(uid, folder, account) → mark processed
│         └─ Log action with [AccountName] prefix in reasoning
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
      "tags": ["urgent", "client"],
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
- Dropdown values (`classify`, `tag`, `draft`, `send`, `skip`) map to outcome strings (`classified`, `tagged`, `draft`, `sent`, `skipped`)
- Search filters by sender or subject
- **Hide Skipped** button (top-right of filter bar) — client-side filter, hides all skipped cards from the current view

Actions grouped by `emailId` into email cards. Each card shows avatar, sender name + address, subject, tag pills, outcome badge, action count. Click to expand →

**Expanded card sections (in order):**

1. **Email Content panel** — collapsible, lazy-loaded from `/api/email-meta/:messageId`
   - Shows: From · To · Subject · Date · Body preview (first 600 chars with scroll) · Attachment chips (📎 filename, name only — no download)
   - "Loading..." shown on first expand, then cached — no repeat fetches
   - Falls back to "Content not available" if metadata missing

2. **Action timeline** — colored dot per action, reasoning at each step
   - `classify` actions: shows tag pills extracted from classification (not raw JSON)
   - `suggest` actions: shows agent's decision text / summary (not raw JSON)
   - `draft` actions: shows draft guidance and preview
   - `blacklist`, `manual-trash`, `auto-trash`, `trash-undo`, `classify-undo` actions: shows reasoning
   - Other actions: shows full details JSON

3. **Draft preview** (if draft exists)

4. **Action bar** (unprocessed / skipped / un-classified emails):
   - **Blacklist** (red) → confirm modal → IMAP trash + blacklist add
   - **Trash** (red) → confirm modal → IMAP trash + pattern learn
   - **Classify** → dropdown with tag input, existing classifications, Needs Reply, Needs Action panel
   - **Recompose** (green) → guidance modal → re-draft → Gmail + queue

5. **Whitelist row** (skipped cards only): `+ Address` | `+ @domain` | `Recompose`

6. **Feedback form** + **Recompose button** (pipeline-processed cards: classified/tagged/draft/sent/error):
   - Left: type dropdown + text input → `Save`
   - Right: Recompose button

7. **Recompose only** (trashed / custom-classified cards): bottom-right Recompose button

**Outcome badges** support hoverable `×` for undo on trashed and custom-classified states → clicking resets to `skipped` and re-renders the action bar.

**Classification suggestion pills** appear below the action bar when `classificationSuggestions` exist in email metadata — color-coded, shows confidence %, click to assign.

### Tag Pill Color Map

| Tag Pattern | Color |
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
| Tagged | Purple | `Tagged` | — |
| Draft Pending | Yellow | `Draft` | — |
| Sent | Green | `Sent` | — |
| Error | Red | `Error` | — |
| Blacklisted | Red | `Blacklisted` | — |
| Trashed | Red | `Trashed` | Hoverable `×` → undo trash |
| Auto-Trash | Yellow | `Auto-Trash` | Rescue from pending trash |
| cls:Name | Blue + color dot | Classification name | Hoverable `×` → unassign |

Outcome priority (highest wins): skip(1) < blacklisted/trashed/auto-trash(2) < classify(3) < tag(4) < draft(6) < send(7) < error(8). Undo actions (`trash-undo`, `classify-undo`) always reset to `skipped`.

### Queue Tab

Split-view cards: left = email summary, right = draft. Actions: **Approve & Send** · **Edit** (inline textarea) · **Reject**.

**Clear All** button (top-right) rejects all pending items at once via `POST /api/bulk/clear-queue`.

Approve sends via SMTP, marks source email `\Seen` in IMAP, and removes the Gmail draft (cleanup). Queue items store `uid` + `folder` at creation time. Recompose-generated drafts also save to Gmail Drafts folder via IMAP — visible in Gmail app/webmail.

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
| GET | `/api/emails` | Actions grouped by emailId — `?date=YYYY-MM-DD` |
| GET | `/api/actions` | Flat action log — `?limit=&filter=&date=` |
| GET | `/api/actions/:id` | Single action detail |
| POST | `/api/actions/:id/feedback` | Add typed feedback to action `{ comment, type, sender }` |
| GET | `/api/email-meta/:messageId` | Email metadata (from, subject, body preview, attachments) |
| GET | `/api/queue` | Approval queue `?status=pending` |
| POST | `/api/queue/:id/approve` | Approve and send, marks source \Seen |
| POST | `/api/queue/:id/reject` | Reject draft |
| POST | `/api/queue/:id/edit` | Edit draft text, records correction |
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
| POST | `/api/classifications/:id/assign` | Assign email + execute Needs Action actions |
| POST | `/api/classifications/:id/unassign` | Unassign (undo classification) |
| POST | `/api/recompose` | Re-draft with guidance → Gmail draft + approval queue |
| POST | `/api/check-now` | Trigger immediate cycle + SSE broadcast |
| GET | `/api/auth/config` | Supabase config for frontend |

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
      "tags": ["client", "action-required"],
      "outcome": "draft",
      "draft": "Thank you for the update..."
    }
  ]
}
```

**Action priority**: skip(1) < blacklist/manual-trash/auto-trash(2) < classify(3) < tag/suggest/organize(4) < queue(5) < draft(6) < send(7) < error(8). **Outcome priority** (separate): classified(0) < skipped(1) < blacklisted/trashed/auto-trash(2) < tagged(4) < draft(6) < sent(7) < error(8). Undo actions (`trash-undo`, `classify-undo`) always force outcome to `skipped`.

Tag extraction handles: `details.classification.tags[]`, `details.tags[]`, `details.labels[]`, `details.category`, string `details.classification`.

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

## Safety Guarantees

1. **Whitelist is non-bypassable** — gate runs before ANY action, including classification
2. **Blacklist overrides everything** — Step 0, runs before whitelist/ARL/classification
3. **Auto-trash has 48h delay** — user can rescue before IMAP move; override unlearns patterns
4. **Blacklist/whitelist mutual exclusion** — adding to one removes from the other
5. **Auto mode rate-limited** — default 5/hour, adjustable from UI without restart
6. **Kill button halts immediately** — in-memory flag, audit server stays alive
7. **Default is suggestion** — must explicitly opt into Internal or Auto
8. **Every action logged with reasoning** — full audit trail + daily archives
9. **Feedback loop** — admin comments become rules without code changes
10. **markEmailSeen is non-blocking** — IMAP failures never block a send
11. **fetchThreadEmail is non-blocking** — IMAP failures silently return null; draft proceeds without thread context
12. **storeEmailMeta is pre-gate** — even skipped/rejected emails get a metadata record
13. **SSE failures are silent** — `broadcastSSE` catches all write errors; a dropped client never affects the pipeline
14. **Gmail draft save is non-blocking** — `saveDraftToAccount()` failures are logged but don't block queue creation
15. **Recompose double-submit prevention** — modal callback nulled before execution, confirm button disabled during processing

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

## Voice Profile

Located at `voices/paradise-web-agent.txt`. Defines tone, structure, style for all drafts:
- Professional, warm, service-oriented
- 2-3 paragraphs max
- No signature blocks (email client appends)
- Never reveals AI/automation

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

Two skill types:
- **`direct`** — Shell commands (zero AI cost). E.g., `dig {{domain}} MX`, `systemctl --user list-units`, `journalctl`
- **`claude`** — Prompts piped to `claude -p --model <model> --output-format text`. Template placeholders: `{{sender}}`, `{{subject}}`, `{{body}}`, `{{domain}}`, `{{context}}`, `{{goal}}`

7 built-in skills: `diagnose`, `research`, `explain`, `codebase-search`, `service-status`, `dns-lookup`, `log-analysis`

Custom skills added via API (`POST /api/arl/skills`) or directly in `arl-skills.json`. Built-in skills cannot be deleted.

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

---

## Performance History

| Date | Change | Before | After |
|------|--------|--------|-------|
| 2026-02-24 | Day-of-only + multi-account | 54K emails / 37min cycle / ETIMEOUT crash | 23 emails / 1.5min for 2 accounts |

---

## Development State (2026-02-27)

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
| ARL (Agent Response Loop) | **Complete** | 7 skills, 5-min conversations, fast-poll |
| Feedback system | **Complete** | 6 rule types, draft corrections, prompt injection |
| CLI checker | **Complete** | On-demand search/read from terminal |

### Known Issues (Active)

- **Browser autofill on search**: Wrapped in `<form autocomplete="off">` — fragile, browsers may ignore. DO NOT remove the form wrapper.
- **Voice profile**: `dallas-personal` not found warning in logs — only `paradise-web-agent` voice file exists. Dallas account recompose uses default voice.

### Recent Changes (v5 Session — 2026-02-27)

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
| Medium | Dallas personal voice profile (`voices/dallas-personal.txt`) |
| Medium | UI multi-account inbox view (show emails from all accounts, filtered by account) |
| Low | Pending trash count badge in controls sidebar |
| Low | Stats sparkline / 7-day trend in stats strip |
| Low | Multi-folder IMAP support (currently INBOX only) |
| Low | Email search across all archived days |
| Low | Auto-suggest whitelist for repeated unknown senders |
| Low | Parallel account checking (currently sequential — low priority since cycles are fast now) |
