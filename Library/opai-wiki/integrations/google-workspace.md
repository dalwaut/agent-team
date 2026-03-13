# Google Workspace Integration

> **Status:** Phases 1–3 Live + Domain-Wide Delegation (7 scopes, updated 2026-03-10)
> **Account:** agent@paradisewebfl.com (primary), any @paradisewebfl.com via delegation
> **Project ID:** opai-workspace-agent (opai-487916)
> **Shared Drive:** OPAI Agent-Space
> **Agent Workspace Folder:** `1i2usqWNFXQ03OyWOkqt2gNfuUpiu-lPA`

---

## Overview

OPAI's agent account has full Google Workspace API access — Drive, Gmail, Docs, Sheets, Calendar, Chat — through OAuth2 user-flow authentication. The agent operates as a real team member: reading docs, responding to @agent commands in doc comments, answering questions in Google Chat, and making direct edits to documents in supervised co-edit sessions.

Additionally, **domain-wide delegation** allows OPAI to access any @paradisewebfl.com user's Gmail, Drive, and Calendar — enabling cross-user inbox checks, Drive searches, and more without per-user OAuth flows.

**Design principle:** Two auth paths — OAuth2 user flow for agent@'s full capabilities (11 scopes), service account delegation for cross-user read/send access (4 scopes).

---

## Architecture

Three access paths — **GWS CLI** for interactive sessions, **Python class** for background automation, **delegation** for cross-user access:

```
Interactive — agent@ (Claude Code sessions):
    Claude Code CLI ──shell──> gws <service> <resource> <method> [flags]
                                    │
                                    └── ~/.config/gws/credentials.json (refresh token from opai-vault)
                                    └── Covers: Drive, Gmail, Calendar, Sheets, Docs, Slides, Chat, Tasks

Interactive — cross-user (any @paradisewebfl.com):
    Claude Code CLI ──shell──> ./scripts/gws-as <user@> <gws args...>
                                    │
                                    └── Mints delegated token via google_auth.get_delegated_token()
                                    └── Passes to GWS CLI via GOOGLE_WORKSPACE_CLI_TOKEN env var
                                    └── Covers: Gmail read/send/drafts/modify, Drive read, Calendar read/write

Background automation (Engine port 8080):
    tools/shared/google_workspace.py  ← async Python class (23+ methods)
        ├── imports tools/shared/google_auth.py
        │       ├── get_access_token()         → agent@ OAuth (refresh token from vault)
        │       └── get_delegated_token(user)   → SA delegation (JSON key from vault)
        ├── as_user=None → agent@ OAuth (default, all background tasks)
        ├── as_user="dallas@..." → SA delegation (cross-user access)
        └── httpx async calls to googleapis.com

Engine background loops (all use agent@ OAuth, unaffected by delegation):
    ├── workspace_chat.py        → Fast loop (30s) — Chat poller, intent router, skill dispatch
    ├── workspace_mentions.py    → Cron (2 min) — Doc comment @agent commands
    ├── workspace_coedit.py      → Cron (2 min) — Activity-gated co-editing sessions
    ├── chat_skills.py           → Skill handlers (find_file, research, teamhub, coedit, newsletter)
    ├── workspace_agent.py       → Cron (daily) — Folder audit
    └── knowledge_refresher.py   → Cron (02:30 daily) — Business context builder for chat prompts
```

**Migration note (v3.5→v3.6):** The custom MCP server (`mcps/google-workspace/server.py`) was archived to `mcps/_archived/google-workspace/`. It's replaced by the [GWS CLI](https://github.com/googleworkspace/cli) (`@googleworkspace/cli` on npm) which covers all previous tools plus Calendar, Sheets, Slides, and Gmail attachments. Background tasks are unaffected — they import `google_workspace.py` directly.

---

## Phase Roadmap

| Phase | Name | Status | Capabilities |
|-------|------|--------|-------------|
| **1** | Read-Only Observer | **Live** | Drive read/search/list, Gmail read/search, sandboxed writes to Agent Workspace, daily folder audit |
| **2** | Contributor | **Live** | Doc comments (list/add/reply/resolve), @agent command system (7 commands), Google Chat integration (spaces/messages) |
| **2.5** | Smart Contributor | **Live** | Chat intent router (13 intents), two-tier research (quick Claude + deep NLM), 30-second fast loop, immediate acknowledgment, sender resolution chain, DM fallback chain, gap detection + Telegram notification, daily agent newsletter, Drive reference context |
| **3** | Co-Editor | **Live** | Direct doc edits via Docs API batchUpdate, activity-gated sessions (join/leave), 10-min human activity timeout, revision-based activity detection, co-edit commands in both doc comments and Chat |
| **4** | Autonomous Member | Planned | Push notifications, Calendar awareness, cross-system sync, template factory, Sheets formulas |

---

## Phase 1 — Read-Only Observer

### GWS CLI Commands (Interactive)

```bash
# Drive
gws drive files list --params '{"pageSize": 10, "supportsAllDrives": true, "includeItemsFromAllDrives": true}'
gws drive files get --params '{"fileId": "ID", "supportsAllDrives": true}'
gws drive files list --params '{"q": "name contains \"report\"", "supportsAllDrives": true, "includeItemsFromAllDrives": true}'

# Gmail
gws gmail users messages list --params '{"userId": "me", "q": "has:attachment", "maxResults": 10}'
gws gmail users messages get --params '{"userId": "me", "id": "MSG_ID"}'

# Gmail attachments (NEW — key capability)
gws gmail users messages attachments get --params '{"userId": "me", "messageId": "MSG_ID", "id": "ATT_ID"}' --output /tmp/attachment.pdf

# Calendar (NEW)
gws calendar calendarList list
gws calendar events list --params '{"calendarId": "primary", "maxResults": 10}'

# Sheets (NEW)
gws sheets spreadsheets get --params '{"spreadsheetId": "SHEET_ID"}'
gws sheets spreadsheets values get --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1:D10"}'
```

