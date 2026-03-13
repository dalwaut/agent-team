# OPAI Tools & API System — Context Document
> For AI assistants and professionals working on OPAI server tools and APIs.
> Last updated: 2026-02-20

---

## Overview

OPAI runs **25 systemd user services** on a Linux VPS (Hostinger KVM4, `72.60.115.74`). Each service is a self-contained web application (Python FastAPI or Node.js) with its own static frontend, served at a dedicated path under the unified domain `https://opai.boutabyte.com` via Caddy reverse proxy. All tools share Supabase authentication.

**Infra**:
- VPS: `72.60.115.74` (Tailscale: `bb-vps`, `100.106.200.68`)
- Caddy: reverse proxy on OPAI Server, terminates TLS
- Public entry: `https://opai.boutabyte.com`
- Tailscale admin backdoor: `https://opai-server/`
- NAS: NFS-mounted per-user sandboxes at `/workspace/users/<id>/`

---

## Unified Domain Routing

| Path | Handler | Source |
|------|---------|--------|
| `/about`, `/welcome` | Static (BB VPS) | `tools/opai-billing/public-site/` |
| `/` → redirect | Portal → `/dashboard` | `tools/opai-portal/` |
| `/dashboard` | Auth dashboard (21 admin tiles) | `tools/opai-portal/static/` |
| `/chat/` | AI chat | `tools/opai-chat/` |
| `/monitor/` | System monitor | `tools/opai-monitor/` |
| `/tasks/` | Task Control Panel | `tools/opai-tasks/` |
| `/team-hub/` | Team Hub (ClickUp-style) | `tools/opai-teamhub/` |
| `/agents/` | Agent Studio | `tools/opai-agents/` |
| `/email-agent/` | Email Agent | `tools/email-agent/` |
| `/files/` | File Manager | `tools/opai-files/` |
| `/billing/` | Stripe Billing | `tools/opai-billing/` |
| `/wordpress/` | WP Manager | `tools/opai-wordpress/` |
| `/marketplace/` | Marketplace | `tools/opai-marketplace/` |
| `/docs/` | Docs Portal | `tools/opai-docs/` |
| `/forum/` | Dev Forum | `tools/opai-forum/` |
| `/messenger/` | Internal Messenger | `tools/opai-messenger/` |
| `/ide/` | OP IDE (Theia) | Per-project workspaces |
| `/discord-bridge/` | Discord Bot UI | `tools/discord-bridge/` |

---

## Service Map

| Service Name | Port | Backend | Purpose |
|-------------|------|---------|---------|
| `opai-portal` | 8090 | FastAPI (Python) | Auth, dashboard, onboarding, Pages Manager |
| `opai-chat` | 8091 | FastAPI + WebSocket | AI chat (Claude + Gemini), Mozart Mode |
| `opai-monitor` | 8092 | FastAPI (Python) | System metrics, health, Claude usage, logs |
| `opai-email-agent` | 8093 | Node.js | Autonomous inbox manager |
| `opai-tasks` | 8094 | FastAPI (Python) | Task Control Panel: HITL, feedback, audit |
| `opai-teamhub` | 8095 | FastAPI (Python) | ClickUp-style project/task management |
| `opai-agents` | 8096 | FastAPI (Python) | Agent Studio: create/edit/run agents + squads |
| `opai-billing` | 8097 | FastAPI (Python) | Stripe billing, subscription management |
| `opai-files` | 8098 | FastAPI (Python) | Sandboxed file manager, wikilinks, knowledge graph |
| `opai-docs` | 8099 | FastAPI (Python) | Auto-updating wiki-sourced docs portal |
| `opai-wordpress` | 8100 | FastAPI (Python) | Multi-site WordPress management |
| `opai-orchestrator` | — (3737 reserved) | Node.js | Central daemon (scheduling, routing, HITL) |
| `opai-marketplace` | — | FastAPI (Python) | BoutaByte catalog, tier-based access |
| `opai-forum` | — | FastAPI (Python) | Reddit-style dev forum |
| `opai-messenger` | — | FastAPI (Python) | Internal DMs + group messaging |
| `opai-discord-bridge` | — | Node.js | Discord bot ↔ Claude CLI bridge |
| `opai-email-checker` | — | Node.js | IMAP fetch + classification (cron-driven) |

**Service control**:
```bash
./scripts/opai-control.sh {start|stop|restart|status|logs}
systemctl --user restart opai-<name>
journalctl --user -u opai-<name> -f
```

---

## Authentication System

All OPAI APIs are JWT-authenticated via Supabase.

