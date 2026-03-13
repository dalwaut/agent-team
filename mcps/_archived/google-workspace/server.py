"""OPAI Google Workspace MCP Server.

Provides Claude Code with Google Drive and Gmail access for the
agent@paradisewebfl.com account. Phase 1: read-only observer + sandboxed writes.

Safety:
  - All writes restricted to Agent Workspace folder (parent chain verified)
  - Every API call audited via shared/audit.py
  - Rate limits enforced per operation type
  - Credentials encrypted at rest in opai-vault (SOPS+age)

Tools (Phase 1):
  - drive_list: List files in a Drive folder or Shared Drive root
  - drive_read: Read file content (Google Docs exported as text)
  - drive_search: Search across Shared Drive
  - drive_write: Create file (Agent Workspace only)
  - drive_get_metadata: File name, type, size, owner, modified, permissions
  - gmail_search: Search agent@paradisewebfl.com inbox
  - gmail_read: Read full email (headers, body, attachment names)
"""

import asyncio
import sys
from pathlib import Path

# Add shared library to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "tools" / "shared"))

from mcp.server.fastmcp import FastMCP
from google_workspace import GoogleWorkspace

mcp = FastMCP("opai-google-workspace")
_ws: GoogleWorkspace | None = None


def _get_ws() -> GoogleWorkspace:
    """Get or create the workspace client singleton."""
    global _ws
    if _ws is None:
        _ws = GoogleWorkspace()
    return _ws


def _format_file(f: dict) -> str:
    """Format a Drive file entry as a readable line."""
    name = f.get("name", "(unnamed)")
    mime = f.get("mimeType", "")
    file_id = f.get("id", "")
    modified = f.get("modifiedTime", "")[:10]
    size = f.get("size")

    # Friendly type names
    type_map = {
        "application/vnd.google-apps.folder": "Folder",
        "application/vnd.google-apps.document": "Google Doc",
        "application/vnd.google-apps.spreadsheet": "Google Sheet",
        "application/vnd.google-apps.presentation": "Google Slides",
        "application/vnd.google-apps.form": "Google Form",
        "application/pdf": "PDF",
    }
    friendly_type = type_map.get(mime, mime.split("/")[-1] if "/" in mime else mime)

    parts = [f"  {name}"]
    parts.append(f"    Type: {friendly_type}")
    parts.append(f"    ID: {file_id}")
    if modified:
        parts.append(f"    Modified: {modified}")
    if size:
        size_kb = int(size) / 1024
        if size_kb > 1024:
            parts.append(f"    Size: {size_kb / 1024:.1f} MB")
        else:
            parts.append(f"    Size: {size_kb:.1f} KB")

    return "\n".join(parts)


def _format_email(msg: dict) -> str:
    """Format a Gmail message as a readable block."""
    parts = []
    parts.append(f"  Subject: {msg.get('subject', '(no subject)')}")
    parts.append(f"  From: {msg.get('from', '(unknown)')}")
    if msg.get("to"):
        parts.append(f"  To: {msg['to']}")
    if msg.get("date"):
        parts.append(f"  Date: {msg['date']}")
    parts.append(f"  ID: {msg.get('id', '')}")
    if msg.get("snippet"):
        parts.append(f"  Preview: {msg['snippet'][:150]}")
    return "\n".join(parts)


# ── Drive Tools ──────────────────────────────────────────

@mcp.tool()
async def drive_list(folder_id: str = "", page_size: int = 50) -> str:
    """List files in a Drive folder or Shared Drive root.

    Args:
        folder_id: Folder ID to list. Leave empty for Shared Drive root.
        page_size: Max results per page (1-100).

    Returns:
        Formatted list of files with name, type, ID, modified date, and size.
    """
    ws = _get_ws()

    try:
        result = await ws.drive_list(
            folder_id=folder_id if folder_id else None,
            page_size=page_size,
        )
    except Exception as e:
        return f"Error: {e}"

    files = result.get("files", [])
    if not files:
        target = f"folder {folder_id}" if folder_id else "Shared Drive root"
        return f"No files found in {target}."

    parts = [f"Found {len(files)} file(s):\n"]
    for f in files:
        parts.append(_format_file(f))

    if result.get("nextPageToken"):
        parts.append(f"\n(More results available — next page token: {result['nextPageToken']})")

    return "\n".join(parts)


@mcp.tool()
async def drive_read(file_id: str) -> str:
    """Read file content from Google Drive.

    For Google Docs/Sheets/Slides, exports as plain text/CSV.
    For other text files, returns content directly.
    Binary files return metadata only.

    Args:
        file_id: The Google Drive file ID.

    Returns:
        File metadata and content.
    """
    ws = _get_ws()

    try:
        result = await ws.drive_read(file_id)
    except Exception as e:
        return f"Error: {e}"

    meta = result.get("metadata", {})
    content = result.get("content", "")

    parts = []
    parts.append(f"File: {meta.get('name', '(unnamed)')}")
    parts.append(f"Type: {meta.get('mimeType', 'unknown')}")
    if meta.get("modifiedTime"):
        parts.append(f"Modified: {meta['modifiedTime']}")
    if meta.get("description"):
        parts.append(f"Description: {meta['description']}")
    parts.append("")
    parts.append(content if content else "(No content)")

    return "\n".join(parts)


