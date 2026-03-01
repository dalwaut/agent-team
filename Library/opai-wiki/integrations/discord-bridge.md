# Discord Bridge
> Last updated: 2026-02-24 | Source: `tools/discord-bridge/`

## Overview

Local Discord bot (discord.js) that bridges Discord messages to the Claude Code CLI. Runs on the local machine with zero API cost via `claude -p`. Supports per-guild data isolation (v4), team bot access restrictions, async job queuing, persona system, workspace AI (Team Hub MCP with multi-workspace mode), email commands, task routing, self-healing log review, notification recovery on restart, and [YouTube transcript processing](youtube-transcriber.md) (auto-detect URL, summarize, reaction menu for Save to Brain / Research / Re-Write / PRD).

## Architecture

```
Discord message → discord.js client → askClaude() → spawn claude -p
               ← bot edits reply    ← parse JSON stdout ← Claude response
```

- **Version**: v4
- **Per-guild isolation**: All state (conversations, sessions, jobs, persona, logs) namespaced under `data/guilds/{guildId}/`
- **Team bot restriction**: Non-admin guilds get ONLY Team Hub MCP tools — no filesystem, Bash, or OPAI workspace access
- **Async queue**: Messages processed non-blocking — bot stays responsive during Claude execution
- **Session reuse**: 30-minute window via `--resume` (session-manager.js)
- **Conversation memory**: Recent messages stored per channel for context (conversation-memory.js)
- **Job tracking**: Active jobs tracked with status command, recovery on restart (job-manager.js)
- **Persona system**: Swappable personalities for bot responses (persona.js)
- **Workspace AI**: Claude CLI with Team Hub MCP tools for workspace-bound channels
- **Per-channel roles**: Each channel can be `admin` or `team-hub` independently (channel-config.js)

## Guild + Channel Isolation Model

### Two-Level Access Control

Access is determined by **guild** (server) AND **channel**:

```
Step 1: Guild check — isAdminGuild(guildId)
  HOME_GUILD_ID in .env → compared against message.guildId
    ├─ guildId === HOME_GUILD_ID  → admin guild
    ├─ guildId === 'opai-home'    → admin (DMs, always trusted)
    └─ anything else              → non-admin guild

Step 2: Channel role check — channel-config.json
  ├─ Explicit config exists → use configured role ("admin" or "team-hub")
  ├─ No config + admin guild → defaults to "admin"
  └─ No config + non-admin guild → defaults to "team-hub"
```

This means the admin guild can have BOTH admin channels (full OPAI access) and team-hub channels (workspace AI only) side by side.

### Channel Roles

| Role | Claude Access | cwd | System Prompt | Tools |
|------|-------------|-----|---------------|-------|
| `admin` | Full OPAI workspace | `OPAI_ROOT` | Full OPAI admin context (paths, tools, orchestrator) | All (Bash, Read, Write, etc.) |
| `team-hub` | Workspace-scoped | `/tmp/opai-guild-{guildId}/` (non-admin) or `OPAI_ROOT` (admin) | Team Hub workspace assistant | MCP teamhub tools only (non-admin) or all (admin) |

### Channel Configuration

Stored per-guild in `data/guilds/{guildId}/channel-config.json`. Managed via `channel-config.js`.

**Discord commands** (admin guild only):

| Command | What It Does |
|---------|-------------|
| `channel list` | Show all configured channels |
| `channel set admin` | Make current channel an admin channel (full OPAI access) |
| `channel set team-hub [workspace]` | Make current channel a Team Hub channel |
| `channel clear` | Remove config (revert to default) |
| `channel` | Show help |

### Access Matrix

