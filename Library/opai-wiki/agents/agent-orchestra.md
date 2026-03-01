# Agent Orchestra
> Last updated: 2026-02-21 | Source: `tools/opai-orchestra/` | Port: 8098 | Route: `/orchestra/`

## Overview

Agent Orchestra is a **visual concert hall interface** for the OPAI agent system — a full reimagination of Agent Studio through the musical metaphor that defines OPAI's brand. Instead of managing agents as configuration items, users experience them as **musicians** seated in an orchestra pit, organised into sections, performing programmes.

It is a **standalone tool** that reads all data from the Agent Studio backend (`/agents/api/*`) — no duplicated backend. Orchestra is a visual layer on top of Agent Studio, not a replacement. Both coexist.

---

## Architecture

```
tools/opai-orchestra/
  ├── app.py                     FastAPI backend (port 8098) — serves static files + /api/auth/config
  ├── config.py                  Port 8098, static dir, Supabase env
  ├── requirements.txt
  ├── .env -> ../opai-agents/.env  Symlinked — shares same Supabase keys
  └── static/
        ├── index.html           SPA shell (7 views, 3 modals)
        ├── style.css            Concert hall design system (~1,300 lines)
        └── js/
              ├── app.js         Auth, state, navigation, TERM_MAP, tooltip wiring
              ├── orchestra.js   Orchestra Pit SVG — Level 1 view
              ├── section.js     Section/Squad view — Level 2
              ├── musician.js    Musician editor — Level 3
              ├── concert-hall.js  Run history + report viewer
              ├── calendar.js    Schedule manager
              ├── symphony.js    Multi-squad workflow builder
              └── composition.js Composition Studio — visual flow editor
```

**Data source**: All agent/squad/run/schedule/workflow data comes from `GET/POST /agents/api/*` — the opai-agents backend at port 8088. Orchestra adds zero backend duplication.

**Auth**: Supabase JWT via shared `.env`. Same session cookies as all other OPAI tools.

---

## Terminology Map (TERM_MAP)

Orchestra replaces technical terms with musical equivalents throughout the UI. Every renamed field has an `ℹ` tooltip showing both terms.

| Orchestra Term | Technical Term | Description |
|---------------|----------------|-------------|
| Musician | Agent | An autonomous AI worker with a specific role |
| Programme | Squad | A named group of agents that run together |
| Section | Category | The instrument family / agent category |
| Score | Prompt Content | The instructions written for the agent |
| Instrument Grade | Model | Which Claude model this agent uses |
| Max Bars | Max Turns | Maximum conversation turns per run |
| Solo Mode | Skip Project Context | Run without the shared project context |
| When They Play | Run Order | first / parallel (default) / last |
| Cued By | Depends On | Agents that must complete before this one starts |
| Programme Note | Description | Short description of the agent |
| Musician Initials | Emoji/Badge | 2-char display badge |
| Intro | First (run order) | Runs before main movement |
| Main Movement | Parallel (run order) | Runs concurrently — default |
| Coda | Last (run order) | Runs after main movement |
| Composition Studio | Agent Flow Editor | Visual node canvas for pipelines |
| Concert Hall | Run History | Log of past performances |
| Symphony | Workflow | Multi-squad sequential pipeline |

---

## Three-Level Navigation

### Level 1 — Full Orchestra (Orchestra Pit SVG)

The homepage. An SVG visualization of all agents as seated musicians in a concert hall pit.

**Layout system**: Row-band geometry (not concentric arcs — arcs cause side overlap). Each category occupies a guaranteed non-overlapping horizontal band:

| Section | Y-Centre | Band Height | X-Range | Instrument |
|---------|----------|-------------|---------|------------|
| leadership | 450px | 28px | 392–508 | 🎻 |
| quality | 385px | 38px | 218–682 | 🎺 |
| planning | 319px | 38px | 162–738 | 🥁 |
| research | 252px | 38px | 112–788 | 🎷 |
| security | 184px | 38px | 66–834 | 🎸 |
| operations | 116px | 36px | 24–876 | 🪗 |
| meta / content / orchestration / execution | 50px (top row) | 28px | split left/right | 🪘 / 🎹 / 🎵 / 🎶 |

Agents sit along a **parabolic arc** within their band: `y = yCtr - parabH × 4t(1−t)`. Band backgrounds are quadratic bezier curve paths.

**Programme dimming**: Selecting a programme from the dropdown dims all agents NOT in that programme to 8% opacity + greyscale, with `pointer-events:none`. Programme members stay fully interactive. Deselecting restores all seats.

