# OPAI Studio — Wiki

> **Status**: Phase 1 Live (2026-03-02) | **Last updated**: 2026-03-04
> **Service**: `opai-studio` | **Port**: `8108` | **Path**: `/studio/`
> **Tool dir**: `tools/opai-studio/` | **Stack**: FastAPI (Python) + Supabase + Fabric.js 5.3.1 + Gemini
> **Plan file**: `/home/dallas/.claude/plans/indexed-launching-spring.md`

---

## Concept & Positioning

OPAI Studio is the internal AI-powered image generation and editing suite. It replaces external tools like Canva/Photoshop for quick asset creation by combining:

- **AI image generation** via Google Gemini (Nano Banana models) with daily rate limiting
- **Canvas editing** via Fabric.js (layers, shapes, text, import/paste, undo/redo)

> **See also**: [Pencil.dev](pencil.md) — for UI/layout design (Figma-like, MCP-driven). Studio is for AI image generation; Pencil is for visual component design. Complementary workflows.
- **Project organization** with per-project image collections stored in Supabase
- **Export** to PNG/JPEG/WebP at configurable quality and scale

The tool is designed for internal OPAI use and future HELM client access. Phase 1 delivers a working generation + editing loop; phases 2-6 add layers system, image processing, presets/bulk export, recipes, and polish.

---

## Architecture Overview

```
tools/opai-studio/
├── app.py                      — FastAPI app, router registration, lifespan
├── config.py                   — Port 8108, env vars, paths, limits
├── requirements.txt            — pillow, httpx, python-multipart, etc.
├── core/
│   ├── __init__.py
│   └── supabase.py             — Async REST helpers (sb_get/post/patch/delete)
├── routes/
│   ├── __init__.py
│   ├── health.py               — GET /health, /api/health, /api/auth-config
│   ├── projects.py             — Project CRUD (list, create, get, update, delete)
│   ├── images.py               — Image CRUD, canvas save, b64 store, file upload
│   ├── generate.py             — AI generation, usage tracking, daily limits
│   └── assets.py               — Serve project files with path traversal protection
├── static/
│   ├── index.html              — SPA: loading → project browser → editor
│   ├── style.css               — Dark theme, CSS variables, 3-column layout
│   └── js/
│       ├── app.js              — Auth, routing, state, API helpers, toast
│       ├── canvas.js           — Fabric.js canvas manager (save/load, zoom, tools, import)
│       └── generate.js         — AI generation panel (form, usage bar, recent history)
└── data/
    └── projects/               — Runtime storage (gitignored)
        ├── {project_uuid}/
        │   ├── generations/    — AI-generated images
        │   ├── images/         — Uploaded images
        │   └── canvas/         — Canvas-referenced images (from b64 store)
        ├── _uploads/           — Unassigned file uploads
        ├── _unassigned/        — Generations without a project
        └── _scroll-frames/     — Scroll animation frame sets
```

---

## Phase Status

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 1** | Foundation — auth, projects, canvas, AI generation, save/load, import | **Live** |
| **Phase 2** | Layers + Properties + Drawing Tools (full layer CRUD, object props panel) | Planned |
| **Phase 3** | Image Processing + Background Removal (rembg, PIL filters) | Planned |
| **Phase 4** | Presets + Export + Media Packages (45+ system presets, bulk async jobs) | Planned |
| **Phase 5** | Timeline + Versions + Recipes (edit history, replayable workflows) | Planned |
| **Phase 6** | Polish + AI Enhancement (prompt builder, variations, scroll frames, UX) | Planned |

---

## Configuration

**File**: `tools/opai-studio/config.py`

| Variable | Default | Source |
|----------|---------|--------|
| `HOST` | `127.0.0.1` | `OPAI_STUDIO_HOST` |
| `PORT` | `8108` | `OPAI_STUDIO_PORT` |
| `SUPABASE_URL` | — | Vault (`SUPABASE_URL`) |
| `SUPABASE_ANON_KEY` | — | Vault (`SUPABASE_ANON_KEY`) |
| `SUPABASE_SERVICE_KEY` | — | Vault (`SUPABASE_SERVICE_KEY`) |
| `SUPABASE_JWT_SECRET` | — | Vault (`SUPABASE_JWT_SECRET`) |
| `GEMINI_API_KEY` | — | Vault (`GEMINI_API_KEY`) — service-specific |
| `MAX_UPLOAD_SIZE` | `20 * 1024 * 1024` | Hardcoded (20 MB) |
| `STATIC_DIR` | `tools/opai-studio/static` | Derived |
| `DATA_DIR` | `tools/opai-studio/data` | Derived |
| `PROJECTS_DIR` | `data/projects` | Derived |

