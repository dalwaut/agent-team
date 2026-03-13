# OPAI Files
> Last updated: 2026-03-04 | Source: `tools/opai-files/`

## Overview

OPAI Files is a sandboxed web file manager with Obsidian-like knowledge features. Regular users browse their personal sandbox directory (`/workspace/users/<Name>/`); admin users (Dallas-ADMIN) get full access to the OPAI workspace root (`/workspace/synced/opai`) with an optional **context switcher** to toggle to their personal NAS folder. The backend enforces strict path isolation server-side — the client never sees absolute filesystem paths.

**File management**: directory browsing, text editing (Ctrl+S), drag-and-drop upload, download, cut/copy/paste, rename, delete, new file/folder creation, context menu, image preview.

**Knowledge features**: rich markdown rendering (markdown-it + highlight.js + KaTeX + mermaid), `[[wikilink]]` support with resolution and navigation, backlinks panel, interactive knowledge graph (Cytoscape.js radial layout), content search, quick switcher (Ctrl+O), wikilink autocomplete, markdown toolbar, and **Instruct AI** (sandboxed Claude Code for file/folder tasks).

## Architecture

```
Browser → Caddy (:80/:443)
    /files/* → strip prefix → OPAI Files (:8086)
                                  ├── /                     → SPA (index.html)
                                  ├── /api/files/list       → Directory listing
                                  ├── /api/files/read       → Text file content
                                  ├── /api/files/write      → Save file (+ link index update)
                                  ├── /api/files/*          → mkdir, delete, rename, copy, upload, download, info, search
                                  ├── /api/files/search-content → Full-text content search
                                  ├── /api/files/names      → All filenames (autocomplete)
                                  ├── /api/files/ai/*       → Instruct AI (plan + execute)
                                  ├── /api/links/backlinks  → Files linking TO a file
                                  ├── /api/links/forward    → Files a file links TO
                                  ├── /api/links/resolve    → Wikilink name → file path
                                  ├── /api/links/graph      → Graph data (nodes + edges)
                                  ├── /api/links/rebuild    → Force index rebuild (admin)
                                  └── /health               → Service health

Link Index (links.py):
  Lazy-built on first /api/links/* request (~7s for 16k .md files)
  Incrementally updated on write/delete/rename operations
  One index per user root (admin = workspace, users = sandbox)
  Memory: ~500KB for 1000 files with 5 links each

AI Instruct flow:
  1. User selects file/folder, clicks "Instruct AI", types instruction
  2. POST /ai/plan → spawns `claude -p` with strict constraints → returns plan
  3. User reviews plan → clicks "Approve & Execute"
  4. POST /ai/execute → spawns `claude -p` with pre-approved tools → returns result
  Claude is invoked with --allowedTools "Read,Write,Edit,Bash,Glob,Grep"
  CLAUDECODE env var stripped to prevent nested session conflicts

Security flow:
  JWT → get_current_user() → user.role check
    admin → root = /workspace/synced/opai (default)
           → root = user.sandbox_path (when X-Files-Context: personal)
    user  → root = user.sandbox_path (from profiles table)
  Client sends: path="Projects/foo/bar.txt"
  Server joins: root + path → resolve → startswith check → allow or 403

Context switching (admin only):
  Frontend sends X-Files-Context header ("" or "personal")
  Backend uses contextvars.ContextVar for per-request state
  _get_user_root() checks context → returns personal NAS dir or server workspace
  GET /api/files/contexts → lists available contexts for the user
```

