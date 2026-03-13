# 2nd Brain — Developer Reference

> **Last updated**: 2026-03-01 (Phase 9)
> **For high-level docs** see: `Library/opai-wiki/brain.md`
> **This file covers**: JS state, component wiring, data flow, backend internals, gotchas, and where to add things

---

## Quick Start

```bash
# Start / restart service
systemctl --user restart opai-brain
systemctl --user status opai-brain
journalctl --user -u opai-brain -f  # live logs

# Access
https://opai.boutabyte.com/brain/   # production (via Caddy + Tailscale)
http://localhost:8101/brain/         # direct (on OPAI Server)

# Smoke test
curl http://localhost:8101/api/health
curl http://localhost:8101/openapi.json | python3 -m json.tool | grep '"path"'
```

---

## File Map

```
tools/opai-brain/
├── app.py            entry point — FastAPI + lifespan (scheduler) + all routers
├── config.py         env vars, paths, constants
├── scheduler.py      background asyncio loop — agent cron runner
├── requirements.txt  Python deps (including croniter for Phase 6)
├── .env              SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY,
│                     ANTHROPIC_API_KEY, BRAIN_CLAUDE_MODEL (optional)
├── routes/
│   ├── health.py     GET /api/health
│   ├── nodes.py      Node CRUD + snapshot trigger
│   ├── snapshots.py  Version snapshot CRUD + write_snapshot() helper
│   ├── inbox.py      Inbox capture/promote/dismiss
│   ├── search.py     FTS via Supabase wfts
│   ├── graph.py      D3-ready graph data + position CRUD + group derivation
│   ├── canvas.py     Canvas positions + links + suggest-label
│   ├── schedule.py   Admin scheduler API
│   ├── ai.py         AI co-editor (tier-gated)
│   ├── research.py   Research synthesis sessions
│   └── tier.py       GET /api/me
├── static/
│   ├── index.html    SPA shell — all HTML elements, CDN scripts
│   ├── app.js        All frontend logic (~2400 lines)
│   └── style.css     Dark theme + all component styles
└── data/             Created on startup; currently empty (future: embeddings cache)
```

---

## app.py — Entry Point

```python
# Lifespan: starts/stops scheduler background task
@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(scheduler_loop())
    yield
    task.cancel()
    try: await task
    except asyncio.CancelledError: pass

app = FastAPI(..., lifespan=lifespan)

# Registered routers (in order):
health_router, nodes_router, inbox_router, search_router,
graph_router, ai_router, research_router, canvas_router,
tier_router, snapshots_router, schedule_router
```

Static files mounted at `/static` and `/` (html=True for SPA fallback).

---

## config.py — Key Variables

```python
SUPABASE_URL         = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")  # bypasses RLS
SUPABASE_ANON_KEY    = os.getenv("SUPABASE_ANON_KEY")     # returned to frontend
ANTHROPIC_API_KEY    = os.getenv("ANTHROPIC_API_KEY")
CLAUDE_MODEL         = os.getenv("BRAIN_CLAUDE_MODEL", "claude-sonnet-4-6")
HOST                 = "127.0.0.1"
PORT                 = 8101
DATA_DIR             = Path(__file__).parent / "data"
STATIC_DIR           = Path(__file__).parent / "static"
```

---

## Backend — Supabase Helpers Pattern

Every route file duplicates these helpers (no shared module — by design, avoids circular imports and makes each route self-contained):

```python
def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",  # returns inserted/updated row
    }

async def _sb_get(path, params="") -> list
async def _sb_post(path, body) -> dict
async def _sb_patch(path, params, body) -> dict
async def _sb_delete(path, params) -> None
```

All use `httpx.AsyncClient(timeout=10-15)`. Service key bypasses RLS — all ownership checks are done in Python before Supabase calls.

---

## routes/nodes.py — Snapshot Integration

The snapshot trigger is in `update_node()`:

```python
# 1. Fetch existing node (includes content for snapshot)
existing = await _sb_get("brain_nodes", f"id=eq.{node_id}&user_id=eq.{user.id}&select=id,content")
old_content = existing[0].get("content")

# 2. Apply patch...

# 3. After patch succeeds — fire-and-forget snapshot
if body.content is not None and old_content and old_content.strip():
    from routes.snapshots import write_snapshot
    asyncio.create_task(write_snapshot(node_id, old_content))
```

