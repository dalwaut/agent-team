# Shared Navigation Bar
> Last updated: 2026-02-22 | Source: `tools/opai-portal/static/js/navbar.js`

## Overview

A self-injecting navigation bar shared across all OPAI tool pages. Provides a back-to-portal button, quick-access icons for the 4 most recently visited tools, and a feedback button for in-app user feedback. Each tool page includes a single `<script>` tag — the navbar handles its own CSS injection, DOM creation, recent-tools tracking, role-aware permission filtering, and feedback modal.

## Architecture

```
tools/opai-portal/static/js/navbar.js
    ↓ served via Caddy + FastAPI as
/auth/static/js/navbar.js
    ↓ loaded by each tool page via
<script src="/auth/static/js/navbar.js" defer></script>
    ↓ on DOMContentLoaded
Injects <style> → Builds <nav> → Prepends to <body>
    ↓ async
Checks permissions → Filters tool icons for non-admins
```

No Caddy or backend config changes required — the file is served by the existing Portal static mount at `/auth/static/`.

## Visual Layout

```
┌──────────────────────────────────────────────────────────────┐
│ [←]  │  [CH] [FL] [MN] [TK]              [💬]               │
│ back    divider   recent tools       feedback btn  44px tall │
└──────────────────────────────────────────────────────────────┘
```

- **44px tall**, sticky top, z-index 99999
- Glassmorphic dark background (`rgba(10,10,15,0.92)` + `backdrop-filter: blur(12px)`)
- Tool icons: 28px colored circles with 2-letter abbreviations
- Active tool: glow ring around its icon
- Hover: scale + brighten

## Tool Registry

| Key | Abbr | Color | Path |
|-----|------|-------|------|
| `chat` | CH | `#a855f7` (purple) | `/chat/` |
| `monitor` | MN | `#3b82f6` (blue) | `/monitor/` |
| `tasks` | TK | `#f59e0b` (amber) | `/tasks/` |
| `terminal` | TM | `#f59e0b` (amber) | `/terminal/` |
| `claude` | CL | `#6366f1` (indigo) | `/terminal/claude` |
| `messenger` | MS | `#10b981` (green) | `/messenger/` |
| `users` | US | `#ec4899` (pink) | `/users/` |
| `dev` | DV | `#06b6d4` (cyan) | `/dev/` |
| `files` | FL | `#8b5cf6` (violet) | `/files/` |
| `forum` | FM | `#f97316` (orange) | `/forum/` |
| `docs` | DC | `#22d3ee` (teal) | `/docs/` |
| `agents` | AS | `#f43f5e` (rose) | `/agents/` |
| `team-hub` | TH | `#6c5ce7` (purple) | `/team-hub/` |
| `billing` | BL | `#22c55e` (green) | `/billing/` |
| `wordpress` | WP | `#0073aa` (blue) | `/wordpress/` |
| `bot-space` | BS | `#f59e0b` (amber) | `/bot-space/` |
| `orchestra` | OR | `#d4a017` (gold) | `/orchestra/` |
| `prd` | PR | `#14b8a6` (teal) | `/prd/` |
| `forumbot` | FB | `#8b5cf6` (violet) | `/forumbot/` |
| `email-agent` | EA | `#0984e3` (blue) | `/email-agent/` |
| `brain` | BR | `#8b5cf6` (violet) | `/brain/` |
| `bx4` | B4 | `#10b981` (green) | `/bx4/` |

## Recent Tools Tracking

- **localStorage key**: `opai_recent_tools` — JSON array of tool keys, max 4
- On load: detects current tool from `window.location.pathname`, moves it to front, caps at 4, saves
- Icons render in MRU order (most recent first)

## Role-Aware Permissions

- Attempts to read session from `window.opaiAuth.getSession()` (provided by `auth-v3.js`)
- **Admin**: all tools visible (no filtering)
- **Non-admin**: fetches `GET /api/me/apps` → filters recent list to `allowed_apps` only
- Cached in `sessionStorage` key `opai_allowed_apps` with 5-minute TTL
- On error or no session: shows all tools (fail open for rendering, auth enforcement still happens per-app)

## Feedback Button & Modal

A message-bubble icon button sits right-aligned in the navbar (pushed via `flex: 1` spacer). Clicking it opens a dark-themed modal overlay:

1. **Auto-detects tool name** from `detectCurrentTool()` + `window.location.pathname`
2. **Pre-populates** the tool label and page path in the modal header
3. **Textarea prompt**: "I wish this app/page..."
4. **User identity** (optional): attempts to read `window.opaiAuth.getSession()` for user ID and email
5. **Submits** `POST /api/feedback` to the Portal backend
6. **Flash confirmation**: "Thanks for your feedback!" green pill (2.5s auto-dismiss)
7. **Error handling**: Shows error text in submit button, re-enables on failure

The feedback endpoint and processing pipeline are documented in [Feedback System](feedback-system.md).

## Full-Height Layout Handling

Full-height SPA tools need the body to be a flex column so `flex: 1` on their root container works. The navbar detects these tools via `FULL_HEIGHT_TOOLS` and injects:

