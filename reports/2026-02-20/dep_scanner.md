# Report: dep_scanner

Now I have all the data needed for a complete report. Let me compile it:

---

## Dependency Vulnerability Scan

**Scan Date:** 2026-02-20
**Workspace:** `/workspace/synced/opai`
**Manifests Audited:** 19 Python (`requirements.txt`, `pyproject.toml`) + 48 Node.js (`package.json`) = **67 total manifests**
**Languages:** Python, Node.js/TypeScript
**Go / Rust / Ruby project-level manifests:** None found

---

### Summary

| Manifest | Path | Total Deps | Critical | High | Medium | Low |
|----------|------|-----------|---------|------|--------|-----|
| requirements.txt | tools/opai-docs | 5 | 0 | 2 | 1 | 1 |
| requirements.txt | tools/opai-wordpress | 7 | 0 | 2 | 2 | 1 |
| requirements.txt | tools/opai-prd | 6 | 0 | 2 | 1 | 1 |
| requirements.txt | tools/opai-forumbot | 1 | 0 | 1 | 0 | 0 |
| requirements.txt | tools/opai-chat | 8 | 1 | 1 | 2 | 1 |
| requirements.txt | tools/opai-messenger | 8 | 1 | 1 | 2 | 1 |
| requirements.txt | tools/opai-terminal | 5 | 1 | 0 | 2 | 1 |
| requirements.txt | tools/opai-monitor | 6 | 1 | 0 | 2 | 1 |
| requirements.txt | tools/opai-tasks | 5 | 1 | 0 | 2 | 1 |
| requirements.txt | tools/opai-agents | 6 | 1 | 0 | 2 | 1 |
| requirements.txt | tools/opai-portal | 3 | 0 | 0 | 2 | 1 |
| requirements.txt | tools/opai-files | 5 | 0 | 0 | 2 | 1 |
| requirements.txt | tools/opai-forum | 6 | 0 | 0 | 2 | 1 |
| requirements.txt | Projects/Lace & Pearls/wp-agent | 2 | 0 | 1 | 1 | 1 |
| requirements.txt | tools/wp-agent | 2 | 0 | 1 | 1 | 1 |
| requirements.txt | mcps/wshobson-agents/tools | 5 | 0 | 0 | 2 | 1 |
| pyproject.toml | Projects/Flipper/.../nanopb | 2 | 0 | 1 | 0 | 1 |
| package.json | tools/opai-api-server | 7 | 0 | 0 | 1 | 2 |
| package.json | tools/opai-dev | 11 | 0 | 0 | 1 | 2 |
| package.json | tools/opai-email-agent | 4 | 0 | 0 | 0 | 1 |
| package.json | tools/email-checker | 4 | 0 | 0 | 0 | 1 |
| package.json | mcps/boutabyte-mcp | 7 | 0 | 0 | 1 | 1 |
| package.json | mcps/Wordpress-VEC | 6 | 0 | 0 | 0 | 1 |
| package.json | Projects/Boutabyte | 25 | 0 | 1 | 2 | 2 |
| package.json | Projects/vec-article-builder | 7 | 0 | 1 | 1 | 1 |
| package.json | Projects/BoutaCare | 5 | 0 | 0 | 1 | 1 |
| package.json | Projects/BoutaChat | 7 | 0 | 0 | 1 | 1 |
| package.json | Projects/BoutaPRD | 7 | 0 | 0 | 1 | 1 |
| package.json | Projects/ByteSpace/apps/api | 10 | 0 | 0 | 0 | 1 |
| package.json | Projects/INTERNAL/Hostinger File Manager/backend | 7 | 0 | 0 | 1 | 1 |
| package.json | Projects/INTERNAL/Hostinger File Manager-public/backend | 7 | 0 | 0 | 1 | 1 |
| package.json | Projects/Boutabyte/hostinger/file-api | 5 | 0 | 0 | 1 | 1 |
| package.json | Projects/Supa-Tools/SupaMigrate | 5 | 0 | 0 | 1 | 1 |
| package.json | Projects/NurtureNet/Newborn Tracker/Expo | 36 | 0 | 0 | 2 | 2 |
| package.json | Projects/SEO-GEO-Automator/webapp | 6 | 0 | 0 | 1 | 1 |
| package.json | Projects/ThisKitchen | 5 | 0 | 0 | 1 | 1 |