**Vault**: 6 env vars injected from `services.opai-studio` + `shared` sections via `vault-env.sh`. The `GEMINI_API_KEY` is stored under `services.opai-studio` (not shared).

---

## Supabase Tables

10 tables total. Phase 1 uses the first 4 + presets. Remaining tables are created but unused until later phases.

### Core Tables (Phase 1)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `studio_projects` | User workspace containers | `id`, `user_id`, `name`, `description`, `tags`, `thumbnail_url` |
| `studio_images` | Images within projects | `id`, `project_id`, `user_id`, `name`, `width`, `height`, `canvas_json`, `source_type`, `storage_key` |
| `studio_presets` | Dimension presets (45 seeded) | `id`, `name`, `category`, `width`, `height`, `icon`, `is_system`, `user_id` |
| `studio_generations` | AI generation log | `id`, `user_id`, `image_id`, `project_id`, `prompt`, `model`, `aspect_ratio`, `image_size`, `storage_key`, `duration_ms` |

### Future Tables (Phases 2-5)

| Table | Phase | Purpose |
|-------|-------|---------|
| `studio_layers` | 2 | Layer index (type, z_index, visibility, opacity, data) |
| `studio_image_versions` | 5 | Version snapshots (canvas_json + thumbnail) |
| `studio_timeline` | 5 | Edit history per image (action, description, data) |
| `studio_recipes` | 5 | Saved workflow step arrays |
| `studio_shares` | 4 | Public share links with expiry + view count |
| `studio_export_jobs` | 4 | Async bulk job queue (media packages, batch recipes) |

### RLS

All tables have RLS enabled. A `studio_has_project_access(project_id, user_id)` function provides ownership checks that cascade through images, layers, versions, and timeline entries.

### System Presets (45 seeded)

| Category | Count | Examples |
|----------|-------|---------|
| Icons | 6 | App Icon iOS 1024, Favicon 32, PWA 192/512 |
| Social Media | 15 | Instagram Post/Story/Reel, YouTube Thumbnail, TikTok Cover |
| Headers & Banners | 6 | Website Hero 1920x1080, Email Header 600x200 |
| Logos | 4 | Square 500, Landscape 1000x300, Transparent 2000 |
| Print | 5 | Business Card 1050x600, Poster A3, Letter 8.5x11 (300 DPI) |
| App Screens | 6 | Splash iOS/Android, App Store Screenshot 6.7"/5.5" |
| Presentation | 3 | Slide 16:9, Slide 4:3, OG Image 1200x630 |

---

## API Reference

All `/api/*` routes require `Authorization: Bearer <supabase_jwt>` unless marked "None".

### Health & Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Service health (status, port, uptime) |
| GET | `/api/health` | None | Same as above |
| GET | `/api/auth-config` | None | Public Supabase URL + anon key for client |

### Projects

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/projects` | JWT | List user's projects (`?limit=50&offset=0`) |
| POST | `/api/projects` | JWT | Create project (`{name, description}`) |
| GET | `/api/projects/{id}` | JWT | Get single project |
| PATCH | `/api/projects/{id}` | JWT | Update project (`{name, description, tags}`) |
| DELETE | `/api/projects/{id}` | JWT | Delete project |
| GET | `/api/projects/{id}/images` | JWT | List project images (`?limit=50&offset=0`) |

### Images

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/images/{id}` | JWT | Get image metadata + canvas_json |
| POST | `/api/projects/{id}/images` | JWT | Create image (`{name, width, height, preset_id}`) |
| PATCH | `/api/images/{id}` | JWT | Update image metadata |
| DELETE | `/api/images/{id}` | JWT | Delete image |
| POST | `/api/images/{id}/upload` | JWT | Upload file as image background (multipart) |
| POST | `/api/images/{id}/save-canvas` | JWT | Save Fabric.js canvas JSON (`{canvas_json}`) |
| POST | `/api/images/store-b64` | JWT | Store base64 image data to disk, return URL |
| POST | `/api/images/upload-file` | JWT | Upload file for canvas use, return URL (multipart) |

