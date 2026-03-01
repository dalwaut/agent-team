# TUI Frameworks — Reference Guide

> Terminal User Interface frameworks for building interactive terminal applications.
> Last updated: 2026-02-23

---

## Quick Decision Matrix

| Language | Primary Pick | Alternative | Low-Level |
|----------|-------------|-------------|-----------|
| **Python** | Textual (full TUI) / Rich (output only) | urwid, pytermgui, prompt_toolkit | `curses` (stdlib) |
| **Go** | Bubble Tea (Elm arch) / tview (widgets) | lipgloss (styling only) | tcell |
| **Rust** | Ratatui (immediate mode) | Cursive (retained/widget mode) | crossterm |
| **JS/TS** | Ink (React model) | blessed (legacy) | raw ANSI |
| **C** | ncurses | notcurses (modern) | raw termios |
| **C++** | FTXUI | ncurses (C API) | raw termios |
| **Java/JVM** | Lanterna | -- | JLine |
| **Swift** | OpenTUI | -- | POSIX APIs |

### By Project Type

| Need | Best Fit |
|------|----------|
| Pretty CLI output (tables, colors, progress) | Rich (Py), Lip Gloss (Go), colored (Rust) |
| Interactive prompts (select, confirm) | prompt_toolkit (Py), huh (Go), dialoguer (Rust), Inquirer (JS) |
| REPL / Shell | prompt_toolkit (Py), liner (Go), rustyline (Rust) |
| Dashboard / status screen | tview (Go), blessed-contrib (JS), Textual (Py) |
| Multi-view app (tabs, forms) | Textual (Py), Bubble Tea (Go), Ratatui (Rust), Ink (JS) |
| SSH-served TUI | Bubble Tea + Wish (Go), Lanterna (Java) |
| Web-deployed TUI | Textual + textual-serve (Py), FTXUI + WASM (C++) |
| Max performance | ncurses (C), Ratatui (Rust), FTXUI (C++) |

---

## The Big Three

### 1. Textual (Python) — "React of the Terminal"

| Fact | Value |
|------|-------|
| Maker | Textualize (Will McGuigan, Edinburgh) |
| License | MIT |
| Stars | ~27k |
| Install | `pip install textual` (+ `pip install textual-dev` for devtools) |
| Python | 3.9+ |
| Version | 6.x (stable, rapid iteration) |

**Architecture**: CSS-styled widget tree (DOM-like). Async event system on `asyncio`. Declarative `compose()` yields widgets. Screens stack. Messages bubble up. Reactive descriptors auto-trigger watchers.

**Key concepts**:
- `App` > `Screen` > Widget tree (DOM hierarchy)
- `.tcss` files for styling (selectors, flexbox/grid layout, transitions, animations)
- `compose()` — declarative widget yielding
- `on_<event>()` handlers — messages bubble up the tree
- `reactive()` descriptors — data binding with `watch_*()` callbacks
- `Worker` — background tasks without blocking UI
- `BINDINGS` — keyboard shortcut → action mapping
- Command palette (Ctrl+P) built-in

**40+ built-in widgets**: Header, Footer, Button, Input, TextArea, DataTable, Tree, DirectoryTree, TabbedContent, Markdown, RichLog, ProgressBar, Select, Switch, Checkbox, RadioButton, and more.

**Dev tools**: CSS live reload (`textual run --dev`), dev console (`textual console`), headless test pilot (`app.run_test()`), SVG export.

**Ecosystem**: Rich (rendering engine, 55k stars), textual-web/textual-serve (browser deployment), Trogon (auto-TUI for Click CLIs), Harlequin (SQL IDE), Posting (API client).

**When to use**: Full interactive terminal apps, dashboards, admin panels, dev tools. Web-like dev experience. Potential browser deployment.
**When NOT to use**: Simple CLIs (use Click/Typer), just pretty output (use Rich), minimal environments.

**Example pattern**:
```python
from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, Static, Button

class MyApp(App):
    CSS = """
    Screen { align: center middle; }
    #greeting { width: 40; border: solid green; }
    """
    BINDINGS = [("q", "quit", "Quit")]

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Hello!", id="greeting")
        yield Button("OK", variant="primary")
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.query_one("#greeting").update("Clicked!")

if __name__ == "__main__":
    MyApp().run()
```

---

### 2. Bubble Tea (Go) — Elm Architecture for Terminals

