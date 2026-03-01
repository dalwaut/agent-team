# SCC IDE — Squad Claude Code Desktop
> Last updated: 2026-02-23 | Source: `tools/scc-ide/` | Port: N/A (desktop app)

## Overview

SCC IDE is a native Linux desktop application that wraps the Claude Code CLI with a full conversation management UI, OPAI-specific tooling, and a sleek dark theme. It is **not** a web app — it runs as a standalone `.AppImage` or `.deb` package launched from the desktop shortcut.

**Desktop shortcut:** `~/Desktop/scc-ide.desktop`
**Icon:** `tools/scc-ide.png` (256×256 pixel art, transparent bg)
**Launcher script:** `tools/scc-ide/launch.sh`
**Build output:** `tools/scc-ide/out/`

---

## Architecture

```
Electron Main Process (Node.js)
  ├── Claude CLI runner — spawns `claude --output-format stream-json --verbose`
  ├── SQLite DB (~/.scc-ide/conversations.db) — conversation metadata
  ├── chokidar HITL watcher — watches reports/HITL/ for new files
  ├── Squad runner — spawns run_squad.sh, streams output
  └── IPC handlers (all exposed via preload as window.scc)

Renderer Process (React 18 + Vite)
  ├── App.tsx — 3-panel resizable layout
  ├── TopBar — frameless window controls, cwd/model selectors
  ├── ConversationList — session groups, search, pin/delete
  ├── ChatArea — message stream, thinking display, HITL cards
  ├── InputArea — Shift+Enter, file/image attach, clipboard paste
  └── RightPanel — tabbed: Plugins | Squads | Links | HITL
```

**Tech stack:** Electron 31 + electron-vite + React 18 + TypeScript + Tailwind CSS 3 + Zustand + better-sqlite3 + chokidar + lucide-react

---

## Image / Vision Input

SCC supports pasting or attaching images that Claude can actually *see* (full vision, not just filename labels).

### How it works — end to end

**1. Renderer: capture attachment**
`InputArea.tsx` reads the image via `FileReader.readAsDataURL()` → `att.content = "data:image/png;base64,..."`
The full data URL is stored in the `Attachment` object and displayed as a thumbnail preview.

**2. Renderer: add to message content**
In `ChatArea.processMessage`, the image is pushed as an `{ type: 'image', dataUrl, name }` content block.
This renders in `MessageBubble` as a normal `<img src={dataUrl}>` — the thumbnail appears in the user bubble.

**3. Renderer: extract base64 for Claude**
Also in `processMessage`, the base64 payload is stripped from the data URL prefix and passed to `spawn()`:
```typescript
images: [{ base64: att.content.split(',')[1], mimeType: att.mimeType, name: att.name }]
```
No temp files, no IPC round-trips for writing — the base64 data goes straight into the spawn call.

