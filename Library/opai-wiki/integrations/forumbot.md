# OPAI Forum Bot
> Last updated: 2026-02-20 | Source: `tools/opai-forumbot/`

AI-powered content generation, scheduling, and moderation pipeline for the OPAI Forum. Generates professional forum posts (dev notes, polls, feature announcements) from admin prompts or automated schedules, queues them as drafts for review, and publishes approved content directly to the forum.

## Overview

| Property | Value |
|----------|-------|
| **Port** | `8095` |
| **Framework** | FastAPI + Uvicorn |
| **Database** | OPAI Supabase (`idorgloobxkmlnwnxbej`) — `forumbot_drafts`, `forumbot_schedules`, `forumbot_history` |
| **Auth** | Admin-only — Supabase JWT via `shared/auth.py` (`require_admin` on all endpoints) |
| **AI Engine** | Claude CLI (`claude -p --output-format json`) as subprocess |
| **Frontend** | Admin SPA (vanilla JS, 5-tab interface) |
| **Service** | `opai-forumbot` (systemd user unit) |
| **Caddy route** | `/forumbot/*` → `localhost:8095` |
| **Migration** | `config/supabase-migrations/016_forumbot.sql` |
| **Version** | 1.0.0 |

## Architecture

### Content Pipeline

```
Admin prompt (or schedule trigger)
        │
        ▼
   generator.py
   ├── Builds system prompt (security rules + post type guidelines)
   ├── Gathers context (git log --oneline -20, filtered for secrets)
   ├── Spawns: claude -p --output-format json
   ├── Strips CLAUDECODE env var (prevent nested session error)
   └── Parses JSON array → [{title, content, tags, poll?}]
        │
        ▼
   forumbot_drafts table (status: 'draft')
        │
        ├── Admin reviews in UI → edit/approve/discard
        │                           │
        │                     ┌─────┴─────┐
        │                     ▼           ▼
        │              'published'   'discarded'
        │                  │
        │                  ▼
        │           forum_posts + forum_polls (via Supabase REST)
        │           forumbot_history (action: 'published')
        │
        └── Auto-publish (if schedule.auto_publish = true)
                  │
                  ▼
            Skip approval → publish immediately
```

### Scheduler Loop

```
scheduler.py (asyncio background task, 60s tick)
        │
        ├── Fetch enabled schedules from forumbot_schedules
        ├── For each: check croniter if due (compare last_run_at vs cron prev)
        ├── Check conditions (AND logic — all must pass):
        │   ├── git_commits: min N commits in last M hours
        │   ├── weekday: only on specific days (0=Mon)
        │   └── service_restart: any service uptime < threshold
        ├── Generate posts via generator.py
        ├── Insert drafts (auto-publish if enabled)
        └── Update last_run_at + last_result
```

### Security Layer

The generator enforces strict content security:
- **Never reveals**: file paths, port numbers, IP addresses, API keys, database schemas
- **Never mentions**: internal tool names (`opai-monitor`, `opai-chat`, etc.)
- **Uses public names**: "System Monitor", "AI Chat", "Dev IDE", "Agent Studio"
- **Git context filtered**: Commits matching `password|secret|key|token|credential|.env|migration|sql|schema` are excluded

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-forumbot/app.py` | FastAPI entrypoint, scheduler lifespan startup |
| `tools/opai-forumbot/config.py` | Port, Supabase, Claude CLI, paths |
| `tools/opai-forumbot/routes_api.py` | 14 API endpoints (all admin-only) |
| `tools/opai-forumbot/generator.py` | AI content generation via Claude CLI subprocess |
| `tools/opai-forumbot/scheduler.py` | Background cron loop with condition checks |
| `tools/opai-forumbot/static/index.html` | Admin SPA shell |
| `tools/opai-forumbot/static/js/app.js` | Frontend logic (auth, tabs, CRUD, markdown preview) |
| `tools/opai-forumbot/static/css/style.css` | Dark theme matching OPAI portal |
| `tools/opai-forumbot/.env` | Supabase credentials + `FORUM_BOT_AUTHOR_ID` |
| `config/service-templates/opai-forumbot.service` | systemd unit (includes nvm PATH for Claude CLI) |
| `config/supabase-migrations/016_forumbot.sql` | Database migration |

## Database Schema

### `forumbot_drafts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | auto |
| `status` | TEXT | `draft` / `approved` / `published` / `discarded` |
| `post_type` | TEXT | `dev-note` / `poll` / `feature` / `announcement` / `general` |
| `title` | TEXT | Post title |
| `content` | TEXT | Markdown body |
| `content_format` | TEXT | Default `markdown` |
| `tags` | TEXT[] | Tag array |
| `category_id` | UUID FK | → `forum_categories` |
| `poll_data` | JSONB | `{question, options[], allow_multiple, closes_at}` |
| `prompt` | TEXT | Admin prompt that generated this |
| `batch_id` | TEXT | Groups drafts from same generation request |
| `schedule_id` | UUID FK | → `forumbot_schedules` (if auto-generated) |
| `published_post_id` | UUID FK | → `forum_posts` (after publish) |
| `published_at` | TIMESTAMPTZ | When published |
| `published_by` | UUID | Who approved |
| `created_at` / `updated_at` | TIMESTAMPTZ | Auto-managed |

