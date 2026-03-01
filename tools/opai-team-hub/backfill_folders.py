#!/usr/bin/env python3
"""OPAI Team Hub — Backfill folders & lists from ClickUp migration tags.

The ClickUp migration stored folder/list names as tags (folder:X, list:Y)
on each item. This script reads those tags, creates proper team_folders and
team_lists records, links items via list_id/folder_id, and optionally
removes the now-redundant tags.

Usage:
    python3 backfill_folders.py              # Run backfill
    python3 backfill_folders.py --dry-run    # Preview without writing
    python3 backfill_folders.py --cleanup    # Remove folder:/list: tags after backfill
"""

import argparse
import os
import sys
from collections import defaultdict
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
from dotenv import load_dotenv
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
OWNER_USER_ID = os.getenv("MIGRATION_OWNER_ID", "1c93c5fe-d304-40f2-9169-765d0d2b7638")


def sb_headers():
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def sb_url(table):
    return f"{SUPABASE_URL}/rest/v1/{table}"


class Backfiller:
    def __init__(self, dry_run=False, cleanup=False):
        self.dry_run = dry_run
        self.cleanup = cleanup
        self.client = httpx.Client(timeout=30.0)
        self.stats = {
            "folders_created": 0,
            "lists_created": 0,
            "items_linked": 0,
            "tags_removed": 0,
        }

    def sb_get_all(self, table, params):
        """Fetch all rows with pagination (Supabase default limit is 1000)."""
        all_rows = []
        offset = 0
        batch = 1000
        while True:
            p = {**params, "limit": str(batch), "offset": str(offset)}
            resp = self.client.get(sb_url(table), headers=sb_headers(), params=p)
            if resp.status_code >= 400:
                print(f"  [ERROR] GET {table}: {resp.status_code} {resp.text[:200]}")
                break
            rows = resp.json()
            all_rows.extend(rows)
            if len(rows) < batch:
                break
            offset += batch
        return all_rows

    def sb_post(self, table, data):
        if self.dry_run:
            return {**data, "id": "dry-run-id"}
        resp = self.client.post(sb_url(table), headers=sb_headers(), json=data)
        if resp.status_code >= 400:
            print(f"  [ERROR] POST {table}: {resp.status_code} {resp.text[:200]}")
            return None
        rows = resp.json()
        return rows[0] if rows else data

    def sb_patch(self, table, params, data):
        if self.dry_run:
            return True
        resp = self.client.patch(sb_url(table), headers=sb_headers(), params=params, json=data)
        if resp.status_code >= 400:
            print(f"  [ERROR] PATCH {table}: {resp.status_code} {resp.text[:200]}")
            return False
        return True

    def sb_delete(self, table, params):
        if self.dry_run:
            return True
        resp = self.client.delete(sb_url(table), headers=sb_headers(), params=params)
        if resp.status_code >= 400:
            print(f"  [ERROR] DELETE {table}: {resp.status_code} {resp.text[:200]}")
            return False
        return True

    def run(self):
        prefix = "[DRY RUN] " if self.dry_run else ""
        print("=" * 60)
        print(f"{prefix}OPAI Team Hub — Backfill Folders & Lists")
        print("=" * 60)

        # ── Step 1: Load all folder: and list: tags ──────────────
        print("\n1. Loading folder:/list: tags...")
        all_tags = self.sb_get_all("team_tags", {"select": "id,workspace_id,name"})

        folder_tags = []  # {id, workspace_id, name} where name starts with "folder:"
        list_tags = []
        for t in all_tags:
            if t["name"].startswith("folder:"):
                folder_tags.append(t)
            elif t["name"].startswith("list:"):
                list_tags.append(t)

        print(f"   Found {len(folder_tags)} folder tags, {len(list_tags)} list tags")

        if not folder_tags and not list_tags:
            print("   Nothing to backfill.")
            return

        # ── Step 2: Load all item-tag links for these tags ───────
        print("\n2. Loading item-tag associations...")
        tag_ids = [t["id"] for t in folder_tags + list_tags]
        # Fetch in batches to avoid URL length limits
        item_tags = []
        batch_size = 50
        for i in range(0, len(tag_ids), batch_size):
            chunk = tag_ids[i:i + batch_size]
            rows = self.sb_get_all("team_item_tags", {
                "tag_id": f"in.({','.join(chunk)})",
                "select": "item_id,tag_id",
            })
            item_tags.extend(rows)
        print(f"   Found {len(item_tags)} item-tag links")

        # Build lookup: tag_id → list of item_ids
        tag_to_items = defaultdict(list)
        for it in item_tags:
            tag_to_items[it["tag_id"]].append(it["item_id"])

        # Build lookup: item_id → list of tag_ids
        item_to_tags = defaultdict(list)
        for it in item_tags:
            item_to_tags[it["item_id"]].append(it["tag_id"])

        # ── Step 3: Create folders ───────────────────────────────
        print("\n3. Creating folders...")
        # Group by workspace
        folder_tag_by_ws = defaultdict(list)
        for ft in folder_tags:
            folder_tag_by_ws[ft["workspace_id"]].append(ft)

        # tag_id → created folder record
        folder_map = {}  # tag_id → folder_id
        folder_name_map = {}  # (ws_id, folder_name) → folder_id

        # Pre-load existing folders to avoid duplicates
        existing_folders = self.sb_get_all("team_folders", {"select": "id,workspace_id,name"})
        for ef in existing_folders:
            folder_name_map[(ef["workspace_id"], ef["name"])] = ef["id"]
        print(f"   {len(existing_folders)} folders already exist")

        for ws_id, ws_folder_tags in folder_tag_by_ws.items():
            for ft in ws_folder_tags:
                folder_name = ft["name"].replace("folder:", "", 1).strip()
                key = (ws_id, folder_name)
                if key in folder_name_map:
                    folder_map[ft["id"]] = folder_name_map[key]
                    continue

                record = self.sb_post("team_folders", {
                    "workspace_id": ws_id,
                    "name": folder_name,
                    "created_by": OWNER_USER_ID,
                })
                if record and record.get("id"):
                    folder_map[ft["id"]] = record["id"]
                    folder_name_map[key] = record["id"]
                    self.stats["folders_created"] += 1
                    print(f"   {prefix}Created folder: {folder_name} (ws: {ws_id[:8]}...)")

        # ── Step 4: Discover folder-list relationships ───────────
        print("\n4. Discovering folder↔list relationships...")
        # For each list tag, find which items also have a folder tag
        # The most common co-occurring folder tag = the parent folder
        list_tag_lookup = {lt["id"]: lt for lt in list_tags}
        folder_tag_lookup = {ft["id"]: ft for ft in folder_tags}

        # list_tag_id → folder_tag_id (most common co-occurrence)
        list_parent = {}
        for lt in list_tags:
            lt_items = set(tag_to_items.get(lt["id"], []))
            if not lt_items:
                continue

            # Count co-occurring folder tags on these items
            folder_counts = defaultdict(int)
            for item_id in lt_items:
                for tid in item_to_tags[item_id]:
                    if tid in folder_tag_lookup:
                        folder_counts[tid] += 1

            if folder_counts:
                best_folder_tag = max(folder_counts, key=folder_counts.get)
                list_parent[lt["id"]] = best_folder_tag
                lt_name = lt["name"].replace("list:", "", 1)
                ft_name = folder_tag_lookup[best_folder_tag]["name"].replace("folder:", "", 1)
                print(f"   {lt_name} → {ft_name} ({folder_counts[best_folder_tag]} items)")

        # ── Step 5: Create lists ─────────────────────────────────
        print("\n5. Creating lists...")
        list_tag_by_ws = defaultdict(list)
        for lt in list_tags:
            list_tag_by_ws[lt["workspace_id"]].append(lt)

        list_map = {}  # tag_id → list_id

        # Pre-load existing lists to avoid duplicates
        existing_lists = self.sb_get_all("team_lists", {"select": "id,workspace_id,folder_id,name"})
        existing_list_keys = {}
        for el in existing_lists:
            existing_list_keys[(el["workspace_id"], el.get("folder_id"), el["name"])] = el["id"]
        print(f"   {len(existing_lists)} lists already exist")

        for ws_id, ws_list_tags in list_tag_by_ws.items():
            for lt in ws_list_tags:
                list_name = lt["name"].replace("list:", "", 1).strip()

                # Determine parent folder
                parent_folder_tag_id = list_parent.get(lt["id"])
                folder_id = folder_map.get(parent_folder_tag_id) if parent_folder_tag_id else None

                # Check if list already exists
                list_key = (ws_id, folder_id, list_name)
                if list_key in existing_list_keys:
                    list_map[lt["id"]] = existing_list_keys[list_key]
                    continue

                record = self.sb_post("team_lists", {
                    "workspace_id": ws_id,
                    "folder_id": folder_id,
                    "name": list_name,
                    "created_by": OWNER_USER_ID,
                })
                if record and record.get("id"):
                    list_map[lt["id"]] = record["id"]
                    self.stats["lists_created"] += 1
                    parent_info = f" (folder: {folder_tag_lookup[parent_folder_tag_id]['name'].replace('folder:', '')})" if parent_folder_tag_id and parent_folder_tag_id in folder_tag_lookup else ""
                    print(f"   {prefix}Created list: {list_name}{parent_info} (ws: {ws_id[:8]}...)")

        # ── Step 6: Link items to lists and folders ──────────────
        print("\n6. Linking items to folders and lists...")
        items_updated = set()

        for lt in list_tags:
            list_id = list_map.get(lt["id"])
            if not list_id:
                continue

            # Get the folder_id for this list
            parent_folder_tag_id = list_parent.get(lt["id"])
            folder_id = folder_map.get(parent_folder_tag_id) if parent_folder_tag_id else None

            lt_items = tag_to_items.get(lt["id"], [])
            if not lt_items:
                continue

            # Update items in batches
            batch_size = 50
            for i in range(0, len(lt_items), batch_size):
                chunk = lt_items[i:i + batch_size]
                update = {"list_id": list_id}
                if folder_id:
                    update["folder_id"] = folder_id
                self.sb_patch("team_items", {"id": f"in.({','.join(chunk)})"}, update)
                items_updated.update(chunk)

        # Also link items that only have folder tags (no list)
        for ft in folder_tags:
            folder_id = folder_map.get(ft["id"])
            if not folder_id:
                continue

            ft_items = tag_to_items.get(ft["id"], [])
            # Only update items not already linked via a list
            unlinked = [iid for iid in ft_items if iid not in items_updated]
            if not unlinked:
                continue

            batch_size = 50
            for i in range(0, len(unlinked), batch_size):
                chunk = unlinked[i:i + batch_size]
                self.sb_patch("team_items", {"id": f"in.({','.join(chunk)})"}, {"folder_id": folder_id})
                items_updated.update(chunk)

        self.stats["items_linked"] = len(items_updated)
        print(f"   {prefix}Linked {len(items_updated)} items")

        # ── Step 7: Cleanup tags (optional) ──────────────────────
        if self.cleanup:
            print("\n7. Cleaning up folder:/list: tags...")
            for tag in folder_tags + list_tags:
                # Remove item-tag associations
                self.sb_delete("team_item_tags", {"tag_id": f"eq.{tag['id']}"})
                # Remove the tag itself
                self.sb_delete("team_tags", {"id": f"eq.{tag['id']}"})
                self.stats["tags_removed"] += 1
            print(f"   {prefix}Removed {self.stats['tags_removed']} tags")
        else:
            print("\n7. Skipping tag cleanup (use --cleanup to remove folder:/list: tags)")

        # ── Summary ──────────────────────────────────────────────
        print("\n" + "=" * 60)
        print(f"{prefix}Backfill Complete!")
        print(f"  Folders created: {self.stats['folders_created']}")
        print(f"  Lists created:   {self.stats['lists_created']}")
        print(f"  Items linked:    {self.stats['items_linked']}")
        print(f"  Tags removed:    {self.stats['tags_removed']}")
        print("=" * 60)

        if not self.cleanup and not self.dry_run:
            print("\nNext: verify data, then run with --cleanup to remove redundant tags.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill folders & lists from ClickUp migration tags")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument("--cleanup", action="store_true", help="Remove folder:/list: tags after backfill")
    args = parser.parse_args()

    backfiller = Backfiller(dry_run=args.dry_run, cleanup=args.cleanup)
    backfiller.run()