| Capability | Admin Channel | Team-Hub Channel | Non-Admin Guild |
|-----------|--------------|-----------------|-----------------|
| `review logs` | Full access | Blocked | Blocked |
| `task:` routing | Full access | Blocked — suggests `hub task` | Blocked |
| Email commands | Full access | Blocked | Blocked |
| `persona` switching | Full access | Blocked | Blocked |
| `channel` config | Full access | Full access | Blocked |
| YouTube reactions | All 4 reactions | All 4 reactions | Save/Research/Re-Write only (`💡` PRD hidden) |
| `hub` commands | Works | Works | Works |
| `status` / `jobs` | Works | Works | Works |
| Normal messages | Full Claude + OPAI access | Workspace AI (MCP tools) | Workspace AI or hub hint |

### Non-Admin Claude Restrictions

When Claude CLI spawns for a non-admin guild:

1. **`--allowedTools mcp__teamhub__*`** — Only Team Hub MCP tools are available (Bash, Read, Write, Edit, Glob, Grep all disabled)
2. **`cwd: /tmp/opai-guild-{guildId}/`** — Sandbox directory, not OPAI workspace root
3. **System prompt reinforcement** — Explicitly tells Claude to only use teamhub tools, no filesystem access

### Per-Guild Data Directories

```
data/guilds/{guildId}/
├── channel-config.json  # Per-channel role configs (admin vs team-hub)
├── conversations.json   # Message history per channel
├── sessions.json        # Claude session IDs (--resume)
├── jobs.json            # Active/completed job tracking
├── persona.json         # Active persona for this guild
└── guild.log            # Guild-specific activity log
```

Managed by `guild-data.js` — `getGuildDataDir()`, `ensureGuildDir()`, `listGuildIds()`.

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main bot logic: message router, Claude invocation, review flow, workspace AI, email/task commands, channel/guild access control |
| `start-bot.sh` | Launcher: loads nvm, strips `CLAUDECODE` env var, enforces single instance via PID lock |
| `.env` | `DISCORD_BOT_TOKEN`, `TRIGGER_PREFIX`, `CLAUDE_TIMEOUT`, `HOME_GUILD_ID`, `OPAI_ROOT` |
| `channel-config.js` | Per-channel role management (admin vs team-hub), persists to guild data dir |
| `guild-data.js` | Per-guild data directory management (`data/guilds/{guildId}/`) |
| `conversation-memory.js` | Per-channel message history for context |
| `session-manager.js` | Claude session reuse (`--resume`), CLI arg building, tool restriction support |
| `job-manager.js` | Active job tracking, restart recovery |
| `logger.js` | Tees console to `data/bot.log`, per-guild logging |
| `persona.js` | Persona switching (response tone/style) |
| `teamhub-mcp.js` | MCP stdio server exposing workspace-scoped Team Hub tools to Claude CLI. Has `input_examples` on 6 tools (-35% cost validated). See [MCP Infrastructure](mcp-infrastructure.md) |
| `data/bot.pid` | PID lockfile for single-instance enforcement |
| `data/bot.log` | Persistent activity log |

## Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `DISCORD_BOT_TOKEN` | Bot token (required) | — |
| `DISCORD_CHANNEL_ID` | Restrict to one channel | (all channels) |
| `TRIGGER_PREFIX` | Message prefix (e.g., `!@`) | (none) |
| `CLAUDE_TIMEOUT` | Max Claude execution time (ms) | `300000` (5 min) |
| `HOME_GUILD_ID` | Admin guild — full access; all others restricted | (none — all guilds get admin) |
| `OPAI_ROOT` | Workspace root for Claude's cwd | `../../` relative |

## API / Interface

### Discord Commands

| Command | Access | What It Does |
|---------|--------|-------------|
| `<message>` | Admin channel: full Claude / Team-hub channel: workspace AI | Normal conversation |
| `review logs` | Admin channels only | Claude analyzes bot.log, proposes code fixes |
| `task: <description>` | Admin channels only | Classify and route via work-companion |
| `check email` | Admin channels only | Trigger email check |
| `email tasks` | Admin channels only | Show pending tasks from emails |
| `email drafts` | Admin channels only | Show pending response drafts |
| `approve <id>` | Admin channels only | Approve and send an email draft |
| `reject <id>` | Admin channels only | Cancel an email draft |
| `persona [name]` | Admin channels only | View or switch bot persona |
| `channel [set/list/clear]` | Admin guild only | Configure channel roles (admin vs team-hub) |
| `hub note/task/idea <text>` | All channels | Create Team Hub items |
| `hub status` | All channels | Show open items |
| `hub search <query>` | All channels | Search workspace items |
| `status` / `jobs` | All channels | Show active Claude jobs |