**Key design decisions**:
- Snapshot of OLD content (before patch) — you can always restore what was there
- Only snapshot if content actually changed (`body.content is not None`)
- Only snapshot if old content was non-empty (no point snapshotting blank notes)
- Fire-and-forget: snapshot failure never fails the save

---

## routes/snapshots.py — Snapshot CRUD

`write_snapshot(node_id, content)` — callable from anywhere:
```python
async def write_snapshot(node_id: str, content: str) -> None:
    await _sb_post("brain_snapshots", {"node_id": node_id, "content": content})
    rows = await _sb_get("brain_snapshots", f"node_id=eq.{node_id}&select=id&order=created_at.desc&limit=1000")
    if len(rows) > 20:
        for oid in [r["id"] for r in rows[20:]]:
            await _sb_delete("brain_snapshots", f"id=eq.{oid}")
```

Ownership verification in all routes: check `brain_nodes` for `user_id` first, then query `brain_snapshots` by `node_id` (no direct user_id on snapshots table).

---

## routes/canvas.py — Phase 6 Additions

### PATCH /api/canvas/links/{id}

Partial update of label and/or strength. Ownership verified by `user_id` on `brain_links`.

```python
class LinkUpdate(BaseModel):
    label: Optional[str] = None
    strength: Optional[float] = None  # clamped to 0.0–1.0
```

### POST /api/canvas/suggest-label

Tier gate: `profiles.subscription_tier` must be `pro | ultimate | admin`.
Model: `claude-haiku-4-5-20251001` (not Sonnet — speed + cost).
Prompt: fetches title + content[:500] of both nodes → asks for 1-5 word label.
Returns: `{ suggested_label: str }`.

---

## routes/schedule.py — Scheduler API

All three endpoints call `_require_admin(user)`:
```python
def _require_admin(user: AuthUser):
    if getattr(user, "role", None) != "admin":
        raise HTTPException(403, "Admin only")
```

`AuthUser.role` is populated by `tools/shared/auth.py` from `profiles.role`.

`POST /api/admin/schedule/run/{agent}` imports `scheduler.trigger_agent` at call time (not at import time) to avoid circular import during startup.

---

## scheduler.py — Internal Details

### Loop
```
every 60 seconds:
  fetch brain_schedule table
  for each agent (curator, linker):
    if enabled AND _is_due(cron_expr, last_run_at):
      asyncio.create_task(trigger_agent(agent))
```

### _is_due() Logic
```python
cron = croniter(cron_expr, now)
prev_fire = cron.get_prev(datetime)
# Due if: last run was before the most recent scheduled fire time
return last_run_at is None or last_dt < prev_fire
```

### trigger_agent() Flow
```python
env = {k:v for k,v in os.environ.items() if k != "CLAUDECODE"}
proc = await asyncio.create_subprocess_exec("bash", str(script), env=env, ...)
await asyncio.wait_for(proc.communicate(), timeout=600)
await _update_last_run(agent)  # always update, even on failure
```

Script paths:
```python
_WORKSPACE / "scripts" / "run_brain_curator.sh"
_WORKSPACE / "scripts" / "run_brain_linker.sh"
```

`_WORKSPACE` = `Path(__file__).parent.parent.parent` (3 levels up from `tools/opai-brain/scheduler.py` → workspace root).

---

## Frontend — app.js Architecture

### State Variables

