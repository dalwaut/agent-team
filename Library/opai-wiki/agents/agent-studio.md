# Agent Studio
> Last updated: 2026-02-19 | Source: `tools/opai-agents/`

## Overview

Agent Studio is the visual management interface for OPAI's AI agent team framework. It provides a browser-based dashboard for creating, organizing, running, and monitoring AI agents and squads — replacing the need for direct CLI interaction with `run_squad.ps1` and `team.json`.

The service runs as a FastAPI application on port 8088, proxied through Caddy at `/agents/`. Admin users manage the master `team.json`; regular users with sandbox access get isolated copies in their sandbox directories. All execution happens via Claude CLI (`claude -p`) spawned as subprocesses, with reports written to `reports/`.

## Architecture

```
Browser (HTTPS)
  |
  v
Caddy (port 443/80)
  |  handle_path /agents/* -> reverse_proxy localhost:8088
  v
opai-agents FastAPI server (port 8088)
  |
  |  Static files:   /agents/         -> static/index.html (SPA)
  |  API:            /agents/api/*    -> routes_api.py
  |  Auth config:    /agents/api/auth/config -> Supabase keys
  |
  |  Backend services:
  |    agent_manager    <- CRUD agents in team.json + prompt files
  |    squad_manager    <- CRUD squads in team.json
  |    executor         <- Spawn claude -p, track runs, read reports
  |    scheduler        <- Cron-based automated runs
  |    workflow_manager <- Multi-step squad pipelines
  |    ai_assistant     <- AI flow generation from natural language
  |    sandbox_bridge   <- Per-user sandbox isolation
  |
  v
File System
  |  /workspace/synced/opai/team.json     <- Agent/squad definitions
  |  /workspace/synced/opai/scripts/      <- Prompt files (prompt_*.txt)
  |  /workspace/synced/opai/reports/      <- Execution reports
  |  /workspace/users/<Name>/             <- User sandboxes (NFS)
  v
Claude CLI
  |  claude -p --output-format text < prompt.txt
  |  Writes markdown reports to reports/<date>/ + reports/latest/
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-agents/app.py` | FastAPI application: CORS, static files, auth middleware, startup |
| `tools/opai-agents/config.py` | All configuration: paths, env vars, categories, run orders |
| `tools/opai-agents/routes_api.py` | API route definitions — agents, squads, runs, reports, scheduler, workflows, AI, sandbox |
| `tools/opai-agents/requirements.txt` | Python dependencies (FastAPI, uvicorn, httpx, python-jose, aiofiles) |
| `tools/opai-agents/.env` | Supabase credentials (URL, anon key, JWT secret, service key) |
| `tools/opai-agents/services/__init__.py` | Service module package |
| `tools/opai-agents/services/agent_manager.py` | Agent CRUD: create/read/update/delete in team.json + prompt file management |
| `tools/opai-agents/services/squad_manager.py` | Squad CRUD: create/read/update/delete squad groups in team.json |
| `tools/opai-agents/services/executor.py` | Execution engine: spawn `claude -p`, track active runs, read reports |
| `tools/opai-agents/services/scheduler.py` | Cron scheduler: automated squad runs with preset templates |
| `tools/opai-agents/services/workflow_manager.py` | Workflow engine: multi-step squad pipelines with failure handling |
| `tools/opai-agents/services/ai_assistant.py` | AI flow builder: generate agent pipelines from natural language |
| `tools/opai-agents/services/sandbox_bridge.py` | Sandbox integration: user directory isolation, agent initialization |
| `tools/opai-agents/static/index.html` | Main SPA shell — tabs, views, loading screen, modal containers |
| `tools/opai-agents/static/style.css` | Full UI stylesheet — OPAI dark theme, guide forms, flow editor |
| `tools/opai-agents/static/js/app.js` | Core app: auth, router, state management, data loading, shared utilities |
| `tools/opai-agents/static/js/agents.js` | Agent management tab: table view, create/edit wizard, category filtering |
| `tools/opai-agents/static/js/squads.js` | Squad builder tab: agent pool, drag-to-add, execution preview |
| `tools/opai-agents/static/js/runs.js` | Runs tab: active runs, run history, report viewer modal |
| `tools/opai-agents/static/js/scheduler.js` | Scheduler tab: cron editor, preset buttons, schedule list |
| `tools/opai-agents/static/js/workflows.js` | Workflows tab: multi-step pipeline builder with failure handling |
| `tools/opai-agents/static/js/flow.js` | Flow editor tab: visual node canvas, drag-drop, connections, AI bar |
| `tools/opai-agents/static/js/guide.js` | Interactive onboarding guide: 8 slides with inline agent creation |

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPAI_AGENTS_HOST` | `127.0.0.1` | Server bind address |
| `OPAI_AGENTS_PORT` | `8088` | HTTP server port |
| `SUPABASE_URL` | (from .env) | Supabase project endpoint |
| `SUPABASE_ANON_KEY` | (from .env) | Supabase publishable key (for frontend auth config) |
| `SUPABASE_JWT_SECRET` | (from .env) | JWT validation secret |
| `SUPABASE_SERVICE_KEY` | (from .env) | Service role key (admin operations) |

### Hard-coded Paths

| Path | Purpose |
|------|---------|
| `/workspace/synced/opai` | Workspace root |
| `/workspace/synced/opai/team.json` | Agent roster + squad definitions |
| `/workspace/synced/opai/scripts/` | Prompt files (`prompt_*.txt`) and runner scripts |
| `/workspace/synced/opai/Templates/` | Specialist agent templates |
| `/workspace/synced/opai/reports/` | Execution report output |
| `/workspace/synced/opai/config/orchestrator.json` | Orchestrator config (cross-referenced) |
| `/workspace/users/` | NFS-mounted user sandbox root |

### Agent Categories

| Category | Color | Examples |
|----------|-------|---------|
| `quality` | `#10b981` | Code review, accuracy, health, security, UX, testing |
| `planning` | `#3b82f6` | Feature architecture, integration blueprints |
| `research` | `#f59e0b` | Technical research, problem solving |
| `operations` | `#8b5cf6` | GitHub, email, notes, workspace maintenance |
| `leadership` | `#ef4444` | Project management, consolidation |
| `content` | `#ec4899` | Changelogs, app store copy, social posts |
| `execution` | `#06b6d4` | Auto-apply safe fixes or all improvements |
| `meta` | `#64748b` | Self-assessment, team evolution |
| `orchestration` | `#f97316` | Report dispatch, action routing |

