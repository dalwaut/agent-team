# OPAI Forum
> Last updated: 2026-02-15 | Source: `tools/opai-forum/`

## Overview

Reddit-style dev community forum for sharing projects, asking questions, and discussing ideas. Features longform posts with Markdown rendering, threaded comments, upvotes/downvotes, emoji reactions, polls with live results, image attachments, code snippets with syntax highlighting, and category-based topic groups. Accessible to all authenticated users as a portal tile.

## Architecture

```
Browser (vanilla JS SPA, hash routing)
    ↓ REST API (HTTPS)
Caddy (:443 / :80)
    /forum/*     → Forum backend (:8087) [handle_path strips prefix]
    ↓
FastAPI (Python) on port 8087
    ├── REST /api/* → routes_api.py (all auth-gated)
    │       ├── Supabase PostgREST → forum_* tables (service role key)
    │       └── Local uploads → data/uploads/
    └── Static files → static/ (HTML, JS, CSS)

Database (Supabase):
    forum_categories ─┐
    forum_posts ──────┤── Core content
    forum_comments ───┘
    forum_votes ──────┐
    forum_reactions ──┤── Engagement
    forum_polls ──────┤
    forum_poll_options ┤
    forum_poll_votes ──┘
```

## Features

### Posts
- Title, rich content (Markdown or plain text), category assignment
- Optional image attachment (drag-and-drop upload, max 5MB)
- Optional code snippet with language selector and PrismJS syntax highlighting
- Optional poll (single or multiple choice, optional close date)
- Tags for discoverability
- Pin and lock controls (admin only)
- Soft-delete (author or admin)

### Feed
- Reddit-style post cards: vote column (left) + content column (right)
- Sort modes: New, Top (by votes), Hot (by comments)
- Category filtering via sidebar or direct links
- Pagination (20 posts per page)
- Inline reaction previews and comment/view counts

### Comments
- Threaded replies (up to 3 levels deep)
- Markdown rendering
- Individual vote scores
- Inline emoji reactions
- Reply, delete (own), and react actions

### Voting
- Upvote/downvote toggle (1 / -1) on posts and comments
- Denormalized `vote_score` on posts and comments for fast sorting
- Orange upvote, blue downvote colors (Reddit-style)

### Reactions
- 16 emoji options: 👍 👎 🔥 ❤️ 😂 🤔 🎉 🚀 👀 💯 🐛 ✅ 💡 ⚡ 🙏 😍
- Toggle on/off per user per emoji
- Compact emoji picker popup

### Polls
- Attached to posts (1:1 relationship)
- Single or multiple choice
- Optional close date
- Horizontal bar chart results (pure CSS)
- Vote toggle (click again to remove)

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-forum/app.py` | FastAPI entrypoint — health (localhost-only), static/upload mounts, SPA index route |
| `tools/opai-forum/config.py` | Port 8087, Supabase env vars, upload limits (5MB, image types), pagination defaults |
| `tools/opai-forum/routes_api.py` | REST API — CRUD for posts, comments, votes, reactions, polls, uploads, admin actions |
| `tools/opai-forum/.env` | Supabase credentials (URL, anon key, service key, JWT secret) |
| `tools/opai-forum/requirements.txt` | Python dependencies |
| `tools/opai-forum/static/index.html` | Forum SPA — topnav, main content area, compact sidebar |
| `tools/opai-forum/static/css/forum.css` | Reddit-style dark theme — vote columns, card layout, compact sidebar |
| `tools/opai-forum/static/js/forum.js` | SPA client — hash routing, sidebar population, post cards, detail view, forms |
| `tools/opai-forum/data/uploads/` | Uploaded images (served via static mount at `/forum/uploads/`) |
| `config/supabase-migrations/009_forum_tables.sql` | Database schema — 8 tables, RLS policies, indexes, seed categories |
| `config/service-templates/opai-forum.service` | systemd unit file template |

## Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `SUPABASE_URL` | Supabase project URL | (required) |
| `SUPABASE_ANON_KEY` | Supabase anonymous/publishable key | (required) |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (bypasses RLS) | (required) |
| `SUPABASE_JWT_SECRET` | JWT validation secret | (required) |

## API Endpoints

All endpoints require auth (`Authorization: Bearer <JWT>`).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/categories` | List all categories (sorted by sort_order) |
| POST | `/api/categories` | Create category (admin) |
| PUT | `/api/categories/{id}` | Update category (admin) |
| GET | `/api/posts` | List posts (query: `category`, `sort`, `page`, `limit`, `author`) |
| GET | `/api/posts/{id}` | Get post detail (with reactions, user vote, poll) |
| POST | `/api/posts` | Create post (with optional poll) |
| PUT | `/api/posts/{id}` | Edit own post |
| DELETE | `/api/posts/{id}` | Soft-delete own post |
| GET | `/api/posts/{id}/comments` | Get threaded comment tree |
| POST | `/api/posts/{id}/comments` | Add comment (with optional parent_id for replies) |
| PUT | `/api/comments/{id}` | Edit own comment |
| DELETE | `/api/comments/{id}` | Soft-delete own comment |
| POST | `/api/posts/{id}/vote` | Vote on post (`{value: 1}` or `{value: -1}`, toggles) |
| POST | `/api/comments/{id}/vote` | Vote on comment |
| POST | `/api/posts/{id}/react` | Toggle emoji reaction on post (`{emoji: "🔥"}`) |
| POST | `/api/comments/{id}/react` | Toggle emoji reaction on comment |
| GET | `/api/posts/{id}/poll` | Get poll results |
| POST | `/api/posts/{id}/poll/vote` | Cast/remove poll vote (`{option_id: "..."}`) |
| POST | `/api/upload` | Upload image (multipart, max 5MB, returns URL) |
| PUT | `/api/posts/{id}/pin` | Pin/unpin post (admin) |
| PUT | `/api/posts/{id}/lock` | Lock/unlock post (admin) |
| DELETE | `/api/posts/{id}/admin` | Hard-delete post (admin) |