### Generation

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/generate/models` | JWT | Available models, aspect ratios, image sizes |
| GET | `/api/generate/usage` | JWT | Today's generation count vs daily limit |
| POST | `/api/generate` | JWT | Generate image (`{prompt, model, aspect_ratio, image_size, override_limit}`) |
| POST | `/api/generate/scroll-frames` | JWT | Generate scroll animation frames |

### Assets

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/assets/{path}` | None | Serve project file (path traversal protected) |

---

## Frontend Architecture

### Views

1. **Loading Screen** — Spinner while fetching auth config and checking session
2. **Project Browser** — Grid of project cards, "+ New Project" button, user email + sign out
3. **Editor** — Three-column layout with canvas center

### Editor Layout

```
┌──────────────────────────────────────────────────────────────┐
│ TOOLBAR: ← Back | Project Name | Image Name (editable)      │
│ Tools: Select | Text | Rect | Circle | Import | Undo | Redo │
│                                            Save | Export     │
├───────────┬──────────────────────────┬───────────────────────┤
│ LEFT 280px│                          │ RIGHT 300px           │
│           │                          │                       │
│ [Layers]  │    FABRIC.JS CANVAS      │ [Generate]  [Props]   │
│ [Images]  │                          │                       │
│           │                          │ Prompt textarea       │
│ Layer list│    (fills remaining)     │ Model / AR / Size     │
│ + reorder │                          │ Usage: X/50 [toggle]  │
│           │                          │ [Generate] [Gen+Add]  │
│           │                          │ Preview + Recent      │
├───────────┴──────────────────────────┴───────────────────────┤
│ STATUS: 1024 x 1024 | 100% | 512, 256                       │
└──────────────────────────────────────────────────────────────┘
```

### Key JS Modules

**`app.js`** — Application controller
- `App.BASE = '/studio'` — all API calls prepend this
- `App.apiFetch(path, opts)` — adds auth headers, prepends BASE, handles 401 redirect
- `App.apiJSON(path, opts)` — apiFetch + checks `resp.ok`, throws with error detail
- `App._esc(str)` — HTML escape helper
- `App.toast(msg, type)` — notification system
- Auth: picks up existing Supabase session from localStorage (shared with Portal)

**`canvas.js`** — Fabric.js canvas manager (`CanvasMgr`)
- `init(w, h)` — creates canvas, sets up events/keyboard/import handlers
- `save()` / `loadJSON(json)` — persist to/from Supabase via API
- `toJSON()` — serializes canvas, strips `/studio` BASE prefix from image URLs
- `loadJSON()` — deserializes, rewrites `/api/` paths to include BASE for Caddy
- `addImageFromB64(b64, name)` — uploads to disk first, then adds by URL reference
- `addImageFromURL(url, name)` — adds image object to canvas
- `importFromFile()` — file picker for image import
- `_handlePaste(e)` — Ctrl+V paste handler (images + image URLs)
- `_handleDrop(e)` — drag-and-drop onto canvas
- Undo/redo stack (max 50 entries), zoom (0.1-5x range), pan
- Layer rename via double-click

**`generate.js`** — AI generation panel (`GeneratePanel`)
- `init()` — fetches models + usage in parallel
- `render()` — builds form with usage bar, override toggle, model/AR/size selects
- `generate(addToCanvas)` — sends generation request, updates usage counter
- `_showPreview(result)` — shows generated image with "Add to Canvas" / "Download" buttons
- Recent generations grid (last 6, clickable to add to canvas)
- Keyboard shortcut: Ctrl+Enter to generate

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| V | Select tool |
| T | Add text |
| R | Add rectangle |
| C | Add circle |
| I | Import image (file picker) |
| Delete/Backspace | Delete selected object |
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+S | Save canvas |
| Ctrl+C | Copy selected |
| Ctrl+V | Paste (clipboard image or copied object) |
| Ctrl+Enter | Generate (when prompt focused) |

### Design System

Dark theme with purple accent. CSS variables in `style.css`:

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-body` | `#0a0a0f` | Page background |
| `--bg-panel` | `#12121a` | Side panels |
| `--bg-card` | `#1a1a2e` | Cards, inputs |
| `--bg-canvas` | `#181824` | Canvas area |
| `--accent` | `#6C63FF` | Buttons, links, selection |
| `--text-primary` | `#e0e0e8` | Body text |
| `--text-muted` | `#8888a0` | Secondary text |
| `--danger` | `#FF6B6B` | Errors, destructive |
| `--success` | `#4ECB71` | Confirmations |
| `--warning` | `#FFB347` | Warnings |

