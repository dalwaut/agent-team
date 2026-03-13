#!/usr/bin/env python3
"""Google Drive differential scanner for ParadiseWebFL.

Uses the Drive Changes API to efficiently track only new/modified/deleted
files across all shared drives. Maintains state in a JSON file so each
run only fetches the delta since the last scan.

Usage:
    # First run (initializes token + does baseline scan):
    python3 scripts/drive-scanner.py --init

    # Subsequent runs (differential — only changes):
    python3 scripts/drive-scanner.py

    # Force full rescan:
    python3 scripts/drive-scanner.py --full

    # Show recent changes without updating state:
    python3 scripts/drive-scanner.py --dry-run

Output:
    - Updates Library/knowledge/ParadiseWebFL-Structure.md changelog
    - Prints change summary to stdout
    - State stored in tools/opai-engine/data/drive-scan-state.json
"""

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Setup paths
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "shared"))

from google_workspace import GoogleWorkspace

# ── Config ────────────────────────────────────────────

STATE_FILE = ROOT / "tools" / "opai-engine" / "data" / "drive-scan-state.json"
STRUCTURE_FILE = ROOT / "Library" / "knowledge" / "ParadiseWebFL-Structure.md"

SHARED_DRIVES = {
    "0APYzOzcV0MYMUk9PVA": "Everglades IT (PW Drive)",
    "0AMVyn7WIA5AoUk9PVA": "Lace & Pearl",
    "0AI_12gJkvppNUk9PVA": "OPAI Agent-Space",
    "0ANXUNX1ug79DUk9PVA": "Pioneers of Personal Development",
    "0AG6Kc-7mKN54Uk9PVA": "Visit Everglades City",
    "0ALNVJFcS2Gf7Uk9PVA": "WellFit Girls",
}

MIME_LABELS = {
    "application/vnd.google-apps.folder": "folder",
    "application/vnd.google-apps.document": "doc",
    "application/vnd.google-apps.spreadsheet": "sheet",
    "application/vnd.google-apps.presentation": "slides",
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "text/plain": "txt",
    "text/csv": "csv",
}


def mime_label(mime: str) -> str:
    return MIME_LABELS.get(mime, mime.split("/")[-1][:10])


# ── State Management ──────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, default=str))


# ── Scanner ───────────────────────────────────────────

async def get_all_changes(gw: GoogleWorkspace, page_token: str) -> tuple[list, str]:
    """Fetch all changes since page_token, handling pagination."""
    all_changes = []
    token = page_token

    while True:
        result = await gw.drive_get_changes(token)
        changes = result.get("changes", [])
        all_changes.extend(changes)

        # If there's a nextPageToken, there are more changes in this batch
        if "nextPageToken" in result:
            token = result["nextPageToken"]
        else:
            # newStartPageToken = token for next poll
            new_token = result.get("newStartPageToken", token)
            return all_changes, new_token


def classify_change(change: dict) -> str:
    """Classify a change as added/modified/deleted/trashed."""
    if change.get("removed"):
        return "removed"
    f = change.get("file", {})
    if f.get("trashed"):
        return "trashed"
    # Check if created recently (within ~1 min of modified = likely new)
    created = f.get("createdTime", "")
    modified = f.get("modifiedTime", "")
    if created and modified and created == modified:
        return "added"
    return "modified"


def resolve_drive(parents: list) -> str:
    """Resolve which shared drive a file belongs to based on parent chain."""
    for pid in parents:
        if pid in SHARED_DRIVES:
            return SHARED_DRIVES[pid]
    return "unknown"


def format_changes(changes: list) -> str:
    """Format changes into a readable summary."""
    if not changes:
        return "No changes detected."

    lines = []
    by_action = {"added": [], "modified": [], "trashed": [], "removed": []}

    for c in changes:
        action = classify_change(c)
        f = c.get("file", {})
        name = f.get("name", c.get("fileId", "unknown"))
        mime = mime_label(f.get("mimeType", ""))
        parents = f.get("parents", [])
        drive = resolve_drive(parents)
        ts = c.get("time", "")[:19]
        by_action[action].append(f"  - [{mime}] {name} ({drive}) — {ts}")

    for action, items in by_action.items():
        if items:
            lines.append(f"\n### {action.upper()} ({len(items)})")
            lines.extend(items)

    return "\n".join(lines)