```css
html, body { height: 100vh; margin: 0; overflow: hidden; }
body { display: flex !important; flex-direction: column !important; }
.opai-navbar { flex-shrink: 0; }
```

**Current `FULL_HEIGHT_TOOLS`**: `terminal`, `claude`, `chat`, `bx4`, `brain`, `bot-space`, `orchestra`

This ensures the app root container fills `calc(100vh - 44px)` (full viewport minus navbar). Without it, `flex: 1` has no effect (parent not flex) and `overflow-y: auto` on inner scroll containers never triggers.

**Rule of thumb**: Any tool that uses a `flex: 1; overflow: hidden` root layout and needs internal scrolling must be in `FULL_HEIGHT_TOOLS`. Tools that are just document-style pages (scroll on `<body>`) do not need it.

**Gotcha**: If a tool page has no scrolling even after adding `overflow-y: auto` to inner containers, the first thing to check is whether the tool is in `FULL_HEIGHT_TOOLS`. Add it, restart `opai-portal`, and hard-reload the browser (Ctrl+Shift+R) to clear the cached navbar.js.

## Body Padding Handling

Pages with body padding (e.g., Dev IDE's `padding: 1.5rem`) are detected at init. The navbar applies negative margins and width compensation to stretch edge-to-edge despite the padding.

## Full-Viewport Overlay Pattern

Pages with full-viewport overlays (e.g., OPAI Files knowledge graph) should position below the navbar using `top: 44px` instead of `inset: 0`. This keeps the navbar visible and avoids hide/show toggling. The overlay's z-index should be >= 100000 (above the navbar's 99999).

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-portal/static/js/navbar.js` | Self-contained navbar module (~416 lines) |

## Pages Using the Navbar

| Page | File |
|------|------|
| Chat | `tools/opai-chat/static/index.html` |
| Monitor | `tools/opai-monitor/static/index.html` |
| Tasks | `tools/opai-tasks/static/index.html` |
| Terminal | `tools/opai-terminal/static/index.html` |
| Claude Code | `tools/opai-terminal/static/claude.html` |
| Users | `tools/opai-users/static/index.html` |
| Files | `tools/opai-files/static/index.html` |
| Messenger | `tools/opai-messenger/static/index.html` |
| Forum | `tools/opai-forum/static/index.html` |
| Dev IDE | `tools/opai-dev/index.js` (inline HTML template) |

| Forum Bot | `tools/opai-forumbot/static/index.html` |
| Docs | `tools/opai-docs/static/index.html` |
| Agents | `tools/opai-agents/static/index.html` |
| Team Hub | `tools/opai-team-hub/static/index.html` |
| Billing | `tools/opai-billing/static/index.html` |
| Marketplace | `tools/opai-marketplace/static/index.html` |
| WordPress | `tools/opai-wordpress/static/index.html` |
| PRD | `tools/opai-prd/static/index.html` |
| Bot Space | `tools/opai-bot-space/static/index.html` |
| Email Agent | `tools/opai-email-agent/static/index.html` |
| Orchestra | `tools/opai-orchestra/static/index.html` |

**Not included**: Portal dashboard (`tools/opai-portal/static/index.html`) — it's the hub, no navbar needed.

## Sticky Header Convention

Tools with their own sticky app header must set `top: 44px` (not `top: 0`) so the header sticks correctly below the 44px navbar. Using `top: 0` causes the tool header to slide under the navbar on scroll.

```css
/* Correct — header sticks below the navbar */
.app-header {
    position: sticky;
    top: 44px;
    z-index: 100;
}
```

Tools currently following this convention: `opai-bot-space` (`.app-header`), `opai-email-agent` (`.header`), `opai-orchestra` (`.orch-header`).

**Alternative (preferred for FULL_HEIGHT_TOOLS)**: Instead of `position: sticky/fixed`, render the tool's top-bar as an in-flow flex child (`flex-shrink: 0`) inside the root flex column. This way the top-bar never overlaps the navbar — it simply comes after it in the layout. Bx4 uses this pattern (`.top-bar { flex-shrink: 0 }` inside `.app { display: flex; flex-direction: column }`).

## Adding the Navbar to a New Tool

1. Add one line to the `<head>` of the tool's HTML:

```html
<script src="/auth/static/js/navbar.js" defer></script>
```

2. Register the tool in the `TOOLS` object inside `navbar.js` with its key, abbreviation, color, label, and path.

3. If the tool has its own sticky app header, change `top: 0` to `top: 44px` in that header's CSS rule.

## Dependencies

- **Served by**: [Portal](portal.md) static file mount
- **Auth integration**: `window.opaiAuth` from `auth-v3.js` (see [Auth & Network](auth-network.md))
- **Permissions endpoint**: `GET /api/me/apps` on [Portal](portal.md)
- **Feedback pipeline**: [Feedback System](feedback-system.md) (`POST /api/feedback` → processor → per-tool files)
- **No external dependencies**: vanilla JS, self-contained CSS
