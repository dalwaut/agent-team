# OpenClaw Vault Broker & Container Runtime

> **Port**: 8106 | **Path**: `/oc/` | **Dir**: `tools/open-claw/`
> **Status**: Live (broker + runtime + LLM proxy + ClawHub + NAS workspaces)
> **Related**: [Vault](vault.md), [OpenClaw Techniques](openclaw.md), `Research/open-claw-integration-plan.md`
> **Design Doc**: `notes/Improvements/V2/openclaw-nas-architecture.md` (full diagrams + component map)

## Purpose

The OC Vault Broker is the **only** code path through which OpenClaw containers receive credentials. It sits between OC containers and the OPAI Vault, enforcing an explicit access manifest: containers only get credentials that an admin has specifically granted.

The Container Runtime handles the full Docker lifecycle: provision, start, stop, restart, destroy.

OC containers never see the vault URL, never know it exists, and never call it directly.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Admin (Portal / CLI)                                     │
│  Grant/revoke credentials via /oc/api/instances/{slug}/   │
│  Provision/start/stop via /oc/api/instances/{slug}/...    │
└────────────────────┬─────────────────────────────────────┘
                     │ authenticated API calls
                     ▼
┌──────────────────────────────────────────────────────────┐
│  OC Vault Broker (FastAPI, port 8106, localhost-only)     │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ manifest.py │  │ vault_bridge │  │ runtime.py     │  │
│  │ Supabase    │  │ Vault fetch  │  │ Docker lifecycle│  │
│  │ CRUD        │  │ (scoped)     │  │ + port alloc   │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                   │            │
│  Reads manifest    Fetches only       docker-compose      │
│  from Supabase     granted keys       up/down/rm          │
│         │                │                   │            │
│         ▼                ▼                   ▼            │
│  oc_access_manifest     Vault API      Docker Engine      │
│  (whitelist table)      (localhost:8105) (opai-claw net)  │
└──────────────────────────────────────────────────────────┘
                     │
                     │ writes .env to tmpfs
                     ▼
┌──────────────────────────────────────────────────────────┐
│  Docker Container (clawbot-{slug})                        │
│  Image: opai/clawbot:latest (Node.js Alpine)              │
│  Receives: env_file from tmpfs (only granted credentials) │
│  Port: 9001-9099 range (localhost-only, Caddy proxies)    │
│  Security: read-only rootfs, no caps, 512MB RAM, 0.5 CPU │
└──────────────────────────────────────────────────────────┘
```

## Database Tables (Migration 037)

### `oc_instances`
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| slug | TEXT UNIQUE | Container name suffix, e.g. "alpha-01" |
| display_name | TEXT | Human-readable name |
| owner_id | UUID FK profiles | Who owns this instance |
| status | TEXT | provisioning/running/stopped/error/archived |
| tier | TEXT | internal/starter/pro/enterprise |
| autonomy_level | SMALLINT 0-10 | How autonomous (0=none, 10=full) |
| config | JSONB | Personality, model prefs, limits |

### `oc_access_manifest`
The core safety table. Each row = one credential grant for one instance.

| Column | Type | Description |
|--------|------|-------------|
| instance_id | UUID FK | Which instance |
| vault_key | TEXT | Exact key name in vault |
| vault_section | TEXT | shared/services/credentials |
| vault_service | TEXT | If section=services, which service |
| scope | TEXT | read (API) or inject (env var at start) |
| granted_by | UUID FK | Who approved this grant |
| reason | TEXT | Why (e.g., "Phase 2: Discord integration") |
| expires_at | TIMESTAMPTZ | Optional TTL |
| revoked_at | TIMESTAMPTZ | Soft-delete (null = active) |

### `oc_credential_log`
Audit trail for all credential operations.

| Column | Type | Description |
|--------|------|-------------|
| instance_slug | TEXT | Which instance |
| action | TEXT | inject/fetch/grant/revoke/deny/expire |
| vault_keys | TEXT[] | Which keys were involved |
| success | BOOLEAN | Did it work |
| actor_id | UUID FK | Who triggered (null = system/service-role) |

## API Endpoints

All require admin auth (Supabase JWT or service key). Localhost-only middleware.

### Instance Management
| Method | Path | Description |
|--------|------|-------------|
| GET | `/oc/api/instances` | List all instances |
| GET | `/oc/api/instances/{slug}` | Get instance details |
| POST | `/oc/api/instances` | Register new instance |
| PATCH | `/oc/api/instances/{slug}/status` | Update status |
| DELETE | `/oc/api/instances/{slug}` | Destroy (stop + clean dirs + release port + archive) |

### Credential Manifest (Grant/Revoke)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/oc/api/instances/{slug}/credentials` | List grants |
| POST | `/oc/api/instances/{slug}/credentials` | Grant a credential |
| DELETE | `/oc/api/instances/{slug}/credentials` | Revoke a credential |
| POST | `/oc/api/instances/{slug}/kill-switch` | Revoke ALL + set stopped |

