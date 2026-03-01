# OPAIxClaude — Standalone Claude Code Desktop Wrapper
> Last updated: 2026-02-25 | Source: `tools/opai-agent/` | GitHub: `dalwaut/OPAIxClaude` (private) | Port: N/A (desktop app)

## Overview

OPAIxClaude is a **standalone** native Linux desktop application that wraps the Claude Code CLI with a clean conversation UI, parallel session management, and a branch-based self-improvement loop. Forked from SCC IDE, it has been fully sanitized of OPAI internals — it's a generic Claude wrapper that picks up skills, MCPs, and tools from whatever project directory the user selects.

**Goal:** Anyone can pick up the app, run it on their own machine, and evolve it to be their own interface.

**Desktop shortcut:** `~/Desktop/opai-agent.desktop` (create manually)
**Launcher script:** `tools/opai-agent/launch.sh`
**Build output:** `tools/opai-agent/out/`
**DB:** `~/.opaixclaude/conversations.db` (SQLite, WAL mode)
**localStorage keys:** `opaixclaude:*`

---

## Standalone Repository

OPAIxClaude has its own Git repo **nested inside** the OPAI workspace:

```
/workspace/synced/opai/          ← parent OPAI repo (OPAI-Server branch)
  └── tools/opai-agent/          ← OPAIxClaude repo (main branch)
       └── .git/                 ← independent repo
```

**Parent ignores child:** `tools/opai-agent/` is in the parent `.gitignore`. Git commands run inside `tools/opai-agent/` operate on the OPAIxClaude repo only.

**Versioning:** GitHub at `dalwaut/OPAIxClaude`. Push/pull/branch all independent from OPAI.

```bash
# Update OPAIxClaude only
cd /workspace/synced/opai/tools/opai-agent
git add -A && git commit -m "feat: whatever"
git push origin main

# Parent OPAI repo is completely unaffected
```

---

## Architecture

```
Electron Main Process (Node.js)
  ├── Claude CLI runner — Map<string, ChildProcess> (parallel sessions)
  ├── SQLite DB (~/.opaixclaude/conversations.db)
  ├── GitHub integration (PAT encrypted via safeStorage)
  ├── Branch-based feedback/self-improvement loop
  └── IPC handlers (all exposed via preload as window.scc)

Renderer Process (React 18 + Vite)
  ├── App.tsx — 2-panel resizable white layout
  ├── TopBar — white frameless titlebar, project/model selectors
  ├── ConversationList — left sidebar (collapsible) with active-session indicators
  ├── ChatArea — message stream with inline permission cards
  └── InputArea — message input with file/image attach
```

**Tech stack:** Electron 31 + electron-vite + React 18 + TypeScript + Tailwind CSS 3 + better-sqlite3 + lucide-react

---

## Key Features

### Parallel Conversations
Multiple Claude sessions run simultaneously. Switching conversations does NOT stop the previous session — it continues in the background. Active sessions show a spinning indicator in the sidebar.

Implementation: `claudeProcesses = new Map<string, ChildProcess>()` with `pending-<uuid>` temporary keys re-keyed to real session IDs on `system/init`.

### Branch-Based Self-Improvement
The app can improve itself via Claude:
1. User submits improvement idea → Claude analyzes and creates a plan
2. User approves plan → creates `improvement-<timestamp>` git branch, implements changes, runs `npm run build` to verify
3. User approves result → merges branch to main
4. User rejects → deletes branch, restores main

Changes never touch main until build-tested and approved.

### GitHub Integration
- Encrypted PAT storage via Electron `safeStorage` (OS keychain)
- Push/pull directly from the app
- Version control and restore via GitHub

### Directory-Aware
The project dropdown selects the working directory. Claude picks up `.claude/`, CLAUDE.md, `.mcp.json`, skills, and tools from whatever directory is selected — making the app useful for any project.

---

## Design System (White Theme)

| Token | Value | Usage |
|-------|-------|-------|
| Primary accent | `#4a56e6` | Buttons, active states, links |
| Surface base | `#ffffff` | App background |
| Surface panel | `#f8f9fb` | Sidebars |
| Surface content | `#fafbfc` | Chat area |
| Surface card | `#f1f3f6` | Code blocks, cards |
| Border | `#e2e6ec` | Panel borders, dividers |
| Text primary | `#1a1d23` | Main text |
| Text secondary | `#2d3748` | Body text |
| Text muted | `#9aa2b1` | Labels, timestamps |

---

## Layout

Sidebar is collapsible via toggle in the top bar for a focused full-width chat view:

```
┌──────────────────────────────────────────────────────────┐
│  [≡]  folder/project ▾      session $0.12     Sonnet ▾  _ □ ×  │
├──────────┬───────────────────────────────────────────────┤
│          │                                               │
│Sessions  │            Chat Area                          │
│(collapse)│      Clean white background                   │
│  • conv1 │      Inline permission cards                  │
│  ◎ conv2 │      Thinking block display                   │
│  • conv3 │      File/image attachments                   │
│          │                                               │
│          ├───────────────────────────────────────────────┤
│          │ [📎] [📷] Message Claude...           [Send]  │
└──────────┴───────────────────────────────────────────────┘
  ◎ = active session (spinning indicator)
```

---

## Running

### Dev mode (hot reload)
```bash
cd /workspace/synced/opai/tools/opai-agent
npm run dev
```

### Production build
```bash
cd /workspace/synced/opai/tools/opai-agent
npm run build
```

### Launch
```bash
# AppImage (if built) or dev mode
./tools/opai-agent/launch.sh

# Direct (after build)
ELECTRON_DISABLE_SANDBOX=1 npx electron out/main/index.js
```

---

## Differences from SCC IDE

| Feature | SCC IDE | OPAIxClaude |
|---------|---------|-------------|
| Theme | Dark (#0a0a0a) | White (#ffffff) |
| Layout | 3-panel (sidebar + chat + right panel) | 2-panel (sidebar + chat) |
| Right panel | Plugins, Squads, Links, HITL | **Removed** |
| Conversations | Single process (switching kills previous) | **Parallel** (Map of processes) |
| Self-improvement | None | Branch-based feedback loop |
| OPAI integration | HITL watcher, squad runner, service status | **None** (standalone) |
| GitHub | None | PAT-encrypted push/pull |
| Accent color | Violet (#7c3aed) | Blue (#4a56e6) |
| DB location | `~/.scc-ide/` | `~/.opaixclaude/` |
| localStorage | `scc:*` keys | `opaixclaude:*` keys |
| Repo | Part of OPAI monorepo | **Standalone** (`dalwaut/OPAIxClaude`) |

---

## Related

- [SCC IDE](scc-ide.md) — the dark-themed original this was forked from
- [Feedback System](feedback-system.md) — OPAI's server-side feedback (OPAIxClaude uses its own branch-based loop)
