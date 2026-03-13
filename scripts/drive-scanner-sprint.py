#!/usr/bin/env python3
"""Drive Scanner for Token Burn Sprint — Track A.

Discovers all shared drives, scans their folder structures,
and outputs JSON for doc generation.
"""

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools" / "shared"))

from google_auth import get_access_token
import httpx

DRIVE_API = "https://www.googleapis.com/drive/v3"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "Library" / "knowledge"

# Rate limiting
_call_times = []
RATE_LIMIT = 200  # Google Drive API allows ~600/min; be generous
RATE_WINDOW = 60


async def rate_wait():
    """Wait if needed to stay under rate limit."""
    global _call_times
    while True:
        now = time.time()
        _call_times = [t for t in _call_times if now - t < RATE_WINDOW]
        if len(_call_times) < RATE_LIMIT:
            break
        wait = RATE_WINDOW - (now - _call_times[0]) + 1
        print(f"  [rate limit] waiting {wait:.0f}s...", flush=True)
        await asyncio.sleep(wait)
    _call_times.append(time.time())


async def get_headers():
    token = await get_access_token()
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


async def list_shared_drives(client, headers):
    """List all shared drives."""
    drives = []
    page_token = None
    while True:
        await rate_wait()
        params = {"pageSize": 100}
        if page_token:
            params["pageToken"] = page_token
        resp = await client.get(f"{DRIVE_API}/drives", headers=headers, params=params)
        if resp.status_code != 200:
            print(f"ERROR listing drives: {resp.status_code} {resp.text}")
            break
        data = resp.json()
        drives.extend(data.get("drives", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return drives


async def list_folder(client, headers, folder_id, drive_id=None):
    """List files in a folder. Returns list of file dicts."""
    files = []
    page_token = None
    while True:
        await rate_wait()
        params = {
            "q": f"'{folder_id}' in parents and trashed = false",
            "pageSize": 100,
            "fields": "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
            "orderBy": "name",
        }
        if drive_id:
            params["driveId"] = drive_id
            params["corpora"] = "drive"
        if page_token:
            params["pageToken"] = page_token
        resp = await client.get(f"{DRIVE_API}/files", headers=headers, params=params)
        if resp.status_code != 200:
            print(f"  ERROR listing folder {folder_id}: {resp.status_code}")
            break
        data = resp.json()
        files.extend(data.get("files", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return files


async def scan_drive_recursive(client, headers, drive_id, drive_name, max_depth=3):
    """Recursively scan a drive up to max_depth. Returns tree structure."""
    print(f"\n  Scanning: {drive_name} ({drive_id})...")

    async def scan_folder(folder_id, depth=0):
        if depth >= max_depth:
            return {"_truncated": True}

        files = await list_folder(client, headers, folder_id, drive_id)
        tree = {}
        for f in files:
            name = f["name"]
            mime = f.get("mimeType", "")
            entry = {
                "id": f["id"],
                "type": mime.split(".")[-1] if "vnd.google-apps" in mime else mime.split("/")[-1] if "/" in mime else mime,
                "modified": f.get("modifiedTime", "")[:10],
            }
            if f.get("size"):
                entry["size"] = int(f["size"])

            if mime == "application/vnd.google-apps.folder":
                entry["type"] = "folder"
                children = await scan_folder(f["id"], depth + 1)
                entry["children"] = children
                entry["file_count"] = sum(1 for v in children.values() if isinstance(v, dict) and v.get("type") != "folder")
                entry["folder_count"] = sum(1 for v in children.values() if isinstance(v, dict) and v.get("type") == "folder")

            tree[name] = entry
        return tree

    tree = await scan_folder(drive_id)
    total_files = count_files(tree)
    total_folders = count_folders(tree)
    print(f"  Done: {drive_name} — {total_files} files, {total_folders} folders")
    return tree


def count_files(tree):
    count = 0
    for name, entry in tree.items():
        if isinstance(entry, dict):
            if entry.get("type") != "folder":
                count += 1
            if "children" in entry:
                count += count_files(entry["children"])
    return count


def count_folders(tree):
    count = 0
    for name, entry in tree.items():
        if isinstance(entry, dict):
            if entry.get("type") == "folder":
                count += 1
            if "children" in entry:
                count += count_folders(entry["children"])
    return count


def tree_to_ascii(tree, prefix="", is_last=True):
    """Convert tree dict to ASCII art."""
    lines = []
    items = sorted(tree.items(), key=lambda x: (0 if isinstance(x[1], dict) and x[1].get("type") == "folder" else 1, x[0].lower()))
    for i, (name, entry) in enumerate(items):
        if not isinstance(entry, dict):
            continue
        is_final = i == len(items) - 1
        connector = "└── " if is_final else "├── "
        ext_prefix = "    " if is_final else "│   "

        etype = entry.get("type", "")
        modified = entry.get("modified", "")
        suffix = ""
        if etype == "folder":
            fc = entry.get("file_count", 0)
            foc = entry.get("folder_count", 0)
            if fc or foc:
                suffix = f"  ({fc} files, {foc} folders)"
            name_display = f"{name}/"
        else:
            name_display = name
            if modified:
                suffix = f"  [{modified}]"

        lines.append(f"{prefix}{connector}{name_display}{suffix}")

        if "children" in entry and entry["children"]:
            if entry["children"].get("_truncated"):
                lines.append(f"{prefix}{ext_prefix}└── ... (depth limit)")
            else:
                child_lines = tree_to_ascii(entry["children"], prefix + ext_prefix)
                lines.extend(child_lines)
    return lines


def generate_structure_doc(drive_name, drive_id, tree):
    """Generate a markdown structure doc for a drive."""
    total_files = count_files(tree)
    total_folders = count_folders(tree)
    ascii_tree = tree_to_ascii(tree)

    doc = f"""# {drive_name} — Google Drive Structure

> **Drive ID:** `{drive_id}`
> **Last scanned:** 2026-03-05
> **Total files:** ~{total_files}
> **Total folders:** {total_folders}
> **Access:** Read-only via `agent@paradisewebfl.com`

---

## Folder Structure

```
{drive_name}/
"""
    for line in ascii_tree:
        doc += f"{line}\n"
    doc += "```\n"

    # Add key files section
    key_files = []
    def find_key_files(t, path=""):
        for name, entry in t.items():
            if not isinstance(entry, dict):
                continue
            full_path = f"{path}/{name}" if path else name
            if entry.get("type") != "folder":
                key_files.append({
                    "name": name,
                    "path": full_path,
                    "type": entry.get("type", "unknown"),
                    "id": entry.get("id", ""),
                    "modified": entry.get("modified", ""),
                })
            if "children" in entry:
                find_key_files(entry["children"], full_path)
    find_key_files(tree)

    if key_files:
        doc += "\n## Key Files\n\n"
        doc += "| File | Type | Last Modified | ID |\n"
        doc += "|------|------|---------------|----|\n"
        for f in sorted(key_files, key=lambda x: x.get("modified", ""), reverse=True)[:30]:
            doc += f"| {f['name']} | {f['type']} | {f['modified']} | `{f['id'][:20]}...` |\n"

    return doc


async def main():
    print("=== OPAI Drive Scanner — Token Burn Sprint Track A ===\n")

    async with httpx.AsyncClient(timeout=30) as client:
        headers = await get_headers()

        # Step 1: Discover all shared drives
        print("Step 1: Discovering shared drives...")
        drives = await list_shared_drives(client, headers)
        print(f"Found {len(drives)} shared drives\n")

        # Known drives (already indexed)
        known_ids = {
            "0APYzOzcV0MYMUk9PVA",  # Everglades IT
            "0AI_12gJkvppNUk9PVA",  # OPAI Agent-Space
            "0AMVyn7WIA5AoUk9PVA",  # Lace & Pearl
            "0ANXUNX1ug79DUk9PVA",  # Pioneers of Personal Development
            "0AG6Kc-7mKN54Uk9PVA",  # Visit Everglades City
            "0ALNVJFcS2Gf7Uk9PVA",  # WellFit Girls
        }

        # Separate new vs known
        new_drives = [d for d in drives if d["id"] not in known_ids]
        all_drives = sorted(drives, key=lambda d: d["name"])

        print(f"Known drives: {len(known_ids)}")
        print(f"New drives: {len(new_drives)}")
        print(f"Total: {len(all_drives)}")

        # Step 2: Scan all new drives
        results = {}
        for i, drive in enumerate(new_drives):
            name = drive["name"]
            did = drive["id"]
            print(f"\n[{i+1}/{len(new_drives)}] Scanning {name}...")
            try:
                tree = await scan_drive_recursive(client, headers, did, name, max_depth=3)
                results[name] = {"id": did, "tree": tree}
            except Exception as e:
                print(f"  ERROR scanning {name}: {e}")
                results[name] = {"id": did, "tree": {}, "error": str(e)}

        # Step 3: Save raw JSON for reference
        raw_path = OUTPUT_DIR / "drive-scan-raw.json"
        with open(raw_path, "w") as f:
            json.dump(results, f, indent=2, default=str)
        print(f"\nRaw scan data saved to {raw_path}")

        # Step 4: Generate per-drive structure docs
        for name, data in results.items():
            if data.get("error"):
                print(f"Skipping {name} (error during scan)")
                continue
            safe_name = name.replace(" ", "-").replace("/", "-").replace("(", "").replace(")", "").replace("&", "and")
            doc_path = OUTPUT_DIR / f"{safe_name}-Structure.md"
            doc = generate_structure_doc(name, data["id"], data["tree"])
            with open(doc_path, "w") as f:
                f.write(doc)
            print(f"Written: {doc_path.name}")

        # Step 5: Generate master index
        master_lines = [
            "# ALL Drives Index — Google Shared Drives\n",
            "> **Account:** `agent@paradisewebfl.com`",
            "> **Last scanned:** 2026-03-05",
            f"> **Total shared drives:** {len(all_drives)}",
            "> **Access:** Read all drives, Write only to Agent Workspace\n",
            "---\n",
            "## Drive Directory\n",
            "| # | Drive Name | Drive ID | Category | Est. Files | Structure Doc |",
            "|---|-----------|----------|----------|------------|---------------|",
        ]

        for i, drive in enumerate(all_drives, 1):
            name = drive["name"]
            did = drive["id"]
            safe_name = name.replace(" ", "-").replace("/", "-").replace("(", "").replace(")", "").replace("&", "and")

            if did in known_ids:
                if "Everglades IT" in name or "PW Drive" in name:
                    cat = "Internal"
                elif "Agent-Space" in name or "OPAI" in name:
                    cat = "Agent"
                else:
                    cat = "Client"
                doc_ref = "ParadiseWebFL-Structure.md"
                est = "See ParadiseWebFL"
            else:
                scan = results.get(name, {})
                tree = scan.get("tree", {})
                est = str(count_files(tree)) if tree else "?"
                cat = categorize_drive(name)
                doc_ref = f"{safe_name}-Structure.md" if not scan.get("error") else "N/A"

            master_lines.append(
                f"| {i} | **{name}** | `{did}` | {cat} | {est} | [{doc_ref}]({doc_ref}) |"
            )

        master_lines.extend([
            "\n---\n",
            "## Categories\n",
            "- **Client** — Client project drives with brand assets, content, and deliverables",
            "- **Internal** — Paradise Web / WautersEdge internal business files",
            "- **Agent** — OPAI agent workspace (writable)",
            "- **Resource** — Shared resources (fonts, stock photos, images)",
            "- **Personal** — Individual team member drives",
            "\n---\n",
            "## Notes\n",
            "- Original 6 drives detailed in `ParadiseWebFL-Structure.md`",
            "- Each new drive has its own `<DriveName>-Structure.md` doc",
            "- Agent write access is restricted to OPAI Agent-Space only",
            "- Rate limits: 60 reads/min, 10 writes/min",
        ])

        master_path = OUTPUT_DIR / "ALL-DRIVES-INDEX.md"
        with open(master_path, "w") as f:
            f.write("\n".join(master_lines))
        print(f"\nMaster index: {master_path}")

        # Step 6: Output drive-reference update data
        ref_lines = ["\n## New Drives for drive-reference.md:\n"]
        for d in sorted(new_drives, key=lambda x: x["name"]):
            scan = results.get(d["name"], {})
            cat = categorize_drive(d["name"])
            ref_lines.append(f"| {d['name']} | `{d['id']}` | {cat} |")
        print("\n".join(ref_lines))

    print("\n=== Track A Complete ===")


def categorize_drive(name):
    """Guess category from drive name."""
    resources = ["Fonts", "Images", "Stock Photos", "Stock Photos by Denise"]
    internal = ["Paradise Web", "Everglades IT", "OPAI"]
    personal = ["Stock Photos by Denise"]

    for r in resources:
        if r.lower() in name.lower():
            return "Resource"
    for i in internal:
        if i.lower() in name.lower():
            return "Internal"
    return "Client"


if __name__ == "__main__":
    asyncio.run(main())
