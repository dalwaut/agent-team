# Marq — App Store Publisher Agent

> The marquee — billboard announcing the show. Marq handles the "last mile" of getting production apps through Apple/Google review and onto the stores.

## Overview

Marq is the OPAI tool for app store submission lifecycle management. It automates pre-submission compliance checking, store listing metadata, submission tracking, review monitoring, rejection-to-task relay, and AI review response drafting. Multi-app from day one.

**The gap it fills**: No agentic publisher liaison tool exists. The market is fragmented — Fastlane handles mechanics, Runway is closed SaaS, AppFollow handles reviews only. Marq does the full lifecycle.

## Architecture

| Item | Value |
|------|-------|
| Port | `8103` |
| Path | `/marq/` |
| Service | `opai-marq` |
| Directory | `tools/opai-marq/` |
| Stack | FastAPI + vanilla JS SPA |
| Table prefix | `mrq_` (12 tables) |
| Migration | `config/supabase-migrations/033_marq.sql` |
| Store accounts | Google Play Developer (exists), Apple Developer (TBD) |
| Fastlane | Hybrid — iOS code signing + binary upload only; all else via direct API |

## Database (12 tables)

| Table | Purpose |
|-------|---------|
| `mrq_apps` | App registry (name, slug, bundle ID, package name, platform, status, version) |
| `mrq_app_access` | Multi-user ACL (owner/editor/viewer per app) |
| `mrq_store_credentials` | Encrypted credential refs (vault_key → Fernet-encrypted files) |
| `mrq_metadata` | Store listing per version/locale/store (app_name, description, keywords, etc.) |
| `mrq_screenshots` | Screenshots with dimension validation per device type |
| `mrq_submissions` | Submission lifecycle (12-state: preparing → released/rejected) |
| `mrq_pre_checks` | Individual check results (31 checks, linked to submissions) |
| `mrq_review_events` | Immutable status change log (from webhooks, polling, manual) |
| `mrq_tasks_relay` | Maps rejection events → TeamHub tasks for fix tracking |
| `mrq_review_responses` | AI-drafted review replies with approval gate |
| `mrq_audit_log` | Immutable action log |
| `mrq_schedule` | Polling job config per app (Google/Apple status, reviews, credential verify) |

**RLS helpers**: `mrq_has_access(app_id)`, `mrq_has_role(app_id, role)` — SECURITY DEFINER, uses `get_my_role()` for admin check.

**Seed function**: `mrq_seed_default_schedule(app_id)` — creates 6 default polling jobs per app.

## Key Files