### Legacy MCP Tools (archived)

The following tools were provided by the custom MCP server (now archived to `mcps/_archived/google-workspace/`):

| Tool | Purpose | GWS CLI Equivalent |
|------|---------|-------------------|
| `drive_list` | List files in folder | `gws drive files list` |
| `drive_read` | Read file content | `gws drive files get` + `export` for Google Docs |
| `drive_search` | Search Shared Drive | `gws drive files list --params '{"q": "..."}'` |
| `drive_write` | Create file (Agent Workspace only) | `gws drive files create --upload` |
| `drive_get_metadata` | File metadata | `gws drive files get --params '{"fields": "..."}'` |
| `gmail_search` | Search inbox | `gws gmail users messages list --params '{"q": "..."}'` |
| `gmail_read` | Read full email | `gws gmail users messages get` |

### Daily Folder Audit

- **Schedule:** `0 23 * * *` daily
- **Handler:** `tools/opai-engine/background/workspace_agent.py`
- Checks: stale files (30+ days), naming inconsistencies, storage usage, type distribution
- Posts findings to HITL Telegram topic (thread 112) with approve/dismiss buttons

---

### Drive Changes API & Differential Scanner

Efficient daily monitoring of all 6 shared drives using Google Drive's Changes API — fetches only files that changed since the last scan instead of re-scanning everything.

#### How It Works

```
First run: drive_get_start_token() → saves pageToken to state file
Daily run: drive_get_changes(pageToken) → fetches delta → classifies → updates state
           │
           ├── Classifies: added / modified / trashed / removed
           ├── Resolves which shared drive each file belongs to
           ├── Appends changelog to Library/knowledge/ParadiseWebFL-Structure.md
           └── Updates state with new pageToken for next run
```

#### API Methods (google_workspace.py)

| Method | Purpose |
|--------|---------|
| `drive_get_start_token()` | Initialize change tracking — returns first pageToken |
| `drive_get_changes(page_token, page_size?)` | Fetch incremental changes since token (handles pagination) |

Both methods use `supportsAllDrives=true` + `includeItemsFromAllDrives=true` to cover all 6 shared drives in a single call.

#### Standalone CLI Scanner

```bash
# First run — initialize token:
python3 scripts/drive-scanner.py --init

# Daily differential scan:
python3 scripts/drive-scanner.py

# Preview changes without updating state:
python3 scripts/drive-scanner.py --dry-run

# Force full re-init + scan:
python3 scripts/drive-scanner.py --full
```

**Output:** Updates `Library/knowledge/ParadiseWebFL-Structure.md` changelog table + prints summary to stdout.

#### State Persistence

State file: `tools/opai-engine/data/drive-scan-state.json`

```json
{
  "page_token": "1394",
  "initialized_at": "2026-03-05T08:04:14Z",
  "last_scan": "2026-03-05T08:09:26Z",
  "total_scans": 5,
  "total_changes_seen": 2
}
```

The `page_token` is the key — Google's Changes API returns a new token after each poll, ensuring each scan only fetches the delta since the previous one. Typically 1 API call per scan (vs ~200 for a full rescan).

#### Shared Drive Coverage

| Drive | ID | Type |
|-------|----|------|
| Everglades IT (PW Drive) | `0APYzOzcV0MYMUk9PVA` | Primary business |
| Lace & Pearl | `0AMVyn7WIA5AoUk9PVA` | Client brand |
| OPAI Agent-Space | `0AI_12gJkvppNUk9PVA` | Agent workspace |
| Pioneers of Personal Development | `0ANXUNX1ug79DUk9PVA` | Content project |
| Visit Everglades City | `0AG6Kc-7mKN54Uk9PVA` | Client site (2000+ files) |
| WellFit Girls | `0ALNVJFcS2Gf7Uk9PVA` | Fitness brand |

Full structure map: `Library/knowledge/ParadiseWebFL-Structure.md`

#### MCP Tool: drive_scan_changes

Available in the `google-workspace` MCP server. Self-contained — loads state, fetches changes, updates state, returns formatted summary. No arguments needed.

---

## Phase 2 — Contributor (Doc Comments + Chat)

### Doc Comment API

| Method | Purpose |
|--------|---------|
| `docs_list_comments(file_id)` | List unresolved comments on a file |
| `docs_add_comment(file_id, content)` | Add a new comment |
| `docs_reply_comment(file_id, comment_id, content)` | Reply to a comment thread |
| `docs_resolve_comment(file_id, comment_id)` | Mark comment as resolved |

### @agent Doc Comment Commands

Polled every 2 minutes via `workspace_mentions.py`. Triggered by `@agent` or `agent@paradisewebfl.com` mentions in unresolved comments.