### Container Runtime (Lifecycle)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/oc/api/instances/{slug}/provision` | Full provision: port + dirs + compose + creds + start |
| POST | `/oc/api/instances/{slug}/start` | Start stopped container (re-injects fresh creds) |
| POST | `/oc/api/instances/{slug}/stop` | Stop container gracefully |
| POST | `/oc/api/instances/{slug}/restart` | Stop + fresh creds + start |
| GET | `/oc/api/instances/{slug}/runtime` | Detailed status (Docker health, CPU, mem, PIDs) |
| GET | `/oc/api/instances/{slug}/logs?lines=50` | Container logs |
| GET | `/oc/api/runtime/overview` | All instances status + port map |

### Credential Injection
| Method | Path | Description |
|--------|------|-------------|
| GET | `/oc/api/instances/{slug}/inject?format=env` | Get credentials for container start |

### Audit & Status
| Method | Path | Description |
|--------|------|-------------|
| GET | `/oc/api/audit` | View credential access log |
| GET | `/oc/api/vault-status` | Check vault connection |

## Security Properties

| Property | How |
|----------|-----|
| Container isolation | Docker: read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, `pids_limit: 100` |
| Resource limits | 512MB RAM (no swap), 0.5 CPU, 100MB /tmp, 50MB /app/tmp |
| Network isolation | `opai-claw` bridge network, localhost-only port binding, DNS: 1.1.1.1 + 8.8.8.8 |
| Credential scoping | Only explicitly granted keys are fetchable (manifest whitelist) |
| No vault exposure | OC never sees vault URL, API, or auth tokens |
| tmpfs injection | Credentials written to RAM-only filesystem, never persistent disk |
| Kill switch | One API call revokes all credentials + stops container |
| Audit trail | Every grant/revoke/inject logged with actor, timestamp, keys |
| Validation | Vault key must exist before it can be granted (prevents typos) |
| Limits | Max 25 credentials per instance (configurable) |
| TTL | Grants can have expiry dates — auto-expire without admin action |
| Progressive access | Start with 0 credentials, expand over time as trust builds |

## Container Lifecycle Flow

```
1. POST /oc/api/instances          → Creates DB record (status=provisioning)
2. POST .../credentials            → Grant specific vault keys (one at a time)
3. POST .../provision              → Port alloc → dirs → compose → inject → start → health
4. Container runs with only granted credentials
5. POST .../stop                   → docker-compose down
6. POST .../start                  → Re-inject fresh creds → docker-compose up
7. POST .../kill-switch            → Revoke all creds + set stopped
8. DELETE /oc/api/instances/{slug} → Stop + rm container + delete dirs + release port + archive
```

## ClawBot Image (Full Agent Runtime)

- **Image**: `opai/clawbot:latest` (Node.js 20 Alpine, ~53MB memory footprint)
- **Build**: `docker build -t opai/clawbot:latest tools/open-claw/images/clawbot/`
- **Exposed**: Port 3000 (Express server)
- **User**: `clawbot` (non-root)
- **Config**: Reads `/app/config/instance.json` on startup (mounted from instance dir)