**Auth flow**:
1. Client authenticates via Supabase JS (`supabase.auth.signInWithPassword`)
2. Supabase issues ES256 JWT access token (15 min expiry)
3. Client sends `Authorization: Bearer <token>` on every request
4. Backend (FastAPI) verifies JWT signature + extracts `sub` (user ID) + `role`
5. RLS policies in PostgreSQL enforce row-level access

**Key auth patterns**:
```python
# FastAPI dependency (all protected routes)
async def get_current_user(token: str = Depends(oauth2_scheme)):
    payload = verify_jwt(token)
    return payload

# Role check
def require_admin(user = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403)
```

**Supabase RLS**: `get_my_role()` SECURITY DEFINER function used in all admin policies — prevents infinite recursion that occurs with self-referencing `FROM profiles` subqueries inside policies ON the `profiles` table.

**Roles**:
- `admin` — full access to all tools, Command tab in mobile, all API endpoints
- `user` — access to allowed apps only (configured per-user in `profiles.apps`)

---

## Core Tool Details

### Portal (`tools/opai-portal/`, port 8090)

Entry point for all web services.

**Routes**:
| Route | Purpose |
|-------|---------|
| `/` | Public landing page (`landing.html`) |
| `/dashboard` | Authenticated admin dashboard (21 tiles) |
| `/auth/login` | Login form (Supabase JS) |
| `/auth/verify` | Invite token verification (PKCE/hash/OTP) |
| `/auth/callback` | OAuth redirect handler |
| `/onboard/` | 5-step onboarding wizard |
| `/archive/` | Pages Manager (WordPress-style) |
| `/api/me/apps` | User's allowed apps |
| `/api/feedback` | Feedback submission |
| `/api/pages/*` | Pages registry + route management |
| `/health` | Service health check |

**Key files**: `tools/opai-portal/app.py` (FastAPI, ~400 LOC), `static/index.html` (dashboard), `static/js/auth-v3.js` (shared auth client used by all tools)

---

### Monitor (`tools/opai-monitor/`, port 8092)

System observability dashboard.

**API endpoints**:
| Endpoint | Purpose |
|----------|---------|
| `GET /monitor/api/health/summary` | Aggregated service health (healthy/degraded/down counts) |
| `GET /monitor/api/system/stats` | CPU %, Memory GB, Disk GB, Load avg |
| `GET /monitor/api/system/services` | List of managed services + status |
| `POST /monitor/api/system/services/{name}/{action}` | start/stop/restart a service |
| `GET /monitor/api/claude/plan-usage` | Anthropic plan quota |
| `GET /monitor/api/claude/usage` | Today's token usage |
| `GET /monitor/api/tasks/registry` | Task registry contents |
| `GET /monitor/api/logs` | Tail of orchestrator/system logs |
| `GET /monitor/api/reports` | List reports in `reports/latest/` |

---

### Task Control Panel (`tools/opai-tasks/`, port 8094)

HITL review, feedback management, agent execution, audit trail.

**Tabs**:
- **My Queue**: HITL briefings from `reports/HITL/` — approve/reject/defer/reassign
- **Feedback**: Browse user feedback items, trigger `feedback_fixer` agent on individual items
- **Audit**: Per-run token cost + step-by-step execution trace (session JSONL)

**API endpoints**:
| Endpoint | Purpose |
|----------|---------|
| `GET /tasks/api/hitl` | List HITL briefing files |
| `POST /tasks/api/hitl/{filename}/respond` | Approve/reject HITL item |
| `GET /tasks/api/feedback` | List feedback items |
| `POST /tasks/api/feedback/{id}/fix` | Trigger feedback_fixer on item |
| `GET /tasks/api/audit` | List audit records |
| `GET /tasks/api/audit/{run_id}` | Full step trace for a run |
| `GET /tasks/api/token-budget` | Current budget config |
| `POST /tasks/api/token-budget` | Update budget settings |

**Key file**: `tools/opai-tasks/services.py` — `run_agent_task()` + `_run_feedback_fix()` (resolve model/turns from `team.json`, build `claude -p` CLI call, write audit record)

---

### Team Hub (`tools/opai-teamhub/`, port 8095)

ClickUp-style project and task management. Primary task store for all OPAI work.

**Data hierarchy**: Workspaces → Folders → Lists → Items

**API endpoints**:
| Endpoint | Purpose |
|----------|---------|
| `GET /team-hub/api/workspaces` | All workspaces (spaces) |
| `GET /team-hub/api/workspaces/{id}/folders` | Folders + lists with task counts |
| `GET /team-hub/api/lists/{id}/items` | Items in a list (filterable by status) |
| `POST /team-hub/api/lists/{id}/items` | Create item |
| `GET /team-hub/api/items/{id}` | Item detail |
| `PATCH /team-hub/api/items/{id}` | Update item (status, priority, assignee) |
| `GET /team-hub/api/items/{id}/comments` | Item comments |
| `POST /team-hub/api/items/{id}/comments` | Add comment |
| `GET /team-hub/api/my/home` | Dashboard aggregation (top items, overdue, upcoming) |
| `GET /team-hub/api/my/notifications` | User notifications |
| `GET /team-hub/api/profiles` | Team member list |

