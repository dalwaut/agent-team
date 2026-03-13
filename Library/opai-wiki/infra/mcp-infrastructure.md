# MCP Infrastructure & Profile System

> Last updated: 2026-03-10 | Catalog: `config/mcp-all.json` | Profiles: `config/mcp-profiles/`

## Overview

MCP (Model Context Protocol) is the standard for connecting Claude to external tool servers. OPAI uses MCP servers to give Claude access to Team Hub, WordPress, YouTube transcripts, Playwright browser automation, and more — both in interactive Claude Code sessions and programmatic `claude -p` invocations from services.

This doc covers the **profile-based launch system**, **master catalog**, **subagent workers**, **tool optimization**, and the **shared Claude wrapper**.

---

## Profile System

### Why Profiles?

MCP tools consume context tokens every session (~4,300 tokens for Playwright alone, ~650 for YouTube). Loading unused MCPs wastes context budget. The profile system lets you launch Claude Code with exactly the MCPs you need.

### How It Works

```
claude --mcp-config config/mcp-profiles/<profile>.json
```

This flag loads MCP servers from the specified JSON file instead of (or in addition to) the root `.mcp.json`. Each profile is a standalone `mcpServers` config.

### Available Profiles

| Profile | Config File | MCPs Loaded | Est. Tokens | Launch Script |
|---------|-------------|-------------|-------------|---------------|
| **Slim** | `config/mcp-profiles/slim.json` | YouTube, Instagram | ~1,300 | `scripts/claude-slim.sh` |
| **Browser** | `config/mcp-profiles/browser.json` | YouTube, Instagram, Playwright | ~5,600 | `scripts/claude-browser.sh` |
| **WordPress** | `config/mcp-profiles/wordpress.json` | YouTube, Instagram, Playwright, WP-VEC | ~9,200 | `scripts/claude-wordpress.sh` |
| **Full** | `config/mcp-profiles/full.json` | YouTube, Instagram, Playwright, ClickUp, GoDaddy | ~8,000 | `scripts/claude-full.sh` |
| **Default** | `.mcp.json` (root) | YouTube, Instagram, Playwright | ~5,600 | `claude` (no script) |

### Launch Scripts

All in `scripts/`:

```bash
# Slim — minimal context, best for pure coding sessions
./scripts/claude-slim.sh

# Browser — web testing with Playwright (same as default .mcp.json)
./scripts/claude-browser.sh

# WordPress — content management + browser testing
./scripts/claude-wordpress.sh

# Full — all local MCPs (ClickUp, GoDaddy added back)
./scripts/claude-full.sh

# Pass-through args work:
./scripts/claude-slim.sh --resume
./scripts/claude-full.sh -p "some prompt"
```

### Desktop Launcher

`~/Desktop/claude-slim.desktop` — launches Slim profile in a terminal window. Double-click from desktop or file manager.

### Default `.mcp.json`

The root `.mcp.json` loads **YouTube + Instagram + Supabase Local + Playwright** for standard interactive sessions. ClickUp and GoDaddy were removed from the default (rarely used, available via the `full` profile).

```json
{
  "mcpServers": {
    "youtube-transcript": { "type": "stdio", "command": "python3", "args": ["..."] },
    "instagram-scraper": { "type": "stdio", "command": "python3", "args": ["..."] },
    "supabase-local": { "type": "stdio", "command": "python3", "args": ["mcps/supabase-local/server.py"] },
    "playwright": { "type": "stdio", "command": "npx", "args": ["@playwright/mcp@latest", ...] }
  }
}
```

### Remote vs Local MCPs

| Type | Controllable via `--mcp-config`? | How to Manage |
|------|----------------------------------|---------------|
| **Local** (YouTube, Instagram, Supabase Local, Playwright, ClickUp, GoDaddy, WP-VEC, TeamHub, Google Workspace) | Yes | Profile JSONs control which load |
| **Remote/Anthropic-hosted** (Gmail, Netlify, n8n) | No | Always load at account level. Disconnect from Claude account settings to remove |

The Anthropic-hosted Supabase MCP was **dropped in v3.5** — it was OAuth-locked to the WautersEdge org and could not see the OPAI project. Replaced by `supabase-local` (see below).

The `--strict-mcp-config` flag blocks remote MCPs too, but also removes Gmail access — usually not desired.

### Token Savings

