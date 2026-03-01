#!/usr/bin/env python3
"""OPAI TUI — Terminal dashboard: Claude usage, system monitor, task manager."""

import json
import os
import signal
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import psutil
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.reactive import reactive
from textual.widgets import (
    DataTable,
    Footer,
    Header,
    Label,
    ProgressBar,
    RichLog,
    Static,
    TabbedContent,
    TabPane,
)

# ── Paths & Constants ────────────────────────────────────────

CLAUDE_HOME = Path.home() / ".claude"
CREDENTIALS_FILE = CLAUDE_HOME / ".credentials.json"
PLAN_USAGE_API = "https://api.anthropic.com/api/oauth/usage"


# ── Data Fetchers ────────────────────────────────────────────

def get_oauth_token() -> str | None:
    try:
        data = json.loads(CREDENTIALS_FILE.read_text())
        return data.get("claudeAiOauth", {}).get("accessToken")
    except Exception:
        return None


def fetch_plan_usage() -> dict:
    token = get_oauth_token()
    if not token:
        return {"error": "No OAuth token"}
    try:
        resp = httpx.get(
            PLAN_USAGE_API,
            headers={
                "Authorization": f"Bearer {token}",
                "anthropic-beta": "oauth-2025-04-20",
                "Content-Type": "application/json",
            },
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def fetch_system_stats() -> dict:
    cpu = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    net = psutil.net_io_counters()
    load1, load5, load15 = os.getloadavg()
    uptime_s = time.time() - psutil.boot_time()
    days = int(uptime_s // 86400)
    hours = int((uptime_s % 86400) // 3600)
    mins = int((uptime_s % 3600) // 60)
    return {
        "cpu_percent": cpu,
        "cpu_count": psutil.cpu_count(),
        "load": (load1, load5, load15),
        "mem_total": mem.total,
        "mem_used": mem.used,
        "mem_percent": mem.percent,
        "swap_total": psutil.swap_memory().total,
        "swap_used": psutil.swap_memory().used,
        "swap_percent": psutil.swap_memory().percent,
        "disk_total": disk.total,
        "disk_used": disk.used,
        "disk_percent": disk.percent,
        "net_sent": net.bytes_sent,
        "net_recv": net.bytes_recv,
        "uptime": f"{days}d {hours}h {mins}m",
    }


def fetch_processes() -> list[dict]:
    procs = []
    for p in psutil.process_iter(["pid", "name", "username", "cpu_percent", "memory_percent", "status", "create_time", "cmdline"]):
        try:
            info = p.info
            procs.append({
                "pid": info["pid"],
                "name": info["name"] or "?",
                "user": (info.get("username") or "?")[:12],
                "cpu": info.get("cpu_percent") or 0.0,
                "mem": info.get("memory_percent") or 0.0,
                "status": info.get("status") or "?",
                "cmdline": " ".join(info.get("cmdline") or [])[:120],
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    procs.sort(key=lambda x: x["cpu"], reverse=True)
    return procs[:80]


# ── Formatting helpers ───────────────────────────────────────

def fmt_bytes(b: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(b) < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} PB"


def bar_text(pct: float, width: int = 20) -> str:
    filled = int(pct / 100 * width)
    empty = width - filled
    if pct >= 85:
        color = "red"
    elif pct >= 50:
        color = "yellow"
    else:
        color = "green"
    return f"[{color}]{'█' * filled}{'░' * empty}[/] {pct:.1f}%"


def time_until(iso_ts: str | None) -> str:
    if not iso_ts:
        return "?"
    try:
        reset = datetime.fromisoformat(iso_ts)
        if reset.tzinfo is None:
            reset = reset.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        delta = reset - now
        if delta.total_seconds() <= 0:
            return "now"
        hours = int(delta.total_seconds() // 3600)
        mins = int((delta.total_seconds() % 3600) // 60)
        if hours > 24:
            days = hours // 24
            return f"{days}d {hours % 24}h"
        return f"{hours}h {mins}m"
    except Exception:
        return "?"


# ── Widgets ──────────────────────────────────────────────────

class UsagePanel(Static):
    """Claude plan usage display with progress bars."""

    usage_data: reactive[dict] = reactive({})

    def render(self) -> str:
        d = self.usage_data
        if not d:
            return "[dim]Loading usage data...[/]"
        if "error" in d:
            return f"[red]Error: {d['error']}[/]"

        lines = ["[bold cyan]Claude Plan Usage[/]\n"]

        five = d.get("five_hour")
        if five:
            pct = five.get("utilization", 0)
            lines.append(f"  Session (5h)  {bar_text(pct)}  resets {time_until(five.get('resets_at'))}")

        seven = d.get("seven_day")
        if seven:
            pct = seven.get("utilization", 0)
            lines.append(f"  Week (all)    {bar_text(pct)}  resets {time_until(seven.get('resets_at'))}")

        sonnet = d.get("seven_day_sonnet")
        if sonnet:
            pct = sonnet.get("utilization", 0)
            lines.append(f"  Week (Sonnet) {bar_text(pct)}  resets {time_until(sonnet.get('resets_at'))}")

        opus = d.get("seven_day_opus")
        if opus:
            pct = opus.get("utilization", 0)
            lines.append(f"  Week (Opus)   {bar_text(pct)}  resets {time_until(opus.get('resets_at'))}")

        extra = d.get("extra_usage")
        if extra and extra.get("is_enabled"):
            used = extra.get("used_credits", 0) / 100
            limit = extra.get("monthly_limit", 0) / 100
            pct = extra.get("utilization", 0)
            lines.append(f"\n  [bold]Extra Usage[/]   {bar_text(pct)}  ${used:.2f} / ${limit:.2f}")

        # Threshold indicator
        session_pct = (five or {}).get("utilization", 0)
        if session_pct >= 85:
            lines.append("\n  [bold red]CRITICAL — Queue all automated tasks[/]")
        elif session_pct >= 70:
            lines.append("\n  [bold yellow]THROTTLE — Defer non-urgent system tasks[/]")
        elif session_pct >= 50:
            lines.append("\n  [yellow]CAUTION — Prefer Sonnet for automated tasks[/]")
        else:
            lines.append("\n  [green]Normal operations[/]")

        return "\n".join(lines)


class SystemPanel(Static):
    """System resource display."""

    sys_data: reactive[dict] = reactive({})

    def render(self) -> str:
        d = self.sys_data
        if not d:
            return "[dim]Loading system data...[/]"

        load1, load5, load15 = d.get("load", (0, 0, 0))
        lines = [
            "[bold cyan]System Resources[/]\n",
            f"  CPU       {bar_text(d['cpu_percent'])}  {d['cpu_count']} cores",
            f"  Load      {load1:.2f} / {load5:.2f} / {load15:.2f}  (1/5/15 min)",
            f"  Memory    {bar_text(d['mem_percent'])}  {fmt_bytes(d['mem_used'])} / {fmt_bytes(d['mem_total'])}",
            f"  Swap      {bar_text(d['swap_percent'])}  {fmt_bytes(d['swap_used'])} / {fmt_bytes(d['swap_total'])}",
            f"  Disk /    {bar_text(d['disk_percent'])}  {fmt_bytes(d['disk_used'])} / {fmt_bytes(d['disk_total'])}",
            f"  Network   [cyan]▲[/] {fmt_bytes(d['net_sent'])}  [green]▼[/] {fmt_bytes(d['net_recv'])}",
            f"  Uptime    {d['uptime']}",
        ]
        return "\n".join(lines)


class ClaudeProcessPanel(Static):
    """Shows running Claude processes."""

    proc_data: reactive[list] = reactive([])

    def render(self) -> str:
        procs = self.proc_data
        if not procs:
            return "[dim]No Claude processes detected[/]"

        lines = [f"[bold cyan]Claude Processes[/]  ({len(procs)} active)\n"]
        for p in procs:
            uptime_m = p.get("uptime_seconds", 0) // 60
            ptype = p.get("type", "?")
            pid = p["pid"]
            cwd_short = p.get("cwd", "")
            if "/workspace/synced/opai/" in cwd_short:
                cwd_short = cwd_short.replace("/workspace/synced/opai/", "~/")
            cwd_short = cwd_short[-40:] if len(cwd_short) > 40 else cwd_short
            icon = {"interactive": "⌨", "automated": "⚙", "automated-agent": "🤖", "discord-bot": "💬", "feedback-fixer": "🔧"}.get(ptype, "●")
            lines.append(f"  {icon} PID {pid:<7} {ptype:<18} {uptime_m:>4}m  {cwd_short}")
        return "\n".join(lines)


# ── Main App ─────────────────────────────────────────────────

class OpaiTUI(App):
    """OPAI Terminal Dashboard."""

    TITLE = "OPAI Dashboard"
    SUB_TITLE = "Claude Usage · System · Tasks"

    CSS = """
    Screen {
        background: $surface;
    }

    #usage-tab {
        height: 1fr;
    }

    UsagePanel {
        height: auto;
        min-height: 12;
        margin: 1 2;
        padding: 1 2;
        border: round $primary;
    }

    ClaudeProcessPanel {
        height: auto;
        min-height: 6;
        margin: 1 2;
        padding: 1 2;
        border: round $secondary;
    }

    SystemPanel {
        height: auto;
        min-height: 10;
        margin: 1 2;
        padding: 1 2;
        border: round $primary;
    }

    #system-tab {
        height: 1fr;
    }

    #tasks-tab {
        height: 1fr;
    }

    #task-table {
        height: 1fr;
        margin: 1 2;
    }

    #log-panel {
        height: 8;
        margin: 0 2 1 2;
        border: round $accent;
    }

    .status-bar {
        height: 1;
        margin: 0 2;
        color: $text-muted;
    }

    #refresh-label {
        dock: right;
        width: auto;
        margin-right: 2;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("r", "refresh", "Refresh"),
        Binding("k", "kill_selected", "Kill Process", show=True),
        Binding("1", "tab_usage", "Usage", show=False),
        Binding("2", "tab_system", "System", show=False),
        Binding("3", "tab_tasks", "Tasks", show=False),
    ]

    refresh_count: reactive[int] = reactive(0)

    def compose(self) -> ComposeResult:
        yield Header()
        with TabbedContent(initial="usage-tab"):
            with TabPane("Claude Usage", id="usage-tab"):
                with VerticalScroll():
                    yield UsagePanel(id="usage-panel")
                    yield ClaudeProcessPanel(id="claude-procs")
            with TabPane("System", id="system-tab"):
                with VerticalScroll():
                    yield SystemPanel(id="system-panel")
            with TabPane("Task Manager", id="tasks-tab"):
                yield DataTable(id="task-table")
                yield RichLog(id="log-panel", highlight=True, markup=True)
        yield Horizontal(
            Label("[dim]Last refresh: never[/]", id="refresh-label"),
            classes="status-bar",
        )
        yield Footer()

    def on_mount(self) -> None:
        # Configure process table
        table = self.query_one("#task-table", DataTable)
        table.cursor_type = "row"
        table.zebra_stripes = True
        table.add_columns("PID", "Name", "User", "CPU%", "Mem%", "Status", "Command")

        # Initial data load
        self.refresh_all()

        # Auto-refresh timers
        self.set_interval(15, self.refresh_usage)
        self.set_interval(5, self.refresh_system)
        self.set_interval(5, self.refresh_processes)

    def action_tab_usage(self) -> None:
        self.query_one(TabbedContent).active = "usage-tab"

    def action_tab_system(self) -> None:
        self.query_one(TabbedContent).active = "system-tab"

    def action_tab_tasks(self) -> None:
        self.query_one(TabbedContent).active = "tasks-tab"

    def action_refresh(self) -> None:
        self.refresh_all()
        self.log_msg("[green]Manual refresh triggered[/]")

    def refresh_all(self) -> None:
        self.refresh_usage()
        self.refresh_system()
        self.refresh_processes()
        self.refresh_claude_procs()

    @work(thread=True, exclusive=True, group="usage")
    def refresh_usage(self) -> None:
        data = fetch_plan_usage()
        self.app.call_from_thread(self._apply_usage, data)

    def _apply_usage(self, data: dict) -> None:
        panel = self.query_one("#usage-panel", UsagePanel)
        panel.usage_data = data
        self._update_refresh_time()

    @work(thread=True, exclusive=True, group="system")
    def refresh_system(self) -> None:
        data = fetch_system_stats()
        self.app.call_from_thread(self._apply_system, data)

    def _apply_system(self, data: dict) -> None:
        panel = self.query_one("#system-panel", SystemPanel)
        panel.sys_data = data
        self._update_refresh_time()

    @work(thread=True, exclusive=True, group="procs")
    def refresh_processes(self) -> None:
        procs = fetch_processes()
        self.app.call_from_thread(self._apply_processes, procs)

    def _apply_processes(self, procs: list[dict]) -> None:
        table = self.query_one("#task-table", DataTable)
        table.clear()
        for p in procs:
            cpu_str = f"{p['cpu']:.1f}"
            mem_str = f"{p['mem']:.1f}"
            status = p["status"]
            if status == "running":
                status = "[green]running[/]"
            elif status in ("sleeping", "idle"):
                status = f"[dim]{status}[/]"
            elif status in ("zombie", "dead"):
                status = f"[red]{status}[/]"
            table.add_row(
                str(p["pid"]),
                p["name"][:20],
                p["user"],
                cpu_str,
                mem_str,
                status,
                p["cmdline"][:80],
            )
        self._update_refresh_time()

    @work(thread=True, exclusive=True, group="claude-procs")
    def refresh_claude_procs(self) -> None:
        procs = []
        for p in psutil.process_iter(["pid", "name", "cmdline", "create_time", "cwd"]):
            try:
                info = p.info
                name = info.get("name", "")
                cmdline = info.get("cmdline") or []
                cmdline_str = " ".join(cmdline)
                if name in ("claude", "claude-code"):
                    pass
                elif cmdline and cmdline[0].endswith("/claude"):
                    pass
                else:
                    continue
                if "electron" in cmdline_str or "claude-desktop" in cmdline_str:
                    continue
                cmdline_lower = cmdline_str.lower()
                cwd = info.get("cwd", "")
                if "-p" in cmdline_str.split() or "--print" in cmdline_str.split():
                    if "discord" in cwd.lower() or "discord" in cmdline_lower:
                        ptype = "discord-bot"
                    elif "feedback" in cmdline_lower:
                        ptype = "feedback-fixer"
                    elif "squad" in cmdline_lower or "agent" in cmdline_lower:
                        ptype = "automated-agent"
                    else:
                        ptype = "automated"
                else:
                    ptype = "interactive"

                uptime = time.time() - (info.get("create_time") or time.time())
                procs.append({
                    "pid": info["pid"],
                    "type": ptype,
                    "uptime_seconds": int(uptime),
                    "cwd": cwd,
                })
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        self.app.call_from_thread(self._apply_claude_procs, procs)

    def _apply_claude_procs(self, procs: list[dict]) -> None:
        panel = self.query_one("#claude-procs", ClaudeProcessPanel)
        panel.proc_data = procs

    def _update_refresh_time(self) -> None:
        now = datetime.now().strftime("%H:%M:%S")
        label = self.query_one("#refresh-label", Label)
        label.update(f"[dim]Last refresh: {now}[/]")

    def action_kill_selected(self) -> None:
        active_tab = self.query_one(TabbedContent).active
        if active_tab != "tasks-tab":
            self.log_msg("[yellow]Switch to Task Manager tab to kill processes[/]")
            return

        table = self.query_one("#task-table", DataTable)
        if table.cursor_row is None or table.row_count == 0:
            self.log_msg("[yellow]No process selected[/]")
            return

        row_idx = table.cursor_row
        row = table.get_row_at(row_idx)
        pid = int(row[0])
        name = row[1]

        self._do_kill(pid, name)

    @work(thread=True)
    def _do_kill(self, pid: int, name: str) -> None:
        try:
            proc = psutil.Process(pid)
            proc_name = proc.name()
            proc.terminate()
            self.app.call_from_thread(
                self.log_msg,
                f"[green]Sent SIGTERM to PID {pid} ({proc_name})[/]",
            )
            gone, alive = psutil.wait_procs([proc], timeout=3)
            if alive:
                alive[0].kill()
                self.app.call_from_thread(
                    self.log_msg,
                    f"[red]Sent SIGKILL to PID {pid} (did not terminate gracefully)[/]",
                )
            # Refresh the table after kill
            import time as _t
            _t.sleep(0.5)
            self.app.call_from_thread(self.refresh_processes)
        except psutil.NoSuchProcess:
            self.app.call_from_thread(
                self.log_msg,
                f"[yellow]PID {pid} already gone[/]",
            )
        except psutil.AccessDenied:
            self.app.call_from_thread(
                self.log_msg,
                f"[red]Access denied killing PID {pid} ({name}). Try with sudo.[/]",
            )
        except Exception as e:
            self.app.call_from_thread(
                self.log_msg,
                f"[red]Error killing PID {pid}: {e}[/]",
            )

    def log_msg(self, msg: str) -> None:
        try:
            log = self.query_one("#log-panel", RichLog)
            now = datetime.now().strftime("%H:%M:%S")
            log.write(f"[dim]{now}[/] {msg}")
        except Exception:
            pass


if __name__ == "__main__":
    app = OpaiTUI()
    app.run()
