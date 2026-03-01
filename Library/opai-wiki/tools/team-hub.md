# OPAI Team Hub
> Last updated: 2026-02-28 (tile flex-fill, board enhancements, mentions fix, file preview) | Source: `tools/opai-team-hub/`

ClickUp-style task and project management system built into OPAI. Provides workspace-based project tracking with folders, lists, tags, assignments, comments, dashboards, Discord integration, and a cross-workspace AI assistant. Includes a per-user ClickUp import pipeline with live SSE progress streaming, a ClickUp API proxy for transition continuity, and a comprehensive internal MCP API for programmatic workspace management.

## Overview

| Property | Value |
|----------|-------|
| **Port** | `8089` |
| **Framework** | FastAPI + Uvicorn |
| **Database** | Supabase (REST API) |
| **Auth** | Shared Supabase JWT (ES256 JWKS, HS256 fallback) |
| **Frontend** | Vanilla JS SPA (`static/index.html`, `app.js`, `style.css`) |
| **Service** | `opai-team-hub` (systemd user unit) |
| **Caddy route** | `/team-hub/` → `localhost:8089` |
| **Version** | 2.6.0 |

## Architecture

```
Discord ──→ Internal API ──→ Supabase
                              ↑
Web UI  ──→ JWT Auth ───→ REST API ──→ Supabase
              │               ↑
              │  ClickUp ←── Import/Proxy ────┘
              │
              └──→ AI Chat ──→ Claude CLI (subscription)
                      ↑
MCP/Agents ──→ Internal Workspace API ──→ Supabase
```

Six layers:
1. **Web UI** — SPA with home dashboard, board/list/calendar views, detail panel, search, notifications, settings modal, member management, AI panel
2. **AI Panel** — Cross-workspace conversational assistant using Claude CLI, personalized by user identity
3. **Discord Bridge** — Internal (unauthenticated) endpoints for the Discord bot to create items, search, and resolve users
4. **MCP/Agent API** — Internal workspace-scoped endpoints for programmatic access (MCP tools, Discord AI, agents)
5. **ClickUp Import** — Per-user API key-based import with SSE streaming progress (replaces old system-wide migration)
6. **ClickUp Proxy** — Passthrough to ClickUp API for transition period

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-team-hub/app.py` | FastAPI entrypoint, mounts 4 routers + static files |
| `tools/opai-team-hub/config.py` | Env config: server, Supabase, ClickUp, paths |
| `tools/opai-team-hub/routes_api.py` | Core API: workspaces, items, tags, assignments, search, members, Discord settings, ClickUp import, internal endpoints |
| `tools/opai-team-hub/routes_spaces.py` | Hierarchy API: folders, lists, statuses, files, dashboards, templates, profiles, assignees, calendar, invite |
| `tools/opai-team-hub/routes_comments.py` | Item comments CRUD |
| `tools/opai-team-hub/routes_clickup.py` | ClickUp API proxy (spaces, lists, tasks, comments, members) |
| `tools/opai-team-hub/clickup_migrate.py` | CLI: full ClickUp-to-Supabase migration (legacy, replaced by web import) |
| `tools/opai-team-hub/backfill_folders.py` | CLI: converts folder:/list: tags into proper hierarchy records |
| `tools/opai-team-hub/static/` | SPA frontend (index.html, app.js, style.css) |
| `tools/shared/auth.py` | Shared JWT auth module (JWKS + HS256) |
| `config/supabase-migrations/012_team_hub.sql` | Base schema (workspaces, items, assignments, comments, tags) |
| `config/supabase-migrations/014_team_hub_hierarchy.sql` | Folders, lists, statuses, files, dashboards, RLS, triggers |
| `config/supabase-migrations/040_team_hub_owner_only_status_tags.sql` | Owner-only RLS for statuses + tags (INSERT/UPDATE/DELETE) |

## Database Schema

### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `team_workspaces` | Spaces/projects | name, slug, icon, color, owner_id, is_personal, discord_server_id, discord_channel_id, bot_prompt |
| `team_membership` | User-workspace roles | user_id, workspace_id, role (owner/admin/member/viewer) |
| `team_items` | Tasks, notes, ideas, decisions, bugs | workspace_id, type, title, description, status, priority, due_date, list_id, folder_id, source, created_by |
| `team_assignments` | Item assignments | item_id, assignee_type (user/agent/squad), assignee_id |
| `team_comments` | Item comments | item_id, author_id, content, is_agent_report |
| `team_tags` | Workspace tags (owner-only CRUD, see [Global Settings](#global-settings-ownership-model)) | workspace_id, name, color |
| `team_item_tags` | Item-tag junction | item_id, tag_id |

### Hierarchy Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `team_folders` | Folders within a workspace | workspace_id, name, orderindex, created_by |
| `team_lists` | Lists within a folder or workspace | workspace_id, folder_id (nullable), name, orderindex, created_by |
| `team_statuses` | Custom statuses per workspace (owner-only CRUD, see [Global Settings](#global-settings-ownership-model)) | workspace_id, name, color, type (open/active/done/closed), orderindex |
| `team_files` | Attachments (Supabase Storage) | workspace_id, folder_id, list_id, item_id, file_name, file_path, uploaded_by |
| `team_dashboards` | Workspace dashboards | workspace_id, name, created_by |
| `team_dashboard_widgets` | Dashboard widget configs | dashboard_id, widget_type, title, config, position |

### Supporting Tables

| Table | Purpose |
|-------|---------|
| `team_activity` | Audit log (workspace_id, action, actor_id, item_id, details) |
| `team_user_prefs` | Per-user preferences (user_id PK, home_layout JSONB, updated_at) |
| `team_notifications` | User notifications (user_id, type, title, body, read) |
| `team_invitations` | Workspace invites (inviter_id, invitee_email, role, status) |
| `team_discord_members` | Discord-to-workspace member mappings |

### Triggers

- **`create_default_statuses()`** — auto-creates 6 statuses (open, to do, in progress, review, done, closed) on workspace insert
- **`create_default_dashboard()`** — auto-creates Overview dashboard with 4 widgets on workspace insert
- **`create_personal_workspace()`** — auto-creates personal workspace on new user signup

### Hierarchy Model

```
Workspace
├── Folder A
│   ├── List 1  →  Items (list_id + folder_id set)
│   └── List 2  →  Items
├── List 3 (folderless)  →  Items (list_id set, folder_id NULL)
└── Uncategorized  →  Items (list_id NULL, folder_id NULL)
```

Items reference both `list_id` and `folder_id` directly (denormalized for query speed). The API returns a virtual "All Items" list for uncategorized items.

## API Routes

### Core (`routes_api.py`, prefix `/api`)

**Workspaces**: `GET/POST /workspaces`, `GET/PATCH/DELETE /workspaces/{ws_id}`

**Items**: `GET/POST /workspaces/{ws_id}/items`, `GET/PATCH/DELETE /items/{item_id}`
- Filter by: type, status, priority, assignee, search query
- Enriched with assignments + tags on detail view
- PATCH supports: `title`, `description`, `status`, `priority`, `due_date`, `list_id`, `folder_id` (last two enable move-between-lists)

**Assignments**: `POST/DELETE /items/{item_id}/assign[/{assign_id}]`

**Tags**: `GET/POST /workspaces/{ws_id}/tags`, `PATCH/DELETE /workspaces/{ws_id}/tags/{tag_id}`, `POST/DELETE /items/{item_id}/tags[/{tag_id}]`
- Workspace-level tag CRUD: create, rename (PATCH name/color), delete (cascades to item associations). **Owner-only** — POST/PATCH/DELETE check membership role = `owner` (403 otherwise)
- Item-level tag assignment/removal — any member can assign/unassign existing tags to tasks

**Members**: `GET /workspaces/{ws_id}/members`, `POST /workspaces/{ws_id}/add-member` (direct add by user_id), `DELETE /workspaces/{ws_id}/members/{user_id}` (remove member — admin/owner only, prevents self-removal), `POST /workspaces/{ws_id}/invite` (email-based, legacy), `POST /invitations/{id}/accept|decline`

**Activity**: `GET /workspaces/{ws_id}/activity`, `GET /items/{item_id}/activity`

**Search**: `GET /search?q=...` (cross-workspace full-text search)

**My Work**: `GET /my/items`, `GET /my/home`, `GET/POST /my/notifications[/read]`

**Discord Settings**: `GET/PATCH /workspaces/{ws_id}/discord`, `GET /workspaces/{ws_id}/discord/members`

### ClickUp Import (`routes_api.py`, prefix `/api`)

Per-user API key-based import flow. Each user connects their own ClickUp account.

| Endpoint | Purpose |
|----------|---------|
| `GET /clickup/admin-key-hint` | Returns pre-filled API key for admin user (Dallas-ADMIN), empty for others |
| `POST /clickup/connect?api_key=...` | Validates key, discovers teams → spaces → folders → lists with task counts |
| `GET /clickup/import?api_key=...&space_ids=...` | SSE streaming import of selected spaces into Team Hub |

**Import flow**:
1. User enters their ClickUp API key (admin gets pre-filled)
2. `connect` endpoint validates and returns full hierarchy with task counts per list
3. User browses/selects specific spaces to import
4. `import` endpoint streams SSE events: `init` → `fetching` → `space` → `folder` → `list` → `progress` → `space_done` → `done`
5. Each progress event includes running stats: `{spaces, folders, lists, tasks, comments, tags, skipped}`

**Data mapping**: ClickUp spaces → workspaces, folders → `team_folders`, lists → `team_lists`, tasks → `team_items`, comments → `team_comments`, tags → `team_tags`, assignees → `team_assignments` (mapped by email to OPAI user, or stored as `clickup:username` placeholder)

### Settings Sync (`routes_api.py`, prefix `/api`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/settings/sync` | `POST` | Sync statuses + tags from personal workspace to all other owned workspaces |

