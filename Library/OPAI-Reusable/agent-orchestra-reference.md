# Agent Orchestra — Complete System Reference
> Written: 2026-02-21 | Author: Dallas + Claude (Sonnet 4.6) | For: Team + future AI reference
> Source: `tools/opai-orchestra/` | Live at: `/orchestra/` | Port: `8098`

---

## What This Document Is

This is a complete, narrative reference for the Agent Orchestra system — written so that any team member or AI assistant can understand the system end-to-end without reading the source code first. It covers the philosophy behind the design, every architectural decision made, how each module works, the math behind the visualisation, all interaction patterns, and known gotchas.

The wiki entry (`Library/opai-wiki/agent-orchestra.md`) is a compact reference. This document is the full story.

---

## 1. Why Agent Orchestra Exists

### The Problem with "Agent Studio"

Agent Studio (`/agents/`) is the operational tool for managing agents. It works well — you can create, edit, and run agents and squads. But it presents AI agents the way software presents configuration: lists of items, forms with fields, technical IDs. For a power user who knows what `run_order: parallel` means, this is fine. For anyone else, it's opaque.

The deeper problem: OPAI's brand identity is built around a **musical metaphor**. The Orchestrator is a conductor. Agents are musicians. Squads are ensembles. Reports are performances. This language is used in documentation, landing pages, and pitches. But the actual tools didn't reflect it — they spoke entirely in technical terms.

### The Solution

Agent Orchestra is a **visual reimagination** of the same system, speaking the same musical language the brand uses. It is:

- A **standalone tool** at `/orchestra/` that reads all data from the Agent Studio backend (`/agents/api/*`)
- A **three-level visual experience**: the full orchestra pit → a section/squad → an individual musician
- A **design showcase** that demonstrates what OPAI's AI system looks and feels like at its best
- **Not a replacement** for Agent Studio — both coexist. Studio is the admin workhorse; Orchestra is the user-facing showcase

The guiding design question was: *if you were introducing someone to OPAI's agent system for the first time, what would you show them?*

---

## 2. The Musical Metaphor — Complete Mapping

Every technical term in the agent system maps to a musical equivalent. This is not superficial renaming — the metaphors are carefully chosen to be intuitive:

| Musical Term | Technical Term | Why It Maps |
|-------------|----------------|-------------|
| **Musician** | Agent | An AI specialist performing a defined role — just like a musician performing a defined part |
| **Programme** | Squad | A programme is what an orchestra performs — a named collection of pieces (agents) that go together |
| **Section** | Category | Strings, brass, woodwinds — each section has specialists with similar instruments/roles |
| **Score** | Prompt Content | The written instructions the musician follows — literally what gets "played" |
| **Instrument Grade** | Model (Claude Haiku/Sonnet/Opus) | A violin can be a student model or a Stradivarius — the grade determines capability |
| **Max Bars** | Max Turns | How many bars (turns) the musician plays before stopping |
| **Solo Mode** | Skip Project Context | A soloist doesn't need the full ensemble's context — plays their own part independently |
| **When They Play** | Run Order | The conductor tells each section when to enter: Intro (overture), Main Movement (allegro), Coda (finale) |
| **Intro** | run_order: first | The opening — setup, familiarisation tasks |
| **Main Movement** | run_order: parallel | The bulk of the performance — concurrent with other agents |
| **Coda** | run_order: last | The closing — consolidation, dispatch, summary |
| **Cued By** | Depends On | A musician waits for their cue from another before their part is considered |
| **Programme Note** | Description | The brief text in a concert programme explaining what a piece/musician does |
| **Musician Initials** | Emoji/Badge | The 2-character badge displayed on a musician's seat |
| **Composition Studio** | Agent Flow Editor | Where a composer writes — visual canvas for building pipelines |
| **Concert Hall** | Run History | The performance venue — where past performances are recorded |
| **Symphony** | Workflow | A multi-movement work — one programme completing triggers the next |
| **Rehearse** | Preview Execution | Practice run — see the execution order without actually performing |
| **Perform Now** | Run Squad | Opening night — execute the programme via Claude CLI |
| **Inherit** | System Default | Uses whatever model the Orchestrator has configured globally |

### Section → Instrument Family Mapping

Each agent category maps to an instrument section in the orchestra:

| Category | Section Name | Instrument | Colour | Analogy |
|----------|-------------|------------|--------|---------|
| `leadership` | Conductor | 🎼 | `#ef4444` red | Leads and coordinates — the conductor doesn't play but directs everything |
| `quality` | Strings | 🎻 | `#10b981` green | The backbone of any orchestra — reliable, versatile, essential |
| `planning` | Woodwinds | 🎵 | `#3b82f6` blue | Thoughtful, structured, often carry the melody (the plan) |
| `research` | Brass | 🎺 | `#f59e0b` amber | Loud, powerful, cuts through — research that makes an impact |
| `security` | Security Ensemble | 🛡️ | `#dc2626` red | A dedicated ensemble — security is critical and separate |
| `operations` | Percussion | 🥁 | `#8b5cf6` purple | Keeps the beat — operations maintain the rhythm of the system |
| `content` | Keyboards | 🎹 | `#ec4899` pink | Versatile, melodic — content creation spans everything |
| `execution` | Timpani | ⚡ | `#06b6d4` cyan | The big execution moments — dramatic, decisive |
| `meta` | Harp | 🔮 | `#94a3b8` grey | Background texture — meta/utility agents that support everything else |
| `orchestration` | Organ | 🔔 | `#f97316` orange | The organ fills the whole hall — orchestration ties everything together |