```javascript
// Auth
let _supabase = null;      // Supabase JS client
let _session  = null;      // current session (has .access_token)
let _meData   = null;      // GET /api/me result {tier, features, research_quota, ...}

// Library
let _nodes        = [];       // all non-inbox library nodes
let _activeNodeId = null;     // currently open node id (null = new note)
let _activeTab    = 'library';
let _searchTimer  = null;     // debounce handle
let _dirty        = false;    // unsaved changes flag
let _previewMode  = false;    // markdown preview toggle
let _typeFilter   = 'all';    // type pill filter
let _tagFilter    = null;     // (future) tag filter
let _currentTags  = [];       // tags for open node

// Block editor (Phase 6)
let _editor     = null;      // EditorJS instance (singleton)
let _editorMode = 'block';   // 'block' | 'markdown'

// Inbox
let _inbox = [];

// Promote modal
let _promoteNodeId = null;

// AI actions
let _aiResult = null;
let _aiAction = null;

// Graph
let _graphData = null;
let _graphPanelNodeId = null;    // node shown in side panel
let _graphPanelCache = {};       // { summary: html, original: html|null }
let _graphPanelTags = [];        // current tags for open node
let _graphPanelFullNode = null;  // full node data for editing
let _graphPanelEditing = false;  // edit mode toggle
let _graphSim = null;            // D3 simulation reference
let _graphFrozen = false;        // freeze toggle
let _graphGroupBy = 'none';      // 'none' | 'source' | 'type'

// Canvas
let _canvasData   = null;    // {nodes[], links[]}
let _canvasSvg    = null;    // D3 selection of #canvas-svg
let _canvasZoom   = null;    // D3 zoom behavior
let _canvasLoaded = false;   // init guard (SVG needs visible dims)
let _connectSrc   = null;    // {node_id, x, y} during port drag
let _ctxPos       = {x:0,y:0}; // right-click canvas position (canvas coords)
let _ctxNodeId    = null;    // right-click target node id
let _posTimers    = {};      // debounce timers keyed by node id

// Canvas label modal (Phase 6)
let _pendingLinkSrc = null;  // source node id while label modal is open
let _pendingLinkTgt = null;  // target node id while label modal is open

// Snapshots (Phase 6)
let _snapshotDrawerOpen    = false;
let _activeSnapshotId      = null;
let _activeSnapshotContent = null;

// Research
let _researchSessions = [];
let _researchPollers  = {};  // session_id → setInterval handle

// Scheduler (Phase 6, admin only)
let _scheduleData  = {};
let _scheduleDirty = false;
```

### Init Flow

```
DOMContentLoaded → init()
  → fetch /brain/api/auth/config (no auth needed)
  → createClient(url, anon_key)
  → getSession() → if session: showApp(), else: showAuth()
  → onAuthStateChange listener
  → initBlockEditor()  ← Phase 6: creates EditorJS singleton

showApp()
  → loadMe()          → GET /api/me → _meData → applyTierGating()
  → loadLibrary()     → GET /api/nodes × 3 types → render sidebar
  → loadInbox()       → GET /api/inbox → render list + badge
  → loadResearch()    → GET /api/research → render sessions
  → loadSchedule()    → GET /api/admin/schedule (403 ignored for non-admin)
  (canvas loads lazily on first tab switch)
```

### apiFetch() Helper

```javascript
async function apiFetch(path, opts = {}) {
  const r = await fetch('/brain' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeader(), ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(await r.text() || r.statusText);
  return r.status === 204 ? null : r.json();
}
```

All API calls go through `/brain` prefix (Caddy strips it before forwarding to port 8101).

### Node Open/Edit Flow

```
openNode(id)
  → find node in _nodes[]
  → if dirty + confirm → _activeNodeId = id
  → showEditor(node)
    → show #editor-form, hide #editor-empty
    → set title, type-select
    → if _editorMode === 'block' && _editor:
        if node.metadata?.blocks: _editor.render({blocks})
        else: markdownToBlocks(node.content) → _editor.render()
    → set node-content textarea value (for markdown mode + preview)
    → renderTags(node.tags)
    → updateSaveBtn()
```

### Save Flow

```
saveNode()
  → collect title, type, pending tag input
  → if _editorMode === 'block':
      _editor.save() → {blocks}
      blocksToMarkdown(blocks) → content
      metadata.blocks = blocks
  → else: content = textarea.value
  → PATCH /api/nodes/{id} {title, content, type, tags, metadata}
      ↑ server-side: captures old_content → creates snapshot task
  → _dirty = false
  → loadLibrary() → openNode(id) (refreshes from DB)
```

### Canvas Architecture

```
SVG structure:
<svg id="canvas-svg">
  <g id="canvas-content">  ← D3 zoom transform applied here
    <rect (grid pattern)/>
    <g id="canvas-links"/>  ← path elements, drawn first (behind nodes)
    <line id="canvas-drag-line"/>  ← connection preview during drag
    <g id="canvas-nodes"/>  ← D3 groups per node
  </g>
</svg>
```

