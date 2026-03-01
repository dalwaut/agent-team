#!/usr/bin/env python3
"""OPAI ARL TUI — Agent Response Loop dashboard: status, skills, activity, conversations."""

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.reactive import reactive
from textual.screen import ModalScreen
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Header,
    Input,
    Label,
    RichLog,
    Select,
    Static,
    TabbedContent,
    TabPane,
)

# ── Paths & Constants ────────────────────────────────────────

EMAIL_AGENT_BASE = "http://127.0.0.1:8093"
ARL_SKILLS_PATH = Path(__file__).parent.parent / "opai-email-agent" / "arl-skills.json"
ARL_LOG_PATH = Path(__file__).parent.parent / "opai-email-agent" / "data" / "arl-log.json"

REFRESH_INTERVAL = 5  # seconds


# ── Data Fetchers (local JSON + API) ─────────────────────────

def load_skills_config() -> dict:
    try:
        return json.loads(ARL_SKILLS_PATH.read_text())
    except Exception:
        return {"arlEnabled": False, "skills": []}


def load_arl_log() -> list:
    try:
        data = json.loads(ARL_LOG_PATH.read_text())
        return data.get("entries", [])
    except Exception:
        return []


def api_get(endpoint: str) -> dict:
    try:
        resp = httpx.get(f"{EMAIL_AGENT_BASE}{endpoint}", timeout=5)
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def api_post(endpoint: str, data: dict = None) -> dict:
    try:
        resp = httpx.post(f"{EMAIL_AGENT_BASE}{endpoint}", json=data or {}, timeout=5)
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def api_patch(endpoint: str, data: dict = None) -> dict:
    try:
        resp = httpx.patch(f"{EMAIL_AGENT_BASE}{endpoint}", json=data or {}, timeout=5)
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def api_delete(endpoint: str) -> dict:
    try:
        resp = httpx.delete(f"{EMAIL_AGENT_BASE}{endpoint}", timeout=5)
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


# ── Cursor-preserving table refresh ─────────────────────────

def refresh_table(table: DataTable, rows: list[tuple]) -> None:
    """Clear and repopulate a DataTable, preserving cursor_row position."""
    saved_row = table.cursor_row
    table.clear()
    for row in rows:
        table.add_row(*row)
    if rows and saved_row is not None:
        table.move_cursor(row=min(saved_row, len(rows) - 1))


# ── Add Skill Modal ─────────────────────────────────────────