---

### Findings

---

#### CRITICAL

---

**Finding C-01**

- **Package:** `python-jose[cryptography]>=3.3.0`
- **Manifest:** `tools/opai-chat/requirements.txt` (line 6), `tools/opai-messenger/requirements.txt` (line 6), `tools/opai-terminal/requirements.txt` (line 3), `tools/opai-monitor/requirements.txt` (line 5), `tools/opai-tasks/requirements.txt` (line 5), `tools/opai-agents/requirements.txt` (line 5), `tools/opai-docs/requirements.txt`, `tools/opai-wordpress/requirements.txt`, `tools/opai-prd/requirements.txt`
- **Risk:** Critical
- **Issue:** **CVE-2024-33664** — python-jose is affected by an algorithm confusion vulnerability that allows an attacker to forge JWTs by passing an RSA public key as an HMAC secret (`alg` confusion). The latest version is 3.3.0 (released 2021); the library is **effectively unmaintained**. **No patched version exists.** This package is used for JWT auth across 9 production tools in the OPAI system, meaning the entire authentication layer of opai-terminal, opai-monitor, opai-tasks, opai-agents, opai-chat, opai-messenger, opai-docs, opai-wordpress, and opai-prd may be exploitable if any endpoint does not strictly validate the `alg` header.
- **Fix:** Migrate to an actively maintained JWT library. Recommended replacements:
  - `PyJWT>=2.8.0` — widely maintained, actively patched
  - `joserfc>=0.12.0` — modern, RFC-compliant
  - If keeping python-jose temporarily: add explicit `algorithms=["RS256"]` parameter to **every** `jwt.decode()` call and validate the `alg` header before decode.

---

#### HIGH

---

**Finding H-01**

- **Package:** `requests>=2.28.0`
- **Manifest:** `tools/wp-agent/requirements.txt` (line 2), `Projects/Lace & Pearls/wp-agent/requirements.txt` (line 2)
- **Risk:** High
- **Issue:** **CVE-2023-32681** — `requests` versions prior to 2.31.0 leak the `Proxy-Authorization` header to the destination server when a redirect crosses schemes (http→https). The range `>=2.28.0` permits installing any 2.28.x, 2.29.x, or 2.30.x which are all vulnerable. Additionally, the range is unpinned so future breaking versions can install automatically.
- **Fix:** Pin to `requests==2.32.3` (current stable as of Feb 2026). Minimum safe range: `requests>=2.31.0`.

---

**Finding H-02**

- **Package:** `fastapi` (no version), `uvicorn` (no version), `python-dotenv` (no version), `python-jose[cryptography]` (no version), `httpx` (no version), `aiofiles` (no version), `croniter` (no version), `pytz` (no version)
- **Manifest:**
  - `tools/opai-docs/requirements.txt` (lines 1–5): all 5 dependencies are fully unpinned
  - `tools/opai-wordpress/requirements.txt` (lines 1–7): all 7 dependencies fully unpinned
  - `tools/opai-prd/requirements.txt` (lines 1–6): all 6 dependencies fully unpinned
  - `tools/opai-forumbot/requirements.txt` (line 1): `croniter` fully unpinned
