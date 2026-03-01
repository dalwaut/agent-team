# OPAI Messenger
> Last updated: 2026-02-14 | Source: `tools/opai-messenger/`

## Overview

Internal team messaging service for person-to-person and group communication within the OPAI ecosystem. Supports 1:1 DMs, group channels, emoji reactions, file sharing, full-text message search, typing indicators, and online presence. Built with FastAPI + vanilla HTML/CSS/JS on the backend, Supabase Realtime for live message delivery, and Supabase Storage for file uploads. Accessible to all authenticated users.

Includes a **floating widget** (`widget.js`) injected into all other OPAI apps via a single `<script>` tag. The widget starts hidden and pops in when a new message arrives; users can dismiss it until the next message.

## Architecture

```
Browser (vanilla JS + Supabase Realtime)
    ↓ HTTP / WebSocket
Caddy (:443 HTTPS / :80 HTTP)
    /messenger/*     → Messenger backend (:8083) [handle_path strips prefix]
    /ws/messenger    → Presence WebSocket (:8083) [direct proxy]
    ↓
FastAPI (Python) on port 8083
    ├── REST /api/* → routes_api.py (channels, messages, users, search, upload)
    ├── WebSocket /ws/messenger → routes_ws.py (presence + typing indicators)
    └── Static files → static/ (HTML, JS, CSS)

Message Delivery:
    Sender → POST /api/channels/{id}/messages → Supabase INSERT
                                                  ↓
                                          Supabase Realtime
                                                  ↓
                                    All clients subscribed to dm_messages
```

## Key Files

| File | Purpose |
|------|---------|
| `app.py` | FastAPI entrypoint, health check, static mount |
| `config.py` | Port, Supabase config, file upload limits, storage bucket |
| `routes_api.py` | 14 REST endpoints: channels CRUD, messages CRUD, users, search, upload, reactions |
| `routes_ws.py` | WebSocket endpoint for presence and typing indicators |
| `presence.py` | In-memory tracker for online users and typing state |
| `.env` | Supabase URL, anon key, JWT secret, service key |
| `requirements.txt` | Python dependencies (fastapi, uvicorn, httpx, python-jose) |
| `static/index.html` | Full messenger page (3-panel layout) |
| `static/style.css` | Dark purple theme matching portal/chat |
| `static/js/app.js` | Auth init, Supabase Realtime subscriptions, state management |
| `static/js/channels.js` | Channel sidebar: list, create DM/group, unread badges |
| `static/js/chat.js` | Message rendering, sending, editing, deleting, replies |
| `static/js/presence.js` | WebSocket client for online dots + typing indicators |
| `static/js/reactions.js` | Emoji picker + reaction pills |
| `static/js/upload.js` | File/image upload with drag-and-drop |
| `static/js/search.js` | Full-text message search across channels |
| `static/js/widget.js` | Self-contained floating bubble for embedding in other apps |

## Database Schema

Four tables in the `public` schema (migration: `config/supabase-migrations/005_messenger_tables.sql`):

| Table | Purpose |
|-------|---------|
| `dm_channels` | Conversation containers. `type`: 'dm' or 'group'. `name` for groups. |
| `dm_channel_members` | Membership + `last_read_at` for unread counts. Unique on (channel_id, user_id). |
| `dm_messages` | Messages with `content`, `reply_to`, `file_url/file_name/file_type`, `edited_at`, `deleted_at` (soft-delete). Full-text search index on content. |
| `dm_reactions` | Emoji reactions. Unique on (message_id, user_id, emoji). |

**RLS**: Users can only see channels they're members of. Users can only send to/edit/delete their own messages. Reactions are user-scoped.