**Views**: Board, List, Calendar. Features: markdown descriptions, @mention, item actions, Discord integration, ClickUp import.

---

### Agent Studio (`tools/opai-agents/`, port 8096)

Visual interface for agent management.

**API endpoints**:
| Endpoint | Purpose |
|----------|---------|
| `GET /agents/api/agents` | List all agents with tuning fields |
| `POST /agents/api/agents` | Create new agent |
| `PATCH /agents/api/agents/{name}` | Update agent (model, max_turns, prompt, etc.) |
| `GET /agents/api/squads` | List all squad definitions |
| `POST /agents/api/squads` | Create squad |
| `POST /agents/api/run/squad/{name}` | Run a squad |
| `GET /agents/api/runs` | List active + historical runs |
| `POST /agents/api/runs/{id}/cancel` | Cancel active run |
| `GET /agents/api/schedules` | Scheduled squad runs |
| `POST /agents/api/schedules` | Add schedule |

**Features**: Agent edit form (model picker, max turns, context toggle, prompt editor), interactive onboarding guide with inline agent creation, AI flow builder.

---

### OP WordPress (`tools/opai-wordpress/`, port 8100)

Multi-site WordPress management. ManageWP replacement.

**API endpoints**:
| Endpoint | Purpose |
|----------|---------|
| `GET /wordpress/api/sites` | List all managed WP sites |
| `POST /wordpress/api/sites` | Add new site |
| `POST /wordpress/api/sites/{id}/connect` | Test/establish connector |
| `POST /wordpress/api/sites/{id}/push-op` | Force-push OP connector update |
| `GET /wordpress/api/sites/{id}/plugins` | List plugins |
| `POST /wordpress/api/automation/schedule` | Schedule content posting |
| `POST /wordpress/api/avada/...` | Avada theme operations |

**Key features**:
- Multi-strategy connector deployment (`services/deployer.py`): tries SSH, SFTP, FTP, REST API, WP-CLI in order
- Per-site method pinning once a strategy succeeds
- Self-healing connection retry agent (`services/connection_agent.py`) with HITL reporting
- WooCommerce management
- Site-specific AI Agents UI
- Push OP: force-push connector updates to all sites with per-site failure banners + fix steps

---

### Email Agent (`tools/email-agent/`, port 8093)

Autonomous inbox manager for `agent@paradisewebfl.com`.

**Three operating modes**:
| Mode | Classify | Tag | Draft | Send |
|------|----------|-----|-------|------|
| `suggestion` | Yes | Yes | No | No |
| `internal` | Yes | Yes | Yes (queue) | No |
| `auto` | Yes | Yes | Yes | Yes (rate-limited) |

**Safety**: Strict sender whitelist. Only approved internal domains/addresses are interacted with.

**API** (`/email-agent/`): Inbox-style moderation UI — card view, tags, timeline, approval drawer.

---

### Billing (`tools/opai-billing/`, port 8097)

Stripe subscription management with dual-Supabase architecture.

**Two Supabase projects**:
- **OPAI Supabase** (`idorgloobxkmlnwnxbej`): User auth, profiles, sessions
- **BB2.0 Supabase** (`aggxspqzerfimqzkjgct`): Billing data (subscriptions, products, prices)

**Pricing**:
- Starter: $29/mo | Pro: $79/mo | Ultimate: $149/mo
- Storage: $1 = 1GB, minimum $5 to activate

**Stripe webhook**: `POST https://opai.boutabyte.com/billing/api/webhooks/stripe`

**Key endpoints**:
| Endpoint | Purpose |
|----------|---------|
| `GET /billing/api/products` | List products + prices |
| `POST /billing/api/checkout` | Create Stripe checkout session |
| `POST /billing/api/webhooks/stripe` | Handle Stripe lifecycle events |
| `GET /billing/api/subscription/{user_id}` | User subscription status |

**Public landing**: `tools/opai-billing/public-site/index.html` (hosted on BB VPS at `/var/www/opai-landing/`)

---

### Chat (`tools/opai-chat/`, port 8091)

AI chat with Claude + Gemini, voice-to-text, file uploads, Mozart Mode.