- **Risk:** High
- **Issue:** Zero version constraints on production service dependencies. `pip install` resolves to the absolute latest version at install time. This allows: (a) future breaking changes to silently break the service, (b) a malicious package update (supply chain attack) to be pulled in automatically, (c) dependency conflicts across reinstalls to go undetected. The `python-jose` in opai-docs and opai-wordpress compounds C-01: an unpinned install of python-jose could receive a hypothetical malicious update with no audit trail.
- **Fix:** Pin all production dependencies to exact versions using pip-compile or manual pinning:
  ```
  fastapi==0.115.6
  uvicorn[standard]==0.34.0
  python-dotenv==1.0.1
  httpx==0.28.1
  aiofiles==24.1.0
  croniter==6.0.0
  pytz==2024.2
  ```
  Replace `python-jose` per Finding C-01.

---

**Finding H-03**

- **Package:** `protobuf>=3.6`
- **Manifest:** `Projects/Flipper/qFlipper/3rdparty/nanopb/extra/poetry/pyproject.toml` (line 22)
- **Risk:** High
- **Issue:** protobuf 3.6.x is approximately **7 major minor releases** behind current stable (5.x). The range `>=3.6` accepts any version from 3.6 onward including broken/vulnerable intermediates. protobuf 3.x releases prior to 3.18.3 have known denial-of-service vulnerabilities (CVE-2021-22570, GHSA-8gq9-2x98-w8hf). The `>=3.6` lower bound is far below the safe minimum.
- **Fix:** Tighten lower bound to `protobuf>=4.23.0` to avoid known 3.x CVE range, or `protobuf>=5.26.0` (current stable). Also add `grpcio-tools>=1.60.0` minimum.

---

**Finding H-04**