```
tools/opai-marq/
  app.py                    # FastAPI + lifespan (scheduler)
  config.py                 # Env vars, paths
  .env                      # Supabase keys, vault key, internal URLs
  requirements.txt
  core/
    supabase.py             # Async httpx REST helpers (_sb_get/post/patch/delete/rpc)
    vault.py                # Fernet encryption for store credentials
    scheduler.py            # Background polling loop (60s tick)
    checker.py              # Pre-submission check engine (31-check registry)
    checks/                 # Check modules (Phase 2)
      __init__.py           # Imports all 5 modules → registers 31 checks
      legal.py              # 9 legal/privacy checks (all blockers)
      design.py             # 6 design/assets checks (mixed)
      metadata.py           # 5 metadata checks (all warnings)
      technical.py          # 6 technical checks (mixed)
      safety.py             # 5 safety/compliance checks (mixed)
    claude_cli.py           # Claude CLI subprocess helper (async)
    metadata_builder.py     # AI metadata gen from doc folder (reads README/PRD/CHANGELOG)
    teamhub.py              # TeamHub integration (folder/list/task CRUD via Supabase + internal API)
    translator.py           # Rejection-to-task AI translation (guideline mapping, priority, fix steps)
  connectors/
    apple.py                # App Store Connect API v3 (JWT/ES256, JSON:API, full CRUD)
    google.py               # Google Play Developer API v3 (OAuth2 service account, Edits workflow)
    fastlane.py             # Fastlane CLI wrapper — iOS binary upload + code signing only
  routes/
    health.py               # /health + /api/health
    apps.py                 # App CRUD + access check
    metadata.py             # Metadata CRUD (full editor)
    submissions.py          # Submission lifecycle + store workflow (push-metadata, submit-to-store)
    checks.py               # Pre-check runner + results storage + auto-fix engine (6 AI fixers)
    screenshots.py          # Screenshot/icon upload, serve, reorder, delete, import-from-path
    reviews.py              # Review monitoring + response approval
    webhooks.py             # Apple webhook receiver (scaffolded)
    credentials.py          # Store credential vault management
    schedule.py             # Polling schedule config
  static/
    index.html              # SPA shell with 6 tabs
    style.css               # Dark theme, checks, metadata, credentials, assets, store status styles
    js/app.js               # SPA core (routing, API helpers, state, file picker)
    js/dashboard.js         # App list, detail view, credential management, store status, edit/delete app, audit log
    js/checks.js            # Pre-check report (grouped, expandable, score ring, action links, auto-fix buttons)
    js/assets.js            # Asset management (icon, screenshots per device type, feature graphic, OPAI file picker)
    js/metadata.js          # Metadata editor + submissions (workflow actions)
    js/reviews.js           # Review dashboard, star distribution, AI drafting, approval gate, events
```

## API Endpoints

### Apps
- `GET /api/apps` — List accessible apps
- `GET /api/apps/:id` — Get app with recent submissions
- `POST /api/apps` — Create app (auto-creates owner access + default schedule)
- `PATCH /api/apps/:id` — Update app
- `DELETE /api/apps/:id` — Delete app (owner only)
- `GET /api/apps/:id/submissions` — List submissions
- `GET /api/apps/:id/audit` — Audit log
- `POST /api/apps/:id/setup-teamhub` — Create TeamHub folder structure for app
- `GET /api/apps/:id/task-relays` — List rejection→task relay records

### Metadata
- `GET /api/apps/:id/metadata` — List metadata entries
- `POST /api/apps/:id/metadata` — Create or update metadata (upserts on app+version+locale+store)
- `PATCH /api/metadata/:id` — Update metadata
- `DELETE /api/metadata/:id` — Delete metadata
- `POST /api/apps/:id/generate-metadata` — AI-generate from project docs (returns draft)

### Assets
- `GET /api/apps/:id/screenshots` — List screenshots
- `POST /api/apps/:id/screenshots` — Upload screenshot (multipart: file + store + device_type + locale + display_order)
- `POST /api/apps/:id/icon` — Upload app icon (PNG)
- `POST /api/apps/:id/import-from-path` — Import image from OPAI filesystem path (icon, screenshot, or feature graphic)
- `GET /api/assets/:path` — Serve uploaded asset files (access-checked)
- `PATCH /api/screenshots/:id/reorder` — Swap display_order with neighbor
- `DELETE /api/screenshots/:id` — Delete screenshot + file from disk

### Pre-Checks
- `POST /api/apps/:id/run-checks` — Run all checks (optionally link to submission)
- `GET /api/submissions/:id/checks` — Get check results
- `POST /api/apps/:id/auto-fix/:check_id` — Auto-fix a single failed check via AI
- `POST /api/apps/:id/auto-fix-all` — Auto-fix all fixable failed checks

### Submissions
- `POST /api/apps/:id/submissions` — Create submission (409 if duplicate active submission exists)
- `PATCH /api/submissions/:id` — Update status (auto-sets timestamps)
- `GET /api/submissions/:id` — Get with pre-checks, events, and task relays
- `POST /api/submissions/:id/check-resubmit` — Check if rejected submission ready to resubmit
- `POST /api/submissions/:id/push-metadata` — Push metadata to Google/Apple store
- `POST /api/submissions/:id/submit-to-store` — Submit version for store review
- `GET /api/apps/:id/store-status` — Live store status check via connector