| Fact | Value |
|------|-------|
| Maker | Charm / Charmbracelet (Toby Padilla, Christian Rocha) |
| License | MIT |
| Stars | ~40k |
| Install | `go get github.com/charmbracelet/bubbletea` |
| Version | v1.x stable, **v2 beta** |

**Architecture**: The Elm Architecture (TEA) — Model/Update/View. Functional, unidirectional data flow. Commands run async I/O in goroutines, returning messages. Framerate-based renderer batches updates.

**Key concepts**:
- `Model` struct — entire app state
- `Init()` → initial command
- `Update(msg) → (Model, Cmd)` — handle messages, return new state + side effects
- `View() → string` — pure render function (string IS the UI)
- `tea.Cmd` — async I/O functions returning `tea.Msg`
- `tea.Batch()` / `tea.Sequence()` — concurrent/ordered commands
- Composable: nest models, route messages parent→child

**Charm ecosystem** (massive):
| Library | Purpose |
|---------|---------|
| **Bubbles** (7.8k stars) | Pre-built components (spinner, text input, list, table, viewport, paginator, etc.) |
| **Lip Gloss** (10.6k stars) | CSS-like terminal styling (colors, borders, padding, alignment) |
| **Huh** (6.6k stars) | Interactive forms (input, select, multiselect, confirm). Standalone or embedded in Bubble Tea |
| **Wish** | Serve Bubble Tea apps over SSH (each connection = isolated session) |
| **Glamour** | Stylesheet-based markdown rendering |
| **Glow** | Terminal markdown reader |
| **Soft Serve** | Self-hosted Git server with SSH TUI |
| **VHS** | Terminal recording to GIF from `.tape` scripts |
| **Freeze** (4.4k) | Generate images of code/terminal output |
| **Crush** (20k) | Agentic coding tool |
| **Fantasy** | AI agent framework in Go |

**When to use**: Complex interactive TUIs, SSH-served apps, composable component architectures. Go is your language.
**When NOT to use**: Simple flag-parsing CLIs (use cobra), quick forms only (use huh standalone), standard widget layouts (tview is faster to prototype).

**v2 changes**: Init returns `(Model, Cmd)`, declarative View return type, tighter Lip Gloss integration, progressive keyboard enhancements.

**Example pattern**:
```go
type model struct {
    cursor   int
    choices  []string
    selected map[int]struct{}
}

func (m model) Init() tea.Cmd { return nil }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
    switch msg := msg.(type) {
    case tea.KeyMsg:
        switch msg.String() {
        case "q":      return m, tea.Quit
        case "up":     m.cursor--
        case "down":   m.cursor++
        case "enter":  m.selected[m.cursor] = struct{}{}
        }
    }
    return m, nil
}

func (m model) View() string {
    s := "Pick items:\n\n"
    for i, c := range m.choices {
        cursor, checked := " ", " "
        if m.cursor == i { cursor = ">" }
        if _, ok := m.selected[i]; ok { checked = "x" }
        s += fmt.Sprintf("%s [%s] %s\n", cursor, checked, c)
    }
    return s + "\nq to quit.\n"
}
```

---

### 3. Ratatui (Rust) — Immediate Mode Rendering

| Fact | Value |
|------|-------|
| Origin | Community fork of tui-rs (Jan 2023) |
| License | MIT |
| Stars | ~10k+ |
| Install | `ratatui = "0.29"` + `crossterm = "0.28"` |
| Version | 0.29.x (pre-1.0 but production-quality) |

**Architecture**: Immediate mode — redraw entire UI from state every frame. Framework diffs at cell-buffer level, writes only changed cells. You own the event loop. Backend-agnostic via `Backend` trait.

**Key concepts**:
- `Terminal<B: Backend>` — wraps backend, double-buffered cell grid
- `terminal.draw(|frame| { ... })` — render closure called each frame
- `Widget` trait: `fn render(self, area: Rect, buf: &mut Buffer)` — widgets are ephemeral, consumed on render
- `StatefulWidget` — for widgets needing mutable external state (scroll position, selection)
- `Layout` — constraint-based splitting (Length, Min, Max, Percentage, Ratio, Fill)
- `Rect` — all positioning via `{x, y, width, height}`
- `Style` — fg, bg, modifiers (bold, italic, etc.)
- `Span` → `Line` → `Text` — rich text model

**Backends**: crossterm (default, cross-platform), termion (Unix-only, lighter), termwiz (WezTerm ecosystem), TestBackend (in-memory for tests).

