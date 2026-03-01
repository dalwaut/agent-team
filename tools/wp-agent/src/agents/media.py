"""
Media Agent - Manage WordPress media library
"""

from pathlib import Path
from typing import Optional, List, Dict, Any
from .base import BaseAgent, AgentCapability, ActionResult, ActionStatus


class MediaAgent(BaseAgent):
    """Agent for managing WordPress media library"""

    @property
    def name(self) -> str:
        return "media"

    @property
    def description(self) -> str:
        return "Upload, manage, and organize media files in WordPress"

    def _register_capabilities(self):
        self.register_capability(AgentCapability(
            name="list",
            description="List media items with filtering",
            parameters=[
                {"name": "page", "type": "int", "description": "Page number", "default": 1},
                {"name": "per_page", "type": "int", "description": "Items per page", "default": 10},
                {"name": "search", "type": "str", "description": "Search query"},
                {"name": "media_type", "type": "str", "description": "Filter by type (image, video, audio, application)"},
                {"name": "mime_type", "type": "str", "description": "Filter by MIME type"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get",
            description="Get a single media item by ID",
            parameters=[
                {"name": "media_id", "type": "int", "description": "Media ID", "required": True},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="upload",
            description="Upload a media file",
            parameters=[
                {"name": "file_path", "type": "str", "description": "Local file path", "required": True},
                {"name": "title", "type": "str", "description": "Media title"},
                {"name": "caption", "type": "str", "description": "Media caption"},
                {"name": "alt_text", "type": "str", "description": "Alt text for images"},
                {"name": "description", "type": "str", "description": "Media description"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="upload-from-url",
            description="Upload media from a URL",
            parameters=[
                {"name": "url", "type": "str", "description": "URL of the file", "required": True},
                {"name": "title", "type": "str", "description": "Media title"},
                {"name": "caption", "type": "str", "description": "Media caption"},
                {"name": "alt_text", "type": "str", "description": "Alt text for images"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="update",
            description="Update media item metadata",
            parameters=[
                {"name": "media_id", "type": "int", "description": "Media ID", "required": True},
                {"name": "title", "type": "str", "description": "Media title"},
                {"name": "caption", "type": "str", "description": "Media caption"},
                {"name": "alt_text", "type": "str", "description": "Alt text"},
                {"name": "description", "type": "str", "description": "Description"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete",
            description="Delete a media item",
            parameters=[
                {"name": "media_id", "type": "int", "description": "Media ID", "required": True},
                {"name": "force", "type": "bool", "description": "Permanently delete", "default": True},
            ],
            http_method="DELETE"
        ))

        self.register_capability(AgentCapability(
            name="bulk-upload",
            description="Upload multiple files from a directory",
            parameters=[
                {"name": "directory", "type": "str", "description": "Directory path", "required": True},
                {"name": "pattern", "type": "str", "description": "File pattern (e.g., *.jpg)", "default": "*"},
            ],
            http_method="POST"
        ))

    def action_list(
        self,
        page: int = 1,
        per_page: int = 10,
        search: Optional[str] = None,
        media_type: Optional[str] = None,
        mime_type: Optional[str] = None
    ):
        """List media items"""
        params = {
            "page": page,
            "per_page": min(per_page, 100),
        }

        if search:
            params["search"] = search
        if media_type:
            params["media_type"] = media_type
        if mime_type:
            params["mime_type"] = mime_type

        return self.client.get("/wp/v2/media", params)

    def action_get(self, media_id: int):
        """Get a single media item"""
        return self.client.get(f"/wp/v2/media/{media_id}")

    def action_upload(
        self,
        file_path: str,
        title: Optional[str] = None,
        caption: Optional[str] = None,
        alt_text: Optional[str] = None,
        description: Optional[str] = None
    ):
        """Upload a media file"""
        import mimetypes

        path = Path(file_path)

        if not path.exists():
            return ActionResult(
                action="upload",
                status=ActionStatus.FAILED,
                error=f"File not found: {file_path}"
            )

        # Determine MIME type
        mime_type, _ = mimetypes.guess_type(str(path))
        if not mime_type:
            mime_type = "application/octet-stream"

        # Prepare file for upload
        with open(path, 'rb') as f:
            files = {
                'file': (path.name, f, mime_type)
            }

            data = {}
            if title:
                data["title"] = title
            if caption:
                data["caption"] = caption
            if alt_text:
                data["alt_text"] = alt_text
            if description:
                data["description"] = description

            return self.client.post("/wp/v2/media", data=data, files=files)

    def action_upload_from_url(
        self,
        url: str,
        title: Optional[str] = None,
        caption: Optional[str] = None,
        alt_text: Optional[str] = None
    ):
        """Upload media from URL (sideload)"""
        import requests
        import tempfile
        from urllib.parse import urlparse

        try:
            # Download file
            response = requests.get(url, stream=True, timeout=60)
            response.raise_for_status()

            # Get filename from URL
            parsed = urlparse(url)
            filename = Path(parsed.path).name or "downloaded_file"

            # Save to temp file and upload
            with tempfile.NamedTemporaryFile(delete=False, suffix=Path(filename).suffix) as tmp:
                for chunk in response.iter_content(chunk_size=8192):
                    tmp.write(chunk)
                tmp_path = tmp.name

            result = self.action_upload(tmp_path, title, caption, alt_text)

            # Clean up temp file
            Path(tmp_path).unlink(missing_ok=True)

            return result

        except requests.RequestException as e:
            return ActionResult(
                action="upload-from-url",
                status=ActionStatus.FAILED,
                error=f"Failed to download: {str(e)}"
            )

    def action_update(
        self,
        media_id: int,
        title: Optional[str] = None,
        caption: Optional[str] = None,
        alt_text: Optional[str] = None,
        description: Optional[str] = None
    ):
        """Update media metadata"""
        data = {}

        if title is not None:
            data["title"] = title
        if caption is not None:
            data["caption"] = caption
        if alt_text is not None:
            data["alt_text"] = alt_text
        if description is not None:
            data["description"] = description

        return self.client.put(f"/wp/v2/media/{media_id}", data)

    def action_delete(self, media_id: int, force: bool = True):
        """Delete a media item"""
        params = {"force": "true"} if force else {}
        return self.client.delete(f"/wp/v2/media/{media_id}", params)

    def action_bulk_upload(self, directory: str, pattern: str = "*"):
        """Upload multiple files from a directory"""
        dir_path = Path(directory)

        if not dir_path.exists() or not dir_path.is_dir():
            return ActionResult(
                action="bulk-upload",
                status=ActionStatus.FAILED,
                error=f"Directory not found: {directory}"
            )

        files = list(dir_path.glob(pattern))

        if not files:
            return ActionResult(
                action="bulk-upload",
                status=ActionStatus.FAILED,
                error=f"No files matching pattern: {pattern}"
            )

        results = []
        for file_path in files:
            if file_path.is_file():
                result = self.action_upload(str(file_path))
                results.append({
                    "file": file_path.name,
                    "success": result.success if hasattr(result, 'success') else result.status == ActionStatus.SUCCESS,
                    "media_id": result.data.get("id") if hasattr(result, 'data') and result.data else None,
                    "error": result.error if hasattr(result, 'error') else None
                })

        successful = sum(1 for r in results if r["success"])

        return ActionResult(
            action="bulk-upload",
            status=ActionStatus.SUCCESS if successful > 0 else ActionStatus.FAILED,
            data={
                "total": len(results),
                "successful": successful,
                "failed": len(results) - successful,
                "results": results
            }
        )
