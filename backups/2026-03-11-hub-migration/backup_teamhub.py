#!/usr/bin/env python3
"""Backup TeamHub Supabase tables to JSON files before migration."""

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

BACKUP_DIR = "/workspace/synced/opai/backups/2026-03-11-hub-migration"
PROJECT_ID = "idorgloobxkmlnwnxbej"
BASE_URL = f"https://{PROJECT_ID}.supabase.co/rest/v1"

# Read service key from vault
def get_service_key():
    vault_path = f"/run/user/{os.getuid()}/opai-vault/opai-engine.env"
    with open(vault_path) as f:
        for line in f:
            if line.startswith("SUPABASE_SERVICE_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("SUPABASE_SERVICE_KEY not found in vault env")

SERVICE_KEY = get_service_key()

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "count=exact",
}

# Tables to backup: (table_name, select_columns or None for all)
TABLES = [
    ("team_workspaces", None),
    ("team_statuses", None),
    ("team_tags", None),
    ("team_membership", None),
    ("team_items", "id,workspace_id,title,status,priority,type"),
]

def fetch_table(table: str, select: str | None = None) -> list[dict]:
    """Fetch all rows from a table using pagination (PostgREST limit is 1000)."""
    all_rows = []
    offset = 0
    page_size = 1000

    while True:
        url = f"{BASE_URL}/{table}?"
        if select:
            url += f"select={select}&"
        url += f"limit={page_size}&offset={offset}"

        req = urllib.request.Request(url, headers=HEADERS, method="GET")
        # Add Range header for count
        req.add_header("Range-Unit", "items")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
                if not data:
                    break
                all_rows.extend(data)
                if len(data) < page_size:
                    break
                offset += page_size
        except urllib.error.HTTPError as e:
            body = e.read().decode() if e.fp else ""
            print(f"  ERROR fetching {table}: {e.code} {e.reason} — {body}", file=sys.stderr)
            sys.exit(1)

    return all_rows


def main():
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "purpose": "TeamHub table backup before migration",
        "project_id": PROJECT_ID,
        "tables": {},
    }

    for table, select in TABLES:
        cols_label = select if select else "*"
        print(f"Fetching {table} (columns: {cols_label}) ...", end=" ", flush=True)

        rows = fetch_table(table, select)
        row_count = len(rows)

        out_file = os.path.join(BACKUP_DIR, f"{table}.json")
        with open(out_file, "w") as f:
            json.dump(rows, f, indent=2, default=str)

        size_kb = os.path.getsize(out_file) / 1024
        print(f"{row_count} rows ({size_kb:.1f} KB)")

        manifest["tables"][table] = {
            "file": f"{table}.json",
            "row_count": row_count,
            "columns": select if select else "all",
            "size_bytes": os.path.getsize(out_file),
        }

    # Write manifest
    manifest_path = os.path.join(BACKUP_DIR, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nManifest written to manifest.json")

    # Summary
    total_rows = sum(t["row_count"] for t in manifest["tables"].values())
    print(f"\nBackup complete: {len(TABLES)} tables, {total_rows} total rows")


if __name__ == "__main__":
    main()
