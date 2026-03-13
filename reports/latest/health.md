# Report: health



# OPAI Codebase Health Audit Report

**Date:** 2026-03-04 | **Scope:** `/workspace/synced/opai` — 24 active projects, 22+ tools/services, 42 SQL migrations

---

## Executive Summary

| Severity | Count | Categories |
|----------|-------|------------|
| **Critical** | 6 | 3 Security (hardcoded secrets), 3 Async Blocking (Python/FastAPI) |
| **High** | 20 | 8 Performance (unbounded queries), 8 Security (.env exposure), 4 Dead Code (PII logging, debug page) |
| **Medium** | 19 | 6 Performance, 5 Dead Code (TODOs, stubs), 5 Security, 3 Dependency |
| **Low** | 12 | 4 Performance, 5 Dead Code, 3 Dependency |

**Total: 57 findings across 11 projects and 22 tool services.**

---

## P0 — Do Now (Crashes, Async Blocking, Security)

### SEC-1: ~70 Hardcoded Credentials in migrate_credentials.py [CRITICAL]

- **File:** `/workspace/synced/opai/tools/opai-vault/migrate_credentials.py`, lines 39–321
- **Category:** Security Surface
- **Severity:** Critical
- **Issue:** This single file contains the **entire credential corpus** in plaintext — Anthropic, OpenAI, Stripe live keys, Google OAuth secrets, SSH root passwords, Supabase service keys, email app passwords, Discord/Telegram bot tokens, client WooCommerce keys, 10 Synology NAS passwords, and more.
- **Fix:**
  1. Delete this file immediately
  2. Scrub from git history using BFG Repo-Cleaner
  3. **Rotate ALL credentials** — they must be considered compromised

### SEC-2: Live Stripe Secret Keys in opai-helm .env [CRITICAL]

- **File:** `/workspace/synced/opai/tools/opai-helm/.env`, lines 34–40
- **Category:** Security Surface
- **Severity:** Critical
- **Issue:** Contains `sk_live_*` Stripe secret key, `sk_test_*` key, `whsec_*` webhook secrets, plus Hostinger API key, GoDaddy API key/secret, Netlify PAT, and a Fernet vault encryption key — all in plaintext.
- **Fix:** Migrate opai-helm to vault-managed credentials. Rotate Stripe keys.

### SEC-3: Live Stripe & Supabase Keys in opai-billing .env [CRITICAL]

- **File:** `/workspace/synced/opai/tools/opai-billing/.env`, lines 6–20
- **Category:** Security Surface
- **Severity:** Critical
- **Issue:** Contains `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` in plaintext.
- **Fix:** Migrate opai-billing to vault-managed credentials.

### ASYNC-1: Synchronous `requests` Blocks FastAPI Event Loop [CRITICAL]

- **File:** `/workspace/synced/opai/Projects/Lace & Pearls/wp-agent/src/core/client.py`, lines 145–164
- **Category:** Async Blocking
- **Severity:** Critical
- **Issue:** The entire `WordPressClient` uses synchronous `requests.Session` for all HTTP methods. When called from async FastAPI routes, **every API call blocks the entire event loop**, stalling all concurrent requests.
- **Fix:** Replace `requests` with `httpx.AsyncClient`, or wrap all calls with `asyncio.to_thread()`.

### ASYNC-2: Synchronous Media Download Blocks Event Loop [CRITICAL]

- **File:** `/workspace/synced/opai/Projects/Lace & Pearls/wp-agent/src/agents/media.py`, lines 180–186
- **Category:** Async Blocking
- **Severity:** Critical
- **Issue:** `requests.get(url, stream=True, timeout=60)` blocks the event loop for up to 60 seconds during file download, preventing all other requests from being served.
- **Fix:** Use `httpx.AsyncClient` with `await`, or `asyncio.to_thread()`.

### ASYNC-3: All FastAPI Routes Declared `async def` but Call Blocking Code [CRITICAL]