**Legend filter**: Clicking a section in the legend dims agents outside that category. Clears programme selection.

**View Flow button**: When a programme is selected, the `🖊️ View Flow` button opens Composition Studio pre-loaded with that programme's agents connected in sequence.

**Hover tooltips**: Hovering a musician seat shows name, section, description, run order, and model in a floating tooltip.

### Level 2 — Section View (Squad/Programme)

Click a musician seat → section view for their programme. Shows:
- Programme header with musician count
- **Phase lanes**: Intro (first) | Main Movement (parallel, default) | Coda (last)
- Musician cards per lane with remove button
- Agent pool sidebar with search for adding musicians
- Actions: Rehearse (execution order preview), Perform Now, Edit, Delete

### Level 3 — Musician View (Agent Editor)

Click a musician card in section view → full agent editor. Two-column layout:
- **Sidebar (1/4 width)**: instrument display, identity fields (name, initials, programme note, section), tuning panel (model/max bars/run order/solo mode), cues panel (depends_on), performance history
- **Score area (3/4 width)**: styled prompt editor with left-margin line (music paper aesthetic), live char/word/line count, Ctrl+S to save
- **Tooltips**: every renamed field has an `ℹ` icon that shows a floating dual-term panel

---

## Composition Studio (Visual Flow Editor)

Located at the "Composition" panel tab. A canvas-based node editor for building agent pipelines visually.

### Architecture

```
.comp-canvas-wrap
  ├── #comp-svg        (SVG overlay — same CSS transform as nodes, z-index:1)
  ├── #comp-nodes      (absolute DOM nodes — CSS transform, z-index:2)
  └── #comp-right-panel  (slides in from right, 272px, z-index:20)
#comp-context-menu     (position:fixed, appears at right-click position)
```

### Key Design Decisions

**Port positions via `getBoundingClientRect`**: Connection lines use `_portPos(nodeId, type)` which calls `getBoundingClientRect()` on the actual rendered port dot element. Coordinates are converted to canvas-space: `(screenX - wrapLeft - panX) / zoom`. This gives pixel-perfect alignment regardless of node content height, zoom, or pan.

**Shared CSS transform**: Both the SVG overlay and the nodes layer receive the same `translate(panX,panY) scale(zoom)` CSS transform. SVG path coordinates = node x/y coordinates directly — no viewBox math.

**SVG pointer-events**: SVG has `pointer-events:none` globally so it never blocks node interaction. Hit paths for connections use `pointer-events:stroke` on individual path elements (overrides the parent `none`).

**Node dragging**: Each node has its own scoped `onMove`/`onUp` pair added to `window`, isolated from connection-drawing state. Nodes are freely draggable while connections re-draw live via `_renderConnections()`.

**Connection drawing**: Mousedown on out-port → `drawingConn = {fromNodeId, x1, y1}` (using `_portPos`). Dashed bezier drawn during drag via `_onMouseMove`. On mouseup: in-port precision drop OR 52px proximity snap checks all in-ports via `Math.hypot`. Duplicate connections are silently ignored.

### Features

| Feature | How |
|---------|-----|
| Add node | Drag from palette or click palette item |
| Move node | Drag node body; connections track live |
| Connect nodes | Drag from right port dot → release near left port dot |
| Delete node | ✕ button (hover) or right-click → Remove Node |
| Delete connection | Right-click near line (within 20px, bezier-sampled) → Remove Connection |
| Agent info | Click node → right panel slides in (model, run order, max bars, solo mode, cued-by) |
| Navigate to edit | Right panel "Edit Musician" button or right-click → Edit Musician |
| Dismiss panel | Click canvas background or ✕ in panel |
| Pan | Drag canvas background |
| Zoom | Scroll wheel (0.25×–4×) |
| Reset view | ⌖ Reset button |
| AI build | Describe pipeline in text → AI places nodes + connects them |
| Save as Symphony | Saves node layout as a workflow (agents ordered by x position) |
| Preload from Orchestra | "View Flow" button with programme selected |

### Preload from Orchestra

When navigating from the Orchestra pit via `🖊️ View Flow`:
1. `navigateTo('composition', { squadId })` is called
2. `app.js` passes `params` to `CompositionStudio.render(params)`
3. `preloadSquad(squadId)` normalises `squad.agents` (may be objects or ID strings), sorts by run_order (first→parallel→last), places nodes in a horizontal line with 220px spacing, connects them sequentially

### Right-Click Context Menu