Node card DOM (per node, inside `#canvas-nodes`):
```
g.canvas-node (transform="translate(x,y)")
  rect (shadow, offset 2,3)
  rect.node-card (main card, click → Library)
  rect (type color accent bar, 4px wide)
  text (title, truncated to 22 chars)
  text (type label)
  circle×4.node-port (ports: right, left, top, bottom)
```

Port drag:
```
mousedown on port (with shiftKey or buttons===1):
  _connectSrc = {node_id, x: node.x + port.cx, y: node.y + port.cy}
  startConnecting(event)
    → show drag line, track mousemove, mouseup
    → on mouseup: find node under cursor (bounds check)
    → if target found && target !== src:
        showCanvasLabelModal(src, tgt)  ← Phase 6
        (was: createCanvasLink directly)
```

Position save:
```
drag end → saveNodePosition(id, x, y)
  → debounce 600ms
  → PATCH /api/canvas/nodes/{id}/position {x, y}
      → server fetches existing metadata, merges x/y, patches
```

Link rendering (strength visuals):
```javascript
const strength = lk.strength || 1;
path.setAttribute('stroke-width', (1 + strength * 3).toFixed(1));  // 1→4px
path.setAttribute('stroke-opacity', (0.4 + strength * 0.6).toFixed(2));  // 0.4→1.0
```

### Block Editor Integration

```javascript
function initBlockEditor() {
  // Called once from init() after DOMContentLoaded
  // EditorJS loaded as UMD global from CDN
  _editor = new EditorJS({
    holder: 'editor-block',        // div#editor-block in HTML
    placeholder: 'Write here…',
    autofocus: false,
    tools: {
      header:    { class: Header,    inlineToolbar: true, config: { levels:[2,3], defaultLevel:2 } },
      list:      { class: List,      inlineToolbar: true, config: { defaultStyle:'unordered' } },
      checklist: { class: Checklist, inlineToolbar: true },
      code:      { class: CodeTool },
      quote:     { class: Quote,     inlineToolbar: true },
      delimiter: { class: Delimiter },
    },
    onChange: () => markDirty(),
  });
}
```

**Critical**: `initBlockEditor()` must run after CDN scripts load. Called in `init()` (DOM ready). EditorJS initialises async internally — the `_editor` reference is set immediately but the editor may still be initialising. `_editor.render()` and `_editor.save()` return Promises — always `.catch()` or await safely.

### Snapshot Drawer

```
toggleSnapshotDrawer()
  → if opening && _activeNodeId: loadSnapshots(id)
    → GET /api/nodes/{id}/snapshots → render list items
  → #snapshot-drawer.classList.toggle('hidden', !open)

Click snapshot item:
  → previewSnapshot(snapshotId)
    → GET /api/nodes/{id}/snapshots/{sid} → {content, created_at}
    → show #snapshot-preview panel
    → display content in #snapshot-preview-content (pre element)

Click Restore:
  → restoreSnapshot()
    → fills textarea and/or re-renders block editor
    → markDirty() — user must Save to apply
    → toggleSnapshotDrawer()  (close drawer)
```

The drawer is `position: fixed` — it overlaps the editor. Z-index 200.

---

## HTML Structure — Key Elements

### Editor Area

```html
<!-- #editor-form (hidden until node opened) -->
<div id="editor-form" class="editor-body hidden">
  <input id="node-title">
  <div id="tags-row">...</div>
  <div id="editor-block"></div>          <!-- EditorJS mounts here (Phase 6) -->
  <textarea id="node-content" class="hidden">  <!-- markdown mode / preview fallback -->
  <div id="preview-area" class="hidden">  <!-- rendered markdown preview -->
</div>
```

### Toolbar Buttons

```html
<button id="btn-preview"  onclick="togglePreview()">Preview</button>
<button id="btn-mode"     onclick="toggleEditorMode()">⬚ Blocks</button>  <!-- Phase 6 -->
<button id="btn-history"  onclick="toggleSnapshotDrawer()">🕐 History</button>  <!-- Phase 6 -->
<button id="btn-save"     onclick="saveNode()" disabled>Save</button>
<button class="btn-delete" onclick="deleteNode()">Delete</button>
```

### Modals