---

## Daily Generation Limit

- **Default**: 50 generations per user per day (UTC midnight reset)
- **Backend**: `DAILY_LIMIT = 50` in `routes/generate.py`
- **Counting**: Queries `studio_generations` where `created_at >= today 00:00:00 UTC`
- **Enforcement**: Returns HTTP 429 if at limit and `override_limit` is false
- **Override toggle**: Frontend checkbox that sends `override_limit: true` in the request body
- **Usage display**: Bar at top of Generate panel shows `X / 50 today` with color states:
  - Normal: default styling
  - Low (`<= 10 remaining`): yellow/warning
  - At limit: red with disabled buttons
  - Override active: accent color, buttons re-enabled

---

## Image Storage Model

Canvas images are stored as **URL references**, not embedded base64 data URIs. This keeps `canvas_json` small and prevents save timeouts.

**Flow: AI generation → canvas**
1. Backend generates image → saves PNG to `data/projects/{project_id}/generations/{uuid}.png`
2. Returns base64 to frontend + `storage_key` path
3. Frontend calls `POST /api/images/store-b64` → saves to disk → gets URL
4. Adds to canvas as `fabric.Image` with `src = /studio/api/assets/{storage_key}`
5. On save: `toJSON()` strips `/studio` prefix → stored as `/api/assets/{key}`
6. On load: `loadJSON()` rewrites `/api/` to `/studio/api/` for Caddy routing

**Flow: file import (paste/drop/picker)**
1. Frontend calls `POST /api/images/upload-file` with multipart form data
2. Backend saves to `data/projects/_uploads/{uuid}.{ext}` or project dir
3. Returns URL → added to canvas by URL reference

---

## Shared Code Dependencies

| Module | Source | Usage |
|--------|--------|-------|
| `tools/shared/auth.py` | Auth middleware | `Depends(get_current_user)` on all protected endpoints |
| `tools/shared/image_gen.py` | Gemini image generation | `generate_image()`, `generate_scroll_frames()` |
| Supabase JS (CDN) | Client-side auth | Session management, token refresh |
| Fabric.js 5.3.1 (CDN) | Canvas editing | Interactive layer editing, JSON serialization |

---

## Deployment

### Systemd Service

File: `config/service-templates/opai-studio.service`

```bash
# Start/stop/restart
sudo systemctl restart opai-studio
sudo systemctl status opai-studio
journalctl -u opai-studio -f
```

### Caddy

```
handle_path /studio/* {
    reverse_proxy localhost:8108
}
```

Note: Caddy strips the `/studio/` prefix before forwarding. All browser URLs include `/studio/` but the backend sees clean paths.

### Portal Tiles

**Admin dashboard**: Registered in `ADMIN_CARDS` in `tools/opai-portal/static/index.html`:
```javascript
{ id: 'studio', href: '/studio/', icon: '🎨', title: 'Studio',
  desc: 'AI image generation + editing', css: 'card-studio', svcKey: 'studio' }
```

**User dashboard**: Registered in `APP_CARDS` (key `studio`):
```javascript
studio: { href: '/studio/', icon: '🎨', title: 'Studio',
  desc: 'AI image generation, editing, and media tools', css: 'card-studio' }
```

Users see the Studio tile only if `studio` is in their `allowed_apps` array.

### Shared Navbar

Studio includes the [Shared Navbar](../core/navbar.md) via:
```html
<script src="/auth/static/js/navbar.js" defer></script>
```

Studio is registered in navbar.js `TOOLS` as `{ abbr: 'ST', color: '#ec4899', label: 'Studio', path: '/studio/' }` and added to `FULL_HEIGHT_TOOLS`. The navbar injects flex-column body styling so Studio's 3-column editor layout fills `calc(100vh - 44px)`.

CSS adjustments for navbar coexistence:
- `--navbar-height: 44px` CSS variable on `:root`
- `.screen` uses `flex: 1; min-height: 0` instead of `height: 100%`
- `.projects-container` and `.editor-body` use `calc(100vh - var(--toolbar-height) - var(--navbar-height))`

### Health Monitoring

Registered in `tools/opai-engine/config.py` → `HEALTH_SERVICES`:
```python
"studio": 8108
```