| Command | Action |
|---------|--------|
| `@agent review` | Full document review — clarity, structure, completeness |
| `@agent summarize` | Concise summary with key points and action items |
| `@agent fact-check` | Flag inaccurate/unsupported claims |
| `@agent format` | Suggest structure/formatting improvements |
| `@agent draft [topic]` | Draft content for a section |
| `@agent rewrite [text]` | Rewrite selected text for clarity |
| `@agent research [topic]` | Research a topic, post findings |

### Google Chat Integration

Polled every **30 seconds** via dedicated fast loop in `workspace_chat.py` (not cron). Messages sent as agent@paradisewebfl.com (user auth, not bot).

- **DMs:** Respond to all messages (no @agent prefix needed)
- **Spaces/Groups:** Only respond when "agent" is mentioned
- **Identity:** Locked-down business persona — never reveals internal systems, OPAI, file paths, etc.
- **Acknowledgment:** Immediate "Got it, [name] — working on that now..." before slower Claude/skill processing
- **Self-detection:** Skips own messages via `AGENT_USER_RESOURCE_NAME` (user resource ID) + sent message ID tracking
- **Safety cap:** Max 3 messages processed per space per poll cycle

### Sender Resolution Chain

Chat API with user auth doesn't return `sender.email` or `sender.displayName`. Resolution order:

1. Chat API sender fields (rarely populated)
2. In-memory member cache (TTL: 1 hour)
3. Chat API membership lookup (requires `chat.memberships.readonly` scope)
4. DM mapping file (`data/chat-dm-mapping.json`) — manually seeded + auto-populated
5. Fallback: email local part or "someone"

### DM Reply Fallback Chain

When a DM send fails (403), the fallback chain fires (each step tried once):

1. **DM setup** — `chat_setup_dm()` joins the DM space (requires `chat.spaces.create` scope)
2. **Retry DM send** — if setup succeeded
3. **Agent Work space** — post with `@username` prefix in shared space
4. **Gmail** — email the user via `gmail_send()`
5. **Telegram notification** — always notify Dallas about DM permission issues

### Trust Model

| Source | Level | Access |
|--------|-------|--------|
| Dallas (dallas@paradisewebfl.com, dalwaut@gmail.com) | Full | All commands including system/infra queries |
| paradisewebfl.com / wautersedge.com / boutabyte.com | Domain | Business commands only |
| External emails | Blocked | No response |
| Agent (self) | Skip | Never responds to own comments |

System/infrastructure queries (server, credentials, IP, config files) are blocked for non-Dallas users.

---

## Phase 2.5 — Smart Contributor (Intent Router + Skills)

### Chat Intent Router

Messages classified via regex fast-path (no AI call for known patterns):

| Intent | Trigger Patterns | Handler |
|--------|-----------------|---------|
| `find_file` | "find", "locate", "where is", "link to" | `skill_find_file` → Drive search, return clickable links |
| `research` | "research", "investigate", "report on" | `skill_research_doc` → Quick Claude research → in-chat + optional Google Doc |
| `deep_research` | "deep research", "in-depth research", "research report" | `skill_deep_research` → NLM web research + grounded Q&A → Google Doc + in-chat |
| `teamhub_query` | "my tasks", "assigned to me", "what am I working on" | `skill_teamhub_query` → Supabase query via team_assignments |
| `teamhub_create` | "create task", "new task", "add task" | `skill_teamhub_create` → Creates item + auto-assigns |
| `teamhub_update` | "mark done", "update task", "complete task" | `skill_teamhub_update` → Status change by title fragment |
| `quoting` | "quote", "estimate", "pricing" | Stub — "being set up with Denise" |
| `folder_template` | "client folder", "new client" | Stub — "being finalized" |
| `coedit_activate` | "join [doc]", "co-edit [doc]" | Activate co-edit session on a document |
| `coedit_deactivate` | "leave", "stop editing" | Deactivate co-edit session |
| `coedit_status` | "co-edit status", "active sessions" | List active co-edit sessions |
| `newsletter_send` | "send newsletter" | Send pending announcements (Dallas-only) |
| `newsletter_status` | "newsletter status" | Show pending/sent count |
| `doc_command` | review, summarize, etc. | Reuses Phase 2 processing |
| `free_form` | Everything else | Claude Haiku Q&A with business identity |

### Two-Tier Research

| Tier | Trigger | Backend | Speed | Output |
|------|---------|---------|-------|--------|
| **Quick** | "research X", "look into X" | Claude Haiku (direct call) | ~10s | In-chat delivery + Google Doc (when folder ID set) |
| **Deep** | "deep research X", "in-depth research X", "research report on X" | NotebookLM web research → grounded Q&A → Claude fallback | ~30-60s | In-chat (truncated) + Google Doc with full report |

Deep research uses `nlm.research_topic()` to discover and import real web sources into the "OPAI Research" notebook, then asks NLM for a structured analysis grounded in those sources. Falls back to Claude if NLM is unavailable or produces insufficient results (<200 chars).

### Gap Detection

Unrecognized requests logged to `data/chat-gaps.json` + Telegram HITL notification. Gaps feed into capability expansion planning.

### Daily Agent Newsletter

- **Schedule:** `0 7 * * *` (7 AM daily)
- **Three data sources** (sends when ANY has content):
  1. **Feature announcements** — `tools/opai-engine/data/feature-announcements.json` entries with `"announced": false`
  2. **Git capability commits** — `feat:` commits in last 48h touching workspace/chat/teamhub files
  3. **Daily activity** — TeamHub actions from Chat + capability gaps
