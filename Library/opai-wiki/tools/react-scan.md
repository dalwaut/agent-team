# React Scan — Wiki

> **Status**: Phase 2 Live (2026-03-09)
> **Type**: Dev dependency + CLI tool (no dedicated service/port)
> **Integration**: `tools/opai-agent/` (dev overlay) + `scripts/react-scan.sh` (CLI)

---

## Concept

React Scan is a **runtime performance profiler** for React applications. It detects unnecessary re-renders by visually highlighting components that re-render, showing render counts and timing. Part of Aiden Bai's React tooling suite.

Two integration modes:
1. **Dev overlay** — imported in the app, shows visual re-render highlights during development
2. **CLI scanner** — `npx react-scan <url>` scans any running React app from outside

---

## Architecture

### Dev Overlay (opai-agent)

```
tools/opai-agent/src/renderer/src/main.tsx
  ├── if (import.meta.env.DEV) { import('react-scan'); }
  └── Only activates in development mode (Vite DEV flag)
      └── Visual overlay: highlights re-rendering components
          with render counts and timing
```

The conditional import ensures react-scan is **tree-shaken out of production builds** — zero runtime cost in production.

### CLI Mode

```
scripts/react-scan.sh <url>
  └── npx -y react-scan@latest <url>
      └── Opens a browser, injects profiling, reports findings
```

---

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-agent/src/renderer/src/main.tsx` | Conditional dev import of react-scan |
| `tools/opai-agent/package.json` | `react-scan` in devDependencies |
| `scripts/react-scan.sh` | CLI wrapper for scanning any URL |

---

## Usage

### Dev Overlay (opai-agent)

```bash
cd tools/opai-agent && npm run dev
```

When the app runs in dev mode, react-scan automatically activates. Components that re-render are highlighted with visual overlays showing:
- Render count
- Render timing
- Which props/state changed

### CLI Scanner (any React app)

```bash
# Scan a local dev server
./scripts/react-scan.sh http://localhost:5173

# Scan any public React app
./scripts/react-scan.sh https://react.dev
```

---

## React Tooling Suite — Phase Status

| Phase | Tool | Purpose | Status |
|-------|------|---------|--------|
| 1 | React Doctor | Static anti-pattern scanner | **Live** |
| **2** | **React Scan** | Runtime performance profiler | **Live** |
| 3 | React Grab | AI context selection (hover → source) | Planned |

---

## Dependencies

- **Node.js**: v20.19.5 via NVM
- **react-scan**: devDependency in `tools/opai-agent/package.json`
- **Vite**: DEV mode flag controls overlay activation