---

## 3. System Architecture

### How It Connects

```
Browser → Caddy (:443) → /orchestra/* → opai-orchestra (port 8098)
                     → /agents/api/* → opai-agents (port 8088)

opai-orchestra:
  - Serves static files (index.html, style.css, JS modules)
  - Exposes /orchestra/api/auth/config (Supabase keys for frontend auth)
  - All agent/squad/run data comes from /agents/api/* directly

opai-agents:
  - The authoritative backend (unchanged)
  - Orchestra calls it as AGENTS_API = '/agents/api'
  - Same JWT auth, same Supabase project
```

**Key principle**: Orchestra has zero backend logic for agent data. It is a pure frontend that reads/writes through Agent Studio's API. If you change something in Orchestra, it immediately appears in Studio, and vice versa.

### File Structure

```
tools/opai-orchestra/
├── app.py                 FastAPI app — 3 routes only
├── config.py              Port 8098, static dir path, Supabase env vars
├── requirements.txt       fastapi, uvicorn, python-dotenv
├── .env                   Symlink → ../opai-agents/.env (shared Supabase keys)
└── static/
    ├── index.html         Full SPA — all 7 views + 3 modals + tooltip div
    ├── style.css          Concert hall design system (~1,400 lines)
    └── js/
        ├── app.js         Foundation: auth, state, nav, TERM_MAP, SECTION_DEFS, tooltip
        ├── orchestra.js   Level 1: SVG orchestra pit visualisation
        ├── section.js     Level 2: Section/squad phase-lane view
        ├── musician.js    Level 3: Individual agent editor (the "music stand")
        ├── concert-hall.js  Panel: Run history + report viewer
        ├── calendar.js    Panel: Cron schedule manager
        ├── symphony.js    Panel: Multi-squad workflow builder
        └── composition.js Panel: Visual flow editor (Composition Studio)
```

### The Backend (`app.py`)

Only three routes:

```python
GET  /orchestra/api/auth/config   → {supabase_url, supabase_anon_key}
GET  /orchestra/static/*          → static file serving
GET  /orchestra/*                 → index.html (SPA catch-all)
```

Everything else hits `/agents/api/*` directly from the browser, routed by Caddy to the Agent Studio backend on port 8088.

---

## 4. Foundation Layer (`app.js`)

`app.js` is loaded first and sets up everything the other modules depend on.

### Auth Flow

```javascript
initAuth()
  → fetch('/orchestra/api/auth/config')     // get Supabase keys
  → supabase.createClient(url, anonKey)
  → sb.auth.getSession()                    // check existing session
  → if no session → redirect to /auth/login
  → if non-admin → check /api/me/apps for 'agents' permission
  → store token, currentUser
  → sb.auth.onAuthStateChange(...)          // keep token fresh
```

`apiFetch(path, opts)` is the universal data fetching function. It prepends `AGENTS_API = '/agents/api'` to the path, injects the `Authorization: Bearer {token}` header, and handles 401 redirects.

### State Object

```javascript
const State = {
    agents:        [],    // all agents from /agents/api/agents
    squads:        [],    // all squads from /agents/api/squads
    categories:    [],    // from /agents/api/meta/categories
    activeRuns:    [],    // from /agents/api/runs/active (polled every 4s)
    currentView:   'orchestra',
    currentSection: null,   // squad ID when in section view
    currentMusician: null,  // agent ID when in musician view
    liveInterval:  null,    // setInterval handle for live polling
};
```

State is a plain object — no reactivity framework. Views re-render themselves when called by `navigateTo`.

### Navigation (`navigateTo`)

```javascript
navigateTo(view, params = {})
```

- Hides all `.orch-view` sections
- Shows the target `#view-{view}` section
- Updates `State.currentSection` / `State.currentMusician` from `params`
- Updates the breadcrumb trail
- Calls the appropriate render function: `OrchestraPit.render()`, `SectionView.render(...)`, etc.
- For `composition`, passes the full `params` object to `CompositionStudio.render(params)` so squad preload works

### TERM_MAP and Tooltip System

`TERM_MAP` is a flat object mapping 24 orchestra term keys to `{tech, desc}`. Every form label in the musician view and section view has an `ℹ` icon wired to `data-term="key"`:

```html
<span class="term-info" data-term="score">ℹ</span>
```

The `Tooltip` IIFE listens for `mouseover` on any `[data-term]` element and shows a floating div:

```
┌─────────────────────────────────┐
│ Score                           │  ← orchestra term (formatted)
│ Studio term: Prompt Content     │  ← technical name
│ The instructions given to...    │  ← plain-English description
└─────────────────────────────────┘
```

The tooltip follows the cursor with edge-aware positioning (flips if it would overflow the viewport).

### Live Polling

`startLivePoll()` calls `refreshActiveRuns()` every 4 seconds. When in orchestra view, it also calls `OrchestraPit.updateLive()` to update the visual live-run overlay on musician seats.

