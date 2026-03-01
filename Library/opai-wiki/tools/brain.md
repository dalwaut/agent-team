# OPAI 2nd Brain — Wiki

> **Status**: Phase 8.1 Live (2026-02-27)
> **Service**: `opai-brain` | **Port**: `8101` | **Path**: `/brain/`
> **Tool dir**: `tools/opai-brain/` | **Stack**: FastAPI (Python) + Supabase + pgvector + Editor.js
> **Dev doc**: `tools/opai-brain/DEV.md` — detailed implementation reference

---

## Concept & Positioning

The 2nd Brain is the **cognitive layer of OPAI** — where ideas live, grow, connect, and get actioned. Purpose-built for *thinking work* rather than file management or chat history.

**Musical metaphor**: The 2nd Brain is the **Composer's Notebook** — where the score is written before it's handed to the Conductor.

Five tabs: **Library** (notes), **Inbox** (quick capture), **Canvas** (spatial board), **Research** (AI synthesis), **Graph** (force layout).

---

## Architecture Overview

```
tools/opai-brain/
├── app.py              — FastAPI app (port 8101), registers all routers, lifespan scheduler
├── config.py           — env + paths (HOST, PORT, SUPABASE_*, CLAUDE_MODEL)
├── claude_cli.py       — async helper: calls `claude --print` via subprocess (no API key)
├── requirements.txt    — fastapi, uvicorn, httpx, python-jose, python-dotenv, croniter
├── scheduler.py        — asyncio background loop: reads brain_schedule, runs agents via cron
├── .env                — Supabase credentials (no Anthropic API key needed)
├── routes/
│   ├── health.py       — GET /api/health (no auth)
│   ├── nodes.py        — CRUD for library nodes + tags; auto-snapshots on PATCH
│   ├── snapshots.py    — Version snapshot CRUD (max 20/node); write_snapshot() helper
│   ├── inbox.py        — quick capture, promote to Library, dismiss
│   ├── search.py       — full-text search (FTS via Supabase wfts)
│   ├── graph.py        — nodes + links formatted for D3 force-directed visualization
│   ├── canvas.py       — spatial canvas: positions, link CRUD, auto-layout, suggest-label, PATCH links
│   ├── schedule.py     — admin-only: GET/PATCH brain_schedule, POST run/{agent}
│   ├── ai.py           — AI co-editor actions (tier-gated: pro/ultimate/admin)
│   ├── research.py     — research sessions: Claude synthesis → Library note (tier-gated)
│   ├── suggestions.py  — Smart Suggestions engine: Claude Haiku semantic matching, accept/dismiss, cached 24h
│   ├── relationships.py — Phase 8.1: typed relationship CRUD, graph analytics (orphans, dead-ends, clusters)
│   └── tier.py         — GET /api/me: tier, features, research quota + usage
├── static/
│   ├── index.html      — SPA shell: 5 tabs, modals, snapshot drawer, schedule panel
│   ├── app.js          — Vanilla JS SPA (~2200 lines); all UI logic, block editor, canvas, suggestions
│   └── style.css       — OPAI dark theme (--bg #0d0d0f, --accent #8b5cf6 purple)
└── data/               — runtime data dir (created on startup if missing)
```

Claude model: `claude-sonnet-4-6` — configurable via `BRAIN_CLAUDE_MODEL` env var.
Haiku used for suggest-label (cheap, fast — only needs 5 words): `claude-haiku-4-5-20251001`.

---

## Phase Status

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 1** | Library (note CRUD, markdown editor, tags, wikilinks), Inbox (capture, promote, dismiss), Graph (D3 force layout), full-text search, auth, all infrastructure | ✅ **Live** |
| **Phase 2** | AI co-editor (expand/summarize/rewrite/extract_tasks/find_related), Research tab (Claude synthesis → Library note), tier gating foundation | ✅ **Live** |
| **Phase 3** | Canvas — spatial note board, drag-to-reposition (persisted), shift+drag port to connect, right-click menus, auto-layout | ✅ **Live** |
| **Phase 4** | Mobile Brain tab (Library + Inbox + node editor + AI toolbar), brain_linker agent + runner script | ✅ **Live** |
| **Phase 4.5** | Voice capture (requires `expo-av` install + Whisper/STT integration) | ⏳ Planned |
| **Phase 5** | Full tier gates — AI co-editor + Research gated by `marketplace_tier`; `GET /api/me`; research quota tracking and progress bar | ✅ **Live** |
| **Phase 6** | Block editor (Editor.js), version snapshots, canvas relationship label modal + AI suggest, agent scheduler (croniter), link strength visuals | ✅ **Live** |
| **Phase 7** | Smart Suggestions — Claude Haiku semantic matching across all 5 tabs; `brain_suggestions` table, 5 API endpoints, library sidebar, graph overlay + orphan detection, inbox chips, research related notes, canvas suggest links | ✅ **Live** |
| **Phase 8.1** | Relationship Intelligence — color-coded typed edges (8 types, 8 colors), `created_by` provenance tracking, enhanced graph popover (type chips, provenance counts, relationship creator), dead-end detection + orange pulse, graph legend toggle, relationship create modal, graph analytics API (orphans, dead-ends, clusters, bridges), `confidence` + `source` columns on nodes | ✅ **Live** |

---

## UI — Five Tabs

### Library Tab

The primary workspace — write, edit, and browse notes.

- **Left sidebar**: note list filtered by type (All / Note / Concept / Question) + debounced search bar
- **Right editor panel**: title field, tag chips (add via input, Enter or comma; click × to remove), block editor, preview toggle
- **Editor toolbar** (left→right): `+ New` | Type select | [spacer] | `Preview` | `⬚ Blocks` (mode toggle) | `🕐 History` (snapshot drawer) | `Save` | `Delete`
- **Status bar**: word count + character count (bottom of editor, updates live)
- **Keyboard shortcuts**: `Ctrl+S` save, `Ctrl+N` new note, `Escape` close modals/drawers, `beforeunload` guard for unsaved changes
- **AI Toolbar**: appears below editor toolbar when a saved node is open (tier-gated)
- **Related Notes sidebar** (Phase 7): below editor, auto-loads cached suggestions on node open; "Find Related" button generates fresh suggestions via Claude Haiku; cards show title, score badge (green/yellow/gray), reason; Accept creates link, Dismiss hides
- **Wikilinks**: `[[Note Title]]` render as clickable spans in preview → search + jump to that note
- **Note types**: `note` (blue), `concept` (purple), `question` (green) — each gets a color badge

### Inbox Tab