class AddSkillModal(ModalScreen[dict | None]):
    """Modal form for adding a new ARL skill."""

    CSS = """
    AddSkillModal {
        align: center middle;
    }
    #add-skill-dialog {
        width: 72;
        max-height: 38;
        border: thick $accent;
        background: $surface;
        padding: 1 2;
    }
    #add-skill-dialog Label {
        margin-top: 1;
        color: $text-muted;
    }
    #add-skill-dialog Input {
        margin-bottom: 0;
    }
    #add-skill-dialog .title-label {
        text-style: bold;
        color: $text;
        margin-bottom: 1;
        margin-top: 0;
    }
    #modal-btn-row {
        margin-top: 1;
        height: 3;
        align: right middle;
    }
    #modal-btn-row Button {
        margin-left: 1;
    }
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def compose(self) -> ComposeResult:
        with Vertical(id="add-skill-dialog"):
            yield Label("Add New ARL Skill", classes="title-label")
            yield Label("Name *")
            yield Input(placeholder="e.g. Disk Usage", id="inp-name")
            yield Label("ID (auto from name if blank)")
            yield Input(placeholder="e.g. disk-usage", id="inp-id")
            yield Label("Type")
            yield Select(
                [("direct -- shell command", "direct"), ("claude -- AI prompt", "claude")],
                value="direct",
                id="sel-type",
            )
            yield Label("Command (direct) or Prompt Template (claude)")
            yield Input(placeholder="e.g. df -h /workspace", id="inp-command")
            yield Label("Model (claude skills only)")
            yield Select(
                [("haiku", "haiku"), ("sonnet", "sonnet"), ("opus", "opus")],
                value="sonnet",
                id="sel-model",
            )
            yield Label("Intent Patterns (comma-separated regex)")
            yield Input(placeholder="e.g. disk,storage,space,how much room", id="inp-patterns")
            yield Label("Timeout (seconds)")
            yield Input(placeholder="10", id="inp-timeout", value="10")
            with Horizontal(id="modal-btn-row"):
                yield Button("Cancel", variant="default", id="btn-modal-cancel")
                yield Button("Create Skill", variant="primary", id="btn-modal-create")

    def action_cancel(self) -> None:
        self.dismiss(None)

    @on(Button.Pressed, "#btn-modal-cancel")
    def handle_cancel(self) -> None:
        self.dismiss(None)

    @on(Button.Pressed, "#btn-modal-create")
    def handle_create(self) -> None:
        name = self.query_one("#inp-name", Input).value.strip()
        if not name:
            self.query_one("#inp-name", Input).focus()
            return

        skill_id = self.query_one("#inp-id", Input).value.strip()
        skill_type = self.query_one("#sel-type", Select).value
        command_or_prompt = self.query_one("#inp-command", Input).value.strip()
        model = self.query_one("#sel-model", Select).value
        patterns_raw = self.query_one("#inp-patterns", Input).value.strip()
        timeout_raw = self.query_one("#inp-timeout", Input).value.strip()

        patterns = [p.strip() for p in patterns_raw.split(",") if p.strip()] if patterns_raw else []
        try:
            timeout = int(timeout_raw)
        except ValueError:
            timeout = 10 if skill_type == "direct" else 120

        payload = {
            "name": name,
            "type": skill_type,
            "enabled": True,
            "intentPatterns": patterns,
            "timeout": timeout,
        }
        if skill_id:
            payload["id"] = skill_id

        if skill_type == "claude":
            payload["model"] = model
            payload["promptTemplate"] = command_or_prompt
        else:
            payload["command"] = command_or_prompt or 'echo "no command"'

        self.dismiss(payload)


# ── Status Bar Widget ────────────────────────────────────────

class ArlStatusBar(Static):
    """Top-level ARL status display."""

    def render(self) -> str:
        config = load_skills_config()
        enabled = config.get("arlEnabled", False)
        status = "[bold green]ACTIVE[/]" if enabled else "[bold red]DISABLED[/]"
        skills = config.get("skills", [])
        enabled_count = sum(1 for s in skills if s.get("enabled"))
        model = config.get("defaultModel", "sonnet")
        window = config.get("replyWindowMinutes", 5)
        fast = config.get("fastPollSeconds", 30)

        return (
            f" ARL: {status}  |  "
            f"Skills: {enabled_count}/{len(skills)}  |  "
            f"Model: {model}  |  "
            f"Reply Window: {window}m  |  "
            f"Fast Poll: {fast}s"
        )


# ── Main App ─────────────────────────────────────────────────

class ArlTui(App):
    """OPAI Agent Response Loop -- Terminal Dashboard"""

    TITLE = "OPAI ARL Dashboard"
    CSS = """
    Screen {
        background: $surface;
    }
    ArlStatusBar {
        dock: top;
        height: 1;
        background: $boost;
        color: $text;
        padding: 0 1;
    }
    #skills-table, #history-table, #conversations-table {
        height: 1fr;
    }
    .section-label {
        color: $accent;
        text-style: bold;
        padding: 0 1;
    }
    .hint {
        color: $text-muted;
        padding: 0 1;
    }
    #log-panel {
        height: 1fr;
        border: tall $primary;
    }
    #skills-toolbar {
        height: 3;
        padding: 0 1;
    }
    #skills-toolbar Button {
        margin-right: 1;
    }
    """

    BINDINGS = [
        Binding("r", "refresh", "Refresh", priority=True),
        Binding("t", "toggle_arl", "Toggle ARL", priority=True),
        Binding("q", "quit", "Quit"),
        Binding("1", "tab_status", "Status", priority=True),
        Binding("2", "tab_skills", "Skills", priority=True),
        Binding("3", "tab_activity", "Activity", priority=True),
        Binding("4", "tab_conversations", "Conversations", priority=True),
        Binding("a", "skill_add", "Add Skill", priority=True),
        Binding("e", "skill_enable", "Enable", priority=True, show=False),
        Binding("d", "skill_disable", "Disable", priority=True, show=False),
        Binding("x", "skill_delete", "Delete", priority=True, show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Header()
        yield ArlStatusBar()
        with TabbedContent():
            with TabPane("Status", id="tab-status"):
                yield VerticalScroll(
                    Static("", id="status-overview"),
                    Static("", id="status-agent"),
                    Label("Recent ARL Activity", classes="section-label"),
                    RichLog(id="log-panel", highlight=True, markup=True),
                )
            with TabPane("Skills", id="tab-skills"):
                with Horizontal(id="skills-toolbar"):
                    yield Button("Add Skill", variant="primary", id="btn-add")
                    yield Button("Enable", variant="success", id="btn-enable")
                    yield Button("Disable", variant="warning", id="btn-disable")
                    yield Button("Delete", variant="error", id="btn-delete")
                yield DataTable(id="skills-table")
            with TabPane("Activity", id="tab-activity"):
                yield VerticalScroll(
                    Label("ARL Execution History", classes="section-label"),
                    DataTable(id="history-table"),
                )
            with TabPane("Conversations", id="tab-conversations"):
                yield VerticalScroll(
                    Label("Active Reply Windows", classes="section-label"),
                    DataTable(id="conversations-table"),
                )
        yield Footer()

    def on_mount(self) -> None:
        skills_table = self.query_one("#skills-table", DataTable)
        skills_table.add_columns("ID", "Name", "Type", "Model", "Enabled", "Built-in", "Patterns")
        skills_table.cursor_type = "row"

        history_table = self.query_one("#history-table", DataTable)
        history_table.add_columns("Time", "Sender", "Subject", "Skills", "Success", "Duration", "Follow-up")
        history_table.cursor_type = "row"

        conv_table = self.query_one("#conversations-table", DataTable)
        conv_table.add_columns("Sender", "Thread", "Turns", "Last Activity", "Remaining", "Account")
        conv_table.cursor_type = "row"

        self.refresh_all()
        self.set_interval(REFRESH_INTERVAL, self.refresh_all)

    @work(thread=True)
    def refresh_all(self) -> None:
        self._refresh_status()
        self._refresh_skills()
        self._refresh_history()
        self._refresh_conversations()
        self.call_from_thread(self.query_one(ArlStatusBar).refresh)

    def _refresh_status(self) -> None:
        config = load_skills_config()
        agent_status = api_get("/api/status")

        enabled = config.get("arlEnabled", False)
        overview_parts = []
        overview_parts.append(f"[bold]Agent Response Loop[/]: {'[green]ENABLED[/]' if enabled else '[red]DISABLED[/]'}")
        overview_parts.append(f"Default Model: [cyan]{config.get('defaultModel', 'sonnet')}[/]")
        overview_parts.append(f"Planner Model: [cyan]{config.get('plannerModel', 'haiku')}[/]")
        overview_parts.append(f"Max Skills/Request: {config.get('maxSkillsPerRequest', 5)}")
        overview_parts.append(f"Reply Window: {config.get('replyWindowMinutes', 5)} minutes")
        overview_parts.append(f"Fast Poll: {config.get('fastPollSeconds', 30)} seconds")
        overview_parts.append(f"Global Timeout: {config.get('globalTimeout', 300)}s")

        self.call_from_thread(
            self.query_one("#status-overview", Static).update,
            "\n".join(overview_parts),
        )

        if "error" not in agent_status:
            agent_parts = []
            agent_parts.append(f"\n[bold]Email Agent[/]: {'[red]KILLED[/]' if agent_status.get('killed') else '[green]RUNNING[/]'}")
            agent_parts.append(f"Mode: {agent_status.get('mode', 'unknown')}")
            uptime = agent_status.get("uptime_seconds", 0)
            hours, remainder = divmod(uptime, 3600)
            mins, secs = divmod(remainder, 60)
            agent_parts.append(f"Uptime: {int(hours)}h {int(mins)}m {int(secs)}s")
            stats = agent_status.get("stats", {})
            if stats:
                agent_parts.append(f"Today: {stats.get('total', 0)} emails processed")
            self.call_from_thread(
                self.query_one("#status-agent", Static).update,
                "\n".join(agent_parts),
            )
        else:
            self.call_from_thread(
                self.query_one("#status-agent", Static).update,
                f"\n[red]Agent unreachable: {agent_status['error']}[/]",
            )

        entries = load_arl_log()[-15:]
        log = self.query_one("#log-panel", RichLog)
        self.call_from_thread(log.clear)
        for entry in reversed(entries):
            ts = entry.get("timestamp", "")[:19]
            sender = entry.get("sender", "?")
            skills = ", ".join(entry.get("skills", []))
            success = "[green]OK[/]" if entry.get("success") else "[red]FAIL[/]"
            dur = entry.get("duration", 0)
            follow = " [yellow](follow-up)[/]" if entry.get("isFollowUp") else ""
            line = f"[dim]{ts}[/] {success} {sender} | {skills} | {dur}ms{follow}"
            self.call_from_thread(log.write, line)

    def _refresh_skills(self) -> None:
        config = load_skills_config()
        skills = config.get("skills", [])
        table = self.query_one("#skills-table", DataTable)

        rows = []
        for s in skills:
            enabled = "[green]Yes[/]" if s.get("enabled") else "[red]No[/]"
            builtin = "Yes" if s.get("builtIn") else "No"
            model = s.get("model", "-")
            patterns = ", ".join((s.get("intentPatterns") or [])[:3])
            if len(s.get("intentPatterns", [])) > 3:
                patterns += "..."
            rows.append((
                s.get("id", "?"),
                s.get("name", "?"),
                s.get("type", "?"),
                model,
                enabled,
                builtin,
                patterns,
            ))
        self.call_from_thread(refresh_table, table, rows)

    def _refresh_history(self) -> None:
        entries = load_arl_log()[-50:]
        table = self.query_one("#history-table", DataTable)

        rows = []
        for entry in reversed(entries):
            ts = entry.get("timestamp", "")[:19]
            sender = entry.get("sender", "?")[:30]
            subject = (entry.get("subject") or "")[:40]
            skills = ", ".join(entry.get("skills", []))
            success = "Yes" if entry.get("success") else "No"
            dur = f"{entry.get('duration', 0)}ms"
            follow = "Yes" if entry.get("isFollowUp") else "No"
            rows.append((ts, sender, subject, skills, success, dur, follow))
        self.call_from_thread(refresh_table, table, rows)

    def _refresh_conversations(self) -> None:
        data = api_get("/api/arl/conversations")
        convs = data.get("conversations", [])
        table = self.query_one("#conversations-table", DataTable)

        rows = []
        if not convs:
            rows.append(("(none)", "-", "-", "-", "-", "-"))
        else:
            for c in convs:
                rows.append((
                    c.get("sender", "?"),
                    c.get("threadId", "?")[:30],
                    str(c.get("turns", 0)),
                    c.get("lastActivity", "?")[:19],
                    f"{c.get('remainingSeconds', 0)}s",
                    c.get("accountEmail", "?"),
                ))
        self.call_from_thread(refresh_table, table, rows)

    # ── Helpers ──────────────────────────────────────────────

    def _get_selected_skill_id(self) -> str | None:
        table = self.query_one("#skills-table", DataTable)
        if table.cursor_row is None or table.row_count == 0:
            return None
        try:
            row = table.get_row_at(table.cursor_row)
            return row[0]
        except Exception:
            return None

    def _is_skills_tab(self) -> bool:
        return self.query_one(TabbedContent).active == "tab-skills"

    # ── Actions (keyboard bindings with priority=True) ───────

    def action_refresh(self) -> None:
        self.refresh_all()

    def action_toggle_arl(self) -> None:
        config = load_skills_config()
        new_state = not config.get("arlEnabled", False)
        api_post("/api/arl/toggle", {"enabled": new_state})
        self.refresh_all()

    def action_tab_status(self) -> None:
        self.query_one(TabbedContent).active = "tab-status"

    def action_tab_skills(self) -> None:
        self.query_one(TabbedContent).active = "tab-skills"

    def action_tab_activity(self) -> None:
        self.query_one(TabbedContent).active = "tab-activity"

    def action_tab_conversations(self) -> None:
        self.query_one(TabbedContent).active = "tab-conversations"

    def action_skill_add(self) -> None:
        if not self._is_skills_tab():
            return
        self.push_screen(AddSkillModal(), callback=self._on_add_skill_result)

    def action_skill_enable(self) -> None:
        if not self._is_skills_tab():
            return
        skill_id = self._get_selected_skill_id()
        if skill_id:
            api_patch(f"/api/arl/skills/{skill_id}/toggle", {"enabled": True})
            self.notify(f"Enabled: {skill_id}", severity="information")
            self.refresh_all()

    def action_skill_disable(self) -> None:
        if not self._is_skills_tab():
            return
        skill_id = self._get_selected_skill_id()
        if skill_id:
            api_patch(f"/api/arl/skills/{skill_id}/toggle", {"enabled": False})
            self.notify(f"Disabled: {skill_id}", severity="warning")
            self.refresh_all()

    def action_skill_delete(self) -> None:
        if not self._is_skills_tab():
            return
        skill_id = self._get_selected_skill_id()
        if skill_id:
            result = api_delete(f"/api/arl/skills/{skill_id}")
            if result.get("success"):
                self.notify(f"Deleted: {skill_id}", severity="information")
            else:
                self.notify(f"Cannot delete: {result.get('error', 'built-in or not found')}", severity="error")
            self.refresh_all()

    # ── Button click handlers ────────────────────────────────

    @on(Button.Pressed, "#btn-add")
    def handle_btn_add(self) -> None:
        self.push_screen(AddSkillModal(), callback=self._on_add_skill_result)

    @on(Button.Pressed, "#btn-enable")
    def handle_btn_enable(self) -> None:
        self.action_skill_enable()

    @on(Button.Pressed, "#btn-disable")
    def handle_btn_disable(self) -> None:
        self.action_skill_disable()

    @on(Button.Pressed, "#btn-delete")
    def handle_btn_delete(self) -> None:
        self.action_skill_delete()

    # ── Modal callback ───────────────────────────────────────

    def _on_add_skill_result(self, payload: dict | None) -> None:
        if payload is None:
            return
        result = api_post("/api/arl/skills", payload)
        if result.get("success"):
            self.notify(f"Skill created: {payload.get('name', '?')}", severity="information")
        else:
            self.notify(f"Error: {result.get('error', 'unknown')}", severity="error")
        self.refresh_all()


if __name__ == "__main__":
    app = ArlTui()
    app.run()