- **Backend**: FastAPI (Python) with Uvicorn on port 8086
- **Frontend**: Vanilla JS SPA, dark theme, no framework
- **Auth**: Shared `auth.py` module (Supabase JWT validation)
- **Key pattern**: All paths are relative — server resolves and verifies containment before every operation

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-files/app.py` | FastAPI server — file API endpoints + link API + AI instruct + health + SPA |
| `tools/opai-files/links.py` | Wikilink index engine — scan, resolve, backlinks, graph data, content search |
| `tools/opai-files/config.py` | Host, port, Supabase keys, size limits, admin workspace root, protected files, Claude CLI path |
| `tools/opai-files/requirements.txt` | Python deps: fastapi, uvicorn, python-dotenv, aiofiles, python-multipart |
| `tools/opai-files/.env` | Supabase credentials (URL, anon key, JWT secret, service key) |
| `tools/opai-files/static/index.html` | SPA shell — editor panel, graph overlay, quick switcher, backlinks panel, modals |
| `tools/opai-files/static/style.css` | Dark theme styles — markdown elements, graph, backlinks, quick switcher |
| `tools/opai-files/static/js/files.js` | Client logic: auth, navigation, editor, clipboard, upload, search, wikilink nav, backlinks, autocomplete |
| `tools/opai-files/static/js/markdown.js` | Markdown rendering — markdown-it with highlight.js, KaTeX, wikilinks, callouts, mermaid |
| `tools/opai-files/static/js/graph.js` | Knowledge graph — Cytoscape.js with radial tree layout engine |

## Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `OPAI_FILES_HOST` | Bind address | `127.0.0.1` |
| `OPAI_FILES_PORT` | Listen port | `8086` |
| `SUPABASE_URL` | Supabase project URL | (required) |
| `SUPABASE_ANON_KEY` | Supabase public key | (required) |
| `SUPABASE_JWT_SECRET` | JWT secret for HS256 | (required) |
| `SUPABASE_SERVICE_KEY` | Service role key (profile lookup) | (required) |
| `CLAUDE_CLI` | Path to Claude Code CLI binary | `~/.nvm/versions/node/v20.19.5/bin/claude` |

### Settings (in `config.py`)

| Setting | Value | Purpose |
|---------|-------|---------|
| `MAX_EDIT_SIZE` | 1 MB | Files larger than this are download-only |
| `MAX_UPLOAD_SIZE` | 50 MB | Per-file upload limit |
| `BINARY_CHECK_BYTES` | 8 KB | Bytes checked for null bytes to detect binary |
| `ADMIN_WORKSPACE_ROOT` | `/workspace/synced/opai` | Root directory for admin users |
| `PROTECTED_FILES` | `.opai-user.json`, `CLAUDE.md`, `config/sandbox.json` | Read-only for non-admins |
| `AI_TIMEOUT` | 120 seconds | Max time for a single Claude CLI invocation |
| `LINK_INDEX_MAX_FILES` | 5000 | Max files to index per user root |
| `CONTENT_SEARCH_MAX_RESULTS` | 100 | Max results for content search |

## API

### File Operations

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/files/list` | GET | User | List directory contents (`?path=relative/dir`) |
| `/api/files/read` | GET | User | Read text file for editing (`?path=relative/file`) |
| `/api/files/write` | POST | User | Save text file (JSON: `{path, content}`) — updates link index for .md |
| `/api/files/mkdir` | POST | User | Create directory (JSON: `{path}`) |
| `/api/files/delete` | POST | User | Delete file or empty directory (JSON: `{path}`) — removes from link index |
| `/api/files/rename` | POST | User | Rename/move within sandbox (JSON: `{path, new_path}`) — updates link index |
| `/api/files/upload` | POST | User | Upload file(s) via multipart (`?path=target_dir`) |
| `/api/files/download` | GET | User | Download file as binary (`?path=relative/file`) |
| `/api/files/info` | GET | User | File/directory metadata (`?path=relative`) |
| `/api/files/copy` | POST | User | Copy file or directory (JSON: `{source, dest}`) |
| `/api/files/search` | GET | User | Search filenames (`?q=query&path=search_root`) |
| `/api/files/search-content` | GET | User | Search file contents (`?q=query&path=search_root`) — returns matching lines with context |
| `/api/files/names` | GET | User | All indexed filenames for autocomplete |

### Link / Knowledge API

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/links/backlinks` | GET | User | Files linking TO a file (`?path=rel/file.md`) with context snippets |
| `/api/links/forward` | GET | User | Wikilinks FROM a file (`?path=rel/file.md`) with resolution status |
| `/api/links/resolve` | GET | User | Resolve wikilink name to file path (`?name=target`) |
| `/api/links/graph` | GET | User | Graph data (`?path=&scope=directory&depth=2`) — nodes + edges |
| `/api/links/rebuild` | POST | Admin | Force full index rebuild |

### AI Instruct

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/files/ai/plan` | POST | User | Generate AI plan (JSON: `{path, instruction}`) |
| `/api/files/ai/execute` | POST | User | Execute approved plan (JSON: `{plan_id}`) |

### Context Switching

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/files/contexts` | GET | User | List available file contexts (default + personal if admin with sandbox_path) |
| `/health` | GET | Public | Service health (status, uptime, memory) |

## Wikilink Index Engine (`links.py`)

The `LinkIndex` class provides an in-memory index of all `[[wikilink]]` references across markdown files.

### How It Works

```
1. Build: Scan all .md files under user root via rglob('*.md')
2. For each file:
   - Register filename stem (lowercase) in name_to_paths lookup
   - Extract all [[target]] and [[target|alias]] via regex
   - Store forward links (file → set of targets)