Requires JWT auth. Fire-and-forget — called automatically after any status/tag mutation. See [Global Settings](#global-settings-ownership-model).

### Hierarchy (`routes_spaces.py`, prefix `/api`)

**Folders**: `GET /workspaces/{ws_id}/folders` (full tree with item counts), `POST /workspaces/{ws_id}/folders`, `PATCH/DELETE /folders/{id}`

**Lists**: `POST /workspaces/{ws_id}/lists`, `GET /lists/{id}/items` (with assignments, tags, statuses), `PATCH/DELETE /lists/{id}`, `POST /lists/{id}/items`

**Statuses**: `GET/POST /workspaces/{ws_id}/statuses`, `PATCH/DELETE /statuses/{id}` — **Owner-only** for POST/PATCH/DELETE (403 for non-owners)

**Files**: `GET/POST /workspaces/{ws_id}/files`, `DELETE /files/{id}`

**Dashboards**: `GET /workspaces/{ws_id}/dashboard` (with computed widget data), `POST /workspaces/{ws_id}/dashboard/widgets`, `DELETE /dashboard/widgets/{id}`

**Calendar**: `GET /workspaces/{ws_id}/calendar?month=YYYY-MM` (items with due dates for month, ±7 day spillover, includes statuses for coloring)

**Templates**: `GET /templates`, `POST /templates`, `PATCH/DELETE /templates/{id}`, `POST /templates/apply`

`POST /templates/apply` accepts:
- `space_name` (required), `color`, `icon` — workspace metadata
- `template` — builtin key (`standard`, `client`, `simple`, `kanban`)
- `template_id` — saved template UUID
- `structure` — inline structure object (bypasses template lookup entirely)
- `prefix` — optional string prepended to all folder/list names as `"prefix - name"`

Resolution priority: `structure` > `template_id` > `template` > blank

**Inline structure format** (sent by Structure Builder):
```json
{
  "folders": [{"name": "Dev", "lists": [{"name": "Backlog", "tasks": ["Setup CI", "Write tests"]}]}],
  "lists": [{"name": "Notes", "tasks": ["First note"]}]
}
```

Lists support both string format (legacy/templates) and `{name, tasks}` object format (structure builder). Tasks are created as `team_items` with `source=template`, `status=open`, `priority=medium`.

Available builtin templates: `standard` (Dev + Marketing + Admin), `client` (Deliverables + Communication), `simple` (flat To Do/In Progress/Done), `kanban` (single Board list)

**Assignees**: `GET /workspaces/{ws_id}/assignees` — returns only real OPAI users (filters out `clickup:` placeholder assignees)

**Profiles**: `GET /profiles` — all OPAI user profiles for search/dropdowns (id, email, display_name, is_active)

### Internal (unauthenticated, for Discord bridge)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/internal/create-item` | Create item from Discord (by slug/id/personal ws) |
| `GET /api/internal/user-items` | Get items for a user by user_id |
| `GET /api/internal/search` | Search items for a user |
| `GET /api/internal/resolve-discord-user` | Map Discord ID → OPAI user |
| `GET /api/internal/resolve-channel` | Map Discord channel → workspace + bot_prompt |
| `POST /api/internal/resolve-or-create-discord-member` | Auto-discover/create Discord member mapping |

### Discord Settings (`routes_api.py`, prefix `/api`)

Per-workspace Discord integration. Each workspace can bind to a specific Discord server and channel, enabling two-way communication between Team Hub and Discord.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/workspaces/{ws_id}/discord` | `GET` | Get Discord binding (server_id, channel_id, bot_prompt) |
| `/workspaces/{ws_id}/discord` | `PATCH` | Update Discord server/channel/bot_prompt (admin/owner only) |
| `/workspaces/{ws_id}/discord/members` | `GET` | List Discord member mappings for workspace |

**Pydantic model** (`UpdateDiscordSettings`):
- `discord_server_id` (optional str) — Discord guild ID to bind
- `discord_channel_id` (optional str) — Discord channel ID for workspace notifications
- `bot_prompt` (optional str) — Custom system prompt for the Discord bot when responding in this workspace's channel

The binding is stored directly on `team_workspaces` columns (`discord_server_id`, `discord_channel_id`, `bot_prompt`). The Discord bridge resolves channels to workspaces via `POST /api/internal/resolve-channel` using the `discord_channel_id` field. Updates are logged to `team_activity` as `discord_settings_updated`.

### AI Chat (`routes_api.py`, prefix `/api`)

Cross-workspace AI assistant endpoint powering the AI Panel in the frontend. Uses Claude CLI (subscription-based) via the shared `call_claude` wrapper — no API key required.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ai/chat` | `POST` | Get an AI response with full cross-workspace context |

**Request body** (`AIChatRequest`):
```json
{
  "messages": [
    {"role": "user", "content": "What are my pressing tasks?"},
    {"role": "assistant", "content": "Here are your top priorities..."},
    {"role": "user", "content": "Which ones are overdue?"}
  ],
  "workspace_id": "optional-uuid-focus-hint"
}
```

- `messages`: Full conversation history, newest message last
- `workspace_id`: Optional — when the user has a workspace selected, provides a focus hint but does NOT restrict the AI's knowledge

**Response**: JSON `{ "reply": "markdown text" }`. Error: `{ "detail": "message" }`.

**Context injection**: The endpoint fetches ALL of the user's data in parallel via `asyncio.gather`:
- All workspaces the user is a member of (names, descriptions)
- All items across those workspaces (up to 200), enriched with assignments
- Items specifically assigned to the user
- User's display name for personalized responses

The system prompt identifies the user by name and provides a compact summary: workspace list, task breakdown by status per workspace, assigned items with details (title, status, priority, due date, workspace). If `workspace_id` is provided, that workspace's tasks are highlighted.

**Model**: `claude-haiku-4-5` via CLI (`call_claude` with `api_key=""` to force CLI mode). No API key needed — uses the Claude subscription.

### Internal Workspace-Scoped API (for MCP/Discord AI)

Unauthenticated internal endpoints for programmatic workspace management. Used by MCP tools, Discord AI, and agents. All endpoints use query parameters.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/internal/workspace-summary` | `GET` | Workspace overview: name, description, member count, item stats by status |
| `/internal/list-spaces` | `GET` | List workspace info with folder/list counts |
| `/internal/list-folders` | `GET` | List all folders in a workspace (ordered by orderindex) |
| `/internal/list-lists` | `GET` | List all lists in a workspace, optionally filtered by `folder_id` |
| `/internal/list-items` | `GET` | List items with optional filters: `list_id`, `status` (comma-separated), `assignee_id`, `limit` (max 200) |
| `/internal/search-items` | `GET` | Full-text search by title/description within a workspace |
| `/internal/get-item` | `GET` | Full item detail with assignments, tags, and comments |
| `/internal/create-space` | `POST` | Create a folder (space-level container) in a workspace |
| `/internal/create-folder` | `POST` | Create a folder in a workspace |
| `/internal/create-list` | `POST` | Create a list in a workspace (optionally inside a folder via `folder_id`) |
| `/internal/create-item` | `POST` | Create an item (task/note/bug/etc.) with full field support |
| `/internal/update-item` | `PATCH` | Update item fields: title, description, status, priority, due_date, follow_up_date, list_id |
| `/internal/add-comment` | `POST` | Add a comment to an item (default author: `ai-assistant`) |
| `/internal/assign-item` | `POST` | Assign a user to an item (replaces existing assignment for idempotency) |
| `/internal/list-members` | `GET` | List all workspace members with profile info (display_name, email, discord_id) |

All write endpoints set `created_by` / `author_id` to `"ai-assistant"` by default. The `create-item` endpoint supports `assigned_by` (default `"discord-bot"`).

### ClickUp Proxy (`routes_clickup.py`, prefix `/api/clickup`)

Passthrough to ClickUp API v2: spaces, hierarchy, tasks (with pagination), task detail + comments, task updates, team members.

## ClickUp Migration

### Web Import (Primary — Settings Modal)

Per-user import accessed via Settings gear icon → Import tab:

1. **Enter API Key** — password input; Dallas-ADMIN gets admin key pre-filled, other users enter their own
2. **Connect** — validates key, fetches full ClickUp hierarchy (teams → spaces → folders → lists) with task counts
3. **Browse & Select** — expandable tree with checkboxes per space; shows folder/list/task counts; summary bar with totals
4. **Import** — SSE streaming with live progress: current-item indicator, progress bars (spaces X/total, tasks X/estimated), scrolling log, 6-card stat grid updating in real-time
5. **Disconnect** — reset and connect with a different key

### CLI Migration (Legacy — `clickup_migrate.py`)

```bash
python3 clickup_migrate.py              # Full migration
python3 clickup_migrate.py --dry-run    # Preview
python3 clickup_migrate.py --space ID   # Single space only
```

Uses system-configured `CLICKUP_API_KEY` from config. Creates workspaces, folders, lists, items, comments, tags, and assignments.

### Backfill Script (`backfill_folders.py`)

The original migration stored folder/list hierarchy as tags (`folder:X`, `list:Y`). This script converts them to proper `team_folders`/`team_lists` records:

```bash
python3 backfill_folders.py              # Run backfill
python3 backfill_folders.py --dry-run    # Preview
python3 backfill_folders.py --cleanup    # Remove redundant folder:/list: tags
```

**Migration stats** (2026-02-16): 44 folders, 72 lists, 4,125 items linked, 121 redundant tags removed.

### Assignee Handling

- ClickUp assignees are mapped by email to OPAI user profiles where possible
- Unmapped assignees are stored as `clickup:username` in `team_assignments.assignee_id`
- The assignee dropdown in the UI only shows real OPAI users (backend filters out `clickup:` prefix)
- `resolveAssigneeName()` in app.js returns `null` for `clickup:` IDs, hiding them from task display

## Frontend

Vanilla JS SPA (no framework) with Supabase auth integration and Supabase Realtime for live cross-user updates.

### Views

- **Home dashboard**: Intelligent landing page shown when no space/list is selected. Displays cross-workspace data as drag-and-drop tiles in a responsive CSS grid. Accessed via house icon in header or by deselecting all spaces. The header **Grid** button shows the tile dashboard; **List** button shows the All Tasks table — no separate tab bar.
- **Board view**: Kanban-style columns by status, drag-and-drop between columns, per-column quick-add, description previews on cards, collapsible columns, empty column drop zones
- **List view**: Table with sortable columns, inline status/priority badges
- **Calendar view**: Month grid (7-column CSS grid) filling the full viewport height. Status-colored task pills, up to 3 per day visible; days with more show a "+N more" button that opens a slim floating popup listing all tasks for that day (click any task to open the detail panel, click outside or press Escape to dismiss). Month navigation (prev/next/today); works at space level or list level. Grid rows are set dynamically to match the exact week count of the displayed month (no empty gray row).
- **Dashboard view**: Widget-based overview with status counts, priority breakdown, due-soon items, recent activity

### Home Dashboard

The home dashboard replaces the old empty "Select a list" state with a curateable tile-based overview. All tile layout, visibility, and size preferences persist per-user in `localStorage` (key: `teamhub_home_layout_{userId}`).

**Data source**: Single aggregation endpoint `GET /api/my/home` returns all tile data in one call, avoiding N+1 frontend requests.

#### Home Tiles

| Tile ID | Title | Data | Default |
|---------|-------|------|---------|
| `top3` | Top 3 Priorities | Highest-priority assigned items (sorted by priority then due_date) | visible |
| `overdue` | Overdue | Items with due_date < today, not done | visible |
| `due_week` | Due This Week | Items due within next 7 days | visible |
| `todos` | Recent Todos | Last assigned items by updated_at | visible |
| `workspaces` | My Workspaces | Per-workspace summary with progress bars | visible |
| `follow_ups` | Follow-ups Due | Items with follow_up_date within next 7 days | visible |
| `mentions` | Mentions | Comments containing `@DisplayName` or `@emailPrefix` (searches ALL comments, excludes own) | visible |
| `activity` | Recent Activity | Last activity entries across user's workspaces | visible |

#### Tile Sizes (WxH — Width x Height)

Each tile can be resized by clicking the expand button, which cycles through 6 sizes:

| Size | Grid Span | Content Scaling |
|------|-----------|-----------------|
| **1x1** | 1 col, 1 row (280px) | Compact — minimal items, titles only |
| **2x1** | 2 cols, 1 row | Wide — row layout, adds timestamps, due dates |
| **3x1** | 3 cols, 1 row | Extra wide — full grid width, priority pills, workspace badges |
| **1x2** | 1 col, 2 rows (576px) | Tall — more items, due dates, priority, "days overdue" |
| **2x2** | 2 cols, 2 rows | Large — grouped day headers, descriptions, workspace stat breakdowns |
| **3x2** | 3 cols, 2 rows | Maximum — up to 40 items, full detail expansion |

Cycle order: `1x1 → 2x1 → 3x1 → 1x2 → 2x2 → 3x2 → 1x1`

Grid rows are fixed at **280px** — tiles fill their grid cell via flex layout and scroll internally if content overflows. No per-size max-height overrides; the CSS grid enforces height.

**Item limits per tile size:**

| Tile | 1x1 | 2x1 | 3x1 | 1x2 | 2x2 | 3x2 |
|------|-----|-----|-----|-----|-----|-----|
| top3 | 3 | 5 | 8 | 8 | 15 | 25 |
| todos | 6 | 10 | 14 | 15 | 25 | 40 |
| overdue/due_week/follow_ups | 5 | 8 | 12 | 12 | 20 | 35 |
| mentions | 5 | 8 | 10 | 12 | 20 | 30 |
| activity | 6 | 10 | 14 | 15 | 25 | 40 |

Each size scales both the number of items shown and the metadata displayed per item. Wider tiles show more columns (priority, status, timestamps side by side). Taller tiles show more rows. Combined sizes show descriptions, grouped headers, and full stat breakdowns.

#### Layout Persistence

Tile layout (visibility, order, sizes) persists to Supabase via `team_user_prefs` table — survives cleared browser data and works across devices. The flow:

1. **Page load** — reads from `localStorage` cache (instant render)
2. **First render** — fetches authoritative layout from `GET /api/my/home-layout`, overwrites local cache
3. **Any change** — writes to `localStorage` immediately + debounced `PUT /api/my/home-layout` (300ms)

| Endpoint | Purpose |
|----------|---------|
| `GET /my/home-layout` | Load saved layout from `team_user_prefs.home_layout` (JSONB) |
| `PUT /my/home-layout` | Upsert layout to `team_user_prefs` (debounced from frontend) |

#### Drag-and-Drop

Tiles use HTML5 Drag API. Drag a tile to reorder — colored border indicators show the drop position. Order persists across sessions via Supabase.

#### Home Dashboard Endpoint

`GET /api/my/home` — requires JWT auth. Returns:

```json
{
  "top_items": [...],       // Top priority assigned items
  "recent_todos": [...],    // Recent items by updated_at
  "overdue": [...],         // Past-due items
  "mentions": [...],        // Comments mentioning user
  "workspace_summary": [    // Per-workspace stats
    { "id", "name", "icon", "color", "total_items", "done_count", "active_count" }
  ],
  "due_this_week": [...],   // Items due in next 7 days
  "follow_ups_due": [...],  // Items with follow_up_date within next 7 days
  "recent_activity": [...]  // Activity log entries (limit 40)
}
```

**Mentions tile rendering**: Shows `AuthorName in TaskTitle: preview...` with `@Name` patterns highlighted via `<span class="mention-hl">`. Looks up author from `_profiles` and item title from home data arrays.

#### Board View Enhancements

The board view (`renderBoard()`) includes:

- **All statuses shown**: Renders every defined status as a column, even those with 0 tasks
- **Quick-add per column**: "+ Add task" button at bottom of each column body. Clicking reveals inline text input — Enter creates a task with that column's status in the current list. Functions: `showBoardQuickAdd(status)`, `submitBoardQuickAdd(status, title)`
- **Description preview on cards**: First ~80 chars of `description` shown as a gray truncated line below the title (`.th-card-desc`)
- **Empty column placeholder**: When a column has 0 cards, shows "Drag tasks here or click + below" with a dashed border so the drop target is visible
- **Collapse/expand columns**: Chevron button on column header. Collapsed = 42px narrow bar with vertical status name + count, still accepts drag-and-drop. State tracked in `_collapsedColumns` Set (in-memory). Function: `toggleBoardColumn(status)`

Backend queries: user's workspace memberships → assigned item IDs → all items in workspaces (limit 200) → workspace metadata → activity log (limit 40). Mentions query searches `team_comments` directly with PostgREST `ilike` for `@DisplayName`/`@emailPrefix` patterns, excludes user's own comments, returns up to 30 results post-filtered to user's workspaces. All in a single endpoint call.

### UI Components

- **Sidebar**: Workspace selector + folder/list tree hierarchy with expand/collapse
- **Detail panel**: Slide-out (60vw, max 900px) with colored pill-dropdown pickers for status and priority; header action buttons (Move, Duplicate, Delete); assignees (OPAI users only), tags, markdown description with Pretty/Raw toggle, files with preview popup, comments with @mention autocomplete. Navbar-aware positioning (`top: 44px`, `height: calc(100vh - 44px)`).
- **Header**: Home (house icon), Search (global, `/` shortcut), Create New (5 types: Space, Folder, List, Task, Structure), Templates, Invite (Add Team Member), Settings (gear icon), **AI panel toggle** (brain icon), notifications bell
- **AI Panel**: Slide-in panel from the right (340px wide, z-index 200, below detail panel z-index 300). Cross-workspace knowledge, optional workspace focus hint. See [AI Panel](#ai-panel) section.

### Add Team Member Modal

- **Multi-space selection**: Checkboxes for each space + "Share All" toggle
- **User search**: Live-filters OPAI profiles by name/email; shows avatar initials, name, email
- **Add button**: One-click add to all selected spaces; disabled state for already-added users
- **Current Members section**: Shows members across selected spaces with role, email, space count, and red **Remove** button to revoke access from all selected spaces
- Profile data: queries `profiles` table (id, email, display_name, is_active — no avatar_url column)

### Detail Panel Features

#### Markdown Description (Pretty/Raw Toggle)

Description field renders markdown via `markdown-it` (CDN) with a dual-mode toggle:

- **Pretty mode** (default): rendered HTML with styled headings, lists, code blocks, blockquotes, tables, links. `- [ ]` / `- [x]` items render as interactive checkboxes — clicking toggles the raw markdown and saves via `updateField('description', ...)`.
- **Raw mode**: editable `<textarea>` with monospace font (`Fira Code`), saves on blur.
- Toggle buttons `[Pretty] [Raw]` in the field label row.
- Both modes support `resize: vertical` for manual drag-to-expand.

Functions: `renderDescription(desc)`, `toggleDescMode(mode)`, `handleCheckboxToggle(index)`

#### @Mention Autocomplete

Comment input supports `@` mention autocomplete:

1. Typing `@` followed by characters triggers a filtered dropdown of workspace members (from `_allAssignees` + `_profiles`)
2. Dropdown positioned above input, max 5 results, shows avatar initials + display name
3. Arrow Up/Down navigate, Enter/click selects, Escape dismisses
4. On select: replaces `@partial` with `@DisplayName ` (trailing space)
5. Mentions render as `<span class="mention">` in comment display (purple, bold, hover underline)

Functions: `bindMentionAutocomplete()`, `renderMentionDropdown()`, `selectMention()`, `hideMentionDropdown()`

#### File Preview

Clicking any file in the task detail Files section (or the dashboard Files widget) opens a popup preview modal (`previewFile(filePath, fileName, mimeType)`):

1. Gets a signed URL from Supabase Storage (`team-files` bucket, 1-hour expiry)
2. Renders preview based on MIME type:
   - **Images** (`image/*`): `<img>` with max-width/max-height 80vh
   - **PDFs** (`application/pdf`): embedded `<iframe>` viewer
   - **Video** (`video/*`): `<video>` with native controls, autoplay
   - **Audio** (`audio/*`): `<audio>` with native controls
   - **Text/JSON/XML**: `<iframe>` render
   - **Other**: file icon + file name + Download button (no preview)
3. Header bar: file name, Download link, Open in new tab link, Close button
4. Click backdrop or press Escape to dismiss
5. CSS: `.th-file-preview-backdrop` (fixed overlay z-index 10000), `.th-file-preview-modal` (max 90vw/90vh)

#### Item Actions (Header)

Three action buttons in the detail panel header bar (between type badge and close button):

| Button | Action | Details |
|--------|--------|---------|
| **Move** | `openMoveItemModal()` | Modal with Space + List dropdowns; `PATCH /items/{id}` with `list_id`/`folder_id` |
| **Duplicate** | `duplicateDetailItem()` | Creates copy with "(copy)" suffix in same list via `POST /lists/{id}/items` |
| **Delete** | `deleteDetailItem()` | Confirm dialog → `DELETE /items/{id}` → closes panel, refreshes view |

Backend: `UpdateItem` model extended with optional `list_id` and `folder_id` fields to support move operations.

#### Navbar-Aware Layout

All fixed/absolute positioning accounts for the shared OPAI navbar (44px):

| Element | CSS |
|---------|-----|
| `.app` | `height: calc(100vh - var(--navbar-h))` |
| `.loading-screen` | `height: calc(100vh - var(--navbar-h))` |
| `.th-detail-panel` | `top: var(--navbar-h); height: calc(100vh - var(--navbar-h))` |
| `.th-detail-backdrop` | `top: var(--navbar-h)` |
| `.th-notif-dropdown` | `top: calc(var(--navbar-h) + var(--header-h))` |
| `.th-ai-panel` | `top: calc(var(--navbar-h) + var(--header-h)); height: calc(100vh - navbar - header)` |

### Settings Modal (Gear Icon)

Title: **"TeamHub Settings"**. Opens from any context — home, within a space, list, or folder. Settings are **global** (not per-workspace). Six tabs:

1. **Landing** — Home dashboard tile configuration: toggle switches for tile visibility, clickable size badge to cycle through 6 sizes (1x1 → 2x1 → 3x1 → 1x2 → 2x2 → 3x2), drag handles to reorder tiles, "Reset to Defaults" button.
2. **Statuses** — Owner: full CRUD (inline color picker, rename, delete with confirmation, add row). Non-owner: read-only list with info text.
3. **Priorities** — Owner: info text explaining these are built-in system-wide levels. Non-owner: info text noting these are set by the workspace owner. Both see read-only color badges (critical, high, medium, low, none).
4. **Tags** — Owner: full CRUD (inline color picker, rename, delete). Non-owner: read-only list with info text.
5. **Import** — ClickUp import flow (see [ClickUp Migration > Web Import](#web-import-primary--settings-modal))
6. **Discord AI** — Per-workspace Discord bot integration and AI configuration (see [Discord Integration](#discord-integration))

See [Global Settings Ownership Model](#global-settings-ownership-model) for the full architecture.

### Global Settings Ownership Model

Statuses, tags, and priorities are **global** — the workspace owner defines one canonical set that applies across their entire TeamHub. Non-owners (invited members) see read-only views but can still assign existing statuses/tags to tasks.

**Architecture**:
- The owner's **personal workspace** (`is_personal = true`) is the canonical store for statuses and tags
- Settings modal always loads from and writes to the personal workspace, regardless of which space/list/folder is currently selected
- After any mutation (add/edit/delete status or tag), a fire-and-forget `POST /api/settings/sync` propagates changes to all other owned workspaces (upsert by name, delete orphans)
- `team_items.status` and `team_items.priority` are **TEXT fields** (not FKs) — tasks reference statuses by name, enabling the global model
- `team_item_tags` uses FK to `team_tags.id` — the sync endpoint matches tags by name across workspaces

**Three-layer defense** (owner-only enforcement):
1. **Database (RLS)** — Migration `040_team_hub_owner_only_status_tags.sql` restricts INSERT/UPDATE/DELETE on `team_statuses` and `team_tags` to `workspace_role() = 'owner'`
2. **Backend** — Status endpoints (`routes_spaces.py`) and tag endpoints (`routes_api.py`) check `role != "owner"` → 403
3. **Frontend** — `_isSettingsOwner()` guard on all mutation functions + conditional rendering (owner=editable, non-owner=read-only)

**What non-owners CAN still do**:
- Read all statuses, tags, and priorities
- Assign existing statuses/tags to tasks (item-level assignment is unrestricted)
- Full control of their own personal space settings (where they are owner)

**Key functions** (`app.js`):
- `_myPersonalSpaceId()` — returns the `is_personal` workspace ID
- `_isSettingsOwner()` — checks `my_role === 'owner'` on the personal workspace
- `_syncSettingsToAllSpaces()` — fire-and-forget POST to `/api/settings/sync`

### Context Menu (Right-Click)

Right-clicking any space, folder, list, or task opens a custom context menu (browser default is suppressed inside `.app`). Menu options vary by type:

| Type | Options |
|------|---------|
| **Space** | Rename, Delete |
| **Folder** | Rename, Delete |
| **List** | Rename, Move to Folder, Delete |
| **Task** | Open Task, Rename, Move Task, Duplicate, Delete |

- **Rename** — prompt dialog, PATCH API, broadcasts changes
- **Move List** — prompt with numbered folder list, PATCH with `folder_id`
- **Move Task** — opens existing move-item modal (space + list dropdowns)
- **Duplicate Task** — creates copy with "(copy)" suffix in same list
- **Delete** — confirmation dialog, DELETE API, broadcasts `structure_changed`

Functions: `showCtxMenu()`, `hideCtxMenu()`, `renameCtxItem()`, `deleteCtxItem()`, `duplicateCtxTask()`, `moveListToFolder()`

### Create New Wizard

Modal with 5 type cards in a 2-column grid (5th card spans full width):

| Type | Fields | Action |
|------|--------|--------|
| **Space** | Name, Prefix (optional), Template dropdown, Color | `POST /templates/apply` |
| **Folder** | Name, Space dropdown | `POST /workspaces/{id}/folders` |
| **List** | Name, Space dropdown, Folder dropdown | `POST /workspaces/{id}/lists` |
| **Task** | Title, Space, List, Type, Priority, Status, Due Date, Description | `POST /lists/{id}/items` |
| **Structure** | Name, Prefix, Color, inline tree builder, Save as template checkbox | `POST /templates/apply` with inline `structure` |

#### Structure Builder

The Structure card provides an inline tree builder for constructing full space hierarchies (folders → lists → tasks) before creation. Uses prompt-based add dialogs for each level.

**Builder state**: `_structBuilderFolders` = `[{name, lists: [{name, tasks: [str]}]}]`, `_structBuilderLists` = `[{name, tasks: [str]}]`

**Functions**: `renderStructBuilderTree()`, `structAddFolder()`, `structAddList()`, `structAddListToFolder(fi)`, `structAddTaskToFolderList(fi, li)`, `structAddTaskToList(li)`, `structRemoveFolder(fi)`, `structRemoveList(li)`, `structRemoveListFromFolder(fi, li)`, `structRemoveTaskFromFolderList(fi, li, ti)`, `structRemoveTaskFromList(li, ti)`, `toggleStructTplName()`

**Prefix system**: Both Space and Structure forms have an optional prefix field. When set, all folder and list names are created as `"prefix - name"` (e.g., prefix "ACME" + list "Backlog" → "ACME - Backlog"). Backend helper: `_prefixed(name, prefix)`.

**Save as template**: Structure builder has a "Save as template" checkbox. When checked, the structure is saved to `team_templates` (with string-only lists for legacy compatibility) before applying.

### AI Panel

A slide-in conversational AI assistant with cross-workspace knowledge, personalized by user identity.

**Trigger**: Brain icon button in the header (right side, next to notifications). Toggles open/closed. CSS class `.th-ai-toggle-btn` — glows accent when active.

**Panel layout** (`.th-ai-panel`, 340px wide, slides from right at z-index 200):
1. **Header** — AI icon + "AI Assistant" title + context label (workspace name or "All Workspaces") + close button
2. **Messages area** — scrollable chat history with user (right-aligned, accent background) and assistant (left-aligned, card background with markdown rendering) bubbles. Thinking indicator uses pulsing animation (`.th-ai-thinking`).
3. **Footer** — textarea input + send button (icon). Enter sends, Shift+Enter newlines.

**Cross-workspace behavior**: The AI has access to ALL of the user's workspaces and tasks. No workspace selection is required to chat. When a workspace is selected in the sidebar, it becomes a context hint (shown in header label) but does NOT restrict the AI's knowledge. Navigating between workspaces updates the label but does NOT reset the conversation.

**Backend endpoint**: `POST /api/ai/chat`
- Auth: JWT required
- Body: `{ "messages": [...], "workspace_id": "optional" }` — full conversation history + optional focus hint
- Response: JSON `{ "reply": "markdown text" }`
- Model: `claude-haiku-4-5` via CLI (no API key needed)

**State variables**: `_aiPanelOpen`, `_aiMessages`, `_aiStreaming`, `_aiCurrentSpaceId`

**Key functions**: `toggleAIPanel()`, `openAIPanel()`, `closeAIPanel()`, `sendAIMessage()`, `_aiSyncContext()`, `_aiAppendBubble(role, content)`, `_aiRenderMarkdown(text)`

**Config**: No API key required — uses Claude CLI subscription via shared `call_claude` wrapper.

### Discord Integration

The Discord AI tab in Settings provides a unified interface for connecting the OPAI Discord bot to Team Hub workspaces. This enables the bot to answer questions in a Discord channel with workspace-scoped context.

**Configuration flow** (Settings > Discord AI tab):

1. **Server ID** — Enter the Discord guild (server) ID. An invite banner appears with a link to add the bot to the server and step-by-step instructions.
2. **Channel ID** — Enter the Discord channel ID where the bot should listen and respond.
3. **Bot Prompt** — Optional custom system prompt that shapes how the AI responds in this channel.
4. **Workspace Scoping** — Toggle checkboxes to select which workspaces the bot has access to. Each workspace's `bot_prompt` is included in the AI context when the bot answers in the linked channel.
5. **Save & Apply** — Persists settings via `PATCH /api/workspaces/{ws_id}/discord` for each modified workspace.

**State variables**: `_discordAIWorkspaces`, `_discordAIConnection` (`{server_id, channel_id, bot_prompt}`), `_discordAIDirty`

**Key functions**: `renderSettingsDiscordAI()`, `saveDiscordAISettings()`, `_updateBotInviteLink()`

**Discord bridge resolution**: When the Discord bridge receives a message in a channel, it calls `GET /api/internal/resolve-channel?channel_id=...` which queries `team_workspaces` by `discord_channel_id` to find the linked workspace(s) and their `bot_prompt`.

### System Update Banner

When a `system_update` broadcast is received via Realtime, a purple banner slides down from the top with the update message and a "Refresh Now" button. This enables zero-downtime deployments — the system can be updated and users are notified in real time to reload.

Function: `showSystemUpdateBanner(message)`

### Realtime

Supabase Realtime broadcast channel (`team-hub-live`) for live cross-user updates:
- `task_updated` — updates task in-place, refreshes detail panel if open
- `task_created` — reloads list if created in current list
- `comment_added` — refreshes comments if detail panel is open for that task
- `structure_changed` — space/folder/list deleted, live-updates sidebar for other users
- `system_update` — displays refresh banner when system has been updated
- `team_notifications` postgres_changes listener for instant notification badges

### State Management

Key state variables in `app.js`:

| Variable | Purpose |
|----------|---------|
| `_user` | Current authenticated user |
| `_spaces` | All workspace records |
| `_profiles` | All OPAI user profiles (for dropdowns/search) |
| `_homeData` | Cached response from `/api/my/home` for home dashboard tiles |
| `_homeLayout` | Tile layout/visibility/size prefs (synced to localStorage) |
| `_collapsedColumns` | Set of status names with collapsed board columns (in-memory) |
| `_currentSpaceId` / `_currentListId` | Active navigation context |
| `_currentStatuses` | Statuses for active workspace (used in board columns + pill pickers) |
| `_tasks` | Items loaded for current list |
| `_allAssignees` | OPAI-only assignees for active workspace |
| `_detailTask` | Currently open task in detail panel |
| `_inviteSelectedSpaces` | Set of space IDs selected in invite modal |
| `_inviteSpaceMembers` | Map of spaceId → member user_id arrays |
| `_settingsStatuses` / `_settingsTags` | Data for settings modal tabs (loaded from personal workspace) |
| `_importConnected` / `_importHierarchy` | ClickUp connection state for import tab |
| `_importSelectedSpaces` | Set of ClickUp space IDs selected for import |
| `_importRunning` / `_importStats` | Import progress state |
| `_descMode` | Description toggle state: `'pretty'` or `'raw'` |
| `_mentionActive` / `_mentionIndex` / `_mentionMatches` | @mention autocomplete state |
| `_structBuilderFolders` / `_structBuilderLists` | Structure builder state (folders/lists with nested tasks) |
| `_aiPanelOpen` | Whether AI panel is visible |
| `_aiMessages` | Conversation history `[{role, content}]` for current session |
| `_aiStreaming` | Whether a response is in progress |
| `_aiCurrentSpaceId` | Current workspace context hint (optional, does not gate AI access) |
| `_calendarItems` | Items with due_date for calendar view |
| `_calendarStatuses` | Statuses for calendar coloring |
| `_calendarSpaces` | Space info map for all-spaces calendar view |

### Dependencies (CDN/Shared)

- `@supabase/supabase-js@2`
- `markdown-it@14` — markdown rendering for description Pretty mode
- Shared OPAI auth (`/auth/static/js/auth-v3.js`) and navbar (`/auth/static/js/navbar.js`)

## Service Management

```bash
# systemd
systemctl --user status opai-team-hub
systemctl --user restart opai-team-hub
journalctl --user -u opai-team-hub -f

# via opai-control
./scripts/opai-control.sh status
./scripts/opai-control.sh restart team-hub
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `fastapi` | Web framework |
| `uvicorn` | ASGI server |
| `httpx` | HTTP client (Supabase REST, ClickUp API) |
| `python-dotenv` | `.env` loading |
| `python-jose` | JWT decoding (shared auth) |
| `shared/claude_api.py` | Claude CLI wrapper (AI chat, no SDK dependency) |

## Registry Task Migration

Work tasks from the internal task registry (`tasks/registry.json`) are migrated to Team Hub workspaces via `scripts/migrate-registry-to-hub.py`. This bridges the internal agent task system with the user-facing project management UI.

### Migration Mapping (31 tasks)

| Project | Workspace | Tasks |
|---------|-----------|-------|
| Everglades-News | Paradise Web | 8 (t-003 to t-010) |
| Lace & Pearl | Lace & Pearl | 4 (t-019 to t-022) |
| BoutaCare | BoutaByte | 11 (t-024 to t-034) |
| Westberg | Pioneers of Personal Development | 6 (t-045, t-046, t-051, t-053, t-054, t-055) |
| MDH (t-011) | Morning Dew Homestead | 1 |
| Misc (t-049) | Dallas's Space (personal) | 1 |

### Traceability

Each migrated item gets a `registry:{task_id}` tag (e.g., `registry:t-20260212-024`) stored in `team_tags` + `team_item_tags`. This enables:
- **Dedup**: Migration script checks for existing tags before creating items
- **Bidirectional lookup**: Find the Team Hub item from a registry task ID, or vice versa
- **Orchestrator callback** (planned): Agent completion reports can be posted to the linked Team Hub item

### Key Distinction

- **Team Hub** = User-facing project management (ClickUp replacement). Used by team members to track project work.
- **Task Control Panel** = Internal system for orchestrator tasks, agent dispatching, HITL gates. Used by operators.
- Work tasks start in the registry (via email/monitor), get migrated to Team Hub for user visibility, while system tasks stay in the registry for agent execution.

## ClickUp MCP Integration

Team Hub supports programmatic ClickUp workspace binding via the internal API and config-level ClickUp credentials. This allows MCP tools and agents to interact with both Team Hub and ClickUp data in a unified way.

**Config keys** (in `config.py` / `.env`):
- `CLICKUP_API_KEY` — Admin-level ClickUp personal API key. Used for the web import pre-fill (Dallas-ADMIN), CLI migration, and ClickUp proxy passthrough. Stored in config with a default value for the primary admin account.
- `CLICKUP_TEAM_ID` — ClickUp team (workspace) ID. Used by the CLI migration and proxy endpoints to scope API calls to the correct ClickUp organization.
- `CLICKUP_BASE` — ClickUp API v2 base URL (`https://api.clickup.com/api/v2`), hardcoded in config.

**How it works**:
1. The ClickUp proxy (`routes_clickup.py`) uses `CLICKUP_API_KEY` and `CLICKUP_TEAM_ID` to forward requests to ClickUp's API, providing a seamless bridge during migration.
2. The web import endpoints allow per-user ClickUp keys, but fall back to the admin key for privileged users.
3. MCP tools can call the [Internal Workspace-Scoped API](#internal-workspace-scoped-api-for-mcpdiscord-ai) to read/write Team Hub data programmatically, while the ClickUp proxy provides read access to the legacy ClickUp workspace for comparison or continued use.

## Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `OPAI_TEAM_HUB_HOST` | Bind address | `127.0.0.1` |
| `OPAI_TEAM_HUB_PORT` | Port | `8089` |
| `SUPABASE_URL` | Supabase project URL | — |
| `SUPABASE_ANON_KEY` | Supabase anon key | — |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | — |
| `CLICKUP_API_KEY` | Admin ClickUp key (pre-filled for Dallas-ADMIN); also used by ClickUp MCP integration for programmatic workspace binding | — |
| `CLICKUP_TEAM_ID` | ClickUp team ID; used by CLI migration and MCP workspace binding | `8500473` |
| `OPAI_AUTH_DISABLED` | Skip JWT validation (dev only) | — |

## Known Issues / Gotchas

- **profiles table has no `avatar_url` column** — must use `is_active` or omit; requesting `avatar_url` causes Supabase 400 error (silently caught → empty profile list)
- **`clickup:` prefix assignees** — stored in `team_assignments` for unmapped ClickUp users; filtered out of UI dropdowns and task display; only visible in raw DB queries
- **SSE import endpoint** — uses `text/event-stream` content type; frontend reads via `ReadableStream`; each event is `data: {json}\n\n`
- **Admin key detection** — compares `user.id` against hardcoded `ADMIN_USER_ID` constant (`1c93c5fe-d304-40f2-9169-765d0d2b7638`)
- **`registry:` tags** — 31 tags created by migration script; do not delete — they enable dedup and traceability
- **`follow_up_date` column** — migration `020_team_items_follow_up_date.sql` adds `date` column to `team_items`; was missing from DB causing all list item requests to return 400 until applied (fixed 2026-02-21)
- **Home list view rendering** — `renderHomeListTable` has a "surgical update" path that checks for an existing `.home-list-view` div. The initial render shows a spinner in that div; the surgical path must verify `.home-list-table tbody` exists before updating, otherwise it returns early and the table never renders (fixed 2026-02-27)
- **AI CLI env stripping** — The shared `call_claude` wrapper strips `ANTHROPIC_API_KEY` from subprocess env to prevent stale vault keys from being passed to `claude -p`. Without this, the CLI attempts API auth with the stale key and returns 401. See `_CLI_STRIP_VARS` in `tools/shared/claude_api.py`.
- **Tag data inconsistency across workspaces** — After the global settings migration (040), the personal workspace may have fewer tags than other workspaces (e.g., 2 vs 10+). Running settings sync before setting up canonical tags in the personal workspace would delete the extras. The owner should configure their full tag set in settings first, then sync will propagate.
- **Owner-only settings migration (040)** — RLS policies on `team_statuses` and `team_tags` were tightened from `IN ('owner','admin')` to `= 'owner'`. Admins can no longer create/edit/delete statuses or tags. Previously there was no UPDATE policy on `team_tags` — migration adds one.

## Cross-References

- [Auth & Network](auth-network.md) — JWT validation, Caddy proxy
- [Discord Bridge](discord-bridge.md) — Discord bot uses internal endpoints
- [Portal](portal.md) — Navigation includes Team Hub link
- [Services & systemd](services-systemd.md) — Service unit management
- [Shared Navbar](navbar.md) — Injected navigation bar
- [OPAI Files](opai-files.md) — TeamTask button creates tasks with smart descriptions + file attachments
- [Task Control Panel](task-control-panel.md) — Internal task system; registry work tasks migrate to Team Hub via `registry:` tags
- [Feedback System](feedback-system.md) — Collects Team Hub improvement suggestions
