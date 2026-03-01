"""Agent CRUD — reads/writes team.json roles + prompt files."""

import json
import re
from pathlib import Path
from typing import Optional

import config


def _read_team(team_path: Path = None) -> dict:
    """Read and parse team.json."""
    path = team_path or config.TEAM_JSON
    if not path.is_file():
        return {"version": "1.3.0", "roles": {}, "squads": {}, "config": {}}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_team(data: dict, team_path: Path = None):
    """Write team.json with formatting."""
    path = team_path or config.TEAM_JSON
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _prompt_path(prompt_file: str, scripts_dir: Path = None) -> Path:
    """Resolve prompt file path."""
    base = scripts_dir or config.SCRIPTS_DIR
    return base / prompt_file


def _sanitize_name(name: str) -> str:
    """Sanitize an agent name to a safe identifier."""
    return re.sub(r"[^a-z0-9_]", "_", name.lower().strip())


def _user_paths(user) -> tuple[Path, Path]:
    """Get team.json and prompts dir for a sandbox user."""
    sandbox = Path(user.sandbox_path)
    team_path = sandbox / "agents" / "team.json"
    scripts_dir = sandbox / "agents" / "prompts"
    return team_path, scripts_dir


def list_agents(user=None) -> list[dict]:
    """List all agents. Admin gets full roster, users get sandbox copy."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
        team = _read_team(team_path)
    else:
        team = _read_team()

    agents = []
    for key, role in team.get("roles", {}).items():
        agents.append({
            "id": key,
            "name": role.get("name", key),
            "emoji": role.get("emoji", ""),
            "description": role.get("description", ""),
            "category": role.get("category", ""),
            "run_order": role.get("run_order", "parallel"),
            "depends_on": role.get("depends_on", []),
            "prompt_file": role.get("prompt_file", ""),
            "model": role.get("model", ""),
            "max_turns": role.get("max_turns", 0),
            "no_project_context": role.get("no_project_context", False),
        })
    return agents


def get_agent(agent_id: str, user=None) -> Optional[dict]:
    """Get agent details including prompt content."""
    if user and not user.is_admin:
        team_path, scripts_dir = _user_paths(user)
    else:
        team_path, scripts_dir = config.TEAM_JSON, config.SCRIPTS_DIR

    team = _read_team(team_path)
    role = team.get("roles", {}).get(agent_id)
    if not role:
        return None

    # Read prompt content
    prompt_content = ""
    prompt_file = role.get("prompt_file", "")
    if prompt_file:
        ppath = _prompt_path(prompt_file, scripts_dir)
        if ppath.is_file():
            prompt_content = ppath.read_text(encoding="utf-8")

    return {
        "id": agent_id,
        "name": role.get("name", agent_id),
        "emoji": role.get("emoji", ""),
        "description": role.get("description", ""),
        "category": role.get("category", ""),
        "run_order": role.get("run_order", "parallel"),
        "depends_on": role.get("depends_on", []),
        "model": role.get("model", ""),
        "max_turns": role.get("max_turns", 0),
        "no_project_context": role.get("no_project_context", False),
        "prompt_file": prompt_file,
        "prompt_content": prompt_content,
    }


def create_agent(data: dict, user=None) -> dict:
    """Create a new agent. Returns the created agent dict."""
    agent_id = _sanitize_name(data["id"])

    if user and not user.is_admin:
        team_path, scripts_dir = _user_paths(user)
        scripts_dir.mkdir(parents=True, exist_ok=True)
        team_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        team_path, scripts_dir = config.TEAM_JSON, config.SCRIPTS_DIR

    team = _read_team(team_path)

    if agent_id in team.get("roles", {}):
        raise ValueError(f"Agent '{agent_id}' already exists")

    prompt_file = f"prompt_{agent_id}.txt"
    role = {
        "name": data.get("name", agent_id),
        "emoji": data.get("emoji", ""),
        "description": data.get("description", ""),
        "prompt_file": prompt_file,
        "depends_on": data.get("depends_on", []),
        "run_order": data.get("run_order", "parallel"),
        "category": data.get("category", "quality"),
        "model": data.get("model", ""),
        "max_turns": data.get("max_turns", 0),
        "no_project_context": data.get("no_project_context", False),
    }

    if "roles" not in team:
        team["roles"] = {}
    team["roles"][agent_id] = role
    _write_team(team, team_path)

    # Write prompt file
    prompt_content = data.get("prompt_content", f"# {role['name']}\n\nYou are the {role['name']} agent.\n")
    ppath = _prompt_path(prompt_file, scripts_dir)
    ppath.write_text(prompt_content, encoding="utf-8")

    return {"id": agent_id, **role, "prompt_content": prompt_content}


def update_agent(agent_id: str, data: dict, user=None) -> Optional[dict]:
    """Update an existing agent."""
    if user and not user.is_admin:
        team_path, scripts_dir = _user_paths(user)
    else:
        team_path, scripts_dir = config.TEAM_JSON, config.SCRIPTS_DIR

    team = _read_team(team_path)
    if agent_id not in team.get("roles", {}):
        return None

    role = team["roles"][agent_id]

    # Update fields if provided
    for field in ("name", "emoji", "description", "category", "run_order", "depends_on", "model", "max_turns", "no_project_context"):
        if field in data:
            role[field] = data[field]

    team["roles"][agent_id] = role
    _write_team(team, team_path)

    # Sync feedback_fixer settings to orchestrator.json so Token Budget stays in sync
    if agent_id == "feedback_fixer" and ("model" in data or "max_turns" in data):
        try:
            orch_path = config.TEAM_JSON.parent / "config" / "orchestrator.json"
            if orch_path.is_file():
                import json as _json
                orch = _json.loads(orch_path.read_text())
                tp = orch.setdefault("task_processor", {})
                if "model" in data:
                    tp["feedback_fixer_model"] = data["model"]
                if "max_turns" in data:
                    tp["feedback_fixer_max_turns"] = data["max_turns"]
                orch_path.write_text(_json.dumps(orch, indent=2))
        except Exception:
            pass  # non-critical

    # Update prompt if provided
    if "prompt_content" in data:
        prompt_file = role.get("prompt_file", f"prompt_{agent_id}.txt")
        ppath = _prompt_path(prompt_file, scripts_dir)
        ppath.write_text(data["prompt_content"], encoding="utf-8")

    return get_agent(agent_id, user)


def delete_agent(agent_id: str, user=None) -> bool:
    """Delete an agent and its prompt file. Returns True if deleted."""
    if user and not user.is_admin:
        team_path, scripts_dir = _user_paths(user)
    else:
        team_path, scripts_dir = config.TEAM_JSON, config.SCRIPTS_DIR

    team = _read_team(team_path)
    if agent_id not in team.get("roles", {}):
        return False

    role = team["roles"].pop(agent_id)

    # Remove from any squads
    for squad in team.get("squads", {}).values():
        if agent_id in squad.get("agents", []):
            squad["agents"].remove(agent_id)

    _write_team(team, team_path)

    # Delete prompt file
    prompt_file = role.get("prompt_file", "")
    if prompt_file:
        ppath = _prompt_path(prompt_file, scripts_dir)
        if ppath.is_file():
            ppath.unlink()

    return True


def list_templates() -> list[dict]:
    """List available specialist templates."""
    templates = []
    templates_dir = config.TEMPLATES_DIR
    if not templates_dir.is_dir():
        return templates

    for f in sorted(templates_dir.rglob("prompt_*.txt")):
        content = f.read_text(encoding="utf-8")
        # Extract first line as description
        first_line = content.split("\n", 1)[0].strip("# ").strip()
        templates.append({
            "file": f.name,
            "name": first_line or f.stem.replace("prompt_", "").replace("_", " ").title(),
            "path": str(f.relative_to(templates_dir)),
        })

    return templates


def get_squad_membership(agent_id: str, user=None) -> list[str]:
    """Return list of squad names that include this agent."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)
    squads = []
    for name, squad in team.get("squads", {}).items():
        if agent_id in squad.get("agents", []):
            squads.append(name)
    return squads