- **File:** `/workspace/synced/opai/Projects/Lace & Pearls/wp-agent/api/server.py`, lines 147–181
- **Category:** Async Blocking
- **Severity:** Critical
- **Issue:** Routes `execute`, `execute_command`, `list_posts`, `list_pages`, `list_media` are `async def` but call `orchestrator.execute()` which is synchronous. This blocks the event loop.
- **Fix:** Either change routes from `async def` to plain `def` (FastAPI auto-threadpool), or wrap with `await asyncio.to_thread(orchestrator.execute, ...)`.

---

## P1 — This Sprint (Performance, Major Dead Code, Remaining Security)

### Performance: Unbounded Queries

| # | File | Line(s) | Issue | Fix |
|---|------|---------|-------|-----|
| PERF-1 | `ByteSpace/apps/mobile/app/(tabs)/dashboard.tsx` | 53–82 | Waterfall N+1: 4 sequential Supabase queries, tasks query has no `.limit()` | Add `.limit()`, use RPC for aggregation |
| PERF-2 | `Boutabyte/src/components/admin/MediaManagement.tsx` | 42–44 | `.select('*')` on `media_items` — no limit | Add `.limit(100)` + pagination |
| PERF-3 | `Boutabyte/src/components/admin/DashboardOverview.tsx` | 100–103 | Fetches ALL `blog_posts` just to count rows | Use `select('*', { count: 'exact', head: true })` |
| PERF-4 | `Boutabyte/src/components/admin/DashboardOverview.tsx` | 113–116 | Unbounded `n8n_automations` query | Add `.limit()` |
| PERF-5 | `BoutaCare/src/pages/admin.js` | 75–84 | 3 unbounded queries + N+1 client-side join for subscription stats | Create Supabase RPC with server-side JOIN |
| PERF-6 | `vec-article-builder/src/app/articles/page.tsx` | 20–23 | `.select('*')` on `articles` — no limit | Add `.limit(50)` + pagination |
| PERF-7 | `BoutaChat/src/hooks/useChat.ts` | 19–24 | Unbounded chat history query with full join | Add `.limit(50)` |
| PERF-8 | `ByteSpace/apps/api/src/routes/tasks.ts` | 12–17 | All tasks for project fetched with nested join, no limit | Add `.limit(100)` + cursor pagination |

### Performance: Aggressive Polling

| # | File | Line(s) | Issue | Fix |
|---|------|---------|-------|-----|
| PERF-9 | `Boutabyte/src/components/admin/DashboardOverview.tsx` | 216–219 | `setInterval(fetchData, 10000)` — 6 queries every 10 seconds | Increase to 60s or use Supabase Realtime |
| PERF-10 | `Boutabyte/src/contexts/SiteSettingsContext.tsx` | 58–63 | `setInterval(loadSettings, 30000)` runs globally on all pages | Use Supabase Realtime subscription |

### Performance: Missing Memoization

| # | File | Line(s) | Issue | Fix |
|---|------|---------|-------|-----|
| PERF-11 | `Boutabyte/src/components/admin/AnalyticsDashboard.tsx` | 10–19 | 5 array operations on every render without `useMemo` | Wrap in `useMemo(() => ..., [analytics])` |
| PERF-12 | `Boutabyte/src/components/admin/MediaManagement.tsx` | 36, 215 | `createClient()` in component body (new instance every render); `filteredMedia` not memoized | Move client outside component; wrap filter in `useMemo` |
| PERF-13 | `Boutabyte/src/components/admin/DashboardOverview.tsx` | 95–213 | `fetchData` not wrapped in `useCallback`, causes subtle stale closure bug with `setInterval` | Wrap in `useCallback` or use ref |

### Performance: useEffect Issues

| # | File | Line(s) | Issue | Fix |
|---|------|---------|-------|-----|
| PERF-14 | `Everglades-News/.../app/(tabs)/index.tsx` | 49–81 | `loadArticles` has `page` in deps but also sets `page`; `useEffect` missing `loadArticles` in deps array (stale closure) | Use ref for page; add `loadArticles` to deps |

### Dead Code: Security-Sensitive