### Pre-Checks
- `POST /api/apps/:id/run-checks` — Run all checks (optionally link to submission)
- `GET /api/submissions/:id/checks` — Get check results

### Reviews
- `GET /api/apps/:id/reviews` — List reviews (filters: store, status, min_rating, max_rating)
- `GET /api/apps/:id/review-stats` — Star distribution, avg rating, status/store counts
- `GET /api/apps/:id/review-events` — List review events (status changes from webhooks/polling)
- `POST /api/reviews/:id/generate-draft` — AI-generate response draft (Claude Haiku)
- `POST /api/apps/:id/reviews/batch-draft` — Generate drafts for all pending reviews
- `PATCH /api/reviews/:id/approve` — Approve (auto-sends to store) or skip

### Credentials
- `GET /api/apps/:id/credentials` — List (vault_key hidden)
- `POST /api/apps/:id/credentials` — Store encrypted credential
- `DELETE /api/credentials/:id` — Remove credential + vault file

### Schedule
- `GET /api/apps/:id/schedule` — List polling jobs
- `PATCH /api/schedule/:id` — Enable/disable, change interval

### Webhooks
- `POST /api/webhooks/apple` — Apple App Store Connect notifications (JWS signed, auto-maps states)

### System
- `GET /health` / `GET /api/health` — Health check
- `GET /api/auth/config` — Supabase public config
- `GET /api/scheduler/settings` — Runtime scheduler state `{tick_seconds, paused}` (admin)
- `PUT /api/scheduler/settings` — Update tick interval / pause (admin)

## Pre-Submission Checks (31 checks, Phase 2+7)

Grouped by category. Each returns `{check_id, status, severity, details, recommendation, doc_url}`.

**Scoring**: `100 - (failed_blockers * 20) - (failed_warnings * 5)`. Any blocker = submission blocked.

| Category | Checks | Severity |
|----------|--------|----------|
| Legal/Privacy | privacy_policy_exists, privacy_policy_content, support_url, contact_info, account_deletion, export_compliance, content_rating, iap_compliance, subscription_disclosure | Blocker |
| Design/Assets | screenshot dimensions/count/format/accuracy, feature_graphic_android, icon_specs | Mixed |
| Metadata | app_name_length, description_quality, keywords_optimization, release_notes, localization | Warning |
| Technical | demo_credentials, minimum_functionality, permissions_justified, api_level, sign_in_with_apple, crash_rate | Mixed |
| Safety | data_safety, category_requirements, age_rating, url_scheme_conflict, bitcode_arm64 | Mixed |

**Auto-Fix Engine** (Phase 7): 6 AI-powered fixers in `routes/checks.py`:
- `export_compliance` — sets `export_compliance_declared = true` (HTTPS exemption)
- `keywords_optimization` — generates keywords via Claude from app docs
- `description_quality` — generates/improves full_description + short_description
- `release_notes_present` — generates release notes from app context
- `app_name_length` — generates optimized app name + subtitle
- `localization_completeness` — fills all missing recommended fields at once

**Action Links**: Each failed check has navigation buttons:
- Design/Asset failures → "Go to Assets" tab
- Metadata failures → "Go to Metadata" tab
- Legal/Compliance failures → "Edit App" modal
- All failures with `doc_url` → "View Guidelines" external link

## Submission Status Lifecycle

```
preparing → pre_check_failed (blockers found)
         → ready (checks pass) → uploading → submitted → in_review
                                                       → approved → released
                                                       → rejected → (fix via TeamHub) → ready (loop)
         → cancelled / suspended / withdrawn
```

## TeamHub Integration (Phase 3)