### YouTube Reaction Menu

When a YouTube URL is detected and summarized, the bot adds emoji reactions as an action menu. Users click a reaction to trigger the corresponding action. See [YouTube Transcriber](youtube-transcriber.md) for full pipeline details.

| Emoji | Action | Endpoint | Admin Only |
|-------|--------|----------|-----------|
| `📝` | Save to Brain | `POST localhost:8101/brain/api/youtube/save` | No |
| `🔬` | Research | `POST localhost:8101/brain/api/youtube/research` | No |
| `✍️` | Re-Write (Content Pack) | `POST localhost:8101/brain/api/youtube/rewrite` | No |
| `💡` | PRD Pipeline | `POST localhost:8093/prd/api/ideas/from-youtube` | Yes |

**Re-Write** generates an original content pack from the video's topics — includes a video script, blog post, and social media posts. The cached transcript, title, author, and summary data are sent to the Brain API which returns a session ID.

Requires `GuildMessageReactions` intent on the client and partial reaction fetching (`reaction.partial` must be resolved before reading emoji).

### Workspace AI Flow

When a channel has a workspace binding (set via Team Hub Discord integration):

1. `resolveChannelWorkspace()` checks the Team Hub API for channel→workspace mapping (cached 5 min)
2. `generateMcpConfig()` creates a temp JSON file with the `teamhub` MCP server config, scoped to bound workspace IDs
3. For non-admin guilds: `--allowedTools mcp__teamhub__*` restricts Claude to only MCP tools; cwd set to sandbox
4. For admin guilds: Claude gets full tool access with OPAI workspace as cwd
5. System prompt tells Claude about available workspaces and how to use Team Hub tools
6. Temp MCP config cleaned up after response

### Review Flow (Self-Healing) — Admin Only

1. User says "review logs" → Claude analyzes `data/bot.log`
2. Claude proposes fixes as JSON: `[{file, search, replace}]`
3. User replies "approve" → fixes applied to files within `tools/discord-bridge/` only
4. Bot writes pending notification, restarts, sends "Update Complete" message

### Startup Recovery

On bot restart (`ClientReady` event), two recovery mechanisms run:

1. **Pending notifications** — If a `data/pending-notification.json` file exists (written before a self-healing restart), the bot sends the notification message to the original channel. Notifications older than 5 minutes are discarded as stale.
2. **Interrupted jobs** — `recoverAllJobs()` scans `data/guilds/*/jobs.json` across all guilds, marks running jobs as interrupted, and sends a formatted message to each affected channel: `"Interrupted: "<query>" (was running for Xm Ys)"` with a prompt to resend. Elapsed time is formatted as `Xm Ys` via `formatElapsed()`.

This ensures no work is silently lost during restarts or crashes.

## How to Use

```bash
# Start via launcher (recommended)
./tools/discord-bridge/start-bot.sh

# Via systemd
systemctl --user start opai-discord-bot
systemctl --user status opai-discord-bot
journalctl --user -u opai-discord-bot -f
```

### Setting Up Channel Roles (Admin Guild)

The admin guild supports mixed channels — some for OPAI admin, others for Team Hub:

1. In your admin channel: `!@channel set admin` — full OPAI access
2. In a team channel: `!@channel set team-hub` — workspace AI only
3. Verify with: `!@channel list`
4. Unconfigured channels default to **admin** mode in the admin guild

### Setting Up a Non-Admin Guild