### Run Orders

| Order | Behavior |
|-------|----------|
| `parallel` | Runs concurrently with other parallel agents (Phase 2) |
| `first` | Runs sequentially before parallel agents (Phase 1) |
| `last` | Runs sequentially after all parallel agents finish (Phase 3) |

### Per-Agent Tuning Fields

The agent create/edit form includes three tuning controls that map to fields stored per-role in `team.json`:

| UI Control | team.json Field | Options | Effect |
|-----------|----------------|---------|--------|
| **Model** dropdown | `model` | Inherit (default) / haiku / sonnet / opus | Sets `--model` flag on `claude -p`. "Inherit" uses the system default from `config/orchestrator.json`. |
| **Max Turns** input | `max_turns` | `0` = unlimited (default), any positive integer | Sets `--max-turns` flag. Limits agentic turns to control token spend. |
| **Skip Project Context** toggle | `no_project_context` | off (default) / on | Adds `--setting-sources user` to skip loading CLAUDE.md + MEMORY.md (~14KB, ~3,500 tokens/turn). |

These fields are consumed by `run_agent_task()` and `_run_feedback_fix()` in the Task Control Panel backend (`tools/opai-tasks/services.py`). The `list_agents()` API response includes the `model` field so the UI correctly pre-fills the dropdown on edit.