**4. Main process: multimodal spawn**
`index.ts claude:spawn` detects `hasImages = opts.images.length > 0` and:
- Adds `-p ""` (enables print mode; prompt content comes from stdin, not the arg)
- Adds `--input-format stream-json` (Claude Code reads its user turn from stdin as JSON)
- After spawning, immediately writes the user turn to stdin:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } },
      { "type": "text", "text": "user's prompt text" }
    ]
  }
}
```

Claude Code receives the image as a proper Anthropic API vision block and can describe, analyze, or reason about it.

**5. stdin stays open**
stdin is **not** closed after writing the user message — it must remain open to support permission responses (`claude:permission-respond` writes JSON to stdin if Claude needs tool approval). stdin is only closed after the `result` event fires.

### Critical rules — DO NOT change this pipeline
- **`-p ""`** is required even with `--input-format stream-json`. Without `-p`, Claude Code stays in interactive mode and ignores `--input-format`.
- **Envelope format** must be `{"type":"user","message":{...}}`. A bare `{"role":"user","content":[...]}` is silently ignored (no output, no error).
- **Text-only messages** continue using `-p opts.prompt` (no `--input-format stream-json`). The multimodal path only activates when `opts.images?.length > 0`.
- **`--allowedTools Read Glob Grep LS`** is always added. This prevents Claude from blocking on a permission card for safe read-only tools. Write/Edit/Bash still prompt for approval.

### Tested and confirmed working (2026-02-23)
Claude correctly described a screenshot with: *"The screenshot shows Claude Code retrieving and displaying the workspace's weekly Claude API usage, which is at 51% and entering caution territory."*

---

## Features

### Conversation Management
- Sidebar groups sessions by Pinned / Today / Yesterday / This Week / Older
- Resume via `--resume <session_id>` (from `~/.claude/projects/<encoded_path>/*.jsonl`)
- Search, pin, delete, right-click context menu
- Metadata stored in `~/.scc-ide/conversations.db` (SQLite)

### Thinking Display
- Claude's `<thinking>` blocks render as `⚙ Thinking...` with a shimmer animation
- Click to expand/collapse — shows full reasoning in monospace scrollable block
- Auto-scrolls when streaming and expanded

### Input Box
- **Shift+Enter** = newline, **Enter** = submit
- Drag-and-drop or click 📎/📷 to attach files
- Clipboard image paste (Ctrl+V)
- Attachment strip preview above the textarea
- File types: images (base64/vision), PDFs (text extract), text files (code blocks), others (base64)

### wshobson Plugin Panel (Right → Plugins tab)
- Full 72-plugin catalog searchable by name/description
- Categorized: Always Installed → High Priority → Mobile → PRD → Low Priority
- One-click `[Install]` injects `/plugin install <name>` as a chat message
- Session state tracking — shows what's installed this session
- Hover to see slash commands for each plugin

### Squad Quick-Run (Right → Squads tab)
- All 26 squads grouped: Development / Security / Quality / Operations / Auto-Fix
- Favorites pinned at top: audit, security_quick, ship, build, review
- HITL badge on squads that always require human approval
- `build` squad shows inline task text input before running
- Output streamed as a `SquadRunCard` in the chat

### HITL Panel (Right → HITL tab)
- Watches `reports/HITL/` via chokidar — live badge count
- Each item: filename, timestamp, 100-char preview, [View Full] + [Mark Done]
- In-session tool approvals show as `HitlCard` inline in chat with Approve/Deny/Modify

### OPAI Links (Right → Links tab)
- All OPAI tools: Portal, Monitor, Orchestra, Agent Studio, Task Control, Files, Chat, Bot Space
- Quick actions: check service status, open workspace in file manager
- Docs: OPAI Wiki, Mobile API Reference, SCC IDE plan

### Top Bar
- Frameless window (custom title bar) — minimize/maximize/close
- Project (cwd) dropdown — OPAI Workspace default + recently used
- Model selector — claude-sonnet-4-6 / claude-opus-4-6 / claude-haiku-4-5
- Right panel toggle

---

## File Structure

```
tools/scc-ide/
├── launch.sh                          # Smart launcher (AppImage → built → dev → setup)
├── package.json                       # Electron + React + TS deps
├── electron.vite.config.ts            # Build config (main/preload/renderer)
├── tailwind.config.js                 # OPAI purple palette + animations
├── build/
│   └── icon.png                       # 512×512 app icon (electron-builder)
├── src/
│   ├── main/index.ts                  # Electron main process, IPC handlers
│   ├── preload/
│   │   ├── index.ts                   # contextBridge → window.scc
│   │   └── index.d.ts                 # TypeScript types for window.scc API
│   └── renderer/src/
│       ├── App.tsx                    # 3-panel layout, resizable
│       ├── types.ts                   # Shared TS interfaces
│       ├── assets/index.css           # Global styles + animations
│       ├── components/
│       │   ├── TopBar.tsx
│       │   ├── chat/
│       │   │   ├── ChatArea.tsx       # Main chat + stream handler
│       │   │   ├── MessageBubble.tsx  # User/assistant message renderer
│       │   │   ├── ThinkingBlock.tsx  # Animated collapsible thinking
│       │   │   ├── ToolCallCard.tsx   # Tool use/result display
│       │   │   ├── HitlCard.tsx       # Inline approval card
│       │   │   ├── InputArea.tsx      # Textarea + file attach
│       │   │   └── SquadRunCard.tsx   # Squad execution output
│       │   ├── sidebar/
│       │   │   ├── ConversationList.tsx
│       │   │   └── ConversationItem.tsx
│       │   └── right-panel/
│       │       ├── RightPanel.tsx     # Tabbed container
│       │       ├── PluginsTab.tsx     # wshobson 72-plugin catalog
│       │       ├── SquadsTab.tsx      # 26-squad quick-run
│       │       ├── LinksTab.tsx       # OPAI tool links
│       │       └── HitlTab.tsx        # Async HITL file viewer
│       ├── stores/
│       │   ├── conversationStore.ts
│       │   ├── chatStore.ts
│       │   ├── pluginStore.ts
│       │   └── hitlStore.ts
│       ├── lib/utils.ts               # cn(), formatRelativeTime(), etc.
│       └── data/
│           ├── wshobson-plugins.json  # Full 72-plugin static catalog
│           └── opai-squads.json       # All 26 squads
└── out/                               # Build output (electron-vite)
    ├── main/index.js
    ├── preload/index.js
    └── renderer/
```

---

## Running

### Launch from desktop
Double-click `SCC IDE` on the desktop — the `.desktop` file calls `launch.sh` which:
1. Checks for `dist/SCC-IDE.AppImage` → launches it
2. Falls back to `out/main/index.js` via `npx electron .` (built, not packaged)
3. Falls back to `npm run dev` (hot-reload dev mode)
4. If nothing built: prints setup instructions

### Dev mode (hot reload)
```bash
cd /workspace/synced/opai/tools/scc-ide
npm run dev
```

### Production build
```bash
cd /workspace/synced/opai/tools/scc-ide
npm run build
```

### Package as AppImage + .deb
```bash
cd /workspace/synced/opai/tools/scc-ide
npm run build:linux
# Output in dist/
```

---

## IPC API Reference (window.scc)

| Method | Description |
|--------|-------------|
| `spawn(opts)` | Spawn Claude CLI. `opts`: `{ cwd, prompt, sessionId?, model?, images? }`. Text-only: uses `-p prompt`. With images: uses `-p "" --input-format stream-json`, writes multimodal JSON to stdin. |
| `stop()` | SIGTERM the running Claude process |
| `listSessions()` | List all JSONL sessions from `~/.claude/projects/` |
| `deleteSession(id)` | Delete a session file |
| `openExternal(url)` | Open URL/path in system default app |
| `runSquad(opts)` | Run a squad script, stream via `squad:output` / `squad:done` |
| `listHITL()` | List files in `reports/HITL/` |
| `doneHITL(file)` | Move HITL file to `reports/HITL/done/` |
| `readHITL(file)` | Read HITL file content |
| `permissionRespond(requestId, approved)` | Approve or deny a Claude tool permission. Approve = writes JSON to stdin; Deny = SIGTERM |
| `getVersion()` | App version string |
| `minimize/maximize/close()` | Window controls (frameless titlebar) |
| `upsertConversation(data)` | Save conversation metadata to SQLite |
| `listConversations()` | All conversations, sorted pinned-first then by recency |
| `pinConversation(id)` | Toggle pinned flag |
| `deleteConversation(id)` | Soft-delete (sets `deleted=1` in SQLite; excluded from future lists) |
| `loadMessages(sessionId)` | Load full JSONL history. Returns messages already converted to `thought_group` format. |
| `getServiceStatus()` | Poll `systemctl --user list-units opai-*` |
| `getUsage()` | Fetch Claude plan usage from local monitor API |
| `on(channel, cb)` | Subscribe to a stream event channel |
| `off(channel, cb)` | Unsubscribe |

**Stream channels:** `claude:stream`, `claude:done`, `claude:error`, `claude:permission-request`, `squad:output`, `squad:done`, `hitl:new`, `hitl-update`, `conversation-updated`

---

## Design System

| Token | Value | Usage |
|-------|-------|-------|
| `--opai-600` | `#7c3aed` | Primary accent, buttons, borders |
| `--surface-base` | `#0a0a0a` | App background |
| `--surface-panel` | `#111111` | Sidebars, panels |
| `--surface-content` | `#0d0d1a` | Chat area |
| `--surface-card` | `#18181b` | Code blocks, thinking |
| `--text-primary` | `#f4f4f5` | Main text |
| `--text-muted` | `#71717a` | Labels, timestamps |

Animations: `shimmer` (thinking text), `msg-in` (message fade), `pulse-red` (HITL badge)

---

## Future Roadmap

- [ ] Multi-window support (separate window per project)
- [ ] Git diff viewer for Claude file changes
- [ ] Timeline / session checkpointing
- [ ] MCP server manager UI
- [ ] Prompt library (saved templates)
- [ ] In-app report browser (`reports/<date>/`)
- [ ] Token budget visual bar
- [ ] Voice input
- [ ] AppImage packaging + auto-update

---

## Related

- [wshobson Agents](wshobson-agents.md) — the 72-plugin catalog powering the Plugins tab
- [Agent Framework](agent-framework.md) — the 26 squads powering the Squads tab
- [services-systemd.md](services-systemd.md) — OPAI services linked from the Links tab
- `memory/wip/scc-ide-plan.md` — original design plan with layout mockups