---

## 5. Level 1 — The Orchestra Pit (`orchestra.js`)

This is the centrepiece — a full SVG visualisation of all agents as seated musicians.

### Why SVG, Not Canvas or DOM

SVG was chosen because:
- It scales cleanly at any viewport size (viewBox)
- Text rendering is crisp and accessible
- Elements can be individually targeted for animation/hover
- No canvas state management needed

The SVG uses a fixed `viewBox="0 0 900 490"` — the internal coordinate space never changes regardless of screen size. CSS scales it to fill available space.

### The Row-Band Layout System

**The original design used concentric circular arcs.** This caused a serious visual overlap problem at the sides of each arc. Here is the geometry of why:

A circular arc centred below the canvas at `(cx=450, cy=570)` with radius `r` and half-angle `aMax` has:
- Centre point: `y = cy - r` (the middle of the arc band)
- Side points: `y = cy - r·cos(aMax)` (higher up on screen, i.e. towards audience)

For two adjacent sections with radii `r1=178` (quality) and `r2=248` (planning) at `aMax=50°` and `aMax=56°`:
- Quality sides: `y = 570 - 178·cos(50°) = 570 - 114 = 456`
- Planning sides: `y = 570 - 248·cos(56°) = 570 - 139 = 431`

The bands only 25px apart at the sides while 67px apart at centre — causing visual overlap at the extremes.

**The fix: row-band geometry.** Each section occupies a guaranteed non-overlapping horizontal band defined by:

```javascript
const SECTION_ROWS = {
//  category:    { yCtr, parabH, bandH, xL,  xR  }
    leadership:  { yCtr: 450, parabH: 4,  bandH: 28, xL: 392, xR: 508 },
    quality:     { yCtr: 385, parabH: 11, bandH: 38, xL: 218, xR: 682 },
    planning:    { yCtr: 319, parabH: 15, bandH: 38, xL: 162, xR: 738 },
    research:    { yCtr: 252, parabH: 18, bandH: 38, xL: 112, xR: 788 },
    security:    { yCtr: 184, parabH: 20, bandH: 38, xL: 66,  xR: 834 },
    operations:  { yCtr: 116, parabH: 22, bandH: 36, xL: 24,  xR: 876 },
};
```

Where:
- `yCtr` — the centreline y-coordinate for agents in this section
- `parabH` — how many pixels the sides of the arc bow downward from centre (creates the orchestra pit curve)
- `bandH` — total height of the section band (inner edge to outer edge)
- `xL`, `xR` — left and right x-coordinates bounding this section

Small/special categories (meta, content, orchestration, execution) use a **top row** split:
```javascript
const TOP_LEFT_ZONES  = { meta: [20, 180], content: [200, 360] };
const TOP_RIGHT_ZONES = { orchestration: [540, 700], execution: [720, 880] };
const TOP_Y = 50;
```

### Agent Positioning Formula

Within each band, agents are distributed along a parabolic arc. For the `i`-th agent out of `n` total, the parameter `t = i / (n-1)` (or `0.5` for a single agent):

```javascript
const ax = xL + t * (xR - xL);               // linear x distribution
const ay = yCtr - parabH * 4 * t * (1-t);    // parabolic y (bows toward audience)
```

The parabola `4t(1-t)` has value `0` at `t=0` and `t=1` (the sides), and peaks at `1.0` when `t=0.5` (the centre). Multiplied by `parabH`, this means agents at the centre of a section sit `parabH` pixels above the centreline (further from the audience), while agents at the sides sit exactly on the centreline. This creates the classic curved front-of-section look.

### Band Background Drawing

Each section gets a curved background shape drawn as an SVG path using **quadratic bezier curves** for the inner and outer edges:

```javascript
// Inner edge (front/audience side): y increases downward
const yInnerMid  = yCtr + bandH/2;
const yInnerSide = yCtr + parabH + bandH/2;
const cpInnerY   = 2*yInnerMid - yInnerSide;  // control point (mirrors the bezier)

// Outer edge (back): same logic
const yOuterMid  = yCtr - bandH/2;
const yOuterSide = yCtr + parabH - bandH/2;
const cpOuterY   = 2*yOuterMid - yOuterSide;

// Path: M left-inner Q mid-inner right-inner L right-outer Q mid-outer left-outer Z
```

The control point formula `cp = 2*mid - side` is the standard trick for making a quadratic bezier that passes through `mid` at `t=0.5` — the control point is reflected through the midpoint.

### Musician Seat Elements

Each agent is rendered as an SVG `<g>` group (`class="svg-musician-seat"`, `id="seat-{agentId}"`):

```
<g transform="translate(ax, ay)">
  <circle r="17" class="seat-ring" />     ← hover ring (normally 25% opacity)
  <circle r="12" class="seat-circle" />   ← main fill (coloured per section)
  <text class="seat-label" />             ← 2-char initials, centred
  <text class="seat-name" y="20" />       ← agent name below, 6.5px
</g>
```

Click → `navigateTo('musician', {musicianId: agent.id, sectionId: State.currentSection})`

Hover → `_showTooltip(agent, e)` — shows floating tooltip with name, section, description, run order, model