**REST API**:
| Endpoint | Purpose |
|----------|---------|
| `GET /chat/api/conversations` | List conversations |
| `POST /chat/api/conversations` | Create conversation |
| `DELETE /chat/api/conversations/{id}` | Delete conversation |
| `GET /chat/api/conversations/{id}/messages` | Message history |
| `GET /chat/api/models` | Available models |

**WebSocket**: `wss://opai.boutabyte.com/ws/chat`
```
→ { type: 'auth', token }
→ { type: 'chat', conversation_id, message, model, mozart_mode? }
← { type: 'content_delta', text }
← { type: 'stream_complete', message_id?, usage? }
← { type: 'error', message }
```

**Mozart Mode**: Musical AI personality (gold UI styling). Toggled per-conversation.
**File uploads**: Malicious content scanning before AI processing.
**AI lock**: Security mode — blocks all AI chat for a user when enabled.

---

## Shared Infrastructure

### Shared Auth Client (`tools/opai-portal/static/js/auth-v3.js`)
Injected by every OPAI web frontend. Handles:
- Session check + redirect to login
- Auto-refresh on 401
- Cross-page session sharing via localStorage

### Shared Navbar (`tools/opai-portal/static/js/navbar.js`)
Self-injecting navigation bar loaded by all tool pages:
- Back button
- Recent tools tracking
- Role-aware icon strip

### Supabase Realtime
Used for live updates. Pattern for broadcasting a system update (shows refresh banner to open clients):
```javascript
POST https://{ref}.supabase.co/realtime/v1/api/broadcast
Headers: { apikey: <anon_key> }
Body: {
  "messages": [{
    "topic": "realtime:system",
    "event": "broadcast",
    "payload": { "type": "system_update", "message": "..." }
  }]
}
```

### Feedback-to-Fix Loop
1. User submits feedback via `/api/feedback`
2. `feedback_processor` classifies it every 5 min
3. HIGH/MEDIUM items auto-create tasks every 15 min
4. `feedback_fixer` agent implements targeted fix
5. Service restarted
6. `system_update` broadcast via Supabase Realtime
7. Feedback item marked IMPLEMENTED
8. Change logged to `notes/Improvements/`

---

## Extensibility: Adding a New Tool

1. **Create service directory**: `tools/opai-<name>/`
2. **Backend**: FastAPI (`app.py`) or Node.js (`index.js`)
   - All protected routes: `Depends(get_current_user)`
   - Admin routes: `Depends(require_admin)`
   - Health endpoint: `GET /health` returns `{ status: "ok" }`
3. **Frontend**: Static files in `static/` or `public/`
   - Include `auth-v3.js` for auth
   - Include `navbar.js` for navigation
4. **systemd service**: `~/.config/systemd/user/opai-<name>.service`
5. **Caddy route**: Add to OPAI Server Caddyfile
6. **Portal tile**: Register in dashboard `index.html`
7. **Monitor registration**: Add to Monitor service list
8. **Wiki doc**: `Library/opai-wiki/<name>.md`

### FastAPI Service Template

```python
from fastapi import FastAPI, Depends, HTTPException
from fastapi.staticfiles import StaticFiles
import uvicorn, os

app = FastAPI()

async def get_current_user(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(401)
    token = authorization.replace("Bearer ", "")
    # verify JWT via supabase or local secret
    return verify_jwt(token)

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/api/resource")
async def get_resource(user=Depends(get_current_user)):
    return {"data": [...]}

app.mount("/", StaticFiles(directory="static", html=True))

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8100))
    uvicorn.run(app, host="127.0.0.1", port=port)
```

---

## Key Gotchas

- **JSDoc `*/` in comments**: Never put `*/` in a comment body (e.g., file paths like `/users/*/tasks/`) — it closes the JS comment block. Use `//` comments for glob paths.
- **Node `req.on('close')`**: Fires on body end, not TCP close. Use `res.on('close')` for disconnect detection.
- **Template literal backticks**: Nested backticks terminate outer template — use string concatenation.
- **pg_net on Supabase**: Use `net.http_post()` not `extensions.http_post()` — function lives in the `net` schema.
- **Supabase RLS recursion**: NEVER use `EXISTS (SELECT FROM profiles WHERE ...)` inside a policy ON `profiles` — causes infinite recursion. Always use `get_my_role()`.
- **systemd + nvm PATH**: Services spawning `claude` CLI need nvm bin in PATH (`/home/dallas/.nvm/versions/node/v20.19.5/bin`) — systemd doesn't source `.bashrc`.
- **BB VPS SSH**: User is `root@bb-vps` (no `dallas` user exists). SSH key: `~/.ssh/bb_vps`.
- **Supabase project ID**: `idorgloobxkmlnwnxbej` (OPAI auth + main DB)
