"""Workflow Manager — chain squads with conditional branching.

Workflows are stored in team.json under a "workflows" key.
Format:
{
  "workflows": {
    "deploy_check": {
      "description": "Pre-deploy validation pipeline",
      "steps": [
        { "squad": "audit", "on_fail": "stop" },
        { "squad": "review", "on_fail": "continue" },
        { "squad": "ship", "on_fail": "stop" }
      ]
    }
  }
}

Each step runs a squad. "on_fail" controls behavior:
  - "stop" — abort workflow on failure (default)
  - "continue" — proceed to next step regardless
  - "run:<squad>" — run alternate squad on failure
"""

import json
from pathlib import Path
from typing import Optional

import config
from services.agent_manager import _read_team, _write_team, _user_paths


def list_workflows(user=None) -> list[dict]:
    """List all workflows."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)
    workflows = []
    for key, wf in team.get("workflows", {}).items():
        entry = {
            "id": key,
            "description": wf.get("description", ""),
            "steps": wf.get("steps", []),
            "step_count": len(wf.get("steps", [])),
        }
        if "flow" in wf:
            entry["flow"] = wf["flow"]
        if "triggers" in wf:
            entry["triggers"] = wf["triggers"]
        workflows.append(entry)
    return workflows


def get_workflow(workflow_id: str, user=None) -> Optional[dict]:
    """Get workflow details."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)
    wf = team.get("workflows", {}).get(workflow_id)
    if not wf:
        return None

    # Resolve squad names to details
    squads = team.get("squads", {})
    steps = []
    for step in wf.get("steps", []):
        squad_id = step.get("squad", "")
        squad_info = squads.get(squad_id, {})
        steps.append({
            "squad": squad_id,
            "squad_description": squad_info.get("description", ""),
            "squad_agents": squad_info.get("agents", []),
            "on_fail": step.get("on_fail", "stop"),
        })

    result = {
        "id": workflow_id,
        "description": wf.get("description", ""),
        "steps": steps,
        "step_count": len(steps),
    }
    if "flow" in wf:
        result["flow"] = wf["flow"]
    if "triggers" in wf:
        result["triggers"] = wf["triggers"]
    return result


def create_workflow(data: dict, user=None) -> dict:
    """Create a workflow."""
    wf_id = data["id"].lower().strip().replace(" ", "_")

    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
        team_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)

    if wf_id in team.get("workflows", {}):
        raise ValueError(f"Workflow '{wf_id}' already exists")

    # Validate squad references
    squads = team.get("squads", {})
    for step in data.get("steps", []):
        if step.get("squad") not in squads:
            raise ValueError(f"Unknown squad: {step['squad']}")
        fail_action = step.get("on_fail", "stop")
        if fail_action.startswith("run:"):
            alt_squad = fail_action[4:]
            if alt_squad not in squads:
                raise ValueError(f"Unknown fallback squad: {alt_squad}")

    wf = {
        "description": data.get("description", ""),
        "steps": data.get("steps", []),
    }
    if data.get("flow"):
        wf["flow"] = data["flow"]
    if data.get("triggers"):
        wf["triggers"] = data["triggers"]

    if "workflows" not in team:
        team["workflows"] = {}
    team["workflows"][wf_id] = wf
    _write_team(team, team_path)

    return get_workflow(wf_id, user)


def update_workflow(workflow_id: str, data: dict, user=None) -> Optional[dict]:
    """Update a workflow."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)
    if workflow_id not in team.get("workflows", {}):
        return None

    wf = team["workflows"][workflow_id]

    if "description" in data:
        wf["description"] = data["description"]

    if "steps" in data:
        squads = team.get("squads", {})
        for step in data["steps"]:
            if step.get("squad") not in squads:
                raise ValueError(f"Unknown squad: {step['squad']}")
        wf["steps"] = data["steps"]

    if "flow" in data:
        if data["flow"] is not None:
            wf["flow"] = data["flow"]
        else:
            wf.pop("flow", None)

    if "triggers" in data:
        if data["triggers"] is not None:
            wf["triggers"] = data["triggers"]
        else:
            wf.pop("triggers", None)

    team["workflows"][workflow_id] = wf
    _write_team(team, team_path)
    return get_workflow(workflow_id, user)


def delete_workflow(workflow_id: str, user=None) -> bool:
    """Delete a workflow."""
    if user and not user.is_admin:
        team_path, _ = _user_paths(user)
    else:
        team_path = config.TEAM_JSON

    team = _read_team(team_path)
    if workflow_id not in team.get("workflows", {}):
        return False

    del team["workflows"][workflow_id]
    _write_team(team, team_path)
    return True