**Built-in widgets**: Paragraph, Block (borders/titles), List, Table, Tabs, Gauge, LineGauge, BarChart, Sparkline, Chart (XY), Canvas (freeform), Calendar, Scrollbar, Clear.

**No built-in**: text input, dropdown, checkbox (use community crates: `tui-input`, `tui-textarea`, `tui-scrollview`, `tui-popup`, `tui-tree-widget`).

**Community crates**: `ratatui-image` (sixel/kitty images), `tui-logger`, `tui-big-text`, `color-eyre` (panic recovery).

**Notable apps**: gitui, bottom (btm), bandwhich, spotify-tui, taskwarrior-tui, oxker.

**When to use**: Performance-critical TUIs, data dashboards, monitoring tools. Maximum rendering control. Rust ecosystem.
**When NOT to use**: Form-heavy apps (Cursive is better), need built-in input widgets, want a full framework (Ratatui is a rendering library — you build the rest).

**Typical project structure**:
```
src/
  main.rs   — terminal setup/teardown, run loop
  app.rs    — App struct (state) + update logic
  ui.rs     — rendering functions (fn ui(frame, &app))
  event.rs  — event handling (optional: async via tokio)
```

**Example pattern**:
```rust
loop {
    terminal.draw(|frame| {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(0)])
            .split(frame.area());
        let block = Block::default().title("App").borders(Borders::ALL);
        let para = Paragraph::new(format!("Count: {}", app.count)).block(block);
        frame.render_widget(para, chunks[0]);
    })?;
    if let Event::Key(key) = event::read()? {
        match key.code {
            KeyCode::Char('q') => break,
            KeyCode::Up => app.count += 1,
            _ => {}
        }
    }
}
```

---

## Other Notable Frameworks

### Ink (JavaScript/TypeScript) — React for CLI

| Fact | Value |
|------|-------|
| Stars | ~27k |
| Install | `npm install ink react` |
| Architecture | React components → Ink reconciler → Yoga (flexbox) → ANSI output |

Full React: hooks, context, JSX. Flexbox layout via Yoga. Testing via `ink-testing-library`. Used by Gatsby CLI, Prisma, Tap. Rich component ecosystem (`ink-text-input`, `ink-select-input`, `ink-spinner`, `ink-table`). Best JS TUI option for new projects.

### tview (Go) — Widget Toolkit

| Fact | Value |
|------|-------|
| Stars | ~10.5k |
| Install | `go get github.com/rivo/tview` |
| Built on | tcell |

20+ pre-built widgets (Form, InputField, DropDown, Table, TreeView, Modal, Pages). Flex/Grid layout. Less boilerplate than Bubble Tea for standard UIs. Choose for quick prototyping, forms, dashboards. Less composable/customizable than Bubble Tea.

### FTXUI (C++) — Functional TUI

| Fact | Value |
|------|-------|
| Stars | ~9k |
| Architecture | 3 layers: screen (low-level), dom (declarative elements), component (interactive) |
| Unique | **WASM/browser deployment** via Emscripten |

Modern C++17, zero dependencies. Declarative: `vbox({text("Hello"), separator(), hbox({...})})`. Flexbox layout. Canvas with Braille sub-cell resolution. Animation support. Only TUI that compiles to WebAssembly.

### Cursive (Rust) — Retained Mode

| Fact | Value |
|------|-------|
| Stars | ~4k |
| Architecture | Widget tree + callbacks (like GTK/Qt for terminal) |

Multiple backends (ncurses, crossterm, termion). Stack-based layer system (push/pop dialogs). Rich built-in views (Dialog, EditView, SelectView, ListView, ScrollView). Choose over Ratatui when you want a traditional widget toolkit feel with less boilerplate for forms/dialogs.

### ncurses (C) — The Foundation

Since 1993. Every other framework either wraps it, reimplements it, or was inspired by it. Low-level cell-based rendering. Panels, forms, menus libraries. Maximum performance. Maximum portability. Use for C/C++ system tools or when building your own framework.

### urwid (Python) — Classic

Since 2004. Widget-based + signal/callback system. UTF-8, wide chars, RTL text. Web display mode. Asyncio integration. Mature but dated compared to Textual. Used by Debian installer, `pudb` debugger.

### prompt_toolkit (Python) — REPL King

Powers IPython, pgcli, mycli, aws-shell. World-class line editing, auto-completion, syntax highlighting. Full-screen mode available but secondary. Choose for REPLs and shells, not general TUIs.