| # | File | Line(s) | Issue | Fix |
|---|------|---------|-------|-----|
| DC-1 | `Boutabyte/src/app/debug-menu/page.tsx` | 1–98 | **Debug page at `/debug-menu` dumps all `menu_items` from DB** — accessible without auth | **Delete immediately** |
| DC-2 | `Boutabyte/src/app/api/admin/reset-user-password/route.ts` | 84 | Logs user email during password reset | Remove `console.log` |
| DC-3 | `Boutabyte/src/app/api/admin/create-user/route.ts` | 44–51 | Logs entire create-user request body including email/name | Remove or redact PII |
| DC-4 | `Boutabyte/src/app/api/admin/delete-user/route.ts` | 44–117 | 13 console statements logging userId through delete cascade | Remove debug logging |

### Dead Code: Test Data in Production

| # | File | Line(s) | Issue | Fix |
|---|------|---------|-------|-----|
| DC-5 | `Everglades-News/.../app/(tabs)/events.tsx` | 194–214 | Fake test events (IDs 8888, 8889) injected into real API results | Remove test event block |
| DC-6 | `Everglades-News/.../app/article/[id]-old.tsx` | entire file | Old backup file never deleted, logs on every render | Delete file |

### Dead Code: Massive Console Logging (1,301 total statements)

| Project | Count | Worst Files |
|---------|-------|-------------|
| **Boutabyte** | 735 | `FileManagement.tsx` (21), `EditSubAppForm.tsx` (21), `FrontendManagement.tsx` (15) |
| **Everglades-News** | 410 | `places.tsx` (**102 statements**), `wordpress.ts` (**85 statements**) |
| **BoutaCare** | 124 | `adminCommunity.js` (34), `dashboard.js` (25) |
| **vec-article-builder** | 21 | Spread across 7 files |
| **BoutaChat** | 7 | `useChat.ts`, `App.tsx` |

### Security: Remaining .env Exposure

| # | File | Issue |
|---|------|-------|
| SEC-4 | `tools/email-checker/.env` (lines 18, 24, 30) | Gmail and Hostinger app passwords in plaintext |
| SEC-5 | `tools/opai-telegram/.env` (line 4) | Telegram bot token, webhook secret, Supabase service key |
| SEC-6 | `tools/opai-dev/.env` (line 36) | WebSocket cookie secret |
| SEC-7 | `mcps/Wordpress-VEC/.env` (line 3) | WordPress application password |
| SEC-8 | `mcps/clickup-mcp/.env` (line 1) | ClickUp API key |
| SEC-9 | 6 `.env.pre-vault` files | Pre-migration backups with live credentials — **delete all** |
| SEC-10 | `Projects/OPAI/Archived/opai-marketplace/.env` (line 16) | SSH root password to VPS |
| SEC-11 | `Projects/OPAI/Archived/opai-chat/.env` (line 6) | Gemini API key |
| SEC-12 | 20+ `.env` files | Same `SUPABASE_JWT_SECRET` and `SUPABASE_SERVICE_KEY` duplicated everywhere — only 6/22 tools migrated to vault |

### Security: Infrastructure Defaults

| # | File | Line | Issue | Fix |
|---|------|------|-------|-----|
| SEC-13 | `tools/open-claw/broker/config.py` | 19 | Defaults to `0.0.0.0` binding | Change default to `127.0.0.1` |
| SEC-14 | `tools/wp-agent/api/server.py` | 242 | Defaults to `0.0.0.0` binding | Change default to `127.0.0.1` |
| SEC-15 | `config/supabase-migrations/022_wp_sites_admin_password.sql` | — | WP admin passwords stored as plaintext TEXT columns | Encrypt at application layer |

---

## P2 — Backlog (Cleanup, Minor Improvements)

### Dead Code: TODOs & Stubs

| # | File | Line | Description |
|---|------|------|-------------|
| DC-7 | `Boutabyte/.../ContactForm.tsx` | 20 | Contact form uses `setTimeout` instead of calling existing `/api/contact` |
| DC-8 | `Boutabyte/.../api/contact/route.ts` | 43 | TODO: Send notification email to admin |
| DC-9 | `Boutabyte/.../api/webapp-submissions/[id]/route.ts` | 370–371 | TODO: Delete orphaned files/images on submission delete |
| DC-10 | `Boutabyte/.../admin/FileManagement.tsx` | 1446 | Move modal commented out |
| DC-11 | `Boutabyte/.../social/publishers.ts` | 148–160 | Twitter/LinkedIn stubs always return failure |
| DC-12 | `Boutabyte/src/lib/archiveUtils.ts` | entire file | ~240 lines of dead code, never imported |
| DC-13 | `BoutaCare/.../core.js` | 202 | Subscription checkout stub shows "coming soon" toast |
| DC-14 | `BoutaCare/.../adminCommunity.js` | 600 | "Comments management coming soon" placeholder |

