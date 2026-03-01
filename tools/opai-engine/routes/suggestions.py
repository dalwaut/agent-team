"""OPAI Engine — Updater suggestions endpoints.

Migrated from opai-monitor/routes_api.py updater section.
"""

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

import config
from auth import require_admin

router = APIRouter(prefix="/api")


def _get_updater():
    """Get the updater instance from the app module."""
    from app import updater
    return updater


@router.get("/updater/suggestions")
def updater_suggestions():
    """Return all suggestions from the updater agent."""
    try:
        if config.UPDATER_SUGGESTIONS_FILE.is_file():
            return json.loads(config.UPDATER_SUGGESTIONS_FILE.read_text())
        return {"suggestions": []}
    except (json.JSONDecodeError, OSError):
        return {"suggestions": []}


@router.get("/updater/state")
def updater_state():
    """Return updater agent state."""
    try:
        if config.UPDATER_STATE_FILE.is_file():
            return json.loads(config.UPDATER_STATE_FILE.read_text())
        return {"last_scan": None, "known_components": []}
    except (json.JSONDecodeError, OSError):
        return {"last_scan": None, "known_components": []}


@router.post("/updater/suggestions/{suggestion_id}/archive", dependencies=[Depends(require_admin)])
def archive_suggestion(suggestion_id: str):
    """Archive a suggestion so it won't be re-suggested."""
    updater = _get_updater()
    if updater.archive_suggestion(suggestion_id):
        return {"success": True}
    raise HTTPException(404, "Suggestion not found or already archived")


@router.post("/updater/suggestions/{suggestion_id}/task", dependencies=[Depends(require_admin)])
def create_task_from_suggestion(suggestion_id: str):
    """Create a task in registry.json from a suggestion."""
    updater = _get_updater()
    suggestion = updater.get_suggestion(suggestion_id)
    if not suggestion:
        raise HTTPException(404, "Suggestion not found")

    try:
        registry = json.loads(config.REGISTRY_JSON.read_text()) if config.REGISTRY_JSON.is_file() else {"tasks": {}}
    except (json.JSONDecodeError, OSError):
        registry = {"tasks": {}}

    date_str = datetime.now().strftime("%Y%m%d")
    existing = [k for k in registry["tasks"] if k.startswith(f"t-{date_str}-")]
    next_num = len(existing) + 1
    task_id = f"t-{date_str}-{next_num:03d}"

    desc = suggestion.get("description", "")
    actions = suggestion.get("suggested_actions", [])
    if actions:
        desc += "\n\nSuggested actions:\n" + "\n".join(f"- {a}" for a in actions)

    registry["tasks"][task_id] = {
        "id": task_id,
        "title": suggestion.get("title", suggestion_id),
        "description": desc,
        "source": "monitor-updater",
        "sourceRef": {"suggestion_id": suggestion_id, "kind": suggestion.get("kind", "update")},
        "project": None,
        "assignee": None,
        "status": "pending",
        "priority": "normal",
        "deadline": None,
        "routing": {"type": "auto", "squads": [], "mode": "execute"},
        "queueId": None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "updatedAt": None,
        "completedAt": None,
    }

    config.REGISTRY_JSON.parent.mkdir(parents=True, exist_ok=True)
    config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2))
    updater.mark_tasked(suggestion_id, task_id)

    # Write HITL briefing
    squad_map = {
        "new_tool": "workspace",
        "orphan_prompt": "hygiene",
        "removed_tool": "hygiene",
        "removed_agent": "hygiene",
        "config_modified": "workspace",
    }
    kind = suggestion.get("kind", "update")
    recommended_squad = squad_map.get(kind, "review")

    task_data = registry["tasks"][task_id]
    actions = suggestion.get("suggested_actions", [])
    actions_md = "\n".join(f"- {a}" for a in actions) if actions else "- Review and address as needed"

    briefing = f"""# Task: {task_id}

**Title:** {task_data['title']}
**Priority:** {task_data['priority']}
**Created:** {task_data['createdAt']}
**Source:** UPD System Changes -- {suggestion_id}

## Description
{suggestion.get('description', 'No description provided.')}

## Suggested Actions
{actions_md}

## Routing
- **Recommended Squad:** {recommended_squad}
- **Mode:** execute

## Delegation
This task was created from monitor system change detection.
Review and assign to an agent squad or handle manually.
"""

    config.REPORTS_HITL.mkdir(parents=True, exist_ok=True)
    (config.REPORTS_HITL / f"{task_id}.md").write_text(briefing)

    return {"success": True, "task_id": task_id}