### Live Run Overlay

`OrchestraPit.updateLive()` runs every 4 seconds when in orchestra view:

```javascript
State.activeRuns.forEach(r => {
    (r.agents_running || []).forEach(id => running.add(id));
    (r.agents_done   || []).forEach(id => done.add(id));
});
document.querySelectorAll('.svg-musician-seat').forEach(g => {
    const circle = g.querySelector('.seat-circle');
    circle.classList.toggle('seat-live', running.has(id));   // pulsing gold
    circle.classList.toggle('seat-done', done.has(id));      // dimmed check
});
```

### Programme Dimming

When a programme is selected from the `#pit-programme-select` dropdown:

```javascript
// squad.agents may be full objects OR plain ID strings — normalise
const rawAgents = squad?.agents || [];
const memberIds = new Set(rawAgents.map(a => typeof a === 'object' ? a.id : a));

seats.forEach(g => {
    const inProgramme = memberIds.has(g.dataset.agentId);
    g.style.opacity       = inProgramme ? '1' : '0.08';
    g.style.filter        = inProgramme ? '' : 'grayscale(1)';
    g.style.pointerEvents = inProgramme ? '' : 'none';
});
```

**Critical gotcha**: `squad.agents` from the API is an array of **full agent objects** `{id, name, category, ...}`, not plain strings. If you do `new Set(squad.agents)` and then `memberIds.has(agentId)` where `agentId` is a string, it always returns `false` because you're comparing a string to objects. Always normalise first.

Deselecting the programme resets all seats: `style.opacity = ''`, `style.filter = ''`, `style.pointerEvents = ''` (removing inline styles falls back to CSS).

### View Flow Button

When a programme is selected, the `🖊️ View Flow` button becomes enabled. Clicking it calls:
```javascript
navigateTo('composition', { squadId });
```
Which passes `params` to `CompositionStudio.render(params)`, which calls `preloadSquad(squadId)` automatically.

### Legend Filter

`filterBySection(cat)` dims agents not in the clicked category. It also clears any programme highlight (the two filters are mutually exclusive — selecting a programme resets the legend filter and vice versa).

---

## 6. Level 2 — Section View (`section.js`)

The section view shows a single squad (programme) as a concert section, organised by execution phase.

### Phase Lanes

```
┌──────────────────────────────────────────────────────────┐
│  🎵 Intro          │  🎶 Main Movement      │  🎷 Coda  │
│  (run_order:first) │  (run_order:parallel)  │  (last)   │
│                    │                        │           │
│  [Agent Card]      │  [Agent Card]          │  [Agent]  │
│                    │  [Agent Card]          │           │
└──────────────────────────────────────────────────────────┘
```

Each musician card shows: initials badge, name, category/instrument, remove button. The agent pool sidebar on the right lets you search and add musicians by dragging or clicking.

### Adding Musicians

`addToSection(agentId)` calls:
```javascript
PUT /agents/api/squads/{squadId}
Body: { agents: [...existingIds, agentId] }
```

Agents are stored by ID in the squad definition. The section view resolves them to full objects via `State.agents`.

### Perform / Rehearse

- **Perform**: `POST /agents/api/runs/squad/{squadId}` → starts a run
- **Rehearse**: `GET /agents/api/squads/{squadId}/execution-order` → shows the planned execution sequence in a modal without running

---

## 7. Level 3 — Musician View (`musician.js`)

The musician view is the agent editor. It presents the same data as Agent Studio's agent form but in the musical metaphor, with a score-paper editor for the prompt.

### Layout

```
┌─────────────────┬──────────────────────────────────────────────────┐
│   SIDEBAR 1/4   │   SCORE AREA 3/4                                 │
│                 │                                                  │
│ Instrument      │  Agent Name ——————————————— [Unsaved ●]         │
│ display         │  Score  [Prompt Content]                         │
│                 ├──────────────────────────────────────────────────┤
│ Identity        │                                                  │
│ fields          │  ╔══════════════════════════════════════════╗   │
│                 │  ║ │ (score/prompt textarea, JetBrains Mono) ║   │
│ Tuning          │  ║ │                                         ║   │
│ panel           │  ║ │ You are the [Name] agent.               ║   │
│                 │  ║ │                                         ║   │
│ Cues            │  ╚══════════════════════════════════════════╝   │
│ panel           │  chars  lines  words                            │
│                 ├──────────────────────────────────────────────────┤
│ Performance     │  [💾 Save Score]  [▶ Run Solo]  [🗑 Remove]    │
│ history         │                                                  │
└─────────────────┴──────────────────────────────────────────────────┘
```

CSS grid: `grid-template-columns: 1fr 3fr` (sidebar 1/4, score 3/4). `grid-template-rows: 1fr auto` (score fills height, footer is auto). Sidebar spans both rows.

### Score Editor

The textarea container uses `flex: 1; overflow: hidden` all the way up the chain:
- `.musician-shell` → `height: calc(100vh - var(--header-h))`
- `.musician-main` → `display: flex; flex-direction: column; overflow: hidden`
- `.musician-score-body` → `flex: 1; overflow: hidden; display: flex; flex-direction: column`
- `.score-editor` → `flex: 1; display: flex; flex-direction: column; padding: 20px 28px`
- `.score-paper` → `flex: 1; overflow: hidden; position: relative`
- `.score-textarea` → `width: 100%; height: 100%`