| Configuration | Local MCP Tokens | Savings vs Full |
|---------------|-----------------|-----------------|
| Full (all local) | ~8,000 | Baseline |
| Default (YouTube + Instagram + Playwright) | ~5,600 | ~2,400 saved |
| Slim (YouTube + Instagram) | ~1,300 | ~6,700 saved |

Remote MCPs add ~3,680 tokens regardless (Gmail ~1,080, Netlify ~1,950, n8n ~650). Previously included Anthropic-hosted Supabase (~5,400 tokens) — dropped in favor of `supabase-local`.

---

## Subagent Workers (`.claude/agents/`)

Specialized subagent definitions for the Task tool. These don't truly isolate MCP access (remote MCPs are always available), but they provide organizational focus — each worker has domain-specific instructions and preferred tools.

### Available Workers

| Agent | File | Specialty | Key Tools |
|-------|------|-----------|-----------|
| `supabase-worker` | `.claude/agents/supabase-worker.md` | Database migrations, queries, RLS policies, edge functions | `mcp__claude_ai_Supabase__*`, Bash (`supabase-sql.sh`) |
| `browser-worker` | `.claude/agents/browser-worker.md` | Web testing, browser automation | `mcp__playwright__*` |

### Invoking Workers

Workers are invoked via the Task tool in Claude Code conversations:

```
Task tool → subagent_type: "supabase-worker"
Task tool → subagent_type: "browser-worker"
```

Each worker carries its own system prompt with domain knowledge (project IDs, gotchas, best practices) so the main conversation stays focused.

### Worker Design Guidelines

- **Frontmatter**: YAML block with `name`, `description`, `tools`
- **Domain context**: Include project IDs, connection details, common gotchas
- **Tool preferences**: List preferred tools in frontmatter (organizational, not enforced)
- **Keep focused**: Each worker handles one domain. Don't create "does everything" workers.

---

## Supabase Local MCP (`mcps/supabase-local/`)

### Why Local?

The Anthropic-hosted Supabase MCP uses OAuth and is locked to the WautersEdge org. It cannot see the OPAI project (`idorgloobxkmlnwnxbej`), which lives in a different Supabase account. The local MCP solves this by loading PATs from the vault at runtime, supporting **any** Supabase project.

### How It Works

```
tool call (project="bb2") → resolve alias via projects.json
  → get vault_pat_key + project_ref
  → _load_vault() → store.get_secret(vault_pat_key)
  → cache PAT in memory (1hr TTL)
  → POST https://api.supabase.com/v1/projects/{ref}/database/query
```

PATs are per-Supabase-account (not per-project), so multiple projects in the same account share one PAT.

### Tools (8)

| Tool | Description |
|------|-------------|
| `supabase_execute_sql` | Run any SQL (SELECT, INSERT, UPDATE, DELETE, DDL) |
| `supabase_list_tables` | List tables in a schema with estimated row counts |
| `supabase_describe_table` | Column details, types, constraints, primary keys |
| `supabase_apply_migration` | Execute DDL + log migration name |
| `supabase_list_projects` | Show all configured aliases (reads local config) |
| `supabase_get_project_info` | Project status/health from Management API |
| `supabase_list_migrations` | Applied migrations with timestamps |
| `supabase_get_logs` | Recent logs by service type (postgres, auth, storage, etc.) |

Every tool (except `list_projects`) accepts an optional `project` param — empty string defaults to the default project from `projects.json`.

### Project Configuration (`mcps/supabase-local/projects.json`)

```json
{
  "default_project": "opai",
  "projects": {
    "opai":          { "project_ref": "idorgloobxkmlnwnxbej", "vault_pat_key": "supabasemaster/PAT" },
    "bb2":           { "project_ref": "aggxspqzerfimqzkjgct", "vault_pat_key": "supabase-wautersedge/PAT" },
    "apps-internal": { "project_ref": "ehrzhdzmbbuizsobmddq", "vault_pat_key": "supabase-wautersedge/PAT" }
  }
}
```

To add a new project: add an entry to `projects.json` with its `project_ref` and the vault key holding the account's PAT. If the PAT isn't in the vault yet, store it:

```bash
python3 tools/opai-vault/scripts/import-env.py --credential <vault-key-name> --value 'sbp_...'
```

### Patterns Reused

| Pattern | Source |
|---------|--------|
| FastMCP server structure | `mcps/youtube-transcript/server.py` |
| `_load_vault()` with sys.modules swap | `tools/shared/google_auth.py` |
| `get_secret()` API | `tools/opai-vault/store.py` |
| Management API endpoint + PAT auth | `scripts/supabase-sql.sh` |