Auto-creates per app:
```
User's Workspace
  └─ Folder: "Marq: {App Name}"
       ├─ List: "Submissions"     — One task per submission
       ├─ List: "Store Issues"    — Rejection fixes
       └─ List: "Reviews"         — Review response tasks
```

Rejection translator produces: human-readable summary, task classification (fix_app/fix_website/fix_metadata/fix_policy), step-by-step fix instructions with file paths, Apple/Google guideline links.

**Resubmission loop**: All linked tasks complete → Marq re-runs failed checks → if pass → "Ready to resubmit" notification → one-click resubmit.

## Store API Connectors (Phase 4)

### Google Play Developer API (`connectors/google.py`)
- **Auth**: OAuth2 service account JWT → access token (PyJWT RS256)
- **Edits workflow**: `create_edit()` → make changes → `commit_edit()` (atomic)
- **Methods**: `get_app`, `create/delete/commit/validate_edit`, `get/update_listing`, `get/update_track`, `upload_bundle`, `upload_apk`, `list/get/reply_to_review`
- **High-level**: `push_metadata()` (edit→update→commit), `submit_release()` (edit→upload→track→commit), `check_first_upload()`
- First upload must be manual via Play Console — Marq detects and shows guide

### Apple App Store Connect API (`connectors/apple.py`)
- **Auth**: JWT from P8 key (ES256, 20-min expiry, `kid` header, `appstoreconnect-v1` audience)
- **JSON:API format**: `_extract()` helper flattens `{data: {id, attributes}}` responses
- **Methods**: `get/list_apps`, `list/get/create_version`, `list/update/create_localization`, `get_app_info`, `list_screenshot_sets`, `upload/commit_screenshot`, `submit_for_review`, `get_review_status`, `list_customer_reviews`, `reply_to_review`
- **High-level**: `update_metadata()` (find/create version → localization → update)
- **Status mapping**: `APPLE_TO_MARQ_STATUS` dict + `map_status()` class method

### Fastlane CLI Wrapper (`connectors/fastlane.py`)
- iOS only: `deliver` (IPA upload), `pilot_upload` (TestFlight), `match` (code signing)
- Subprocess with configurable timeout (default 10min)
- Structured result: `{success, exit_code, stdout, stderr, error}`
- All metadata operations go through API, not Fastlane

### Credential Vault UI
- App detail view shows credential cards with store badges, active/inactive status
- Add credential modal with Google (JSON paste) and Apple (issuer/key/P8) forms
- Fernet-encrypted storage on disk, vault_key reference in Supabase
- Delete removes both DB record and encrypted file

### Store Workflow Actions
- **Push Metadata** button on submissions (available in preparing/draft/ready states)
- **Submit to Store** button (with confirmation) — detects first-upload requirement for Google
- **Check Store Status** on app detail — live query via connector
- First-upload guide modal with step-by-step Play Console instructions

## Apple Webhooks (Phase 5)

- **Endpoint**: `POST /api/webhooks/apple`
- **Signature**: JWS (JSON Web Signature) — header/payload/signature decoded from base64url
- **Verification**: Algorithm check (ES256/RS256), payload structure validation. Full x5c certificate chain verification pending Apple account setup.
- **Handled notification types**: `APP_VERSION_STATE_CHANGE`, `BUILD_UPLOAD_STATE_CHANGE`, `TESTFLIGHT_STATE_CHANGE`
- **State mapping**: 13 Apple states → Marq statuses (see `APPLE_STATE_MAP` in `routes/webhooks.py`)
- **Flow**: Decode JWS → find app by `bundleId` → find active submission → update status → create review event → trigger rejection handler if rejected

## Review Dashboard (Phase 5)

- **Stats**: Star distribution bars (5→1), average rating, total count, by-store/by-status breakdown
- **Filters**: All / Pending / Drafts Ready / Approved / Sent / Low Rating (1-2) / High Rating (4-5)
- **Review cards**: Rating stars, store badge, status badge, review text, AI draft area
- **AI draft**: Claude Haiku generates response considering rating, text, app context, tone, char limits
  - Google limit: 350 chars; Apple limit: 5970 chars
  - Fallback: generic response if Claude CLI unavailable
  - Batch mode: draft all pending reviews at once
