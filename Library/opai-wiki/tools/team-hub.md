# OPAI Team Hub
> Last updated: 2026-03-12 (Hub Model: multi-tenant hubs with shared statuses/tags/members, hub-level permissions, All Tasks view) | Source: `tools/opai-team-hub/`, `tools/shared/teamhub_client.py`

ClickUp-style task and project management system built into OPAI. Provides **hub-based** project tracking where workspaces (spaces) are grouped under a hub with shared statuses, tags, and team membership. Includes folders, lists, assignments, comments, dashboards, Discord integration, a cross-workspace AI assistant, task dependencies with blocking detection, an SVG Gantt chart, workspace-scoped custom fields, per-item time tracking with live timer, and configurable automations. Also features a per-user ClickUp import pipeline with live SSE progress streaming, a ClickUp API proxy for transition continuity, and a comprehensive internal MCP API for programmatic workspace management.

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
| **Version** | 3.0.0 |

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

### Hub Model (v3.5)

```
Hub (e.g. "Water's Edge")
├── Shared Statuses (hub-level, apply to all spaces)
├── Shared Tags (hub-level, apply to all spaces)
├── Members + Permissions (hub-level, 16 granular permissions)
├── Space: OPAI Workers
│   ├── Folder → Lists → Items
│   └── ...
├── Space: Client Projects
│   └── ...
└── Space: Marketing
    └── ...
```

A **hub** is the top-level organizational entity. Workspaces (spaces) are bound to a hub via `hub_id`. Statuses and tags can be hub-scoped (`hub_id` set, `workspace_id` NULL) — these apply across all spaces in the hub. Members are managed at the hub level with role-based access (admin/member) plus 16 granular permission flags.

