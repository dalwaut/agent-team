# Dev IDE (Workspace Manager)
> Last updated: 2026-02-20 | Source: `tools/opai-dev/`

## Overview

Browser-based IDE providing per-user, per-project Theia containers. Users pick a project from a file explorer landing page, and the system spins up a Docker container with the project mounted as the workspace root and their full sandbox as a secondary read-write mount. Caddy terminates TLS; the Express app handles auth, workspace lifecycle, and reverse-proxies HTTP + WebSocket traffic into the container.

The IDE includes built-in AI integration powered by Claude Code CLI on the host server, baked-in extensions for web development, and a shared extension library users can opt into.

## Architecture

```
Browser (HTTPS)
  |
  v
Caddy (port 443/80)
  |  handle /dev/* -> reverse_proxy localhost:8085
  |  (path preserved -- uses `handle` not `handle_path`)
  v
opai-dev Express server (port 8085)
  |  Landing page: /dev/         -> project picker + file explorer + extensions panel
  |  API:          /dev/api/*    -> workspace + project + extension CRUD
  |  IDE proxy:    /dev/ide/:id  -> reverse_proxy -> container
  |    HTTP:  strip prefix -> proxy.web()
  |    WS:    strip prefix -> proxy.ws()
  |  Claude bridge: Unix socket  -> spawns `claude -p` on host
  v
Docker container (opai-theia:latest)
  |  Internal port 3000 -> host port 9000-9099 (127.0.0.1 only)
  |  Theia serves static files + socket.io backend
  |  AI Chat -> localhost:4141 (socat) -> Unix socket -> host bridge -> Claude CLI
  |  Mounts:
  |    /home/project    <- user's project folder (read-write)
  |    /home/opai       <- user's full sandbox (read-write)
  |    /tmp/opai-claude-bridge.sock <- Claude bridge socket
  |    /usr/local/bin/opai-claude   <- Claude CLI wrapper (read-only)
  |    /home/theia/user-plugins     <- staged user extensions (read-only, optional)
  v
User's filesystem
  Admin:   /workspace/synced/opai/Projects/{name}
  Regular: /workspace/users/{userId}/Projects/{name}
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-dev/index.js` | Express app: landing page, IDE reverse proxy, WebSocket upgrade handler, extensions panel |
| `tools/opai-dev/routes/workspaces.js` | Workspace CRUD: create, list, status, stop, destroy + extension staging |
| `tools/opai-dev/routes/projects.js` | Project folder CRUD: list, browse, create, rename, delete |
| `tools/opai-dev/routes/extensions.js` | Extension library API: list available, enable/disable per user |
| `tools/opai-dev/middleware/auth.js` | Supabase JWT auth (JWKS + HS256 fallback), profile enrichment |
| `tools/opai-dev/services/docker-manager.js` | Container lifecycle: create, start, stop, destroy, inspect, mounts, env vars |
| `tools/opai-dev/services/port-allocator.js` | Port range management (9000-9099) |
| `tools/opai-dev/services/lifecycle.js` | Auto-stop idle containers (30 min), stale cleanup (24 hr) |
| `tools/opai-dev/services/claude-bridge.js` | WebSocket + OpenAI-compat HTTP bridge to Claude Code CLI |
| `tools/opai-dev/services/extensions.js` | Extension registry cache, user prefs, VSIX symlink staging |
| `tools/opai-dev/services/supabase.js` | Supabase client (service role) |
| `tools/opai-dev/docker/Dockerfile` | Multi-stage Theia image build (build + runtime stages) |
| `tools/opai-dev/docker/theia-app.json` | Theia extension manifest + theiaPlugins (pinned to 1.68.2) |
| `tools/opai-dev/docker/default-settings.json` | Baked-in Theia settings (theme, AI config, editor defaults) |
| `tools/opai-dev/docker/entrypoint.sh` | Container entrypoint: starts socat proxy, then launches Theia |
| `tools/opai-dev/docker/scripts/opai-claude` | In-container CLI wrapper for Claude bridge |
| `tools/opai-dev/docker/plugins/opai-ai-defaults/` | Custom plugin: auto-opens AI Chat panel on startup |
| `tools/opai-dev/docker/branding/product.json` | Theia branding (title, logo) |
| `tools/opai-dev/.env` | Runtime configuration |
| `/workspace/shared/extensions/registry.json` | Shared extension library catalog |

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `8085` | Express listen port |
| `SUPABASE_URL` | -- | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | -- | Service role key (profile enrichment) |
| `SUPABASE_JWT_SECRET` | -- | JWT signing secret (HS256 fallback) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker daemon socket |
| `THEIA_IMAGE` | `opai-theia:latest` | Container image |
| `PORT_RANGE_START` | `9000` | First allocatable port |
| `PORT_RANGE_END` | `9099` | Last allocatable port |
| `NFS_WORKSPACE_ROOT` | `/workspace/users` | User sandbox root |
| `CONTAINER_MEMORY` | `2147483648` (2 GB) | Container memory limit |
| `CONTAINER_CPU_PERIOD` | `100000` | CPU CFS period |
| `CONTAINER_CPU_QUOTA` | `100000` | CPU CFS quota (1 core) |
| `IDLE_TIMEOUT` | `1800` (30 min) | Idle container auto-stop |
| `STALE_TIMEOUT` | `86400` (24 hr) | Stale container cleanup |
| `LIFECYCLE_INTERVAL` | `60` | Lifecycle check interval (seconds) |
| `OPAI_AUTH_DISABLED` | -- | Set `1` to bypass auth (dev only) |
| `EXTENSIONS_LIBRARY_PATH` | `/workspace/shared/extensions` | Shared vetted extension library root |
| `CLAUDE_BRIDGE_SOCKET` | `/tmp/opai-claude-bridge.sock` | Unix socket path for Claude bridge |
| `OPAI_ROOT` | `/workspace/synced/opai` | OPAI workspace root (admin project resolution) |