## Database Schema

8 tables in the `public` schema, all with RLS enabled:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `forum_categories` | Topic groups | name, slug, icon, sort_order |
| `forum_posts` | Main posts | author_id, category_id, title, content, vote_score, comment_count, tags[] |
| `forum_comments` | Threaded comments | post_id, author_id, parent_id, vote_score |
| `forum_votes` | Up/downvotes | user_id, post_id OR comment_id, value (1/-1) |
| `forum_reactions` | Emoji reactions | user_id, post_id OR comment_id, emoji |
| `forum_polls` | Polls on posts | post_id (unique), question, allow_multiple, closes_at |
| `forum_poll_options` | Poll choices | poll_id, label, vote_count |
| `forum_poll_votes` | Individual poll votes | poll_id, option_id, user_id |

### RLS Policy Summary
- **Read**: All tables public read (posts/comments filtered by `deleted_at IS NULL`)
- **Write**: Authenticated users can create posts, comments, votes, reactions, poll votes
- **Update/Delete**: Users can modify/remove their own content
- **Admin**: Full access to all operations (checked via `raw_app_meta_data->>'role' = 'admin'`)

### Seed Categories
| Name | Slug | Icon |
|------|------|------|
| General | general | 💬 |
| Dev | dev | 💻 |
| Showcase | showcase | 🚀 |
| Feedback | feedback | 📝 |
| Off-Topic | off-topic | 🎲 |

## Frontend (SPA)

### Hash Routes
| Route | View |
|-------|------|
| `#/` | Feed — all posts, sort bar, pagination |
| `#/category/{slug}` | Category-filtered feed |
| `#/post/{id}` | Post detail — full content, comments, poll, reactions |
| `#/new` | Create post form |
| `#/user/{id}` | Posts by specific user |

### Layout
- **Topnav**: Back to portal, logo, "New Post" button, user chip
- **Main content** (left, flex-grow): Feed, post detail, or create form
- **Sidebar** (right, 220px): Category list with active highlight, about section
- Sidebar hides on mobile (<900px)

### CDN Dependencies
- `marked.js` v12.0.2 — Markdown parsing (UMD build, not ESM)
- `DOMPurify` v3 — HTML sanitization (XSS protection)
- `PrismJS` v1 + autoloader — Syntax highlighting for code snippets
- `Supabase JS` v2 — Client-side auth (session, token refresh)

## How to Use

```bash
# Start the service
systemctl --user start opai-forum

# Check health
curl http://127.0.0.1:8087/health

# Access via browser
# https://<host>/forum/

# View logs
journalctl --user -u opai-forum -f
```

### Portal Access
Forum tile appears on both user and admin dashboards with 📢 icon and amber left border. Health dot monitored by opai-monitor.

## Dependencies

- **Python**: FastAPI, uvicorn, httpx, python-dotenv, python-multipart, aiofiles
- **Database**: Supabase PostgREST (8 `forum_*` tables, migration `009_forum_tables.sql`)
- **Frontend CDN**: marked.js v12, DOMPurify v3, PrismJS v1, Supabase JS v2, Inter font
- **Shared**: `tools/shared/auth.py` (Supabase JWT validation, `get_current_user`, `require_admin`)
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-forum.service`)
- **Auth via**: [Auth & Network](auth-network.md)
- **Portal tile**: [Portal](portal.md)
- **Health monitored by**: [Monitor](monitor.md)
