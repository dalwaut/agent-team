#!/usr/bin/env python3
"""OPAI Team Hub — ClickUp Migration Tool.

Imports all ClickUp spaces, folders, lists, tasks, comments, and tags
into the Team Hub database. Creates one workspace per ClickUp space,
preserves hierarchy via tags, and maps assignees where possible.

Usage:
    python3 clickup_migrate.py                    # Full migration
    python3 clickup_migrate.py --dry-run          # Preview without writing
    python3 clickup_migrate.py --space 10797301   # Migrate single space
"""

import argparse
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

# Load env
sys.path.insert(0, str(Path(__file__).parent))
from dotenv import load_dotenv
load_dotenv()

# ── Config ──────────────────────────────────────────────────

CLICKUP_API_KEY = os.getenv("CLICKUP_API_KEY", "pk_12684773_506E7BHJVG1DWN9GTHKM2LF9WSO5HQHN")
CLICKUP_TEAM_ID = os.getenv("CLICKUP_TEAM_ID", "8500473")
CLICKUP_BASE = "https://api.clickup.com/api/v2"

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# The OPAI user who "owns" imported workspaces (admin)
OWNER_USER_ID = os.getenv("MIGRATION_OWNER_ID", "1c93c5fe-d304-40f2-9169-765d0d2b7638")  # Dallas


# ── Helpers ─────────────────────────────────────────────────

def cu_headers():
    return {"Authorization": CLICKUP_API_KEY}


def sb_headers():
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def sb_url(table):
    return f"{SUPABASE_URL}/rest/v1/{table}"


def ts_to_iso(ms_str):
    """Convert ClickUp millisecond timestamp to ISO datetime."""
    if not ms_str:
        return None
    try:
        return datetime.fromtimestamp(int(ms_str) / 1000, tz=timezone.utc).isoformat()
    except (ValueError, TypeError):
        return None