### `forumbot_schedules`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | auto |
| `name` | TEXT | Display name |
| `enabled` | BOOLEAN | Toggle on/off |
| `cron_expr` | TEXT | e.g., `0 9 * * 1-5` (weekdays at 9am) |
| `post_type` | TEXT | Target post type |
| `prompt_template` | TEXT | Prompt for generation |
| `category_id` | UUID FK | Target forum category |
| `tags` | TEXT[] | Auto-applied tags |
| `auto_publish` | BOOLEAN | Skip approval queue |
| `conditions` | JSONB | `[{type, params}]` — all must pass (AND) |
| `max_drafts` | INT | 1-5 per run |
| `last_run_at` | TIMESTAMPTZ | Last execution |
| `last_result` | JSONB | `{success, drafts_created, error?}` |

### `forumbot_history`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | auto |
| `draft_id` | UUID FK | → `forumbot_drafts` |
| `post_id` | UUID FK | → `forum_posts` |
| `action` | TEXT | `generated` / `approved` / `published` / `discarded` / `schedule_triggered` |
| `actor` | TEXT | `admin:<user_id>` or `scheduler:<schedule_id>` |
| `details` | JSONB | Context metadata |

All tables have RLS enabled with service-role-only access policies.

## API Endpoints

All endpoints require admin authentication (`require_admin`).

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/generate` | AI generates 1-5 drafts from prompt + post_type |
| `GET` | `/api/drafts` | List drafts (filter by status, paginated) |
| `GET` | `/api/drafts/{id}` | Get single draft with category |
| `PUT` | `/api/drafts/{id}` | Edit draft content/title/tags |
| `POST` | `/api/drafts/{id}/approve` | Publish to forum (creates forum_post + optional poll) |
| `DELETE` | `/api/drafts/{id}` | Discard draft (soft delete) |
| `GET` | `/api/schedules` | List all schedules |
| `POST` | `/api/schedules` | Create schedule (validates cron) |
| `PUT` | `/api/schedules/{id}` | Update schedule |
| `DELETE` | `/api/schedules/{id}` | Delete schedule |
| `POST` | `/api/schedules/{id}/run` | Manual trigger |
| `GET` | `/api/history` | Paginated activity log |
| `GET` | `/api/stats` | Dashboard counts (pending, published today/total, active schedules) |
| `GET` | `/api/categories` | Forum categories for dropdowns |
| `GET` | `/api/scheduler/settings` | Runtime scheduler state `{tick_seconds, paused}` |
| `PUT` | `/api/scheduler/settings` | Update tick interval / pause toggle (body: `{tick_seconds?, paused?}`) |

## Admin UI

5-tab SPA at `/forumbot/`:

| Tab | Features |
|-----|----------|
| **Dashboard** | Stat cards (pending, published today, total, active schedules) + recent activity feed |
| **Generate** | Post type dropdown, count slider (1-5), prompt textarea, category selector, tags input, "Generate" button with loading state |
| **Drafts** | Filterable list with status badges, click-to-open modal with markdown preview, inline edit, approve/discard actions |
| **Schedules** | CRUD with cron expression input, condition builder (git_commits, weekday, service_restart), auto-publish toggle, "Run Now" button |
| **History** | Paginated activity log table |

Auth: Same pattern as all OPAI tools — Supabase session from `/auth/config`, Bearer token on all API calls. Non-admin users are redirected to portal.

## Post Type Templates

| Type | Tone | Length | Special |
|------|------|--------|---------|
| `dev-note` | Professional, approachable | 150-400 words | Headers, bullets, code snippets |
| `poll` | Brief context | 2-3 sentences + poll | Outputs `poll` JSON with question/options |
| `feature` | Enthusiastic, not hype-y | 200-500 words | Intro, what's new, how to use, what's next |
| `announcement` | Clear, direct | 100-300 words | Action items |
| `general` | Conversational, engaging | 100-400 words | Markdown as appropriate |

## Condition Types

Used in schedules to gate generation:

| Condition | Parameters | Behavior |
|-----------|-----------|----------|
| `git_commits` | `min_commits`, `hours` | Checks `git log --since` for minimum activity |
| `weekday` | `days` (0=Mon, 6=Sun) | Only triggers on specified weekdays |
| `service_restart` | `threshold_seconds` | Triggers if any service uptime < threshold |

All conditions use AND logic — every condition must pass for the schedule to execute.

## Configuration

### Environment Variables (`.env`)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase API URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_JWT_SECRET` | JWT validation secret |
| `SUPABASE_SERVICE_KEY` | Service role key (bypasses RLS) |
| `FORUM_BOT_AUTHOR_ID` | Supabase user ID for published posts (required for publishing) |