### ClawBot Capabilities (Felix Techniques)

Each container is a full autonomous agent with:

- **3-Layer Memory** (`lib/memory.js`): Knowledge Graph (entities + relationships), Daily Notes (chronological), Tacit Knowledge (learned patterns with confidence scores). Persists to `/app/workspace/memory/` (NAS-backed in NAS mode).
- **Knowledge Base** (`lib/knowledge.js`): Indexes `/app/knowledge/` (read-only mount), TF-based search with title/filename boost, supports .txt/.md/.json/.csv.
- **RALPH Loops** (`lib/ralph.js`): Read-Act-Log-Plan-Heal multi-step task execution. Tasks stored as JSON in `/app/workspace/ralph/`, survive container restarts, max 3 retries per step.
- **Heartbeat** (`lib/heartbeat.js`): Proactive check-in on configurable interval (default 30 min). Scans memory for pending items (follow ups, reminders, deadlines).
- **LLM via Broker Proxy** (`lib/llm.js`): Calls broker `POST /oc/api/llm/chat` with callback token auth. Never calls Anthropic API directly (uses Claude CLI on host).

### ClawBot Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/message` | POST | Main conversation — memory context + KB search + LLM call |
| `/health` | GET | Docker healthcheck + basic stats |
| `/status` | GET | Detailed instance info + memory + knowledge stats |
| `/ready` | GET | 503 during init, 200 when ready |
| `/memory` | GET | Memory layer stats + recent notes + insights |
| `/memory/note` | POST | Add daily note externally |
| `/memory/entity` | POST | Add knowledge graph entity |
| `/memory/insight` | POST | Add tacit knowledge insight |
| `/knowledge` | GET | Knowledge base file list + stats |
| `/knowledge/search?q=` | GET | Search the knowledge base |
| `/heartbeat` | GET | Heartbeat status |
| `/tasks` | GET | List RALPH tasks |
| `/tasks/:id` | GET | Get RALPH task detail |

## LLM Proxy

Containers call `POST /oc/api/llm/chat` on the broker, which runs `claude -p` as a subprocess on the host (no API key needed — uses Claude subscription).

- **Auth**: Per-instance callback token (`oc_<slug>_<32hex>`, SHA-256 hash in DB)
- **Rate limits per tier**: internal (30 rpm, 300 rph, 500k tokens/day), starter (10/100/100k), pro (20/200/300k)
- **Concurrency**: Semaphore limits concurrent CLI calls (default 3, env `OC_LLM_MAX_CONCURRENT`)
- **Timeout**: 120 seconds per request (env `OC_LLM_TIMEOUT`)
- **Files**: `broker/routes_llm.py` (proxy endpoint), `broker/container_auth.py` (token auth)

## ClawHub Marketplace

Skill catalog for OC instances. Syncs from API/GitHub/local seed, stores in Supabase.

- **Tables**: `ch_skills` (catalog), `ch_installations` (install records)
- **Compatibility**: `full` (prompt/knowledge only), `partial` (simple tools), `oc_only` (runtime deps)
- **Dual install target**: OC instances (file copy to knowledge/prompts dirs) or Claude Code (commands + knowledge library)
- **File**: `broker/clawhub.py`
- **Background sync**: Runs every 24h in broker lifespan

| Method | Path | Description |
|--------|------|-------------|
| GET | `/oc/api/hub/catalog` | List skills (filter by category, search, compat) |
| POST | `/oc/api/hub/sync` | Manual catalog refresh |
| GET | `/oc/api/hub/skills/{slug}` | Skill detail + installations |
| POST | `/oc/api/hub/install` | Install to OC instance or Claude Code |
| DELETE | `/oc/api/hub/install` | Uninstall |
| GET | `/oc/api/hub/installations` | List installations |

## NAS Workspace Architecture