3. Resolution: wikilink name → exact stem match → path-based match
4. Backlinks: reverse lookup — scan all forward links for stem matches
```

### Key Methods

| Method | Purpose |
|--------|---------|
| `build(root)` | Full scan of all .md files — ~7s for 16k files |
| `update_file(root, rel_path)` | Re-index one file (called on write) |
| `remove_file(rel_path)` | Remove from index (called on delete/rename) |
| `resolve_wikilink(name)` | Name → file path (exact stem, then .md strip, then path match) |
| `get_backlinks(rel_path, root)` | Files linking TO this file, with context line snippets |
| `get_forward_links(rel_path)` | Files this file links TO, with resolution status |
| `get_graph_data(root, scope, center_path, depth)` | Nodes + edges for graph visualization |
| `search_content(root, query, search_path)` | Full-text search with matching line context |
| `get_all_filenames()` | All indexed filenames for autocomplete |

### Graph Data Generation

Three scopes for `get_graph_data`:

| Scope | Behavior |
|-------|----------|
| `directory` | Files in center directory + subdirectories down to `depth` levels. Creates folder nodes + containment edges + wikilink edges. |
| `local` | BFS from a specific file via wikilinks + backlinks, expanding `depth` hops. Includes sibling files. |
| `all` | Full directory tree + all wikilink edges (capped at 500 nodes). |

Node types: files (with link count) and directories (with `dir:` prefix).
Edge types: `contains` (folder → child) and `link` (wikilink reference).

## Knowledge Graph (`graph.js`)

Interactive visualization using **Cytoscape.js** (lazy-loaded from CDN).

### Radial Tree Layout

Uses a custom `computeRadialPositions()` algorithm instead of force-directed layout:

```
1. Build tree from containment edges (parent → children)
2. Find center node (is_center flag or root directory)
3. Count leaf descendants for proportional angular allocation
4. Place center at (0,0)
5. For each ring (depth level):
   - Distribute children within parent's angular slice
   - Slice width proportional to descendant count
   - Minimum arc-length per node (55px) prevents crowding
6. Ring gap: 220px between concentric rings
7. Orphan nodes placed in an outer ring
```

Result: guaranteed zero overlap, children visually grouped near their parent.

### Visual Design

| Element | Style |
|---------|-------|
| Folders | Rounded rectangles, colored by top-level group |
| Files | Circles, sized by link count (20–50px) |
| Center node | White border, larger, bold label |
| Containment edges | Dashed gray lines (parent → child) |
| Wikilink edges | Solid blue arrows (file → file) |
| Hover | Dims all nodes except the hovered node's neighborhood |

### Navbar Coexistence

The graph overlay (`z-index: 100000`) positions itself below the shared navbar (`z-index: 99999`) using `top: 44px` instead of `inset: 0`. The navbar remains visible and functional while the graph is open — no hide/show toggling needed.

### Interactions

- **Click folder** → re-renders graph centered on that folder
- **Click file** → opens file in editor panel (graph shrinks to left side)
- **Close editor** → graph expands back to full viewport
- **Filter input** → dims non-matching nodes
- **Depth selector** → 2, 3, 4 hops, or all files
- **Zoom-dependent labels** — labels hidden at low zoom levels

## Markdown Rendering (`markdown.js`)

Rich rendering via **markdown-it** with plugins:

| Feature | Implementation |
|---------|---------------|
| Syntax highlighting | highlight.js v11 (github-dark theme) |
| Math | KaTeX v0.16 — inline `$...$` and block `$$...$$` |
| Wikilinks | Custom inline rule → `<a class="wikilink" data-wikilink="target">` |
| Task lists | Checkbox rendering for `- [ ]` and `- [x]` |
| Callouts | Post-processing for `> [!NOTE]`, `> [!WARNING]`, etc. (16 types) |
| Mermaid diagrams | Lazy-loaded on first ` ```mermaid ` block detection |
| Tables | Standard markdown tables with striped rows |
| Fallback | Built-in regex renderer if CDN fails |

### Wikilink Rendering

`[[target]]` renders as a clickable link. `[[target|alias]]` shows the alias text. Click handler calls `/api/links/resolve` and navigates to the resolved file, or offers to create a new file if unresolved.

## Frontend Features

### Admin Context Switching
- **Context switch button** — admin-only toolbar button to toggle between "Server Workspace" (default) and "My Files" (personal NAS folder at `sandbox_path`)
- Sends `X-Files-Context: personal` header on all API calls when in personal mode
- Backend uses `contextvars.ContextVar` to avoid modifying all handler signatures
- Button shows folder icon (default) or home icon (personal) with green highlight
- `GET /api/files/contexts` returns available contexts and whether the personal directory exists
- Requires `sandbox_path` set in Supabase profiles (e.g., `/workspace/users/Dallas`)