@mcp.tool()
async def drive_search(query: str, page_size: int = 20) -> str:
    """Search across Shared Drive.

    Supports simple keywords or Drive query syntax:
    - Simple: "budget 2024" (searches full text)
    - Advanced: "name contains 'budget'" or "mimeType = 'application/pdf'"

    Args:
        query: Search query (keyword or Drive query syntax).
        page_size: Max results (1-100).

    Returns:
        Matching files with metadata.
    """
    ws = _get_ws()

    try:
        result = await ws.drive_search(query=query, page_size=page_size)
    except Exception as e:
        return f"Error: {e}"

    files = result.get("files", [])
    if not files:
        return f"No files found matching: {query}"

    parts = [f"Found {len(files)} result(s) for '{query}':\n"]
    for f in files:
        parts.append(_format_file(f))

    return "\n".join(parts)


@mcp.tool()
async def drive_write(name: str, content: str, mime_type: str = "text/plain", folder_id: str = "") -> str:
    """Create a file in the Agent Workspace folder.

    WRITE RESTRICTED: Can only create files within Agent Workspace
    and its subfolders. Attempts to write elsewhere will be blocked.

    Args:
        name: File name (e.g., "report.txt", "analysis.md").
        content: File content (text).
        mime_type: MIME type. Use "application/vnd.google-apps.document" for Google Docs.
        folder_id: Target subfolder within Agent Workspace. Leave empty for workspace root.

    Returns:
        Created file metadata with link.
    """
    ws = _get_ws()

    try:
        result = await ws.drive_write(
            name=name,
            content=content,
            mime_type=mime_type,
            folder_id=folder_id if folder_id else None,
        )
    except PermissionError as e:
        return f"BLOCKED: {e}"
    except Exception as e:
        return f"Error: {e}"

    parts = []
    parts.append(f"File created successfully!")
    parts.append(f"  Name: {result.get('name', name)}")
    parts.append(f"  ID: {result.get('id', 'unknown')}")
    parts.append(f"  Type: {result.get('mimeType', mime_type)}")
    if result.get("webViewLink"):
        parts.append(f"  Link: {result['webViewLink']}")

    return "\n".join(parts)


@mcp.tool()
async def drive_get_metadata(file_id: str) -> str:
    """Get detailed file metadata from Google Drive.

    Args:
        file_id: Google Drive file ID.

    Returns:
        File name, type, size, owner, created/modified dates, permissions, and sharing info.
    """
    ws = _get_ws()

    try:
        meta = await ws.drive_get_metadata(file_id)
    except Exception as e:
        return f"Error: {e}"

    parts = []
    parts.append(f"Name: {meta.get('name', '(unnamed)')}")
    parts.append(f"ID: {meta.get('id')}")
    parts.append(f"Type: {meta.get('mimeType', 'unknown')}")

    if meta.get("size"):
        size_kb = int(meta["size"]) / 1024
        if size_kb > 1024:
            parts.append(f"Size: {size_kb / 1024:.1f} MB")
        else:
            parts.append(f"Size: {size_kb:.1f} KB")

    if meta.get("createdTime"):
        parts.append(f"Created: {meta['createdTime']}")
    if meta.get("modifiedTime"):
        parts.append(f"Modified: {meta['modifiedTime']}")

    owners = meta.get("owners", [])
    if owners:
        owner_names = [o.get("displayName", o.get("emailAddress", "?")) for o in owners]
        parts.append(f"Owner: {', '.join(owner_names)}")

    if meta.get("description"):
        parts.append(f"Description: {meta['description']}")

    parts.append(f"Shared: {'Yes' if meta.get('shared') else 'No'}")
    parts.append(f"Trashed: {'Yes' if meta.get('trashed') else 'No'}")

    if meta.get("webViewLink"):
        parts.append(f"Link: {meta['webViewLink']}")

    # Permissions summary
    perms = meta.get("permissions", [])
    if perms:
        parts.append(f"\nPermissions ({len(perms)}):")
        for p in perms[:10]:
            role = p.get("role", "?")
            email = p.get("emailAddress", p.get("displayName", p.get("type", "?")))
            parts.append(f"  {role}: {email}")

    return "\n".join(parts)


# ── Gmail Tools ──────────────────────────────────────────

