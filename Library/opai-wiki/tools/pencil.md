# Pencil.dev — Agent-Driven Visual Design

> **Status**: Phase 1 Live | **Type**: Desktop app + MCP | **Port**: N/A (desktop app, MCP auto-detected)

## Overview

Pencil.dev is an agent-driven design tool (Figma-like) that turns text prompts into editable visual designs via MCP. It fills the gap between ASCII `blueprint` wireframes and coded UIs — giving agents a visual design step before implementation.

**Key value**: Agents can now design UIs visually, iterate on them with screenshots, and hand off polished designs to code generation — all without leaving the Claude Code workflow.

## Architecture

```
┌──────────────────────────────────────────────────┐
│ Pencil.dev Desktop App (AppImage)                │
│  ┌────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ Design     │  │ UI Kits      │  │ .pen     │ │
│  │ Canvas     │  │ (Shadcn,     │  │ Export   │ │
│  │            │  │  Lunaris,    │  │ (JSON)   │ │
│  │            │  │  Halo, Nitro)│  │          │ │
│  └────────────┘  └──────────────┘  └──────────┘ │
│         │                                        │
│  ┌──────┴──────────────────────────────────────┐ │
│  │ MCP Server (auto-starts with app)           │ │
│  │ 7 tools: batch_design, batch_get,           │ │
│  │ get_screenshot, snapshot_layout,            │ │
│  │ get_editor_state, get_variables,            │ │
│  │ set_variables                               │ │
│  └─────────────────────┬───────────────────────┘ │
└────────────────────────┼─────────────────────────┘
                         │ auto-detected
                         ▼
              ┌──────────────────────┐
              │ Claude Code          │
              │ (MCP client)         │
              │ /pencil skill        │
              └──────────────────────┘
```

## MCP Tools Reference

| Tool | Description | Use Case |
|------|-------------|----------|
| `batch_design` | Create or update designs from text prompt | Primary design tool — describe what you want |
| `batch_get` | Retrieve design data from canvas | Read back current design state |
| `get_screenshot` | Capture screenshot of current design | Verify output, share with user |
| `snapshot_layout` | Get structural layout snapshot | Understand component hierarchy |
| `get_editor_state` | Get editor state (selection, zoom) | Context for targeted edits |
| `get_variables` | Read design variables (colors, spacing) | Inspect current design tokens |
| `set_variables` | Update design variables | Batch-update colors, spacing, tokens |

## Key Files

| File | Purpose |
|------|---------|
| `/opt/pencil/Pencil.AppImage` | Desktop application binary |
| `scripts/pencil.sh` | Launcher script |
| `config/mcp-all.json` → `pencil` | MCP catalog entry |
| `~/.agents/skills/pencil/SKILL.md` | Claude Code skill definition |

## UI Kits

Pencil ships with 4 built-in component kits:

| Kit | Style | Best For |
|-----|-------|----------|
| **Shadcn** | Clean, modern | Dashboards, SaaS, admin panels |
| **Lunaris** | Dark, sleek | Developer tools, monitoring |
| **Halo** | Soft, rounded | Consumer apps, landing pages |
| **Nitro** | Bold, high-contrast | Marketing, portfolios |

Specify the kit in your `batch_design` prompt for consistent styling across components.

## Usage

### Skill-Triggered (Recommended)

Say "pencil design a login form" or "design a dashboard with pencil" in Claude Code. The `/pencil` skill handles:
1. Checking if Pencil is running
2. Guiding design prompt creation
3. Executing `batch_design`
4. Capturing screenshots for review
5. Iterating on feedback

### Manual Launch

```bash
./scripts/pencil.sh
```

### Direct MCP

When Pencil is running, MCP tools are auto-available in Claude Code. Use them directly:
- `batch_design` with a detailed prompt
- `get_screenshot` to verify
- `batch_design` again to refine

### CLI (Experimental)

Requires: `File → Install pencil command into PATH` in the Pencil app.

```bash
pencil --agent-config config.json
```

## Workflow

```
Prompt → batch_design → get_screenshot → Review → Iterate → Export .pen
```

**Full design pipeline**:
1. **Blueprint** (`/blueprint` skill) — ASCII wireframe for layout
2. **Pencil** (`/pencil` skill) — Visual design from wireframe
3. **Code** — Implement from the Pencil design

## Integration Notes

- **Blueprint skill**: ASCII wireframe first → Pencil for visual execution. Complementary tools.
- **Studio (port 8108)**: Studio is for AI image generation (photos, illustrations). Pencil is for UI/layout design. Different use cases — no overlap.
- **Not in `.mcp.json`**: On-demand only. MCP auto-starts when the desktop app is running — no config needed.
- **Headless**: Not yet available. Pencil team says "coming soon." Currently requires the desktop app to be open.

## Known Limitations

- Chat/overlay can be unresponsive on some actions (from testing)
- Overlay may get stuck — close and reopen if needed
- Slower on complex multi-component designs
- No headless mode yet — requires desktop app running
- CLI is experimental — desktop app is the stable path
- No npm MCP package available (can't add to `.mcp.json` as a standard server)

## Configuration

Not added to `.mcp.json` — the MCP server auto-starts when the Pencil desktop app is open. Claude Code auto-detects it. This is by design since Pencil requires the desktop app to be running.

Entry in `config/mcp-all.json` is for catalog/documentation purposes only.