## API

### Workspace Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/dev/api/workspaces` | Bearer | Create or switch workspace (accepts `project_name` or `project_path`) |
| GET | `/dev/api/workspaces` | Bearer | List user's workspaces |
| GET | `/dev/api/workspaces/:id/status` | Bearer | Workspace status + Docker inspect |
| DELETE | `/dev/api/workspaces/:id` | Bearer | Stop (default) or destroy (`?action=destroy`) |

### Project Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/dev/api/projects` | Bearer | List top-level project folders |
| GET | `/dev/api/projects/browse` | Bearer | Browse directory (`?path=relative/path`) |
| POST | `/dev/api/projects` | Bearer | Create project folder (`{ name }`) |
| POST | `/dev/api/projects/mkdir` | Bearer | Create subfolder (`{ path }`) |
| PATCH | `/dev/api/projects/:name` | Bearer | Rename project (`{ name: newName }`) |
| DELETE | `/dev/api/projects/:name` | Bearer | Delete project folder |

### Extension Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/dev/api/extensions/available` | Bearer | List library extensions with user enabled status |
| GET | `/dev/api/extensions/enabled` | Bearer | User's enabled extension IDs |
| POST | `/dev/api/extensions/enable` | Bearer | Enable extension (`{ extension_id }`) |
| POST | `/dev/api/extensions/disable` | Bearer | Disable extension (`{ extension_id }`) |

### Other Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/dev/` | Cookie | Landing page (file explorer + IDE launcher + extensions panel) |
| GET/WS | `/dev/ide/:workspaceId/*` | Bearer/Cookie | IDE reverse proxy (HTTP + WebSocket) |
| GET | `/health` | None | Service health check |

## AI Integration

### Architecture

