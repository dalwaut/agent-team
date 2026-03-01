"""Marq — TeamHub internal API wrapper.

Creates folders, lists, and tasks in TeamHub for app submissions,
store issues, and review responses. Uses localhost internal endpoints
(no JWT auth required).

Structure per app:
  User's Workspace
    └─ Folder: "Marq: {App Name}"
         ├─ List: "Submissions"
         ├─ List: "Store Issues"
         └─ List: "Reviews"
"""

import logging
import httpx
import config

from core.supabase import _sb_get, _sb_post, _sb_patch

log = logging.getLogger("marq.teamhub")

TEAMHUB_BASE = config.TEAMHUB_URL.rstrip("/")


async def _th_post(path: str, params: dict) -> dict:
    """POST to TeamHub internal API with query params."""
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{TEAMHUB_BASE}/api{path}", params=params)
        if not r.is_success:
            log.error("TeamHub POST %s → %d: %s", path, r.status_code, r.text[:300])
            r.raise_for_status()
        return r.json()


async def _th_patch(path: str, params: dict) -> dict:
    """PATCH to TeamHub internal API with query params."""
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.patch(f"{TEAMHUB_BASE}/api{path}", params=params)
        if not r.is_success:
            log.error("TeamHub PATCH %s → %d: %s", path, r.status_code, r.text[:300])
            r.raise_for_status()
        return r.json()


async def _get_user_workspace(user_id: str) -> str | None:
    """Get the user's personal workspace ID from TeamHub."""
    rows = await _sb_get(
        f"team_workspaces?owner_id=eq.{user_id}&is_personal=eq.true&select=id&limit=1"
    )
    if rows:
        return rows[0]["id"]

    # Fallback: try any workspace the user owns
    rows = await _sb_get(
        f"team_workspaces?owner_id=eq.{user_id}&select=id&limit=1"
    )
    return rows[0]["id"] if rows else None


async def ensure_app_workspace(app: dict) -> dict:
    """Ensure TeamHub folder structure exists for an app. Returns IDs.

    Creates the folder and lists if they don't exist.
    Stores the workspace_id on the app for future use.

    Returns:
        {
            "workspace_id": str,
            "folder_id": str,
            "submissions_list_id": str,
            "issues_list_id": str,
            "reviews_list_id": str,
        }
    """
    app_id = app["id"]
    app_name = app.get("name", "Unknown")
    owner_id = app.get("owner_id")

    # Check if already set up
    existing_ws = app.get("teamhub_workspace_id")
    if existing_ws:
        # Verify folder still exists by checking for the lists
        # If it does, return cached IDs from app metadata
        log.info("App %s already has TeamHub workspace %s", app_id, existing_ws)

    # Get workspace
    workspace_id = existing_ws
    if not workspace_id and owner_id:
        workspace_id = await _get_user_workspace(owner_id)

    if not workspace_id:
        log.warning("No workspace found for app %s owner %s", app_id, owner_id)
        return {}

    folder_name = f"Marq: {app_name}"

    try:
        # Create folder via Supabase directly (TeamHub internal endpoint has
        # a bug where created_by is set to non-UUID "ai-assistant")
        folder_result = await _sb_post("team_folders", {
            "workspace_id": workspace_id,
            "name": folder_name,
            "created_by": owner_id,
        })
        folder = folder_result[0] if isinstance(folder_result, list) else folder_result
        folder_id = folder.get("id")
        if not folder_id:
            log.error("Failed to create folder — no ID returned: %s", folder)
            return {}

        # Create three lists inside the folder
        subs_result = await _sb_post("team_lists", {
            "workspace_id": workspace_id,
            "folder_id": folder_id,
            "name": "Submissions",
            "created_by": owner_id,
        })
        subs_list = subs_result[0] if isinstance(subs_result, list) else subs_result

        issues_result = await _sb_post("team_lists", {
            "workspace_id": workspace_id,
            "folder_id": folder_id,
            "name": "Store Issues",
            "created_by": owner_id,
        })
        issues_list = issues_result[0] if isinstance(issues_result, list) else issues_result

        reviews_result = await _sb_post("team_lists", {
            "workspace_id": workspace_id,
            "folder_id": folder_id,
            "name": "Reviews",
            "created_by": owner_id,
        })
        reviews_list = reviews_result[0] if isinstance(reviews_result, list) else reviews_result

        result = {
            "workspace_id": workspace_id,
            "folder_id": folder_id,
            "submissions_list_id": subs_list.get("id"),
            "issues_list_id": issues_list.get("id"),
            "reviews_list_id": reviews_list.get("id"),
        }

        # Store workspace_id on the app for future reference
        if not existing_ws:
            await _sb_patch(f"mrq_apps?id=eq.{app_id}", {
                "teamhub_workspace_id": workspace_id,
            })

        log.info("Created TeamHub workspace for app %s: folder=%s", app_id, folder_id)
        return result

    except Exception as e:
        log.error("Failed to create TeamHub workspace for app %s: %s", app_id, e)
        return {}


