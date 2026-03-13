# React Grab — Wiki

> **Status**: Phase 3 Live (2026-03-09)
> **Type**: Dev dependency + MCP server (on-demand, no persistent service)
> **Integration**: `tools/opai-agent/` (dev overlay) + MCP (Claude Code context provider)

---

## Concept

React Grab lets you **hover over any UI element in a running React app and press Ctrl+C** to copy the element's context — file name, React component name, and HTML source code — directly to your clipboard. This context can then be pasted into coding agents for 3x faster, more accurate responses.

Part of Aiden Bai's React tooling suite.

**OPAI integration**: Embedded in opai-agent's dev mode (auto-activates) + available as an on-demand MCP server for Claude Code sessions.

---

## Architecture

### Dev Overlay (opai-agent)

```
tools/opai-agent/src/renderer/index.html
  └── <script type="module">
        if (import.meta.env.DEV) {
          import("react-grab");
        }
      </script>
      └── Hover any element + Ctrl+C → copies component context
```

Only activates in development mode. Zero production overhead.

### MCP Server (Claude Code)

```
npx -y grab@latest mcp
  └── Starts an MCP server that provides React component context
      └── Claude Code can query active React dev sessions for component info
```

On-demand — listed in `config/mcp-all.json` but NOT in root `.mcp.json` by default. Enable per-session when doing React development.

---

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-agent/src/renderer/index.html` | Script tag with conditional dev import |
| `tools/opai-agent/package.json` | `react-grab` + `grab` in devDependencies |
| `config/mcp-all.json` | `react-grab` MCP server entry (on-demand) |

---

## Usage

### In opai-agent (Dev Mode)

```bash
cd tools/opai-agent && npm run dev
```

1. Hover over any UI element
2. Press **Ctrl+C** (Linux/Windows) or **Cmd+C** (Mac)
3. Context is copied to clipboard: file name, component, HTML source
4. Paste into Claude Code or any AI agent for targeted assistance

### MCP Server (Claude Code)

To enable the MCP server for a session, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "react-grab": {
      "command": "npx",
      "args": ["-y", "grab@latest", "mcp"]
    }
  }
}
```

Then restart Claude Code. The MCP server provides component context tools.

### CLI (One-off)

```bash
export PATH="/home/dallas/.nvm/versions/node/v20.19.5/bin:$PATH"
npx -y grab@latest mcp
```

---

## React Tooling Suite — Phase Status

| Phase | Tool | Purpose | Status |
|-------|------|---------|--------|
| 1 | React Doctor | Static anti-pattern scanner | **Live** |
| 2 | React Scan | Runtime performance profiler | **Live** |
| **3** | **React Grab** | AI context selection (hover → source) | **Live** |

---

## Dependencies

- **Node.js**: v20.19.5 via NVM
- **react-grab**: devDependency in `tools/opai-agent/package.json` (overlay)
- **grab**: devDependency (CLI + MCP runner)
- **Vite**: DEV mode flag controls overlay activation