- **Approval flow**: `pending` → generate draft → `draft_ready` → approve/edit → `approved` → auto-send → `sent`
- **Send flow**: Background task loads connector from vault, sends via `reply_to_review()`, updates status to `sent`
- **Review events**: Status change timeline from webhooks/polling/manual sources

## SPA Polish (Phase 6)

- **App status dots**: Color-coded indicator on app icon (green = live/released, yellow = in review, red = rejected, gray = draft)
- **Edit App form**: Full edit modal (name, platform, version, bundle IDs, URLs, doc folder, status) + delete with double-confirm
- **Audit log viewer**: Modal showing 50 most recent actions per app with action badges and timestamps
- **Duplicate submission guard**: Backend rejects `POST /api/apps/:id/submissions` with 409 if active (non-terminal) submission exists for same app/store/version
- **Shared helpers**: `esc()`, `formatDate()`, `emptyState()` consolidated into `app.js` — eliminated duplication across 4 tab files
- **Proper new submission modal**: Dashboard uses proper modal form (was using browser `prompt()` — now uses `showNewSubmissionForm` from metadata.js)

## Scheduler

- 60-second tick loop (`core/scheduler.py`)
- Queries `mrq_schedule` for due jobs
- Job types: `google_status_poll` (15min), `google_review_poll` (30min), `apple_status_poll` (15min), `apple_review_sync` (30min), `pre_check_rerun` (60min, disabled), `credential_verify` (24h, disabled)
- **4 handlers registered**: `handle_google_status_poll`, `handle_google_review_poll`, `handle_apple_status_poll`, `handle_apple_review_sync`
- On status change → creates `mrq_review_events` → if rejection → translator → TeamHub tasks
- Shared rejection handler (same flow as `submissions.py`)

## Configuration

`.env` variables:
```
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, SUPABASE_JWT_SECRET
MARQ_VAULT_KEY          # Fernet encryption key for credential vault
TEAMHUB_URL             # http://127.0.0.1:8089
TASKS_URL               # http://127.0.0.1:8081
```

## System Registration

- **Caddyfile**: `/marq/*` → `localhost:8103`, internal API blocked
- **systemd**: `opai-marq.service` (enabled, auto-restart)
- **Portal**: Dashboard tile (svcKey: `marq`)
- **Navbar**: Tool entry `MQ` + `FULL_HEIGHT_TOOLS`
- **opai-control.sh**: In SERVICES array

## Build Phases

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | Foundation — DB, service skeleton, CRUD, portal registration | **Complete** |
| 2 | Pre-submission checker — 31 checks, metadata editor, screenshot validation | **Complete** |
| 3 | AI metadata + TeamHub — doc-based metadata gen, rejection-to-task relay | **Complete** |
| 4 | Store API connectors — Google Play full, Apple scaffolded, scheduler handlers, credential UI | **Complete** |
| 5 | Webhooks + reviews — Apple webhooks, review dashboard, AI response drafting | **Complete** |
| 6 | Polish — edit app, audit log, status dots, shared helpers, duplicate guard, wiki | **Complete** |
| 7 | Assets + Auto-Fix — Assets tab (icon/screenshot/feature graphic upload + OPAI file picker), auto-fix engine (6 AI fixers), checks UX overhaul (action links, severity badge fix), robust JSON extraction for AI metadata gen, metadata upsert | **Complete** |

## Dependencies

| Dependency | Status |
|------------|--------|
| Google Play Developer Account | Exists |
| Apple Developer Account | Not yet acquired |
| Fastlane (Ruby) | Needs install (iOS only) |
| TeamHub internal API | Live at :8089 |
| Supabase Storage | Available (screenshots) |
