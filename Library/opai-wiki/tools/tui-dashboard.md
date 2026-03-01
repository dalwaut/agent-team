# OPAI TUI Dashboard

Terminal-based admin dashboard built with [Textual](https://textual.textualize.io/) (Python TUI framework). Provides live Claude usage monitoring, system resource gauges, and a process task manager with kill capability — all from any terminal session.

**Port**: N/A (local terminal app, not a web service)
**Directory**: `tools/opai-tui/`
**Framework**: Textual 8.x (Python)
**Dependencies**: `textual`, `httpx`, `psutil`

---

## Overview

The TUI is a lightweight alternative to the web-based Monitor (`/monitor/`) for quick terminal checks. It runs entirely locally — no server, no port, no auth. Useful for SSH sessions, tmux panes, or quick glances without opening a browser.

```
┌────────────────────────────────────────────────────────────┐
│  OPAI Dashboard — Claude Usage · System · Tasks            │
├──────────┬──────────┬──────────────────────────────────────┤
│ Claude   │ System   │ Task Manager                         │
│ Usage    │          │                                      │
├──────────┴──────────┴──────────────────────────────────────┤
│  Tab 1: Plan usage bars + Claude process list              │
│  Tab 2: CPU / Memory / Swap / Disk / Network / Uptime      │
│  Tab 3: Top processes table + kill action + log            │
├────────────────────────────────────────────────────────────┤
│  q Quit  r Refresh  k Kill Process         Last: 14:32:07 │
└────────────────────────────────────────────────────────────┘
```

---

## Key Files

| File | Purpose |
|------|---------|
| `tools/opai-tui/app.py` | Main application — all widgets, data fetchers, and TUI logic |
| `tools/opai-tui/launch.sh` | Convenience launcher script |

---

## Architecture

### Framework: Textual

Textual is a Python TUI framework by Textualize (makers of Rich). It provides CSS-styled widget trees, async event handling, reactive data binding, and 40+ built-in widgets. The OPAI TUI uses:

- **`TabbedContent`** — 3-tab layout
- **`Static` subclasses** — Custom widgets with `reactive` properties that auto-re-render on data change
- **`DataTable`** — Sortable process table with row cursor for kill selection
- **`RichLog`** — Scrolling action log for kill results
- **`@work(thread=True)`** — Background workers for non-blocking data fetching
- **Inline TCSS** — CSS-like styling for layout, borders, colors

### Data Flow

```
Timer intervals ──→ @work(thread=True) fetchers ──→ call_from_thread() ──→ reactive property update ──→ auto re-render
     │                      │
     │                      ├── fetch_plan_usage()    → Anthropic OAuth API (15s)
     │                      ├── fetch_system_stats()  → psutil (5s)
     │                      ├── fetch_processes()     → psutil process list (5s)
     │                      └── claude proc scanner   → psutil + classification (on refresh)
     │
     └── set_interval() on mount
```

All I/O runs in thread workers to keep the UI responsive. Results are marshalled back to the main thread via `call_from_thread()`.

---

## Tabs

### Tab 1: Claude Usage

Fetches live plan usage from the Anthropic OAuth API (same endpoint as the web Monitor).

**Displays**:
- **Session (5h)** — Rolling 5-hour utilization with colored progress bar and time-until-reset
- **Week (all models)** — 7-day aggregate utilization
- **Week (Sonnet)** — Sonnet-specific 7-day limit
- **Week (Opus)** — Opus-specific 7-day limit (shown if available)
- **Extra Usage** — Pay-per-use overages: `$used / $limit` with percentage bar
- **Threshold alert** — Color-coded status matching the usage throttling rules:

| Session % | Alert | Meaning |
|-----------|-------|---------|
| < 50% | Green: Normal operations | All tasks can run freely |
| 50-70% | Yellow: CAUTION | Prefer Sonnet for automated tasks |
| 70-85% | Yellow bold: THROTTLE | Defer non-urgent system tasks |
| > 85% | Red bold: CRITICAL | Queue ALL automated tasks |

**Claude Process List** — Scans `psutil` for running `claude`/`claude-code` processes, classifies each:

| Type | Icon | Detection |
|------|------|-----------|
| interactive | keyboard | No `-p`/`--print` flag |
| automated | gear | `-p` flag, no specific context match |
| automated-agent | robot | `-p` flag + "squad" or "agent" in cmdline |
| discord-bot | chat | `-p` flag + "discord" in cwd/cmdline |
| feedback-fixer | wrench | `-p` flag + "feedback" in cmdline |

Shows PID, type, uptime in minutes, and shortened working directory.

**Refresh**: Every 15 seconds (matches the OAuth API cache TTL).

### Tab 2: System

Reads system metrics via `psutil` and `os.getloadavg()`.

**Displays**:
- **CPU** — Percent utilization with core count
- **Load** — 1/5/15 minute load averages
- **Memory** — Used / total with percent bar
- **Swap** — Used / total with percent bar
- **Disk /** — Used / total with percent bar
- **Network** — Cumulative bytes sent (up arrow) and received (down arrow)
- **Uptime** — Days, hours, minutes since boot

All bars are color-coded: green (< 50%), yellow (50-85%), red (> 85%).

**Refresh**: Every 5 seconds.

### Tab 3: Task Manager

Full process table (top 80 by CPU usage) with interactive kill capability.

**Table columns**: PID, Name, User, CPU%, Mem%, Status, Command

**Status coloring**: `running` = green, `sleeping`/`idle` = dim, `zombie`/`dead` = red.

**Kill flow**:
1. Navigate to the target process row with arrow keys
2. Press `k`
3. Sends `SIGTERM` → waits 3 seconds → escalates to `SIGKILL` if still alive
4. Result logged in the action log panel below the table
5. Table auto-refreshes after kill

**Action log**: Timestamped entries for kill results, errors, access denied messages.

**Refresh**: Every 5 seconds.

---

## Keyboard Controls

| Key | Action | Context |
|-----|--------|---------|
| `q` | Quit | Global |
| `r` | Force refresh all data | Global |
| `k` | Kill selected process | Task Manager tab only |
| `1` | Switch to Claude Usage tab | Global |
| `2` | Switch to System tab | Global |
| `3` | Switch to Task Manager tab | Global |
| Arrow keys | Navigate table rows | Task Manager tab |
| Tab | Cycle between tabs | Global (Textual built-in) |

---

## How to Use

### Launch

```bash
# From anywhere
python3 /workspace/synced/opai/tools/opai-tui/app.py

# Via launcher script
./tools/opai-tui/launch.sh

# With Textual dev console (for debugging)
textual run --dev tools/opai-tui/app.py
```

### Requirements

| Package | Version | Purpose |
|---------|---------|---------|
| `textual` | 8.x | TUI framework |
| `httpx` | any | HTTP client for Anthropic API |
| `psutil` | 5.x+ | System metrics and process management |

Install: `pip install textual httpx psutil`

### OAuth Token

The usage panel reads the OAuth token from `~/.claude/.credentials.json` (same credential file Claude Code uses). No additional configuration needed if Claude Code is logged in.

---

## Configuration

No config files. All behavior is hardcoded for simplicity:

| Setting | Value | Location |
|---------|-------|----------|
| Usage poll interval | 15s | `set_interval(15, self.refresh_usage)` |
| System poll interval | 5s | `set_interval(5, self.refresh_system)` |
| Process poll interval | 5s | `set_interval(5, self.refresh_processes)` |
| Max processes shown | 80 | `fetch_processes()` return slice |
| Kill timeout (TERM→KILL) | 3s | `psutil.wait_procs([proc], timeout=3)` |
| Usage API | Anthropic OAuth | `https://api.anthropic.com/api/oauth/usage` |

---

## Relationship to Other Tools

| Tool | Relationship |
|------|-------------|
| **Monitor** (`/monitor/`) | Web-based equivalent with more panels. TUI is for quick terminal checks. |
| **session_collector.py** | Monitor's backend fetcher. TUI reimplements the same logic standalone (no server dependency). |
| **Usage Throttling** | TUI displays the same threshold alerts defined in the throttling rules. |
| **opai-control.sh** | Service manager. TUI shows system state; opai-control manages services. |

---

## Textual Framework Reference

For building additional TUI tools or extending this one, see `Library/OPAI-Reusable/tui-frameworks.md` — comprehensive guide covering Textual, Bubble Tea (Go), Ratatui (Rust), Ink (JS), and 10+ other frameworks with decision matrices.

Key Textual patterns used in this app:
- **`reactive` properties** — Trigger re-render when data changes (`usage_data`, `sys_data`, `proc_data`)
- **`@work(thread=True)`** — Run I/O in background threads without blocking the event loop
- **`call_from_thread()`** — Marshal results back to the main thread for safe widget updates
- **`set_interval()`** — Timer-based auto-refresh
- **Inline `CSS`** — TCSS styling embedded in the App class
- **`compose()` with context managers** — Declarative widget tree using `with` blocks