See [Agent Framework — Agent Tuning Fields](agent-framework.md#agent-tuning-fields) for the full architecture and token optimization strategy.

## API

### Agent Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents` | List all agents (user-filtered for sandbox users) |
| `GET` | `/api/agents/templates` | List specialist agent templates |
| `GET` | `/api/agents/{agent_id}` | Get single agent with prompt content |
| `POST` | `/api/agents` | Create agent (body: `{id, name, emoji, category, description, run_order, prompt_content, depends_on, model, max_turns, no_project_context}`) |
| `PUT` | `/api/agents/{agent_id}` | Update agent fields |
| `DELETE` | `/api/agents/{agent_id}` | Delete agent and its prompt file |

### Squad Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/squads` | List all squads (user-filtered) |
| `GET` | `/api/squads/{squad_id}` | Get squad with resolved agent details |
| `POST` | `/api/squads` | Create squad (body: `{id, description, agents}`) |
| `PUT` | `/api/squads/{squad_id}` | Update squad |
| `DELETE` | `/api/squads/{squad_id}` | Delete squad |

### Execution Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/runs/squad/{squad_name}` | Execute a squad (async, returns run_id) |
| `POST` | `/api/runs/agent/{agent_name}` | Execute a single agent (async) |
| `GET` | `/api/runs` | List run history (default limit=50) |
| `GET` | `/api/runs/active` | List in-progress runs |
| `GET` | `/api/runs/{run_id}` | Get run details |
| `POST` | `/api/runs/{run_id}/cancel` | Cancel a running execution |

### Report Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reports/dates` | List available report dates |
| `GET` | `/api/reports/{date}` | List reports for a date (use `latest` for most recent) |
| `GET` | `/api/reports/{date}/{name}` | Read a specific report file |

### Scheduler Endpoints (admin only)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/schedules` | List all schedules |
| `GET` | `/api/schedules/presets` | Get cron expression presets |
| `GET` | `/api/schedules/{name}` | Get schedule details |
| `POST` | `/api/schedules` | Create schedule (body: `{name, squad, cron, enabled}`) |
| `PUT` | `/api/schedules/{name}` | Update schedule |
| `DELETE` | `/api/schedules/{name}` | Delete schedule |

### Workflow Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/workflows` | List workflows (user-filtered) |
| `GET` | `/api/workflows/{workflow_id}` | Get workflow details |
| `POST` | `/api/workflows` | Create workflow (body: `{id, name, steps}`) |
| `PUT` | `/api/workflows/{workflow_id}` | Update workflow |
| `DELETE` | `/api/workflows/{workflow_id}` | Delete workflow |

### AI & Metadata Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ai/build-flow` | Generate agent/squad flows from natural language prompt |
| `GET` | `/api/meta/categories` | List agent categories |
| `GET` | `/api/meta/run-orders` | List run order options |

### Sandbox Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sandbox/info` | Get user's sandbox configuration |
| `POST` | `/api/sandbox/init` | Initialize sandbox with agent team copy |

## How to Use

### From the Browser

1. Navigate to `https://<server>/agents/` (or click "Agent Studio" in the portal navbar)
2. **Dashboard** tab: overview cards (agent count, squad count) + quick-launch squad cards
3. **Agents** tab: browse, filter by category, create with the wizard, edit inline
4. **Squads** tab: build squads by clicking agents into the group, preview execution order
5. **Runs** tab: trigger squad runs, watch active progress, browse reports
6. **Scheduler** tab: set up recurring cron-based runs (admin only)
7. **Workflows** tab: chain squads into multi-step pipelines with failure handling
8. **Agent Flow** tab: visual node editor + AI builder for designing pipelines

### Interactive Guide

The onboarding guide auto-shows on first visit and walks through all concepts. Slides 5-7 let you create an agent directly inside the guide with embedded form inputs. Re-open anytime via the **? Help** button.

### From the CLI

```bash
# Run a squad
./scripts/run_squad.ps1 -Squad "audit"

# Run specific agents only
./scripts/run_agents_seq.ps1 -Filter "accuracy,health"

# Auto-fix (safe mode — non-breaking only)
./scripts/run_auto.ps1 -Mode safe

# Auto-fix (full mode — all improvements)
./scripts/run_auto.ps1 -Mode full

# List available squads
./scripts/run_squad.ps1 -List
```

### Create an Agent via API

```bash
curl -X POST https://<server>/agents/api/agents \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "docs_checker",
    "name": "Documentation Checker",
    "emoji": "DC",
    "category": "quality",
    "description": "Validates docs completeness",
    "run_order": "parallel",
    "prompt_content": "You are the Documentation Checker agent...",
    "depends_on": []
  }'
```

### Create a Squad via API

```bash
curl -X POST https://<server>/agents/api/squads \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "docs_review",
    "description": "Review all documentation",
    "agents": ["docs_checker", "content_curator", "manager"]
  }'
```

### Run a Squad via API

```bash
curl -X POST https://<server>/agents/api/runs/squad/audit \
  -H "Authorization: Bearer <jwt>"
# Returns: {"run_id": "abc123", "status": "running"}
```

### Read Reports

```bash
# List available dates
curl https://<server>/agents/api/reports/dates \
  -H "Authorization: Bearer <jwt>"

# List reports for latest run
curl https://<server>/agents/api/reports/latest \
  -H "Authorization: Bearer <jwt>"

# Read a specific report
curl https://<server>/agents/api/reports/latest/accuracy \
  -H "Authorization: Bearer <jwt>"
```

## Dependencies

### Runtime

| Dependency | Version | Purpose |
|-----------|---------|---------|
| `fastapi` | >= 0.104.0 | Web framework |
| `uvicorn` | >= 0.24.0 | ASGI server |
| `httpx` | >= 0.25.0 | Async HTTP client |
| `python-dotenv` | >= 1.0.0 | Environment variable loading |
| `python-jose[cryptography]` | >= 3.3.0 | JWT decoding and validation |
| `aiofiles` | >= 23.0.0 | Async file I/O |

### Frontend Libraries (CDN)

| Library | Purpose |
|---------|---------|
| `@supabase/supabase-js` | Auth session management |
| Inter font | UI typography |
| JetBrains Mono font | Code/monospace typography |

### External Tools

| Tool | Purpose |
|------|---------|
| `claude` CLI | Agent execution engine (via `claude -p`) |
| `run_squad.ps1` | PowerShell squad runner (executor invokes this) |
| `run_agents_seq.ps1` | PowerShell sequential agent runner |

### Data Files

| File | Read/Write | Purpose |
|------|-----------|---------|
| `team.json` | R/W | Agent roster, squad definitions, specialist templates |
| `scripts/prompt_*.txt` | R/W | Individual agent prompt files |
| `reports/` | Read | Execution output (timestamped dirs + `latest/`) |
| `config/orchestrator.json` | Read | Orchestrator state (cross-reference) |

### Inter-service Dependencies

| Service | Relationship |
|---------|-------------|
| [Portal](portal.md) | Provides auth login page and navbar |
| [Orchestrator](orchestrator.md) | Can trigger squad runs; shares `team.json` |
| [Sandbox System](sandbox-system.md) | Provides per-user isolated directories |
| Caddy | Reverse proxy (`/agents/` -> `localhost:8088`) |
| Supabase | JWT authentication and user metadata |

## Frontend Layout

### Layout Strategy (Two-Mode Design)

The Agent Studio uses two distinct layout modes to handle the difference between scrollable content views and the fixed-viewport flow editor:

**Normal mode** (Dashboard, Agents, Squads, Runs, Scheduler, Workflows):
```css
body { min-height: 100vh; min-height: 100dvh; }
.as-main { padding: 1.5rem; }
```
Standard scrollable page — body grows with content, page scrolls naturally. No `overflow: hidden`, no flex column layout. This is the same pattern used by Monitor and other working OPAI tools.

**Flow mode** (Agent Flow tab only):
```css
body.flow-layout {
    height: 100vh; height: 100dvh;
    overflow: hidden;
    display: flex; flex-direction: column;
}
body.flow-layout #app {
    display: flex; flex-direction: column;
    flex: 1; min-height: 0; overflow: hidden;
}
body.flow-layout .as-main {
    overflow-y: auto; flex: 1; min-height: 0;
}
```
The `flow-layout` class is toggled on `<body>` by `switchView()` in `app.js` when entering/leaving the flow tab. This creates a fixed-viewport flex chain so the canvas, AI bar, and status bar fill the screen exactly.

### Layout Gotchas

- **`flow-layout` must NOT be applied during loading**: The `switchView()` function checks `#app` visibility before adding the class. If hash is `#flow` on page load, the class is deferred until after `#loading-screen` is hidden and `#app` is revealed. Applying it early breaks the loading screen display.
- **No `max-width` or `margin: 0 auto` on `.as-main`**: Earlier versions constrained the main area to 1200px centered. This caused the UI to float in the center with empty gutters on wide screens. Content now stretches edge-to-edge with padding only.
- **Cache busting**: Static assets use `?v=N` query strings in `index.html` to bypass Caddy's ETag caching after CSS/JS changes. Bump the version number after frontend edits.
- **Navbar height**: The shared navbar (`navbar.js`) prepends a 44px bar to `<body>`. In normal mode this just pushes content down naturally. In flow mode, the navbar has `flex-shrink: 0` so the flow editor fills the remaining space.

### Asset Cache Busting

After editing any CSS or JS file, bump the `?v=N` query string in `static/index.html`:
```html
<link rel="stylesheet" href="/agents/static/style.css?v=4">
<script src="/agents/static/js/app.js?v=4"></script>
```
Then restart the service. Caddy serves HTML with `Cache-Control: no-cache` but static assets use ETag caching, so without the version bump browsers may serve stale files.

## Troubleshooting

### Page bottom is cut off / buttons inaccessible

**Symptom:** The bottom of the page is clipped. Create Agent button, AI input bar, or other elements are unreachable. More/less is cut off depending on screen size.
**Cause:** Using `body { height: 100vh; overflow: hidden; display: flex; }` for all views breaks scrollable content. The rigid flex chain requires every intermediate container to have correct flex properties, and the navbar's 44px further reduces available space.
**Solution:** The fix is the two-mode layout (see Frontend Layout section). Normal views use `min-height: 100vh` with natural scrolling. Only the flow editor activates the fixed-viewport flex layout via the `flow-layout` body class.

### Endless "Loading..." on page refresh (especially #flow)

**Symptom:** Refreshing the page shows "Loading..." forever when the URL hash is `#flow`.
**Cause:** `initRouter()` calls `switchView('flow')` early during init, which was adding `flow-layout` to body while `#loading-screen` was still visible. The flex layout collapsed the loading screen.
**Solution:** `switchView()` now checks if `#app` is visible before adding `flow-layout`. The class is deferred and applied after the loading screen is hidden. See the `DOMContentLoaded` handler in `app.js`.

### CSS/JS changes not appearing after restart

**Symptom:** Service restarted but browser still shows old styles or behavior.
**Cause:** Caddy serves static assets with ETag caching. Browser uses cached version.
**Solution:** Bump the `?v=N` query string on all `<link>` and `<script>` tags in `index.html`, then restart. Or use Ctrl+Shift+R for a hard refresh.

### Agent creation fails with "already exists"

**Symptom:** POST `/api/agents` returns 409 or error about duplicate ID.
**Cause:** An agent with that ID already exists in `team.json`.
**Solution:** Choose a different ID, or delete the existing agent first. Check `team.json` directly if the UI doesn't show it (stale cache).

### Squad run hangs or never completes

**Symptom:** Run stays in "running" status indefinitely.
**Cause:** Claude CLI process may have stalled, or the prompt file is missing.
**Solution:** Cancel the run via API or UI. Check that `scripts/prompt_<agent_id>.txt` exists for all agents in the squad. Check `journalctl --user -u opai-agents -f` for subprocess errors.

### Reports tab shows no dates

**Symptom:** Report dates list is empty even after running squads.
**Cause:** Reports directory doesn't exist or permissions issue on NFS.
**Solution:** Verify `reports/` exists at workspace root. Check NFS mount is active (`mount | grep opai`). Run a squad from CLI to confirm reports are generated.

### Scheduler not firing

**Symptom:** Scheduled squad runs don't execute at the expected time.
**Cause:** Scheduler runs in-process; if the service restarts, schedule state resets.
**Solution:** Check the service is running (`systemctl --user status opai-agents`). Verify the cron expression is correct. Check logs for scheduler tick errors.

### Sandbox user sees no agents

**Symptom:** Non-admin user's agent list is empty.
**Cause:** User's sandbox hasn't been initialized with an agent team copy.
**Solution:** Click "Initialize Agents" in the sandbox panel, or call `POST /api/sandbox/init`. Verify the user's sandbox directory exists at `/workspace/users/<DisplayName>/`.

### Guide doesn't auto-show

**Symptom:** New user doesn't see the welcome guide.
**Cause:** `opai-agents-guide-seen` localStorage flag is already set (e.g., from a previous session).
**Solution:** Clear the flag: open browser DevTools > Application > Local Storage > delete `opai-agents-guide-seen`. Or click the **? Help** button to manually trigger it.

## Examples

### Example 1: Create a Security Auditor

```javascript
// From the browser console or frontend code
const agent = await apiFetch('/agents', {
    method: 'POST',
    body: JSON.stringify({
        id: 'security_auditor',
        name: 'Security Auditor',
        emoji: 'SA',
        category: 'quality',
        description: 'OWASP audit, auth checks, secrets scanning',
        run_order: 'parallel',
        prompt_content: `You are the Security Auditor agent.

Tasks:
1. Scan for hardcoded secrets, API keys, and credentials
2. Check authentication and authorization patterns
3. Review input validation and sanitization
4. Identify OWASP Top 10 vulnerabilities
5. Check dependency versions for known CVEs

Output a markdown report grouped by severity.`,
        depends_on: [],
    }),
});
```

### Example 2: Build a Pre-Release Squad

```javascript
const squad = await apiFetch('/squads', {
    method: 'POST',
    body: JSON.stringify({
        id: 'pre_release',
        description: 'Full check before shipping a release',
        agents: ['security_auditor', 'health', 'test_writer', 'content_curator', 'manager'],
    }),
});
```

### Example 3: Schedule a Nightly Audit

```bash
curl -X POST https://<server>/agents/api/schedules \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "nightly_audit",
    "squad": "audit",
    "cron": "0 2 * * *",
    "enabled": true
  }'
```

### Example 4: Create a Workflow Pipeline

```javascript
const workflow = await apiFetch('/workflows', {
    method: 'POST',
    body: JSON.stringify({
        id: 'full_review',
        name: 'Full Review Pipeline',
        steps: [
            { squad: 'familiarize', on_failure: 'stop' },
            { squad: 'audit', on_failure: 'skip' },
            { squad: 'review', on_failure: 'stop' },
        ],
    }),
});
```

## Security

### Authentication
All API endpoints require a valid Supabase JWT in the `Authorization: Bearer <token>` header. The frontend obtains this via `supabase.auth.getSession()`. Unauthenticated requests return 401 and redirect to `/auth/login`.

### Authorization
- **Admin users** (`app_metadata.role === 'admin'`): full access to all endpoints including scheduler
- **Regular users**: must have `agents` in their `allowed_apps` list; scheduler endpoints are restricted
- **Sandbox isolation**: non-admin users read/write their own `team.json` copy in `/workspace/users/<Name>/`

### Execution Safety
- Agents execute via `claude -p` as read-only analyzers — they produce stdout reports, no file modifications (except `executor_safe` and `executor_full` which are opt-in)
- Prompt files are sanitized on write (agent IDs restricted to `[a-z0-9_]`)
- Run cancellation kills the subprocess tree

### CORS
Configured to allow requests from the Caddy-proxied origin. No wildcard origins in production.

## Cross-References

- [Agent Framework](../CLAUDE.md) — Full agent roster, squad definitions, execution model
- [Orchestrator](orchestrator.md) — Central coordinator that can trigger squad runs
- [Sandbox System](sandbox-system.md) — Per-user directory isolation and provisioning
- [Portal](portal.md) — Auth flow, navbar, app access control
- [Dev IDE](dev-ide.md) — Browser IDE with Claude integration
- [Docs Portal](docs.md) — Auto-generated documentation from wiki entries
