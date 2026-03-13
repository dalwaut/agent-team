"""Google Workspace async API wrapper for OPAI.

Provides Drive and Gmail access for the agent@paradisewebfl.com account.
Uses httpx for async HTTP calls (same pattern as opai-bx4/connectors).

Safety features:
  - Write boundary enforcement: all writes must target Agent Workspace folder
  - Audit logging on every API call via shared/audit.py
  - Rate limiting per operation type

Usage:
    from google_workspace import GoogleWorkspace
    ws = GoogleWorkspace()
    files = await ws.drive_list(folder_id="...")
"""

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

# Add shared libs to path
_shared_dir = str(Path(__file__).resolve().parent)
if _shared_dir not in sys.path:
    sys.path.insert(0, _shared_dir)

from google_auth import get_access_token, get_delegated_token
from audit import log_audit

logger = logging.getLogger("opai.google_workspace")

# ── Constants ────────────────────────────────────────────

DRIVE_API = "https://www.googleapis.com/drive/v3"
GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me"
DOCS_API = "https://docs.googleapis.com/v1/documents"
SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
CHAT_API = "https://chat.googleapis.com/v1"

# Agent Workspace folder — the ONLY place writes are allowed
AGENT_WORKSPACE_FOLDER_ID = os.environ.get(
    "GOOGLE_AGENT_WORKSPACE_FOLDER_ID", ""
)

# Write restriction flag (safety switch)
WRITE_RESTRICTED = os.environ.get(
    "GOOGLE_WORKSPACE_WRITE_RESTRICTED", "true"
).lower() in ("true", "1", "yes")

# ── Rate Limiting ────────────────────────────────────────

_rate_limits = {
    "drive_read": {"max": 60, "window": 60, "calls": []},
    "drive_write": {"max": 10, "window": 60, "calls": []},
    "gmail_read": {"max": 60, "window": 60, "calls": []},
    "gmail_send": {"max": 5, "window": 3600, "calls": []},
    "docs_comment": {"max": 5, "window": 60, "calls": []},
    "docs_edit": {"max": 10, "window": 60, "calls": []},
    "docs_read": {"max": 30, "window": 60, "calls": []},
    "chat_read": {"max": 60, "window": 60, "calls": []},
    "chat_write": {"max": 10, "window": 60, "calls": []},
}


def _check_rate_limit(operation: str) -> None:
    """Check and enforce rate limits. Raises RuntimeError if exceeded."""
    limit = _rate_limits.get(operation)
    if not limit:
        return

    now = time.time()
    # Prune old calls
    limit["calls"] = [t for t in limit["calls"] if now - t < limit["window"]]

    if len(limit["calls"]) >= limit["max"]:
        wait = limit["window"] - (now - limit["calls"][0])
        raise RuntimeError(
            f"Rate limit exceeded for {operation}: "
            f"{limit['max']}/{limit['window']}s. Retry in {wait:.0f}s."
        )

    limit["calls"].append(now)


# ── Helper Functions ─────────────────────────────────────

async def _authorized_headers() -> dict:
    """Build headers with current access token."""
    token = await get_access_token()
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }


async def _authorized_headers_for(user_email: str | None = None) -> dict:
    """Build headers, optionally impersonating a domain user.

    Args:
        user_email: If set, uses domain-wide delegation to impersonate this
                    @paradisewebfl.com user. If None, falls back to default
                    agent@ OAuth token.
    """
    if user_email:
        token = await get_delegated_token(user_email)
    else:
        token = await get_access_token()
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }


def _audit(event: str, status: str, summary: str, details: dict | None = None):
    """Log an audit entry for a workspace API call."""
    try:
        log_audit(
            tier="execution",
            service="google-workspace",
            event=event,
            status=status,
            summary=summary,
            details=details or {},
        )
    except Exception as e:
        logger.warning("Audit log failed: %s", e)


# ── Write Boundary Enforcement ───────────────────────────

async def _verify_write_target(folder_id: str) -> bool:
    """Verify that folder_id is within Agent Workspace.

    Traverses the parent chain via Drive API to confirm the target
    folder is a descendant of AGENT_WORKSPACE_FOLDER_ID.
    Defense-in-depth against accidental writes outside the sandbox.

    Returns True if write is allowed, False otherwise.
    """
    if not WRITE_RESTRICTED:
        return True

    if not AGENT_WORKSPACE_FOLDER_ID:
        logger.error("GOOGLE_AGENT_WORKSPACE_FOLDER_ID not set — writes blocked")
        return False

    if folder_id == AGENT_WORKSPACE_FOLDER_ID:
        return True

    # Walk up the parent chain (max 10 levels to prevent infinite loops)
    current = folder_id
    headers = await _authorized_headers()

    async with httpx.AsyncClient(timeout=15) as client:
        for _ in range(10):
            resp = await client.get(
                f"{DRIVE_API}/files/{current}",
                headers=headers,
                params={
                    "fields": "id,name,parents",
                    "supportsAllDrives": "true",
                },
            )

            if resp.status_code != 200:
                logger.warning("Parent chain check failed at %s: %s", current, resp.status_code)
                return False

            data = resp.json()
            parents = data.get("parents", [])

            if not parents:
                return False  # Reached root without finding workspace folder

            if AGENT_WORKSPACE_FOLDER_ID in parents:
                return True

            current = parents[0]  # Continue up the chain

    return False  # Max depth reached


# ── Google Workspace API Client ──────────────────────────