**On a node**:
- 🗑 Remove Node
- ℹ View Info (opens right panel)
- ✏ Edit Musician (navigates to musician view)

**Near a connection line** (within 20px — detected by sampling 16 bezier points):
- 🗑 Remove Connection

---

## Design System

**Fonts**: Playfair Display (serif — headings, labels), Inter (body), JetBrains Mono (code/score editor)

**Colour palette**:
```css
--bg: #0d0b08         /* dark warm black */
--gold: #c9a84c       /* primary accent */
--gold-dim: #8b6914   /* secondary gold */
```

Each section has a dedicated colour (used for musician seats, band backgrounds, section badges):
- leadership: `#ef4444` (red)
- quality: `#f59e0b` (amber)
- planning: `#3b82f6` (blue)
- research: `#8b5cf6` (purple)
- security: `#10b981` (emerald)
- operations: `#06b6d4` (cyan)
- meta: `#6b7280`, content: `#ec4899`, orchestration: `#f97316`, execution: `#84cc16`

**Score editor**: Dark paper (`#0f0d09`), left margin line at 60px (`rgba(201,168,76,0.08)`), JetBrains Mono 13px, line-height 1.7. Simulates music manuscript paper.

---

## Service

```ini
# ~/.config/systemd/user/opai-orchestra.service
[Unit]
Description=OPAI Orchestra — Musical visualization of the AI agent ensemble
After=network.target opai-agents.service

[Service]
Type=simple
WorkingDirectory=/workspace/synced/opai/tools/opai-orchestra
ExecStart=/usr/bin/python3 -m uvicorn app:app --host 127.0.0.1 --port 8098
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=-/workspace/synced/opai/tools/opai-orchestra/.env
```

```bash
# Control
systemctl --user start opai-orchestra
systemctl --user restart opai-orchestra
systemctl --user status opai-orchestra
journalctl --user -u opai-orchestra -f
```

---

## Caddy Route

```caddy
handle_path /orchestra/* {
    reverse_proxy localhost:8098
}
@orchestraExact path /orchestra
redir @orchestraExact /orchestra/ 301
```

Route is in the `@html` no-cache list so auth changes take effect immediately.

---

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-orchestra/app.py` | FastAPI backend — static serving + `/api/auth/config` |
| `tools/opai-orchestra/static/index.html` | SPA shell — all views, modals, panels |
| `tools/opai-orchestra/static/style.css` | Full concert hall design system |
| `tools/opai-orchestra/static/js/app.js` | Auth, state, TERM_MAP, SECTION_DEFS, navigation, tooltips |
| `tools/opai-orchestra/static/js/orchestra.js` | SVG pit, row-band layout, programme dimming, legend |
| `tools/opai-orchestra/static/js/section.js` | Phase-lane squad view |
| `tools/opai-orchestra/static/js/musician.js` | Full agent editor with dual-term tooltips |
| `tools/opai-orchestra/static/js/composition.js` | Visual flow editor — nodes, connections, right panel, context menu |
| `tools/opai-orchestra/static/js/concert-hall.js` | Run history + report viewer |
| `tools/opai-orchestra/static/js/calendar.js` | Cron schedule CRUD |
| `tools/opai-orchestra/static/js/symphony.js` | Multi-squad workflow builder |
| `~/.config/systemd/user/opai-orchestra.service` | systemd unit |
| `config/Caddyfile` | `/orchestra/*` route |

---

## Relationship to Agent Studio

| Aspect | Agent Studio (`/agents/`) | Agent Orchestra (`/orchestra/`) |
|--------|--------------------------|--------------------------------|
| Backend | `tools/opai-agents/` (port 8088) | Same — proxied via `/agents/api/*` |
| Data | Authoritative source | Read/write via Studio API |
| Terminology | Technical (agent, squad, prompt) | Musical (musician, programme, score) |
| Primary view | List/card UI | SVG concert hall pit |
| Audience | Power users, devs | All users, onboarding, demos |
| Flow editor | Agent Flow tab | Composition Studio (improved) |
| Squad view | Agent list within squad | Phase-lane section view |

Both are accessible simultaneously. Orchestra is the **user-facing showcase**; Studio is the **admin workhorse**.

---

## Dependencies

- **Requires**: `opai-agents.service` (data source), `opai-caddy.service` (routing)
- **Auth via**: Supabase (same session as all tools)
- **Portal tile**: `tools/opai-portal/static/index.html` — "Agent Orchestra" card (icon 🎼, css `card-agents`, svcKey `orchestra`)
- **Monitored by**: Orchestrator health checks