### Lanterna (Java) — JVM Option

3-layer: Terminal → Screen → GUI (Swing-like). WindowBasedTextGUI with overlapping windows. Built-in SSH/Telnet serving. Only real JVM TUI option.

### blessed / neo-blessed (JS) — Legacy

40+ widgets, mouse support, image rendering. **Effectively abandoned** (blessed: ~2015, neo-blessed: sporadic). Use Ink instead for new projects.

### blessed-contrib (JS) — Dashboard Widgets

Built on blessed. Charts (line, bar, stacked), maps (GeoJSON), gauges, sparklines using Braille characters. Dashboard-specific. Legacy/unmaintained.

### pytermgui (Python) — Lightweight

TIM markup (`[bold red]Hello`), YAML theming, SVG export. Lighter than Textual. Smaller community.

### notcurses (C) — Modern ncurses

By Nick Black. TrueColor, multimedia (images, video in terminal), sixel, Braille, pixel rendering. More capable than ncurses but less portable.

### Rich (Python) — Output Library (Not TUI)

50k+ stars. Beautiful terminal output: tables, trees, syntax highlighting, progress bars, Markdown, logging. Foundation for Textual. Not interactive — no event loop, no input handling. Use when you need pretty output, not a TUI.

---

## Architecture Patterns

### Immediate Mode (Ratatui, FTXUI dom layer)
Redraw everything every frame from state. Framework diffs at buffer level. You own the event loop. Maximum control, more boilerplate.

### Elm Architecture (Bubble Tea)
Model → Update(msg) → (Model, Cmd) → View(Model) → string. Functional, unidirectional. Clean separation. Messages route through a single point.

### Retained Mode / Widget Tree (Textual, Cursive, tview, Lanterna, blessed)
Build a widget tree, framework manages updates. Event callbacks or message bubbling. Less boilerplate for standard UIs. Less control for custom rendering.

### React/Component Model (Ink)
JSX components, hooks, reconciler, virtual DOM diffing. Familiar to web devs. Flexbox layout. Full React ecosystem patterns.

---

## Performance Tiers

| Tier | Frameworks | Use Case |
|------|-----------|----------|
| **Native speed** | ncurses, notcurses, Ratatui, FTXUI | High-frequency dashboards, system monitors, real-time data |
| **Compiled, good perf** | Bubble Tea, tview, Cursive | Interactive apps, SSH-served TUIs |
| **Interpreted, acceptable** | Textual, Ink, prompt_toolkit | Dev tools, admin panels, data explorers |
| **Interpreted, heavier** | blessed, urwid, pytermgui | Simple dashboards, config UIs |

---

## Capability Matrix

| Capability | Textual | Bubble Tea | Ratatui | Ink | tview | FTXUI | Cursive |
|-----------|---------|-----------|---------|-----|-------|-------|---------|
| Mouse support | Yes | Yes | Manual | Limited | Yes | Yes | Yes |
| Built-in widgets | 40+ | Minimal (use Bubbles) | 15+ (no input) | Via packages | 20+ | 15+ | 15+ |
| CSS/styled layout | TCSS | Lip Gloss | Manual | Flexbox (Yoga) | Flex/Grid | Flexbox-like | Themes |
| SSH serving | No (web instead) | Yes (Wish) | No | No | No | No | No |
| Web serving | Yes (textual-serve) | No | No | No | No | Yes (WASM) | No |
| Testing framework | Built-in (pilot) | teatest | TestBackend | ink-testing-library | No | No | No |
| Async | Native (asyncio) | Goroutines/Cmds | You provide | React hooks | Goroutines | Threading | Callbacks |
| Hot reload CSS | Yes | No | No | No | No | No | No |

---

## OPAI Relevance

For OPAI tools, the most relevant frameworks would be:

- **Textual** (Python) — Most OPAI server tools are Python (FastAPI). A Textual TUI could provide terminal-based admin interfaces, monitoring dashboards, or agent control panels. `textual-serve` could even expose them via web.
- **Bubble Tea** (Go) — If building standalone CLI tools or SSH-accessible TUI apps.
- **Ink** (JS/TS) — Could be relevant for Node.js-based tools (discord-bridge, orchestrator, email-agent).
- **Ratatui** (Rust) — For performance-critical monitoring/visualization tools if ever building in Rust.

The SCC IDE (Electron + React) is a GUI app, not a TUI. But TUI frameworks could complement it for server-side terminal interfaces or lightweight admin tools that don't need a browser.