### vs Anthropic-Hosted Supabase MCP

The Anthropic-hosted MCP had 28 tools. Our local MCP covers the 8 we actually use. The 20 dropped tools fall into categories we don't need:

- **Edge functions** (list/get/deploy) — not part of OPAI's stack
- **Preview branches** (create/list/delete/merge/reset/rebase) — not used
- **Org management** (list_organizations, get_organization) — single org, no need
- **Billing** (get_cost, confirm_cost) — not programmatic
- **Project lifecycle** (create_project, pause_project, restore_project) — rare, use dashboard
- **Dev tooling** (generate_typescript_types, list_extensions, get_advisors, search_docs) — nice-to-have, can add later

If any dropped tool is needed later, it's trivial to add — the Management API pattern is identical for all endpoints.

---

## Master MCP Catalog (`config/mcp-all.json`)

Central reference listing all MCP servers available across OPAI, with profile definitions that map to the `config/mcp-profiles/` JSON files.

### Servers

| Server | Type | Tools | Description |
|--------|------|-------|-------------|
| `youtube-transcript` | stdio (local) | 3 | YouTube transcript extraction, metadata, search |
| `instagram-scraper` | stdio (local) | 4 | Instagram reel transcripts, metadata, frame extraction, search |
| `playwright` | stdio (npx) | 20+ | Headless browser automation via accessibility tree |
| `teamhub` | stdio (local) | 15 | Team Hub workspace CRUD, search, collaboration |
| `clickup` | stdio (local) | 9 | ClickUp project management |
| `godaddy` | http | 2 | Domain search + availability |
| `hostinger` | stdio (npm) | 10 | Hostinger hosting API (on-demand only) |
| `wordpress-vec` | stdio (local) | 16 | WordPress + WooCommerce REST API |
| `google-workspace` | stdio (local) | 7 | Google Drive + Gmail for agent@paradisewebfl.com |
| `boutabyte` | stdio (local) | 2 | BoutaByte web app publishing |
| `supabase-local` | stdio (local) | 8 | Vault-backed multi-project Supabase (SQL, tables, migrations, logs) |
| `pencil` | stdio (local-app) | 7 | Agent-driven visual design (Figma-like), UI kit layouts, design iteration. On-demand — auto-MCP when desktop app running |
| `react-grab` | stdio (npx) | 0 | AI context selection — hover React element + Ctrl+C for component source. On-demand |
| `netlify` | hosted (Anthropic) | 8 | Netlify deployment + project management |
| `n8n` | hosted (Anthropic) | 3 | n8n workflow automation (internal only) |

**Total: ~113 tools across 15 servers.** (Dropped Anthropic-hosted Supabase MCP — 25 tools replaced by 8 local tools. Added Pencil.dev — 7 design tools.)

### Internal Profiles (in `mcp-all.json`)

Beyond the Claude Code launch profiles, `mcp-all.json` defines profiles for internal services:

| Profile | Servers | Use Case |
|---------|---------|----------|
| `discord-teamhub` | teamhub | Discord bot guild channels |
| `helm` | wordpress-vec, netlify, supabase-local, teamhub, playwright, google-workspace | HELM business runner |
| `workspace` | youtube-transcript, instagram-scraper, playwright, google-workspace | Google Workspace agent collaboration |
| `benchmark` | teamhub | Performance testing scenarios |

### How Services Consume the Catalog

The catalog is a **reference document**, not a runtime config file. Services build their own MCP configs:

1. **Claude Code profiles** (`config/mcp-profiles/*.json`): Pre-built JSON files loaded via `--mcp-config`
2. **Discord bot** (`tools/discord-bridge/index.js`): Dynamically generates temp JSON per guild via `generateMcpConfig()`, cleans up after response
3. **Benchmark harness** (`tools/opai-benchmark/harness.py`): Scenario JSON embeds `mcp_config` inline, harness writes temp files
4. **Root `.mcp.json`**: Default for bare `claude` command — YouTube + Playwright

---

## Tool Optimization

### input_examples (Tier 1A — Shipped)

`input_examples` is a field on MCP tool definitions that provides few-shot examples for parameter handling. It sits as a **sibling of `inputSchema`** (not inside it) at the tool definition level.

**Measured impact: -35% cost on Team Hub MCP scenarios** (benchmark validated 2026-02-24).

| Scenario | Cost Reduction |
|----------|---------------|
| Search + update | -57% |
| Create task | -35% |
| Workspace overview | -16% |