def update_structure_changelog(changes: list, scan_time: str) -> None:
    """Append to the changelog section of ParadiseWebFL-Structure.md."""
    if not STRUCTURE_FILE.exists():
        return

    content = STRUCTURE_FILE.read_text()
    change_count = len(changes)

    # Build summary line
    added = sum(1 for c in changes if classify_change(c) == "added")
    modified = sum(1 for c in changes if classify_change(c) == "modified")
    trashed = sum(1 for c in changes if classify_change(c) in ("trashed", "removed"))

    parts = []
    if added:
        parts.append(f"{added} added")
    if modified:
        parts.append(f"{modified} modified")
    if trashed:
        parts.append(f"{trashed} removed")
    summary = ", ".join(parts) if parts else "no changes"

    # Build details (up to 10 most recent)
    details = ""
    if changes:
        recent = sorted(changes, key=lambda c: c.get("time", ""), reverse=True)[:10]
        detail_items = []
        for c in recent:
            f = c.get("file", {})
            name = f.get("name", "?")
            action = classify_change(c)
            detail_items.append(f"{action}: {name}")
        details = " — " + "; ".join(detail_items)

    new_entry = f"| {scan_time[:10]} | Diff scan: {summary}{details} |"

    # Update "Last scanned" line
    import re
    content = re.sub(
        r"^> \*\*Last scanned:\*\* .*$",
        f"> **Last scanned:** {scan_time[:10]}",
        content,
        flags=re.MULTILINE,
    )

    # Calculate next scan date
    from datetime import timedelta
    next_date = (datetime.fromisoformat(scan_time.replace("Z", "+00:00")) + timedelta(days=1)).strftime("%Y-%m-%d")
    content = re.sub(
        r"^> \*\*Next scan due:\*\* .*$",
        f"> **Next scan due:** {next_date}",
        content,
        flags=re.MULTILINE,
    )

    # Append to changelog table
    if "## Changelog" in content:
        # Insert new entry after the header row
        content = content.replace(
            "| Date | Change |",
            f"| Date | Change |\n{new_entry}",
            1,
        )
        # Wait — that puts it before the separator. Let's find the right spot.
        # Actually, insert after the |------| line
        content = content.replace(
            f"| Date | Change |\n{new_entry}",
            "| Date | Change |",
            1,
        )
        # Find the separator line and insert after it
        lines = content.split("\n")
        for i, line in enumerate(lines):
            if line.strip().startswith("|------"):
                # Find the changelog table separator
                if i > 0 and "Date" in lines[i - 1] and "Change" in lines[i - 1]:
                    lines.insert(i + 1, new_entry)
                    break
        content = "\n".join(lines)

    STRUCTURE_FILE.write_text(content)


# ── Main ──────────────────────────────────────────────

async def run_init(gw: GoogleWorkspace) -> None:
    """Initialize: get start token, save state."""
    print("Initializing Drive change tracking...")
    token = await gw.drive_get_start_token()
    state = {
        "page_token": token,
        "initialized_at": datetime.now(timezone.utc).isoformat(),
        "last_scan": datetime.now(timezone.utc).isoformat(),
        "total_scans": 0,
        "total_changes_seen": 0,
    }
    save_state(state)
    print(f"Initialized. Start token: {token[:20]}...")
    print(f"State saved to: {STATE_FILE}")
    print("Run without --init next time to fetch changes.")


async def run_scan(gw: GoogleWorkspace, dry_run: bool = False) -> dict:
    """Run differential scan, return changes."""
    state = load_state()
    if not state.get("page_token"):
        print("ERROR: No page token found. Run with --init first.")
        sys.exit(1)

    token = state["page_token"]
    scan_time = datetime.now(timezone.utc).isoformat()

    print(f"Scanning for changes since last scan ({state.get('last_scan', 'unknown')[:19]})...")
    changes, new_token = await get_all_changes(gw, token)

    print(f"\nFound {len(changes)} change(s).")
    if changes:
        print(format_changes(changes))

    if not dry_run:
        state["page_token"] = new_token
        state["last_scan"] = scan_time
        state["total_scans"] = state.get("total_scans", 0) + 1
        state["total_changes_seen"] = state.get("total_changes_seen", 0) + len(changes)
        save_state(state)

        if changes:
            update_structure_changelog(changes, scan_time)
            print(f"\nUpdated {STRUCTURE_FILE.name} changelog.")

    return {"changes": len(changes), "scan_time": scan_time, "token": new_token[:20]}


async def main():
    parser = argparse.ArgumentParser(description="Google Drive differential scanner")
    parser.add_argument("--init", action="store_true", help="Initialize change tracking token")
    parser.add_argument("--full", action="store_true", help="Force full rescan (re-init + scan)")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without updating state")
    args = parser.parse_args()

    gw = GoogleWorkspace()

    if args.init or args.full:
        await run_init(gw)
        if not args.full:
            return

    await run_scan(gw, dry_run=args.dry_run)


if __name__ == "__main__":
    asyncio.run(main())