Seven layers:
1. **Web UI** — SPA with home dashboard, board/list/calendar/gantt views, detail panel, subtasks, checklists, dependencies, custom fields, time tracking, favorites, inline editing, search, notifications, settings modal, member management, AI panel
2. **AI Panel** — Cross-workspace conversational assistant using Claude CLI, personalized by user identity
3. **Discord Bridge** — Internal (unauthenticated) endpoints for the Discord bot to create items, search, and resolve users
4. **MCP/Agent API** — Internal workspace-scoped endpoints for programmatic access (MCP tools, Discord AI, agents)
5. **ClickUp Import** — Per-user API key-based import with SSE streaming progress (replaces old system-wide migration)
6. **ClickUp Proxy** — Passthrough to ClickUp API for transition period
7. **Automations Engine** — Server-side rule evaluation on item create/update with depth-limited cascading (max 3), cron-fired due date checks

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-team-hub/app.py` | FastAPI entrypoint, mounts 8 routers + static files |
| `tools/opai-team-hub/config.py` | Env config: server, Supabase, ClickUp, paths |
| `tools/opai-team-hub/routes_api.py` | Core API: workspaces, items, tags, assignments, search, members, Discord settings, ClickUp import, dependencies, time tracking, notifications (`_notify()`, `_get_item_assignees()`), internal endpoints |
| `tools/opai-team-hub/routes_spaces.py` | Hierarchy API: folders, lists, statuses, files, dashboards, templates, profiles, assignees, calendar, invite, Gantt |
| `tools/opai-team-hub/routes_comments.py` | Item comments CRUD + @mention parsing → notifications |
| `tools/opai-team-hub/routes_custom_fields.py` | Custom field definitions CRUD + per-item field values (7 endpoints) |
| `tools/opai-team-hub/routes_automations.py` | Automation rules CRUD + evaluation engine with depth-limited recursion |
| `tools/opai-team-hub/routes_members.py` | Hub/workspace member management (invite, role change, remove) |
| `tools/opai-team-hub/routes_hubs.py` | Hub CRUD, hub member management, hub-level statuses/tags, hub space binding (20 endpoints) |
| `tools/opai-team-hub/routes_clickup.py` | ClickUp API proxy (spaces, lists, tasks, comments, members) |
| `tools/opai-team-hub/clickup_migrate.py` | CLI: full ClickUp-to-Supabase migration (legacy, replaced by web import) |
| `tools/opai-team-hub/backfill_folders.py` | CLI: converts folder:/list: tags into proper hierarchy records |
| `tools/opai-team-hub/static/` | SPA frontend (index.html, app.js, style.css) |
| `tools/shared/auth.py` | Shared JWT auth module (JWKS + HS256) |
| `config/supabase-migrations/012_team_hub.sql` | Base schema (workspaces, items, assignments, comments, tags) |
| `config/supabase-migrations/014_team_hub_hierarchy.sql` | Folders, lists, statuses, files, dashboards, RLS, triggers |
| `config/supabase-migrations/040_team_hub_owner_only_status_tags.sql` | Owner-only RLS for statuses + tags (INSERT/UPDATE/DELETE) |
| `config/supabase-migrations/049_team_hubs.sql` | Hub Model: `team_hubs`, `team_hub_membership`, `team_hub_permissions` tables, hub_id columns, RLS functions/policies, data migration |

## Database Schema

### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `team_workspaces` | Spaces/projects | name, slug, icon, color, owner_id, is_personal, discord_server_id, discord_channel_id, bot_prompt |
| `team_membership` | User-workspace roles | user_id, workspace_id, role (owner/admin/member/viewer), orderindex (per-user space display order) |
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

### Phase 1 Tables (v3.0.0)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `team_checklists` | Checklists per item | item_id, name, orderindex |
| `team_checklist_items` | Items within a checklist | checklist_id, text, checked, assignee_id, orderindex |
| `team_favorites` | User favorites (items, workspaces, etc.) | user_id, target_type, target_id, orderindex, UNIQUE(user_id, target_type, target_id) |
| `team_reminders` | Personal reminders tied to items | user_id, item_id, remind_at, note, fired |

**Phase 1 columns added to `team_items`**: `parent_id` (subtasks), `follow_up_date` (follow-up tracking)

**Phase 1 columns added to `team_lists`**: `id_prefix` (custom task ID prefix, e.g. "BUG"), `id_counter` (auto-increment counter)

### Phase 2 Tables (v3.0.0)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `team_item_dependencies` | Task dependency links | source_id, target_id, type (blocks/blocked_by/relates_to), created_by, UNIQUE(source_id, target_id, type), CHECK(source_id <> target_id) |
| `team_custom_fields` | Workspace-scoped field definitions | workspace_id, name, type (text/number/dropdown/date/checkbox/url/email), options JSONB, orderindex, UNIQUE(workspace_id, name) |
| `team_item_field_values` | Per-item custom field values | item_id, field_id, value, updated_at, UNIQUE(item_id, field_id) |
| `team_time_entries` | Time log entries per item | item_id, user_id, duration (seconds), description, started_at |
| `team_automations` | Workspace automation rules | workspace_id, name, trigger_type, trigger_config JSONB, action_type, action_config JSONB, active |

**Phase 2 columns added to `team_items`**: `start_date` (DATE, for Gantt), `time_estimate` (INTEGER, seconds), `time_logged` (INTEGER, auto-updated by trigger)

**Index**: `idx_team_items_date_range` on `(start_date, due_date)`

### Hub Model Tables (v3.5, migration 049)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `team_hubs` | Top-level hub entity | name, slug (UNIQUE), description, icon, color, created_by |
| `team_hub_membership` | Hub member roster | hub_id, user_id, role (`admin`/`member`), UNIQUE(hub_id, user_id) |
| `team_hub_permissions` | Per-member granular permissions | hub_id, user_id, 16 boolean permission flags (see below), UNIQUE(hub_id, user_id) |

**Hub columns added to existing tables**:
- `team_workspaces.hub_id` — binds a workspace to a hub
- `team_statuses.hub_id` — hub-level statuses (`workspace_id` made nullable for hub-scoped statuses)
- `team_tags.hub_id` — hub-level tags (`workspace_id` made nullable for hub-scoped tags)

**Permission flags** (16 booleans on `team_hub_permissions`):
`can_edit_titles`, `can_change_status`, `can_change_priority`, `can_create_items`, `can_comment`, `can_assign`, `can_create_statuses`, `can_delete_statuses`, `can_create_tags`, `can_delete_tags`, `can_delete_items`, `can_manage_members`, `can_create_spaces`, `can_delete_spaces`, `can_manage_automations`, `can_manage_fields`

Admins bypass all permission checks. Members fall back to their `team_hub_permissions` row.

**RLS helper functions** (defined in migration 049):
- `is_hub_member(hub_id, user_id)` — boolean membership check
- `hub_role(hub_id, user_id)` — returns role text
- `hub_permission(hub_id, user_id, perm_name)` — checks specific permission flag (admins always true)

**Indexes**: `idx_team_hub_membership_hub`, `idx_team_hub_membership_user`, `idx_team_hub_permissions_hub`, `idx_team_workspaces_hub`, `idx_team_statuses_hub`, `idx_team_tags_hub`

### Supporting Tables

| Table | Purpose |
|-------|---------|
| `team_activity` | Audit log (workspace_id, action, actor_id, item_id, details) |
| `team_user_prefs` | Per-user preferences (user_id PK, home_layout JSONB, updated_at) |
| `team_notifications` | User notifications (user_id, type, title, body, item_id, workspace_id, read). Types: `mention`, `assignment`, `update`, `reminder`, `automation` |
| `team_invitations` | Workspace invites (inviter_id, invitee_email, role, status) |
| `team_discord_members` | Discord-to-workspace member mappings |

### Triggers

- **`create_default_statuses()`** — auto-creates 6 statuses (open, to do, in progress, review, done, closed) on workspace insert
- **`create_default_dashboard()`** — auto-creates Overview dashboard with 4 widgets on workspace insert
- **`create_personal_workspace()`** — auto-creates personal workspace on new user signup
- **`update_time_logged()`** — auto-sums `team_time_entries.duration` into `team_items.time_logged` on INSERT/DELETE/UPDATE of time entries

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

### Hubs (`routes_hubs.py`, prefix `/api`)

20 endpoints for hub CRUD, member management, hub-level statuses/tags, and space binding.

**Hub CRUD**: `GET /hubs` (list user's hubs with member counts), `POST /hubs`, `GET /hubs/{hub_id}` (with members, spaces, settings), `PATCH /hubs/{hub_id}` (admin), `DELETE /hubs/{hub_id}` (admin)

**Members**: `GET /hubs/{hub_id}/members` (with profiles + permissions), `POST /hubs/{hub_id}/invite` (by email/user_id, admin-only), `PATCH /hubs/{hub_id}/members/{user_id}` (role + permissions, admin-only), `DELETE /hubs/{hub_id}/members/{user_id}` (admin-only, prevents last-admin removal)

**Hub Statuses**: `GET/POST /hubs/{hub_id}/statuses`, `PATCH/DELETE /hubs/{hub_id}/statuses/{id}` — permission-gated (`can_create_statuses`, `can_delete_statuses`)

**Hub Tags**: `GET/POST /hubs/{hub_id}/tags`, `PATCH/DELETE /hubs/{hub_id}/tags/{id}` — permission-gated (`can_create_tags`, `can_delete_tags`)

**Hub Spaces**: `POST /hubs/{hub_id}/spaces` (create + bind new workspace, permission-gated `can_create_spaces`), `DELETE /hubs/{hub_id}/spaces/{ws_id}` (unbind, permission-gated `can_delete_spaces`)

**Auth model**: All hub endpoints use `_require_hub_member()` or `_require_hub_admin()` guards. Permission-gated endpoints use `_check_hub_permission()` which grants automatic access to admins.

### Core (`routes_api.py`, prefix `/api`)

**Workspaces**: `GET/POST /workspaces`, `POST /workspaces/reorder`, `GET/PATCH/DELETE /workspaces/{ws_id}`

**Items**: `GET/POST /workspaces/{ws_id}/items`, `GET/PATCH/DELETE /items/{item_id}`
- Filter by: type, status, priority, assignee, search query
- Enriched with assignments + tags on detail view
- PATCH supports: `title`, `description`, `status`, `priority`, `due_date`, `start_date`, `follow_up_date`, `list_id`, `folder_id` (last two enable move-between-lists)
- Nullable fields (can be explicitly cleared to `null`): `recurrence`, `links`, `due_date`, `start_date`, `follow_up_date`

**Assignments**: `POST/DELETE /items/{item_id}/assign[/{assign_id}]`

**Tags**: `GET/POST /workspaces/{ws_id}/tags`, `PATCH/DELETE /workspaces/{ws_id}/tags/{tag_id}`, `POST/DELETE /items/{item_id}/tags[/{tag_id}]`
- Workspace-level tag CRUD: create, rename (PATCH name/color), delete (cascades to item associations). **Owner-only** — POST/PATCH/DELETE check membership role = `owner` (403 otherwise)
- Item-level tag assignment/removal — any member can assign/unassign existing tags to tasks

**Members**: `GET /workspaces/{ws_id}/members`, `POST /workspaces/{ws_id}/add-member` (direct add by user_id), `DELETE /workspaces/{ws_id}/members/{user_id}` (remove member — admin/owner only, prevents self-removal), `POST /workspaces/{ws_id}/invite` (email-based, legacy), `POST /invitations/{id}/accept|decline`

**Subtasks**: `GET /items/{item_id}/subtasks`, `POST /items/{id}/subtasks/reorder`
- Subtasks are regular items with `parent_id` set; top-level views filter `parent_id IS NULL`

**Checklists**: `GET/POST /items/{id}/checklists`, `DELETE /checklists/{id}`, `POST /checklists/{id}/items`, `PATCH/DELETE /checklist-items/{id}`

**Favorites**: `GET/POST /my/favorites`, `POST /my/favorites/reorder`, `DELETE /my/favorites/{id}`

**Reminders**: `GET/POST /my/reminders`, `DELETE /my/reminders/{id}`, `POST /internal/fire-reminders` (background — converts due reminders to notifications)

**Activity**: `GET /workspaces/{ws_id}/activity`, `GET /items/{item_id}/activity`

**Search**: `GET /search?q=...` (cross-workspace full-text search)

**My Work**: `GET /my/items`, `GET /my/home`, `GET/POST /my/notifications[/read]`, `DELETE /my/notifications/{id}`

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

**Dashboards**: `GET /workspaces/{ws_id}/dashboard` (with computed widget data including `open_tasks` list and `open_count`), `POST /workspaces/{ws_id}/dashboard/widgets`, `DELETE /dashboard/widgets/{id}`

**Space Dashboard Widgets** (render order):
1. **Open Tasks** — full-width card showing all non-done/closed tasks (max 20 displayed). Status dot, title, status label, due date (overdue highlighted red). Count badge in header. "+N more" overflow navigates to list view. Backend: filters items where status not in `{done, closed, Complete, Approved}`, sorted by `updated_at` desc.
2. **Tasks by Status** — horizontal bar chart per status with counts
3. **Priority Breakdown** — horizontal bar chart per priority level
4. **Due Soon** — items due within 7 days, sorted by due_date
5. **Recent Activity** — last 10 activity entries
6. **Files** — workspace files with upload button

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
| `/internal/search-workspaces` | `GET` | Search workspaces by name (ilike). Params: `q`, `limit` (default 5). Returns `{ workspaces: [{id, name, slug, icon}] }` |
| `/internal/create-workspace` | `POST` | Create workspace with template structure. Params: `name`, `owner_id`, `template` (client/project). Creates folders + default statuses + membership |

All write endpoints set `created_by` / `author_id` to `"ai-assistant"` by default. The `create-item` endpoint supports `assigned_by` (default `"discord-bot"`), `start_date`, and `time_estimate`.

`create-workspace` template folders: **client** (Meeting Action Items, Deliverables, Communications), **project** (Tasks, Documentation, Research). Default statuses: Open, In Progress, Done.

### Dependencies (`routes_api.py`, prefix `/api`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/items/{id}/dependencies` | `GET` | List all dependencies for an item (both directions) |
| `/items/{id}/dependencies` | `POST` | Create a dependency (type: blocks/blocked_by/relates_to) |
| `/dependencies/{id}` | `DELETE` | Remove a dependency link |
| `/items/{id}/blocking-check` | `GET` | Check if an item is blocked by unfinished items |

