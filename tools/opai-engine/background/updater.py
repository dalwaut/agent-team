"""OPAI Engine — Updater agent.

Migrated from opai-monitor/updater.py with engine-specific config paths.
Watches for changes to the OPAI system and generates suggestions.
"""

import asyncio
import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path

import config

logger = logging.getLogger("opai-engine.updater")


class UpdaterAgent:

    def __init__(self):
        self.state = self._load_state()
        self.suggestions = self._load_suggestions()

    # ── Persistence ───────────────────────────────────────

    def _load_state(self) -> dict:
        try:
            if config.UPDATER_STATE_FILE.is_file():
                return json.loads(config.UPDATER_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
        return {"last_scan": None, "known_components": {}, "fingerprints": {}}

    def _load_suggestions(self) -> dict:
        try:
            if config.UPDATER_SUGGESTIONS_FILE.is_file():
                return json.loads(config.UPDATER_SUGGESTIONS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
        return {"suggestions": [], "last_updated": None}

    def _save_state(self):
        config.UPDATER_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.UPDATER_STATE_FILE.write_text(json.dumps(self.state, indent=2))

    def _save_suggestions(self):
        config.UPDATER_SUGGESTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        self.suggestions["last_updated"] = datetime.now().isoformat()
        config.UPDATER_SUGGESTIONS_FILE.write_text(
            json.dumps(self.suggestions, indent=2)
        )

    def _fingerprint(self, path: Path) -> str:
        try:
            return hashlib.md5(path.read_bytes()).hexdigest()
        except (OSError, PermissionError):
            return ""

    @property
    def _is_first_scan(self) -> bool:
        return not self.state.get("known_components")

    # ── Public methods for routes ─────────────────────────

    def archive_suggestion(self, suggestion_id: str) -> bool:
        for s in self.suggestions.get("suggestions", []):
            if s["id"] == suggestion_id and s["status"] != "archived":
                s["status"] = "archived"
                self._save_suggestions()
                return True
        return False

    def mark_tasked(self, suggestion_id: str, task_id: str) -> bool:
        for s in self.suggestions.get("suggestions", []):
            if s["id"] == suggestion_id:
                s["status"] = "tasked"
                s["task_id"] = task_id
                self._save_suggestions()
                return True
        return False

    def get_suggestion(self, suggestion_id: str) -> dict | None:
        for s in self.suggestions.get("suggestions", []):
            if s["id"] == suggestion_id:
                return s
        return None

    # ── Scanners ──────────────────────────────────────────

    def _scan_tools(self) -> dict[str, dict]:
        tools = {}
        if config.TOOLS_DIR.is_dir():
            for entry in config.TOOLS_DIR.iterdir():
                if entry.is_dir() and not entry.name.startswith("."):
                    has_package = (entry / "package.json").is_file()
                    has_python = (entry / "requirements.txt").is_file() or (entry / "app.py").is_file()
                    has_index = (entry / "index.js").is_file() or (entry / "index.ts").is_file()
                    tools[entry.name] = {
                        "type": "tool", "path": str(entry),
                        "runtime": "node" if has_package else "python" if has_python else "unknown",
                        "has_entrypoint": has_index or has_python,
                    }
        return tools

    def _scan_agents(self) -> dict[str, dict]:
        agents = {}
        try:
            team = json.loads(config.TEAM_JSON.read_text())
            for rid, role in team.get("roles", {}).items():
                agents[rid] = {
                    "type": "agent", "name": role.get("name", rid),
                    "category": role.get("category", "unknown"),
                    "prompt_file": role.get("prompt_file", ""),
                }
        except (json.JSONDecodeError, OSError):
            pass
        return agents

    def _scan_squads(self) -> dict[str, dict]:
        squads = {}
        try:
            team = json.loads(config.TEAM_JSON.read_text())
            for sid, squad in team.get("squads", {}).items():
                squads[sid] = {
                    "type": "squad", "description": squad.get("description", ""),
                    "agent_count": len(squad.get("agents", [])),
                    "agents": squad.get("agents", []),
                }
        except (json.JSONDecodeError, OSError):
            pass
        return squads

    def _scan_scripts(self) -> dict[str, dict]:
        scripts = {}
        if config.SCRIPTS_DIR.is_dir():
            for f in config.SCRIPTS_DIR.iterdir():
                if f.is_file() and f.suffix in (".sh", ".ps1", ".txt"):
                    scripts[f.name] = {"type": "script", "path": str(f), "size": f.stat().st_size}
        return scripts

    def _scan_services(self) -> list[str]:
        control = config.SCRIPTS_DIR / "opai-control.sh"
        if control.is_file():
            for line in control.read_text().splitlines():
                if line.strip().startswith("SERVICES=("):
                    inner = line.strip().split("(", 1)[1].rstrip(")")
                    return [s.strip().strip('"').strip("'") for s in inner.split() if s.strip()]
        return []

    def _scan_workspace_dirs(self) -> dict[str, dict]:
        dirs = {}
        for entry in config.WORKSPACE_ROOT.iterdir():
            if entry.is_dir() and entry.name not in ("lost+found",):
                file_count = sum(1 for _ in entry.rglob("*") if _.is_file())
                dirs[entry.name] = {"type": "workspace_dir", "path": str(entry), "file_count": file_count}
        return dirs

    def _scan_report_categories(self) -> dict[str, dict]:
        categories = {}
        if config.REPORTS_DIR.is_dir():
            for entry in config.REPORTS_DIR.iterdir():
                if entry.is_dir():
                    file_count = sum(1 for f in entry.iterdir() if f.is_file())
                    categories[entry.name] = {"type": "report_category", "path": str(entry), "file_count": file_count}
        return categories

    # ── Change detection ──────────────────────────────────

    def _detect_changes(self, current: dict, category: str) -> list[dict]:
        known = self.state["known_components"].get(category, {})
        changes = []
        for key, data in current.items():
            if key not in known:
                changes.append({"change": "added", "category": category, "key": key,
                                "data": data, "detected_at": datetime.now().isoformat()})
        for key in known:
            if key not in current:
                changes.append({"change": "removed", "category": category, "key": key,
                                "data": known[key], "detected_at": datetime.now().isoformat()})
        return changes

    # ── Suggestion generation ─────────────────────────────

    def _generate_suggestion(self, change: dict, context: dict) -> dict | None:
        cat = change["category"]
        key = change["key"]
        action = change["change"]
        agents = context.get("agents", {})
        services = context.get("services", [])
        ts = change["detected_at"]

        if action == "added":
            if cat == "tools":
                in_services = key in services or any(key in s for s in services)
                if in_services:
                    return self._entry(f"add-tool-{key}", "notice", "new_tool",
                        f"New tool: {key}",
                        f"Tool '{key}' detected ({change['data'].get('runtime','?')}). Already in services.",
                        [], ts)
                else:
                    return self._entry(f"add-tool-{key}", "update", "new_tool",
                        f"New tool needs integration: {key}",
                        f"Tool '{key}' ({change['data'].get('runtime','?')}) has no service entry.",
                        [f"Add {key} to SYSTEMD_SERVICES in config.py",
                         f"Add monitoring endpoint if it exposes an API",
                         f"Add log source if it writes logs"], ts)

            elif cat == "agents":
                return self._entry(f"add-agent-{key}", "notice", "new_agent",
                    f"New agent: {change['data'].get('name', key)}",
                    f"Agent '{key}' in category '{change['data'].get('category','?')}'. Auto-detected when running.",
                    [], ts)

            elif cat == "squads":
                return self._entry(f"add-squad-{key}", "notice", "new_squad",
                    f"New squad: {key}",
                    f"Squad '{key}' with {change['data'].get('agent_count',0)} agents: {', '.join(change['data'].get('agents',[]))}.",
                    [], ts)

            elif cat == "scripts":
                if key.startswith("prompt_"):
                    agent_name = key.replace("prompt_", "").replace(".txt", "")
                    if agent_name in agents:
                        return None
                    else:
                        return self._entry(f"add-script-{key}", "update", "orphan_prompt",
                            f"Orphan prompt: {agent_name}",
                            f"Prompt file '{key}' has no matching agent in team.json.",
                            [f"Add '{agent_name}' role to team.json",
                             f"Or remove the orphan prompt file"], ts)
                return None

            elif cat == "workspace_dirs":
                return self._entry(f"add-workspace-{key}", "notice", "new_workspace_dir",
                    f"Workspace directory: /workspace/{key}/",
                    f"{change['data'].get('file_count',0)} files.",
                    [], ts)

            elif cat == "report_categories":
                return self._entry(f"add-report-cat-{key}", "notice", "new_report_category",
                    f"Report category: {key}",
                    f"{change['data'].get('file_count',0)} files. Auto-browsable in Reports panel.",
                    [], ts)

        elif action == "removed":
            kind = "update" if cat in ("tools", "services") else "notice"
            return self._entry(f"remove-{cat}-{key}", kind, f"removed_{cat.rstrip('s')}",
                f"Removed: {key} ({cat})",
                f"Previously tracked {cat} item '{key}' no longer present.",
                [f"Clean up dashboard references to {key}"] if kind == "update" else [],
                ts)

        return None

    def _entry(self, id: str, kind: str, type: str, title: str,
               description: str, suggested_actions: list, created_at: str) -> dict:
        return {
            "id": id, "kind": kind, "type": type, "title": title,
            "description": description, "suggested_actions": suggested_actions,
            "status": "pending", "created_at": created_at,
        }

    # ── Main scan ─────────────────────────────────────────

    async def scan(self):
        tools = self._scan_tools()
        agents = self._scan_agents()
        squads = self._scan_squads()
        scripts = self._scan_scripts()
        services = self._scan_services()
        workspace_dirs = self._scan_workspace_dirs()
        report_categories = self._scan_report_categories()

        is_first = self._is_first_scan

        all_changes = []
        all_changes.extend(self._detect_changes(tools, "tools"))
        all_changes.extend(self._detect_changes(agents, "agents"))
        all_changes.extend(self._detect_changes(squads, "squads"))
        all_changes.extend(self._detect_changes(scripts, "scripts"))
        all_changes.extend(self._detect_changes(workspace_dirs, "workspace_dirs"))
        all_changes.extend(self._detect_changes(report_categories, "report_categories"))

        known_services = set(self.state.get("known_services", []))
        for svc in set(services) - known_services:
            all_changes.append({"change": "added", "category": "services", "key": svc,
                                "data": {"name": svc}, "detected_at": datetime.now().isoformat()})

        # Fingerprint config files
        fingerprint_targets = [config.TEAM_JSON, config.QUEUE_JSON, config.REGISTRY_JSON]
        if config.OPAI_REPORTS_DIR.is_dir():
            fingerprint_targets.extend(config.OPAI_REPORTS_DIR.rglob("*.md"))

        for fpath in fingerprint_targets:
            if fpath.is_file():
                fp = self._fingerprint(fpath)
                old_fp = self.state["fingerprints"].get(str(fpath))
                if old_fp and old_fp != fp:
                    all_changes.append({"change": "modified", "category": "config",
                                        "key": fpath.name, "data": {"path": str(fpath)},
                                        "detected_at": datetime.now().isoformat()})
                self.state["fingerprints"][str(fpath)] = fp

        if not is_first:
            context = {"agents": agents, "services": services}
            existing_ids = {s["id"] for s in self.suggestions.get("suggestions", [])}

            for change in all_changes:
                suggestion = self._generate_suggestion(change, context)
                if suggestion and suggestion["id"] not in existing_ids:
                    self.suggestions.setdefault("suggestions", []).append(suggestion)

        # Update known state
        self.state["known_components"] = {
            "tools": tools, "agents": agents, "squads": squads, "scripts": scripts,
            "workspace_dirs": workspace_dirs, "report_categories": report_categories,
        }
        self.state["known_services"] = services
        self.state["last_scan"] = datetime.now().isoformat()

        self._save_state()
        self._save_suggestions()
        return all_changes

    async def run(self):
        logger.info("Updater agent started")
        await asyncio.sleep(5)
        await self.scan()
        while True:
            await asyncio.sleep(config.UPDATER_SCAN_INTERVAL)
            try:
                await self.scan()
            except Exception as e:
                logger.error("Updater scan error: %s", e)