```html
#ai-modal          — AI action result + Apply button
#related-modal     — Find Related results
#promote-modal     — Promote inbox item (title + type)
#canvas-label-modal — Canvas link label input + Suggest button (Phase 6)
```

### Drawers / Panels

```html
#snapshot-drawer   — right-side history drawer (position:fixed, z-200) (Phase 6)
#schedule-panel    — agent scheduler config (inside research tab, admin only) (Phase 6)
```

### Canvas

```html
<div id="tab-canvas" class="tab-panel canvas-panel">
  <div class="canvas-toolbar">...</div>
  <div class="canvas-surface" id="canvas-surface">
    <svg id="canvas-svg">
      <g id="canvas-content">  ← zoom target
        <g id="canvas-links"/>
        <line id="canvas-drag-line"/>
        <g id="canvas-nodes"/>
      </g>
    </svg>
    <div id="canvas-ctx-menu">...</div>   <!-- background right-click -->
    <div id="node-ctx-menu">...</div>     <!-- node right-click -->
    <div id="canvas-empty">...</div>
  </div>
</div>
```

---

## CSS — Key Selectors

```css
/* Layout */
body { height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
#app { display: flex; flex-direction: column; height: 100vh; }
.tab-panel { display: none; flex: 1; overflow: hidden; }
.tab-panel.active { display: flex; }
.library-layout { display: flex; flex: 1; overflow: hidden; }
.lib-editor { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.editor-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* Block editor (Phase 6) */
.editor-block { flex: 1; overflow-y: auto; padding: 8px 14px;
                background: var(--surface2); border: 1px solid var(--border); }
/* ~40 lines of .codex-editor / .ce-* dark theme overrides */

/* Canvas */
.canvas-panel { flex-direction: column; overflow: hidden; }  /* NOT display! */
.canvas-surface { flex: 1; position: relative; overflow: hidden; }

/* Snapshot drawer (Phase 6) */
.snapshot-drawer { position: fixed; right: 0; top: 0; bottom: 0;
                   width: 320px; z-index: 200; }

/* CSS variables */
--bg:          #0d0d0f
--surface:     #16161a
--surface2:    #1e1e24
--border:      #2a2a35
--accent:      #8b5cf6  (purple)
--accent-dim:  #6d28d9
--accent-glow: rgba(139,92,246,.18)
--text:        #e8e8f0
--text-muted:  #888
--sidebar-w:   280px
```

---

## Database — Table Details

### brain_nodes.metadata JSONB Keys

| Key | Phase | Purpose |
|-----|-------|---------|
| `canvas_x` | 3 | Canvas X position (float) |
| `canvas_y` | 3 | Canvas Y position (float) |
| `graph_x` | 9 | Graph X position (float) — persistent drag position |
| `graph_y` | 9 | Graph Y position (float) — persistent drag position |
| `blocks` | 6 | Editor.js block array (JSON) |
| `source` | 2 | "research" for AI-synthesized notes |
| `research_id` | 2 | UUID linking to brain_research row |
| `sync_dir` | sync | Source directory from library sync (e.g. "notes/plans", "Library/helm-playbooks") |
| `sync_source_path` | sync | Relative path to original file on disk (e.g. "notes/plans/my-plan.md") |

Never replace the entire metadata object — always merge:
```python
existing_meta = rows[0].get("metadata") or {}
merged = {**existing_meta, "canvas_x": x, "canvas_y": y}
```

### brain_links.link_type Values

| Value | Created by |
|-------|-----------|
| `canvas_edge` | User drag-connect on canvas |
| `ai_suggested` | brain_linker agent |
| `wikilink` | Future — auto-parse `[[Note Title]]` |

### Supabase REST Patterns

List with filter: `GET /rest/v1/brain_nodes?user_id=eq.{uid}&type=eq.note&limit=200`
Insert returning row: needs `Prefer: return=representation` header
Patch returning row: same header
Delete no return: `Prefer: return=minimal`
Postgrest IN clause: `id=in.(uuid1,uuid2,uuid3)` — note no spaces, parentheses

---

## Adding a New Feature — Checklist

### New API Route

1. Create or edit a `routes/X.py` file
2. Import router in `app.py`: `from routes.X import router as x_router`
3. Register: `app.include_router(x_router)`
4. Add to this DEV.md and to `Library/opai-wiki/brain.md`