@mcp.tool()
async def gmail_search(query: str, max_results: int = 10) -> str:
    """Search agent@paradisewebfl.com inbox using Gmail search syntax.

    Examples:
    - "subject:shared drive" — Find emails about shared drive
    - "from:dallas@" — Emails from Dallas
    - "is:unread" — Unread messages
    - "has:attachment" — Messages with attachments
    - "newer_than:7d" — Last 7 days

    Args:
        query: Gmail search query.
        max_results: Maximum messages to return (1-50).

    Returns:
        Matching emails with subject, from, date, and preview.
    """
    ws = _get_ws()

    try:
        messages = await ws.gmail_search(query=query, max_results=max_results)
    except Exception as e:
        return f"Error: {e}"

    if not messages:
        return f"No messages found for: {query}"

    parts = [f"Found {len(messages)} message(s) for '{query}':\n"]
    for msg in messages:
        if msg.get("error"):
            parts.append(f"  [Error fetching message {msg.get('id')}]")
        else:
            parts.append(_format_email(msg))
        parts.append("")

    return "\n".join(parts)


@mcp.tool()
async def gmail_read(message_id: str) -> str:
    """Read a full email message from agent@paradisewebfl.com inbox.

    Args:
        message_id: Gmail message ID (from gmail_search results).

    Returns:
        Complete email with headers, body text, and attachment names.
    """
    ws = _get_ws()

    try:
        msg = await ws.gmail_read(message_id)
    except Exception as e:
        return f"Error: {e}"

    if msg.get("error"):
        return f"Error: {msg['error']}"

    parts = []
    parts.append(f"Subject: {msg.get('subject', '(no subject)')}")
    parts.append(f"From: {msg.get('from', '(unknown)')}")
    if msg.get("to"):
        parts.append(f"To: {msg['to']}")
    if msg.get("cc"):
        parts.append(f"CC: {msg['cc']}")
    if msg.get("date"):
        parts.append(f"Date: {msg['date']}")
    parts.append(f"Message ID: {msg.get('id', '')}")
    parts.append(f"Thread ID: {msg.get('threadId', '')}")

    labels = msg.get("labelIds", [])
    if labels:
        parts.append(f"Labels: {', '.join(labels)}")

    attachments = msg.get("attachments", [])
    if attachments:
        parts.append(f"\nAttachments ({len(attachments)}):")
        for a in attachments:
            parts.append(f"  - {a}")

    parts.append(f"\n--- Body ---\n")
    parts.append(msg.get("body", "(No body)"))

    return "\n".join(parts)


# ── Drive Changes Tools ─────────────────────────────────

@mcp.tool()
async def drive_scan_changes() -> str:
    """Scan for recent Google Drive changes across all shared drives.

    Uses the Drive Changes API for efficient delta detection — only
    fetches files that changed since the last scan. State is persisted
    in tools/opai-engine/data/drive-scan-state.json.

    Returns:
        Summary of added, modified, and removed files since last scan.
    """
    import json as _json
    from pathlib import Path as _Path

    ws = _get_ws()
    state_file = _Path(__file__).resolve().parent.parent.parent / "tools" / "opai-engine" / "data" / "drive-scan-state.json"

    # Load or initialize state
    if state_file.exists():
        state = _json.loads(state_file.read_text())
    else:
        # First run — initialize
        token = await ws.drive_get_start_token()
        state = {"page_token": token, "total_scans": 0, "total_changes_seen": 0}
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(_json.dumps(state, indent=2))
        return f"Initialized change tracking. Token: {token[:20]}... Run again to fetch changes."

    token = state["page_token"]

    # Fetch all changes
    all_changes = []
    while True:
        result = await ws.drive_get_changes(token)
        all_changes.extend(result.get("changes", []))
        if "nextPageToken" in result:
            token = result["nextPageToken"]
        else:
            new_token = result.get("newStartPageToken", token)
            break

    # Update state
    from datetime import datetime, timezone
    state["page_token"] = new_token
    state["last_scan"] = datetime.now(timezone.utc).isoformat()
    state["total_scans"] = state.get("total_scans", 0) + 1
    state["total_changes_seen"] = state.get("total_changes_seen", 0) + len(all_changes)
    state_file.write_text(_json.dumps(state, indent=2))

    if not all_changes:
        return f"No changes since last scan ({state.get('last_scan', 'unknown')[:19]}). Total scans: {state['total_scans']}."

    # Format changes
    parts = [f"Found {len(all_changes)} change(s) since last scan:\n"]
    for c in sorted(all_changes, key=lambda x: x.get("time", ""), reverse=True):
        f = c.get("file", {})
        name = f.get("name", c.get("fileId", "?"))
        mime = f.get("mimeType", "").replace("application/vnd.google-apps.", "g:").split("/")[-1]
        ts = c.get("time", "")[:19]
        if c.get("removed") or f.get("trashed"):
            parts.append(f"  REMOVED: {name} ({mime}) at {ts}")
        elif f.get("createdTime") == f.get("modifiedTime"):
            parts.append(f"  ADDED: {name} ({mime}) at {ts}")
        else:
            parts.append(f"  MODIFIED: {name} ({mime}) at {ts}")

    parts.append(f"\nTotal scans: {state['total_scans']}, Total changes tracked: {state['total_changes_seen']}")
    return "\n".join(parts)


if __name__ == "__main__":
    mcp.run(transport="stdio")
