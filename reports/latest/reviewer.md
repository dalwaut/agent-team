# Report: reviewer



# OPAI Codebase — Comprehensive Code Review

**Review Date:** 2026-03-04
**Scope:** 300+ Python files, 200+ TypeScript/TSX files, 50+ JS files, 40+ shell scripts across 22 services
**Reviewer:** Automated deep review (6 parallel review agents)

---

## Executive Summary

The OPAI codebase is a massive, ambitious autonomous infrastructure — 22 active services, 13-worker Claude Code fleet, 42 agent roles. The architecture shows strong conceptual design but has accumulated significant security debt and consistency gaps as it has scaled. The most critical findings center on **missing authentication on write endpoints**, **plaintext credential storage**, and **hardcoded secrets in source code**.

**Total Issues Found: 227**

| Severity | Count |
|----------|-------|
| Critical | 23 |
| High | 56 |
| Medium | 97 |
| Low | 51 |

---

## Table of Contents

1. [Critical Security Findings (Immediate Action Required)](#1-critical-security-findings)
2. [Shared Libraries Review (`tools/shared/`)](#2-shared-libraries)
3. [OPAI Engine Review (`tools/opai-engine/`)](#3-opai-engine)
4. [Brain / HELM / DAM Review](#4-brain--helm--dam)
5. [BX4 / WordPress / Vault / Billing Review](#5-bx4--wordpress--vault--billing)
6. [Shell Scripts & Caddyfile Review](#6-shell-scripts--caddyfile)
7. [TypeScript / React / Frontend Review](#7-typescript--react--frontend)
8. [Cross-Cutting Patterns](#8-cross-cutting-patterns)
9. [Scorecard](#9-scorecard)

---

## 1. Critical Security Findings

These require immediate attention. Any one of them could lead to unauthorized access or data breach.

### 1.1 Plaintext Credentials in Source Code

| # | File | Lines | Issue |
|---|------|-------|-------|
| 1 | `tools/opai-vault/migrate_credentials.py` | 39-320 | **~70 plaintext credentials** including Anthropic API key, OpenAI key, Stripe keys, Supabase service keys, SSH passwords, NAS passwords, email passwords, database passwords, Google OAuth secrets, GitHub PATs, and more. |
| 2 | `scripts/test-agent-task-flow.sh` | 36-37 | Hardcoded Supabase anon key and service role key (full JWTs). |
| 3 | `scripts/supabase-sql.sh` | 32 | Hardcoded Supabase Personal Access Token (`sbp_629281...`) with full DDL capability. |
| 4 | `scripts/fix-inotify-limits.sh` | 38 | Hardcoded Tailscale auth token (`ts_3e927c...`). |
| 5 | `tools/opai-vault/config.py` | 44 | AGE encryption public key as default value — anyone reading source knows the encryption identity. |

**Action:** Delete `migrate_credentials.py`. Rotate every credential listed. Move all secrets to vault or environment variables.

### 1.2 Missing Authentication on Write Endpoints

| # | Service | File | Endpoints | Impact |
|---|---------|------|-----------|--------|
| 6 | Engine | `routes/workers.py:85-104` | `approve_request`, `deny_request` | Anyone can approve/deny worker requests |
| 7 | Engine | `routes/bottleneck.py:48-70` | `accept_suggestion`, `dismiss_suggestion`, `trigger_scan` | Unauthenticated config changes |
| 8 | Engine | `routes/fleet.py:42-55` | `fleet_dispatch`, `fleet_cancel` | Unauthenticated task spawning/cancellation |
| 9 | Engine | `routes/mail.py:47-105` | `get_inbox`, `send_message`, `reply_message` | Read any worker's mail, impersonate workers |
| 10 | Engine | `routes/action_items.py` | `act_on_item`, `bulk_dismiss` | Unauthenticated task state modification |
| 11 | Brain | `routes/youtube.py:72,204,356` | `save`, `research`, `rewrite` | Create brain nodes without auth |
| 12 | Brain | `routes/instagram.py:85,235,385` | `save`, `research`, `rewrite` | Create brain nodes without auth |
| 13 | DAM | All route files | All 11+ endpoints | Complete unauthenticated access to meta-orchestrator |

**Action:** Add `dependencies=[Depends(require_admin)]` to every write endpoint across these services.

### 1.3 Credential Storage & Injection Vulnerabilities

| # | File | Lines | Issue |
|---|------|-------|-------|
| 14 | `tools/opai-wordpress/routes_sites.py` | 113-128 | WordPress `app_password`, `admin_password`, WooCommerce keys stored as **plaintext** in Supabase |
| 15 | `tools/opai-helm/routes/webhooks.py` | 35-46 | Stripe webhook accepts unsigned payloads when `webhook_secret` is empty — enables forged events |
| 16 | `tools/opai-helm/core/vault.py` | 22-30 | Path traversal: `vault_key` like `imp/../../etc/passwd` escapes vault directory |
| 17 | `tools/opai-dam/core/skill_manager.py` | 29 | PostgREST query injection via unsanitized `query` parameter |
| 18 | `tools/opai-vault/scripts/vault-cli.sh` | 69-76 | Shell injection via `$NAME`/`$VALUE` interpolated into inline Python |
| 19 | `scripts/supabase-sql.sh` | 113-115 | SQL injection in `describe_table` — `$table` interpolated into SQL |
| 20 | `tools/opai-vault/routes_auth.py` | 228,246,308,325 | WebAuthn challenges keyed by client IP — shared IP = challenge hijack |
| 21 | `tools/opai-dam/routes/sessions.py` | 61-65 | User impersonation: accepts `user_id` from request body when JWT fails |
| 22 | Portal `static/js/auth.js` | 32-37 | `window.OPAI_AUTH_DISABLED` flag bypasses all authentication |
| 23 | Portal `static/js/auth.js` | 87-94 | Fail-open: if `/api/me/apps` fetch fails for any reason, user is granted access |

---

## 2. Shared Libraries (`tools/shared/`)

10 files reviewed, 52 issues found.

### Must Fix

| # | File:Line | Category | Issue | Fix |
|---|-----------|----------|-------|-----|
| 1 | `auth.py:212` | Security | `user_id` string-interpolated into PostgREST URL without UUID validation | Validate with `uuid.UUID(user_id)` before interpolation |
| 2 | `auth.py:270` | Security | Non-constant-time token comparison for service key | Use `hmac.compare_digest()` |
| 3 | `claude_api.py:245` | Type Safety | `Optional[callable]` — lowercase `callable` is not a valid type hint | Use `Optional[Callable[..., Any]]` |
| 4 | `google_auth.py:122` | Python/Async | Blocking sync I/O (`_load_vault()` filesystem + imports) inside `async def` | Use `await asyncio.to_thread(_get_client_config)` |
| 5 | `google_workspace.py:175` | Resources | `httpx.AsyncClient` created but never guaranteed closed (no `__aenter__`/`__aexit__`) | Implement async context manager protocol |
| 6 | `image_gen.py:112` | Security | Gemini API key exposed in URL query parameter | Pass via `x-goog-api-key` header instead |
| 7 | `instagram.py:109-113` | Security | Subprocess-based vault access spawns Python child to read secrets via stdout | Use direct import pattern from `google_auth.py` |
| 8 | `supadata.py:36-43` | Security | Same subprocess vault pattern | Same fix |
| 9 | `claude_api.py:117,279` | Resources | `anthropic.AsyncAnthropic` client never closed | Use `async with` or call `await client.close()` |
| 10 | `google_auth.py:230` | Security | Full refresh token printed to stdout | Truncate or mask |

### Should Fix

| # | File:Line | Category | Issue |
|---|-----------|----------|-------|
| 11 | `audit.py:37` vs `109` | Quality | Inconsistent timezone: `datetime.now()` vs `datetime.now(timezone.utc)` |
| 12 | `audit.py:46-51,68-72` | Error Handling | `except Exception: pass` — silent swallow on corrupt JSON |
| 13 | `auth.py:67,153-154,166-167,223` | Error Handling | 4 instances of silent exception swallowing in JWKS/JWT/profile code |
| 14 | `audit.py:88-89`, `auth.py:105-106` | Type Safety | `int = None`, `str = None` instead of `Optional[int]`, `Optional[str]` (8+ instances) |
| 15 | `instagram.py:621-626`, `youtube.py:258-261` | Quality | Coroutines awaited sequentially instead of `asyncio.gather()` |
| 16 | `google_workspace.py:338` | Security | Drive query built with unescaped user input (single quote injection) |
| 17 | `youtube.py:34-35` | Security | Real IP addresses and SSH commands in source comments |
| 18 | `youtube.py:189` | Quality | Deprecated `asyncio.get_event_loop()` — use `get_running_loop()` |
| 19 | `instagram.py:374` | Error Handling | `except Exception: pass` silently drops video frames |
| 20 | `supadata.py:57-58` | Error Handling | Corrupt usage file silently resets counter to 0, bypassing rate limits |

---

## 3. OPAI Engine (`tools/opai-engine/`)

56 files reviewed, 56 issues found. This is a **FastAPI** application (despite `app.py` line 1 saying Flask).

### Security — Critical/High (14 issues)

The authentication gaps are covered in Section 1.2 above. Additional findings:

| # | File:Line | Severity | Issue | Fix |
|---|-----------|----------|-------|-----|
| 1 | `services/service_controller.py:218-224` | High | Command injection: task title embedded in Node.js `-e` flag | Pass data via stdin or temp file |
| 2 | `routes/tasks.py:514-519` | High | `/files/read` endpoint takes `path` param with no auth — potential path traversal | Add `require_admin` + validate `read_file_safe()` |
| 3 | `services/task_processor.py:36-41` | Medium | Personal email addresses hardcoded as trusted senders | Move to config |
| 4 | `config.py` | Medium | Multiple hardcoded UUIDs (workspace IDs, queue IDs) | Move to env/config |
| 5 | `background/worker_manager.py:30` | Medium | `NVM_NODE_BIN = "/home/dallas/.nvm/versions/node/v20.19.5/bin"` | Use `shutil.which("node")` |
| 6 | `routes/google_chat.py:75` | Low | Raw exception string returned to API consumers | Return generic error |

### Error Handling — High (5 issues)

| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|
| 1 | `services/guardrails.py:290` | **Runtime crash**: `registry["tasks"].append(task)` on a dict — `AttributeError` | Use `registry["tasks"][task_id] = task` |
| 2 | `routes/tasks.py:144-145` + 3 more | `except Exception: pass` silently swallows Telegram, archive, count errors | Add `logger.warning(...)` |
| 3 | `config.py` (load_orchestrator_config) | Corrupt `orchestrator.json` silently returns empty dict | Log warning, return marked fallback |
| 4 | `ws/streams.py:30-31,43-44,73-74,111-112,129-130` | `except (WebSocketDisconnect, Exception): pass` — real errors lost | Separate catches, log non-disconnect errors |
| 5 | `services/task_processor.py` | `write_registry()` not protected by `_registry_lock` — data corruption risk | Wrap all writes with `with _registry_lock:` |

### Blocking Calls in Async (6 issues)

| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|
| 1 | `ws/streams.py:27,40` | Sync `psutil` calls in async WebSocket handlers block event loop every 2-3s | `await asyncio.to_thread(...)` |
| 2 | `services/session_collector.py:77` | Sync `httpx.get()` in WebSocket handler blocks up to 10s | Use `httpx.AsyncClient` |
| 3 | `services/collectors.py:35` | `psutil.cpu_freq()` called twice (once for check, once for value) | Cache in variable |
| 4 | `services/service_controller.py` | `time.sleep(3)` in `kill_all_agents` | Use `await asyncio.sleep(3)` if async |

### Pattern Consistency — High (4 issues)

| # | Issue |
|---|-------|
| 1 | **Three competing error response patterns**: `HTTPException` vs `{"success": False, "error": ...}` with 200 vs `{"error": ...}` with 200. Standardize on `HTTPException`. |
| 2 | **Inconsistent auth**: some routes use `require_admin`, others have zero auth, with no documented policy |
| 3 | **Global mutable state injection**: `_thing = None; def set_thing(t): global _thing; _thing = t` in 6 route files — use FastAPI `Depends()` or `app.state` |
| 4 | **Mix of sync/async handlers** without clear reasoning |

### Code Quality — High (3 issues)

| # | File | Lines | Issue |
|---|------|-------|-------|
| 1 | `services/task_processor.py` | 700+ | Covers task CRUD, email, audit, sessions, files, registry, agents — violates SRP |
| 2 | `background/scheduler.py` | `_build_evolve_html()` | 80+ lines of inline HTML email template |
| 3 | `routes/action_items.py` | 775+ | Source aggregation, scoring, dispatch all in one file |

### Type Safety — High (3 issues)

| # | File:Line | Issue |
|---|-----------|-------|
| 1 | `routes/tasks.py:104,151,525` | `data: dict = Body(...)` — zero Pydantic validation on 3 critical endpoints |
| 2 | Multiple files | Missing return type annotations on all public service functions |
| 3 | 6 route files | `set_detector(detector)` with no type hint — silently accepts any type |

---

## 4. Brain / HELM / DAM

81 files reviewed, 30 issues found.

### Critical (6 issues)

All covered in Section 1 above: missing auth on YouTube/Instagram/DAM routes, Stripe webhook signature bypass, vault path traversal, PostgREST injection.

### High (6 issues)

| # | File:Line | Category | Issue | Fix |
|---|-----------|----------|-------|-----|
| 1 | `opai-brain/config.py:23` | Security | Admin UUID hardcoded in source | Use `os.getenv("BRAIN_ADMIN_USER_ID")` |
| 2 | `opai-helm/core/vault.py:10` | Error Handling | Empty `VAULT_KEY` crashes with opaque `ValueError` | Validate at startup with clear error |
| 3 | `opai-helm/connectors/hostinger.py:168` | Security | VPS IP `72.60.115.74` hardcoded | Use env var |
| 4 | `opai-helm/routes/onboarding.py:29` | Quality | Hardcoded absolute template path | Derive from config |
| 5 | `opai-dam/core/pipeline.py:246-247` | Error Handling | `except Exception: pass` in pipeline logging — invisible failures | Log at warning level |
| 6 | `opai-dam/routes/sessions.py:61-65` | Security | User impersonation via body parameter + admin fallback | Remove `body.get("user_id")` fallback |

### Medium (11 issues)

| # | Category | Issue | Files |
|---|----------|-------|-------|
| 1 | DRY | Supabase helpers (`_sb_get/post/patch/delete`) copy-pasted across **14 Brain route files** with subtle variations | All `opai-brain/routes/*.py` |
| 2 | Performance | New `httpx.AsyncClient` created per request — no connection pooling | All 3 services |
| 3 | Type Safety | Missing type hints on all DAM and HELM supabase helper functions | `core/supabase.py` in both |
| 4 | Error Handling | Silent `except Exception: pass` in Brain `nodes.py` (tag ops) and `tier.py` (quota check returns 0 on error — fail-open) | `nodes.py:188,231,241`, `tier.py:62` |
| 5 | Security | String prefix path traversal check instead of `Path.is_relative_to()` | `brain/routes/nodes.py:153` |
| 6 | Type Safety | No UUID validation on path parameters across all services | All route files |
| 7 | Resources | Anthropic client created per call, never closed | `helm/core/ai.py:185` |
| 8 | Concurrency | Global mutable caches without `asyncio.Lock` | `helm/connectors/hostinger.py:41`, `dam/core/executor.py:22` |
| 9 | Performance | SSE stream polls DB every 2s with 3 queries per tick | `dam/routes/stream.py:27-75` |
| 10 | Type Safety | All DAM routes use raw `request.json()` instead of Pydantic models | 6 DAM route files |
| 11 | Quality | `config` parameter shadows module-level `import config` in 4 DAM executor functions | `dam/core/executor.py:155,164,178,189` |

---

## 5. BX4 / WordPress / Vault / Billing

73 files reviewed, 52 issues found.

### Critical (6 issues)

| # | File | Issue |
|---|------|-------|
| 1 | `opai-vault/migrate_credentials.py:39-320` | ~70 plaintext credentials in source (covered in Section 1) |
| 2 | `opai-vault/config.py:44` | AGE public key as default value (covered in Section 1) |
| 3 | `opai-wordpress/routes_sites.py:113-128` | WordPress passwords stored as plaintext in Supabase |
| 4 | `opai-wordpress/routes_sites.py:218-226` | Credentials endpoint returns plaintext passwords with no secondary confirmation |
| 5 | `opai-bx4/routes/financial.py:~458` | Stripe secret keys stored as plaintext in Supabase |
| 6 | `opai-vault/routes_auth.py:228,246,308,325` | WebAuthn challenges keyed by IP — shared proxy IP enables hijack |

### High (10 issues)

| # | File:Line | Category | Issue |
|---|-----------|----------|-------|
| 1 | `opai-vault/store.py:70-84,116-130` | Security | Plaintext secrets written to temp files during SOPS encryption — crash = cleartext on disk |
| 2 | `opai-billing/routes_webhooks.py:119` | Security | Full Python exception strings returned to Stripe in webhook responses |
| 3 | `opai-wordpress/routes_automation.py:710-740` | Security | Connector secret appears 3 times in response body |
| 4 | `opai-vault/routes_user_vault.py:52-59` | Security | Service key sent as `apikey` header in user-scoped requests |
| 5 | `opai-wordpress/services/connection_agent.py:26-28` | Security | Mixed auth header patterns (anon key + service key) across all WP routes |
| 6 | `opai-wordpress/services/connection_agent.py:~181` | Security | HITL report filenames from user input — path traversal |
| 7 | `opai-vault/routes_user_vault.py:94-95` | Error Handling | `except Exception: pass` on audit logging — broken auditing invisible |
| 8 | `opai-billing/routes_api.py:253-254` | Error Handling | Silent Stripe error on product archival — DB/Stripe inconsistency |
| 9 | `opai-billing/routes_subscriptions.py:143-145` | Error Handling | Silent Stripe error on subscription cancellation — DB shows canceled, Stripe still active |
| 10 | `opai-bx4/connectors/stripe.py:241` | Python/Async | Sync `requests` library blocks event loop in async context |

### Medium (21 issues)

Key themes:
- **Massive DRY violation**: Supabase helpers duplicated across **15+ route files** (~1500 lines of copy-paste) in BX4 and WordPress
- **`_parse_recommendations()`** duplicated across 4 BX4 wing files
- **5 files over 500 lines**: `deployer.py` (844), `routes_automation.py` (799), `routes_sites.py` (797), `financial.py` (688), `routes_auth.py` (512)
- **File-based stores** (`auth_store.py`, `audit.py`) have TOCTOU race conditions — no file locking
- **App-level user filtering** instead of RLS enforcement in vault
- **Synchronous Anthropic client** in async BX4 advisor — blocks event loop for 10-60s per Claude call
- **`object.__new__()`** used to bypass constructors in `site_manager.py`
- **Bizarre `chr()` calls** in `bx4/routes/social.py:37-38` — `chr(63)` instead of `?`, `chr(0)` null bytes
- **No rate limiting** on public checkout endpoint (`opai-billing/routes_checkout.py:63`)

---

## 6. Shell Scripts & Caddyfile

42 shell scripts + 1 Caddyfile reviewed, 48 issues found.

### Critical (6 issues)

Hardcoded credentials covered in Section 1 plus:

| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|
| 1 | `opai-vault/scripts/vault-cli.sh:69-76` | Shell injection: `$NAME`/`$VALUE` interpolated into inline Python | Pass via environment variables |
| 2 | `scripts/supabase-sql.sh:113-115` | SQL injection in `describe_table` | Validate table name with `^[a-zA-Z_][a-zA-Z0-9_]*$` |
| 3 | `scripts/tg-notify.sh:27-29` + others | Telegram chat IDs and personal email hardcoded across multiple scripts | Move to shared config |

### High (8 issues)

| # | Issue | Files Affected |
|---|-------|----------------|
| 1 | **Missing `set -euo pipefail`** in 16 scripts | `opai-control.sh`, `install-services.sh`, `claude-*.sh`, `discord-bridge/start-bot.sh`, `entrypoint.sh`, `migrate-tailsync-to-user-service.sh` (no strict mode at all), and 10 more |
| 2 | **Hardcoded IPs** in 6 scripts | `setup-nfs.sh` (NAS IP), `web-fetch-fallback.sh` (proxy IPs), `deploy-bb-vps.sh` (VPS IP) |
| 3 | **Temp files without `trap ... EXIT` cleanup** | `familiarize.sh`, `run_agents.sh`, `run_builder.sh`, `run_auto.sh`, `run_squad.sh` — 6 scripts |
| 4 | **`cat file \| command`** anti-pattern masks exit codes | 10 instances across `run_*.sh` scripts — use `< "$file"` redirect |
| 5 | **`eval` on decrypted vault output** | `mcp-with-vault.sh:20` — shell metacharacters in vault values would execute |
| 6 | **Inline Python with unquoted variable interpolation** | `migrate.sh`, `provision-sandbox.sh`, `run_agents.sh`, `vault-cli.sh` — 4 scripts |
| 7 | **`git add -A`** in automated daily sync | `daily-git-push.sh:87` — stages everything including potential secrets |
| 8 | **`export $(grep ... \| xargs)`** unsafe | `oc-control.sh:62` — special characters in env values can execute commands |

### Caddyfile

| # | Issue | Severity |
|---|-------|----------|
| 1 | No rate limiting on any endpoint | Medium |
| 2 | No `request_body { max_size }` limit | Medium |
| 3 | Internal API block pattern potentially bypassable via URL encoding | Medium |

---

## 7. TypeScript / React / Frontend

5 projects reviewed, 47 issues found.

### Critical (8 issues)

| # | File | Issue |
|---|------|-------|
| 1 | `OPAI Mobile/constants/config.ts:3-5` | Hardcoded Supabase URL and anon key |
| 2 | `Hostinger File Manager/src/App.jsx:37,172,204` | Hardcoded `localhost:3001` API URLs |
| 3 | `Hostinger File Manager/src/context/ThemeContext.jsx` | 4 more hardcoded localhost URLs |
| 4 | `Portal/static/js/auth.js:32-37` | `OPAI_AUTH_DISABLED` flag bypasses all auth |
| 5 | `Portal/static/js/auth.js:87-94` | Fail-open: fetch error = access granted |
| 6 | `Portal/static/js/navbar.js:352-354` | XSS: `innerHTML` with unsanitized `img.name` from user file input |
| 7 | `SCC IDE/src/renderer/components/chat/ChatArea.tsx:272` | **Bug**: `String(data)` references undeclared variable — should be `rawData` |
| 8 | `White-Noise/src/hooks/usePurchases.ts:7-8` | Placeholder RevenueCat API keys will silently fail in production |

### High (14 issues)

| # | Category | Issue | File |
|---|----------|-------|------|
| 1 | React | Non-null assertion on `session!.user.id` — race condition crash | `authStore.ts:40` |
| 2 | React | Non-null assertions on `SecureStore!` — crashes if platform check fails | `storage.ts:13,20,27` |
| 3 | React | Stale closure in `fadeOut` callback — `volume` captured at wrong time | `AudioContext.tsx:199-227` |
| 4 | React | `useEffect` cleanup captures initial `null` sound — never unloads audio | `AudioContext.tsx:34-53` |
| 5 | React | Missing effect dependencies in `useNotifications.ts:48` and `_layout.tsx:36` | Mobile app |
| 6 | Quality | `App.jsx` is **640 lines** with 20+ `useState` calls | Hostinger File Manager |
| 7 | Quality | `main/index.ts` is **1055 lines** — all Electron logic in one file | SCC IDE |
| 8 | Quality | `ChatArea.tsx` is **699 lines** with 15+ `useRef` declarations | SCC IDE |
| 9 | TypeScript | Zero TypeScript in Hostinger File Manager — all `.jsx`/`.js` | Entire project |
| 10 | TypeScript | Zero TypeScript in Portal — all vanilla JS | Entire project |
| 11 | Security | `sandbox: false` in Electron `webPreferences` | `main/index.ts:105` |
| 12 | Security | `auth.js` and `auth-v3.js` are **identical 226-line files** — bugs must be fixed in two places | Portal |
| 13 | Quality | `navbar.js` is **525 lines** — all logic in single IIFE | Portal |
| 14 | Quality | No React error boundaries anywhere in Hostinger File Manager | Entire project |

### TypeScript `any` Usage — Pervasive

**22 instances of `catch (e: any)`** across OPAI Mobile stores:

| Store | Count |
|-------|-------|
| `commandStore.ts` | 9 |
| `tasksStore.ts` | 7 |
| `monitorStore.ts` | 3 |
| `chatStore.ts` | 1 |
| `authStore.ts` | 1 |
| `usePurchases.ts` | 1 |

**Fix:** Create a shared utility: `function getErrorMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }`

Additional `any` usage: `api.get<any>(...)` (5 instances), `(item: any)` in map callbacks (4 instances), `as any` casts (3 instances), `let db: any` in SCC IDE.

---

## 8. Cross-Cutting Patterns

### 8.1 Silent Error Swallowing — Systemic

**40+ instances** of `except Exception: pass` across the codebase. Most problematic locations:

| Location | Impact |
|----------|--------|
| Audit logging (vault, bx4, engine) | Broken auditing invisible for days |
| Stripe operations (billing) | DB/Stripe state divergence |
| Tier quota checks (brain) | Users exceed quotas (fail-open) |
| Pipeline logging (dam) | Invisible execution failures |
| WebSocket handlers (engine) | Real errors masked by disconnect catch |

**Recommendation:** Establish a project-wide rule: **no `except Exception: pass` without at minimum `logger.warning()`**. Enforce with a linter rule.

### 8.2 Supabase Helper Duplication — Massive DRY Violation

The same `_sb_get()`, `_sb_post()`, `_sb_patch()`, `_sb_delete()` functions are copy-pasted across **30+ route files** with subtle variations (different timeouts, different `Prefer` headers). Estimated **3000+ lines of duplicated code**.

| Service | Files with duplicated helpers |
|---------|-------------------------------|
| Brain | 14 route files |
| BX4 | 8 route files |
| WordPress | 7 route files |
| Engine | 2 route files |

**Recommendation:** Create `{service}/core/supabase.py` (which HELM and DAM already have) for each service. Single source of truth.

### 8.3 `httpx.AsyncClient` Per-Request Anti-Pattern

Nearly every Supabase call across the entire codebase creates and destroys a new `httpx.AsyncClient`. This means:
- No TCP connection reuse
- No keep-alive
- Repeated TLS handshakes
- ~50-100ms added latency per request

**Recommendation:** Create a shared client in each app's lifespan event:
```python
async def lifespan(app):
    app.state.http = httpx.AsyncClient(timeout=15)
    yield
    await app.state.http.aclose()
```

### 8.4 Hardcoded Absolute Paths

`/workspace/synced/opai` appears hardcoded in:
- `opai-vault/config.py:10`
- `scc-ide/src/main/index.ts:16`
- `opai-vault/scripts/vault-cli.sh:18`
- `opai-helm/routes/onboarding.py:29`
- `scripts/test-agent-task-flow.sh:29-33`
- Multiple other scripts and configs

**Recommendation:** Derive from `__file__` or `BASH_SOURCE[0]` in all cases. Use `OPAI_ROOT` env var as fallback.

### 8.5 `sys.path.insert` Repeated Everywhere

Nearly every route file across Brain, HELM, DAM, BX4, and WordPress starts with:
```python
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
```

**Recommendation:** Set up proper Python packaging with `pyproject.toml`, or do the `sys.path` insert once in each `app.py`.

---

## 9. Scorecard

| Category | Grade | Summary |
|----------|-------|---------|
| **Code Quality** | **D+** | 5+ files over 500 lines (one at 1055), massive DRY violations (3000+ duplicated lines), magic numbers throughout, 40+ silent exception swallows |
| **Pattern Consistency** | **D** | Three competing error response patterns, inconsistent auth enforcement, inconsistent Supabase helper naming across services, mixed sync/async without clear rules, `sys.path.insert` in every file |
| **Error Handling** | **D** | 40+ instances of `except Exception: pass`, fail-open patterns in auth and quota checks, Stripe operations silently fail leaving DB/payment state inconsistent, no error boundaries in frontend |
| **Type Safety** | **C-** | 22 `catch (e: any)` in TypeScript, raw `dict` request bodies instead of Pydantic models, missing return types on most Python public functions, `callable` (lowercase) as type hint, 2 entire projects without TypeScript |
| **Security** | **F** | ~70 plaintext credentials in source, 20+ unauthenticated write endpoints, path traversal vulnerabilities, SQL/PostgREST injection, shell injection, XSS via innerHTML, fail-open auth, unsigned webhook acceptance, plaintext credential storage in DB |
| **Python Patterns** | **D+** | Blocking sync calls in async contexts (6 instances), `asyncio.get_event_loop()` (deprecated), subprocess-based vault access, per-request httpx clients, file-based stores without locking |
| **Bash Patterns** | **D** | 16 scripts missing strict mode, hardcoded credentials in 4 scripts, shell injection in vault CLI, SQL injection in SQL runner, no trap cleanup on temp files, unsafe eval/export patterns |

### Overall Grade: **D**

The architecture and ambition are impressive, but the codebase has accumulated critical security debt that must be addressed before any external exposure. The three highest-impact action items:

1. **Rotate all credentials** in `migrate_credentials.py` and shell scripts, then delete the file
2. **Add authentication** to all 20+ unprotected write endpoints
3. **Extract duplicated Supabase helpers** into shared modules (eliminates ~3000 lines and inconsistency)