#!/usr/bin/env python3
"""One-time migration: Replace statuses on all TeamHub workspaces
except 'Dallas's Space' and 'OPAI Workers'.

New statuses (in order):
  Not Started, Working on, Manager Review, Back to You, Stuck,
  Waiting on Client, Client Review, Approved, Postponed,
  Quality Review, Complete (closed)

Also migrates existing items' status values to new names.
"""

import json
import os
import sys

import httpx

# Load from vault env
env_file = "/run/user/1000/opai-vault/opai-team-hub.env"
if os.path.exists(env_file):
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, val = line.split("=", 1)
                os.environ[key] = val.strip('"')

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

EXCLUDE_WORKSPACES = {
    "80753c5a-beb5-498c-8d71-393a0342af27",  # Dallas's Space
    "d27944f3-8079-4e40-9e5d-c323d6cf7b0f",  # OPAI Workers
}

NEW_STATUSES = [
    {"name": "Not Started",       "color": "#d3d3d3", "type": "active",  "orderindex": 0},
    {"name": "Working on",        "color": "#fdcb6e", "type": "active",  "orderindex": 1},
    {"name": "Manager Review",    "color": "#6c5ce7", "type": "active",  "orderindex": 2},
    {"name": "Back to You",       "color": "#e17055", "type": "active",  "orderindex": 3},
    {"name": "Stuck",             "color": "#d63031", "type": "active",  "orderindex": 4},
    {"name": "Waiting on Client", "color": "#fd79a8", "type": "active",  "orderindex": 5},
    {"name": "Client Review",     "color": "#a29bfe", "type": "active",  "orderindex": 6},
    {"name": "Approved",          "color": "#00cec9", "type": "active",  "orderindex": 7},
    {"name": "Postponed",         "color": "#636e72", "type": "active",  "orderindex": 8},
    {"name": "Quality Review",    "color": "#74b9ff", "type": "active",  "orderindex": 9},
    {"name": "Complete",          "color": "#00b894", "type": "closed",  "orderindex": 10},
]

# Map old status names to new ones for item migration
STATUS_MIGRATION_MAP = {
    "open":        "Not Started",
    "to do":       "Not Started",
    "in progress": "Working on",
    "in_progress": "Working on",
    "review":      "Manager Review",
    "done":        "Complete",
    "closed":      "Complete",
    "blocked":     "Stuck",
    "archived":    "Complete",
}


def sb_url(table: str) -> str:
    return f"{SUPABASE_URL}/rest/v1/{table}"


def main():
    dry_run = "--dry-run" in sys.argv
    if dry_run:
        print("=== DRY RUN MODE ===\n")

    client = httpx.Client(timeout=30.0)

    # 1. Get all workspaces
    resp = client.get(
        sb_url("team_workspaces"),
        headers=HEADERS,
        params={"select": "id,name", "order": "name.asc"},
    )
    workspaces = resp.json()
    print(f"Found {len(workspaces)} workspaces total")

    target_workspaces = [w for w in workspaces if w["id"] not in EXCLUDE_WORKSPACES]
    print(f"Targeting {len(target_workspaces)} workspaces (excluding Dallas's Space, OPAI Workers)\n")

    for ws in target_workspaces:
        ws_id = ws["id"]
        ws_name = ws["name"]
        print(f"--- {ws_name} ({ws_id}) ---")

        # 2. Get current statuses
        resp = client.get(
            sb_url("team_statuses"),
            headers=HEADERS,
            params={"workspace_id": f"eq.{ws_id}", "select": "id,name", "order": "orderindex.asc"},
        )
        current_statuses = resp.json() if resp.status_code < 400 else []
        current_names = [s["name"] for s in current_statuses]
        print(f"  Current statuses: {current_names}")

        # 3. Migrate items' status values
        for old_name, new_name in STATUS_MIGRATION_MAP.items():
            if dry_run:
                # Check how many items would be affected
                resp = client.get(
                    sb_url("team_items"),
                    headers=HEADERS,
                    params={
                        "workspace_id": f"eq.{ws_id}",
                        "status": f"eq.{old_name}",
                        "select": "id",
                    },
                )
                count = len(resp.json()) if resp.status_code < 400 else 0
                if count:
                    print(f"  Would migrate {count} items: '{old_name}' -> '{new_name}'")
            else:
                resp = client.patch(
                    sb_url("team_items"),
                    headers={**HEADERS, "Prefer": "return=minimal"},
                    params={
                        "workspace_id": f"eq.{ws_id}",
                        "status": f"eq.{old_name}",
                    },
                    json={"status": new_name},
                )
                if resp.status_code < 400:
                    # Count affected rows from content-range header
                    print(f"  Migrated items: '{old_name}' -> '{new_name}'")
                else:
                    print(f"  WARN: Failed to migrate '{old_name}': {resp.status_code}")

        # 4. Delete old statuses
        for status in current_statuses:
            if dry_run:
                print(f"  Would delete status: '{status['name']}' ({status['id']})")
            else:
                resp = client.delete(
                    sb_url("team_statuses"),
                    headers={**HEADERS, "Prefer": "return=minimal"},
                    params={"id": f"eq.{status['id']}"},
                )
                if resp.status_code < 400:
                    print(f"  Deleted status: '{status['name']}'")
                else:
                    print(f"  WARN: Failed to delete '{status['name']}': {resp.status_code}")

        # 5. Create new statuses
        for new_status in NEW_STATUSES:
            payload = {**new_status, "workspace_id": ws_id}
            if dry_run:
                print(f"  Would create status: '{new_status['name']}' (order {new_status['orderindex']}, type {new_status['type']})")
            else:
                resp = client.post(
                    sb_url("team_statuses"),
                    headers=HEADERS,
                    json=payload,
                )
                if resp.status_code < 400:
                    print(f"  Created status: '{new_status['name']}'")
                else:
                    print(f"  WARN: Failed to create '{new_status['name']}': {resp.status_code} {resp.text}")

        print()

    print("Done!" + (" (dry run — no changes made)" if dry_run else ""))
    client.close()


if __name__ == "__main__":
    main()
