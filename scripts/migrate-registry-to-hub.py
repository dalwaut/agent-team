#!/usr/bin/env python3
"""Migrate work tasks from tasks/registry.json to Team Hub workspaces.

Reads the registry, filters to project-specific work tasks, creates
corresponding items in Team Hub (via Supabase REST API), and tags them
with registry:{task_id} for bidirectional traceability.

Usage:
    python3 scripts/migrate-registry-to-hub.py          # dry-run (default)
    python3 scripts/migrate-registry-to-hub.py --apply   # actually create items
"""

import json
import sys
import os
import urllib.request
import urllib.error

# ── Config ──────────────────────────────────────────────────────

SUPABASE_URL = "https://idorgloobxkmlnwnxbej.supabase.co"
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlkb3JnbG9vYnhrbWxud254YmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4Mzk2NzUsImV4cCI6MjA4NjQxNTY3NX0.zJ9L0QbKLFlNs1PV_yhlEjd0SbJ9XPTaBC7dxDul30I")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlkb3JnbG9vYnhrbWxud254YmVqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDgzOTY3NSwiZXhwIjoyMDg2NDE1Njc1fQ.TXLI1QnYqJwUCFejlXR0AKh5xwDVhi5nALrAGUFZs2c")

ADMIN_USER_ID = "1c93c5fe-d304-40f2-9169-765d0d2b7638"

REGISTRY_PATH = os.path.join(os.path.dirname(__file__), "..", "tasks", "registry.json")

# ── Project → Workspace mapping ────────────────────────────────

WORKSPACE_MAP = {
    "Everglades-News":  "9503ddda-eea0-4b60-a2bc-cd5c072206d1",  # Paradise Web
    "Lace & Pearl":     "2f021a6c-2ca3-43fd-ac7c-9977b2607762",  # Lace & Pearl
    "BoutaCare":        "5f158f9d-de71-4db1-bd05-87684f34da30",  # BoutaByte
    "Westberg":         "562d881e-8df5-439a-b8ec-ab33635d3b91",  # Pioneers of Personal Development
    "Boutabyte":        "5f158f9d-de71-4db1-bd05-87684f34da30",  # BoutaByte
}

# Fallback for tasks without a project match
PERSONAL_WORKSPACE = "80753c5a-beb5-498c-8d71-393a0342af27"  # Dallas's Space

# Tasks with null project that have specific workspace homes
NULL_PROJECT_MAP = {
    "t-20260212-011": "125eced4-f25a-47fa-a960-1f1415697498",  # MDH video manager → Morning Dew Homestead
    "t-20260212-049": "80753c5a-beb5-498c-8d71-393a0342af27",  # Supabase password → personal
}

# System tasks — stay in registry, do NOT migrate
SYSTEM_TASK_IDS = {
    "t-20260212-001",   # Claude Code settings migration
    "t-20260212-018",   # Google Cloud credentials (agent)
    "t-20260212-048",   # ngrok agent upgrade
    "t-20260212-050",   # BoutaCare Supabase security (agent)
    "t-20260212-058",   # Email checker enhancement (agent)
    "t-20260213-001",   # opai-chat integration (agent)
}


# ── Supabase helpers ───────────────────────────────────────────

def sb_headers():
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def sb_request(method, table, data=None, params=None):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    if params:
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        url += f"?{qs}"

    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=sb_headers(), method=method)

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f"  ERROR {e.code}: {err_body}")
        return None


def find_existing_tag(workspace_id, tag_name):
    """Check if a registry tag already exists in this workspace."""
    result = sb_request("GET", "team_tags", params={
        "workspace_id": f"eq.{workspace_id}",
        "name": f"eq.{tag_name}",
    })
    return result[0] if result else None


def find_item_by_tag(tag_id):
    """Find a team item linked to this tag."""
    result = sb_request("GET", "team_item_tags", params={
        "tag_id": f"eq.{tag_id}",
        "select": "item_id",
    })
    return result[0]["item_id"] if result else None


def create_tag(workspace_id, name, color="#6366f1"):
    """Create a tag in the workspace."""
    return sb_request("POST", "team_tags", data={
        "workspace_id": workspace_id,
        "name": name,
        "color": color,
    })


def link_tag_to_item(item_id, tag_id):
    """Associate a tag with an item."""
    return sb_request("POST", "team_item_tags", data={
        "item_id": item_id,
        "tag_id": tag_id,
    })