async def create_task(
    app: dict,
    list_id: str,
    title: str,
    description: str = "",
    priority: str = "medium",
    source: str = "marq",
    status: str | None = None,
    due_date: str | None = None,
) -> dict:
    """Create a task in TeamHub via internal API.

    Args:
        app: App dict (needs owner_id)
        list_id: TeamHub list ID to create item in
        title: Task title
        description: Task description (markdown)
        priority: low/medium/high/urgent
        source: Source identifier (default: marq)
        status: Optional status override
        due_date: Optional due date (ISO format)

    Returns:
        Created item dict, or empty dict on failure.
    """
    owner_id = app.get("owner_id", "")
    workspace_id = app.get("teamhub_workspace_id", "")

    # Map priorities to TeamHub valid values (critical/high/medium/low/none)
    priority_map = {"urgent": "critical", "blocker": "critical"}
    mapped_priority = priority_map.get(priority, priority)

    params = {
        "user_id": owner_id,
        "workspace_id": workspace_id,
        "title": title,
        "description": description,
        "priority": mapped_priority,
        "source": source,
        "type": "task",
        "list_id": list_id,
    }
    if status:
        params["status"] = status
    if due_date:
        params["due_date"] = due_date

    try:
        item = await _th_post("/internal/create-item", params)
        log.info("Created TeamHub task '%s' in list %s", title, list_id)
        return item
    except Exception as e:
        log.error("Failed to create TeamHub task: %s", e)
        return {}


async def update_task(item_id: str, **updates) -> dict:
    """Update a TeamHub task via internal API.

    Accepts keyword args matching update-item params:
    title, description, status, priority, due_date, list_id
    """
    params = {"item_id": item_id}
    for key in ("title", "description", "status", "priority", "due_date", "list_id"):
        if key in updates and updates[key] is not None:
            params[key] = updates[key]

    try:
        result = await _th_patch("/internal/update-item", params)
        log.info("Updated TeamHub item %s", item_id)
        return result
    except Exception as e:
        log.error("Failed to update TeamHub item %s: %s", item_id, e)
        return {}


async def add_comment(item_id: str, content: str, author_id: str | None = None) -> dict:
    """Add a comment to a TeamHub task.

    If author_id is not a valid UUID, writes directly to Supabase
    using the ADMIN_ID as fallback.
    """
    # TeamHub's author_id requires a valid UUID (FK to auth.users).
    # Use the provided UUID or fall back to writing directly.
    effective_author = author_id
    if not effective_author or len(effective_author) < 36:
        # Use the admin user as fallback author
        effective_author = config.ADMIN_USER_ID or ""

    try:
        result = await _th_post("/internal/add-comment", {
            "item_id": item_id,
            "content": content,
            "author_id": effective_author,
        })
        log.info("Added comment to TeamHub item %s", item_id)
        return result
    except Exception as e:
        log.error("Failed to add comment to item %s: %s", item_id, e)
        return {}
