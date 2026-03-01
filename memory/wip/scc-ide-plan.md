# SCC IDE — Architecture & Design Plan
> Status: PLANNING | Created: 2026-02-21 | Author: Claude Code

## What Is SCC IDE

"SCC" = **Squad Claude Code** IDE — OPAI's native Linux desktop client that wraps
Claude Code CLI with full conversation management, OPAI-specific tooling, the
wshobson plugin cheatsheet, HITL displays, and a sleek branded UI.

This is NOT a web app or a browser tab. It is a genuine native Linux application
installable as a `.deb` / `.AppImage`, running standalone.

---

## Ecosystem Survey Summary

| Project | Stack | License | Key Features | Why Not Use As Base |
|---------|-------|---------|-------------|---------------------|
| **CodePilot** | Electron + Next.js + shadcn | MIT | ✅ Best feature set overall | Heavy Electron but MIT is ideal |
| **Opcode** | Tauri + React | AGPL-3.0 | Timeline/checkpoints, MCP mgmt | AGPL forces source disclosure |
| Claude Code Desktop | Tauri + React | MIT | Multi-model support | Less mature |
| CloudCLI | Node + React (web) | GPLv3 | Simplest to extend | Web only, not native |
| claude-code-webui | Deno/Node + React | MIT | Clean streaming | Web only |

**Decision: Fork CodePilot (MIT)** — most feature-complete baseline:
- ✅ Real-time streaming with tool-call visualization → repurpose as Thinking display
- ✅ File & image attachments already working
- ✅ Per-action permission controls → HITL foundation
- ✅ Custom skills as slash commands
- ✅ Electron → .deb, .AppImage, .rpm on Linux
- ✅ MIT license → can fork, modify, brand, keep private
- ✅ Next.js + shadcn/ui → familiar, extensible
- ✅ SQLite local persistence

**CodePilot GitHub**: https://github.com/op7418/CodePilot

---

## Tech Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Desktop shell | Electron (via CodePilot fork) | Linux native, pre-built .AppImage/.deb, mature IPC |
| Frontend | Next.js 16 + React 18 + TypeScript | CodePilot baseline |
| UI components | shadcn/ui + Tailwind CSS 4 | Already in CodePilot, consistent design system |
| State | Zustand | Already in CodePilot |
| DB | better-sqlite3 (embedded) | Conversation persistence, no server required |
| Markdown | react-markdown + Shiki | Code highlighting in messages |
| Claude integration | `claude` CLI via `--output-format stream-json --verbose` | Official streaming format |
| File watching | chokidar | Watch reports/HITL/ for new items |
| Package | bun or npm | Build tooling |

---

## Layout & UI Design

```
┌─────────────────────────────────────────────────────────────────────┐
│  [SCC] ▼ Project Selector    [Model ▼]  [⚡ Usage]  [⚙]  [↗ Open] │  ← Top Bar
├──────────────┬──────────────────────────────────┬───────────────────┤
│              │                                  │                   │
│ CONVERSATIONS│         CHAT AREA                │   RIGHT PANEL     │
│              │                                  │  ┌─ Tabs ────────┐│
│ 🔍 Search    │  ╔══════════════════════════╗    │  │ Plugins│Squads││
│              │  ║ [User message bubble]    ║    │  │ Links │ HITL  ││
│ ▼ Today      │  ╚══════════════════════════╝    │  └───────────────┘│
│   Fix auth   │                                  │                   │
│   New feat   │  ⚙ Thinking...  [▶ expand]      │  [PLUGIN PANEL]   │
│              │  ▼ (expanded)                    │  ┌───────────────┐│
│ ▼ Yesterday  │  ┌──────────────────────────┐    │  │ agent-teams ✓ ││
│   Bug audit  │  │ <thinking>content</thinking>│  │  │ security-scan ││
│   Wiki sync  │  └──────────────────────────┘    │  │ python-dev    ││
│              │                                  │  │ database-des  ││
│ ▼ This Week  │  ╔══════════════════════════╗    │  └───────────────┘│
│   ...        │  ║ [Claude response]        ║    │                   │
│              │  ║ [tool call card]         ║    │  [SQUAD QUICK-RUN]│
│              │  ╚══════════════════════════╝    │  ┌───────────────┐│
│ [+ New Chat] │                                  │  │ ▶ audit       ││
│              │  ╔══════════════════════════╗    │  │ ▶ security_q  ││
│              │  ║ HITL CARD:               ║    │  │ ▶ ship        ││
│              │  ║ 🔴 Action Required       ║    │  └───────────────┘│
│              │  ║ Agent wants to delete    ║    │                   │
│              │  ║ [Approve] [Deny] [Edit]  ║    │  [OPAI LINKS]     │
│              │  ╚══════════════════════════╝    │  Portal Monitor   │
│              │                                  │  Orchestra Studio │
│              │  ─────── Input Area ───────      │                   │
│              │  ┌──────────────────────────┐    │                   │
│              │  │ Shift+Enter for newline  │    │                   │
│              │  │ Drag files/images here   │    │                   │
│              │  └──────────────────────────┘    │                   │
│              │  📎 📷  [Quick: /audit] [Send ↵] │                   │
└──────────────┴──────────────────────────────────┴───────────────────┘
```