Two workspace modes: `local` (default, data in `instances/<slug>/`) and `nas` (NFS-mounted NAS).

### NAS Mode — Two Models

**Model A (Internal Workforce)**: Bots as virtual employees. Each gets a home in `_clawbots/`. Manager bot coordinates.

```
/workspace/users/          ← NFS mount (Synology DS418, 192.168.2.138)
├── _clawbots/             ← Bot home directories
│   ├── manager/           ← Special: delegation, oversight, reporting
│   ├── research-01/       ← Worker bots with specializations
│   └── content-01/
├── _shared/               ← Cross-bot shared drive
│   ├── reports/           ← Workers drop reports, Manager reads
│   ├── inbox/<slug>/      ← Bot-to-bot messaging (JSON file drop)
│   ├── delegation/<slug>/ ← Manager assigns tasks here
│   └── knowledge/         ← Shared reference docs (all bots :ro)
```

**Model B (User-Attached)**: Bots run in a customer's NAS sandbox, working on their files.

```
/workspace/users/Denise/   ← User's existing sandbox
├── files/                 ← Mounted as bot's /app/workspace
├── wiki/                  ← Mounted as bot's /app/knowledge
└── bots/denise-main/     ← Bot-private state (memory, ralph, logs)
```

### Volume Mounts (NAS)

| Container Path | Model A (research-01) | Model B (denise-main) |
|---------------|----------------------|----------------------|
| `/app/config` :ro | `_clawbots/research-01/config/` | `Denise/bots/denise-main/config/` |
| `/app/knowledge` :ro | `_clawbots/research-01/knowledge/` | `Denise/wiki/` |
| `/app/workspace` :rw | `_clawbots/research-01/workspace/` | `Denise/files/` |
| `/app/logs` :rw | `_clawbots/research-01/logs/` | `Denise/bots/denise-main/logs/` |
| `/app/shared-knowledge` :ro | `_shared/knowledge/` | n/a |
| `/app/inbox` :rw | `_shared/inbox/research-01/` | n/a |
| `/app/reports` :rw | `_shared/reports/` | n/a |

### NAS API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/oc/api/nas/status` | NAS mount status, free space, bot homes, user sandboxes |

### Provisioning with NAS

```python
# Model A: Internal workforce bot
POST /oc/api/instances
{
  "slug": "research-01",
  "display_name": "Research Bot",
  "tier": "internal",
  "workspace_mode": "nas",
  "nas_model": "a",
  "autonomy_level": 7
}

# Model B: User-attached bot
POST /oc/api/instances
{
  "slug": "denise-main",
  "display_name": "Denise's Assistant",
  "tier": "starter",
  "workspace_mode": "nas",
  "nas_model": "b",
  "owner_username": "Denise",
  "autonomy_level": 5
}
```

### Destroy Behavior

NAS data is preserved by default on destroy (memory, reports stay on NAS). Pass `purge_nas=true` to delete.

## Port Allocation

- Range: 9001-9099 (99 slots)
- State: `tools/open-claw/instances/.ports.json` (slug → port map)
- Allocated on provision, released on destroy
- Localhost-only binding (Caddy or direct Tailscale access)

## Scripts

### `scripts/inject-credentials.sh <slug> [output-file]`
Fetches granted credentials from broker, writes to tmpfs. Called before container start.
Exit codes: 0=success, 1=args, 2=broker unreachable, 3=not found, 4=write failed.

### `scripts/kill-switch.sh <slug>`
Emergency stop: revokes all credentials via broker, stops Docker container, cleans tmpfs.

## Key Files