The AI system uses Claude Code CLI on the host server, bridged into containers via Unix domain sockets. This means:
- No API keys required for users (costs are covered by the server's Claude subscription)
- Claude has direct filesystem access to the user's project files on the host
- Users can optionally bring their own API keys (BYOK) for direct provider access

```
Theia AI Chat (in container)
  |  Sends OpenAI-format request to custom model "claude-code"
  v
localhost:4141 (socat inside container)
  |  TCP -> Unix socket proxy
  v
/tmp/opai-claude-bridge.sock (mounted from host)
  |  Unix domain socket
  v
claude-bridge.js (on host, part of opai-dev service)
  |  Spawns: claude -p --output-format text
  |  Working directory: user's actual project path on host
  |  Streams response back as OpenAI SSE format
  v
Claude Code CLI -> Anthropic API -> streaming response
```

**Why Unix sockets?** UFW firewall blocks all TCP traffic from Docker bridge networks to the host (ports 8080-8888 are explicitly blocked). Unix sockets bypass the network stack entirely. The socket is mounted read-write into each container.

**Why socat?** Theia's OpenAI provider sends HTTP requests, but the bridge listens on a Unix socket. The container's `entrypoint.sh` starts socat to proxy `localhost:4141 (TCP) -> /tmp/opai-claude-bridge.sock (Unix)` so Theia can reach the bridge via a normal HTTP URL.

### Claude Bridge Service (`services/claude-bridge.js`)

Runs as part of the opai-dev process (started in `index.js` via `claudeBridge.start()`). Provides two interfaces:

**WebSocket protocol** (used by `opai-claude` CLI):
- Client connects to `ws+unix:///tmp/opai-claude-bridge.sock:/`
- Client sends: `{ type: "prompt", prompt: "...", cwd: "/home/project/..." }`
- Server streams: `{ type: "token", content: "..." }` (real-time tokens)
- Server sends final: `{ type: "result", content: "..." }` (complete output)
- Server sends on error: `{ type: "error", message: "..." }`
- Spawns `claude -p --output-format stream-json --verbose`

**OpenAI-compatible HTTP API** (used by Theia AI Chat):
- `POST /v1/chat/completions` -- streaming SSE or JSON response
- `GET /v1/models` -- returns `claude-code` model listing
- Spawns `claude -p --output-format text`
- Streams back in OpenAI SSE format: `data: {"choices":[{"delta":{"content":"..."}}]}`

**Key behaviors:**
- One concurrent session per user (additional requests rejected)
- 5-minute timeout per request (configurable via `CLAUDE_BRIDGE_TIMEOUT`)
- `CLAUDECODE` env var stripped to prevent nested session detection
- Claude CLI path: `~/.nvm/versions/node/v20.19.5/bin/claude` (nvm)
- Admin users' cwd resolves to OPAI workspace; regular users to their NFS sandbox
- No auth required -- Unix socket is inherently trusted (only containers with the socket mounted can connect)

### Container-side CLI Wrapper (`docker/scripts/opai-claude`)

Bash script mounted at `/usr/local/bin/opai-claude` inside containers. Provides a terminal command for interacting with Claude:

```bash
# Basic usage
opai-claude "explain this code"

# Include file context
opai-claude -f src/index.ts "review this file"

# Pipe from stdin
echo "what does this do?" | opai-claude
```

Uses `NODE_PATH=/home/theia/node_modules` to access the `ws` WebSocket library from Theia's installed packages. Connects directly to the Unix socket (not via socat).

### Container Entrypoint (`docker/entrypoint.sh`)

```bash
#!/bin/bash
BRIDGE_SOCKET="/tmp/opai-claude-bridge.sock"
PROXY_PORT=4141

# Start socat proxy if the bridge socket is mounted
if [ -S "$BRIDGE_SOCKET" ]; then
  socat TCP-LISTEN:${PROXY_PORT},fork,reuseaddr,bind=127.0.0.1 UNIX-CONNECT:${BRIDGE_SOCKET} &
fi

# Launch Theia
exec node /home/theia/src-gen/backend/main.js "$@"
```

### Baked-in AI Settings (`docker/default-settings.json`)

These settings are baked into the Docker image at `/home/developer/.theia/settings.json`:

```json
{
  "ai-features.AiEnable.enableAI": true,
  "ai-features.chat.defaultAgent": "Universal",
  "ai-features.openAiCustom.customOpenAiModels": [
    {
      "model": "claude-code",
      "url": "http://localhost:4141/v1/",
      "id": "claude-code",
      "apiKey": "opai-bridge",
      "enableStreaming": true,
      "developerMessageSettings": "system"
    }
  ],
  "ai-features.agentSettings": {
    "Universal": {
      "languageModelRequirements": [
        { "purpose": "chat", "identifier": "claude-code" }
      ]
    }
  }
}
```

**Critical settings explained:**
- `defaultAgent: "Universal"` -- Routes chat messages to the Universal agent (provided by `@theia/ai-ide`)
- `customOpenAiModels` -- Registers the Claude bridge as a custom OpenAI-compatible model
  - `url: "http://localhost:4141/v1/"` -- Points to socat proxy (Theia appends `/chat/completions`)
  - `apiKey: "opai-bridge"` -- Required by Theia but not validated by the bridge
  - `enableStreaming: true` -- Uses SSE streaming for real-time responses
  - `developerMessageSettings: "system"` -- Sends system prompts as system role messages
- `agentSettings.Universal.languageModelRequirements` -- Maps the Universal agent to use `claude-code` model

### Custom Plugin (`docker/plugins/opai-ai-defaults/`)

A minimal Theia plugin that auto-opens the AI Chat panel 3 seconds after startup:

```javascript
// extension.js
function activate(context) {
  setTimeout(() => {
    vscode.commands.executeCommand('aiChat:toggle');
  }, 3000);
}
```

Registered via `THEIA_DEFAULT_PLUGINS=local-dir:/home/theia/plugins` env var.

### BYOK (Bring Your Own Key)

Users who have their own API keys can configure them directly in Theia settings (Ctrl+,):
- **Anthropic**: `@theia/ai-anthropic` -- enter API key in AI preferences
- **OpenAI**: `@theia/ai-openai` -- enter API key in AI preferences
- **Ollama**: `@theia/ai-ollama` -- configure local Ollama endpoint

No server-side changes needed -- these packages talk directly to the provider APIs.

**Future shared key**: `.env` has a placeholder `SHARED_ANTHROPIC_KEY=` for enterprise/shared API key injection. When activated, `docker-manager.js` would pass it as `ANTHROPIC_API_KEY` env var to containers.

## Extension System

### Layer A: Baked-in Extensions (theiaPlugins)

Downloaded at build time from Open VSX into `/home/theia/plugins/`. Users cannot remove these.

| Category | Extensions |
|----------|-----------|
| Language Support | TypeScript Language Features, JavaScript, JSON, CSS, HTML, Markdown, Emmet, npm |
| Git Integration | Git (built-in), Git Base, GitLens, Git Graph |
| Formatting & Linting | Prettier, ESLint |
| Editor Enhancements | Error Lens, Material Icon Theme, Catppuccin Theme |
| Framework Support | Tailwind CSS IntelliSense |

**Total: 17 baked-in extensions** defined in `theiaPlugins` section of `theia-app.json`.

### Layer B: Shared Extension Library

Admin-curated VSIX extensions users can opt into via the landing page UI.

**Host directory:**
```
/workspace/shared/extensions/
  registry.json              <- Catalog of all vetted extensions
  vsix/
    prisma.prisma-5.10.0.vsix
    golang.go-0.41.0.vsix
    ...
```

**Registry schema** (`registry.json`):
```json
{
  "version": 1,
  "extensions": [
    {
      "id": "Prisma.prisma",
      "name": "Prisma",
      "publisher": "Prisma",
      "description": "ORM schema support",
      "version": "5.10.0",
      "filename": "prisma.prisma-5.10.0.vsix",
      "categories": ["language", "database"],
      "size_bytes": 3145728,
      "added_at": "2026-02-15T00:00:00Z"
    }
  ]
}
```

**Per-user preferences** stored at `{userRoot}/.opai/extensions.json`:
```json
{ "enabled": ["Prisma.prisma", "golang.go"] }
```

**Staging mechanism** (runs before container creation in `routes/workspaces.js`):
1. `extensions.stageExtensions(userId, role)` reads user's preferences
2. Creates/clears `{userRoot}/.opai/active-plugins/`
3. Creates symlinks from shared VSIX library to staging dir
4. Returns staging dir path (or null if no extensions enabled)
5. `docker-manager.js` mounts it at `/home/theia/user-plugins:ro`
6. Overrides `THEIA_DEFAULT_PLUGINS` to include both plugin dirs

**Landing page panel**: Collapsible "Extensions" section shows available extensions with toggle buttons. Shows "restart required" banner when extensions change while IDE is running.

## Theia AI Packages

All pinned to version 1.68.2 in `theia-app.json`:

| Package | Purpose |
|---------|---------|
| `@theia/ai-core` | Foundation: LLM registry, agents, prompts, variables |
| `@theia/ai-core-ui` | AI preference UI, provider config panels |
| `@theia/ai-chat` | Chat backend (sessions, history, context) |
| `@theia/ai-chat-ui` | Chat panel UI (sidebar) |
| `@theia/ai-ide` | **IDE agents: Universal, Coder, Architect** (required for chat to work) |
| `@theia/ai-code-completion` | Inline code completions (ghost text while typing) |
| `@theia/ai-history` | Chat session persistence |
| `@theia/ai-editor` | Editor-specific AI actions (explain, refactor) |
| `@theia/ai-terminal` | Terminal assistance agent |
| `@theia/ai-anthropic` | Native Anthropic provider (for BYOK) |
| `@theia/ai-openai` | OpenAI provider + custom model support (used for bridge) |
| `@theia/ai-ollama` | Local LLM support via Ollama (for BYOK) |
| `@theia/ai-mcp` | MCP server/client integration |
| `@theia/ai-mcp-ui` | MCP configuration UI |

**Critical note**: `@theia/ai-ide` is what provides the actual chat agents (Universal, Coder, Architect). Without this package, the AI Chat UI loads but shows "No agent was found to handle this request." The package was renamed from `@theia/ai-ide-agents` (which only exists as a prerelease) to `@theia/ai-ide` in stable releases.

**NOT included** (and why):
- `@theia/ai-claude-code` -- requires Claude Code installed inside the container; we bridge from the host instead
- `@theia/ai-google` / `@theia/ai-huggingface` -- not needed for current setup

## How It Works

### Workspace Lifecycle

1. User opens `/dev/` -> landing page loads project list from filesystem + workspace status from DB
2. User clicks project -> `POST /dev/api/workspaces` with `project_name`
3. Server calls `extensions.stageExtensions()` to prepare user's optional extensions
4. Server checks for existing workspaces:
   - **Same project running** -> returns existing IDE URL
   - **Different project running** -> auto-stops old container, starts new one
   - **Stopped workspace** -> reallocates port, destroys old container, creates new container
   - **No workspace** -> allocates port, creates container, inserts DB row
5. Container starts with mounts (project, sandbox, bridge socket, CLI wrapper, user plugins)
6. `entrypoint.sh` starts socat proxy (4141 -> socket), then launches Theia
7. User redirected to `/dev/ide/{workspaceId}/`
8. Reverse proxy forwards all HTTP/WS to container, stripping the `/dev/ide/{id}` prefix
9. AI Chat panel auto-opens (opai-ai-defaults plugin, 3s delay)
10. After 30 min of no activity -> lifecycle manager stops container, releases port
11. After 24 hr -> stale containers cleaned up

### Container Mounts

| Container Path | Host Path | Access | Purpose |
|----------------|-----------|--------|---------|
| `/home/project` | `{user}/Projects/{name}` | read-write | IDE workspace root |
| `/home/opai` | `{user sandbox root}` | read-write | Full sandbox |
| `/tmp/opai-claude-bridge.sock` | `/tmp/opai-claude-bridge.sock` | read-write | Claude bridge socket |
| `/usr/local/bin/opai-claude` | `docker/scripts/opai-claude` | read-only | Claude CLI wrapper |
| `/home/theia/user-plugins` | `{user}/.opai/active-plugins/` | read-only | Staged user extensions (optional) |

Admin users mount from `/workspace/synced/opai/Projects/`. Regular users mount from `/workspace/users/{userId}/Projects/`.

### Container Security

- Bound to `127.0.0.1` only (no external port exposure)
- `no-new-privileges` security option
- Memory capped at 2 GB, CPU capped at 1 core
- Docker network: `opai-dev-net` bridge (gateway auto-discovered)
- No restart policy (lifecycle manager handles restarts)
- Unix socket is world-readable/writable (`0o777`) but only accessible to containers with the mount

### IDE Reverse Proxy

The proxy uses `http-proxy` to forward requests to the container:

- **HTTP**: `proxy.web(req, res, { target })` -- prefix stripped, port readiness checked (HTTP GET, 10 retries at 500ms)
- **WebSocket**: `proxy.ws(req, socket, head, { target })` -- prefix stripped, auth via `opai_dev_token` cookie

Port readiness uses HTTP GET (not TCP connect) to avoid a race where the TCP port accepts connections before Theia's HTTP server is ready.

### Authentication

**HTTP requests**: `Authorization: Bearer <JWT>` header, with `opai_dev_token` cookie as fallback for browser page loads.

**WebSocket upgrades**: `opai_dev_token` cookie only (browsers don't send Authorization headers for WebSocket upgrades). Cookie is set client-side on the landing page with `path=/dev/`.

**Token validation**: Dual-path -- JWKS (RS256) first, JWT secret (HS256) fallback. Profile data enriched from Supabase `profiles` table (cached 60s).

**Access control**: Non-admin users must have `'dev'` in `allowed_apps` and `is_active === true`.

## Docker Image

The `opai-theia:latest` image is built from `tools/opai-dev/docker/`:

- **Base**: `node:22-bookworm` (build) / `node:22-bookworm-slim` (runtime)
- **Theia version**: 1.68.2 (all `@theia/*` packages pinned)
- **Runtime deps**: git, curl, build-essential, python3, socat, sudo, openssh-client
- **User**: `developer` (uid 1001, has passwordless sudo)
- **Baked-in settings**: Dark theme, AI enabled, Claude bridge pre-configured
- **Entry**: `entrypoint.sh` -> socat proxy + Theia
- **Internal port**: 3000
- **Key env vars**: `NODE_PATH=/home/theia/node_modules`, `THEIA_DEFAULT_PLUGINS=local-dir:/home/theia/plugins`

### Rebuilding

```bash
cd /workspace/synced/opai/tools/opai-dev

# Standard rebuild (uses Docker layer cache -- fast if only settings/plugins changed)
docker build -t opai-theia:latest -f docker/Dockerfile docker/

# Full rebuild (required when theia-app.json changes -- adds/removes packages)
docker build --no-cache -t opai-theia:latest -f docker/Dockerfile docker/
```

After rebuilding, restart opai-dev so the bridge picks up any code changes:
```bash
systemctl --user restart opai-dev
```

**Existing running containers continue using the old image** until stopped and recreated (users must stop + restart their workspace from the landing page).

### When to Use `--no-cache`

| Change | Cache OK? | Notes |
|--------|-----------|-------|
| `default-settings.json` | Yes | Only rebuilds from COPY step |
| `entrypoint.sh` | Yes | Only rebuilds from COPY step |
| `plugins/opai-ai-defaults/` | Yes | Only rebuilds from COPY step |
| `theia-app.json` (add/remove packages) | **No** | Must `--no-cache` to re-run npm install + theia build |
| `theia-app.json` (add/remove theiaPlugins) | **No** | Must `--no-cache` to re-download plugins |
| `Dockerfile` (change base image or deps) | **No** | Must `--no-cache` |

Full rebuilds take 5-10+ minutes (npm install + theia build + plugin download).

### Version Pinning

All `@theia/*` dependencies are pinned to `1.68.2` in `theia-app.json`. This prevents version skew where transitive dependencies pull in incompatible `@theia/core` versions. The `@theia/git` package was removed because it was discontinued at v1.60.2 and caused a duplicate `@theia/core` bundle.

## Database

### `dev_workspaces` table (Supabase)

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID | Primary key |
| `user_id` | UUID | Owner (FK to auth.users) |
| `container_id` | TEXT | Docker container ID |
| `port` | INT | Host port (9000-9099) |
| `status` | TEXT | `running`, `stopped`, `destroyed` |
| `project_name` | TEXT | Project folder name |
| `project_path` | TEXT | Relative path within Projects/ |
| `last_activity` | TIMESTAMPTZ | Last HTTP/WS activity |
| `created_at` | TIMESTAMPTZ | Creation time |

## Caddy Routes

```
/dev/*    -> handle -> localhost:8085 (path preserved, not stripped)
/dev      -> 301 redirect to /dev/
```

Uses `handle` (preserves path) not `handle_path` (strips prefix). This is important because the Express app routes on `/dev/*` paths and the IDE proxy needs the full `/dev/ide/:id/` prefix to extract the workspace ID.

## Troubleshooting

### AI Chat says "No agent was found"

The `@theia/ai-ide` package is missing or settings are wrong. Verify:
1. `theia-app.json` includes `"@theia/ai-ide": "1.68.2"` in dependencies
2. `default-settings.json` has `"ai-features.chat.defaultAgent": "Universal"`
3. `agentSettings.Universal.languageModelRequirements` maps to `"claude-code"`
4. Container was created AFTER the image was rebuilt (stop + restart workspace)

### AI Chat connects but returns empty responses

The OpenAI endpoint handler had a bug where `req.on('close')` fired when the request body finished, killing the Claude process. Fixed by using `res.on('close')` with `writableFinished` check. If this recurs, check `journalctl --user -u opai-dev -f` for `openai-compat: claude exited code=null`.

### opai-claude says "Cannot find module 'ws'"

The `ws` module lives at `/home/theia/node_modules/ws`. The opai-claude script must set `NODE_PATH=/home/theia/node_modules` before running `node -e`. This is also set as a Dockerfile `ENV` for general use.

### opai-claude returns empty output

The bridge streams tokens, then sends a final `result` with full content. For short responses, there may be no streaming tokens -- only the result. The opai-claude script must check `if (!gotTokens && msg.content)` in the result handler to print content when no tokens were streamed.

### Bridge socket not found in container

1. Check socket exists on host: `ls -la /tmp/opai-claude-bridge.sock`
2. Check bridge is running: `journalctl --user -u opai-dev | grep claude-bridge`
3. Check mount: `docker inspect <container> | grep claude-bridge`
4. The bridge starts automatically with `opai-dev` service via `claudeBridge.start()` in `index.js`

### Container can't reach host TCP ports

UFW blocks Docker bridge network traffic. Do NOT try to use TCP ports -- use Unix sockets instead. The socket is mounted directly into the container, bypassing the network stack entirely.

### Container not loading in browser

1. Check container is running: `docker ps | grep opai-theia`
2. Check direct access: `curl http://127.0.0.1:{port}/`
3. Check proxy logs: `journalctl --user -u opai-dev -f`
4. Check for duplicate `@theia/core`: `docker exec <container> find /home/theia/node_modules -path '*/node_modules/@theia/core/package.json'` -- should return exactly 1 result

### WebSocket not connecting

- Browsers don't send `Authorization` headers for WS upgrades -- auth uses `opai_dev_token` cookie
- Cookie must have `path=/dev/` to be sent for IDE requests
- Check cookie is set: browser DevTools -> Application -> Cookies

### Stale workspace in DB

If a container was manually removed but the DB still shows `running`:
```sql
UPDATE dev_workspaces SET status = 'stopped', port = NULL, container_id = NULL
WHERE id = '<workspace-id>';
```

## Gotchas & Lessons Learned

1. **`@theia/ai-ide` not `@theia/ai-ide-agents`** -- The stable package name is `@theia/ai-ide`. The `-agents` variant only exists as `1.57.0-next.136` (prerelease). This provides Universal, Coder, and Architect agents.

2. **`CLAUDECODE` env var** -- Set by active Claude Code sessions. Must be stripped (`delete env.CLAUDECODE`) when spawning nested `claude -p` processes, or the CLI refuses to start with "cannot be launched inside another Claude Code session".

3. **Template literals in `index.js`** -- The landing page HTML is a massive template literal (line 93-513). Nested backticks (e.g., `` `Bearer ${token}` `` inside client-side JS) will terminate the outer template literal. Use string concatenation (`'Bearer ' + token`) instead.

4. **`req.on('close')` vs `res.on('close')`** -- In Node's HTTP server, `req.on('close')` fires when the request body finishes sending, NOT when the TCP connection closes. Use `res.on('close')` with `res.writableFinished` check for detecting client disconnection.

5. **Docker network gateway** -- The `opai-dev-net` bridge network uses subnet `172.20.0.0/16` (gateway `172.20.0.1`), NOT the default `172.17.0.0/16`. Gateway is auto-discovered at startup via `docker.getNetwork().inspect()`.

6. **`claude -p --output-format stream-json`** -- Requires `--verbose` flag or it exits with code 1. The OpenAI endpoint uses `--output-format text` instead (simpler, no JSON parsing needed).

7. **socat proxy** -- Must use `fork,reuseaddr` flags to handle multiple concurrent connections. Binds to `127.0.0.1` only (container-local).

8. **Settings persistence** -- `/home/developer/.theia/settings.json` is baked into the image, NOT on a mounted volume. It's recreated fresh every time a new container is created. Existing containers keep old settings until destroyed and recreated.

## Dependencies

- **Runtime**: Node.js 20, Docker Engine, Supabase, Claude Code CLI (via nvm)
- **npm deps**: express, http-proxy, cookie, jsonwebtoken, jwks-rsa, @supabase/supabase-js, dotenv, dockerode, ws
- **Docker image**: `opai-theia:latest` (built from `docker/Dockerfile`)
- **System**: socat (in container), nvm (on host for Claude CLI)
- **Auth**: [Auth & Network](auth-network.md) (Supabase JWT + Caddy TLS)
- **Accessed via**: [Portal](portal.md) (Dev IDE tile)
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-dev` service)
- **Research**: [Theia Proxy Architecture](../../Research/theia-multi-tenant-ide/proxy-architecture.md)