def ts_to_date(ms_str):
    """Convert ClickUp millisecond timestamp to date string."""
    if not ms_str:
        return None
    try:
        return datetime.fromtimestamp(int(ms_str) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return None


STATUS_MAP = {
    "to do": "open",
    "not started": "open",
    "open": "open",
    "in progress": "in_progress",
    "in review": "review",
    "review": "review",
    "complete": "done",
    "closed": "done",
    "done": "done",
    "archived": "archived",
}

PRIORITY_MAP = {
    "urgent": "critical",
    "high": "high",
    "normal": "medium",
    "low": "low",
    None: "medium",
}


def map_status(cu_status):
    return STATUS_MAP.get((cu_status or "").lower().strip(), "open")


def map_priority(cu_priority):
    if isinstance(cu_priority, dict):
        cu_priority = cu_priority.get("priority")
    return PRIORITY_MAP.get(cu_priority, "medium")


def slugify(text):
    import re
    slug = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')
    return slug[:50] or 'workspace'


# ── ClickUp API ─────────────────────────────────────────────

def cu_get(path, params=None):
    """Make a GET request to ClickUp API with rate limit handling."""
    url = f"{CLICKUP_BASE}{path}"
    resp = httpx.get(url, headers=cu_headers(), params=params, timeout=30.0)
    if resp.status_code == 429:
        wait = int(resp.headers.get("Retry-After", "5"))
        print(f"  [rate-limit] waiting {wait}s...")
        time.sleep(wait)
        resp = httpx.get(url, headers=cu_headers(), params=params, timeout=30.0)
    resp.raise_for_status()
    return resp.json()


# ── Migration Logic ─────────────────────────────────────────

class Migrator:
    def __init__(self, dry_run=False):
        self.dry_run = dry_run
        self.client = httpx.Client(timeout=15.0)
        self.stats = {"spaces": 0, "folders": 0, "lists": 0, "tasks": 0, "comments": 0, "tags": 0, "skipped": 0}
        # Cache: ClickUp tag name → Team Hub tag ID (per workspace)
        self.tag_cache = {}  # (ws_id, tag_name) → tag_id
        # Cache: ClickUp member email → OPAI user ID
        self.user_map = {}
        # Cache: folder/list names → DB record IDs (per workspace)
        self.folder_cache = {}  # (ws_id, folder_name) → folder_id
        self.list_cache = {}  # (ws_id, folder_name|None, list_name) → list_id

    def sb_post(self, table, data):
        if self.dry_run:
            return {**data, "id": str(uuid.uuid4())}
        resp = self.client.post(sb_url(table), headers=sb_headers(), json=data)
        if resp.status_code >= 400:
            print(f"  [ERROR] POST {table}: {resp.status_code} {resp.text[:200]}")
            return None
        rows = resp.json()
        return rows[0] if rows else data

    def sb_get(self, table, params):
        resp = self.client.get(sb_url(table), headers=sb_headers(), params=params)
        if resp.status_code >= 400:
            return []
        return resp.json()

    def load_user_map(self):
        """Build email→user_id map from OPAI profiles."""
        profiles = self.sb_get("profiles", {"select": "id,email"})
        for p in profiles:
            if p.get("email"):
                self.user_map[p["email"].lower()] = p["id"]
        print(f"  Loaded {len(self.user_map)} OPAI user profiles")

    def get_or_create_tag(self, ws_id, tag_name, color="#6366f1"):
        key = (ws_id, tag_name.lower())
        if key in self.tag_cache:
            return self.tag_cache[key]

        # Check existing
        existing = self.sb_get("team_tags", {
            "workspace_id": f"eq.{ws_id}",
            "name": f"eq.{tag_name}",
        })
        if existing:
            self.tag_cache[key] = existing[0]["id"]
            return existing[0]["id"]

        tag = self.sb_post("team_tags", {
            "workspace_id": ws_id,
            "name": tag_name,
            "color": color,
        })
        if tag and tag.get("id"):
            self.tag_cache[key] = tag["id"]
            self.stats["tags"] += 1
            return tag["id"]
        return None

    def resolve_assignee(self, cu_assignee):
        """Try to map ClickUp assignee to OPAI user."""
        email = (cu_assignee.get("email") or "").lower()
        if email in self.user_map:
            return self.user_map[email]
        return None

    def get_or_create_folder(self, ws_id, folder_name):
        """Get or create a team_folders record, return folder_id."""
        key = (ws_id, folder_name)
        if key in self.folder_cache:
            return self.folder_cache[key]

        folder = self.sb_post("team_folders", {
            "workspace_id": ws_id,
            "name": folder_name,
            "created_by": OWNER_USER_ID,
        })
        if folder and folder.get("id"):
            self.folder_cache[key] = folder["id"]
            self.stats["folders"] += 1
            return folder["id"]
        return None

    def get_or_create_list(self, ws_id, list_name, folder_id=None):
        """Get or create a team_lists record, return list_id."""
        key = (ws_id, folder_id, list_name)
        if key in self.list_cache:
            return self.list_cache[key]

        data = {
            "workspace_id": ws_id,
            "name": list_name,
            "created_by": OWNER_USER_ID,
        }
        if folder_id:
            data["folder_id"] = folder_id

        lst = self.sb_post("team_lists", data)
        if lst and lst.get("id"):
            self.list_cache[key] = lst["id"]
            return lst["id"]
        return None

    def create_workspace(self, space):
        """Create a Team Hub workspace from a ClickUp space."""
        name = space["name"]
        slug = f"cu-{slugify(name)}-{int(time.time()) % 100000}"

        print(f"\n{'[DRY] ' if self.dry_run else ''}Creating workspace: {name}")

        # Check if already migrated (by slug prefix)
        existing = self.sb_get("team_workspaces", {
            "slug": f"like.cu-{slugify(name)}%",
        })
        if existing:
            print(f"  Workspace already exists: {existing[0]['slug']}")
            return existing[0]["id"]

        ws = self.sb_post("team_workspaces", {
            "name": name,
            "slug": slug,
            "icon": "📋",
            "owner_id": OWNER_USER_ID,
            "is_personal": False,
        })
        if not ws or not ws.get("id"):
            print(f"  [ERROR] Failed to create workspace for {name}")
            return None

        ws_id = ws["id"]

        # Add owner membership
        self.sb_post("team_membership", {
            "user_id": OWNER_USER_ID,
            "workspace_id": ws_id,
            "role": "owner",
        })

        self.stats["spaces"] += 1
        return ws_id

    def migrate_task(self, ws_id, task, folder_name=None, list_name=None,
                     folder_id=None, list_id=None):
        """Import a single ClickUp task into Team Hub."""
        title = task.get("name", "Untitled")
        description = task.get("description") or ""

        # Add ClickUp metadata to description
        meta_lines = []
        if folder_name:
            meta_lines.append(f"Folder: {folder_name}")
        if list_name:
            meta_lines.append(f"List: {list_name}")
        meta_lines.append(f"ClickUp ID: {task.get('id', '')}")
        if task.get("url"):
            meta_lines.append(f"Original: {task['url']}")

        if meta_lines:
            description = description.rstrip() + "\n\n---\n" + "\n".join(meta_lines)

        status = map_status(task.get("status", {}).get("status") if isinstance(task.get("status"), dict) else task.get("status"))
        priority = map_priority(task.get("priority"))
        due_date = ts_to_date(task.get("due_date"))

        item_data = {
            "workspace_id": ws_id,
            "type": "task",
            "title": title,
            "description": description,
            "status": status,
            "priority": priority,
            "due_date": due_date,
            "source": "clickup",
            "created_by": OWNER_USER_ID,
        }
        if list_id:
            item_data["list_id"] = list_id
        if folder_id:
            item_data["folder_id"] = folder_id

        item = self.sb_post("team_items", item_data)

        if not item or not item.get("id"):
            self.stats["skipped"] += 1
            return None

        item_id = item["id"]
        self.stats["tasks"] += 1

        # Assign to mapped users
        for assignee in task.get("assignees", []):
            opai_user_id = self.resolve_assignee(assignee)
            if opai_user_id:
                self.sb_post("team_assignments", {
                    "item_id": item_id,
                    "assignee_type": "user",
                    "assignee_id": opai_user_id,
                    "assigned_by": OWNER_USER_ID,
                })
            else:
                # Store as text assignment for reference
                username = assignee.get("username", assignee.get("email", "unknown"))
                self.sb_post("team_assignments", {
                    "item_id": item_id,
                    "assignee_type": "user",
                    "assignee_id": f"clickup:{username}",
                    "assigned_by": OWNER_USER_ID,
                })

        # Tags (skip folder:/list: prefixed tags — hierarchy is in list_id/folder_id now)
        for tag in task.get("tags", []):
            tag_name = tag.get("name") if isinstance(tag, dict) else str(tag)
            if tag_name:
                tag_id = self.get_or_create_tag(ws_id, tag_name,
                                                 tag.get("tag_fg", "#6366f1") if isinstance(tag, dict) else "#6366f1")
                if tag_id:
                    self.sb_post("team_item_tags", {"item_id": item_id, "tag_id": tag_id})

        return item_id

    def migrate_task_comments(self, item_id, cu_task_id):
        """Import comments from a ClickUp task."""
        try:
            data = cu_get(f"/task/{cu_task_id}/comment")
            comments = data.get("comments", [])
        except Exception as e:
            print(f"    [WARN] Failed to fetch comments for {cu_task_id}: {e}")
            return

        for comment in comments:
            text = comment.get("comment_text", "")
            if not text or not text.strip():
                continue

            author_email = (comment.get("user", {}).get("email") or "").lower()
            author_id = self.user_map.get(author_email, OWNER_USER_ID)
            author_name = comment.get("user", {}).get("username", "Unknown")

            content = f"**{author_name}** (from ClickUp):\n{text}"

            self.sb_post("team_comments", {
                "item_id": item_id,
                "author_id": author_id,
                "content": content,
                "is_agent_report": False,
            })
            self.stats["comments"] += 1

    def migrate_list(self, ws_id, cu_list_id, list_name, folder_name=None):
        """Import all tasks from a ClickUp list."""
        print(f"  List: {list_name} (folder: {folder_name or 'root'})")

        # Create folder/list records for hierarchy
        folder_id = None
        if folder_name:
            folder_id = self.get_or_create_folder(ws_id, folder_name)

        hub_list_id = self.get_or_create_list(ws_id, list_name, folder_id)

        page = 0
        while True:
            try:
                data = cu_get(f"/list/{cu_list_id}/task", {
                    "include_closed": "true",
                    "subtasks": "true",
                    "page": str(page),
                })
            except Exception as e:
                print(f"    [ERROR] Failed to fetch tasks: {e}")
                break

            tasks = data.get("tasks", [])
            if not tasks:
                break

            for task in tasks:
                item_id = self.migrate_task(
                    ws_id, task, folder_name, list_name,
                    folder_id=folder_id, list_id=hub_list_id,
                )
                if item_id and not self.dry_run:
                    self.migrate_task_comments(item_id, task["id"])
                    time.sleep(0.2)  # Rate limit courtesy

            self.stats["lists"] += 1

            if data.get("last_page", True):
                break
            page += 1

    def migrate_space(self, space_id):
        """Import an entire ClickUp space into a Team Hub workspace."""
        space = cu_get(f"/space/{space_id}")
        ws_id = self.create_workspace(space)
        if not ws_id:
            return

        # Folderless lists
        try:
            lists_data = cu_get(f"/space/{space_id}/list")
            for lst in lists_data.get("lists", []):
                self.migrate_list(ws_id, lst["id"], lst["name"])
        except Exception as e:
            print(f"  [WARN] Folderless lists: {e}")

        # Folder lists
        try:
            folders_data = cu_get(f"/space/{space_id}/folder")
            for folder in folders_data.get("folders", []):
                for lst in folder.get("lists", []):
                    self.migrate_list(ws_id, lst["id"], lst["name"], folder["name"])
        except Exception as e:
            print(f"  [WARN] Folders: {e}")

    def run(self, space_filter=None):
        """Run the full migration."""
        print("=" * 60)
        print("OPAI Team Hub — ClickUp Migration")
        print("=" * 60)
        if self.dry_run:
            print("[DRY RUN — no data will be written]")

        self.load_user_map()

        # Get all spaces
        data = cu_get(f"/team/{CLICKUP_TEAM_ID}/space", {"archived": "false"})
        spaces = data.get("spaces", [])
        print(f"\nFound {len(spaces)} ClickUp spaces")

        for space in spaces:
            if space_filter and str(space["id"]) != str(space_filter):
                continue
            self.migrate_space(space["id"])
            time.sleep(0.5)  # Rate limit

        print("\n" + "=" * 60)
        print("Migration Complete!")
        print(f"  Spaces:   {self.stats['spaces']}")
        print(f"  Folders:  {self.stats['folders']}")
        print(f"  Lists:    {self.stats['lists']}")
        print(f"  Tasks:    {self.stats['tasks']}")
        print(f"  Comments: {self.stats['comments']}")
        print(f"  Tags:     {self.stats['tags']}")
        print(f"  Skipped:  {self.stats['skipped']}")
        print("=" * 60)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate ClickUp data to OPAI Team Hub")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument("--space", type=str, help="Migrate only this space ID")
    args = parser.parse_args()

    migrator = Migrator(dry_run=args.dry_run)
    migrator.run(space_filter=args.space)