| Path | Purpose |
|------|---------|
| `tools/open-claw/broker/app.py` | FastAPI broker + all API routes (instances, credentials, runtime, hub, NAS) |
| `tools/open-claw/broker/manifest.py` | Access manifest CRUD (Supabase) |
| `tools/open-claw/broker/vault_bridge.py` | Scoped vault credential fetcher |
| `tools/open-claw/broker/runtime.py` | Container lifecycle manager + port allocator + NAS workspace resolver |
| `tools/open-claw/broker/config.py` | Configuration (paths, ports, NAS roots, LLM settings) |
| `tools/open-claw/broker/routes_llm.py` | LLM proxy endpoint (container→broker→claude CLI) |
| `tools/open-claw/broker/container_auth.py` | Per-instance callback token authentication |
| `tools/open-claw/broker/clawhub.py` | ClawHub marketplace (catalog sync, dual-target install) |
| `tools/open-claw/images/clawbot/server.js` | ClawBot runtime (Express, conversation, memory, knowledge) |
| `tools/open-claw/images/clawbot/lib/llm.js` | Container-side LLM client (calls broker proxy) |
| `tools/open-claw/images/clawbot/lib/memory.js` | 3-layer memory (knowledge graph, daily notes, tacit knowledge) |
| `tools/open-claw/images/clawbot/lib/knowledge.js` | Knowledge base indexer + TF search |
| `tools/open-claw/images/clawbot/lib/heartbeat.js` | Proactive check-in system |
| `tools/open-claw/images/clawbot/lib/ralph.js` | RALPH loop execution (multi-step tasks) |
| `tools/open-claw/instances/` | Per-instance dirs (docker-compose.yml + local workspace data) |
| `tools/open-claw/scripts/inject-credentials.sh` | Container credential injection |
| `tools/open-claw/scripts/kill-switch.sh` | Emergency stop |
| `tools/open-claw/templates/docker-compose.instance.yml` | Hardened container template (local mode) |
| `/workspace/users/_clawbots/` | NAS bot home directories (Model A) |
| `/workspace/users/_shared/` | NAS shared drive (reports, inbox, delegation, knowledge) |
| `notes/Improvements/V2/openclaw-nas-architecture.md` | Full design doc with diagrams |
| `config/supabase-migrations/037_openclaw_access_manifest.sql` | Database schema |
| `~/.config/systemd/user/opai-oc-broker.service` | Active systemd unit (user-level) |

## Gotchas