1. Set `HOME_GUILD_ID=<your-admin-server-id>` in `.env` (must match the guild you use for admin)
2. Invite the bot to the other guild
3. In Team Hub, create a workspace for that guild
4. Use Team Hub Discord integration to bind channels to workspaces
5. Users in that guild can use `hub` commands and workspace AI — but cannot access OPAI internals
6. All channels in non-admin guilds default to **team-hub** mode

**Important**: `HOME_GUILD_ID` must be the guild ID of your admin Discord server (`1470538456353734780`), not a team guild.

### Linux Gotchas

1. **Claude CLI path**: Installed via nvm, not in `/bin/sh` PATH — `start-bot.sh` sources nvm
2. **`CLAUDECODE` env var**: Must be unset or Claude CLI refuses to start — `start-bot.sh` strips it
3. **Single instance**: PID lockfile + message dedup guard prevent duplicate responses
4. **Old service**: `opai-discord.service` is DISABLED — only use `opai-discord-bot`

## Session Manager Details

`session-manager.js` builds CLI args via `getClaudeArgs(guildId, channelId, opts)`:

| Option | Type | Effect |
|--------|------|--------|
| `mcpConfigPath` | `string` | Adds `--mcp-config <path>` for Team Hub MCP |
| `systemPrompt` | `string` | Adds `--system-prompt <text>` |
| `restrictTools` | `boolean` | Adds `--allowedTools mcp__teamhub__*` — disables all built-in tools |

Session reuse: stores session IDs per guild+channel in `data/guilds/{guildId}/sessions.json`, expires after 30 min idle.

## TeamHub MCP Multi-Workspace Mode

`teamhub-mcp.js` is a JSON-RPC 2.0 stdio server (MCP transport) that exposes workspace-scoped Team Hub tools to the Claude CLI. It supports binding to one or more workspaces.

### Usage

```bash
# Single workspace
node teamhub-mcp.js --workspace <workspace-uuid>

# Multiple workspaces
node teamhub-mcp.js --workspace <id1> --workspace <id2>
```

### Single vs Multi-Workspace

| Mode | Condition | Extra Tool | `workspace_id` Param |
|------|-----------|-----------|---------------------|
| Single | One `--workspace` flag | None | Not needed (auto-resolved) |
| Multi (`MULTI_WORKSPACE`) | Two or more `--workspace` flags | `list_workspaces` | Added to all tool schemas; optional (defaults to first workspace) |

In multi-workspace mode, every tool schema gains a `workspace_id` property. Claude should call `list_workspaces` first to discover available workspace IDs and names.

### Tool Catalog (16 tools)

`workspace_summary`, `list_spaces`, `list_folders`, `list_lists`, `list_items`, `search_items`, `get_item`, `create_item`, `update_item`, `create_folder`, `create_list`, `create_space`, `add_comment`, `assign_item`, `list_members` — plus `list_workspaces` (multi-workspace only).

### Cost Optimization

Six high-traffic tools include `input_examples` in their schemas (validated at -35% prompt token cost): `list_items`, `search_items`, `create_item`, `update_item`, `add_comment`, `assign_item`. See [MCP Infrastructure](mcp-infrastructure.md) for methodology.

### Internal API

All requests go to `http://127.0.0.1:8089/api/internal/*` (Team Hub internal API). The `workspace_id` query param is injected on every request. No external dependencies — uses Node built-in `http` module only.

## Dependencies

- **Runtime**: Node.js, discord.js, dotenv
- **CLI**: `claude` (via nvm path)
- **Integrates with**: [Team Hub](team-hub.md) (workspace AI, hub commands, MCP server), [Brain](brain.md) (YouTube save/research/re-write reactions), [Email Agent](email-agent.md) (check/drafts/approve/reject commands), [PRD Pipeline](prd-pipeline.md) (YouTube PRD idea creation), [YouTube Transcriber](youtube-transcriber.md) (URL detection, transcript, summary), work-companion (task routing), [MCP Infrastructure](mcp-infrastructure.md) (master catalog, tool optimization)
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-discord-bot` service)
- **Monitored by**: [Orchestrator](orchestrator.md) (health checks, auto-restart)