def create_item(workspace_id, task):
    """Create a team_items row from a registry task."""
    priority_map = {"urgent": "urgent", "high": "high", "normal": "medium", "low": "low"}
    item_data = {
        "workspace_id": workspace_id,
        "type": "task",
        "title": task["title"],
        "description": build_description(task),
        "priority": priority_map.get(task.get("priority", "normal"), "medium"),
        "source": f"registry:{task['source']}",
        "created_by": ADMIN_USER_ID,
    }
    if task.get("due_date") or task.get("deadline"):
        deadline = task.get("due_date") or task.get("deadline")
        # Only use ISO date strings, skip relative ones
        if deadline and len(deadline) == 10 and deadline[4] == "-":
            item_data["due_date"] = deadline

    return sb_request("POST", "team_items", data=item_data)


def build_description(task):
    """Build a rich description from registry task fields."""
    parts = [task.get("description", "")]

    ref = task.get("sourceRef", {})
    if ref.get("sender"):
        parts.append(f"\n---\n**Source**: {ref.get('senderName', '')} <{ref['sender']}>")
        if ref.get("subject"):
            parts.append(f"**Subject**: {ref['subject']}")

    parts.append(f"\n**Registry ID**: `{task['id']}`")

    if task.get("assignee") and task["assignee"] not in ("human", "agent"):
        parts.append(f"**Assigned to**: {task['assignee']}")

    if task.get("notes"):
        parts.append(f"\n**Notes**: {task['notes']}")

    return "\n".join(parts)


# ── Main ───────────────────────────────────────────────────────

def resolve_workspace(task):
    """Determine the target workspace ID for a task."""
    task_id = task["id"]
    project = task.get("project")

    # Check specific null-project overrides
    if task_id in NULL_PROJECT_MAP:
        return NULL_PROJECT_MAP[task_id]

    # Check project mapping
    if project and project in WORKSPACE_MAP:
        return WORKSPACE_MAP[project]

    # Fallback to personal
    if project:
        print(f"  WARNING: No workspace mapping for project '{project}', using personal")
    return PERSONAL_WORKSPACE


def main():
    apply = "--apply" in sys.argv

    with open(REGISTRY_PATH) as f:
        registry = json.load(f)

    tasks = registry.get("tasks", {})
    work_tasks = {tid: t for tid, t in tasks.items() if tid not in SYSTEM_TASK_IDS}

    print(f"Registry: {len(tasks)} total, {len(work_tasks)} work tasks, {len(SYSTEM_TASK_IDS)} system tasks")
    print(f"Mode: {'APPLY' if apply else 'DRY RUN'}\n")

    created = 0
    skipped = 0
    errors = 0

    for tid, task in sorted(work_tasks.items()):
        ws_id = resolve_workspace(task)
        tag_name = f"registry:{tid}"
        status = task.get("status", "pending")
        project = task.get("project") or "(none)"

        print(f"[{tid}] {task['title'][:60]}")
        print(f"  Project: {project} → Workspace: {ws_id[:8]}...")

        # Check for existing tag (dedup)
        existing = find_existing_tag(ws_id, tag_name)
        if existing:
            item_id = find_item_by_tag(existing["id"])
            print(f"  SKIP: Already migrated (tag exists, item={item_id})")
            skipped += 1
            continue

        if not apply:
            print(f"  DRY RUN: Would create item + tag '{tag_name}'")
            skipped += 1
            continue

        # Create the item
        item = create_item(ws_id, task)
        if not item:
            print(f"  FAILED to create item")
            errors += 1
            continue

        item_id = item[0]["id"] if isinstance(item, list) else item["id"]

        # Create the registry tag
        tag = create_tag(ws_id, tag_name)
        if tag:
            tag_id = tag[0]["id"] if isinstance(tag, list) else tag["id"]
            link_tag_to_item(item_id, tag_id)
            print(f"  CREATED: item={item_id[:8]}..., tag={tag_id[:8]}...")
        else:
            print(f"  CREATED item={item_id[:8]}... but tag creation failed")

        created += 1

    print(f"\n{'='*50}")
    print(f"Results: {created} created, {skipped} skipped, {errors} errors")
    if not apply:
        print("Run with --apply to actually create items.")


if __name__ == "__main__":
    main()