---

## Feature Specifications

### 1. Conversation Management

**How it works:**
- Claude Code stores sessions as JSONL files in `~/.claude/projects/<hash>/`
- Each session has a `session_id` (UUID)
- Resume via: `claude --resume <session_id> -p "..."`
- New conversation: `claude --cwd <workdir> -p "..."`

**UI:**
- Left sidebar: grouped by Today / Yesterday / This Week / Older
- Each entry shows: title (first user message, truncated), relative timestamp, status indicator (active/completed)
- Right-click context: rename, delete, export, view raw JSONL
- Search: fuzzy search across conversation titles + content
- Active conversations show a pulsing green dot
- "Pin" conversations to top (stored in SCC local SQLite)
- Create new → shows project/cwd picker dropdown

**Implementation:**
- `ConversationStore` (Zustand) indexes `~/.claude/projects/` on startup + watches via chokidar
- Session metadata cached in local SQLite: title, cwd, created_at, last_message_at, message_count
- Background thread scans JSONL files to extract titles and populate cache

---

### 2. Thinking Display

Claude Code's `stream-json` format emits `assistant` messages with `content` arrays. Thinking blocks appear as `{"type":"thinking","thinking":"..."}` content items.

**UI:**
- While streaming: animated "⚙ Thinking..." with a subtle horizontal shimmer animation
- Collapsible by default (like GitHub's "Details" element)
- Click the header to expand → shows the raw thinking text in a monospace scrollable block with dimmed styling
- If thinking is very long: fade-out at 200px with "Show more" link
- Color: neutral/muted — distinct from response content (e.g., `bg-zinc-900` dark bg, `text-zinc-400`)

**Implementation:**
```typescript
// Detect in stream processor:
if (content.type === 'thinking') {
  setThinkingBuffer(prev => prev + content.thinking)
  setIsThinking(true)
} else if (content.type === 'text') {
  setIsThinking(false)
  // render response
}
```

Animation: CSS keyframe shimmer on the "Thinking..." text, stops when `isThinking` becomes false.

---

### 3. Enhanced Input Box

**Features:**
- `Shift+Enter` → inserts newline (not submit)
- `Enter` → submit (configurable in settings to swap)
- **Attachments:**
  - Click 📎 → file picker (any file type)
  - Click 📷 → image picker (jpg/png/gif/webp)
  - Drag & drop into input area
  - Inline previews: images show thumbnail, files show icon + filename + size
- **File handling:**
  - Images → base64 encoded and passed as vision content (Claude supports multimodal)
  - PDFs → extract text via `pdf-parse` npm package, inject as `<document>` block
  - Text files (.md, .txt, .json, .py, etc.) → read and inject as code block
  - Other binary → warn user, offer to pass file path reference only
- Paste image from clipboard (Ctrl+V)
- Character/token count indicator (approximate)
- Auto-growing textarea (max 8 rows before scroll)

---

### 4. wshobson Plugin Panel (Right Panel → "Plugins" tab)

**Layout:**
```
┌─ Plugins ──────────────────────────────────────┐
│ 🔍 Search plugins...                           │
│                                                │
│ INSTALLED THIS SESSION                         │
│  ✅ agent-teams      [Remove]                  │
│  ✅ security-scan    [Remove]                  │
│                                                │
│ HIGH PRIORITY — CORE STACK                     │
│  python-development     [Install]              │
│    FastAPI async, uv/ruff, Python patterns     │
│  database-design        [Install]              │
│    PostgreSQL, RLS, migration safety           │
│  payment-processing     [Install]              │
│    Stripe, PCI compliance                      │
│  ...                                           │
│                                                │
│ MOBILE APP                                     │
│  react-native           [Install]              │
│  api-testing-obs...     [Install]              │
│                                                │
│ PRD / BUSINESS                                 │
│  startup-business-...   [Install]              │
│  content-marketing      [Install]              │
│                                                │
│ ALL 72 PLUGINS ▼                               │
└────────────────────────────────────────────────┘
```

**Behavior:**
- [Install] button → fires `/plugin install <name>` as a message in the current chat
- Session state tracked: installed plugins stored in Zustand, cleared on new conversation
- [Remove] → fires `/plugin uninstall <name>` (if supported) or warns user to start new session
- Expand "ALL 72 PLUGINS" → shows full catalog from hardcoded JSON (derived from wshobson-agents.md)
- Tooltip on hover: shows description, slash commands available, skill count
- Pinned: the 3 installed ones (agent-teams, security-scanning, full-stack-orchestration) always show at top

**Data source:** Static JSON file embedded in the app, derived from wshobson-agents wiki. No network required.

---

### 5. Squad Quick-Run Panel (Right Panel → "Squads" tab)

```
┌─ Squads ───────────────────────────────────────┐
│ FAVORITES                                      │
│  ▶ audit          Full codebase health check   │
│  ▶ security_quick Daily security sweep         │
│  ▶ ship           Pre-release gate             │
│  ▶ build          [Enter task...    ] [Run ▶]  │
│                                                │
│ SECURITY                                       │
│  ▶ secure         Full security suite          │
│  ▶ dep_scan       CVE scan only               │
│  ▶ secrets_scan   Secrets detection           │
│                                                │
│ QUALITY                                        │
│  ▶ review         Post-change code review      │
│  ▶ a11y           Accessibility review         │
│                                                │
│ OPERATIONS                                     │
│  ▶ wiki           Update system wiki           │
│  ▶ incident       Incident detection (HITL)    │
│  ... (all 26 squads)                           │
│                                                │
│ Custom: [./scripts/run_squad.sh -s _____] [▶]  │
└────────────────────────────────────────────────┘
```

**Behavior:**
- ▶ button → opens confirmation modal showing what the squad does and which agents run
- Confirm → executes `./scripts/run_squad.sh -s <squad>` in background process
- Shows progress: running indicator → complete with link to report file
- `build` squad has inline text input for the task description
- Output appended to chat as a "Squad Run" card with collapsible log

---

### 6. HITL (Human-in-the-Loop) Display

**Two sources of HITL:**

**A. In-session Claude Code permission requests** (tool use approval):
- Already handled by CodePilot's per-action permission system
- Each tool call that needs approval shows as a card:
  ```
  ╔═ 🔴 Tool Approval Required ═══════════════╗
  ║ Claude wants to: Write File                ║
  ║ Path: /workspace/synced/opai/tools/...     ║
  ║ Content preview: [show first 10 lines]     ║
  ║                                            ║
  ║ [✅ Approve] [❌ Deny] [🔧 Modify Path]    ║
  ╚════════════════════════════════════════════╝
  ```

**B. Async HITL from reports/HITL/:**
- chokidar watches `reports/HITL/` for new `.md` files
- New file → shows notification badge on "HITL" tab in right panel
- Click tab → shows list of pending HITL items as cards
- Each card: filename, timestamp, first 100 chars of content, [View Full] [Mark Done] [Open Report]
- [Mark Done] → moves file to `reports/HITL/done/`

---

### 7. OPAI Links Panel (Right Panel → "Links" tab)

```
┌─ OPAI Resources ───────────────────────────────┐
│ TOOLS                                          │
│  🌐 Portal          /dashboard                 │
│  📊 Monitor         /monitor/                  │
│  🎼 Orchestra       /orchestra/                │
│  🤖 Agent Studio    /agents/                   │
│  📋 Task Control    /tasks/                    │
│  📁 Files           /files/                    │
│  💬 Chat            /chat/                     │
│  🤖 Bot Space       /bot-space/                │
│                                                │
│ QUICK ACTIONS                                  │
│  📝 Service Status  [Check]                    │
│  🔄 Restart All     [Restart]                  │
│  📧 Email Agent     [Open]                     │
│                                                │
│ DOCS                                           │
│  📖 OPAI Wiki       Library/opai-wiki/         │
│  📱 Mobile API Ref  docs/mobile-api-reference  │
│  🔑 Access Notes    notes/Access/              │
└────────────────────────────────────────────────┘
```

All links open in the system browser (or Electron's shell.openExternal).

---

### 8. Top Bar

```
[SCC] ▼ /workspace/synced/opai    [claude-sonnet-4-6 ▼]  [⚡ 45% used]  [⚙]  [↗ Open in...]
```

- **Project selector**: dropdown of recently used directories, + browse filesystem
- **Model selector**: shows current model, can switch (claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5)
- **Usage indicator**: pulls from Claude usage tracking (see memory/claude-usage-tracking.md)
- **Settings gear**: opens settings modal (API key, permissions, themes, keybindings)
- **"Open in..." button**: dropdown menu:
  - Open in VS Code (`code <workdir>`)
  - Open in Antigravity / OP IDE (`xdg-open https://opai.boutabyte.com/dev/`)
  - Open in Terminal (`xterm --workdir <workdir>` or system default)
  - Open in File Manager

---

### 9. Theme & Styling

**Dark theme (primary):**
- Background: `#0a0a0a` (near-black)
- Panel bg: `#111111`
- Border: `#222222`
- Accent: OPAI purple `#7c3aed` (violet-600)
- Text primary: `#f4f4f5` (zinc-100)
- Text muted: `#71717a` (zinc-500)
- Thinking block: `#18181b` bg, `#52525b` text
- HITL urgent: `#7f1d1d` bg, `#fca5a5` text
- Success: `#14532d` bg, `#86efac` text

**Typography:**
- UI: `Inter` (system default) or `Geist` (shadcn default)
- Code / thinking blocks: `JetBrains Mono` or `Fira Code`
- Font size: 13px base UI, 14px chat bubbles, 13px code

**Animations:**
- Thinking shimmer: left-to-right gradient sweep, 1.5s loop
- Message fade-in: `opacity 0→1 + translateY 8px→0`, 150ms ease
- Panel transitions: 200ms ease-in-out
- HITL pulse: red glow on badge, 2s pulse loop

---

## Implementation Phases

### Phase 0 — Fork & Bootstrap (Day 1)
```bash
git clone https://github.com/op7418/CodePilot scc-ide
cd scc-ide
# Remove CodePilot branding
# Update package.json: name=scc-ide, productName="SCC IDE"
# Apply OPAI purple theme to tailwind.config.ts
# Verify Linux build: bun run build:linux
```

### Phase 1 — Core Chat Works (Days 2-3)
- [ ] Conversation list sidebar (JSONL file indexing)
- [ ] Resume sessions via `--resume <session_id>`
- [ ] Thinking block detection + animated display
- [ ] Shift+Enter newline support (verify / fix from CodePilot base)
- [ ] File/image attach (verify CodePilot's existing implementation)
- [ ] Basic OPAI theme applied

### Phase 2 — OPAI Panels (Days 4-5)
- [ ] Right panel: Plugins tab with wshobson catalog
- [ ] Right panel: Squads tab with quick-run buttons
- [ ] Right panel: Links tab with OPAI tool links
- [ ] Squad runner (background process execution)
- [ ] HITL tab + chokidar watcher for reports/HITL/

### Phase 3 — HITL & Permissions (Days 6-7)
- [ ] In-session tool approval cards (from CodePilot base, customize UI)
- [ ] Async HITL reader (file watcher → notification badge → card UI)
- [ ] Permission mode selector (normal / plan / auto)

### Phase 4 — Top Bar & Polish (Days 8-9)
- [ ] Project/cwd selector dropdown
- [ ] Model selector
- [ ] Usage indicator (API query)
- [ ] "Open in..." button with VS Code + Antigravity
- [ ] Settings modal

### Phase 5 — Build & Package (Day 10)
- [ ] Linux .AppImage build
- [ ] Linux .deb build
- [ ] Auto-update support (Electron's autoUpdater or electron-updater)
- [ ] README + install script

---

## File Structure (new files on top of CodePilot fork)

```
scc-ide/
├── electron/
│   ├── main.ts              # Electron main process
│   ├── preload.ts           # IPC bridge
│   └── hitl-watcher.ts      # NEW: chokidar HITL file watcher
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/
│   │   ├── chat/
│   │   │   ├── ThinkingBlock.tsx      # NEW: animated thinking display
│   │   │   ├── HitlCard.tsx           # NEW: HITL approval card
│   │   │   ├── SquadRunCard.tsx       # NEW: squad execution result
│   │   │   ├── MessageBubble.tsx      # Modified from CodePilot
│   │   │   └── InputArea.tsx          # Modified: Shift+Enter, file attach
│   │   ├── sidebar/
│   │   │   ├── ConversationList.tsx   # NEW: full conversation manager
│   │   │   └── ConversationItem.tsx
│   │   ├── right-panel/
│   │   │   ├── RightPanel.tsx         # NEW: tabbed container
│   │   │   ├── PluginsTab.tsx         # NEW: wshobson catalog
│   │   │   ├── SquadsTab.tsx          # NEW: squad quick-run
│   │   │   ├── LinksTab.tsx           # NEW: OPAI resource links
│   │   │   └── HitlTab.tsx            # NEW: async HITL viewer
│   │   └── topbar/
│   │       ├── TopBar.tsx             # NEW: project/model/usage/open-in
│   │       └── OpenInMenu.tsx         # NEW: VS Code / Antigravity
│   ├── data/
│   │   ├── wshobson-plugins.json      # NEW: full 72-plugin catalog (static)
│   │   └── opai-squads.json           # NEW: 26 squads with descriptions
│   ├── stores/
│   │   ├── conversationStore.ts       # NEW: session management
│   │   ├── pluginStore.ts             # NEW: session plugin state
│   │   └── hitlStore.ts               # NEW: HITL notification state
│   └── lib/
│       ├── claude-runner.ts           # Modified: --resume support, stream-json
│       ├── session-indexer.ts         # NEW: JSONL file indexer
│       └── squad-runner.ts            # NEW: background squad execution
└── scripts/
    └── build-linux.sh                 # NEW: .AppImage + .deb build script
```

---

## wshobson-plugins.json Structure

```json
{
  "categories": [
    {
      "name": "Installed (Session)",
      "priority": 0,
      "plugins": [
        {
          "id": "agent-teams",
          "displayName": "Agent Teams",
          "description": "Multi-agent parallel code reviews, debugging, feature development",
          "slashCommands": [
            "/agent-teams:team-review",
            "/agent-teams:team-debug",
            "/agent-teams:team-feature",
            "/agent-teams:team-spawn"
          ],
          "installCommand": "/plugin install agent-teams",
          "category": "workflows",
          "opaiPriority": "always-installed"
        }
      ]
    },
    {
      "name": "High Priority — Core Stack",
      "priority": 1,
      "plugins": [
        {
          "id": "python-development",
          "displayName": "Python Development",
          "description": "FastAPI async patterns, Python anti-patterns, uv/ruff",
          "installCommand": "/plugin install python-development",
          "category": "core-stack",
          "opaiPriority": "high"
        }
      ]
    }
  ]
}
```

---

## Technical Notes

### Claude Code Streaming
```bash
# Start new conversation:
claude --cwd /workspace/synced/opai \
       --output-format stream-json \
       --verbose \
       -p "user message here"

# Resume existing:
claude --cwd /workspace/synced/opai \
       --resume <session_id> \
       --output-format stream-json \
       --verbose \
       -p "continuation message"
```

Stream events to handle:
- `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."}]}}`
- `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}`
- `{"type":"tool_use","tool_use":{"name":"...","input":{...}}}`
- `{"type":"tool_result","tool_result":{"content":"..."}}`
- `{"type":"result","result":{"session_id":"...","cost_usd":0.xx}}`

### Session File Location
```
~/.claude/projects/<base64_encoded_path>/
  ├── <session_id_1>.jsonl
  ├── <session_id_2>.jsonl
  └── ...
```

Path encoding: `Buffer.from(absolutePath).toString('base64').replace(/=/g, '')`

### HITL File Watcher
```typescript
import chokidar from 'chokidar';
const hitlDir = '/workspace/synced/opai/reports/HITL';
chokidar.watch(hitlDir, { ignoreInitial: false })
  .on('add', (path) => {
    // Notify renderer via IPC
    mainWindow.webContents.send('hitl:new', { path, timestamp: Date.now() });
  });
```

---

## Future Roadmap (Phase 2 product)

- [ ] **Multi-window**: Separate windows per project/conversation
- [ ] **Diff viewer**: Show file changes from Claude in a git-diff style view
- [ ] **Timeline**: Session branching/checkpointing (from Opcode concept)
- [ ] **MCP server manager**: Configure OPAI MCPs from within SCC IDE
- [ ] **Prompt library**: Saved prompts / templates (OPAI squad prompt viewer)
- [ ] **Report browser**: In-app viewer for `reports/<date>/` markdown files
- [ ] **Token budget display**: Visual bar showing tokens used vs plan limit
- [ ] **Voice input**: Web speech API for hands-free prompting
- [ ] **Multi-agent mode**: Spawn parallel Claude sessions, compare outputs

---

## Where To Build

Decision: Build at `/workspace/synced/opai/tools/scc-ide/` as an OPAI tool (not a
Projects/ entry — it's an internal tool). Add systemd service if needed for any
background services. The app itself runs as a desktop application, not a service.
