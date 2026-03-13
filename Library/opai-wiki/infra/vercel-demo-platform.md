# Vercel Demo Platform

> Ephemeral demo deployments to Vercel for customer presentations and internal testing.

## Overview

The Vercel Demo Platform is a lightweight deployment pipeline for spinning up disposable demos during customer conversations. Build an app, deploy it in seconds, share the link, then tear it down or promote to Hostinger when approved.

**Design principle**: Vercel is a disposable staging ground, not a hosting platform. OPAI stays on our VPS — Vercel is just for quick previews.

### Guardrails

| Constraint | Value | Rationale |
|-----------|-------|-----------|
| Max active demos | 3 | Hobby plan limits, prevent sprawl |
| Default TTL | 48 hours | Auto-review, nothing lingers |
| Domains | `*.vercel.app` only | No custom domains on Vercel |
| Plan | Hobby (free) | Personal/non-commercial; upgrade to Pro ($20/mo) if usage becomes regular |
| "Promotion" | Manual redeploy to Hostinger | Not a Vercel operation |

---

## Architecture

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│   Telegram   │────▶│  Engine API     │────▶│ vercel-demo.sh   │
│   /demo cmd  │     │  /api/demos/*   │     │ (CLI + Vercel)   │
└──────────────┘     └─────────────────┘     └────────┬─────────┘
                            │                          │
                            ▼                          ▼
                     ┌──────────────┐          ┌──────────────┐
                     │ State file   │          │ Vercel API   │
                     │ (JSON)       │          │ (deploy/rm)  │
                     └──────────────┘          └──────────────┘
```

Three components:

1. **CLI Script** (`scripts/vercel-demo.sh`) — Self-contained bash script handling all Vercel operations
2. **Engine API** (`tools/opai-engine/routes/demos.py`) — FastAPI routes that shell out to the CLI script
3. **Telegram Command** (`/demo` in `tools/opai-telegram/handlers/commands.js`) — User-facing interface

---

## Key Files

| File | Purpose |
|------|---------|
| `scripts/vercel-demo.sh` | CLI: deploy, list, teardown, teardown-all, sweep |
| `tools/opai-engine/routes/demos.py` | Engine API routes (5 endpoints) |
| `tools/opai-engine/data/vercel-demos.json` | State file (auto-created on first use) |
| `tools/opai-engine/config.py` | `VERCEL_DEMOS_FILE` path constant |

---

## Configuration

### Vault Secrets

| Key | Purpose |
|-----|---------|
| `VERCEL_TOKEN` | Vercel personal access token (created at vercel.com/account/tokens) |

### State File Schema

```json
{
  "demos": {
    "<slug>": {
      "vercel_project": "demo-<slug>-<4char-hash>",
      "url": "https://demo-<slug>-<hash>.vercel.app",
      "source_dir": "/workspace/synced/opai/Projects/...",
      "deployed_at": "2026-03-04T15:30:00Z",
      "max_age_hours": 48,
      "status": "active",
      "notes": "optional context"
    }
  },
  "config": {
    "max_active_demos": 3,
    "default_max_age_hours": 48
  }
}
```

---

## API Reference

### Engine Routes (`/api/demos`)

| Method | Path | Purpose | Timeout |
|--------|------|---------|---------|
| `POST` | `/api/demos/deploy` | Deploy directory to Vercel | 120s |
| `GET` | `/api/demos` | List active demos | — |
| `POST` | `/api/demos/{slug}/teardown` | Teardown one demo | — |
| `POST` | `/api/demos/teardown-all` | Remove all demos | — |
| `POST` | `/api/demos/sweep` | Auto-remove stale (>48h) demos | — |

#### Deploy Request Body

```json
{
  "directory": "/workspace/synced/opai/Projects/my-app",
  "slug": "my-app",
  "notes": "Demo for client meeting"
}
```

#### Deploy Response

```json
{
  "success": true,
  "slug": "my-app",
  "url": "https://demo-my-app-a1b2.vercel.app",
  "project": "demo-my-app-a1b2"
}
```

#### List Response

```json
{
  "demos": [
    {
      "slug": "my-app",
      "url": "https://demo-my-app-a1b2.vercel.app",
      "project": "demo-my-app-a1b2",
      "source_dir": "/workspace/synced/opai/Projects/my-app",
      "deployed_at": "2026-03-04T15:30:00Z",
      "age_hours": 12,
      "max_age_hours": 48,
      "notes": "Demo for client meeting"
    }
  ],
  "count": 1
}
```

---

## How to Use

### CLI

```bash
# Deploy a project
./scripts/vercel-demo.sh deploy ./Projects/my-app my-app "Client demo"

# List active demos
./scripts/vercel-demo.sh list

# Teardown one
./scripts/vercel-demo.sh teardown my-app

# Teardown all
./scripts/vercel-demo.sh teardown-all

# Sweep stale (>48h)
./scripts/vercel-demo.sh sweep
```

### Telegram

```
/demo list                          — Show active demos
/demo deploy <path> <slug> [notes]  — Deploy a project
/demo teardown <slug>               — Remove a demo
/demo teardown-all                  — Remove all
/demo sweep                         — Clean stale demos
```

### Typical Workflow

1. Build/prepare app in `Projects/<slug>/`
2. Deploy: `/demo deploy ./Projects/my-app client-preview`
3. Share `*.vercel.app` URL with customer
4. Customer approves → manually redeploy to Hostinger
5. Teardown: `/demo teardown client-preview`

---

## Behaviors

- **Auto-sweep**: Runs automatically before every deploy to clean stale demos
- **Limit enforcement**: Blocks deploy if 3 demos already active (exit code 2)
- **Telegram notifications**: Sent on deploy and teardown via `tg-notify.sh`
- **Naming convention**: `demo-<slug>-<4char-md5>` on Vercel
- **Token retrieval**: From Vault (`vault-cli.sh get VERCEL_TOKEN`)
- **Headless deploys**: `vercel --token $TOKEN --yes --prod` (no prompts)

---

## Dependencies

| Dependency | Purpose |
|-----------|---------|
| Vercel CLI (`vercel`) | Deploy/remove projects |
| `scripts/tg-notify.sh` | Telegram notifications |
| `vault-cli.sh` | Token retrieval |
| Engine (port 8080) | API layer |
| `python3` | State file manipulation (JSON) |

---

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `LIMIT_REACHED` | 3 active demos | Teardown one first |
| `No VERCEL_TOKEN in vault` | Token not stored | `vault-cli.sh set VERCEL_TOKEN "<token>"` |
| Deploy timeout (120s) | Slow build | Retry or check Vercel dashboard |
| Teardown fails silently | Already removed from Vercel | State file updated anyway |