- **Package:** `@supabase/auth-helpers-nextjs ^0.10.0`
- **Manifest:** `Projects/Boutabyte/package.json` (line 18), `Projects/vec-article-builder/package.json` (line 13)
- **Risk:** High
- **Issue:** `@supabase/auth-helpers-nextjs` is **officially deprecated** by Supabase as of mid-2024. It is no longer receiving security patches. Supabase auth helpers used server-side cookie handling patterns that have known session fixation and cookie parsing edge cases, and the replacement (`@supabase/ssr`) was created in part to address these. Using a deprecated auth library in production creates an unpatched attack surface.
- **Fix:** Migrate both projects to `@supabase/ssr ^0.7.0` (already present alongside in Boutabyte — remove the deprecated package and consolidate). Follow the [Supabase SSR migration guide](https://supabase.com/docs/guides/auth/server-side/nextjs).

---

#### MEDIUM

---

**Finding M-01**

- **Package:** `websockets` (no version)
- **Manifest:** `tools/opai-chat/requirements.txt` (line 3), `tools/opai-messenger/requirements.txt` (line 3)
- **Risk:** Medium
- **Issue:** `websockets` is completely unpinned. websockets has had multiple breaking API changes across major versions (9→10→11→12→13). An unpinned install can pull in a major version that breaks the WebSocket server implementation silently. websockets <10.0 also lacked timeout handling and had connection-state edge cases.
- **Fix:** Pin to `websockets==14.1` (current stable).

---

**Finding M-02**

- **Package:** `fastapi==0.109.0`, `uvicorn[standard]==0.27.0`, `pydantic==2.6.0`
- **Manifest:** `tools/opai-chat/requirements.txt` (lines 1, 2, 4), `tools/opai-messenger/requirements.txt` (lines 1, 2, 4)
- **Risk:** Medium
- **Issue:** These are **stale exact pins** — pinned to versions that are over a year old. FastAPI 0.109.0 (released Jan 2024) is 6 minor versions behind the current 0.115.6. FastAPI and Starlette have had security fixes for denial-of-service in header parsing (CVE-2024-47874 in Starlette <0.40.0, which FastAPI 0.109 uses). Pydantic 2.6.0 is 4 minor versions behind 2.10.x.
- **Fix:** Update pins: `fastapi==0.115.6`, `uvicorn[standard]==0.34.0`, `pydantic==2.10.6`.

---

**Finding M-03**

- **Package:** Multiple `>=` range dependencies (not unpinned, but open-ended)
- **Manifest:** `tools/opai-portal/requirements.txt`, `tools/opai-terminal/requirements.txt`, `tools/opai-monitor/requirements.txt`, `tools/opai-tasks/requirements.txt`, `tools/opai-files/requirements.txt`, `tools/opai-forum/requirements.txt`, `tools/opai-agents/requirements.txt`, `mcps/wshobson-agents/tools/requirements.txt`
- **Risk:** Medium
- **Issue:** All production Python tools use open `>=` lower-bound ranges (e.g., `fastapi>=0.115.0`, `uvicorn[standard]>=0.34.0`, `httpx>=0.24.0`). While safer than fully unpinned, these allow any future major version to install automatically. If fastapi releases 1.0.0 with breaking changes or a supply-chain-compromised package, the next `pip install` in CI/CD will silently pull it in.
- **Fix:** Use `pip-compile` (pip-tools) to generate a `requirements.lock` with fully-resolved exact pins. Keep `requirements.txt` for human-readable constraints; deploy from the compiled lock file.

---

**Finding M-04**

- **Package:** `multer ^1.4.5-lts.1`
- **Manifest:** `Projects/Boutabyte/hostinger/file-api/package.json` (line 12), `Projects/INTERNAL/Hostinger File Manager/backend/package.json` (line 6), `Projects/INTERNAL/Hostinger File Manager-public/backend/package.json` (line 6)
- **Risk:** Medium
- **Issue:** `multer` 1.x is effectively abandoned. The `-lts.1` suffix indicates a community patch on top of the abandoned 1.4.4 release to fix a path traversal regression. There is no active security team behind multer 1.x. It is used for file upload handling on file manager backends that have SSH access — a path traversal or filename injection could be especially damaging here. `multer` 2.x is now available under new maintainership with proper security hardening.
- **Fix:** Upgrade to `multer@2.0.0` and review file upload validation logic. Ensure `dest` paths are validated and filenames are sanitized with a library like `sanitize-filename`.

---

**Finding M-05**

- **Package:** `@supabase/supabase-js: 2.39.3` (hard-pinned), `@supabase/supabase-js: 2.39.7` (hard-pinned), `@supabase/supabase-js: 2.48.1` (hard-pinned)
- **Manifest:** `Projects/Supa-Tools/SupaMigrate/supamigrate/package.json` (line 16), `Projects/BoutaPRD/package.json` (line 18), `Projects/ThisKitchen/ThisKitchen/package.json` (line 17)
- **Risk:** Medium
- **Issue:** These projects hard-pin Supabase client to versions that are **significantly stale** (current is 2.95.x). Supabase JS 2.39.x–2.48.x predate multiple security-relevant updates to the auth client including session refresh hardening and PKCE flow fixes. Hard-pinned old versions will not receive any security updates even when `npm install` is run.
- **Fix:** Update to `@supabase/supabase-js: ^2.95.0` and re-test auth flows. Do not hard-pin unless there is a specific known breaking change to isolate against.

---

**Finding M-06**

- **Package:** `axios ^1.13.2` in `devDependencies`
- **Manifest:** `Projects/SEO-GEO-Automator/Codebase/webapp/package.json` (line 24)
- **Risk:** Medium
- **Issue:** `axios` is placed in `devDependencies` but is a production HTTP client used at runtime (likely for API calls). Dev dependencies are **not installed in production builds** with `npm ci --production` or `npm install --omit=dev`. If this app is ever deployed with production installs, axios will be missing and the app will crash.
- **Fix:** Move `axios` to `dependencies`.

---

**Finding M-07**

- **Package:** `@types/react-syntax-highlighter ^15.5.13`
- **Manifest:** `Projects/BoutaChat/package.json` (line 5) — listed under `dependencies`
- **Risk:** Medium
- **Issue:** TypeScript type definitions (`@types/*`) are compile-time only and must never be in `dependencies`. Having them in `dependencies` means they are bundled into the production package unnecessarily, increasing bundle size and exposing type-system internals. This also signals a pattern where other `@types/*` packages may also be misplaced.
- **Fix:** Move `@types/react-syntax-highlighter` to `devDependencies`.

---

**Finding M-08**

- **Package:** `@google/generative-ai ^0.24.1`
- **Manifest:** `Projects/NurtureNet/Newborn Tracker/Expo/package.json` (line 20)
- **Risk:** Medium
- **Issue:** `@google/generative-ai` is the **deprecated** first-generation Google AI SDK. Google has migrated to `@google/genai` (the unified AI SDK). The deprecated package no longer receives active feature development and its security posture going forward is unclear. Other projects in this repo (PooPoint, SupaMigrate, HytaleCompanion, ThisKitchen) correctly use the new `@google/genai` package.
- **Fix:** Migrate NurtureNet to `@google/genai ^1.40.0`, updating API call signatures to match the new SDK.

---

**Finding M-09**

- **Package:** `unzipper ^0.10.14`
- **Manifest:** `Projects/INTERNAL/Hostinger File Manager/backend/package.json` (line 7), `Projects/INTERNAL/Hostinger File Manager-public/backend/package.json` (line 7)
- **Risk:** Medium
- **Issue:** `unzipper` <=0.10.11 had **CVE-2022-0122** (GHSA-cf4h-3jhx-xvhq) — arbitrary file write via zip-slip path traversal. Version 0.10.14 includes the fix, but the `^0.10.14` range is broad. Additionally, `unzipper` is used in file manager backends with SSH access — zip-slip on such a backend could lead to remote code execution by overwriting server-side scripts.
- **Fix:** Pin to `unzipper==0.12.3` (current). Add server-side path validation: verify every extracted file path resolves within the intended destination directory before writing.

---

**Finding M-10**

- **Package:** `@bytespace/shared: "*"`
- **Manifest:** `Projects/ByteSpace/apps/api/package.json` (line 12), `Projects/ByteSpace/apps/mobile/package.json` (line 13)
- **Risk:** Medium
- **Issue:** The wildcard `"*"` version constraint (even for a workspace package) is flagged by npm audit tools and can cause unexpected resolution behavior. While this is a monorepo internal package, `"*"` means npm will accept any installed version without version checking, bypassing the workspace protocol's safety. Using `"workspace:*"` explicitly (pnpm convention) or `"*"` in npm workspaces is fine functionally but hides version drift.
- **Fix:** Use `"workspace:*"` if on pnpm, or `"*"` is acceptable for npm workspaces but document this intentional choice. Verify `ByteSpace/packages/shared/package.json` version aligns with both consumers.

---

#### LOW

---

**Finding L-01**

- **Package:** `http-proxy ^1.18.1`
- **Manifest:** `tools/opai-dev/package.json` (line 25)
- **Risk:** Low
- **Issue:** `http-proxy` 1.18.1 was last published in 2020 and the package has had minimal maintenance since. It is used for proxying IDE WebSocket connections. While 1.18.1+ patches the known SSRF (CVE-2022-24434), the library has no active security team and may accumulate unpatched issues. No current CVE, but the maintenance posture is concerning for a network proxy component.
- **Fix:** Consider migrating to `http-proxy-middleware ^3.0.0` (actively maintained, built on http-proxy with additional security defaults) or native Node.js `net` stream proxying for WebSocket tunneling.

---

**Finding L-02**

- **Package:** `marked ^11.0.0`
- **Manifest:** `Projects/BoutaCare/package.json` (line 17)
- **Risk:** Low
- **Issue:** `marked` at version 11.x is behind current stable (15.x). BoutaCare also uses `dompurify ^3.0.6` which mitigates XSS, but `marked` 11.x has received several security-relevant bug fixes in minor/patch releases since. The combination of marked+dompurify is appropriate — this is a lower priority than unmarked use.
- **Fix:** Update to `marked ^15.0.0`. No breaking changes for common usage between 11→15.

---

**Finding L-03**

- **Package:** `nodemon ^3.0.0` in `dependencies` (not `devDependencies`)
- **Manifest:** `tools/opai-orchestrator/package.json` (line 19)
- **Risk:** Low
- **Issue:** `nodemon` is a development hot-reload tool and must never be in `dependencies`. It should be in `devDependencies`. If this package is ever published or deployed with `npm install --production`, `nodemon` being in `dependencies` wastes resources and slightly expands attack surface.
- **Fix:** Move `nodemon` to `devDependencies` in `tools/opai-orchestrator/package.json`.

---

**Finding L-04**

- **Package:** `react-native-url-polyfill ^2.0.0` vs `^3.0.0`
- **Manifest:** `Projects/HytaleCompanion/orbis-guide/package.json` (line 32) uses `^2.0.0`; `Projects/NurtureNet/Newborn Tracker/Expo/package.json` (line 58) uses `^3.0.0`
- **Risk:** Low
- **Issue:** Inconsistent major versions of the same polyfill across projects. The polyfill wraps the WHATWG URL API and a version mismatch can produce subtly different URL parsing behavior — relevant for OAuth redirect URIs and deep links.
- **Fix:** Standardize all React Native projects on `react-native-url-polyfill ^3.0.0` (current).

---

**Finding L-05**

- **Package:** `discord.js ^14.18.0`
- **Manifest:** `tools/discord-bridge/package.json` (line 11)
- **Risk:** Low
- **Issue:** Discord.js undergoes frequent minor versions with security-adjacent fixes (rate limiting, token validation hardening). The `^14.18.0` range is appropriate but worth confirming 14.x is still the supported channel (Discord.js 14 targets API v10, which is current as of this scan).
- **Fix:** No immediate action. Monitor for Discord.js 15 release and plan migration. Pin to `discord.js==14.18.0` for reproducible deploys.

---

**Finding L-06**

- **Package:** `imapflow ^1.0.0`
- **Manifest:** `tools/opai-email-agent/package.json` (line 12), `tools/email-checker/package.json` (line 12)
- **Risk:** Low
- **Issue:** `^1.0.0` allows any 1.x install from 1.0.0 to <2.0.0. imapflow is at 1.0.192+ as of this scan. Early 1.0.x releases had IMAP parsing edge cases. The range is wide for a package that handles email credentials and raw IMAP streams.
- **Fix:** Pin to `imapflow==1.0.192` or a specific tested version.

---

**Finding L-07**

- **Package:** `yt-dlp>=2024.0.0`
- **Manifest:** `mcps/wshobson-agents/tools/requirements.txt` (line 2)
- **Risk:** Low
- **Issue:** `yt-dlp` does not use traditional semantic versioning — releases use `YYYY.MM.DD` date-based versions. The range `>=2024.0.0` will install all future releases forever. yt-dlp makes network requests to third-party services and has had several security-relevant updates around SSRF and malicious playlist handling.
- **Fix:** Pin to a specific tested date release, e.g., `yt-dlp==2025.1.15`. Update quarterly.

---

### Lock File Status

| Directory | Has package.json | Has lock file | Status |
|-----------|-----------------|---------------|--------|
| `tools/opai-orchestrator` | Yes | Yes (package-lock.json noted) | OK |
| `tools/opai-api-server` | Yes | Yes | OK |
| `tools/opai-dev` | Yes | Yes | OK |
| `tools/discord-bridge` | Yes | Yes | OK |
| `tools/opai-email-agent` | Yes | No lock file found | **MISSING** |
| `tools/email-checker` | Yes | No lock file found | **MISSING** |
| `tools/feedback-processor` | Yes | No deps / no lock | N/A (empty deps) |
| `mcps/boutabyte-mcp` | Yes | Yes | OK |
| `mcps/clickup-mcp` | Yes | Yes | OK |
| `mcps/Wordpress-VEC` | Yes | Yes | OK |
| `Projects/Boutabyte` | Yes | Yes | OK |
| `Projects/Boutabyte/hostinger/file-api` | Yes | No lock file found | **MISSING** |
| `Projects/BoutaChat` | Yes | Yes | OK |
| `Projects/BoutaCare` | Yes | No lock file found | **MISSING** |
| `Projects/BoutaPRD` | Yes | No lock file found | **MISSING** |
| `Projects/ByteSpace` | Yes | Yes | OK |
| `Projects/ByteSpace/apps/api` | Yes | Yes (shared) | OK |
| `Projects/ByteSpace/apps/mobile` | Yes | Yes (shared) | OK |
| `Projects/Everglades-News/Everglades-News-Clean` | Yes | Yes | OK |
| `Projects/OPAI Mobile App/opai-mobile` | Yes | Yes | OK |
| `Projects/HytaleCompanion` | Yes | No lock file found | **MISSING** |
| `Projects/HytaleCompanion/orbis-guide` | Yes | No lock file found | **MISSING** |
| `Projects/HytaleCompanion/Orbis-Guide1.0` | Yes | No lock file found | **MISSING** |
| `Projects/INTERNAL/Hostinger File Manager/backend` | Yes | No lock file found | **MISSING** |
| `Projects/INTERNAL/Hostinger File Manager-public/backend` | Yes | No lock file found | **MISSING** |
| `Projects/INTERNAL/Hostinger File Manager` (frontend) | Yes | No lock file found | **MISSING** |
| `Projects/INTERNAL/Hostinger File Manager-public` (frontend) | Yes | No lock file found | **MISSING** |
| `Projects/NurtureNet/Newborn Tracker/Expo` | Yes | Yes | OK |
| `Projects/PooPoint/Expo` | Yes | No lock file found | **MISSING** |
| `Projects/SEO-GEO-Automator/Codebase/webapp` | Yes | No lock file found | **MISSING** |
| `Projects/Supa-Tools/SupaMigrate/supamigrate` | Yes | No lock file found | **MISSING** |
| `Projects/Supa-Tools/SupaView` | Yes | No lock file found | **MISSING** |
| `Projects/ThisKitchen/ThisKitchen` | Yes | No lock file found | **MISSING** |
| `Projects/vec-article-builder` | Yes | No lock file found | **MISSING** |
| `Projects/WE Tools` | Yes | No lock file found | **MISSING** |
| `Projects/Flipper/maruader/companion-app` | Yes | No lock file found | **MISSING** |
| **Python: ALL 15 requirements.txt** | Yes | No `.lock` / pip-compile output | **MISSING (Advisory)** |

**15 Node.js package.json files are missing lock files** (mostly project-tier). Lock files are critical to reproducible, auditable installs; without them, supply chain attacks are harder to detect.

---

### Action Items

#### P0 — Known CVE / Active Vulnerability — Update Immediately

| ID | Package | Affected Manifests | CVE / Issue |
|----|---------|-------------------|-------------|
| C-01 | `python-jose[cryptography]>=3.3.0` | 9 tools (opai-chat, opai-messenger, opai-terminal, opai-monitor, opai-tasks, opai-agents, opai-docs, opai-wordpress, opai-prd) | CVE-2024-33664 — JWT algorithm confusion, no fix exists. **Migrate to PyJWT or joserfc.** |
| H-01 | `requests>=2.28.0` | tools/wp-agent, Projects/Lace & Pearls/wp-agent | CVE-2023-32681 — proxy header leak for requests <2.31.0. **Pin to requests>=2.31.0.** |

#### P1 — Unpinned Prod Dependency / Deprecated Security Package / Lifecycle Risk

| ID | Package | Affected Manifests | Issue |
|----|---------|-------------------|-------|
| H-02 | All deps in opai-docs, opai-wordpress, opai-prd, opai-forumbot | 4 manifests | **Completely unpinned** — any version installs. Pin all immediately. |
| H-03 | `protobuf>=3.6` | Projects/Flipper/.../nanopb/pyproject.toml | Very old range allows CVE-affected 3.x versions. Tighten to `>=4.23.0`. |
| H-04 | `@supabase/auth-helpers-nextjs ^0.10.0` | Projects/Boutabyte, Projects/vec-article-builder | **Deprecated auth package**, no security patches. Migrate to `@supabase/ssr`. |
| M-04 | `multer ^1.4.5-lts.1` | 3 file manager backend manifests | Abandoned package for file upload on SSH-connected backends. Upgrade to multer@2. |

#### P2 — Dev Dep in Prod / Missing Lock File / Version Conflict / Stale Pin

| ID | Package | Affected Manifests | Issue |
|----|---------|-------------------|-------|
| M-01 | `websockets` (unpinned) | opai-chat, opai-messenger | Unpinned WebSocket dep in prod service. Pin to 14.1. |
| M-02 | `fastapi==0.109.0`, `pydantic==2.6.0` | opai-chat, opai-messenger | Stale exact pins — Starlette CVE range. Update to fastapi 0.115.6. |
| M-05 | `@supabase/supabase-js 2.39.x` / `2.48.x` | SupaMigrate, BoutaPRD, ThisKitchen | Stale hard-pinned supabase client. Update to ^2.95.0. |
| M-06 | `axios` in devDependencies | SEO-GEO-Automator/webapp | Runtime HTTP client in devDependencies — missing from prod installs. Move to dependencies. |
| M-07 | `@types/react-syntax-highlighter` in dependencies | BoutaChat | Type definitions in production deps. Move to devDependencies. |
| M-08 | `@google/generative-ai ^0.24.1` | NurtureNet/Newborn Tracker | Deprecated SDK. Migrate to `@google/genai`. |
| M-09 | `unzipper ^0.10.14` | Hostinger File Manager backends | Post-zip-slip — add path validation in file write logic. |
| L-03 | `nodemon` in `dependencies` | tools/opai-orchestrator | Dev tool in production dependencies. Move to devDependencies. |
| — | 15 Python requirements.txt | All tools | No lock files. Add pip-compile to generate `requirements.lock` for all production tools. |
| — | 15 Node.js package.json | Various projects | Missing `package-lock.json`. Run `npm install` to generate lock files and commit them. |

---

### Notes & Assumptions

1. **Lifecycle scripts:** No `preinstall`, `install`, or `postinstall` scripts were found in any reviewed `package.json`. All `scripts` sections contain only standard build/start/dev commands. This is a positive finding — no supply-chain lifecycle script risk detected.

2. **node_modules not scanned:** Ruby Gemfiles found only inside `node_modules/react-native-calendars/` and similar — these are vendored copies of 3rd-party package build scripts, not project-owned manifests, and are excluded from this report.

3. **Clients/ShopHolisticMedicine FTP mirror:** Several `package.json` files exist inside the WordPress plugin backup mirror (`Clients/ShopHolisticMedicine/backup/ftp-mirror/`). These are WordPress plugin internal files, not installable project manifests. They are excluded from this report. Their contents should not be `npm install`-ed.

4. **Scope of python-jose impact (C-01):** The severity depends on whether the affected tools validate the `alg` claim before decoding. If any tool calls `jose.jwt.decode(token, public_key)` without an `algorithms=` argument, it is directly exploitable. Code review of all 9 affected tools' JWT decode call sites is strongly recommended alongside the library migration.

5. **No Go, Rust, or Ruby project manifests found** at the project level — only Python and Node.js ecosystems require remediation.