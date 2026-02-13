# Boutabyte MCP Server

> **Status:** Phase 1 Built & Compiled — Pending IDE Registration  
> **Last Updated:** 2026-02-11  
> **Location:** `D:\SD\Home\OPAI\mcps\boutabyte-mcp\`

---

## What This Is

A custom MCP server that lets the Antigravity agent publish projects directly to the **Boutabyte** platform (`boutabyte.com`). When complete, you can say "add ThisKitchen to Boutabyte" and the agent will find the build files, upload them, and create the database entry automatically.

---

## Current State

### ✅ Done
- Full project scaffolded (TypeScript + ESM)
- `npm install` complete (208 packages, 0 vulnerabilities)
- `npm run build` compiles with **zero errors** → output in `dist/`
- `.env` configured with Supabase URL + service role key
- Two MCP tools implemented:
  - **`publish_webapp`** — Uploads a project's `dist/` folder to VPS + creates `sub_apps` DB record
  - **`list_projects`** — Lists all webapps, mobile apps, plugins, automations from Supabase

### ❌ Remaining (Phase 1)
- **Register in IDE** — Need to add `boutabyte-mcp` to whatever config file drives Gemini's MCP server list. The `supabase-mcp-server` is already registered somewhere but we couldn't locate the config file. Check:
  - Gemini extension settings UI in VS Code
  - Any `mcp.json` or `gemini_mcp_settings.json` in the user profile
  - The Cline MCP settings are at: `C:\Users\dalwa\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` (different system)

### 🔮 Future Phases
- **Phase 2:** `publish_mobile_app` (APK upload), `publish_plugin` (WP plugin ZIP upload)
- **Phase 3:** `update_project` tool, smart project-type auto-detection
- **Phase 4:** Auto-generate slugs/descriptions, icon generation, APK metadata parsing

---

## Architecture

```
Agent → boutabyte-mcp (stdio) → file.boutabyte.com (VPS uploads)
                               → Supabase (DB records)
```

### Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server entry — registers tools, routes calls, stdio transport |
| `src/lib/supabase.ts` | Supabase client using service_role key (bypasses RLS) |
| `src/lib/file-api.ts` | VPS file upload client — multipart uploads, list, delete, directory upload |
| `src/tools/publish-webapp.ts` | `publish_webapp` tool — find build dir, upload, create/update DB |
| `src/tools/list-projects.ts` | `list_projects` tool — query all product tables |

### Key Dependencies
- `@modelcontextprotocol/sdk` — MCP protocol
- `@supabase/supabase-js` — Database operations
- `dotenv` — Environment variables
- `archiver`, `mime-types` — File handling (for future phases)

---

## Credentials

### In `.env` (already configured)
| Variable | Value | Source |
|----------|-------|--------|
| `SUPABASE_URL` | `https://aggxspqzerfimqzkjgct.supabase.co` | Boutabyte project |
| `SUPABASE_SERVICE_KEY` | Set ✅ | From Boutabyte `.env.local` |
| `FILE_API_URL` | `https://file.boutabyte.com` | VPS hosting |
| `FILE_API_KEY` | Empty (not enforced in prod) | VPS docker-compose uses `FILE_API_KEY` env var |
| `DEFAULT_ADMIN_USER_ID` | Empty (optional) | For `created_by` attribution |

### Supabase MCP PAT (separate system)
- Stored at: `mcps/Supabase/mcp.md`
- Token: Set via `mcps/Supabase/mcp.md` (not committed)

---

## How the VPS File API Works

The deployed API at `file.boutabyte.com` is a Node.js/Express server inside Docker on Hostinger VPS.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/upload?path={dir}` | POST (multipart) | Upload files to a directory |
| `/list?path={dir}` | GET | List files in a directory |
| `/delete?path={path}` | DELETE | Delete a file or directory |
| `/health` | GET | Health check (no auth) |

- Source: `Boutabyte/hostinger/file-api/index.js` (ZIP upload version) and `Boutabyte/Docs/file-api-index.js` (individual file version)
- Docker config: `Boutabyte/hostinger/docker-compose.yml` — maps `FILE_API_KEY` env to `API_KEY`
- Default API key: `'dev-key-change-me'` — may not be changed in production since GitHub sync route sends no auth headers

---

## Registration Config (When Ready)

Add to whatever file manages Gemini MCP servers:

```json
{
  "boutabyte-mcp": {
    "command": "node",
    "args": ["D:/SD/Home/OPAI/mcps/boutabyte-mcp/dist/index.js"],
    "env": {
      "SUPABASE_URL": "https://aggxspqzerfimqzkjgct.supabase.co",
      "SUPABASE_SERVICE_KEY": "<from .env>",
      "FILE_API_URL": "https://file.boutabyte.com"
    }
  }
}
```

---

## Boutabyte Platform Reference

- **Codebase:** `D:\SD\Home\OPAI\Obsidian\Projects\Boutabyte\`
- **Stack:** Next.js 15, React 19, TypeScript, Tailwind v4, Supabase, Netlify
- **DB Tables:** `sub_apps`, `mobile_apps`, `wp_plugins`, `n8n_automations`, `webapp_categories`
- **VPS Storage Patterns:** `apps/{slug}/` for webapps, `mobile-apps/{slug}/` for mobile
- **GitHub Sync Route:** `src/app/api/integrations/github/sync/route.ts` — reference implementation for the upload pipeline