This chain ensures the textarea expands to fill all remaining vertical space with no scrollbars on the outer containers.

The left-margin line is a CSS `::before` pseudo-element at `left: 60px`, `background: rgba(201,168,76,0.08)` — gives a faint gold line like manuscript paper.

### ℹ Tooltips

Every form label in the sidebar has:
```html
<div class="orch-label">
    Score
    <span class="term-info" data-term="score">ℹ</span>
</div>
```

The global `Tooltip` system in `app.js` picks this up via `document.addEventListener('mouseover', ...)` and shows the dual-term tooltip.

### Data Fetch

The musician view does a fresh `GET /agents/api/agents/{id}` when loading, to get the full agent data including `prompt_content` (not always included in the list endpoint response).

### Save

`save()` collects the form, calls `PUT /agents/api/agents/{id}` with the full agent object, then calls `loadAll()` to refresh State.agents (so any name/category change propagates to other views).

---

## 8. Composition Studio (`composition.js`)

The Composition Studio is the most technically complex module — a canvas-based visual flow editor for building agent pipelines.

### Core Architecture

```
.comp-canvas-wrap (position: relative, overflow: hidden)
├── #comp-svg       (position: absolute, top/left 0, z-index: 1)
│     CSS transform: translate(panX, panY) scale(zoom)
│     pointer-events: none (globally)
│     Draws: connection bezier curves + in-progress dashed line
│
├── #comp-nodes     (position: absolute, top/left 0, z-index: 2)
│     CSS transform: translate(panX, panY) scale(zoom)
│     Contains: .flow-node divs with ports
│
└── #comp-right-panel  (position: absolute, right: 0, z-index: 20)
      CSS: transform: translateX(100%) by default, translateX(0) when .open
      Slides in from right edge of canvas
```

`#comp-context-menu` is `position: fixed` — it appears at the cursor in viewport coordinates, not canvas coordinates.

### The Shared-Transform Approach

**The fundamental design decision**: both the SVG overlay and the DOM nodes layer receive the **same CSS transform**. This means SVG path coordinates and node `x, y` coordinates are in the same space — a path from `(x1, y1)` to `(x2, y2)` in the SVG will visually connect the node elements at those same coordinates.

```javascript
function _applyTransform() {
    const t = `translate(${panX}px,${panY}px) scale(${zoom})`;
    $nodesLayer.style.transform = t;
    $nodesLayer.style.transformOrigin = '0 0';
    $svg.style.transform = t;
    $svg.style.transformOrigin = '0 0';  // preserved because we only set .transform
}
```

**Why not viewBox?** The original implementation used SVG `viewBox` manipulation to try to match the pan/zoom: `viewBox = "${-panX/zoom} ${-panY/zoom} ${w/zoom} ${h/zoom}"`. This math is incorrect because viewBox describes the SVG's internal coordinate system, not screen coordinates. The CSS transform approach is geometrically sound.

### Pixel-Perfect Port Positions (`_portPos`)

```javascript
function _portPos(nodeId, portType) {
    const dot = document.querySelector(`#fn-${nodeId} .fn-port-${portType} .fn-port-dot`);
    if (!dot || !$canvasWrap) return null;
    const dr = dot.getBoundingClientRect();
    const wr = $canvasWrap.getBoundingClientRect();
    return {
        x: (dr.left + dr.width/2  - wr.left - panX) / zoom,
        y: (dr.top  + dr.height/2 - wr.top  - panY) / zoom,
    };
}
```

This function queries the actual rendered port dot element in the DOM and converts its screen-centre to canvas-space coordinates. The formula:
- `dr.left + dr.width/2` = horizontal screen centre of the dot
- `- wr.left` = relative to the canvas wrapper's left edge
- `- panX` = subtract the current pan offset
- `/ zoom` = convert from screen pixels to canvas-space units

This is called each time connections are rendered, so as nodes are dragged, the connection lines automatically follow by re-querying the actual DOM positions.

**Why not hardcode offsets?** Node height varies with content. A hardcoded `NODE_H = 84` was never reliable — if an agent's description is long, the card taller, the port moves. `getBoundingClientRect` always returns the actual position.

### Node DOM Structure

```html
<div class="flow-node" id="fn-n1" style="left:200px;top:180px">
  <div class="fn-head">
    <div class="fn-emblem">[initials]</div>
    <div>
      <div class="fn-name">Agent Name</div>
      <div class="fn-cat">🎻 Strings</div>
    </div>
  </div>
  <div class="fn-desc">Short description...</div>

  <!-- In-port: left edge. 28×36px hit area, 10px visible dot -->
  <div class="fn-port fn-port-in" data-node="n1">
    <div class="fn-port-dot"></div>
  </div>

  <!-- Out-port: right edge. Same structure -->
  <div class="fn-port fn-port-out" data-node="n1">
    <div class="fn-port-dot"></div>
  </div>

  <button class="fn-del-btn">✕</button>