### Time Tracking (`routes_api.py`, prefix `/api`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/items/{id}/time-entries` | `GET` | List time entries for an item |
| `/items/{id}/time-entries` | `POST` | Log a time entry (duration in seconds, optional description + started_at) |
| `/time-entries/{id}` | `DELETE` | Delete a time entry (auto-updates item's time_logged via trigger) |
| `/items/{id}/time-estimate` | `PATCH` | Set/update time estimate (seconds) |

### Custom Fields (`routes_custom_fields.py`, prefix `/api`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workspaces/{id}/custom-fields` | `GET` | List all custom field definitions for a workspace |
| `/workspaces/{id}/custom-fields` | `POST` | Create a custom field (name, type, options) |
| `/custom-fields/{id}` | `PATCH` | Update field name, options, or orderindex |
| `/custom-fields/{id}` | `DELETE` | Delete a custom field and all its values |
| `/items/{id}/field-values` | `GET` | Get all field values for an item |
| `/items/{id}/field-values/{field_id}` | `PUT` | Set/upsert a field value |
| `/items/{id}/field-values/{field_id}` | `DELETE` | Clear a field value |

### Automations (`routes_automations.py`, prefix `/api`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workspaces/{id}/automations` | `GET` | List all automation rules for a workspace |
| `/workspaces/{id}/automations` | `POST` | Create an automation rule (trigger + action config) |
| `/automations/{id}` | `PATCH` | Update automation name, config, or active state |
| `/automations/{id}` | `DELETE` | Delete an automation rule |
| `/internal/check-due-automations` | `POST` | Fire due_date_passed automations (designed for cron/heartbeat) |

**Trigger types**: `status_changed`, `priority_changed`, `assignee_added`, `due_date_passed`, `item_created`
**Action types**: `change_status`, `change_priority`, `add_assignee`, `send_notification`, `move_to_list`, `add_tag`

Automation evaluation: runs server-side in `create_item` and `update_item` after successful DB write. Depth-limited recursion (max 3) prevents infinite loops. All execution is non-fatal (try/except).

### Gantt (`routes_spaces.py`, prefix `/api`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workspaces/{id}/gantt` | `GET` | Returns items with start_date/due_date, dependencies, and statuses for Gantt rendering |

### Docs (`routes_spaces.py`, prefix `/api`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workspaces/{ws_id}/docs` | `GET` | List docs for a workspace (optional folder_id/list_id/item_id filter) |
| `/workspaces/{ws_id}/docs` | `POST` | Create a doc (title, content, optional folder_id/list_id/item_id) |
| `/docs/{doc_id}` | `GET` | Get doc with pages and author info |
| `/docs/{doc_id}` | `PUT` | Update doc title/content/location |
| `/docs/{doc_id}` | `DELETE` | Delete doc and all pages |
| `/docs/{doc_id}/pages` | `POST` | Add a page to a doc |
| `/docs/{doc_id}/pages/{page_id}` | `PUT` | Update page title/content/orderindex |
| `/docs/{doc_id}/pages/{page_id}` | `DELETE` | Delete a page |

Frontend: Full editor UI with markdown-it rendering, inline title editing, page management (add/edit/delete), "New Doc" via sidebar right-click on spaces/folders.

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
- **All Tasks** (sidebar button): Opens the home list view showing all hub tasks. Clears space/list selection, sets `show_all=true` and `hide_completed=true`, switches to list view. Uses the same `GET /api/my/all-items` endpoint as the home list view. Checkbox toggling uses surgical DOM updates (no API refetch).
- **Board view**: Kanban-style columns by status, drag-and-drop between columns, per-column quick-add, description previews on cards, collapsible columns, empty column drop zones
- **List view**: Table with all columns sortable (Title, Space, List, Status, Priority, Assignee, Tags, Updated), inline status/priority badges. Multi-select checkbox filters for Status/Priority/Tags, toggle switches for My Tasks and Hide Completed.
- **Calendar view**: Month grid (7-column CSS grid) filling the full viewport height. Status-colored task pills, up to 3 per day visible; days with more show a "+N more" button that opens a slim floating popup listing all tasks for that day (click any task to open the detail panel, click outside or press Escape to dismiss). Month navigation (prev/next/today); works at space level or list level. Grid rows are set dynamically to match the exact week count of the displayed month (no empty gray row).
- **Gantt view**: SVG-based timeline chart. Day-level columns, color-coded bars by status, bezier-curve dependency arrows, today line, zoom +/- controls. Items without start/due dates excluded. Endpoint: `GET /api/workspaces/{id}/gantt`
- **Dashboard view**: Widget-based overview. Position #1: **Open Tasks** (full-width card showing all non-closed/done tasks with status dots, count badge, and overflow link). Followed by status counts, priority breakdown, due-soon items, recent activity, and files

### Home Dashboard

The home dashboard replaces the old empty "Select a list" state with a curateable tile-based overview. All tile layout, visibility, and size preferences persist per-user in `localStorage` (key: `teamhub_home_layout_{userId}`).

**Data source**: Single aggregation endpoint `GET /api/my/home` returns all tile data in one call, avoiding N+1 frontend requests.

#### Home Tiles

| Tile ID | Title | Data | Default |
|---------|-------|------|---------|
| `top3` | Top 3 Priorities | Highest-priority assigned items (sorted by priority then due_date) | visible |
| `priorities` | Priorities | Composite urgency score (overdue weight + due proximity + priority level + recency) | visible |
| `overdue` | Overdue | Items with due_date < today, not done — sorted **most recently overdue first** | visible |
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

**Tile overflow links**: When a tile has more items than its size limit allows, a clickable "+N more" link appears at the bottom (styled with accent color). Clicking it navigates to the **home list view** with sorting appropriate for the tile type:
- **Overdue** → list sorted by `due_date` ascending (most overdue first)
- **Due This Week** → list sorted by `due_date` ascending
- **Follow-ups** → list sorted by `follow_up_date` ascending
- **Other** → list sorted by `updated_at` descending (default)

Function: `showAllFromTile(tileType)` — clears filters, sets sort, switches to list view.

#### Home List View (All Tasks Table)

The home list view shows all tasks across all user's workspaces in a unified table. Accessed by clicking the **List** button in the header, or via tile overflow links.

**Endpoint**: `GET /api/my/all-items` — returns items, workspace metadata, and available tags.

| Parameter | Type | Description |
|-----------|------|-------------|
| `sort` | string | Sort column: `updated_at`, `created_at`, `title`, `status`, `priority`, `due_date` (server-side); `workspace_name`, `list_name`, `assignee`, `tags` (client-side) |
| `direction` | string | `asc` or `desc` |
| `status` | string | Comma-separated status names for multi-filter (e.g. `Working on,Stuck`) |
| `priority` | string | Comma-separated priority values for multi-filter (e.g. `high,critical`) |
| `workspace_id` | UUID | Filter to a single workspace |
| `tag` | string | Comma-separated tag names for multi-filter |
| `show_all` | bool | `true` = all workspace tasks; `false` (default) = only user's assigned tasks |
| `hide_completed` | bool | `true` (default from UI) = exclude Complete/done/closed statuses at DB level |
| `limit` | int | Max items (default 200, max 500) |

**Toggle switches** (subheader bar):

| Toggle | Default | Behavior |
|--------|---------|----------|
| **My Tasks** | ON | When ON, shows only tasks assigned to the current user. When OFF, shows all tasks across the user's workspaces. Clear toggle-switch UI with slider indicator. |
| **Hide Completed** | ON | When ON, excludes items with `Complete`, `done`, `closed` statuses at the database query level via PostgREST `not.in.()` filter. |

**Multi-select filter dropdowns** (Status, Priority, Tags):

All three filters use checkbox-based multi-select dropdowns (not single `<select>`). Each option shows:
- A color dot matching the status/priority/tag color
- A checkbox (accent-colored when checked)
- The option label

Features:
- Active dropdown shows selection count in the button label: `Status (2)`
- Button highlighted with accent border + background when any options selected
- "Clear all" link at the top of dropdown when selections exist
- Multiple values sent as comma-separated to the API (e.g. `status=Working on,Stuck`)
- Backend uses PostgREST `in.()` for multi-value queries, `eq.` for single values
- Close on click outside

**Sortable column headers** — all 8 data columns are sortable by clicking the header:

| Column | Sort Type | Default Direction |
|--------|-----------|-------------------|
| Title | Server (API re-fetch) | A→Z |
| Space | Client (in-memory sort) | A→Z |
| List | Client (in-memory sort) | A→Z |
| Status | Server (API re-fetch) | Z→A |
| Priority | Server (API re-fetch) | Z→A |
| Assignee | Client (in-memory sort) | A→Z |
| Tags | Client (in-memory sort) | A→Z |
| Updated | Server (API re-fetch) | Newest first |

Sort indicator: triangle arrow (▲/▼) shown next to the active sort column. Click again to reverse direction.

**My Tasks filter logic** (backend `routes_api.py`):
1. Fetch all items across user's workspaces (respecting status/priority/workspace/hide_completed filters)
2. Fetch all assignments for those items
3. When `show_all=false` (My Tasks ON): filter to items where the user is an assignee. If no matches, show empty (no fallback to all items).
4. Post-filter by tag if specified (requires joined data)

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

#### Live Home Tile Updates

When a task's `due_date` or `status` is changed from the detail panel while on the home page, tiles update instantly without a server refetch:

1. `updateField()` detects it's on the home page (`!_currentListId` + board view)
2. Calls `_syncHomeDataForItem(task)` which updates `_homeData` arrays in-place:
   - **Overdue**: removes if no longer overdue (date cleared, moved to future, or status closed); adds if now overdue
   - **Due This Week**: removes/adds based on new date vs today..+7 days
   - **Recent Todos / Top Items / Priorities**: updates in-place if the item exists in those arrays
3. Calls `renderHomeTiles()` to re-render all tiles from the updated cache — no `renderHome()` / server refetch
4. If the PATCH fails, the optimistic sync is reverted (task field restored → `_syncHomeDataForItem` re-run → tiles re-rendered)

This avoids the race condition where `renderHome()` would refetch stale data before the PATCH completes.

#### Board View Enhancements

The board view (`renderBoard()`) includes:

- **All statuses shown**: Renders every defined status as a column, even those with 0 tasks
- **Quick-add per column**: "+ Add task" button at bottom of each column body. Clicking reveals inline text input — Enter creates a task with that column's status in the current list. Functions: `showBoardQuickAdd(status)`, `submitBoardQuickAdd(status, title)`
- **Description preview on cards**: First ~80 chars of `description` shown as a gray truncated line below the title (`.th-card-desc`)
- **Empty column placeholder**: When a column has 0 cards, shows "Drag tasks here or click + below" with a dashed border so the drop target is visible
- **Collapse/expand columns**: Chevron button on column header. Collapsed = 42px narrow bar with vertical status name + count, still accepts drag-and-drop. State tracked in `_collapsedColumns` Set (in-memory). Function: `toggleBoardColumn(status)`

#### Home Dashboard Data Pipeline

`GET /api/my/home` aggregation flow:

1. **Memberships** — `team_membership` → list of workspace IDs the user belongs to
2. **Assignments** — `team_assignments` → set of item IDs explicitly assigned to the user
3. **All items** — `team_items` in user's workspaces, ordered by `updated_at.desc`, limit 200
4. **Effective items** — filter to items where `id ∈ assigned_set OR created_by = user.id` (creator always sees own items). Falls back to all workspace items if no matches.
5. **Active items** — exclude closed statuses (`done`, `closed`, `archived`, `Complete`)
6. **Per-tile queries**:
   - **Priorities**: scored by composite urgency (overdue weight capped at 30d + due proximity + priority level + recency boost)
   - **Overdue**: separate query (limit 500, `due_date.desc`) to avoid the 200-item window. Filters to assigned OR created-by user.
   - **Due This Week / Follow-ups**: filtered from active items
   - **Mentions**: separate `team_comments` `ilike` query for `@DisplayName`/`@emailPrefix`, excludes own, limit 30

**Important: Overdue sort order is `desc` (most recently overdue first).** This prevents old imported tasks (e.g. from ClickUp) from permanently burying new overdue items in the default 5-item tile view.

#### Auto-Assignment on Creation

Both item creation endpoints (`POST /workspaces/{ws_id}/items` and `POST /lists/{list_id}/items`) automatically assign the creator as an assignee via `team_assignments`. This ensures:
- New items immediately appear in the creator's dashboard tiles (overdue, priorities, due this week, etc.)
- No "invisible task" bug where items exist in list view but are absent from the home dashboard
- Assignment is visible in the detail panel's assignee section

The auto-assignment is non-blocking — if it fails, the item is still created successfully.

#### Known Gotcha: Large Import Backlogs

Users with many imported tasks (e.g. from ClickUp) may have hundreds of overdue items spanning years. The overdue tile's `desc` sort ensures recent overdue items appear first. The priorities tile's scoring caps overdue weight at 30 days, so all 30+-day-overdue items score equally and differentiate by priority level and recency instead.

### UI Components

- **Sidebar**: Workspace selector + folder/list tree hierarchy with expand/collapse. Supports drag-and-drop at every level:
  - **Space reorder**: Drag any space row up/down to reorder. Purple indicator line shows insertion position (above/below target). Order is per-user (stored as `orderindex` on `team_membership`), persisted via `POST /workspaces/reorder`. Optimistic UI — reverts on API failure.
  - **Folder move**: Drag a folder onto a different space to move it between spaces.
  - **List move**: Drag a list onto a folder (to nest it) or onto a space (to make it folderless). Works across spaces.
  - **Task move**: Drag a task card from the main content area onto a sidebar list to move it.
- **Detail panel**: Slide-out (60vw, max 900px) with colored pill-dropdown pickers for status and priority; header action buttons (Move, Duplicate, Delete); assignees (OPAI users only), tags, markdown description with Pretty/Raw toggle, files with preview popup, comments with @mention autocomplete. Navbar-aware positioning (`top: 44px`, `height: calc(100vh - 44px)`).
- **Header**: Hub logo (shows `{icon} {hub_name}` when in a hub, "TeamHub" otherwise), All Tasks (list icon), Search (global, `/` shortcut), Create New (5 types: Space, Folder, List, Task, Structure), Templates, Invite (Add Team Member), Settings (gear icon), **AI panel toggle** (brain icon), notifications bell
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

#### Comment Input

The comment input is an **auto-resizing `<textarea>`** (not a single-line input) that wraps text and grows up to 160px tall:

- **Enter** sends the comment, **Shift+Enter** inserts a new line
- Supports image attachment via button or clipboard paste (images uploaded to Supabase Storage, embedded as markdown)
- A formatting hint below the input shows available markdown syntax

**Markdown rendering in comments**: Posted comments render basic markdown formatting via `renderMentions()`:
- `**bold**` → **bold**, `*italic*` → *italic*, `` `code` `` → inline code
- Newlines preserved as `<br>`, `- item` rendered as bullet points
- `![alt](url)` for images (from image attachments)

Functions: `commentKeyHandler(e)`, `autoResizeComment(el)`, `postComment()`, `renderMentions(text)`

#### @Mention Autocomplete

Comment input supports `@` mention autocomplete:

1. Typing `@` followed by characters triggers a filtered dropdown of workspace members (from `_allAssignees` + `_profiles`)
2. Dropdown positioned above input, max 5 results, shows avatar initials + display name
3. Arrow Up/Down navigate, Enter/click selects, Escape dismisses
4. On select: replaces `@partial` with `@DisplayName ` (trailing space)
5. Mentions render as `<span class="th-mention-pill">` in comment display (blue pill)

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

Title: **"{hub_icon} {hub_name} Settings"** when in a hub (e.g. "🏢 Water's Edge Settings"), or **"TeamHub Settings"** when no hub. Opens from any context — home, within a space, list, or folder. Nine tabs:

1. **Landing** — Home dashboard tile configuration: toggle switches for tile visibility, clickable size badge to cycle through 6 sizes (1x1 → 2x1 → 3x1 → 1x2 → 2x2 → 3x2), drag handles to reorder tiles, "Reset to Defaults" button.
2. **Statuses** — Hub admins: full CRUD (inline color picker, rename, delete with confirmation, add row). Hub members: read-only list. Info text adapts: hub mode says "hub-wide workflow statuses", non-hub says "workspace statuses".
3. **Priorities** — Info text explaining these are built-in system-wide levels. Both see read-only color badges (critical, high, medium, low, none).
4. **Tags** — Hub admins: full CRUD (inline color picker, rename, delete). Hub members: read-only list. Info text adapts like statuses.
5. **Fields** — Custom field definitions for the current workspace. Create fields with name + type (text/number/dropdown/date/checkbox/url/email). Delete fields. Dropdown type supports comma-separated options.
6. **Automations** — Automation rule builder for the current workspace. Create rules with trigger type + config → action type + config. Toggle active/inactive per rule. Delete rules.
7. **Members** — Hub-aware member management (see below).
8. **Import** — ClickUp import flow (see [ClickUp Migration > Web Import](#web-import-primary--settings-modal))
9. **Telegram** — Info page with instructions to join the OPAI Telegram group's Team Hub topic, and a direct contact link to Dallas (`t.me/Dalwaut`) for access requests or troubleshooting

#### Members Tab (Hub Mode)

When user belongs to a hub, the Members tab loads from `GET /api/hubs/{hub_id}/members` instead of workspace-level members. Displays:

- **Member cards** — avatar, name, email, role badge (admin/member)
- **Role dropdown** — admin-only: switch between admin/member
- **Permissions grid** — 16 toggle checkboxes for granular permissions (only shown for non-admin members, since admins bypass all checks). Each toggle calls `PATCH /api/hubs/{hub_id}/members/{user_id}` with the permission field.
- **Remove button** — admin-only: removes member from hub (with confirmation)

Key frontend functions: `changeHubMemberRole()`, `updateHubMemberPermission()`, `removeHubMember()`

See [Global Settings Ownership Model](#global-settings-ownership-model) for the full architecture.

### Global Settings Ownership Model

#### Hub Mode (v3.5)

When a hub exists, statuses and tags are **hub-scoped** — stored with `hub_id` set and `workspace_id` NULL. They apply to all spaces in the hub. The settings modal routes to hub-level API endpoints.

**Architecture**:
- Hub-level statuses/tags are the canonical source (stored in `team_statuses`/`team_tags` with `hub_id`, `workspace_id = NULL`)
- Settings modal loads/writes via `GET/POST/PATCH/DELETE /api/hubs/{hub_id}/statuses` and `/api/hubs/{hub_id}/tags`
- Hub admins have full CRUD; members are permission-gated (`can_create_statuses`, `can_delete_statuses`, `can_create_tags`, `can_delete_tags`)
- `team_items.status` and `team_items.priority` remain **TEXT fields** — tasks reference statuses by name
- Member management is hub-level via `routes_hubs.py` endpoints

**Key frontend functions** (`app.js`):
- `_myHub()` — returns the user's hub object (from `GET /api/hubs` on init)
- `showAllHubTasks()` — navigates to All Tasks list view for the hub

#### Legacy Mode (no hub)

Statuses, tags, and priorities are **global per owner** — the workspace owner defines one canonical set that applies across their entire TeamHub. Non-owners (invited members) see read-only views but can still assign existing statuses/tags to tasks.

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

### Telegram Integration

The Telegram tab in Settings (formerly "Discord AI") is an informational page that directs users to the OPAI Telegram group for Team Hub bot access.

**Content:**
- Instructions to join the OPAI Telegram group and find the **Team Hub** topic
- What the bot can do (create/search/update tasks, manage spaces/folders/lists, comments, summaries)
- Contact link to Dallas on Telegram (`t.me/Dalwaut`) for access requests or troubleshooting

**Key function**: `renderSettingsDiscordAI()` (internal name retained for tab routing compatibility)

**Backend**: Discord settings routes (`GET/PATCH /workspaces/{ws_id}/discord`) still exist for the Telegram bridge's channel resolution via `GET /api/internal/resolve-channel`.

### System Update Banner

When a `system_update` broadcast is received via Realtime, a purple banner slides down from the top with the update message and a "Refresh Now" button. This enables zero-downtime deployments — the system can be updated and users are notified in real time to reload.

Function: `showSystemUpdateBanner(message)`

### Realtime

**Postgres Changes — Live Item Sync** (`team-items-{listId}` channel):

When a list is selected, Team Hub subscribes to `postgres_changes` on `team_items` filtered by `list_id`. This catches ALL changes regardless of source (browser, Telegram bot, MCP tools, direct API):
- **UPDATE** — patches the task in `_tasks` in-place, re-renders list/board, updates detail panel if open (skips if user is editing)
- **INSERT** — adds new task to `_tasks` (deduplicates if already added optimistically), re-renders view
- **DELETE** — removes from `_tasks`, closes detail panel if viewing that task, re-renders
- Subscription managed via `subscribeToListItems(listId)` / `unsubscribeFromListItems()` — auto-switches when navigating between lists, unsubscribes when going to home/dashboard
- Requires `REPLICA IDENTITY FULL` on `team_items` (set) for DELETE old-row data

**Broadcast channel** (`team-hub-live`) for cross-user events:
- `comment_added` — refreshes comments if detail panel is open for that task
- `structure_changed` — space/folder/list deleted, live-updates sidebar for other users
- `system_update` — displays refresh banner when system has been updated
- `task_updated` / `task_created` — kept as no-op placeholders (Postgres Changes handles data sync)

**Postgres Changes — Notifications** (`team-hub-notifs` channel):
- `team_notifications` INSERT listener — filters by `user_id === _user.id`, triggers `pollNotifications()` for badge update and shows toast with notification title

### State Management

Key state variables in `app.js`:

| Variable | Purpose |
|----------|---------|
| `_user` | Current authenticated user |
| `_spaces` | All workspace records |
| `_profiles` | All OPAI user profiles (for dropdowns/search) |
| `_homeData` | Cached response from `/api/my/home` for home dashboard tiles. Live-synced by `_syncHomeDataForItem()` on detail panel due_date/status changes |
| `_homeLayout` | Tile layout/visibility/size prefs (synced to localStorage) |
| `_collapsedColumns` | Set of status names with collapsed board columns (in-memory) |
| `_currentSpaceId` / `_currentListId` | Active navigation context |
| `_currentStatuses` | Statuses for active workspace (used in board columns + pill pickers) |
| `_tasks` | Items loaded for current list |
| `_allAssignees` | OPAI-only assignees for active workspace |
| `_detailTask` | Currently open task in detail panel |
| `_itemsChannel` | Postgres Changes subscription for current list's `team_items` (auto-managed) |
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

## Phase 1 — ClickUp Clone Features (v3.0.0)

### Custom Task IDs

- Per-list configurable prefix (e.g., "BUG", "FEAT") via `id_prefix` on `team_lists`
- Auto-increment counter: BUG-001, BUG-002... generated on item creation
- Shown in board cards, list rows, detail panel header, search results
- Searchable in all search endpoints (user and internal)

### Subtasks

- `parent_id` column on `team_items` — subtasks are regular items with a parent
- Top-level list views filter `parent_id IS NULL` by default (`include_subtasks` query param to override)
- Detail panel shows "Subtasks" section with inline add, status toggle, click-to-open
- Board/list cards show subtask count badge (done/total)
- Internal API accepts `parent_id` for agent-created subtasks
- Reorder endpoint: `POST /api/items/{id}/subtasks/reorder`

### Checklists

- Multiple checklists per item, each with name + ordered items
- Checklist items: text, checked (bool), optional assignee
- Progress indicator per checklist (done/total + progress bar)
- 6 API endpoints: `GET/POST /api/items/{id}/checklists`, `DELETE /api/checklists/{id}`, `POST /api/checklists/{id}/items`, `PATCH /api/checklist-items/{id}`, `DELETE /api/checklist-items/{id}`
- Tables: `team_checklists`, `team_checklist_items`

### @Mentions

- Structured format: `@[Display Name](user_id)` stored in comment content
- Autocomplete dropdown on `@` in comment input, inserts structured format
- Rendered as blue `.th-mention-pill` spans in comment display
- Backend `_parse_mentions()` extracts user IDs → creates `team_notifications` entries
- Backward-compatible with legacy plain `@Name` mentions

### Favorites

- Toggle star on items (extensible to workspaces, folders, lists)
- `POST /api/my/favorites` toggles (add or remove)
- `GET /api/my/favorites` loaded on init, rendered in sidebar section
- `POST /api/my/favorites/reorder`, `DELETE /api/my/favorites/{id}`
- Table: `team_favorites` (user_id, target_type, target_id, orderindex, UNIQUE constraint)

### Reminders

- Personal reminders tied to items
- Quick options: 15min, 1hr, tomorrow 9AM, next Monday 9AM, custom datetime
- `POST /api/internal/fire-reminders` — background endpoint converts due reminders to notifications
- Designed to be fired by OPAI Engine heartbeat (every 60s)
- `GET/POST /api/my/reminders`, `DELETE /api/my/reminders/{id}`
- Table: `team_reminders` (user_id, item_id, remind_at, note, fired)

### Notifications

Notification system creates alerts for assignment, task updates, mentions, reminders, and automations. Uses `team_notifications` table with Supabase Realtime for instant delivery.

**Backend helpers** (`routes_api.py`):
- `_notify(client, user_id, type, title, body, item_id, workspace_id, skip_user_id)` — generic notification creator; skips if `user_id == skip_user_id` (no self-notifications)
- `_get_item_assignees(client, item_id)` — fetches all `assignee_id` from `team_assignments`

**Notification triggers**:

| Trigger | Type | Fired From | Title Format |
|---------|------|------------|--------------|
| Task assigned | `assignment` | `assign_item()` | "Assigned to: {title}" |
| Task updated (status, priority, due_date, title) | `update` | `update_item()` | "Updated: {title}" with change summary body |
| @mention in comment | `mention` | `_parse_mentions()` | "Mentioned in: {title}" |
| Reminder fires | `reminder` | `fire_reminders()` | "Reminder: {title}" |
| Automation sends notification | `automation` | `_execute_action()` | "Automation: {name}" |

**API**: `GET /my/notifications`, `POST /my/notifications/read` (mark read — specific IDs or all), `DELETE /my/notifications/{id}` (dismiss single)

**Frontend dropdown** (`app.js`):
- Bell icon in header with unread badge (polled every 30s + Realtime INSERT listener)
- Dropdown shows type icon, title, body snippet (truncated 80 chars), timestamp
- Type icons: assignment (person), mention (@), update (pencil), reminder (bell), automation (bolt)
- **Click** a notification → marks read, opens task detail panel (if `item_id`), closes dropdown
- **Dismiss** (× button) → `DELETE /my/notifications/{id}`, removes DOM element, updates badge
- **Mark all read** → `POST /my/notifications/read` with empty `notification_ids`

### Inline Editing (List View)

- Double-click title, status, or priority cells in home list view to edit in-place
- Title: text input, Status: dropdown, Priority: dropdown
- On blur/Enter → PATCH item via existing endpoint
- On Escape → cancel edit, no backend changes needed

## Phase 2 — ClickUp Clone Features (v3.0.0)

### Dependencies

- `team_item_dependencies` table with type: blocks, blocked_by, relates_to
- Constraint: `source_id <> target_id`, UNIQUE(source_id, target_id, type)
- Detail panel "Dependencies" section with searchable item picker
- Dep type badges color-coded: red (blocks), amber (blocked_by), indigo (relates_to)
- `GET /api/items/{id}/blocking-check` — returns whether item is blocked by unfinished items
- 4 API endpoints: list, create, delete deps + blocking check

### Gantt View

- SVG-based timeline chart rendered client-side (no external library)
- Day-level columns, bars color-coded by status, dependency arrows as bezier curves
- Today line (dashed accent), zoom +/- controls (day width 30-120px)
- Items without start_date or due_date excluded from Gantt
- Row labels clickable → opens detail panel
- Endpoint: `GET /api/workspaces/{id}/gantt` returns items + deps + statuses

### Custom Fields

- Workspace-scoped field definitions: text, number, dropdown, date, checkbox, url, email
- Per-item values stored in `team_item_field_values` (upsert pattern)
- Detail panel "Custom Fields" section with type-appropriate inputs
- Settings → Fields tab for definition management (create/delete)
- Dropdown fields support comma-separated options
- 7 API endpoints via `routes_custom_fields.py`

### Time Tracking

- Per-item time entries in `team_time_entries`
- Live timer: Start/Stop button with localStorage persistence (`_activeTimer`)
- Manual time log: minutes input + description
- Time estimate: editable field on item, progress bar (logged/estimate)
- `time_logged` auto-updated on `team_items` via database trigger
- Progress bar turns red when logged > estimate
- 4 API endpoints: list entries, log entry, delete entry, set estimate

### Automations

- Workspace-scoped rules: trigger condition → action
- **Triggers**: status_changed, priority_changed, assignee_added, due_date_passed, item_created
- **Actions**: change_status, change_priority, add_assignee, send_notification, move_to_list, add_tag
- Evaluated server-side after item create/update (non-fatal, try/except)
- Depth-limited recursion (max 3) prevents infinite automation loops
- `POST /api/internal/check-due-automations` for cron-fired due date checks
- Settings → Automations tab for rule builder (create, toggle, delete)
- 5 API endpoints via `routes_automations.py`

---

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
- **My Tasks filter fallback removed** — Previously, `GET /my/all-items` with `show_all=false` fell back to showing ALL items if the user had zero matching assignments. This caused non-assigned tasks to leak through. Fixed 2026-03-06: now strictly filters to assigned items only — shows empty if no assignments match.

## OPAI Workers Workspace (v3.5)

A dedicated workspace in Team Hub serves as the **single source of truth** for all agent/system task management — replacing scattered `tasks/registry.json`, `tasks/queue.json`, and `reports/HITL/*.md` files. Both humans and agents interact through the same system.

### Workspace Structure

```
OPAI Workers (workspace: d27944f3-8079-4e40-9e5d-c323d6cf7b0f)
├── "System" Folder
│   ├── "HITL Queue" List (ac6071d1-c86b-4c09-b379-cae8e4f5bd63)
│   │     Items needing human decision (status: awaiting-human)
│   ├── "Active Work" List (0e074890-a10f-4f7f-9155-9bf0094f9559)
│   │     Items currently being executed by agents
│   └── "Completed" List
│         Done items (auto-archive after 7 days)
├── "Agents" Folder
│   ├── "Research" List
│   ├── "Build" List
│   ├── "Review" List
│   └── "Maintenance" List
└── "External Workers" Folder
    └── Per-worker lists (e.g., "cc-research-01")
```

### Custom Statuses

| Status | Type | Meaning |
|--------|------|---------|
| `open` | open | New, unassigned |
| `awaiting-human` | open | **HITL: needs Dallas's decision** |
| `assigned` | active | Assigned to agent/worker, not started |
| `in-progress` | active | Agent actively working |
| `blocked` | active | Agent stuck, needs input |
| `review` | active | Work done, needs human review |
| `done` | done | Completed successfully |
| `dismissed` | closed | Rejected/not needed |
| `failed` | closed | Execution failed |

> **Note (OPAI Workers only):** The above statuses are specific to the Workers workspace. User-facing workspaces use a normalized set of status values — see [Data Quality](#data-quality--status-normalization) below.

### Item Types

| Type | Created By | Purpose |
|------|-----------|---------|
| `task` | Fleet coordinator, manual | Work to be executed |
| `decision` | Task processor (HITL) | Human decision required |
| `idea` | Proactive intelligence | System suggestion, low priority |

### Tags

`hitl`, `auto-routed`, `external-worker`, `high-priority`, `escalated`

### How the Engine Uses Workers Workspace

1. **Task processor** creates `decision` items (status: `awaiting-human`) when HITL approval is needed
2. **Fleet coordinator** updates items to `in-progress` on dispatch, `review` on completion
3. **NFS dispatcher** syncs `awaiting-human` items to admin HITL directory for GravityClaw
4. **Proactive intelligence** creates `idea` items when it detects patterns
5. **Action items API** aggregates all items into a single prioritized feed
6. **Notifier** sends Telegram alerts with action buttons for `awaiting-human` items

### System User

All Engine-created items use the system user ID: `1c93c5fe-d304-40f2-9169-765d0d2b7638` (same as Dallas's profile — acts as the system identity).

### Internal API Usage

The Engine communicates with Team Hub via the unauthenticated internal API at `http://127.0.0.1:8089/api/internal/`:

| Operation | Endpoint | Parameters |
|-----------|----------|------------|
| Create item | `POST /create-item` | workspace_id, type, title, description, priority, status, list_id |
| Update status | `PATCH /update-item` | item_id, status |
| Add comment | `POST /add-comment` | item_id, content, author_id |
| List items | `GET /list-items` | workspace_id, status (filter) |
| Get item | `GET /get-item` | item_id |

**Priority values**: `low`, `medium`, `high`, `urgent` (NOT `normal` — violates check constraint).

**@mention parsing**: The `/internal/add-comment` endpoint now calls `_parse_mentions()` from `routes_comments.py`, enabling agents to trigger real notifications when using `@[Name](uuid)` syntax in comments. This was previously only available on the authenticated route.

### Shared TeamHubClient (`tools/shared/teamhub_client.py`)

Synchronous Python client wrapping the internal API for agent use. Replaces ad-hoc `requests.post()` calls across agent scripts.

```python
from shared.teamhub_client import TeamHubClient, DALLAS_UUID

th = TeamHubClient()
task = th.create_task(title="...", priority="high", assignee_id=DALLAS_UUID)
th.add_comment(task["id"], "Progress update", is_agent_report=True)
th.mention_dallas(task["id"], "Need HITL input on pricing")
th.complete(task["id"])
```

Methods: `create_task()`, `add_comment()`, `assign()`, `update_status()`, `update_task()`, `mention_dallas()`, `create_subtask()`, `complete()`.

### Post-Squad Hook Bridge

`scripts/post_squad_hook.py` now mirrors squad findings to Team Hub alongside the existing `tasks/registry.json` entries:

1. Creates parent task: `[SQUAD_NAME] Agent findings — YYYY-MM-DD`
2. Adds per-agent comments with P0/P1/P2 action items
3. P0 items trigger `@[Dallas]` mention → notification
4. Backward-compatible — registry entries still created

See [Fleet Coordinator & Action Items](../infra/fleet-action-items.md) and [NFS Dispatcher](../infra/nfs-dispatcher.md) for full integration details.

The **Email Agent's Transcript Agent** also uses the internal API to search/create workspaces and create items from meeting transcript action items. See [Email Agent — Transcript Agent](../integrations/email-agent.md#transcript-to-actionable-items-agent).

---

## Data Quality & Status Normalization

> Added 2026-03-05 after Token Burn Sprint Phase 2 cleanup. Full report: `notes/Improvements/teamhub-cleanup-report.md`.

### Status Values (User-Facing Workspaces)

A data cleanup sprint normalized inconsistent status values across all user-facing workspaces. The canonical status values are:

| Status | Replaces |
|--------|----------|
| `Not Started` | `open` |
| `Working on` | `in-progress`, `assigned` |
| `Complete` | `done` |
| `dismissed` | (unchanged) |
| `Manager Review` | (unchanged) |
| `Waiting on Client` | (unchanged) |

The OPAI Workers workspace retains its own status set (see [Custom Statuses](#custom-statuses) above) because agents depend on machine-readable values like `awaiting-human` and `in-progress`.

### Workspace Descriptions

All 21 of 22 workspaces now have populated descriptions (up from 4.5% coverage). This improves agent context when the Engine queries workspace summaries and when the AI chat assistant provides workspace overviews.

---

## Cross-References

- [Auth & Network](../core/auth-network.md) — JWT validation, Caddy proxy
- [Discord Bridge](../integrations/discord-bridge.md) — Discord bot uses internal endpoints
- [Email Agent](../integrations/email-agent.md) — Transcript agent uses workspace search/create + item creation
- [Portal](../core/portal.md) — Navigation includes Team Hub link
- [Services & systemd](../core/services-systemd.md) — Service unit management
- [Shared Navbar](../core/navbar.md) — Injected navigation bar
- [OPAI Files](../core/opai-files.md) — TeamTask button creates tasks with smart descriptions + file attachments
- [Task Control Panel](task-control-panel.md) — Internal task system; registry work tasks migrate to Team Hub via `registry:` tags
- [Feedback System](../infra/feedback-system.md) — Collects Team Hub improvement suggestions
- [Fleet Coordinator & Action Items](../infra/fleet-action-items.md) — Uses Workers workspace for dispatch tracking + HITL
- [NFS Dispatcher](../infra/nfs-dispatcher.md) — Syncs HITL items to admin directory for GravityClaw
- [Heartbeat](../infra/heartbeat.md) — Proactive intelligence creates "idea" items in Workers workspace
- [n8n-Forge Pipeline](n8n-forge.md) — Uses TeamHubClient for forge pipeline task tracking + HITL