- Announcements render as color-coded sections with emoji icons, feature bullet points, and CTA footer
- Marks announcements `"announced": true` after sending (won't repeat)
- **Recipients:** Default Dallas + Denise; announcements can specify additional recipients
- **SMTP:** Loads credentials from vault runtime (`/run/user/.../opai-vault/opai-email-agent.env`)
- **Bypass:** Classified as lightweight task — skips `max_parallel_jobs` gate (won't get deferred)

### Newsletter Skill (On-Demand)

| Channel | Command | Action |
|---------|---------|--------|
| Telegram | `/newsletter send` | Send pending announcements now |
| Telegram | `/newsletter preview` | Show headlines + recipients |
| Telegram | `/newsletter list` | All announcements with sent/pending status |
| Google Chat | `"send newsletter"` | Send pending (Dallas-only) |
| Google Chat | `"newsletter status"` | Pending/sent count |
| Engine API | `POST /api/newsletter/send` | Trigger send via resident scheduler |
| Engine API | `GET /api/newsletter/preview` | HTML preview + metadata |
| Engine API | `POST /api/newsletter/create` | Create new announcement entry |
| Engine API | `GET /api/newsletter/list` | List all announcements |

### Creating Announcements

Add to `tools/opai-engine/data/feature-announcements.json`:

```json
{
  "id": "2026-03-04-my-feature",
  "date": "2026-03-04",
  "announced": false,
  "headline": "Feature Name",
  "subheadline": "One-line description",
  "sections": [
    {"title": "Section Name", "icon": "chat|tasks|docs|coedit|teamhub|default", "items": ["Bullet 1", "Bullet 2"]}
  ],
  "footer": "Call to action text",
  "recipients": ["Dallas@paradisewebfl.com", "Denise@paradisewebfl.com"]
}
```

The 7 AM cron picks it up, sends, and marks as delivered.

### Business Knowledge Context (v3.6)

The chat agent loads a nightly-refreshed business context file into every prompt, giving it awareness of team members, client workspaces, HELM businesses, WordPress sites, and client abbreviations — without burning tokens on dynamic lookups.

#### Architecture

```
Nightly (02:30)                         Chat Prompt (every message)
┌──────────────────────┐                ┌─────────────────────────────┐
│ knowledge_refresher  │   writes →     │ workspace_chat.py           │
│   .py                │                │   CHAT_IDENTITY (tone)      │
│                      │                │   + business-context.md     │ ← 2KB cap
│ Queries Supabase:    │                │   + drive-reference.md      │ ← 4KB cap
│ - profiles           │                │   + conversation history    │
│ - workspaces         │                │   + command context         │
│ - helm_businesses    │                └─────────────────────────────┘
│ - wp_sites           │
└──────────────────────┘
```

#### What It Provides

- **Client abbreviations**: VEC, PW, BB, WE, MDH, MSDS → full names
- **Systems glossary**: "Team Hub = task management", "HELM = business runner", etc.
- **Team roster**: Active members with roles (from `profiles` table)
- **Workspace list**: Shared workspaces (from `workspaces` table, non-personal)
- **HELM businesses**: Active businesses with stage (from `helm_businesses`)
- **WordPress sites**: Site names, URLs, status (from `wp_sites`)

#### Files

| File | Purpose |
|------|---------|
| `tools/opai-engine/background/knowledge_refresher.py` | Nightly Supabase queries → compact markdown builder |
| `tools/shared/business-context.md` | Output file, loaded by `_load_business_context()` in workspace_chat.py |
| `tools/opai-engine/data/knowledge-refresher-state.json` | Run state (last run time, counts) |

#### Chat Identity Improvements (v3.6)

The `CHAT_IDENTITY` prompt was rewritten alongside this feature:

- **Direct tone**: No filler phrases ("Great question!", "Absolutely!"). No emojis.
- **Count precision**: When user asks "top 3 tasks" → return exactly 3 items.
- **Business vocabulary**: Baked-in knowledge of Team Hub, HELM, client codes.
- **Count limit extraction**: `_extract_query_filters()` now parses "top N" / "first N" / "N tasks" patterns and caps `skill_teamhub_query()` output to exactly that many items.

#### Schedule

- **Cron**: `30 2 * * *` (02:30 AM, after consolidator at 01:00 and daily_evolve at 02:00)
- **Lightweight task**: Bypasses `max_parallel_jobs` gate
- **No AI calls**: Pure Supabase REST queries + string formatting
- Seed file at `tools/shared/business-context.md` provides immediate context before first nightly run

---

## Phase 3 — Co-Editor (Activity-Gated Sessions)

### Concept

The agent can make **direct edits** to Google Docs alongside human collaborators. Co-edit is session-based — users activate it per document, and it auto-deactivates after 10 minutes of no human activity. All edits tracked via Google's built-in revision history.

### Session Lifecycle

```
User: "@agent join" (doc comment) or "join Q2 Plan" (Chat)
  → Agent activates session, records revision baseline
  → Confirms: "Co-edit active. Say @agent edit <instruction> to make changes."

User edits document normally...
  → Every 2 min: scheduler checks Drive revisions API
  → Human revision found → reset 10-min timer

User stops editing (goes idle)...
  → After 10 min with no human revision → auto-deactivate
  → Agent posts doc comment: "Co-edit deactivated — no activity for 10 min"
  → Telegram HITL notification sent

User can resume later:
  → "@agent join" re-activates cleanly
```

### Doc Comment Commands

| Command | Action |
|---------|--------|
| `@agent join` | Activate co-edit on this document |
| `@agent leave` | Deactivate co-edit (manual) |
| `@agent edit <instruction>` | Make a specific edit (requires active co-edit) |

### Chat Commands

| Pattern | Intent | Handler |
|---------|--------|---------|
| "join [doc]", "co-edit [doc]", "start editing [doc]" | `coedit_activate` | Search Drive → activate session |
| "leave [doc]", "stop editing", "end co-edit" | `coedit_deactivate` | Find matching session → deactivate |
| "co-edit status", "active sessions", "editing what" | `coedit_status` | List all active sessions with durations |

### Edit Execution Flow

```
1. Check is_coedit_active(doc_id) → must be True
2. Get doc structure via docs_get_content_structure(doc_id)
   → Returns paragraphs with text + startIndex/endIndex
3. Send to Claude Haiku:
   "Given the document structure and user's instruction,
    determine exact edit operations. Return JSON array."
4. Parse response → list of edit operations
5. Apply via docs_edit_text(doc_id, edits)
   → Docs API batchUpdate (insertText / replaceAllText / deleteContentRange)
6. Update agent activity timestamp
7. Reply with summary of what changed
```

### Session State

Stored in `tools/opai-engine/data/coedit-sessions.json`:

```json
{
  "sessions": {
    "<doc_id>": {
      "doc_id": "abc123",
      "doc_title": "Q2 Marketing Plan",
      "doc_type": "document",
      "activated_by": "dallas@paradisewebfl.com",
      "activated_at": "2026-03-04T14:00:00Z",
      "last_human_edit": "2026-03-04T14:05:00Z",
      "last_agent_edit": null,
      "status": "active",
      "revision_baseline": "42"
    }
  }
}
```

### Activity Timeout Config

In `config/orchestrator.json`:

```json
"coedit": {
  "enabled": true,
  "timeout_minutes": 10,
  "max_concurrent_sessions": 5,
  "activity_check_interval": "*/2 * * * *"
}
```

### Docs API Methods (Phase 3)

Added to `tools/shared/google_workspace.py`:

| Method | Purpose |
|--------|---------|
| `docs_edit_text(doc_id, edits)` | Apply text edits via Docs API batchUpdate (insert/replace_all/delete) |
| `docs_get_revisions(doc_id, page_size)` | Get recent revisions (Drive revisions API) for activity detection |
| `docs_get_content_structure(doc_id)` | Get paragraph text + startIndex/endIndex for edit targeting |

### Guard Rails

- **Co-edit not active:** `@agent edit` without `join` → "Co-edit isn't active. Say @agent join first."
- **Ambiguous doc search:** Multiple matches → "Which one?" with numbered list
- **Max sessions:** `max_concurrent_sessions: 5` in config
- **Human gate:** Edits only happen when humans are actively present (10-min activity window)

---

## Domain-Wide Delegation (Cross-User Access)

> **Status:** **Live** (deployed 2026-03-10)
> **Service Account:** `opai-delegated@opai-workspace-agent.iam.gserviceaccount.com`
> **Client ID:** `114347983836775882406`
> **GCP Project:** `opai-workspace-agent`

### Overview

Domain-wide delegation lets OPAI access **any @paradisewebfl.com mailbox** (dallas@, denise@, etc.) without managing separate OAuth tokens per user. A single service account credential impersonates domain users via Google's delegation mechanism. No additional Workspace licenses or user accounts required — the SA is free.

**Key distinction:** This is additive — all existing agent@ OAuth flows remain untouched.

### Architecture

```
Two auth paths — existing OAuth (agent@) and new delegation (any domain user):

OAuth2 User Flow (existing, unchanged):
    google_auth.get_access_token()
        └── Refresh token from vault → access token for agent@paradisewebfl.com
        └── 11 scopes (Drive, Gmail, Docs, Sheets, Calendar, Chat)
        └── Used by: all background tasks, Chat integration, doc commands

Domain-Wide Delegation (new):
    google_auth.get_delegated_token("dallas@paradisewebfl.com")
        └── SA JSON key from vault → mint token impersonating target user
        └── 4 scopes (Gmail read/send, Drive read, Calendar read)
        └── Used by: cross-user CLI access (gws-as), Python as_user= param

GWS CLI wrapper:
    ./scripts/gws-as dallas@paradisewebfl.com gmail users messages list ...
        └── Mints delegated token via Python
        └── Passes to GWS CLI via GOOGLE_WORKSPACE_CLI_TOKEN env var
```

### Delegation Scopes (7 total)

```
https://www.googleapis.com/auth/gmail.readonly      # Read any user's inbox
https://www.googleapis.com/auth/gmail.send           # Send as any user
https://www.googleapis.com/auth/gmail.compose        # Create drafts as any user
https://www.googleapis.com/auth/gmail.modify         # Label, archive, mark read/unread
https://www.googleapis.com/auth/drive.readonly       # Read any user's Drive
https://www.googleapis.com/auth/calendar.readonly    # Read any user's calendar
https://www.googleapis.com/auth/calendar.events      # Create/edit calendar events
```

**Why fewer than OAuth?** Delegation grants only what's needed for cross-user access. Chat, Docs editing, and Drive writes stay on agent@'s OAuth flow where they belong.

### Setup (Completed 2026-03-10, scopes expanded 2026-03-10)

1. **GCP Console** — Created `opai-delegated` SA in `opai-workspace-agent` project with domain-wide delegation enabled. JSON key downloaded.
   - Required temporarily overriding org policy `iam.disableServiceAccountKeyCreation` (re-enabled after key creation)

2. **Workspace Admin Console** (`admin.google.com` → Security → Access and data control → API controls → Manage Domain Wide Delegation):
   - Client ID: `114347983836775882406`
   - Scopes (7): `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.compose,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/calendar.events`

3. **Vault storage:**
   ```python
   # How it was stored (for reference if key needs rotation):
   import sys; sys.path.insert(0, 'tools/opai-vault')
   import store
   store.set_secret('google-workspace-sa-key', open('key.json').read().strip())
   ```

### Python API

```python
from google_auth import get_delegated_token, invalidate_delegated_cache

# Mint token for any domain user
token = await get_delegated_token("dallas@paradisewebfl.com")

# Custom scopes (optional — defaults to 4 delegation scopes)
token = await get_delegated_token("denise@paradisewebfl.com", scopes=["https://..."])

# Clear cache
invalidate_delegated_cache("dallas@paradisewebfl.com")  # one user
invalidate_delegated_cache()                              # all users
```

Via `GoogleWorkspace` class — use `as_user` parameter:

```python
from google_workspace import GoogleWorkspace
ws = GoogleWorkspace()

# Read dallas's unread emails
msgs = await ws.gmail_search("is:unread", as_user="dallas@paradisewebfl.com")

# Read a specific message
msg = await ws.gmail_read("MSG_ID", as_user="dallas@paradisewebfl.com")

# Send as denise
await ws.gmail_send("client@example.com", "Subject", "Body", as_user="denise@paradisewebfl.com")

# Search denise's Drive
files = await ws.drive_search("budget 2026", as_user="denise@paradisewebfl.com")

# Default (no as_user) → agent@ OAuth, unchanged
msgs = await ws.gmail_search("is:unread")
```

### GWS CLI Wrapper

```bash
# Check dallas's inbox
./scripts/gws-as dallas@paradisewebfl.com gmail users messages list \
  --params '{"userId":"me","maxResults":5}'

# Search denise's unread
./scripts/gws-as denise@paradisewebfl.com gmail users messages list \
  --params '{"userId":"me","q":"is:unread"}'

# List dallas's Drive files
./scripts/gws-as dallas@paradisewebfl.com drive files list \
  --params '{"pageSize":10}'

# Default GWS CLI (agent@) still works exactly as before
gws gmail users messages list --params '{"userId":"me","maxResults":1}'
```

### Token Cache

- Per-user cache keyed by `email|scopes` with 55-min TTL
- Thread-safe (shared lock, same pattern as OAuth cache)
- `invalidate_delegated_cache()` to force re-mint

### Safety

- **Domain lock:** Only `@paradisewebfl.com` users — raises `ValueError` for any other domain
- **Scope limitation:** Delegation scopes are a subset of OAuth scopes — no Chat, no Docs write, no Drive write
- **No background task impact:** All background loops use agent@ OAuth (`as_user` defaults to `None`)
- **Audit trail:** All API calls through `GoogleWorkspace` are logged regardless of auth method

### Vault Key

| Key | Contents |
|-----|----------|
| `google-workspace-sa-key` | Service account JSON key (entire file contents) |

### Troubleshooting

| Issue | Fix |
|-------|-----|
| `ValueError: Delegation only allowed for @paradisewebfl.com` | Only domain users can be impersonated |
| `RuntimeError: Service account key not found in vault` | Store SA JSON key: `import-env.py --credential google-workspace-sa-key --value "$(cat key.json)"` |
| 403 on delegation token mint | Check Admin Console delegation: correct Client ID? Correct scopes? Wait 5-15 min for propagation. |
| 403 on API call with delegated token | Scope mismatch — the API you're calling requires a scope not in the delegation list |
| Token works for agent@ but not dallas@ | Delegation scopes are different from OAuth scopes — delegation has 4, OAuth has 11 |

---

## Phase 4 — Autonomous Member (Planned)

| Capability | Description |
|------------|-------------|
| Push notifications | Webhook-based instead of polling (requires Google Cloud Pub/Sub) |
| Calendar awareness | Read team calendars, suggest meeting times, block focus time |
| Cross-system sync | TeamHub ↔ Sheets sync, Drive → Brain knowledge import |
| Template factory | Auto-create client folders from templates, populate boilerplate docs |
| Sheets formulas | Write/update formulas in Google Sheets (not just text) |
| Suggestion mode | Optional: use Docs suggestion mode instead of direct edits |

---

## Files

| File | Purpose |
|------|---------|
| `tools/shared/google_auth.py` | OAuth2 token management (refresh, cache, one-time auth CLI) |
| `tools/shared/google_workspace.py` | Async API wrapper — Drive, Gmail, Docs, Sheets, Chat (23 methods incl. `drive_get_start_token`, `drive_get_changes`, `chat_get_member`, `chat_setup_dm`, `gmail_send`) |
| `mcps/_archived/google-workspace/server.py` | **Archived** — FastMCP stdio server (replaced by GWS CLI) |
| `tools/opai-engine/background/workspace_agent.py` | Daily folder audit cron task |
| `tools/opai-engine/background/workspace_mentions.py` | @agent doc comment poller (10 commands) |
| `tools/opai-engine/background/workspace_chat.py` | Google Chat fast-loop poller (30s) + intent router (13 intents) |
| `tools/opai-engine/background/chat_skills.py` | Chat skill handlers (13 skills incl. deep_research, newsletter send/status) |
| `tools/opai-engine/.env` | Static env config — `GOOGLE_AGENT_WORKSPACE_FOLDER_ID` (secrets come from vault) |
| `tools/opai-engine/data/chat-dm-mapping.json` | DM space → user mapping (manual seed + auto-populated) |
| `tools/opai-engine/routes/newsletter.py` | Newsletter API (send/preview/create/list) |
| `tools/opai-engine/data/feature-announcements.json` | Pending + sent announcement entries |
| `tools/opai-engine/background/workspace_coedit.py` | Co-edit session manager (10 functions) |
| `tools/shared/drive-reference.md` | Shared Drive structure reference (loaded as Chat context) |
| `tools/shared/business-context.md` | Nightly-refreshed business context (team, workspaces, sites — loaded as Chat context) |
| `tools/opai-engine/background/knowledge_refresher.py` | Nightly business context builder (Supabase queries → markdown) |
| `scripts/drive-scanner.py` | Standalone differential scanner CLI (--init, --dry-run, --full) |
| `scripts/gws-as` | Cross-user GWS CLI wrapper via domain-wide delegation |
| `tools/opai-engine/data/drive-scan-state.json` | Persistent Changes API state (pageToken, scan count) |
| `Library/knowledge/ParadiseWebFL-Structure.md` | Full Drive structure map with changelog (auto-updated by scanner) |

---

## Credentials

All credentials stored in opai-vault (SOPS+age encrypted):

| Vault Key | Contents |
|-----------|----------|
| `google-workspace-client-secret` | OAuth2 client configuration (client_id, client_secret, etc.) |
| `google-workspace-refresh-token` | OAuth2 refresh token for agent@paradisewebfl.com |
| `google-workspace-sa-key` | Service account JSON key for domain-wide delegation |

**Access tokens** cached in-memory only (55-min TTL, never persisted to disk).

### One-Time Auth Flow

```bash
# 1. Run auth script (opens browser, sign in as agent@paradisewebfl.com)
python3 tools/shared/google_auth.py /path/to/client_secret.json

# 2. Store refresh token in vault
python3 -c "
import sys; sys.path.insert(0, 'tools/opai-vault')
import store
store.set_secret('google-workspace-refresh-token', 'TOKEN_HERE')
"
```

---

## Safety Architecture

### Write Boundary Enforcement

- All Drive write operations validate target is within Agent Workspace folder
- Parent chain traversal via Drive API (defense-in-depth — walks up folder tree)
- `GOOGLE_WORKSPACE_WRITE_RESTRICTED=true` env var (safety switch)
- Co-edit bypasses write boundary (edits existing docs, doesn't create new files outside workspace)

### Rate Limits

| Operation | Limit |
|-----------|-------|
| Drive reads | 60/min |
| Drive writes | 10/min |
| Gmail reads | 60/min |
| Gmail sends | 5/hour |
| Doc comments | 5/min |
| Doc edits | 10/min |
| Doc reads (structure/revisions) | 30/min |
| Chat reads | 60/min |
| Chat writes | 10/min |

### Audit Trail

Every API call logged via `shared/audit.py`:
- Events: `drive:list`, `drive:read`, `drive:search`, `drive:write`, `drive:metadata`, `drive:create_doc`, `drive:get_start_token`, `drive:get_changes`, `gmail:search`, `gmail:read`, `docs:list_comments`, `docs:add_comment`, `docs:reply_comment`, `docs:resolve_comment`, `docs:edit_text`, `docs:get_revisions`, `docs:get_content_structure`, `chat:list_spaces`, `chat:list_messages`, `chat:send_message`

---

## Background Scheduling

| Task | Schedule | Handler |
|------|----------|---------|
| **Chat poll** | **30-second fast loop** (asyncio task, not cron) | `chat_fast_loop()` → `poll_workspace_chat()` |
| `workspace_mention_poll` | `*/2 * * * *` (cron) | `_workspace_mention_poll()` → doc comment scanning |
| `coedit_activity_check` | `*/2 * * * *` (cron) | `_coedit_activity_check()` → revision polling + timeout |
| `workspace_folder_audit` | `0 23 * * *` (cron) | `_workspace_folder_audit()` → daily folder health check |
| `daily_agent_newsletter` | `0 7 * * *` (cron) | `_daily_agent_newsletter()` → gaps + activity email |
| `knowledge_refresh` | `30 2 * * *` (cron) | `_knowledge_refresh()` → rebuild business-context.md from Supabase |

The chat poll runs on its own asyncio loop registered in `app.py` at startup — bypasses the cron scheduler's 60-second minimum for responsive user interactions.

---

## Scopes Reference

### OAuth2 User Flow — agent@ (11 scopes)

```
https://www.googleapis.com/auth/drive                    # Drive full
https://www.googleapis.com/auth/documents                # Docs read/write/comment/suggest
https://www.googleapis.com/auth/spreadsheets             # Sheets read/write
https://www.googleapis.com/auth/gmail.readonly           # Gmail read
https://www.googleapis.com/auth/gmail.send               # Gmail send (used by fallback chain)
https://www.googleapis.com/auth/calendar.readonly        # Calendar read-only
https://www.googleapis.com/auth/chat.spaces.readonly     # List/read Chat spaces
https://www.googleapis.com/auth/chat.messages.readonly   # Read Chat messages
https://www.googleapis.com/auth/chat.messages.create     # Send Chat messages as agent@
https://www.googleapis.com/auth/chat.spaces.create       # Set up DM spaces (join DMs)
https://www.googleapis.com/auth/chat.memberships.readonly # Resolve space members to email/name
```

**Note:** Uses user-auth (OAuth2 user flow), NOT bot auth. The `chat.bot` scope is NOT used. Messages appear FROM agent@paradisewebfl.com as a real user.

**Incremental scopes:** Re-running `python3 tools/shared/google_auth.py` merges new scopes with existing ones (`include_granted_scopes=true`). Sign in as agent@paradisewebfl.com.

**Internal consent screen** — bypasses Google's verification for restricted scopes (only paradisewebfl.com users can authorize).

### Domain-Wide Delegation — any @paradisewebfl.com user (7 scopes)

```
https://www.googleapis.com/auth/gmail.readonly           # Read any user's inbox
https://www.googleapis.com/auth/gmail.send               # Send as any user
https://www.googleapis.com/auth/gmail.compose            # Create drafts as any user
https://www.googleapis.com/auth/gmail.modify             # Label, archive, mark read/unread
https://www.googleapis.com/auth/drive.readonly           # Read any user's Drive
https://www.googleapis.com/auth/calendar.readonly        # Read any user's calendar
https://www.googleapis.com/auth/calendar.events          # Create/edit calendar events
```

**Why 7 vs 11?** Delegation is intentionally scoped down — cross-user access covers inbox management, drafts, Drive reads, and calendar. Chat, Docs editing, Drive writes, and Sheets stay on agent@'s OAuth. To add delegation scopes, update both `google_auth.py` `DEFAULT_DELEGATION_SCOPES` AND the Admin Console delegation config.

---

## Configuration

### GWS CLI Setup

```bash
# Install
npm install -g @googleworkspace/cli

# Auth credentials (one-time — pull from vault)
# Stored at: ~/.config/gws/credentials.json (authorized_user format)
# Client secret at: ~/.config/gws/client_secret.json (project_id removed to avoid quota header)

# Verify
gws auth status
gws gmail users messages list --params '{"userId": "me", "maxResults": 3}'
```

**Important:** The `client_secret.json` must have `project_id` removed — otherwise the GWS CLI sends a quota project header that agent@ doesn't have IAM permission for. Our custom Python class doesn't have this issue because it makes raw HTTP calls.

### Profiles

- **workspace** — YouTube + Instagram + Playwright (GWS CLI available system-wide via shell)
- **helm** — WP + Netlify + Supabase + TeamHub + Playwright (GWS CLI available system-wide via shell)

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Token refresh fails | Check vault has `google-workspace-refresh-token`. Re-run auth flow if token revoked. |
| Rate limit exceeded | Wait for window reset. Check audit log for burst source. |
| Write blocked | Verify `GOOGLE_AGENT_WORKSPACE_FOLDER_ID`. Check parent chain. |
| GWS CLI 403 quota error | Remove `project_id` from `~/.config/gws/client_secret.json` — agent@ lacks IAM `serviceUsageConsumer` on the GCP project |
| GWS CLI not found | `npm install -g @googleworkspace/cli` |
| "Client secret not found" | Store in vault: `store.set_secret('google-workspace-client-secret', '<json>')` |
| Chat API 403 on DM send | DM space not "joined". Re-run OAuth (`python3 tools/shared/google_auth.py`) to get `chat.spaces.create` scope, then `chat_setup_dm()` auto-joins. Or manually open DM as agent@ in browser. |
| Chat API 403 on member lookup | Need `chat.memberships.readonly` scope. Re-run OAuth flow. |
| Agent responding to own messages | Verify `AGENT_USER_RESOURCE_NAME` in `workspace_chat.py` matches agent@'s user resource ID. Check `_sent_message_ids` tracking. |
| Sender shows as "someone" | Membership lookup failed. Check DM mapping file `data/chat-dm-mapping.json`. Add manual entry if needed. |
| Co-edit not applying edits | Check doc is a Google Doc (not PDF/uploaded file). Docs API only works on native Docs. |
| Revisions API empty | Some file types don't expose revision history. Works for Docs and Sheets. |
| Co-edit won't activate | Check `coedit.enabled: true` in orchestrator.json. Check max_concurrent_sessions. |
| GOOGLE_AGENT_WORKSPACE_FOLDER_ID not set | Research skill can't create Google Docs. Set in `tools/opai-engine/.env`. Currently: `1i2usqWNFXQ03OyWOkqt2gNfuUpiu-lPA`. |
| Repeated messages in Chat (ack spam) | Retry loop bug — if send failed on rate limit, message wasn't marked processed, causing re-ack on every poll. Fixed: always mark processed. |

### Critical Safety Rules (Google Chat)

- **NEVER reset `last_poll` backwards** — causes mass re-processing and spam
- **NEVER manipulate `processed_ids`** — messages are processed ONCE, period
- **NEVER reply in threads** — respond directly in the chat space (no `thread_name` parameter)
- **NEVER send test messages without explicit approval** — especially not to production spaces
- **Safety cap:** MAX_MESSAGES_PER_SPACE = 3 per poll cycle — prevents runaway processing
- **Always mark processed:** Messages are added to `processed_ids` regardless of send success. A rate-limit retry loop previously caused ack spam (10+ repeated messages) — fixed by treating all send failures as terminal. Better to drop one response than spam the chat.