Quick capture queue. All captured items start as `type: inbox` nodes.

- **Capture box**: textarea + Capture button → `POST /api/inbox`
- **Pending list**: inbox items sorted newest first
- **Promote**: modal → set title + destination type → `PATCH /api/inbox/{id}/process` → becomes Library node
- **Dismiss**: deletes the node permanently
- **Tab badge**: shows count of pending inbox items (updates in realtime on capture/dismiss)
- **Related chips** (Phase 7): below each inbox item body, shows up to 3 "Related: {note title}" chips with score %; clicking chip auto-promotes the inbox item and creates a link to that note

### Canvas Tab (Phase 3+6)

Freeform spatial board — lay out notes visually, draw explicit connections. User-controlled positions (persisted); distinct from Graph which is auto-computed.

| Feature | Detail |
|---------|--------|
| **Drag to reposition** | Drag any node card; position saved to `metadata.canvas_x/y` (600ms debounce) |
| **Draw connections** | Shift+drag from a port circle (appears on node hover) → release on target → **label modal** pops (Phase 6) |
| **Label modal** | Optional label input + "✦ Suggest" button calls Claude Haiku (tier-gated) → fills input → "Connect" creates link |
| **Delete connection** | Right-click any link line → confirm dialog |
| **Link strength** | Stroke width: `1 + strength×3` px (1px weak → 4px strong). Opacity: `0.4 + strength×0.6` |
| **Right-click canvas** | "New note here" (placed at cursor coords) · "Auto layout" |
| **Right-click node** | "Edit in Library" · "Delete note" |
| **Click node card** | Jump to Library editor for that note |
| **Auto Layout** | Toolbar button — resets all positions to 5-column grid (220×120px cells, origin 80,80) |
| **Suggest Links** (Phase 7) | Toolbar button — generates suggestions for up to 10 canvas nodes, draws dashed amber bezier curves for suggested connections, click curve → accept/dismiss popover |
| **Orphan highlights** (Phase 7) | Nodes with 0 connections get pulsing amber dashed border |
| **Zoom/pan** | Scroll to zoom (0.1–3×), drag background to pan (D3 zoom on `#canvas-content` group) |
| **Node colors** | note=blue #3b82f6, concept=purple #8b5cf6, question=green #10b981 |

Links: `brain_links` table, `link_type='canvas_edge'`. Positions: `brain_nodes.metadata.canvas_x/y` (merged — never replace whole metadata).

### Research Tab (Phase 2, tier-gated)

AI research synthesis. Tier-gated: pro / ultimate / admin only.

- **Query input + scope** → `POST /api/research` → background synthesis runs async
- Claude writes a structured Markdown note (executive summary, key concepts, core findings, implications, related topics, open questions)
- Result deposited into Library as `type: note`, tagged `research`
- **Session list** polls every 3s while running: `pending` → `running` → `done`/`failed`
- **Open Note**: when done, jump to result in Library
- **Quota bar**: progress bar showing monthly sessions used (pro/ultimate only; admin = unlimited)
- **Related Notes in Library** (Phase 7): below completed research sessions, shows up to 3 suggestion cards linking the research result to existing library notes
- **Agent Schedule panel** (admin only): shown below sessions list — see Scheduler section

### Graph Tab

Auto-computed force-directed graph. Node layout is automatic (D3 force simulation), not persisted — distinct from Canvas.