### Dead Code: Commented-Out Code Blocks

- **135+ files** contain 5+ consecutive commented-out lines
- Worst: Boutabyte (112 files), BoutaCare (13 files), Everglades-News (8 files)

### Dependency: Unpinned Python Packages

| File | Packages | Pinned |
|------|----------|--------|
| `tools/opai-brain/requirements.txt` | 8 | 0 |
| `tools/opai-wordpress/requirements.txt` | 7 | 0 |
| `tools/opai-prd/requirements.txt` | 7 | 0 |
| `tools/opai-bx4/requirements.txt` | 7 | 0 |
| `tools/opai-studio/requirements.txt` | 8 | mixed |
| + 3 more MCP requirements.txt files | — | — |

**Fix:** Pin all Python deps to `>=min,<next_major` or use `pip-compile` for lock files. No Python project has a lock file.

### Dependency: Minor Version Issues

| # | Issue | Fix |
|---|-------|-----|
| DEP-1 | `tools/opai-telegram/package.json` uses Express 4.x (EOL approaching) | Migrate to Express 5 |
| DEP-2 | `@modelcontextprotocol/sdk` version spread: `^1.0.0` vs `^1.26.0` across MCPs | Align to `^1.26.0` |
| DEP-3 | `package-lock.json` in root `.gitignore` — no lock files for tools | Track lock files for reproducibility |

### Positive Findings

- **No SQL injection patterns** found across all Python tools and MCPs
- **RLS enabled on all tables** across 42 migrations; recursive RLS bug fixed in migration 017
- **Path traversal protection** properly implemented in `opai-files/app.py`
- **OPAI Mobile App**, **WE Tools**, **ByteSpace API** — cleanly written with proper patterns
- **6 tools** successfully migrated to vault (opai-portal, opai-email-agent, opai-files, opai-team-hub, opai-wordpress, discord-bridge)

---

## Prioritized Action Plan

### P0 — Immediate (security incidents, blocking bugs)
1. **Delete** `tools/opai-vault/migrate_credentials.py` and scrub from git history with BFG
2. **Rotate ALL credentials** found in that file (~70 keys)
3. **Delete all 6 `.env.pre-vault` files** and the archived project `.env` files
4. **Delete** `Boutabyte/src/app/debug-menu/page.tsx` (unauthenticated data exposure)
5. **Fix async blocking** in wp-agent: change `async def` routes to `def`, or wrap with `asyncio.to_thread()`
6. **Migrate opai-helm and opai-billing** to vault (live Stripe keys exposed)

### P1 — This Sprint (performance, remaining security)
7. Add `.limit()` to all 8 unbounded Supabase queries
8. Replace 10-second polling with Supabase Realtime subscriptions in Boutabyte dashboard
9. Remove test event injection from Everglades-News events.tsx
10. Strip PII from admin API route logging (create-user, delete-user, reset-password)
11. Remove 187 console statements from Everglades-News (places.tsx + wordpress.ts)
12. Migrate remaining 16 tools to vault-managed credentials
13. Change `0.0.0.0` defaults to `127.0.0.1` in broker and wp-agent
14. Encrypt WP admin passwords in Supabase

### P2 — Backlog
15. Add `useMemo`/`useCallback` to Boutabyte admin components
16. Wire ContactForm to existing API endpoint
17. Implement or remove Twitter/LinkedIn publisher stubs
18. Delete dead file `archiveUtils.ts` and old backup `[id]-old.tsx`
19. Clean 135+ files of commented-out code blocks
20. Pin all Python dependencies and add lock files
21. Remove remaining 1,100+ console statements across projects
22. Address 9 TODO comments for incomplete features