- **docker-compose v1**: System has `docker-compose` (v1 standalone), NOT `docker compose` (v2 plugin). Runtime uses `docker-compose -f ... -p ... up -d`.
- **Service-role auth**: `user.id` is `"service-role"` (not a UUID) when authenticating with the service key. Passing it to UUID FK columns causes `22P02`. Always check `user.id != "service-role"` before using as `granted_by`.
- **Health check DNS**: The `dns: 1.1.1.1` override in docker-compose prevents `localhost` resolution inside the container. Health checks must use `127.0.0.1` not `localhost`.
- **PostgREST timestamp `+`**: `isoformat()` produces `+00:00` which gets URL-decoded to a space in PostgREST filters. Use `strftime("%Y-%m-%dT%H:%M:%SZ")` instead.
- **Vault .env bootstrap**: Vault's `.env` must have real Supabase keys (not sourced from vault-env.sh — chicken-and-egg). If vault restarts and `.env` is empty, all services lose auth.
- **Vault audit module shadowing**: Vault's `app.py` must import its own `audit` module BEFORE adding `shared/` to `sys.path`, or `shared/audit.py` (which has `log_audit`) shadows vault's `audit.py` (which has `log_access`).
- Container restart needed after revoking credentials (already-injected env vars persist in running container). Kill switch handles this.
- Max 25 credentials per instance by default (env `OC_MAX_CREDS`).
- Upsert on grant: re-granting an existing key updates the grant (doesn't create duplicate).
- Archived instances can't be re-created with the same slug (unique constraint on `oc_instances.slug`).
- **NAS NFS mount**: Must use `--no-perms --no-group --no-owner` for any rsync operations. NFS mount at `/workspace/users/` (Synology DS418, 25GB quota).
- **NAS Model B `owner_username`**: Must match the exact directory name on the NAS (case-sensitive). Check `/workspace/users/` for available names.
- **NAS destroy preserves data**: `DELETE /oc/api/instances/{slug}` does NOT delete NAS data by default. Pass `?purge_nas=true` to wipe. This is intentional — memory and reports persist for re-attachment.
- **Callback token format**: `oc_<slug>_<32hex>`. Extract slug by splitting from right (hex is always 32 chars). SHA-256 hash stored in `config.callback_token_hash` JSONB field.
- **Container LLM**: Containers POST to `http://host.docker.internal:8106/oc/api/llm/chat`. Requires `extra_hosts` in compose for `host.docker.internal` resolution. Docker bridge IPs (172.*) allowed through localhost guard.

## Server Capacity

With current OPAI workload (11 services + 13 Docker containers using ~10GB RAM):
- **Conservative**: 10-12 OC instances (each 512MB RAM, 0.5 CPU cap)
- **Moderate**: 15-18 instances (most idle, relies on overcommit)
- **Max**: ~25 instances (over-subscribed, production risk)
- Lower `mem_limit` to 256MB for lightweight bots to double capacity.

---

## Strategic Pivot: ClaudeClaw (2026-02-28)

**Decision**: Pivot away from OpenClaw (containerized ClawBots with API keys) toward **ClaudeClaw** — an internal worker model using Claude Code CLI as the backbone. OpenClaw containers are no longer the primary execution model.

### What This Means

| Aspect | OpenClaw (old) | ClaudeClaw (new direction) |
|--------|----------------|---------------------------|
| **Runtime** | Docker containers with Claude CLI inside | Claude Code CLI sessions/processes directly |
| **LLM** | Broker LLM proxy (`routes_llm.py`) | Native Claude Code — no proxy needed |
| **Workers** | Isolated containerized bots | OPAI-managed Claude Code workers |
| **Skills** | ClawHub → install to container or Claude Code | ClawHub → install to Claude Code (primary) |
| **Auth** | Container callback tokens | Claude Code session management |
| **Use case** | Customer-facing chatbots | Internal OPAI workforce (v3 Felix) |

### What Carries Over

- **ClawHub marketplace** — skill catalog, sync, Claude Code installation path (`_install_to_claude()`). This is the primary value.
- **NAS workspace structure** — `_clawbots/`, `_shared/` directories for persistent memory, knowledge, workspace.
- **Vault bridge + access manifest** — credential management still relevant for workers that need API keys.
- **Engine UI** — ClawHub tab stays. Instance tab will evolve to show Claude Code workers.
- **Supabase tables** — `ch_skills`, `ch_installations` fully relevant. `oc_instances`, `oc_access_manifest`, `oc_credential_log` may evolve.

### What Becomes Less Relevant

- **Docker runtime** (`runtime.py`) — container provisioning, compose generation, port allocation.
- **LLM proxy** (`routes_llm.py`) — Claude Code is the LLM interface directly.
- **Container auth** (`container_auth.py`) — callback tokens for Docker containers.
- **Container agent code** (`tools/open-claw/agent/`) — the in-container ClawBot runtime.

### Research Needed

1. **Claude Code worker management** — How to spawn, persist, and manage multiple Claude Code sessions as "workers" with distinct contexts, memory, and skills.
2. **Skill injection** — How ClawHub skills map to Claude Code's `.claude/commands/`, CLAUDE.md context, and MCP server configs.
3. **Memory persistence** — How NAS workspace structure maps to Claude Code's auto-memory and project memory.
4. **Worker coordination** — How workers communicate, delegate, and report back to OPAI (Telegram, Engine, etc.).
5. **Session lifecycle** — Spawning `claude -p` for one-shot tasks vs persistent interactive sessions for ongoing work.

### Current Status

The broker remains live at port 8106 with all existing functionality. The pivot is strategic — no code is being removed. The Docker container path still works for testing and experimentation. New development focuses on the ClaudeClaw model.

> **See also**: [OPAI Evolution](../plans/opai-evolution.md) — v3 "Felix" vision aligns with this internal workforce model.