- D3 force layout: link distance 80, charge -120, center force
- Node color by type; click → jumps to Library editor
- Drag nodes during session (not persisted), zoom/pan via d3.zoom
- Tooltip on hover shows title
- **Color-coded edges** (Phase 8.1): edges colored by relationship type — related (#60a5fa blue), supports (#22c55e green), contradicts (#ef4444 red), derived_from (#a78bfa purple), suggested (#f59e0b amber dashed), blocks (#f97316 orange), enables (#06b6d4 cyan), canvas_edge (#6b7280 gray). Strength still drives width+opacity.
- **Legend toggle** (Phase 8.1): "Legend" button in toolbar → shows/hides color key box (bottom-left)
- **Suggested connections** (Phase 7): dashed amber lines between nodes with pending suggestions; click → accept/dismiss popover
- **Orphan node highlights** (Phase 7): nodes with 0 connections get pulsing amber ring animation
- **Dead-end node highlights** (Phase 8.1): nodes with outgoing links but no incoming links get pulsing orange ring (distinct from orphan amber)
- **Auto-Suggest button** (Phase 7): in toolbar, generates suggestions for top 10 most-recently-edited nodes then re-renders graph
- **Right-click popover** (Phase 7+8.1): shows node title, type badge, connection count, **relationship type chips** (colored by type, e.g. "2 supports, 1 contradicts"), **provenance indicator** ("3 manual · 1 AI"), top 3 suggestions with accept action, "Find Suggestions", "Open in Library", and **"+ Relationship"** buttons
- **Relationship create modal** (Phase 8.1): source pre-filled, searchable target dropdown, radio type picker (7 types with color dots), optional label, strength slider (0.0-1.0), calls `POST /api/relationships`
- **Stats bar**: shows total nodes, links, orphan count, and dead-end count

### AI Toolbar (Phase 2, tier-gated)

Appears below editor toolbar when a saved node is open. Tier: pro / ultimate / admin.

| Action | Behavior |
|--------|----------|
| **Expand** | Claude expands selected text (or full note) with depth, examples, detail |
| **Summarize** | Returns 2–4 bullet summary |
| **Rewrite** | Rewrites for clarity |
| **Extract Tasks** | Pulls action items as `- [ ]` checklist |
| **Find Related** | Scans last 50 notes, returns up to 5 semantically similar ones |

Select text first to act on a selection. Without selection, acts on full note. Result in modal → "Apply to Note" replaces content or appends (summarize/extract_tasks append to end). Find Related opens a separate panel with jump links.

---

## Block Editor (Phase 6)

### Overview

Editor.js — Notion-style block editor loaded via CDN (no build step). Replaces the raw markdown textarea as the default editing surface. Markdown textarea preserved and hidden — toggled via mode switch.

### CDN Versions (in index.html)

```html
<script src="https://cdn.jsdelivr.net/npm/@editorjs/editorjs@2.29.0/dist/editorjs.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@editorjs/header@2.8.1/dist/header.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@editorjs/list@1.9.0/dist/list.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@editorjs/checklist@1.6.0/dist/checklist.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@editorjs/code@2.9.0/dist/code.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@editorjs/quote@2.6.0/dist/quote.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@editorjs/delimiter@1.4.0/dist/delimiter.umd.min.js"></script>
```

### Block Types

| Block | Editor.js type | Markdown mapping |
|-------|---------------|-----------------|
| Paragraph | `paragraph` | Plain text |
| Heading | `header` (level 2 or 3) | `## text` / `### text` |
| Bullet list | `list` (style: unordered) | `- item` |
| Numbered list | `list` (style: ordered) | `1. item` |
| Checklist | `checklist` | `- [x] item` / `- [ ] item` |
| Code block | `code` | `` ``` ... ``` `` |
| Blockquote | `quote` | `> text` |
| Divider | `delimiter` | `---` |

### Data Flow

```
openNode(node)
  ├── if node.metadata.blocks (array) → _editor.render({ blocks })
  └── else → markdownToBlocks(node.content) → _editor.render({ blocks })

saveNode()
  ├── _editor.save() → { blocks }
  ├── blocksToMarkdown(blocks) → content (for FTS + AI actions)
  ├── metadata.blocks = blocks  (persisted JSON in JSONB column)
  └── PATCH /api/nodes/{id} with { content, metadata, ... }
```

### Mode Toggle

`_editorMode` state variable: `'block'` (default) | `'markdown'`.

Button `#btn-mode` in toolbar — clicking calls `toggleEditorMode()`:
- **block → markdown**: sync textarea from `_editor.save()` → `blocksToMarkdown()`, show textarea, hide `#editor-block`
- **markdown → block**: sync editor from `markdownToBlocks(textarea.value)`, show `#editor-block`, hide textarea

### Markdown ↔ Blocks Converters

`markdownToBlocks(md)` — line-by-line parser:
- Detects `` ``` `` fences for code blocks (buffering until close)
- Aggregates consecutive list / checklist lines into one block
- `---` → delimiter, `> text` → quote, `## / ### / #` → header levels
- Falls back to paragraph for everything else
- Always returns at least `[{type:'paragraph',data:{text:''}}]`

`blocksToMarkdown(blocks)` — maps block array → markdown string, joined with `\n\n`.

### Dark Theme Overrides (style.css)

~40 lines of `.codex-editor` and `.ce-*` overrides using CSS vars (`--text`, `--surface2`, `--border`, `--accent`, `--bg`). Key ones: `.ce-paragraph`, `.ce-header`, `.ce-code__textarea`, `.cdx-quote__text`, `.cdx-checklist__item-text`, inline toolbar background, settings popup.

---

## Version Snapshots (Phase 6)

### How It Works

Every time a node's content changes (PATCH with a non-empty `content` diff), `routes/nodes.py` fires a fire-and-forget `asyncio.create_task(write_snapshot(node_id, old_content))` BEFORE applying the patch. This means you always capture what was there *before* the save, not after.

```python
# In update_node() after ownership verify, before patch:
old_content = existing[0].get("content")
# ... apply patch ...
if body.content is not None and old_content and old_content.strip():
    asyncio.create_task(write_snapshot(node_id, old_content))
```

`write_snapshot()` in `routes/snapshots.py`:
1. `INSERT INTO brain_snapshots (node_id, content)` — `created_at` auto-stamps
2. Fetch all snapshot IDs for the node ordered newest→oldest
3. If count > 20: delete oldest until 20 remain

Snapshot writes never fail the main save — errors are logged and swallowed.

### API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/nodes/{id}/snapshots` | List snapshots (id + created_at only, newest first, max 20) |
| GET | `/api/nodes/{id}/snapshots/{sid}` | Full snapshot with `content` field |
| DELETE | `/api/nodes/{id}/snapshots/{sid}` | Delete one snapshot |

Both routes verify node ownership via `brain_nodes.user_id` check before returning snapshot data.

### UI — History Drawer

`#snapshot-drawer` — slides in from right side of screen (fixed position, 320px wide, z-index 200).

Flow:
1. Click `🕐 History` button → `toggleSnapshotDrawer()` → loads snapshot list
2. Click a snapshot → `previewSnapshot(id)` → fetches full content → shows in preview panel below list
3. "Restore" → fills editor (block or textarea mode) with snapshot content, marks dirty → user saves manually
4. `✕` per snapshot item → `deleteSnapshotItem()` → deletes and refreshes list

---

## Canvas Label Modal (Phase 6)

### Connection Flow

Old (Phase 3): shift+drag → release → immediately `POST /api/canvas/links`
New (Phase 6): shift+drag → release → show `#canvas-label-modal` → user types label (optional) → Connect

State: `_pendingLinkSrc`, `_pendingLinkTgt` (node IDs, set when drag completes).

Functions:
- `showCanvasLabelModal(srcId, tgtId)` — stores pending IDs, clears input, shows modal
- `cancelCanvasLink()` — clears state, hides modal
- `confirmCanvasLink()` — reads label input, calls `createCanvasLink(src, tgt, label)`
- `suggestCanvasLabel()` — `POST /api/canvas/suggest-label { source_id, target_id }` → fills input

### Suggest-Label Endpoint

`POST /api/canvas/suggest-label` in `routes/canvas.py`:
- Tier check: `profiles.subscription_tier` must be `pro | ultimate | admin` → 403 otherwise
- Fetches title + content[:500] of both nodes
- Claude Haiku prompt: "What is the relationship from A to B? Reply with ONLY a concise 1-5 word label."
- Returns `{ suggested_label: str }`
- Uses `claude-haiku-4-5-20251001` for speed + cost efficiency

---

## Link Strength Visuals (Phase 6)

`brain_links.strength FLOAT DEFAULT 1.0` — already in schema from Phase 3. Now used in canvas rendering.

In `renderCanvasLinks()`:
```javascript
const strength = lk.strength || 1;
const strokeWidth = (1 + strength * 3).toFixed(1);  // 1px weak → 4px strong
const opacity = (0.4 + strength * 0.6).toFixed(2);  // 40% dim → 100% solid
```

The `brain_linker` agent (Phase 4+) now receives instructions to set `strength` per relationship:
- **0.9–1.0**: very direct (same concept, parent/child, explicit reference)
- **0.6–0.8**: clear relationship (same topic, complementary ideas)
- **0.3–0.5**: loose or speculative connection

`PATCH /api/canvas/links/{id}` — update label and/or strength on existing links.

---

## Agent Scheduler (Phase 6)

### Architecture

`scheduler.py` runs as an `asyncio` background task launched in `app.py`'s `lifespan` context:

```python
@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(scheduler_loop())
    yield
    task.cancel()
    try: await task
    except asyncio.CancelledError: pass
```

`scheduler_loop()` checks `brain_schedule` table every **60 seconds**. For each enabled agent that is "due" (cron expression has fired since `last_run_at`), spawns the agent script as a subprocess and updates `last_run_at`.

### brain_schedule Table

```sql
CREATE TABLE brain_schedule (
  agent        text PRIMARY KEY,  -- 'curator' | 'linker'
  enabled      boolean DEFAULT false,
  cron_expr    text DEFAULT '0 9 * * *',
  last_run_at  timestamptz
);
```

Default rows inserted on first deploy: `curator` and `linker`, both disabled.

### Cron Evaluation

Uses `croniter` (Python package). `_is_due(cron_expr, last_run_at)`:
1. Compute `croniter.get_prev()` — previous scheduled fire time relative to now
2. If `last_run_at` is NULL → run now (first-ever run)
3. If `last_run_at < prev_fire_time` → due (run was missed)

### Agent Subprocess

```python
proc = await asyncio.create_subprocess_exec(
    "bash", str(script),
    env={k:v for k,v in os.environ.items() if k != "CLAUDECODE"},  # unset so claude CLI can spawn
    stdout=PIPE, stderr=PIPE,
)
await asyncio.wait_for(proc.communicate(), timeout=600)
```

`CLAUDECODE` env var is stripped before subprocess — otherwise nested `claude` CLI calls are blocked.
`last_run_at` updated after each run regardless of exit code.

### Scheduler Config API (admin-only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/schedule` | Returns `{curator: {...}, linker: {...}}` config |
| PATCH | `/api/admin/schedule` | Update `{curator_enabled, curator_cron, linker_enabled, linker_cron}` |
| POST | `/api/admin/schedule/run/{agent}` | Trigger immediately (fires `asyncio.create_task(trigger_agent(agent))`) |

All three routes call `_require_admin(user)` — returns 403 for non-admin.

### Scheduler UI (Admin Only)

Schedule panel in Research tab (hidden for non-admin). `loadSchedule()` called from `showApp()` — catches 403 silently, panel stays hidden.

Fields: enabled checkbox, cron expression input, "Run Now" button per agent.
"Save Schedule" button enabled only when values have changed (`scheduleChanged()` sets `_scheduleDirty = true`).

### Agents

| Agent | Script | Prompt | Output |
|-------|--------|--------|--------|
| `brain_curator` | `scripts/run_brain_curator.sh` | `scripts/prompt_braincurator.txt` | `reports/latest/brain-curator.md` |
| `brain_linker` | `scripts/run_brain_linker.sh` | `scripts/prompt_brainlinker.txt` | `reports/latest/brain-linker.md` |

Both use `claude --print --output-format text --max-turns 20` in read-only agent mode. Unset `CLAUDECODE` before calling.

---

## Smart Suggestions (Phase 7)

AI-powered similarity engine that discovers related notes across all 5 tabs. Uses Claude Haiku (`claude-haiku-4-5-20251001`) for fast, cheap semantic matching via the existing `claude_cli.py` subprocess pattern. No embeddings API needed.

**Backend**: `routes/suggestions.py` — 5 endpoints:
- `POST /api/suggestions` — Generate suggestions for a node (by ID) or raw text query
- `GET /api/suggestions/for/{node_id}` — Get cached suggestions for a node
- `GET /api/suggestions/pending` — All pending suggestions for user (graph overlay)
- `POST /api/suggestions/accept` — Accept → creates `brain_links` row (link_type='suggested')
- `POST /api/suggestions/dismiss` — Dismiss → hides suggestion

**Table**: `brain_suggestions` (migration `032_brain_suggestions.sql`):
- `source_id`, `target_id` → `brain_nodes(id)` FK with ON DELETE CASCADE
- `score` (0.0–1.0), `reason` (short text), `status` (pending/accepted/dismissed)
- UNIQUE(source_id, target_id), RLS by user_id

**Caching**: Suggestions cached 24h in DB. Frontend caches in memory for 5 min.

**Tier gate**: Same as AI editor — requires pro/ultimate/admin.

**Frontend integration** (all 5 tabs):
1. **Library**: Related Notes sidebar below editor; loads on node open, "Find Related" button for fresh generation
2. **Graph**: Dashed amber lines for pending suggestions, amber pulsing rings for orphan nodes (0 connections), right-click popover with node info + top 3 suggestions, "Auto-Suggest" toolbar button generates for top 10 nodes
3. **Inbox**: "Related to: {note}" chips below each item; clicking chip auto-promotes and links
4. **Research**: "Related Notes in Library" section below completed research sessions
5. **Canvas**: "Suggest Links" toolbar button, dashed amber bezier curves for suggestions, pulsing borders on orphan nodes

**Score badge colors**: green (>=0.7), yellow (>=0.4), gray (<0.4)

---

## Relationship Intelligence (Phase 8.1)

Color-coded typed edges, provenance tracking, enhanced graph analytics, and a dedicated relationship creation UI.

**Backend**: `routes/relationships.py` — 3 endpoints:
- `GET /api/relationships/{node_id}` — All links for a node (both directions), enriched with peer node title/type, direction, `created_by`. Returns grouped `type_counts`.
- `POST /api/relationships` — Create typed relationship. Body: `{source_id, target_id, link_type, label?, strength?}`. Sets `created_by='user'`. Prevents duplicates (same source+target+type).
- `GET /api/graph/stats` — Graph analytics: `orphan_count`, `dead_end_count`, `cluster_count` (connected components), `bridge_node_count`, plus ID lists for orphans/dead-ends.

**Migration**: `config/supabase-migrations/038_brain_phase8_relationships.sql`
- `brain_links.created_by` (text, default `'user'`) — provenance tracking
- `brain_nodes.confidence` (integer, default 3) — 1=speculative .. 5=certain
- `brain_nodes.source` (text, default `'manual'`) — how the node was created

**Provenance flow**:
- Manual link creation (canvas or relationship modal): `created_by='user'`
- Accepted Smart Suggestion: `created_by='suggestion'`
- Future agent-created: `created_by='agent'`

**8 link types with colors**:

| Type | Color | Hex | Usage |
|------|-------|-----|-------|
| `related` | Blue | `#60a5fa` | General semantic relationship (default) |
| `supports` | Green | `#22c55e` | Evidence, corroboration |
| `contradicts` | Red | `#ef4444` | Conflict, disagreement |
| `derived_from` | Purple | `#a78bfa` | Source material, parent concept |
| `suggested` | Amber | `#f59e0b` | AI-suggested (dashed line) |
| `blocks` | Orange | `#f97316` | Prerequisite, dependency |
| `enables` | Cyan | `#06b6d4` | Unlocks, makes possible |
| `canvas_edge` | Gray | `#6b7280` | Canvas-drawn connection |

**Dead-end detection**: Nodes with outgoing links but zero incoming links. Orange pulse animation (distinct from orphan amber pulse). Count shown in stats bar.

---

## Tier Gates

Feature access gated by `profiles.marketplace_tier`. Backend enforces at route level; frontend reflects via `GET /api/me`.

| Feature | admin | ultimate | pro | starter | (none) |
|---------|-------|----------|-----|---------|--------|
| Library + Inbox + Graph + Canvas | ✅ | ✅ | ✅ | ✅ | ✅ |
| Block editor | ✅ | ✅ | ✅ | ✅ | ✅ |
| Version snapshots | ✅ | ✅ | ✅ | ✅ | ✅ |
| Link strength visuals | ✅ | ✅ | ✅ | ✅ | ✅ |
| AI co-editor | ✅ | ✅ | ✅ | ✗ | ✗ |
| Research tab | ✅ unlimited | ✅ 20/mo | ✅ 20/mo | ✗ | ✗ |
| Canvas suggest-label | ✅ | ✅ | ✅ | ✗ | ✗ |
| Smart Suggestions (Phase 7) | ✅ | ✅ | ✅ | ✗ | ✗ |
| Scheduler UI | ✅ | ✗ | ✗ | ✗ | ✗ |

HTTP error codes: `403` insufficient tier · `429` monthly quota reached.

`GET /api/me` response shape:
```json
{
  "id": "uuid",
  "email": "...",
  "display_name": "...",
  "role": "admin | user",
  "marketplace_tier": "admin | ultimate | pro | starter",
  "features": { "ai_editor": true, "research": true },
  "research_quota": 20,
  "research_used": 3
}
```

---

## Data Model

Migration: `config/supabase-migrations/028_brain.sql`

### Tables

| Table | Purpose |
|-------|---------|
| `brain_nodes` | Core content — notes, concepts, questions, inbox items |
| `brain_links` | Directed edges between nodes (knowledge graph + canvas connections) |
| `brain_tags` | Composite PK `(node_id, tag)` — flat tag system |
| `brain_research` | Agentic research sessions with status tracking |
| `brain_snapshots` | Version history snapshots per node (max 20 per node, auto-pruned) |
| `brain_schedule` | Agent scheduler config (curator, linker) — created 2026-02-22 |
| `brain_suggestions` | AI-generated similarity suggestions between nodes — created 2026-02-23 |
| `brain_api_keys` | Reserved for future user-provided AI keys (currently unused) |

### `brain_nodes` columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid FK | `auth.users`, cascade delete |
| `type` | text | `note` \| `concept` \| `question` \| `inbox` |
| `title` | text | default '' |
| `content` | text | Markdown — always populated even in block mode (converted via `blocksToMarkdown`) |
| `metadata` | jsonb | `canvas_x`, `canvas_y`, `blocks` (Editor.js block array), `source`, `research_id`, etc. |
| `confidence` | integer | Phase 8.1 — 1=speculative .. 5=certain, default 3 |
| `source` | text | Phase 8.1 — `manual` \| `graduated` \| `imported` \| `agent-suggested` |
| `embedding` | vector(1536) | **NULL** — not yet populated (Phase 4.5+) |
| `fts_vector` | tsvector | auto-updated via trigger on `title + content` |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | auto-updated by FTS trigger |

**metadata.blocks**: Editor.js block array (JSON). Stored alongside `content` (markdown). When a node has `metadata.blocks`, the block editor renders from blocks; otherwise auto-converts from `content`. FTS and AI actions always use `content` (markdown).

### `brain_links` columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid | ownership |
| `source_id` | uuid FK | `brain_nodes.id` |
| `target_id` | uuid FK | `brain_nodes.id` |
| `label` | text | relationship label ("supports", "leads to", "example of") |
| `link_type` | text | `related` \| `supports` \| `contradicts` \| `derived_from` \| `suggested` \| `blocks` \| `enables` \| `canvas_edge` |
| `strength` | float | 0.0–1.0, default 1.0; drives canvas stroke width+opacity |
| `created_by` | text | Phase 8.1 — provenance: `user` (manual), `suggestion` (accepted Smart Suggestion), `agent` (future) |
| `created_at` | timestamptz | |

### `brain_snapshots` columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `node_id` | uuid FK | `brain_nodes.id`, cascade delete |
| `content` | text | Markdown content at time of snapshot |
| `created_at` | timestamptz | |

No `user_id` — ownership verified by joining through `brain_nodes`.

### `brain_schedule` columns

| Column | Type | Notes |
|--------|------|-------|
| `agent` | text PK | `'curator'` \| `'linker'` |
| `enabled` | boolean | default false |
| `cron_expr` | text | standard 5-field cron (`0 9 * * *` = 9am daily) |
| `last_run_at` | timestamptz | updated after each run; NULL = never run |

### `brain_research` columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `query` | text | user's research topic |
| `status` | text | `pending` → `running` → `done` \| `failed` |
| `result_node` | uuid FK | `brain_nodes.id` once synthesis complete |
| `created_at` | timestamptz | |

**Status is `'done'` not `'complete'`** — use `'done'` everywhere.

### `brain_suggestions` columns (Phase 7)

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid FK | `auth.users`, for RLS |
| `source_id` | uuid FK | `brain_nodes.id`, cascade delete |
| `target_id` | uuid FK | `brain_nodes.id`, cascade delete |
| `score` | float | 0.0–1.0 relevance score from Claude Haiku |
| `reason` | text | Short explanation (max ~100 chars) |
| `status` | text | `pending` \| `accepted` \| `dismissed` |
| `created_at` | timestamptz | Used for 24h cache TTL |

UNIQUE constraint on `(source_id, target_id)`. Indexes on `(source_id, status)` and `(user_id, status)`.

Migration: `config/supabase-migrations/032_brain_suggestions.sql`

### FTS Trigger

`brain_nodes_fts_trigger` fires BEFORE INSERT OR UPDATE — executes:
```sql
NEW.fts_vector := to_tsvector('english', NEW.title || ' ' || NEW.content);
NEW.updated_at := now();
```

### Key Indexes

| Index | Type | On |
|-------|------|----|
| `brain_nodes_fts_idx` | GIN | `fts_vector` |
| `brain_nodes_user_idx` | BTREE | `(user_id, type, updated_at DESC)` |
| `brain_links_source_idx` | BTREE | `source_id` |
| `brain_links_target_idx` | BTREE | `target_id` |
| `brain_tags_tag_idx` | BTREE | `tag` |
| `idx_brain_suggestions_source` | BTREE | `(source_id, status)` |
| `idx_brain_suggestions_user` | BTREE | `(user_id, status)` |

HNSW vector index on `embedding` defined in migration but commented out — enable when embeddings are populated.

### RLS

All tables have RLS enabled. Core policy: `FOR ALL USING (auth.uid() = user_id)`. `brain_tags` and `brain_snapshots` join through `brain_nodes` to verify ownership.

---

## Full API Reference

All `/api/*` routes require `Authorization: Bearer <supabase_jwt>` unless marked "None".

### Auth / Meta

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/config` | None | Returns `supabase_url` + `supabase_anon_key` for frontend init |
| GET | `/api/health` | None | Service health — status, uptime, memory |
| GET | `/api/me` | JWT | Tier, features, research quota + usage |

### Nodes (Library)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/nodes` | List nodes. Params: `type`, `tag`, `limit` (max 500), `offset` |
| GET | `/api/nodes/{id}` | Single node with tags |
| POST | `/api/nodes` | Create. Body: `{type, title, content, metadata, tags[]}` |
| PATCH | `/api/nodes/{id}` | Partial update. Body: same fields, all optional. Triggers snapshot. |
| DELETE | `/api/nodes/{id}` | Delete node + cascade tags |
| POST | `/api/nodes/{id}/ai` | AI action (tier-gated). Body: `{action, selection?}` |

AI actions: `expand` · `summarize` · `rewrite` · `extract_tasks` · `find_related`
Response: `{action, result}` or `{action, result, related_ids, related_nodes}` for find_related.

### Snapshots (Phase 6)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/nodes/{id}/snapshots` | List snapshots for node (id + created_at, newest first, max 20) |
| GET | `/api/nodes/{id}/snapshots/{sid}` | Single snapshot with content field |
| DELETE | `/api/nodes/{id}/snapshots/{sid}` | Delete one snapshot |

### Inbox

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/inbox` | List all `type=inbox` nodes |
| POST | `/api/inbox` | Capture. Body: `{content, title?}` |
| PATCH | `/api/inbox/{id}/process` | Promote to Library. Body: `{title?, type?}` |
| DELETE | `/api/inbox/{id}` | Dismiss |

### Search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/search?q=&mode=` | Full-text search. `mode=full` (default). Returns nodes with tags |

### Graph

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/graph` | All non-inbox nodes + links formatted for D3 |

### Canvas

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/canvas` | All non-inbox nodes + links with canvas positions |
| PATCH | `/api/canvas/nodes/{id}/position` | Save `{x, y}` → merged into node metadata |
| POST | `/api/canvas/auto-layout` | Reset all positions to 5-col grid |
| GET | `/api/canvas/links` | List all links |
| POST | `/api/canvas/links` | Create link `{source_id, target_id, label?, link_type?, strength?}` |
| PATCH | `/api/canvas/links/{id}` | Update `{label?, strength?}` (Phase 6) |
| DELETE | `/api/canvas/links/{id}` | Delete link |
| POST | `/api/canvas/suggest-label` | AI label suggestion `{source_id, target_id}` → `{suggested_label}` (Phase 6, tier-gated) |

### Research (tier-gated: pro / ultimate / admin)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/research` | List sessions |
| POST | `/api/research` | Start. Body: `{query, scope?}` → background synthesis |
| GET | `/api/research/{id}` | Poll status + result node when done |
| DELETE | `/api/research/{id}` | Delete session (result note kept) |

Status: `pending` → `running` → `done` | `failed`

### Smart Suggestions (Phase 7, tier-gated: pro / ultimate / admin)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/suggestions` | Generate suggestions. Body: `{node_id}` or `{text, context?}`. Returns cached if <24h old. |
| GET | `/api/suggestions/for/{node_id}` | Get cached pending suggestions for a node |
| GET | `/api/suggestions/pending` | All pending suggestions for user (graph/canvas overlay) |
| POST | `/api/suggestions/accept` | Accept. Body: `{suggestion_id}`. Creates `brain_links` row, marks accepted. |
| POST | `/api/suggestions/dismiss` | Dismiss. Body: `{suggestion_id}`. |

Suggestion generation: fetches source node (title + 500 chars), up to 30 candidates (title + 200 chars), asks Claude Haiku to score relevance (0.0–1.0) with 5-word reasons. Only results >= 0.3 are stored. Existing accepted/dismissed suggestions are preserved (not overwritten).

Accept flow: inserts `brain_links` with `link_type='suggested'`, `strength=score`, `label=reason`.

### Relationships (Phase 8.1)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/relationships/{node_id}` | All links for a node (both directions), enriched with peer title/type, direction, `created_by`. Returns `type_counts`. |
| POST | `/api/relationships` | Create typed relationship. Body: `{source_id, target_id, link_type, label?, strength?}`. Sets `created_by='user'`. |
| GET | `/api/graph/stats` | Graph analytics: orphan/dead-end/cluster/bridge counts + ID lists. |

### Scheduler (Phase 6, admin-only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/schedule` | Returns `{curator: {enabled, cron_expr, last_run_at}, linker: {...}}` |
| PATCH | `/api/admin/schedule` | Body: `{curator_enabled?, curator_cron?, linker_enabled?, linker_cron?}` |
| POST | `/api/admin/schedule/run/{agent}` | Trigger agent immediately (fire-and-forget task) |
| GET | `/api/scheduler/settings` | Runtime scheduler state `{tick_seconds, paused}` (for TCP heartbeat control) |
| PUT | `/api/scheduler/settings` | Update tick interval / pause toggle (body: `{tick_seconds?, paused?}`) |

---

## Auth Pattern

Same as all OPAI FastAPI tools:
1. Frontend fetches `GET /brain/api/auth/config` → gets Supabase URL + anon key
2. Supabase JS SDK handles session (`signInWithPassword`, `onAuthStateChange`)
3. All API calls include `Authorization: Bearer <access_token>`
4. Backend validates via `tools/shared/auth.py` → `AuthUser` (id, email, role, marketplace_tier, etc.)

---

## Mobile App — Brain Tab (Phase 4)

Location: `Projects/OPAI Mobile App/opai-mobile/app/(tabs)/brain/`

```
app/(tabs)/brain/
├── _layout.tsx     — Stack navigator (index → node/[id])
├── index.tsx       — Library list + Inbox capture (tab switcher)
└── node/
    └── [id].tsx    — Node detail: editor, type selector, tags, AI toolbar
```

Store: `stores/brainStore.ts` (Zustand) — covers all node/inbox/search/AI operations.

Note: Mobile app currently uses the markdown textarea model only (Phase 6 block editor is web-only). Voice capture (Phase 4.5) pending `expo-av` install.

---

## Agent Squad

| Agent | Script | Prompt | Output |
|-------|--------|--------|--------|
| `brain_curator` | `scripts/run_brain_curator.sh` | `scripts/prompt_braincurator.txt` | `reports/latest/brain-curator.md` |
| `brain_linker` | `scripts/run_brain_linker.sh` | `scripts/prompt_brainlinker.txt` | `reports/latest/brain-linker.md` |

**brain_curator**: Reviews inbox queue — categorizes items, suggests promotions/dismissals/merges. HITL only — no auto-actions. Max 10 recommendations per run.

**brain_linker**: Semantic analysis of all nodes — creates up to 20 new `brain_links` (`link_type: "ai_suggested"`), sets `strength` scores (0.3–1.0), flags orphans. Requires human review of report before links are trusted.

---

## Embedding Strategy

| Phase | State |
|-------|-------|
| Phase 1–6 | `embedding VECTOR(1536)` column exists but is **NULL** — not populated |
| Phase 1–6 | `fts_vector` powers all search |
| Future | Embeddings generated on save; `GET /api/search?mode=hybrid` — cosine + FTS combined |
| Future | HNSW index on `embedding` enabled |

---

## Deployment

### Service

```
systemd user unit: opai-brain.service
Path: /home/dallas/.config/systemd/user/opai-brain.service
WorkingDirectory: /workspace/synced/opai/tools/opai-brain
ExecStart: /usr/bin/python3 -m uvicorn app:app --host 127.0.0.1 --port 8101
EnvironmentFile: tools/opai-brain/.env
```

```bash
systemctl --user restart opai-brain
systemctl --user status opai-brain
journalctl --user -u opai-brain -f
```

### Caddy

```caddy
handle_path /brain/* {
    reverse_proxy localhost:8101
}
@brainExactS path /brain
redir @brainExactS /brain/ 301
```

Brain is in `FULL_HEIGHT_TOOLS` list in `navbar.js` — required for proper flex layout and internal scrolling.

### Portal Dashboard

```js
{ id: 'brain', href: '/brain/', icon: '🧠', title: '2nd Brain',
  desc: 'Cognitive layer — Library, Inbox, knowledge graph with semantic search',
  css: 'card-brain', svcKey: 'brain' }
```

### Monitor

`brain` in `_HEALTH_SERVICES` (port 8101) and `SYSTEMD_SERVICES` in monitor config.

---

## Common Operations

```bash
# Restart service
systemctl --user restart opai-brain

# Health check
curl http://localhost:8101/api/health

# Run brain_linker now
./scripts/run_brain_linker.sh

# Run brain_curator now
./scripts/run_brain_curator.sh

# Check scheduler is running
journalctl --user -u opai-brain --since "1 hour ago" | grep scheduler

# Apply migration (first-time setup)
./scripts/supabase-sql.sh --file config/supabase-migrations/028_brain.sql

# Create brain_schedule table (Phase 6, already applied)
./scripts/supabase-sql.sh "SELECT * FROM brain_schedule;"

# Install croniter (if missing)
pip3 install --break-system-packages croniter
```

---

## Content Strategy — What Goes in Brain vs Library

The 2nd Brain and the filesystem Library (`Library/`) serve different purposes. This section defines the boundary.

### Brain = Personal Thinking Space

Brain is for **your** ideas, decisions, research, and connections. It's a notebook, not a filing cabinet.

| Content Type | How it gets there | Example |
|-------------|-------------------|---------|
| Ideas & notes | Manual — Inbox capture or Library tab | "What if HELM ran a GEO audit service?" |
| Decisions & rationale | Manual — write a note when you decide something | "Chose hybrid bridge approach for Brain ↔ Library" |
| Research sessions | Brain's Research tab (AI synthesis) | "Research: autonomous agent monetization models" |
| YouTube insights | Brain's YouTube integration | Save/summarize a relevant video |
| Questions to explore | Manual — `question` node type | "Should we add pgvector embeddings?" |
| HELM playbook summaries | **Auto-bridged** from Library (future) | Summary of `helm-playbooks/geo-audit-service.md` |
| Research artifacts | **Auto-bridged** from `Research/` (future) | Summary of `Research/IDEAboutit/IDEAboutIt-Technical-Spec.md` |

### Library = System Knowledge for Agents

Library stays on disk as the source of truth for system documentation, references, and assets.

| Library Section | Purpose | Bridged to Brain? |
|----------------|---------|-------------------|
| `opai-wiki/` (58 docs) | System architecture, tool docs | No — agents read directly |
| `knowledge/` (22 docs) | Dev commands, API refs, contexts | No — too granular for thinking |
| `helm-playbooks/` (3 docs) | Revenue model playbooks | **Yes** — summaries + source link |
| `Stack/WordPress/` | Design system tokens | No — agent/builder reference |
| `References/` | External research, archives | No — raw reference material |
| `n8n/` | Workflow archives | No — internal tooling |

| Non-Library Source | Purpose | Bridged to Brain? |
|-------------------|---------|-------------------|
| `Research/` (33 files) | PRDs, business opportunities, architecture research, ideas | **Yes** — all of it, summaries + source link |

### Library & Research Bridge (Planned)

When implemented, a sync script will auto-bridge content from two sources into Brain:

**Source 1 — HELM Playbooks** (`Library/helm-playbooks/`):
- 3 business model playbooks
- Tagged: `helm`, `playbook`, `library`

**Source 2 — Research** (`Research/`):
- 33 files: PRDs, architecture research, business opportunities, lead gen, game concepts, optimization studies
- Tagged by topic: `research`, `prd`, `business`, `architecture`, etc.
- Includes: Open Claw, Mobile App, Theia IDE, Hytale, GEO Optimization, Morning Dew, SpotPoint, IDEAboutIt, lead gen, wshobson, agentic systems, hosting migration

**Sync process (both sources)**:
1. Scan source directories for `.md`, `.json`, `.docx`, `.rtf` files
2. Generate AI summary for each (skip empty/stub files)
3. Create/update Brain nodes with appropriate type and tags
4. Store `source_path`, `source_type` (helm/research), and `last_synced` in node metadata
5. Auto-link related nodes in the graph (e.g., all Hytale research linked together, GEO research linked to HELM GEO playbook)
6. Skip binary assets (PNGs, ZIPs) — reference them in metadata only

This keeps ideas, opportunities, and research graph-connected to your personal thinking without duplicating system docs.

### The Key Habit

Use Brain's **Inbox** for quick captures as you work. Drop in ideas, decisions, questions — anything worth remembering or connecting later. The curator agent can help organize. The value of Brain grows with use.

---

## Known Gotchas

| Issue | Detail |
|-------|--------|
| Research status | DB enum is `'done'` not `'complete'` — use `'done'` everywhere |
| `.canvas-panel` display | Must NOT set `display` — only set `flex-direction` and `overflow`; conflicts with `.tab-panel { display: none }` |
| Canvas DOM static | `#canvas-content` group must remain static in HTML — never move it at runtime |
| Canvas lazy init | `initCanvasSvg()` only sets up zoom/pan; `loadCanvas()` never called from `showApp()` — SVG dimensions are 0 while hidden |
| Position metadata merge | Canvas position PATCH: fetch existing metadata → merge `canvas_x/y` → PATCH. Never replace whole metadata object — wipes `blocks` and other keys |
| Block editor + preview | Preview hides BOTH `#editor-block` and `#node-content`; restore correct one when toggling preview off based on `_editorMode` |
| `metadata.blocks` presence | Always check `Array.isArray(node.metadata?.blocks) && blocks.length` before calling `_editor.render()` — empty array should fall through to `markdownToBlocks()` |
| Snapshot fire-and-forget | `asyncio.create_task()` in an async route — must be called from within a running event loop (uvicorn context). Never call with `await` or it blocks the response |
| `CLAUDECODE` env var | Set by Claude Code sessions — unset it before spawning `claude` CLI subprocesses or the nested call is blocked |
| Scheduler `last_run_at` NULL | First-ever run: `_is_due()` returns `True` when `last_run_at is None`. This is intentional — runs immediately on first enable |
| croniter timezone | `croniter` works in UTC by default; `brain_schedule` uses `timestamptz`. OPAI Server runs CST — be aware when setting cron expressions for time-of-day jobs |
| Editor.js UMD globals | CDN loads as global `EditorJS`, `Header`, `List`, `Checklist`, `CodeTool`, `Quote`, `Delimiter`. If a CDN version changes class names, update `initBlockEditor()` accordingly |
| Suggest-label cost | Uses Haiku (cheapest model). Still counted against the account's API usage. Only call on user action — never auto-trigger |
| AI toolbar button selector | `document.querySelectorAll('.ai-toolbar .ai-btn')` — class is `ai-btn`, not `btn-ai`. Both exist in the codebase for different button styles |
| AI uses Claude Code CLI | All AI features (co-editor, research, suggest-label) use `claude --print` subprocess via `claude_cli.py`, NOT the `anthropic` SDK. No API key needed. |
| Node metadata merge | `update_node()` now merges incoming metadata with existing (was replacing). Safe to send partial metadata from block editor or canvas. |
| AI actions + block editor | `aiAction()` syncs block editor → textarea before reading content. `applyAiResult()` syncs back to block editor. |
| Research error_message | `brain_research.error_message` column stores failure details. Frontend shows on hover. |

---

## Planned / Future Work

| Feature | Notes |
|---------|-------|
| **Voice capture (Phase 4.5)** | Mobile: `expo-av` mic recording → Whisper/STT → transcript to Inbox |
| **Embeddings** | Generate `text-embedding-3-small` on save; enable hybrid search |
| **HNSW semantic search** | Enable once embeddings exist; `/api/search?mode=hybrid` |
| **Wikilink graph** | Parse `[[Note Title]]` in content → auto-create `link_type: 'wikilink'` links |
| **Canvas minimap** | Small-scale overview of full canvas for navigation |
| **Multi-user spaces** | Shared Library / Canvas for team collaboration |
| **Export** | Library → Markdown ZIP, Canvas → PNG/SVG |
| **Block: image/embed** | Editor.js Image block (requires server-side upload endpoint) |
| **brain_curator auto-promote** | After HITL approval step, allow curator to auto-promote high-confidence items |
| **Library & Research bridge** | Auto-sync summaries from `Library/helm-playbooks/` (3 docs) and `Research/` (33 files) → Brain nodes with `source_path` metadata; auto-link related nodes |

---

## Related Files

| File | Purpose |
|------|---------|
| `tools/opai-brain/` | Service root |
| `tools/opai-brain/DEV.md` | **Full developer reference** — state vars, JS architecture, gotchas |
| `tools/opai-brain/routes/ai.py` | AI co-editor — tier-gated actions |
| `tools/opai-brain/routes/research.py` | Research synthesis — tier-gated + quota |
| `tools/opai-brain/routes/youtube.py` | [YouTube transcriber](youtube-transcriber.md): save video as node, start research from transcript |
| `tools/opai-brain/routes/canvas.py` | Canvas positions + link CRUD + suggest-label |
| `tools/opai-brain/routes/relationships.py` | Phase 8.1 — typed relationship CRUD + graph analytics |
| `tools/opai-brain/routes/snapshots.py` | Version snapshot CRUD |
| `tools/opai-brain/routes/schedule.py` | Admin scheduler config API |
| `tools/opai-brain/routes/tier.py` | `GET /api/me` — tier info + quota |
| `tools/opai-brain/scheduler.py` | Background asyncio scheduler loop |
| `tools/shared/auth.py` | JWT validation + profile enrichment |
| `config/supabase-migrations/028_brain.sql` | DB schema — tables, pgvector, FTS, RLS |
| `config/supabase-migrations/038_brain_phase8_relationships.sql` | Phase 8.1 — `created_by`, `confidence`, `source` columns |
| `config/service-templates/opai-brain.service` | Systemd unit template |
| `config/Caddyfile` | `/brain/` reverse proxy route |
| `tools/opai-portal/static/index.html` | Portal dashboard tile |
| `tools/opai-portal/static/js/navbar.js` | Navbar entry + FULL_HEIGHT_TOOLS |
| `team.json` | `brain` squad definition |
| `scripts/prompt_brainlinker.txt` | brain_linker prompt (includes strength scoring) |
| `scripts/run_brain_linker.sh` | brain_linker runner |
| `scripts/prompt_braincurator.txt` | brain_curator prompt |
| `scripts/run_brain_curator.sh` | brain_curator runner |
| `Projects/OPAI Mobile App/opai-mobile/stores/brainStore.ts` | Mobile Zustand store |
| `Projects/OPAI Mobile App/opai-mobile/app/(tabs)/brain/` | Mobile Brain tab screens |
| `notes/Improvements/2nd Brain.md` | Original design spec |