### File Management
- **File list** — sortable table (name, size, modified) with directory-first ordering
- **Breadcrumb navigation** — click any segment to jump back; Backspace to go up
- **Text editor** — full textarea with tab support, Ctrl+S to save, modified indicator
- **Preview toggle** — markdown and JSON files get Edit/Preview button
- **Image preview** — inline display for PNG, JPG, GIF, SVG, WebP
- **Context menu** — right-click for Open, Download, Rename, Delete
- **Upload** — drag-and-drop overlay + toolbar button, multipart upload
- **Instruct AI** — Claude-powered file/folder operations with plan-then-execute workflow
- **TeamTask** — create a Team Hub task from the current file. Builds a concise, actionable description (headings + checkboxes for `.md` files, first comment block for code, blockquote for other text), uploads the file to Supabase Storage (`team-files` bucket), and registers it as an attachment on the created task. Uses `window._sbClient` (globally stored Supabase client).

### Knowledge Features
- **Markdown toolbar** — Bold, Italic, Strikethrough, H1/H2/H3, Link, Code, Wikilink, Lists, Tasks (shown for .md files in edit mode)
- **Wikilink autocomplete** — typing `[[` triggers a dropdown of matching filenames from the index
- **Backlinks panel** — collapsible panel below editor showing files that reference the current file, with context line snippets
- **Knowledge graph** — full-viewport radial graph with folder/file nodes, containment + wikilink edges, depth control, filter, hover highlight
- **Content search** — toggle between filename and content search modes; content results show matching lines
- **Quick switcher** — Ctrl+O opens instant filename search modal (like Obsidian's Quick Open)

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+S | Save file |
| Ctrl+O | Quick switcher |
| Ctrl+B | Bold (in editor) |
| Ctrl+I | Italic (in editor) |
| Backspace | Go up one directory |
| Esc | Close editor / close graph |
| Arrow keys | Navigate wikilink autocomplete / quick switcher results |

## Security Model

1. **Server-side root resolution** — `_get_user_root()` determines the filesystem root from the authenticated user's role and profile, never from client input
2. **Path traversal prevention** — `_resolve_safe_path()` uses `Path.resolve()` + `str.startswith()` to ensure the resolved path stays within the user's root
3. **No symlink escape** — `resolve()` follows symlinks before the containment check
4. **Protected files** — certain system files are viewable but not editable/deletable by non-admin users
5. **Binary detection** — first 8KB checked for null bytes; binary files get download-only treatment
6. **No shell commands** — all direct file ops via Python `os`/`pathlib`/`aiofiles`, no subprocess calls
7. **AI isolation** — Claude invocations are prompt-constrained to only file/folder operations within the user's root; `--allowedTools` pre-approves Read, Write, Edit, Bash, Glob, Grep; `CLAUDECODE` env var stripped; plans auto-expire after 30 minutes; 120-second timeout per invocation

## CDN Dependencies

| Library | Version | Size | Purpose | Loading |
|---------|---------|------|---------|---------|
| markdown-it | 14.x | ~60KB | Markdown parser | Eager (page load) |
| highlight.js | 11.x | ~40KB | Code syntax highlighting | Eager |
| KaTeX | 0.16.x | ~250KB | Math rendering | Eager |
| Cytoscape.js | 3.x | ~380KB | Graph visualization | Lazy (on graph open) |
| Mermaid | 11.x | ~800KB | Diagram rendering | Lazy (on first mermaid block) |
| Supabase JS | 2.x | ~40KB | Auth client | Eager |

## How to Use

```bash
# Service management
systemctl --user status opai-files
systemctl --user restart opai-files
journalctl --user -u opai-files -f

# Test health
curl http://127.0.0.1:8086/health

# Access via browser
# https://opai-server/files/
```

## Dependencies

- **Reads**: User `sandbox_path` from Supabase `profiles` table (via shared auth)
- **Reads**: Filesystem at `/workspace/users/<Name>/` (users) or `/workspace/synced/opai` (admin)
- **Python deps**: fastapi, uvicorn, python-dotenv, aiofiles, python-multipart
- **Frontend deps**: Supabase JS v2, markdown-it, highlight.js, KaTeX, Cytoscape.js, mermaid (all CDN)
- **Fonts**: Inter + JetBrains Mono (Google Fonts CDN)
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-files` service, port 8086)
- **Proxied by**: Caddy at `/files/*` (see [Auth & Network](auth-network.md))
- **Portal tile**: [Portal](portal.md) — "My Files" (user) / "OPAI Files" (admin) dashboard card with health dot
- **Health monitored by**: [Monitor](monitor.md) (`files` in health summary)
