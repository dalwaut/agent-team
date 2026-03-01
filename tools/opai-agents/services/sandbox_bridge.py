"""Sandbox Bridge — manages user sandbox agent configurations.

Each sandbox user gets their own agents/ directory with:
  - agents/team.json — their agent roster + squads
  - agents/prompts/*.txt — their prompt files

This bridge handles reading sandbox configs, enforcing limits,
and providing sandbox-scoped views.
"""

import json
from pathlib import Path
from typing import Optional

import config


def get_sandbox_info(user) -> Optional[dict]:
    """Get sandbox configuration for a user."""
    if user.is_admin:
        return {
            "type": "admin",
            "path": str(config.WORKSPACE_ROOT),
            "has_agents": True,
            "agent_count": _count_agents(config.TEAM_JSON),
        }

    if not user.sandbox_path:
        return None

    sandbox = Path(user.sandbox_path)
    if not sandbox.is_dir():
        return None

    agents_dir = sandbox / "agents"
    team_json = agents_dir / "team.json"
    has_agents = team_json.is_file()

    # Read sandbox config
    sandbox_config = _read_sandbox_config(sandbox)

    return {
        "type": "sandbox",
        "path": str(sandbox),
        "has_agents": has_agents,
        "agent_count": _count_agents(team_json) if has_agents else 0,
        "limits": {
            "max_parallel_agents": sandbox_config.get("max_parallel_agents", 1),
            "agent_timeout_seconds": sandbox_config.get("agent_timeout_seconds", 120),
            "allowed_agent_categories": sandbox_config.get("allowed_agent_categories", []),
        },
    }


def init_sandbox_agents(user) -> dict:
    """Initialize agents directory in user's sandbox with a starter team.json."""
    if user.is_admin:
        raise ValueError("Admin does not use sandbox agents")
    if not user.sandbox_path:
        raise ValueError("No sandbox configured")

    sandbox = Path(user.sandbox_path)
    agents_dir = sandbox / "agents"
    prompts_dir = agents_dir / "prompts"

    agents_dir.mkdir(parents=True, exist_ok=True)
    prompts_dir.mkdir(parents=True, exist_ok=True)

    team_json = agents_dir / "team.json"
    if not team_json.is_file():
        starter = {
            "version": "1.0.0",
            "name": f"{user.display_name}'s Agent Team",
            "config": {
                "max_parallel": 1,
                "report_min_size_bytes": 500,
            },
            "roles": {},
            "squads": {},
        }
        with open(team_json, "w", encoding="utf-8") as f:
            json.dump(starter, f, indent=2)
            f.write("\n")

    return {
        "initialized": True,
        "path": str(agents_dir),
    }


def _read_sandbox_config(sandbox: Path) -> dict:
    """Read sandbox config (config/sandbox.json)."""
    cfg_path = sandbox / "config" / "sandbox.json"
    if not cfg_path.is_file():
        return {}
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _count_agents(team_path: Path) -> int:
    """Count agents in a team.json."""
    if not team_path.is_file():
        return 0
    try:
        with open(team_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return len(data.get("roles", {}))
    except (json.JSONDecodeError, OSError):
        return 0