### systemd Service

The service template includes nvm PATH so `claude` CLI is available for content generation:

```
Environment=PATH=/home/dallas/.nvm/versions/node/v20.19.5/bin:/usr/local/sbin:/usr/local/bin:...
```

## How to Use

### Manual generation
1. Open `/forumbot/` in the portal
2. Go to **Generate** tab
3. Select post type, count, category
4. Write a prompt describing what you want
5. Click **Generate** — drafts appear below
6. Review in **Drafts** tab → edit, approve (publish), or discard

### Automated scheduling
1. Go to **Schedules** tab → **+ New Schedule**
2. Set cron expression (e.g., `0 9 * * 1-5` for weekdays at 9am)
3. Choose post type, write prompt template
4. Optionally add conditions (e.g., only if 3+ commits in last 24h)
5. Toggle auto-publish or leave for manual approval
6. **Run Now** to test immediately

### CLI testing
```bash
# Health check
curl http://127.0.0.1:8095/health

# Generate (requires admin token)
curl -X POST http://127.0.0.1:8095/api/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Write about recent updates","post_type":"dev-note","count":1}'

# List drafts
curl http://127.0.0.1:8095/api/drafts \
  -H "Authorization: Bearer $TOKEN"

# Approve (publish to forum)
curl -X POST http://127.0.0.1:8095/api/drafts/{id}/approve \
  -H "Authorization: Bearer $TOKEN"
```

## Dependencies

- **Requires**: [Forum](forum.md) (publishes to `forum_posts`, `forum_polls`, `forum_poll_options`)
- **Uses**: `shared/auth.py` for JWT validation, Claude CLI for AI generation
- **Python dep**: `croniter` (cron expression parsing)
- **Monitored by**: [Monitor](monitor.md) (health endpoint at `/health`), [Orchestrator](orchestrator.md)
- **Portal tile**: Shows in admin dashboard with health dot
- **Caddy**: `/forumbot/*` → `localhost:8095`

## Important Notes

- `FORUM_BOT_AUTHOR_ID` must be set in `.env` before publishing works — this is the Supabase user ID that posts appear under
- The Claude CLI subprocess strips the `CLAUDECODE` env var to avoid nested session errors (same pattern as discord-bridge)
- The scheduler runs as an asyncio background task started in the FastAPI lifespan — it ticks every 60 seconds
- RLS is service-role-only — no public/anon access to forumbot tables
- Git context for generation uses commit messages only (no diffs, no paths) and filters out sensitive keywords