class GoogleWorkspace:
    """Async wrapper for Google Workspace APIs."""

    def __init__(self):
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=30)
        return self._client

    async def close(self):
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    # ── Drive: List ──────────────────────────────────────

    async def drive_list(
        self,
        folder_id: str | None = None,
        page_size: int = 50,
        page_token: str | None = None,
        as_user: str | None = None,
    ) -> dict:
        """List files in a Drive folder or Shared Drive root.

        Args:
            folder_id: Folder ID to list. If None, lists Shared Drive root.
            page_size: Max results per page (1-100).
            page_token: Token for next page of results.
            as_user: Impersonate this @paradisewebfl.com user via delegation.

        Returns:
            Dict with 'files' list and optional 'nextPageToken'.
        """
        _check_rate_limit("drive_read")
        headers = await _authorized_headers_for(as_user)
        client = await self._get_client()

        query_parts = []
        if folder_id:
            query_parts.append(f"'{folder_id}' in parents")
        query_parts.append("trashed = false")

        params: dict[str, Any] = {
            "q": " and ".join(query_parts),
            "pageSize": min(page_size, 100),
            "fields": "nextPageToken,files(id,name,mimeType,modifiedTime,size,owners,parents)",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
            "orderBy": "modifiedTime desc",
        }
        if page_token:
            params["pageToken"] = page_token

        resp = await client.get(f"{DRIVE_API}/files", headers=headers, params=params)

        _audit(
            "drive:list",
            "completed" if resp.status_code == 200 else "failed",
            f"Listed folder {folder_id or 'root'} ({resp.status_code})",
            {"folder_id": folder_id, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Drive list failed ({resp.status_code}): {resp.text}")

        return resp.json()

    # ── Drive: Read ──────────────────────────────────────

    async def drive_read(self, file_id: str, as_user: str | None = None) -> dict:
        """Read file content from Google Drive.

        For Google Docs/Sheets/Slides, exports as plain text.
        For other files, returns metadata only (content too large/binary).

        Args:
            file_id: The Google Drive file ID.
            as_user: Impersonate this @paradisewebfl.com user via delegation.

        Returns:
            Dict with 'metadata' and 'content' keys.
        """
        _check_rate_limit("drive_read")
        headers = await _authorized_headers_for(as_user)
        client = await self._get_client()

        # Get metadata first
        meta_resp = await client.get(
            f"{DRIVE_API}/files/{file_id}",
            headers=headers,
            params={
                "fields": "id,name,mimeType,modifiedTime,size,owners,parents,description",
                "supportsAllDrives": "true",
            },
        )

        if meta_resp.status_code != 200:
            _audit("drive:read", "failed", f"Read file {file_id} failed", {"file_id": file_id})
            raise RuntimeError(f"Drive read failed ({meta_resp.status_code}): {meta_resp.text}")

        metadata = meta_resp.json()
        mime_type = metadata.get("mimeType", "")
        content = ""

        # Export Google Docs as plain text
        export_map = {
            "application/vnd.google-apps.document": "text/plain",
            "application/vnd.google-apps.spreadsheet": "text/csv",
            "application/vnd.google-apps.presentation": "text/plain",
        }

        if mime_type in export_map:
            export_resp = await client.get(
                f"{DRIVE_API}/files/{file_id}/export",
                headers=headers,
                params={"mimeType": export_map[mime_type]},
            )
            if export_resp.status_code == 200:
                content = export_resp.text
            else:
                content = f"(Export failed: {export_resp.status_code})"
        elif mime_type.startswith("text/") or mime_type == "application/json":
            # Download text-based files
            dl_resp = await client.get(
                f"{DRIVE_API}/files/{file_id}",
                headers=headers,
                params={"alt": "media", "supportsAllDrives": "true"},
            )
            if dl_resp.status_code == 200:
                content = dl_resp.text[:100000]  # Cap at 100KB
            else:
                content = f"(Download failed: {dl_resp.status_code})"
        else:
            content = f"(Binary file: {mime_type}, {metadata.get('size', 'unknown')} bytes)"

        _audit(
            "drive:read", "completed",
            f"Read file: {metadata.get('name', file_id)}",
            {"file_id": file_id, "mime_type": mime_type},
        )

        return {"metadata": metadata, "content": content}

    # ── Drive: Search ────────────────────────────────────

    async def drive_search(
        self,
        query: str,
        page_size: int = 20,
        as_user: str | None = None,
    ) -> dict:
        """Search across Shared Drive using Drive query syntax.

        Args:
            query: Search query (e.g., "name contains 'budget'" or "fullText contains 'proposal'").
            page_size: Max results.
            as_user: Impersonate this @paradisewebfl.com user via delegation.

        Returns:
            Dict with 'files' list.
        """
        _check_rate_limit("drive_read")
        headers = await _authorized_headers_for(as_user)
        client = await self._get_client()

        # If query looks like a simple keyword, wrap it in fullText search
        if not any(op in query for op in ["contains", "=", "!=", "<", ">", "in"]):
            query = f"fullText contains '{query}' and trashed = false"
        elif "trashed" not in query.lower():
            query = f"({query}) and trashed = false"

        params: dict[str, Any] = {
            "q": query,
            "pageSize": min(page_size, 100),
            "fields": "files(id,name,mimeType,modifiedTime,size,owners,parents,webViewLink)",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }

        resp = await client.get(f"{DRIVE_API}/files", headers=headers, params=params)

        _audit(
            "drive:search", "completed" if resp.status_code == 200 else "failed",
            f"Search: {query[:80]} ({resp.status_code})",
            {"query": query, "results": len(resp.json().get("files", [])) if resp.status_code == 200 else 0},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Drive search failed ({resp.status_code}): {resp.text}")

        return resp.json()

    # ── Drive: Create Google Doc ─────────────────────────

    async def drive_create_doc(
        self,
        title: str,
        content: str,
        folder_id: str | None = None,
    ) -> dict:
        """Create a Google Doc with content in Agent Workspace.

        Uses Drive API to create a Google Docs file, then uses Docs API
        to populate it with content.

        WRITE BOUNDARY ENFORCED: Target folder must be in Agent Workspace.

        Args:
            title: Document title.
            content: Plain text content to write into the doc.
            folder_id: Target folder (must be in Agent Workspace). Defaults to workspace root.

        Returns:
            Dict with id, name, webViewLink.
        """
        _check_rate_limit("drive_write")

        target_folder = folder_id or AGENT_WORKSPACE_FOLDER_ID
        if not target_folder:
            raise PermissionError(
                "GOOGLE_AGENT_WORKSPACE_FOLDER_ID not set. Cannot create docs."
            )

        # Verify write target
        if WRITE_RESTRICTED and target_folder != AGENT_WORKSPACE_FOLDER_ID:
            allowed = await _verify_write_target(target_folder)
            if not allowed:
                _audit(
                    "drive:create_doc", "blocked",
                    f"Doc creation blocked — folder {target_folder} outside Agent Workspace",
                    {"target_folder": target_folder, "title": title},
                )
                raise PermissionError(
                    f"Write denied: folder {target_folder} is not within Agent Workspace."
                )

        headers = await _authorized_headers()
        client = await self._get_client()

        # Step 1: Create empty Google Doc via Drive API
        metadata = {
            "name": title,
            "mimeType": "application/vnd.google-apps.document",
            "parents": [target_folder],
        }

        create_resp = await client.post(
            f"{DRIVE_API}/files",
            headers={**headers, "Content-Type": "application/json"},
            json=metadata,
            params={
                "fields": "id,name,webViewLink",
                "supportsAllDrives": "true",
            },
        )

        if create_resp.status_code != 200:
            _audit("drive:create_doc", "failed", f"Create doc failed: {title}", {"status": create_resp.status_code})
            raise RuntimeError(f"Create doc failed ({create_resp.status_code}): {create_resp.text}")

        doc_data = create_resp.json()
        doc_id = doc_data["id"]

        # Step 2: Insert content via Docs API batchUpdate
        if content:
            docs_resp = await client.post(
                f"{DOCS_API}/{doc_id}:batchUpdate",
                headers={**headers, "Content-Type": "application/json"},
                json={
                    "requests": [
                        {
                            "insertText": {
                                "location": {"index": 1},
                                "text": content,
                            }
                        }
                    ]
                },
            )

            if docs_resp.status_code != 200:
                logger.warning("Doc content insert failed (%d) — doc exists but empty", docs_resp.status_code)

        _audit(
            "drive:create_doc", "completed",
            f"Created Google Doc: {title} in {target_folder}",
            {"doc_id": doc_id, "folder_id": target_folder, "title": title},
        )

        return doc_data

    # ── Drive: Write ─────────────────────────────────────

    async def drive_write(
        self,
        name: str,
        content: str,
        mime_type: str = "text/plain",
        folder_id: str | None = None,
    ) -> dict:
        """Create a file in Agent Workspace.

        WRITE BOUNDARY ENFORCED: Can only write to Agent Workspace folder
        or its subfolders.

        Args:
            name: File name.
            content: File content (text).
            mime_type: MIME type (default: text/plain).
            folder_id: Target folder (must be in Agent Workspace). Defaults to workspace root.

        Returns:
            Dict with created file metadata.
        """
        _check_rate_limit("drive_write")

        target_folder = folder_id or AGENT_WORKSPACE_FOLDER_ID
        if not target_folder:
            raise PermissionError(
                "GOOGLE_AGENT_WORKSPACE_FOLDER_ID not set. Cannot write files."
            )

        # Verify write target is within Agent Workspace
        if WRITE_RESTRICTED and target_folder != AGENT_WORKSPACE_FOLDER_ID:
            allowed = await _verify_write_target(target_folder)
            if not allowed:
                _audit(
                    "drive:write", "blocked",
                    f"Write blocked — folder {target_folder} outside Agent Workspace",
                    {"target_folder": target_folder, "file_name": name},
                )
                raise PermissionError(
                    f"Write denied: folder {target_folder} is not within Agent Workspace. "
                    f"Writes are restricted to {AGENT_WORKSPACE_FOLDER_ID} and its subfolders."
                )

        headers = await _authorized_headers()
        client = await self._get_client()

        # Google Drive multipart upload
        metadata = {
            "name": name,
            "parents": [target_folder],
        }

        # For Google Docs format, use conversion
        google_mime_map = {
            "application/vnd.google-apps.document": "text/plain",
            "application/vnd.google-apps.spreadsheet": "text/csv",
        }

        upload_mime = mime_type
        file_metadata = dict(metadata)

        if mime_type in google_mime_map:
            file_metadata["mimeType"] = mime_type
            upload_mime = google_mime_map[mime_type]

        # Use multipart upload
        boundary = "opai_workspace_boundary"
        body = (
            f"--{boundary}\r\n"
            f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
            f"{json.dumps(file_metadata)}\r\n"
            f"--{boundary}\r\n"
            f"Content-Type: {upload_mime}\r\n\r\n"
            f"{content}\r\n"
            f"--{boundary}--"
        )

        upload_headers = dict(headers)
        upload_headers["Content-Type"] = f"multipart/related; boundary={boundary}"

        resp = await client.post(
            "https://www.googleapis.com/upload/drive/v3/files",
            headers=upload_headers,
            content=body.encode("utf-8"),
            params={
                "uploadType": "multipart",
                "fields": "id,name,mimeType,webViewLink,modifiedTime",
                "supportsAllDrives": "true",
            },
        )

        _audit(
            "drive:write",
            "completed" if resp.status_code == 200 else "failed",
            f"Created file: {name} in {target_folder}",
            {"file_name": name, "folder_id": target_folder, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Drive write failed ({resp.status_code}): {resp.text}")

        return resp.json()

    # ── Drive: Get Metadata ──────────────────────────────

    async def drive_get_metadata(self, file_id: str) -> dict:
        """Get detailed file metadata.

        Args:
            file_id: Google Drive file ID.

        Returns:
            Dict with file metadata (name, type, size, owner, modified, permissions, etc.)
        """
        _check_rate_limit("drive_read")
        headers = await _authorized_headers()
        client = await self._get_client()

        resp = await client.get(
            f"{DRIVE_API}/files/{file_id}",
            headers=headers,
            params={
                "fields": "id,name,mimeType,modifiedTime,createdTime,size,owners,parents,permissions,description,webViewLink,shared,trashed",
                "supportsAllDrives": "true",
            },
        )

        _audit(
            "drive:metadata",
            "completed" if resp.status_code == 200 else "failed",
            f"Get metadata for {file_id}",
            {"file_id": file_id},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Drive metadata failed ({resp.status_code}): {resp.text}")

        return resp.json()

    # ── Drive: Changes (Differential Sync) ──────────────

    async def drive_get_start_token(self) -> str:
        """Get the initial page token for the Changes API.

        Call once to initialize, then use drive_get_changes() with the
        returned token for incremental polling.

        Returns:
            Start page token string.
        """
        _check_rate_limit("drive_read")
        headers = await _authorized_headers()
        client = await self._get_client()

        resp = await client.get(
            f"{DRIVE_API}/changes/startPageToken",
            headers=headers,
            params={
                "supportsAllDrives": "true",
            },
        )

        _audit(
            "drive:changes_token",
            "completed" if resp.status_code == 200 else "failed",
            "Fetched start page token",
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Get start token failed ({resp.status_code}): {resp.text}")

        return resp.json()["startPageToken"]

    async def drive_get_changes(
        self,
        page_token: str,
        page_size: int = 100,
    ) -> dict:
        """Fetch incremental changes since the given page token.

        Args:
            page_token: Token from drive_get_start_token() or previous call.
            page_size: Max changes per page (1-100).

        Returns:
            Dict with:
              - 'changes': list of change objects (time, fileId, removed, file metadata)
              - 'newStartPageToken': token for next poll (only if no more changes)
              - 'nextPageToken': token for next page (if more changes in this batch)
        """
        _check_rate_limit("drive_read")
        headers = await _authorized_headers()
        client = await self._get_client()

        resp = await client.get(
            f"{DRIVE_API}/changes",
            headers=headers,
            params={
                "pageToken": page_token,
                "pageSize": min(page_size, 100),
                "fields": "newStartPageToken,nextPageToken,changes(time,fileId,removed,changeType,file(id,name,mimeType,modifiedTime,createdTime,size,parents,trashed))",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
                "includeRemoved": "true",
            },
        )

        _audit(
            "drive:changes",
            "completed" if resp.status_code == 200 else "failed",
            f"Fetched changes from token {page_token[:20]}...",
            {"page_token": page_token[:20], "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Drive changes failed ({resp.status_code}): {resp.text}")

        return resp.json()

    # ── Gmail: Search ────────────────────────────────────

    async def gmail_search(
        self,
        query: str,
        max_results: int = 10,
        as_user: str | None = None,
    ) -> list[dict]:
        """Search Gmail inbox using Gmail search syntax.

        Args:
            query: Gmail search query (e.g., "subject:shared drive", "from:dallas@").
            max_results: Maximum messages to return.
            as_user: Impersonate this @paradisewebfl.com user via delegation.
                     If None, uses agent@ OAuth token.

        Returns:
            List of message dicts with id, threadId, snippet, headers.
        """
        _check_rate_limit("gmail_read")
        headers = await _authorized_headers_for(as_user)
        client = await self._get_client()

        # Search for message IDs
        resp = await client.get(
            f"{GMAIL_API}/messages",
            headers=headers,
            params={
                "q": query,
                "maxResults": min(max_results, 50),
            },
        )

        if resp.status_code != 200:
            _audit("gmail:search", "failed", f"Gmail search failed: {query[:50]}", {"query": query})
            raise RuntimeError(f"Gmail search failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        messages = data.get("messages", [])

        if not messages:
            _audit("gmail:search", "completed", f"Gmail search: no results for '{query[:50]}'")
            return []

        # Fetch each message's metadata
        results = []
        for msg_ref in messages[:max_results]:
            msg = await self._gmail_get_message(client, headers, msg_ref["id"], format="metadata")
            if msg:
                results.append(msg)

        _audit(
            "gmail:search", "completed",
            f"Gmail search: '{query[:50]}' — {len(results)} results",
            {"query": query, "count": len(results)},
        )

        return results

    # ── Gmail: Read ──────────────────────────────────────

    async def gmail_read(self, message_id: str, as_user: str | None = None) -> dict:
        """Read a full email message.

        Args:
            message_id: Gmail message ID (from search results).
            as_user: Impersonate this @paradisewebfl.com user via delegation.

        Returns:
            Dict with headers, body text, and attachment names.
        """
        _check_rate_limit("gmail_read")
        headers = await _authorized_headers_for(as_user)
        client = await self._get_client()

        msg = await self._gmail_get_message(client, headers, message_id, format="full")

        _audit(
            "gmail:read", "completed",
            f"Read message {message_id}",
            {"message_id": message_id},
        )

        return msg

    async def _gmail_get_message(
        self,
        client: httpx.AsyncClient,
        headers: dict,
        message_id: str,
        format: str = "metadata",
    ) -> dict:
        """Fetch a single Gmail message.

        Args:
            format: 'metadata' for headers+snippet, 'full' for complete message.
        """
        resp = await client.get(
            f"{GMAIL_API}/messages/{message_id}",
            headers=headers,
            params={"format": format},
        )

        if resp.status_code != 200:
            return {"id": message_id, "error": f"Fetch failed ({resp.status_code})"}

        data = resp.json()
        result: dict[str, Any] = {
            "id": data.get("id"),
            "threadId": data.get("threadId"),
            "snippet": data.get("snippet", ""),
            "labelIds": data.get("labelIds", []),
            "internalDate": data.get("internalDate"),
        }

        # Extract useful headers
        payload = data.get("payload", {})
        headers_list = payload.get("headers", [])
        for h in headers_list:
            name_lower = h["name"].lower()
            if name_lower in ("from", "to", "subject", "date", "cc"):
                result[h["name"].lower()] = h["value"]

        # Extract body for full format
        if format == "full":
            result["body"] = self._extract_body(payload)
            result["attachments"] = self._extract_attachment_names(payload)

        return result

    @staticmethod
    def _extract_body(payload: dict) -> str:
        """Extract plain text body from Gmail message payload."""
        import base64

        # Direct body
        body_data = payload.get("body", {}).get("data")
        if body_data and payload.get("mimeType", "").startswith("text/"):
            return base64.urlsafe_b64decode(body_data).decode("utf-8", errors="replace")

        # Multipart — find text/plain
        parts = payload.get("parts", [])
        for part in parts:
            if part.get("mimeType") == "text/plain":
                data = part.get("body", {}).get("data")
                if data:
                    return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")

        # Fallback — find text/html
        for part in parts:
            if part.get("mimeType") == "text/html":
                data = part.get("body", {}).get("data")
                if data:
                    html = base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
                    return f"(HTML content, {len(html)} chars)"

        # Nested multipart
        for part in parts:
            if "parts" in part:
                nested = GoogleWorkspace._extract_body(part)
                if nested:
                    return nested

        return "(No readable body)"

    # ── Gmail: Send ──────────────────────────────────────

    async def gmail_send(
        self,
        to: str,
        subject: str,
        body: str,
        cc: str = "",
        as_user: str | None = None,
    ) -> dict:
        """Send an email as agent@ or an impersonated domain user.

        Args:
            to: Recipient email address.
            subject: Email subject.
            body: Plain text email body.
            cc: CC recipients (comma-separated).
            as_user: Impersonate this @paradisewebfl.com user via delegation.
                     Requires gmail.send scope on the SA delegation.

        Returns:
            Sent message dict with id and threadId.
        """
        import base64
        from email.mime.text import MIMEText

        _check_rate_limit("gmail_send")
        headers = await _authorized_headers_for(as_user)
        client = await self._get_client()

        msg = MIMEText(body)
        msg["To"] = to
        msg["Subject"] = subject
        if cc:
            msg["Cc"] = cc

        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")

        resp = await client.post(
            f"{GMAIL_API}/messages/send",
            headers={**headers, "Content-Type": "application/json"},
            json={"raw": raw},
        )

        _audit(
            "gmail:send",
            "completed" if resp.status_code == 200 else "failed",
            f"Send email to {to}: {subject[:50]}",
            {"to": to, "subject": subject[:50], "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Gmail send failed ({resp.status_code}): {resp.text}")

        return resp.json()

    # ── Docs: Comments ────────────────────────────────────

    async def docs_list_comments(
        self,
        file_id: str,
        include_resolved: bool = False,
        modified_after: str | None = None,
    ) -> list[dict]:
        """List comments on a Google Doc/file.

        Uses Drive API comments endpoint (works on any Drive file).

        Args:
            file_id: Google Drive file ID.
            include_resolved: If True, include resolved comments.
            modified_after: ISO timestamp — only return comments modified after this time.

        Returns:
            List of comment dicts with id, author, content, replies, resolved, modifiedTime.
        """
        _check_rate_limit("drive_read")  # Read operation, not a write
        headers = await _authorized_headers()
        client = await self._get_client()

        params: dict[str, Any] = {
            "fields": "comments(id,author,content,quotedFileContent,resolved,createdTime,modifiedTime,replies(id,author,content,createdTime))",
            "pageSize": 100,
        }
        if not include_resolved:
            params["fields"] = params["fields"]  # API returns all; we filter below
        if modified_after:
            params["startModifiedTime"] = modified_after

        all_comments = []
        page_token = None

        while True:
            if page_token:
                params["pageToken"] = page_token

            resp = await client.get(
                f"{DRIVE_API}/files/{file_id}/comments",
                headers=headers,
                params=params,
            )

            if resp.status_code != 200:
                _audit("docs:list_comments", "failed", f"List comments on {file_id} failed ({resp.status_code})")
                raise RuntimeError(f"List comments failed ({resp.status_code}): {resp.text}")

            data = resp.json()
            comments = data.get("comments", [])

            if not include_resolved:
                comments = [c for c in comments if not c.get("resolved")]

            all_comments.extend(comments)
            page_token = data.get("nextPageToken")
            if not page_token:
                break

        _audit(
            "docs:list_comments", "completed",
            f"Listed {len(all_comments)} comments on {file_id}",
            {"file_id": file_id, "count": len(all_comments)},
        )
        return all_comments

    async def docs_add_comment(
        self,
        file_id: str,
        content: str,
        quoted_text: str | None = None,
    ) -> dict:
        """Add a comment to a Google Doc/file.

        Args:
            file_id: Google Drive file ID.
            content: Comment text.
            quoted_text: Optional text selection to anchor the comment to.

        Returns:
            Created comment dict.
        """
        _check_rate_limit("docs_comment")
        headers = await _authorized_headers()
        client = await self._get_client()

        body: dict[str, Any] = {"content": content}
        if quoted_text:
            body["quotedFileContent"] = {"value": quoted_text}

        resp = await client.post(
            f"{DRIVE_API}/files/{file_id}/comments",
            headers={**headers, "Content-Type": "application/json"},
            json=body,
            params={"fields": "id,author,content,createdTime"},
        )

        _audit(
            "docs:add_comment",
            "completed" if resp.status_code == 200 else "failed",
            f"Add comment on {file_id}: {content[:60]}",
            {"file_id": file_id, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Add comment failed ({resp.status_code}): {resp.text}")

        return resp.json()

    async def docs_reply_comment(
        self,
        file_id: str,
        comment_id: str,
        content: str,
    ) -> dict:
        """Reply to an existing comment thread.

        Args:
            file_id: Google Drive file ID.
            comment_id: The comment ID to reply to.
            content: Reply text.

        Returns:
            Created reply dict.
        """
        _check_rate_limit("docs_comment")
        headers = await _authorized_headers()
        client = await self._get_client()

        resp = await client.post(
            f"{DRIVE_API}/files/{file_id}/comments/{comment_id}/replies",
            headers={**headers, "Content-Type": "application/json"},
            json={"content": content},
            params={"fields": "id,author,content,createdTime"},
        )

        _audit(
            "docs:reply_comment",
            "completed" if resp.status_code == 200 else "failed",
            f"Reply to comment {comment_id} on {file_id}",
            {"file_id": file_id, "comment_id": comment_id, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Reply comment failed ({resp.status_code}): {resp.text}")

        return resp.json()

    async def docs_resolve_comment(
        self,
        file_id: str,
        comment_id: str,
    ) -> dict:
        """Mark a comment as resolved.

        Args:
            file_id: Google Drive file ID.
            comment_id: The comment ID to resolve.

        Returns:
            Updated comment dict.
        """
        _check_rate_limit("docs_comment")
        headers = await _authorized_headers()
        client = await self._get_client()

        # Drive API resolves comments by posting a reply with action=resolve
        resp = await client.post(
            f"{DRIVE_API}/files/{file_id}/comments/{comment_id}/replies",
            headers={**headers, "Content-Type": "application/json"},
            json={"content": "Resolved", "action": "resolve"},
            params={"fields": "id,content,createdTime"},
        )

        _audit(
            "docs:resolve_comment",
            "completed" if resp.status_code == 200 else "failed",
            f"Resolve comment {comment_id} on {file_id}",
            {"file_id": file_id, "comment_id": comment_id, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Resolve comment failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        result["resolved"] = True
        return result

    # ── Chat: Spaces & Messages ─────────────────────────────
    # User-authenticated Google Chat API — messages appear FROM agent@paradisewebfl.com

    async def chat_get_member(
        self,
        space_name: str,
        user_name: str,
    ) -> dict | None:
        """Get a member's details in a Chat space.

        Uses the Chat API memberships endpoint to resolve a user resource name
        (e.g., 'users/12345') to their email and display name.

        Args:
            space_name: Space resource name (e.g., 'spaces/AAAA...').
            user_name: User resource name (e.g., 'users/12345...').

        Returns:
            Dict with 'email' and 'displayName', or None if lookup fails.
        """
        _check_rate_limit("chat_read")
        headers = await _authorized_headers()
        client = await self._get_client()

        # Try listing members to find the user
        try:
            resp = await client.get(
                f"{CHAT_API}/{space_name}/members",
                headers=headers,
                params={"pageSize": 20},
            )

            if resp.status_code == 200:
                members = resp.json().get("memberships", [])
                for member in members:
                    m = member.get("member", {})
                    if m.get("name") == user_name:
                        return {
                            "email": m.get("email", ""),
                            "displayName": m.get("displayName", ""),
                        }

            # Fallback: try direct member lookup
            # Chat API format: spaces/X/members/users/Y
            member_name = f"{space_name}/members/{user_name}"
            resp2 = await client.get(
                f"{CHAT_API}/{member_name}",
                headers=headers,
            )
            if resp2.status_code == 200:
                data = resp2.json()
                m = data.get("member", {})
                return {
                    "email": m.get("email", ""),
                    "displayName": m.get("displayName", ""),
                }

        except Exception as e:
            logger.warning("Member lookup failed for %s in %s: %s", user_name, space_name, e)

        return None

    async def chat_list_spaces(
        self,
        page_size: int = 100,
    ) -> list[dict]:
        """List Google Chat spaces the agent account belongs to.

        Args:
            page_size: Max results per page (max 1000).

        Returns:
            List of space dicts with name, displayName, type, etc.
        """
        _check_rate_limit("chat_read")
        headers = await _authorized_headers()
        client = await self._get_client()

        all_spaces = []
        page_token = None

        while True:
            params: dict[str, Any] = {
                "pageSize": min(page_size, 1000),
                "filter": 'spaceType = "SPACE" OR spaceType = "DIRECT_MESSAGE" OR spaceType = "GROUP_CHAT"',
            }
            if page_token:
                params["pageToken"] = page_token

            resp = await client.get(
                f"{CHAT_API}/spaces",
                headers=headers,
                params=params,
            )

            if resp.status_code != 200:
                _audit("chat:list_spaces", "failed", f"List spaces failed ({resp.status_code})")
                raise RuntimeError(f"Chat list spaces failed ({resp.status_code}): {resp.text}")

            data = resp.json()
            all_spaces.extend(data.get("spaces", []))
            page_token = data.get("nextPageToken")
            if not page_token:
                break

        _audit(
            "chat:list_spaces", "completed",
            f"Listed {len(all_spaces)} Chat spaces",
            {"count": len(all_spaces)},
        )
        return all_spaces

    async def chat_list_messages(
        self,
        space_name: str,
        filter_time: str | None = None,
        page_size: int = 50,
    ) -> list[dict]:
        """List messages in a Google Chat space.

        Args:
            space_name: Space resource name (e.g., 'spaces/AAAA...').
            filter_time: ISO timestamp — only return messages created after this time.
            page_size: Max results per page (max 1000).

        Returns:
            List of message dicts with name, sender, text, createTime, thread.
        """
        _check_rate_limit("chat_read")
        headers = await _authorized_headers()
        client = await self._get_client()

        params: dict[str, Any] = {
            "pageSize": min(page_size, 1000),
            "orderBy": "createTime desc",
        }
        if filter_time:
            params["filter"] = f'createTime > "{filter_time}"'

        resp = await client.get(
            f"{CHAT_API}/{space_name}/messages",
            headers=headers,
            params=params,
        )

        if resp.status_code != 200:
            _audit("chat:list_messages", "failed", f"List messages in {space_name} failed ({resp.status_code})")
            raise RuntimeError(f"Chat list messages failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        messages = data.get("messages", [])

        _audit(
            "chat:list_messages", "completed",
            f"Listed {len(messages)} messages in {space_name}",
            {"space": space_name, "count": len(messages)},
        )
        return messages

    async def chat_send_message(
        self,
        space_name: str,
        text: str,
        thread_name: str | None = None,
    ) -> dict:
        """Send a message in a Google Chat space as agent@paradisewebfl.com.

        Uses user authentication — message appears FROM the agent user, not a bot.
        User-authenticated messages are text-only (no cards/widgets).

        Args:
            space_name: Space resource name (e.g., 'spaces/AAAA...').
            text: Message text (max 32KB).
            thread_name: Thread resource name to reply in-thread. If None, starts new thread.

        Returns:
            Created message dict.
        """
        _check_rate_limit("chat_write")
        headers = await _authorized_headers()
        client = await self._get_client()

        body: dict[str, Any] = {"text": text[:32000]}
        if thread_name:
            body["thread"] = {"name": thread_name}

        params: dict[str, Any] = {}
        if thread_name:
            params["messageReplyOption"] = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"

        resp = await client.post(
            f"{CHAT_API}/{space_name}/messages",
            headers={**headers, "Content-Type": "application/json"},
            json=body,
            params=params,
        )

        _audit(
            "chat:send_message",
            "completed" if resp.status_code == 200 else "failed",
            f"Send message in {space_name}: {text[:60]}",
            {"space": space_name, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Chat send message failed ({resp.status_code}): {resp.text}")

        return resp.json()

    async def chat_update_message(
        self,
        message_name: str,
        text: str,
    ) -> dict:
        """Update an existing message in Google Chat.

        Uses PATCH to edit the message text in-place. Only works on messages
        sent by the authenticated user (agent@paradisewebfl.com).

        Args:
            message_name: Full message resource name (e.g., 'spaces/AAA.../messages/BBB...').
            text: New message text (max 32KB).

        Returns:
            Updated message dict.
        """
        _check_rate_limit("chat_write")
        headers = await _authorized_headers()
        client = await self._get_client()

        body = {"text": text[:32000]}

        resp = await client.patch(
            f"{CHAT_API}/{message_name}",
            headers={**headers, "Content-Type": "application/json"},
            json=body,
            params={"updateMask": "text"},
        )

        _audit(
            "chat:update_message",
            "completed" if resp.status_code == 200 else "failed",
            f"Update message {message_name}: {text[:60]}",
            {"message": message_name, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Chat update message failed ({resp.status_code}): {resp.text}")

        return resp.json()

    async def chat_setup_dm(self, user_email: str) -> dict:
        """Set up (join/create) a DM space with a user.

        Uses the Chat spaces.setup API to ensure the agent is a proper member
        of the DM space. This fixes 403 errors when trying to send messages
        in DM spaces the agent hasn't explicitly joined.

        Requires chat.spaces.create scope.

        Args:
            user_email: The email of the user to set up a DM with.

        Returns:
            Space dict with name, displayName, spaceType, etc.
        """
        _check_rate_limit("chat_write")
        headers = await _authorized_headers()
        client = await self._get_client()

        body = {
            "space": {"spaceType": "DIRECT_MESSAGE"},
            "memberships": [
                {
                    "member": {
                        "name": f"users/{user_email}",
                        "type": "HUMAN",
                    }
                }
            ],
        }

        resp = await client.post(
            f"{CHAT_API}/spaces:setup",
            headers={**headers, "Content-Type": "application/json"},
            json=body,
        )

        _audit(
            "chat:setup_dm",
            "completed" if resp.status_code == 200 else "failed",
            f"Setup DM with {user_email}",
            {"user_email": user_email, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Chat DM setup failed ({resp.status_code}): {resp.text}")

        return resp.json()

    # ── Docs: Edit / Revisions / Structure ─────────────────

    async def docs_edit_text(self, doc_id: str, edits: list[dict]) -> dict:
        """Apply text edits to a Google Doc via Docs API batchUpdate.

        Each edit dict:
            {"action": "insert", "index": int, "text": str}
            {"action": "replace_all", "find": str, "replace": str}
            {"action": "delete", "start_index": int, "end_index": int}

        Translates to Docs API batchUpdate requests.
        Returns batchUpdate response.
        """
        _check_rate_limit("docs_edit")
        headers = await _authorized_headers()
        client = await self._get_client()

        requests = []
        # Process edits in reverse index order to preserve positions
        for edit in sorted(edits, key=lambda e: e.get("index", e.get("start_index", 0)), reverse=True):
            action = edit.get("action", "")

            if action == "insert":
                requests.append({
                    "insertText": {
                        "location": {"index": edit["index"]},
                        "text": edit["text"],
                    }
                })
            elif action == "replace_all":
                requests.append({
                    "replaceAllText": {
                        "containsText": {
                            "text": edit["find"],
                            "matchCase": True,
                        },
                        "replaceText": edit["replace"],
                    }
                })
            elif action == "delete":
                requests.append({
                    "deleteContentRange": {
                        "range": {
                            "startIndex": edit["start_index"],
                            "endIndex": edit["end_index"],
                        }
                    }
                })

        if not requests:
            return {"error": "No valid edit operations"}

        resp = await client.post(
            f"{DOCS_API}/{doc_id}:batchUpdate",
            headers={**headers, "Content-Type": "application/json"},
            json={"requests": requests},
        )

        _audit(
            "docs:edit_text",
            "completed" if resp.status_code == 200 else "failed",
            f"Edit doc {doc_id}: {len(requests)} operations",
            {"doc_id": doc_id, "op_count": len(requests), "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Docs edit failed ({resp.status_code}): {resp.text}")

        return resp.json()

    async def docs_get_revisions(self, doc_id: str, page_size: int = 10) -> list[dict]:
        """Get recent revisions of a Google Doc/Sheet via Drive revisions API.

        Returns list of {id, modifiedTime, lastModifyingUser} dicts.
        Used to detect human activity for co-edit timeout.
        """
        _check_rate_limit("docs_read")
        headers = await _authorized_headers()
        client = await self._get_client()

        resp = await client.get(
            f"{DRIVE_API}/files/{doc_id}/revisions",
            headers=headers,
            params={
                "pageSize": min(page_size, 200),
                "fields": "revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress))",
            },
        )

        _audit(
            "docs:get_revisions",
            "completed" if resp.status_code == 200 else "failed",
            f"Get revisions for {doc_id}",
            {"doc_id": doc_id, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Get revisions failed ({resp.status_code}): {resp.text}")

        return resp.json().get("revisions", [])

    async def docs_get_content_structure(self, doc_id: str) -> dict:
        """Get document content structure with paragraph text + indices.

        Uses Docs API GET /documents/{id} and returns a simplified structure:
        {"title": str, "paragraphs": [{"text": str, "startIndex": int, "endIndex": int}]}
        """
        _check_rate_limit("docs_read")
        headers = await _authorized_headers()
        client = await self._get_client()

        resp = await client.get(
            f"{DOCS_API}/{doc_id}",
            headers=headers,
        )

        _audit(
            "docs:get_content_structure",
            "completed" if resp.status_code == 200 else "failed",
            f"Get structure for {doc_id}",
            {"doc_id": doc_id, "status_code": resp.status_code},
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Get doc structure failed ({resp.status_code}): {resp.text}")

        doc = resp.json()
        title = doc.get("title", "")
        body = doc.get("body", {})
        content = body.get("content", [])

        paragraphs = []
        for element in content:
            paragraph = element.get("paragraph")
            if not paragraph:
                continue

            start_index = element.get("startIndex", 0)
            end_index = element.get("endIndex", 0)

            # Extract text from paragraph elements
            text_parts = []
            for pe in paragraph.get("elements", []):
                text_run = pe.get("textRun")
                if text_run:
                    text_parts.append(text_run.get("content", ""))

            text = "".join(text_parts)
            if text.strip():
                paragraphs.append({
                    "text": text,
                    "startIndex": start_index,
                    "endIndex": end_index,
                })

        return {"title": title, "paragraphs": paragraphs}

    @staticmethod
    def _extract_attachment_names(payload: dict) -> list[str]:
        """Extract attachment filenames from Gmail message payload."""
        names = []
        parts = payload.get("parts", [])
        for part in parts:
            filename = part.get("filename")
            if filename:
                names.append(filename)
            if "parts" in part:
                names.extend(GoogleWorkspace._extract_attachment_names(part))
        return names