**Implementation**: 6 tools in `tools/discord-bridge/teamhub-mcp.js` have `input_examples` arrays showing parameter variety (full spec, partial, minimal). This teaches Claude correct field names, valid enum values, and when optional fields are useful.

```javascript
// Example: create_item tool definition
{
  name: 'create_item',
  description: '...',
  inputSchema: { type: 'object', properties: {...}, required: ['title'] },
  input_examples: [
    {title: 'Fix login page 500 error', type: 'bug', priority: 'critical', list_name: 'Development'},
    {title: 'Add dark mode toggle', type: 'task', priority: 'medium'},
    {title: 'Evaluate Stripe Connect', type: 'idea', priority: 'low'},
  ],
},
```

### Tool Search (Tier 1C — Auto-Active)

Claude Code automatically defers tool schema loading when MCP tools exceed ~10% of the context window (`ENABLE_TOOL_SEARCH=auto`, the default). Tools are discovered on-demand instead of preloaded.

**When it matters**: `full` profile (34+ local tools) plus remote MCPs (37 tools) = 70+ total → tool search activates. `slim` profile (3 local + 37 remote = 40 tools) stays closer to threshold.

**Not recommended**: `ENABLE_EXPERIMENTAL_MCP_CLI=true` — an older env var that achieves similar deferred loading but has a known race condition bug on session resume ([#14009](https://github.com/anthropics/claude-code/issues/14009)). Use `ENABLE_TOOL_SEARCH=auto` instead.

---

## Shared Claude Wrapper (`tools/shared/claude_api.py`)

Unified interface for all programmatic Claude invocations across OPAI services. Dual-mode:

- **CLI mode** (default, no API key): Spawns `claude -p` subprocess, uses Claude subscription
- **API mode** (when `ANTHROPIC_API_KEY` is set): Uses Anthropic SDK directly, enables PTC

**Currently all OPAI services run in CLI mode.** API mode + PTC are infrastructure-ready but dormant (no API key provisioned).

### Functions

| Function | Purpose | Mode |
|----------|---------|------|
| `call_claude()` | Standard prompt → response | CLI or API (auto-selects) |
| `call_claude_ptc()` | Programmatic Tool Calling with code_execution sandbox | API only (CLI fallback) |
| `_extract_json()` | Parse JSON from Claude responses (handles markdown fences, regex fallback) | Utility |

### Interface

```python
from claude_api import call_claude

result = await call_claude(
    "Evaluate this idea",
    system="You are PRDgent...",
    model="sonnet",           # short names or full model IDs
    expect_json=True,         # auto-parses JSON from response
    timeout=300,
    api_key=None,             # None = use env var or CLI fallback
    cli_args=["--max-turns", "3"],  # extra CLI flags (CLI mode only)
)

# Returns:
# {
#   "content": "...",         # Raw text
#   "parsed": {...},          # JSON-parsed if expect_json
#   "tokens_used": 0,        # 0 for CLI (subscription)
#   "cost_usd": 0.0,         # 0 for CLI
#   "model": "cli:sonnet",
#   "duration_ms": 4200,
#   "mode": "cli",           # "cli" | "api" | "ptc"
# }
```

### Services Using the Shared Wrapper

| Service | File | Notes |
|---------|------|-------|
| PRD Pipeline | `tools/opai-prd/routes_api.py` | Eval + full PRD generation, CLI mode |
| DAM Bot | `tools/opai-dam/core/ai.py` | Goal decomposition + plan execution, CLI mode |

### PTC (Programmatic Tool Calling) — Dormant

PTC lets Claude write Python code that orchestrates tool calls in a sandbox. Tool results stay in the sandbox (never enter context), and only `print()` output reaches Claude — reducing tokens by 37-98% on batch workloads.

**Status**: Requires Anthropic Messages API (API key). No CLI support exists. Open feature request: [#12836](https://github.com/anthropics/claude-code/issues/12836). Infrastructure is built and will activate automatically if an API key is ever set.

---

## Benchmark System (`tools/opai-benchmark/`)

Measures Claude CLI invocation metrics across scenarios to validate optimization changes.

### Key Files

| File | Purpose |
|------|---------|
| `runner.py` | TUI benchmark runner — runs scenarios, displays scoreboard with `~Tokens` column |
| `harness.py` | Claude CLI metric capture — invokes `claude -p`, extracts cost/tokens/time |
| `report.py` | Before/after comparison reports with delta percentages |
| `scenarios/*.json` | 8 test scenarios (5 general + 3 Team Hub MCP) |
| `configs/*.json` | Named config profiles for A/B testing |
| `results/*.json` | Timestamped result files |

### Running Benchmarks

```bash
# Run all scenarios (1 run each, quiet mode)
python3 tools/opai-benchmark/runner.py --config baseline --runs 1 --quiet

# Run only teamhub scenarios
python3 tools/opai-benchmark/runner.py --scenario "teamhub-*" --config with-examples

# Compare two runs
python3 tools/opai-benchmark/report.py --compare no-examples with-tool-examples

# Show latest results
python3 tools/opai-benchmark/report.py --latest
```

### Token Estimation

CLI mode doesn't expose raw token counts. The harness estimates tokens from cost using blended rates:

| Model | Blended Rate (per 1M tokens) |
|-------|------------------------------|
| Sonnet | $6.00 |
| Haiku | $1.60 |
| Opus | $30.00 |

Estimated values are displayed with a `~` prefix in reports (e.g., `~2,150`).

---

## Key Files

| File | Purpose |
|------|---------|
| `.mcp.json` | Root default — YouTube + Instagram + Supabase Local + Playwright |
| `config/mcp-all.json` | Master catalog — all 14 servers, profiles, tool counts |
| `config/mcp-profiles/slim.json` | Profile: YouTube only |
| `config/mcp-profiles/browser.json` | Profile: YouTube + Playwright |
| `config/mcp-profiles/full.json` | Profile: all local MCPs |
| `config/mcp-profiles/wordpress.json` | Profile: YouTube + Playwright + WP-VEC |
| `scripts/claude-slim.sh` | Launch: Slim profile |
| `scripts/claude-browser.sh` | Launch: Browser profile |
| `scripts/claude-full.sh` | Launch: Full profile |
| `scripts/claude-wordpress.sh` | Launch: WordPress profile |
| `~/Desktop/claude-slim.desktop` | Desktop shortcut: Slim profile |
| `.claude/agents/supabase-worker.md` | Subagent: Supabase specialist |
| `.claude/agents/browser-worker.md` | Subagent: Playwright specialist |
| `tools/shared/claude_api.py` | Shared Claude wrapper (CLI/API dual-mode) |
| `mcps/supabase-local/server.py` | Supabase Local MCP — vault-backed multi-project |
| `mcps/supabase-local/projects.json` | Project aliases → refs + vault PAT keys |
| `tools/opai-benchmark/` | Benchmark harness + scenarios |

---

## Key Architecture Decisions

1. **No API key for internal use** — OPAI runs on the Claude subscription. PTC and API-only features are deferred.
2. **Profile-based launches** — `--mcp-config` flag with standalone JSON files, not manual `.mcp.json` swapping.
3. **Remote MCPs are account-level** — Can't isolate per-session. Manage via Claude account settings.
4. **Subagent workers are organizational** — `.claude/agents/*.md` provide domain focus but don't enforce MCP isolation.
5. **Default is moderate** — Root `.mcp.json` loads YouTube + Playwright (a middle ground). Slim and Full are opt-in.
6. **Catalog is reference, not runtime** — Services build their own MCP configs dynamically.
7. **Tool search over experimental flags** — `ENABLE_TOOL_SEARCH=auto` (stable, default) preferred over `ENABLE_EXPERIMENTAL_MCP_CLI` (buggy).
8. **input_examples on all high-use MCP tools** — Validated -35% cost improvement. Apply this pattern to any new MCP server.
9. **Local Supabase over Anthropic-hosted** — The hosted MCP is OAuth-locked to one org. Our local MCP uses vault-backed PATs and can hit any project in any Supabase account. Dropped 25 hosted tools, replaced with 8 focused local tools we actually use.

---

## Cross-References

- [Discord Bridge](../integrations/discord-bridge.md) — Dynamic MCP config generation, Team Hub MCP server
- [Team Hub](../tools/team-hub.md) — Workspace data exposed via MCP
- [PRD Pipeline](../tools/prd-pipeline.md) — Uses shared Claude wrapper
- [DAM Bot](../tools/dam-bot.md) — Uses shared Claude wrapper
- [Agent Framework](../agents/agent-framework.md) — Token optimization, model routing
- [Services & systemd](../core/services-systemd.md) — Service management for MCP-dependent tools
- [Browser Automation](browser-automation.md) — Playwright MCP server usage
- [Vault](vault.md) — Vault wrapper for MCP credential injection