### New UI Component

1. Add HTML to `index.html` (modal, drawer, panel)
2. Add CSS to `style.css` (use CSS vars, dark theme)
3. Add JS to `app.js` (state var, init call, event handlers)
4. If admin-only: check `_meData.role === 'admin'` and show/hide accordingly

### New Supabase Table

1. Write SQL — test with `./scripts/supabase-sql.sh "SELECT ..."`
2. Add to `config/supabase-migrations/028_brain.sql` (or a new 029_ file)
3. Enable RLS + add policy
4. Document columns in wiki + this file

### New Tier Gate (Backend)

```python
# In route function:
tier_row = await _sb_get("profiles", f"id=eq.{user.id}&select=subscription_tier")
tier = (tier_row[0].get("subscription_tier") or "starter") if tier_row else "starter"
if tier not in ("pro", "ultimate", "admin"):
    raise HTTPException(403, "This feature requires Pro or Ultimate plan")
```

### New Tier Gate (Frontend)

```javascript
// applyTierGating() reads _meData.features
// For new features, update GET /api/me response in tier.py
// Then check in JS:
if (!_meData?.features?.my_feature) { /* show upgrade notice */ }
```

---

## Known Bugs / Edge Cases

| Bug | Status | Detail |
|-----|--------|--------|
| EditorJS placeholder flicker | Known | Placeholder text appears briefly on node switch before blocks render |
| Block editor on mobile | Not supported | `_editorMode` always 'block' but Editor.js doesn't load on mobile (no CDN) — mobile uses textarea model |
| Snapshot on metadata-only save | Intentional | No snapshot if only metadata (canvas position) changes — snapshot only fires when `body.content is not None` |
| Suggest-label on duplicate links | Edge case | Canvas allows suggesting a label for a connection that already exists (duplicate check happens in POST /canvas/links, returns existing) |
| Scheduler vs. uvicorn reload | Dev only | `--reload` flag in dev mode restarts uvicorn workers; asyncio scheduler task is re-created on each reload. Fine for prod (no reload). |
| `croniter` timezone | Watch out | Library defaults to machine local time for calculations; `last_run_at` is UTC. Works correctly as long as cron expressions are in UTC intent. |

---

## Upgrade Path — Phase 4.5 Voice Capture

When ready to implement:

1. Install `expo-av` in mobile project: `npx expo install expo-av`
2. Add voice capture button to `app/(tabs)/brain/index.tsx`
3. Record audio → send to Whisper API (or Anthropic's audio support) → get transcript
4. Call `captureInbox(transcript)` via brainStore
5. Add server-side endpoint if needed: `POST /api/inbox/voice` (accepts audio blob)

---

## Upgrade Path — Embeddings

When ready to populate embeddings:

1. In `routes/nodes.py` `create_node()` and `update_node()` — after save, fire-and-forget task:
   ```python
   asyncio.create_task(_generate_embedding(node_id, content))
   ```
2. `_generate_embedding()` — call `text-embedding-3-small` API → PATCH `embedding` column
3. Enable HNSW index (in 028_brain.sql, currently commented out):
   ```sql
   CREATE INDEX brain_nodes_embedding_idx ON brain_nodes
   USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
   ```
4. Add `GET /api/search?mode=hybrid` in `routes/search.py` — combine FTS score + cosine similarity
5. Update mobile brainStore to support `mode=hybrid`

---

## Upgrade Path — Wikilink Auto-Links

When ready to parse `[[Note Title]]` from content into graph edges:

1. After save, parse content for `[[...]]` patterns
2. Query `brain_nodes` by title (exact match, user-scoped)
3. For each match, `POST /api/canvas/links` with `link_type: 'wikilink'`, `strength: 0.8`
4. Prevent duplicates (existing check in create_link route handles this)
5. On node delete — cascade deletes in `brain_links` (source_id/target_id FKs cascade already)

---

## Monitoring & Debugging

```bash
# Service logs (live)
journalctl --user -u opai-brain -f

# Check scheduler ran
journalctl --user -u opai-brain --since "24 hours ago" | grep scheduler

# Check a snapshot was written
./scripts/supabase-sql.sh "SELECT id, node_id, created_at, length(content) as chars FROM brain_snapshots ORDER BY created_at DESC LIMIT 10;"

# Check brain_schedule state
./scripts/supabase-sql.sh "SELECT agent, enabled, cron_expr, last_run_at FROM brain_schedule;"

# Check research sessions
./scripts/supabase-sql.sh "SELECT id, query, status, created_at FROM brain_research ORDER BY created_at DESC LIMIT 5;"

# Check AI endpoint (with auth token from browser devtools)
curl -H "Authorization: Bearer <token>" http://localhost:8101/api/me

# OpenAPI spec (all routes)
curl -s http://localhost:8101/openapi.json | python3 -c "
import json, sys
spec = json.load(sys.stdin)
for path, methods in spec['paths'].items():
    for method in methods:
        print(method.upper(), path)
" | sort
```

---

## Phase 6 — What Was Done (2026-02-22)

For reference when coming back to this codebase:

### Files Created
- `routes/snapshots.py` — version snapshot CRUD
- `routes/schedule.py` — admin scheduler API
- `scheduler.py` — background asyncio loop with croniter
- `scripts/prompt_braincurator.txt` — brain_curator agent prompt
- `scripts/run_brain_curator.sh` — brain_curator runner (chmod +x)
- `tools/opai-brain/DEV.md` — this file

### Files Modified
- `app.py` — added lifespan, snapshots_router, schedule_router imports
- `routes/nodes.py` — snapshot trigger in update_node()
- `routes/canvas.py` — suggest-label endpoint, PATCH links/{id}, LinkUpdate/SuggestLabelRequest models
- `requirements.txt` — added croniter
- `static/index.html` — Editor.js CDN scripts ×7, #editor-block div, mode toggle + history buttons, snapshot drawer, canvas label modal, schedule panel in research tab
- `static/app.js` — ~400 lines added: block editor init/toggle, md↔blocks converters, snapshot drawer UI, canvas label modal, scheduler UI, strength visuals in renderCanvasLinks
- `static/style.css` — ~130 lines: editor-block styles, Editor.js dark theme overrides, snapshot drawer, suggest-label button, schedule panel
- `scripts/prompt_brainlinker.txt` — added strength scoring instructions

### Database Changes
- `brain_schedule` table created (2 rows: curator, linker, both disabled)
- `croniter` installed system-wide: `pip3 install --break-system-packages croniter`

### Not Changed
- `brain_snapshots` table — already existed in 028_brain.sql ✅
- `brain_links.strength` column — already existed ✅
- Mobile app — no changes (block editor is web-only for now)
- Systemd unit — no changes
- Caddy config — no changes
- Monitor — no changes

---

## Phase 9 — Obsidian-Style Graph (2026-03-01)

Rewrote the Graph tab from a chaotic force-directed blob to an Obsidian-style knowledge graph with persistent positions, cluster grouping, and a full CRUD side panel.

### Problem Solved

With 60+ library-synced nodes and 233 links, the original D3 force graph was an unreadable tangle:
- Nodes snapped back after dragging (`d.fx = null` on drag end)
- No position persistence across page loads
- All nodes pulled to center — no grouping by source
- No way to view original source files (only AI summaries)
- Graph2 (ExcaliBrain-style) experiment was tried and removed

### Backend Changes — `routes/graph.py`

**Existing endpoint enhanced**:
- `GET /api/graph` — now extracts `graph_x`/`graph_y` from metadata and surfaces as `x`/`y` on each node; derives `group` from `metadata.sync_dir` using full path (not collapsed first segment)

**New endpoints**:
- `PATCH /api/graph/nodes/{id}/position` — save `{x, y}` → merged into `metadata.graph_x`/`graph_y`
- `POST /api/graph/save-all-positions` — bulk save for Lock All button. Body: `{positions: [{id, x, y}, ...]}`
- `POST /api/graph/reset-positions` — clear all `graph_x`/`graph_y` from metadata

**Group derivation** — `_derive_group(meta, node_type)`:
```python
# Uses full sync_dir path for granular grouping:
# "notes/plans" → "notes/plans" (NOT collapsed to "notes")
# "Library/helm-playbooks" → "helm-playbooks" (Library/ prefix stripped)
# No sync_dir → "manual:<type>"
```
This gives 5+ distinct groups instead of the original 2.

### Backend Changes — `routes/nodes.py`

**New endpoint**:
- `GET /api/nodes/{id}/original` — reads original source file from disk using `metadata.sync_source_path`. Resolves against workspace root, path traversal protection, returns `{source_path, filename, content, size}`.

### Frontend — Side Panel Architecture

The graph side panel (double-click a node) is now a full CRUD interface:

```
.graph-side-panel (slide-in from right, resizable)
├── resize handle (drag left edge, min 280px, max 70% viewport)
├── header: title (double-click to edit inline) + close button
├── meta: type badge, connection count, group label
├── tags: add/remove with optimistic UI
├── source path: sync_source_path when present
├── view toggle: Summary | Original | Edit
│   ├── Summary: rendered markdown (default)
│   ├── Original: fetched from GET /api/nodes/{id}/original
│   └── Edit: textarea with raw markdown, Save/Cancel buttons
├── connections: list with navigate + delete per connection
└── actions: Open in Library | Close
```

### Frontend — Graph Toolbar

```
Knowledge Graph | Auto-Suggest | Legend | Group By [None/Source Dir/Type] | Freeze | Lock All | Reset | [node count]
```

- **Group By**: adds `forceX`/`forceY` pulling nodes toward cluster centers
- **Freeze/Unfreeze**: stops/restarts simulation
- **Lock All**: pins all nodes + bulk-save positions to server
- **Reset**: confirm → clears all saved positions → re-simulates

### Key State Variables (app.js)

```javascript
let _graphPanelCache = {};       // { summary: html, original: html|null }
let _graphPanelTags = [];        // current tags for open node
let _graphPanelFullNode = null;  // full node data for editing
let _graphPanelEditing = false;  // edit mode active
let _graphSim = null;            // D3 simulation reference
let _graphFrozen = false;        // freeze state
let _graphGroupBy = 'none';      // grouping mode
```

### Key Functions Added

| Function | Purpose |
|----------|---------|
| `openGraphPanel(nodeData)` | Fetches full node, renders side panel with tags, connections, content |
| `graphPanelEditTitle()` | Double-click title → inline input, saves via PATCH |
| `_graphPanelRenderTags()` | Renders tag chips with add/remove |
| `graphPanelAddTagInput()` / `graphPanelRemoveTag(tag)` | Tag CRUD with optimistic UI |
| `graphPanelDeleteConn(linkId)` | Delete connection, re-render |
| `graphPanelShowSummary()` / `graphPanelShowOriginal()` | Toggle rendered views |
| `graphPanelStartEdit()` | Swap body for textarea with raw markdown |
| `graphPanelSaveEdit()` | PATCH content, refresh cache, return to summary view |
| `graphPanelCancelEdit()` | Discard changes, return to summary view |
| `saveGraphPosition(id, x, y)` | Debounced PATCH to `/api/graph/nodes/{id}/position` |
| `onGraphGroupChange(value)` | Set grouping mode, re-render clusters |
| `toggleGraphFreeze()` | Stop/restart simulation |
| `graphLockAll()` | Pin all + bulk POST |
| `graphResetLayout()` | Confirm + POST reset + re-render |
| `initPanelResize()` | IIFE: mousedown/move/up for drag-to-resize |

### Files Modified

| File | Changes |
|------|---------|
| `routes/graph.py` | Fixed `_derive_group()` for full path; added 3 new endpoints (position, bulk save, reset); added `_sb_patch`, `BaseModel`, `HTTPException` |
| `routes/nodes.py` | Added `GET /api/nodes/{id}/original` endpoint |
| `static/index.html` | Added resize handle, tags row, edit button + textarea area, removed Graph2 tab |
| `static/app.js` | ~300 lines added: side panel CRUD, edit mode, resize handler, group/freeze/lock/reset toolbar handlers. ~500 lines removed: Graph2 code |
| `static/style.css` | ~80 lines added: resize handle, tags, edit area, body spacing, connection delete. ~60 lines removed: all `.g2-*` styles |

### Database Changes

None — positions stored in existing `brain_nodes.metadata` JSONB column as `graph_x`/`graph_y`.

### Not Changed

- DB schema — no new tables or columns
- Systemd unit — no changes
- Caddy config — no changes
- Mobile app — no changes
