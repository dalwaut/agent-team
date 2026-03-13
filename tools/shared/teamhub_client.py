"""Shared Team Hub client for agent use.

Synchronous wrapper around Team Hub's internal API (localhost, no auth).
Use this from agent scripts, post-squad hooks, and background workers.

Usage:
    from shared.teamhub_client import TeamHubClient

    th = TeamHubClient()
    task = th.create_task(title="Review security findings", priority="high")
    th.add_comment(task["id"], "Phase A complete. Moving to prototype.")
    th.add_comment(task["id"], "@[Dallas](1c93c5fe-d304-40f2-9169-765d0d2b7638) — need input")
    th.update_status(task["id"], "in_progress")
    th.assign(task["id"], DALLAS_UUID)
"""

import logging
import os
import requests

log = logging.getLogger("teamhub_client")

TEAMHUB_URL = os.getenv("TEAMHUB_URL", "http://127.0.0.1:8089")
DALLAS_UUID = "1c93c5fe-d304-40f2-9169-765d0d2b7638"
AI_AUTHOR_ID = "ai-assistant"


class TeamHubClient:
    """Synchronous client for Team Hub internal API."""

    def __init__(self, base_url: str = None, user_id: str = None,
                 workspace_id: str = None, timeout: int = 15):
        self.base = (base_url or TEAMHUB_URL).rstrip("/")
        self.user_id = user_id or DALLAS_UUID
        self.workspace_id = workspace_id
        self.timeout = timeout

    def _post(self, path: str, params: dict) -> dict:
        url = f"{self.base}/api{path}"
        try:
            r = requests.post(url, params=params, timeout=self.timeout)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            log.error("TeamHub POST %s failed: %s", path, e)
            return {}

    def _patch(self, path: str, params: dict) -> dict:
        url = f"{self.base}/api{path}"
        try:
            r = requests.patch(url, params=params, timeout=self.timeout)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            log.error("TeamHub PATCH %s failed: %s", path, e)
            return {}

    # ── Core operations ─────────────────────────────────────────

    def create_task(self, title: str, description: str = "",
                    priority: str = "medium", source: str = "agent",
                    status: str = None, parent_id: str = None,
                    list_name: str = None, assignee_id: str = None,
                    due_date: str = None) -> dict:
        """Create a task in Team Hub.

        Returns the created item dict, or empty dict on failure.
        """
        params = {
            "user_id": self.user_id,
            "title": title,
            "description": description,
            "priority": priority,
            "source": source,
            "type": "task",
        }
        if self.workspace_id:
            params["workspace_id"] = self.workspace_id
        else:
            params["workspace_type"] = "personal"
        if status:
            params["status"] = status
        if parent_id:
            params["parent_id"] = parent_id
        if list_name:
            params["list_name"] = list_name
        if assignee_id:
            params["assignee_id"] = assignee_id
        if due_date:
            params["due_date"] = due_date

        result = self._post("/internal/create-item", params)
        if result:
            log.info("Created TeamHub task: %s → %s", title, result.get("id", "?"))
        return result

    def add_comment(self, item_id: str, content: str,
                    author_id: str = None, is_agent_report: bool = False) -> dict:
        """Add a comment to a task. Supports @mentions for notifications.

        Use @[Name](uuid) syntax in content to trigger notifications.
        Set is_agent_report=True for automated agent progress updates.
        """
        params = {
            "item_id": item_id,
            "content": content,
            "author_id": author_id or AI_AUTHOR_ID,
        }
        result = self._post("/internal/add-comment", params)
        if result:
            log.info("Added comment to item %s", item_id)
        return result

    def assign(self, item_id: str, assignee_id: str = None,
               assigned_by: str = "agent") -> dict:
        """Assign a user to a task."""
        params = {
            "item_id": item_id,
            "assignee_id": assignee_id or self.user_id,
            "assignee_type": "user",
            "assigned_by": assigned_by,
        }
        return self._post("/internal/assign-item", params)

    def update_status(self, item_id: str, status: str) -> dict:
        """Update a task's status (open/in_progress/review/completed/cancelled)."""
        return self._patch("/internal/update-item", {
            "item_id": item_id,
            "status": status,
        })

    def update_task(self, item_id: str, **updates) -> dict:
        """Update any task fields: title, description, status, priority, due_date."""
        params = {"item_id": item_id}
        for key in ("title", "description", "status", "priority", "due_date"):
            if key in updates and updates[key] is not None:
                params[key] = updates[key]
        return self._patch("/internal/update-item", params)

    # ── Convenience helpers ─────────────────────────────────────

    def mention_dallas(self, item_id: str, message: str) -> dict:
        """Add a comment mentioning Dallas for HITL notification."""
        content = f"@[Dallas]({DALLAS_UUID}) — {message}"
        return self.add_comment(item_id, content)

    def create_subtask(self, parent_id: str, title: str,
                       description: str = "", **kwargs) -> dict:
        """Create a subtask under a parent task."""
        return self.create_task(
            title=title, description=description,
            parent_id=parent_id, **kwargs,
        )

    def complete(self, item_id: str) -> dict:
        """Mark a task as completed."""
        return self.update_status(item_id, "completed")