---

## Common Operations

```bash
# Restart after code changes
sudo systemctl restart opai-studio

# Check logs
journalctl -u opai-studio -f --no-hostname

# Verify health
curl -s localhost:8108/health | python3 -m json.tool

# Check vault env injection
cat /run/user/1000/opai-vault/opai-studio.env

# Count today's generations for a user
scripts/supabase-sql.sh "SELECT count(*) FROM studio_generations WHERE created_at >= CURRENT_DATE"

# List all projects
scripts/supabase-sql.sh "SELECT id, name, created_at FROM studio_projects ORDER BY created_at DESC LIMIT 10"
```

---

## Gotchas & Known Issues

1. **Canvas save silently fails with old apiFetch**: The `App.apiFetch()` helper only catches HTTP 401. All other errors return the response without throwing. Canvas save MUST use `App.apiJSON()` which checks `resp.ok`.

2. **Base64 data URIs in canvas_json**: If images are embedded as data URIs instead of URL references, the JSON blob can exceed Supabase payload limits or cause httpx timeouts. Always upload to disk first via `/api/images/store-b64`.

3. **URL prefix mismatch through Caddy**: Caddy strips `/studio/` before forwarding. Stored URLs use `/api/assets/...` (no prefix). Browser needs `/studio/api/assets/...`. The `loadJSON()`/`toJSON()` methods handle this rewriting.

4. **GEMINI_API_KEY is service-specific**: Unlike shared keys (SUPABASE_URL, etc.), the Gemini key lives under `services.opai-studio` in the vault, not under `shared`.

5. **sb_patch timeout**: Increased to 30s (from default 15s) to handle large canvas JSON saves.

6. **Fabric.js custom properties**: `toJSON()` must include `['name', 'selectable', 'evented']` to preserve layer names and interaction flags across save/load cycles.

---

## Planned Features (Phases 2-6)

### Phase 2: Layers + Properties + Drawing Tools
- Dedicated `studio_layers` table with z_index, visibility, opacity
- Layer CRUD endpoints (`routes/layers.py`)
- Object property panel (position, size, fill, stroke, opacity, filters)
- Drawing tools (pen, line, polygon)
- `static/js/layers.js`, `properties.js`, `tools.js`

### Phase 3: Image Processing + Background Removal
- `core/bg_remover.py` — rembg (ONNX, ~170MB model download)
- `core/image_processor.py` — PIL resize, crop, rotate, brightness, contrast, saturation
- `routes/process.py` — processing endpoints
- `static/js/filters.js` — filter preset UI

### Phase 4: Presets + Export + Media Packages
- `core/canvas_renderer.py` — server-side Fabric.js JSON → PIL render
- `core/bulk_engine.py` — async job queue for batch operations
- Preset browser panel, single export, media package popup (checkbox preset selector)
- `studio_export_jobs` + `studio_shares` tables active

### Phase 5: Timeline + Versions + Recipes
- `core/recipe_executor.py` — replay saved step arrays
- Edit timeline panel, version snapshots, recipe recorder
- `studio_timeline`, `studio_image_versions`, `studio_recipes` tables active

### Phase 6: Polish + AI Enhancement
- `core/prompt_builder.py` — style modifiers, Claude-enhanced prompts
- Variations grid, scroll frame templates
- Responsive panel collapsing, keyboard shortcuts expansion, UX polish

---

## Related Files

| File | Purpose |
|------|---------|
| `tools/opai-studio/app.py` | FastAPI app entry point |
| `tools/opai-studio/config.py` | Configuration |
| `tools/opai-studio/core/supabase.py` | Async Supabase REST client |
| `tools/opai-studio/routes/generate.py` | AI generation + usage limits |
| `tools/opai-studio/routes/images.py` | Image CRUD + canvas save + uploads |
| `tools/opai-studio/routes/projects.py` | Project CRUD |
| `tools/opai-studio/routes/assets.py` | File serving with path protection |
| `tools/opai-studio/static/js/app.js` | Frontend controller + auth |
| `tools/opai-studio/static/js/canvas.js` | Fabric.js canvas manager |
| `tools/opai-studio/static/js/generate.js` | Generation panel |
| `tools/shared/image_gen.py` | Shared Gemini image generation module |
| `tools/shared/auth.py` | Shared auth middleware |
| `config/service-templates/opai-studio.service` | Systemd service file |