</div>
```

Port CSS: the `.fn-port` wrapper is `28×36px` transparent (large hit area). The `.fn-port-dot` is `10×10px` `pointer-events:none` (visual only). Port positions:
- Out port: `right: -14px; top: 50%; transform: translateY(-50%)`
- In port: `left: -14px; top: 50%; transform: translateY(-50%)`

The 28px width centered on the edge means the hit area extends 14px inside and 14px outside the node border.

### Connection Drawing Flow

1. **Start**: `mousedown` on `.fn-port-out` → `e.stopPropagation()` → `drawingConn = { fromNodeId, x1, y1 }` (using `_portPos`)
2. **Tracking**: `window.addEventListener('mousemove', _onMouseMove)` updates `mouseX, mouseY`. `_renderConnections()` draws a dashed temporary bezier from `(x1, y1)` to `_toCanvas(mouseX, mouseY)`
3. **Precision complete**: `mouseup` on `.fn-port-in` → `e.stopPropagation()` → `_addConnection(fromId, toId)` → `drawingConn = null`
4. **Proximity snap**: Global `window.addEventListener('mouseup', _onMouseUp)` fires after step 3 (bubbles from port → window). If `drawingConn` is still set (user released near but not precisely on a port), scans all in-ports via `_portPos` and connects to the nearest one within `52px`. If step 3 already ran, `drawingConn` is `null` and the scan is skipped.

**Why the two-layer approach?** Precision drop (step 3) gives exact connection when the user lands on the port. Proximity snap (step 4) catches near-misses where the cursor was slightly off the 28px hit area. Together they make connection drawing forgiving.

### SVG Connection Rendering

For each connection, two paths are created:

```javascript
// 1. Wide invisible hit-path (for right-click detection on connection)
const hitPath = svgEl('path', {
    d: `M ${p1.x} ${p1.y} C ${cpx} ${p1.y} ${cpx} ${p2.y} ${p2.y}`,  // wide
    fill: 'none', stroke: 'transparent', 'stroke-width': '14',
    style: 'pointer-events:stroke; cursor:context-menu',
});