**Realtime**: `dm_messages`, `dm_reactions`, and `dm_channel_members` are published to `supabase_realtime`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPABASE_URL` | — | Supabase project URL |
| `SUPABASE_ANON_KEY` | — | Supabase anon/public key |
| `SUPABASE_JWT_SECRET` | — | JWT secret for token validation |
| `SUPABASE_SERVICE_KEY` | — | Service role key (for server-side operations) |
| `OPAI_MESSENGER_HOST` | `127.0.0.1` | Bind address |
| `OPAI_MESSENGER_PORT` | `8083` | Listen port |

## REST API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/auth/config` | No | Supabase URL + anon key for client-side init |
| GET | `/api/users` | Yes | List active users (for new conversation creation) |
| GET | `/api/channels` | Yes | User's channels with unread counts and last message |
| POST | `/api/channels` | Yes | Create DM or group channel |
| PATCH | `/api/channels/{id}` | Yes | Update group name, add/remove members |
| GET | `/api/channels/{id}/messages` | Yes | Paginated message history (cursor-based via `before` param) |
| POST | `/api/channels/{id}/messages` | Yes | Send message (with optional `reply_to`) |
| PATCH | `/api/channels/{id}/read` | Yes | Mark channel as read (updates `last_read_at`) |
| PATCH | `/api/messages/{id}` | Yes | Edit own message |
| DELETE | `/api/messages/{id}` | Yes | Soft-delete own message |
| POST | `/api/messages/{id}/reactions` | Yes | Add emoji reaction |
| DELETE | `/api/messages/{id}/reactions/{emoji}` | Yes | Remove own reaction |
| GET | `/api/messages/search?q=` | Yes | Full-text search across user's channels |
| POST | `/api/upload?channel_id=` | Yes | Upload file to Supabase Storage (`messenger-files` bucket) |

## WebSocket Protocol (Presence)

Endpoint: `/ws/messenger`

```
1. Client: {"type": "auth", "token": "JWT"}
2. Server: {"type": "connected", "user": {...}, "online_users": [...]}
3. Client: {"type": "typing", "channel_id": "..."}  (throttled 2s client-side)
4. Server: {"type": "user_typing", "channel_id": "...", "user_id": "...", "display_name": "..."}
5. Server: {"type": "presence_update", "online_users": [...]}  (on connect/disconnect)
6. Client: {"type": "ping"} / Server: {"type": "pong"}
```

Typing indicators auto-expire after 3 seconds server-side. The client throttles typing events to 1 per 2 seconds.

## Floating Widget

`widget.js` is self-contained — it injects its own CSS, creates DOM elements, loads Supabase JS if needed, and handles auth. No dependencies on the host page.

**Behavior:**
- Starts **hidden** (no bubble visible)
- When a new message arrives, bubble **pops in** with animation + unread badge
- Left-click opens the chat panel (recent channels, inline messaging)
- Right-click or panel X button **dismisses** — hides until next incoming message
- Dismissed state persists in `sessionStorage` (survives refresh, clears on tab close)
- Skips loading on `/messenger/` itself to avoid duplication

**Integration** — one line in each app's HTML:
```html
<script src="/messenger/static/js/widget.js" defer></script>
```

Currently embedded in: **Portal**, **Chat**, **Monitor**, **Tasks**, **Terminal**, **Claude Code**

## systemd Service

| Item | Value |
|------|-------|
| Service name | `opai-messenger` |
| Service file | `config/service-templates/opai-messenger.service` |
| Port | 8083 (bind 127.0.0.1) |
| ExecStart | `venv/bin/uvicorn app:app --host 127.0.0.1 --port 8083` |

```bash
systemctl --user status opai-messenger
systemctl --user restart opai-messenger
journalctl --user -u opai-messenger -f
```

Registered in `scripts/opai-control.sh` and `config/network.json`.

## Dependencies

- **[Auth & Network](auth-network.md)** — Supabase JWT validation via `tools/shared/auth.py`, Caddy reverse proxy
- **[Portal](portal.md)** — Dashboard card links to `/messenger/`, widget embedded
- **[Monitor](monitor.md)** — Health check registered in `_HEALTH_SERVICES` (port 8083)
- **[Services & systemd](services-systemd.md)** — Managed by `opai-control.sh`
- **Supabase Storage** — `messenger-files` bucket for file uploads
- **Supabase Realtime** — Live message delivery via postgres_changes subscriptions
