"""Squad CRUD — reads/writes team.json squads."""

import json
from pathlib import Path
from typing import Optional

import config
from services.agent_manager import _read_team, _write_team, _user_paths


def list_squads(user=None) -> list[dict]:
    """List all squads with resolved agent details."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)
    roles = team.get("roles", {})
    squads = []

    for key, squad in team.get("squads", {}).items():
        agent_ids = squad.get("agents", [])
        agents = []
        for aid in agent_ids:
            role = roles.get(aid)
            if role:
                agents.append({
                    "id": aid,
                    "name": role.get("name", aid),
                    "emoji": role.get("emoji", ""),
                    "category": role.get("category", ""),
                    "run_order": role.get("run_order", "parallel"),
                })
            else:
                agents.append({"id": aid, "name": aid, "emoji": "?", "category": "unknown", "run_order": "parallel"})

        squads.append({
            "id": key,
            "description": squad.get("description", ""),
            "agents": agents,
            "agent_count": len(agent_ids),
        })

    return squads


def get_squad(squad_id: str, user=None) -> Optional[dict]:
    """Get squad details with resolved agents."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)
    squad = team.get("squads", {}).get(squad_id)
    if not squad:
        return None

    roles = team.get("roles", {})
    agent_ids = squad.get("agents", [])
    agents = []
    for aid in agent_ids:
        role = roles.get(aid)
        if role:
            agents.append({
                "id": aid,
                "name": role.get("name", aid),
                "emoji": role.get("emoji", ""),
                "description": role.get("description", ""),
                "category": role.get("category", ""),
                "run_order": role.get("run_order", "parallel"),
            })
        else:
            agents.append({"id": aid, "name": aid, "emoji": "?", "description": "", "category": "unknown", "run_order": "parallel"})

    return {
        "id": squad_id,
        "description": squad.get("description", ""),
        "agents": agents,
        "agent_count": len(agent_ids),
    }


def create_squad(data: dict, user=None) -> dict:
    """Create a new squad."""
    squad_id = data["id"].lower().strip().replace(" ", "_")

    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
        team_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)

    if squad_id in team.get("squads", {}):
        raise ValueError(f"Squad '{squad_id}' already exists")

    # Validate agent IDs exist
    roles = team.get("roles", {})
    agent_ids = data.get("agents", [])
    invalid = [a for a in agent_ids if a not in roles]
    if invalid:
        raise ValueError(f"Unknown agents: {', '.join(invalid)}")

    squad = {
        "description": data.get("description", ""),
        "agents": agent_ids,
    }

    if "squads" not in team:
        team["squads"] = {}
    team["squads"][squad_id] = squad
    _write_team(team, team_path)

    return get_squad(squad_id, user)


def update_squad(squad_id: str, data: dict, user=None) -> Optional[dict]:
    """Update a squad."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)
    if squad_id not in team.get("squads", {}):
        return None

    squad = team["squads"][squad_id]

    if "description" in data:
        squad["description"] = data["description"]

    if "agents" in data:
        roles = team.get("roles", {})
        invalid = [a for a in data["agents"] if a not in roles]
        if invalid:
            raise ValueError(f"Unknown agents: {', '.join(invalid)}")
        squad["agents"] = data["agents"]

    team["squads"][squad_id] = squad
    _write_team(team, team_path)

    return get_squad(squad_id, user)


def delete_squad(squad_id: str, user=None) -> bool:
    """Delete a squad. Returns True if deleted."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)
    if squad_id not in team.get("squads", {}):
        return False

    del team["squads"][squad_id]
    _write_team(team, team_path)
    return True