// 2. Visible connection line
const visPath = svgEl('path', {
    d: `M ${p1.x} ${p1.y} C ${cpx} ${p1.y} ${cpx} ${p2.y} ${p2.x} ${p2.y}`,
    stroke: 'rgba(201,168,76,0.55)', 'stroke-width': '2',
    'marker-end': 'url(#arr)',   // arrowhead
});
```

The bezier control points: `cpx = (p1.x + p2.x) / 2`. Both control points share the same `cpx` but their respective port's y-coordinate — this creates an S-curve that exits horizontally from the out-port and enters horizontally at the in-port.

**Note on `pointer-events:stroke`**: The SVG element itself has `pointer-events:none`, but individual child elements can override this. `pointer-events:stroke` means the element receives events only when clicking on the stroke (not the fill). This allows right-clicking connection lines even though the SVG background doesn't receive events.

### Node Dragging

```javascript
el.addEventListener('mousedown', e => {
    if (e.target.closest('.fn-port') || e.target.closest('.fn-del-btn')) return;
    e.stopPropagation();  // prevents canvas pan from starting

    el.classList.add('dragging');
    const startX = e.clientX, startY = e.clientY;
    const origX = node.x, origY = node.y;

    const onMove = ev => {
        node.x = origX + (ev.clientX - startX) / zoom;
        node.y = origY + (ev.clientY - startY) / zoom;
        el.style.left = node.x + 'px';
        el.style.top  = node.y + 'px';
        _renderConnections();   // re-query port positions, redraw lines
    };
    const onUp = () => {
        el.classList.remove('dragging');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
});
```

Key points:
- `e.stopPropagation()` prevents the canvas `_onCanvasDown` from triggering panning simultaneously
- `/zoom` converts screen-pixel delta to canvas-space delta (correct at any zoom level)
- `_renderConnections()` re-queries `_portPos` every mouse move — this is what makes connections "stick" to the node as it moves. It's acceptable performance because `getBoundingClientRect` is fast and nodes rarely exceed ~20 at once

### Right-Click Context Menu

`_onContextMenu(e)` is registered on the canvas wrap:

1. **Check for node**: `e.target.closest('.flow-node')` — if found, show node menu (Remove / View Info / Edit Musician)
2. **Check for connection**: `_nearestConnection(e.clientX, e.clientY, 20)` — if found within 20px, show connection menu (Remove Connection)

**Connection hit detection** (`_nearestConnection`): Samples 16 points along each connection's cubic bezier curve, converts each to screen coordinates, measures distance from the right-click position. The bezier formula for point at parameter `t`:

```javascript
const bx = t2*t2*t2*p1.x + 3*t2*t2*t*cpx + 3*t2*t*t*cpx + t*t*t*p2.x;
const by = t2*t2*t2*p1.y + 3*t2*t2*t*p1.y + 3*t2*t*t*p2.y + t*t*t*p2.y;
// where t2 = 1-t
```

Screen coordinates are computed as: `screenX = wr.left + panX + canvasX * zoom`. This matches the CSS transform applied to the SVG.

### Right Panel (Agent Info)

`_showRightPanel(node)` populates `#crp-body` with agent details and adds `.open` to `#comp-right-panel`:

```css
.comp-right-panel {
    position: absolute;
    right: 0; top: 0; bottom: 0;
    width: 272px;
    transform: translateX(100%);     /* off-screen by default */
    transition: transform 0.22s ...;
}
.comp-right-panel.open {
    transform: translateX(0);        /* slides in */
}
```

The panel lives inside `.comp-canvas-wrap` so it's clipped to the canvas area. It overlays the right edge of the canvas — nodes behind it are still there, just visually hidden. The close button and clicking the canvas background call `hideRightPanel()` which removes `.open`.

### Squad Preload (`preloadSquad`)

Called when navigating from the Orchestra view via "View Flow":

```javascript
function preloadSquad(squadId) {
    const squad = State.squads.find(s => s.id === squadId);
    const rawAgents = squad.agents || [];

    // Normalise: squad.agents may be full objects OR ID strings
    const agentList = rawAgents.map(a => {
        const id = typeof a === 'object' ? a.id : a;
        return State.agents.find(ag => ag.id === id) || { id, name: id, category: 'meta' };
    });

    // Sort by run_order: first → parallel → last
    const orderRank = { first: 0, parallel: 1, last: 2 };
    agentList.sort((a, b) => (orderRank[a.run_order] ?? 1) - (orderRank[b.run_order] ?? 1));

    // Place nodes horizontally with 220px spacing
    agentList.forEach((agent, i) => {
        nodes.push({ id: 'n' + (nextId++), agentId: agent.id, x: 80 + i*220, y: 180, agent });
    });

    // Connect sequentially
    for (let i = 0; i < nodes.length - 1; i++) {
        connections.push({ from: nodes[i].id, to: nodes[i+1].id });
    }
}
```

---

## 9. Supporting Panels

### Concert Hall (`concert-hall.js`)

Lists active runs (from `State.activeRuns`, polled live) and run history (`GET /agents/api/runs?limit=50`). Clicking a completed run fetches the report from `/agents/api/reports/latest/{runId}` and displays it in a modal. Supports cancelling active runs.

### Calendar (`calendar.js`)

Admin-only. CRUD for cron schedules via `/agents/api/schedules`. Provides preset cron buttons (nightly, weekday morning, hourly, every 6 hours). Only visible to admins (`currentUser.isAdmin`).

### Symphony (`symphony.js`)

Builds multi-squad workflows — sequential pipelines where completing one squad triggers the next. Each "movement" (step) has an `on_failure` option: stop, skip, or continue. Saved via `POST /agents/api/workflows`.

---

## 10. Design System

### CSS Architecture

The stylesheet (`style.css`) is ~1,400 lines organised in sections:
1. Custom properties (CSS variables) — colours, fonts, radii, sizes
2. Reset and base styles
3. Layout (header, breadcrumb, views, panels)
4. Orchestra pit (SVG elements, tooltip, legend, controls)
5. Section view (phase lanes, musician cards, pool)
6. Musician view (sidebar, instrument display, tuning panel, score editor)
7. Composition Studio (canvas, nodes, ports, right panel, context menu)
8. Shared components (buttons, inputs, modals, toasts, badges)
9. Responsive (single-column breakpoint)

### Key CSS Variables

```css
--bg: #0d0b08          /* Warm almost-black background */
--surface: #12100c     /* Cards, sidebars */
--surface-2: #1a1712   /* Elevated elements */
--surface-3: #231f18   /* Even more elevated */
--border: rgba(201,168,76,0.08)   /* Subtle gold border */
--border-2: rgba(201,168,76,0.16) /* More visible border */
--gold: #c9a84c        /* Primary accent */
--gold-dim: #8b6914    /* Secondary gold */
--text: #e8dcc8        /* Warm white text */
--text-2: #c8b99a      /* Secondary text */
--text-muted: #8c7c6a  /* Muted text */
--text-faint: #5a4f40  /* Very faint text */
--font-serif: 'Playfair Display'  /* Headings, labels */
--font-sans:  'Inter'             /* Body, UI */
--font-mono:  'JetBrains Mono'    /* Score/prompt editor */
```

The warm dark palette evokes a concert hall at night — dark wood, velvet seats, soft gold lighting.

### Score Editor Aesthetic

The prompt textarea is inside `.score-paper`:
- Background: `#0f0d09` (slightly lighter warm black)
- Left-margin line: `::before` pseudo-element at `left: 60px`, `rgba(201,168,76,0.08)` — faint gold vertical line mimicking music manuscript paper
- Text padding: `20px 20px 20px 72px` — content starts after the margin line
- Font: JetBrains Mono 13px, line-height 1.7 — code-like but comfortable for long prose

---

## 11. How to Extend

### Adding a New View

1. Add `<section class="orch-view hidden" id="view-newview">` to `index.html`
2. Add a new JS file `js/newview.js` with an IIFE: `const NewView = (() => { function render() {...} return {render}; })()`
3. Add `<script src="/orchestra/static/js/newview.js?v=N">` to `index.html`
4. Add a case to the `navigateTo` switch in `app.js`
5. Add a panel button if it should appear in the header nav

### Adding a New Terminology Entry

Add to `TERM_MAP` in `app.js`:
```javascript
'your-key': { tech: 'Technical Name', desc: 'Plain-English explanation.' },
```
Then use `data-term="your-key"` on any element — the tooltip fires automatically.

### Adding a New Section Type

Add to `SECTION_DEFS` in `app.js` and `SECTION_ROWS` (or `TOP_LEFT_ZONES`/`TOP_RIGHT_ZONES`) in `orchestra.js`. The rest of the system picks it up automatically.

### Changing Port Dimensions

If you change the port CSS (`.fn-port-out`, `.fn-port-in`), no JS changes are needed — `_portPos` always reads the actual DOM position. Just update the CSS.

---

## 12. Deployment

### Service

```bash
# Install
cp config/service-templates/opai-orchestra.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable opai-orchestra
systemctl --user start opai-orchestra

# Control
systemctl --user restart opai-orchestra
journalctl --user -u opai-orchestra -f

# Status check
curl -s http://127.0.0.1:8098/orchestra/api/auth/config
```

### Cache Busting

All static files use `?v=N` query strings in `index.html`. Increment `N` after any JS/CSS change and restart the service. The service restart is needed because FastAPI serves files from disk — no build step, changes are immediate after restart.

```bash
sed -i 's/?v=5/?v=6/g' tools/opai-orchestra/static/index.html
systemctl --user restart opai-orchestra
```

### The `.env` Symlink

```bash
# One-time setup:
ln -sf ../opai-agents/.env tools/opai-orchestra/.env
```

Both tools share the same Supabase project and keys. If the agents `.env` changes, Orchestra picks it up automatically on next restart.

---

## 13. Known Gotchas

| Gotcha | Explanation |
|--------|-------------|
| `squad.agents` is objects, not strings | The `/squads` API returns full agent objects in the `agents` array. Always normalise: `.map(a => typeof a === 'object' ? a.id : a)` before comparing to agent IDs |
| SVG `pointer-events:none` vs path `pointer-events:stroke` | Parent `pointer-events:none` prevents child overrides in some browsers when set as CSS class. Set it inline on the SVG element via `style` attribute. Individual path elements with `pointer-events:stroke` in their `style` attribute do work |
| Node height is variable | Never hardcode `NODE_H`. Use `_portPos()` which reads actual DOM positions. If the node content changes height (longer description, different text), ports automatically follow |
| Tooltip global listeners | The `Tooltip` system adds listeners to `document` — they fire for all `[data-term]` elements anywhere in the page, including modals. This is intentional and works correctly |
| `navigateTo('composition', params)` | Must pass the full `params` object, not just `squadId`. The `app.js` switch case passes `params` directly to `CompositionStudio.render(params)` |
| Programme highlight reset | When switching between programme highlight and legend filter, always reset the other. `filterBySection` calls `OrchestraPit.highlightProgramme('')` first. `_highlightProgramme` resets inline styles to `''` (empty string) not `none` — this allows CSS to take back control |
| Panning check in `_onCanvasDown` | Must check `e.target === $canvasWrap || e.target === $svg` — if clicking on a node body or port, `e.stopPropagation()` on the node prevents `_onCanvasDown` from even firing. If the check is missing, panning starts when clicking on the SVG connection lines |
| Context menu `position:fixed` | The context menu is `position:fixed` (not absolute) so it appears at the exact screen cursor position regardless of canvas scroll/pan. Do not make it `position:absolute` relative to the canvas wrap — it would be clipped and offset incorrectly |

---

## 14. Design Decisions Log

These are the key decisions made and why, so future changes don't accidentally revert them.

**Row-band instead of circular arcs**: Circular arcs cause geometric overlap at the sides of adjacent bands. Row-bands with explicit y-ranges guarantee zero overlap regardless of agent count.

**Separate tool, not integrated into Studio**: Keeping Orchestra as a standalone FastAPI app means it can be deployed, restarted, or taken down independently. The agent backend (`opai-agents`) is unaffected by Orchestra's availability.

**All data via `/agents/api/*`**: No duplicated state, no sync problem. Orchestra writes to the same data store as Studio. A squad created in Orchestra appears in Studio instantly.

**`getBoundingClientRect` for port positions**: The alternative (hardcoded offsets from node x/y) breaks when node height varies. DOM measurement is always correct and requires no maintenance.

**Shared CSS transform (not viewBox)**: ViewBox changes the SVG's internal coordinate system — this does not match the CSS transform applied to the nodes layer. Applying the identical CSS transform to both the SVG and nodes layer keeps coordinate systems aligned with no math.

**Right panel instead of modal for agent info**: A modal would block the canvas. A slide-in panel lets the user see the agent in context on the canvas while reading its details. The canvas remains interactive behind the panel.

**Proximity snap at 52px**: Too small (< 20px) and users can't reliably release on the port. Too large (> 80px) and connecting the wrong node becomes likely. 52px is approximately the width of a node emblem — close enough to feel precise, generous enough to be forgiving.

**Programme dimming to 8% (not 0%)**: At 0%, dimmed agents completely vanish, which is disorienting — the orchestra pit looks broken. At 8% with greyscale, users can see the shape of the ensemble but the highlighted members are clearly the focus.

---

*Document ends. All code referenced is in `tools/opai-orchestra/`. Last significant change: 2026-02-21.*
