"""HELM — WordPress REST API v2 connector (Application Passwords / Basic Auth)."""

from __future__ import annotations

import base64
import logging
from typing import Optional

import httpx

try:
    import markdown as _md_lib
    def _md_to_html(text: str) -> str:
        return _md_lib.markdown(text, extensions=["extra", "nl2br"])
except ImportError:
    def _md_to_html(text: str) -> str:  # type: ignore[misc]
        import re
        html = text
        html = re.sub(r'^### (.+)$', r'<h3>\1</h3>', html, flags=re.MULTILINE)
        html = re.sub(r'^## (.+)$',  r'<h2>\1</h2>', html, flags=re.MULTILINE)
        html = re.sub(r'^# (.+)$',   r'<h1>\1</h1>', html, flags=re.MULTILINE)
        html = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', html)
        html = re.sub(r'\*(.+?)\*',     r'<em>\1</em>',         html)
        html = re.sub(r'^---+$', '<hr>', html, flags=re.MULTILINE)
        html = '\n'.join(
            f'<p>{line}</p>' if line.strip() and not line.startswith('<') else line
            for line in html.split('\n')
        )
        return html

log = logging.getLogger("helm.connectors.wordpress")


class WordPressConnector:
    """Full WordPress REST API v2 connector using Application Passwords (Basic Auth)."""

    def __init__(self, site_url: str, username: str, app_password: str):
        """Initialize connector.

        Args:
            site_url: WordPress site URL (e.g. https://example.com)
            username: WordPress username
            app_password: Application Password (generated in WP admin)
        """
        self.site_url = site_url.rstrip("/")
        self.api_base = f"{self.site_url}/wp-json/wp/v2"
        self.username = username
        self.app_password = app_password

        # Build Basic Auth header
        credentials = f"{username}:{app_password}"
        encoded = base64.b64encode(credentials.encode()).decode()
        self._auth_header = f"Basic {encoded}"

    def _headers(self) -> dict:
        return {
            "Authorization": self._auth_header,
            "Content-Type": "application/json",
            "User-Agent": "HELM/1.0",
        }

    async def test_connection(self) -> dict:
        """Verify credentials via /wp-json/wp/v2/users/me."""
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{self.site_url}/wp-json/wp/v2/users/me",
                headers=self._headers(),
            )
        if r.status_code == 200:
            data = r.json()
            return {"ok": True, "user": data.get("name", ""), "user_id": data.get("id")}
        return {"ok": False, "status": r.status_code, "error": r.text[:200]}

    async def create_post(
        self,
        title: str,
        content: str,
        status: str = "draft",
        categories: Optional[list[int]] = None,
        tags: Optional[list[int]] = None,
        slug: Optional[str] = None,
        excerpt: Optional[str] = None,
    ) -> dict:
        """Create a new WordPress post.

        Args:
            title: Post title
            content: Post HTML/block content
            status: draft, publish, pending, private
            categories: List of category IDs
            tags: List of tag IDs
            slug: URL slug (auto-generated if omitted)
            excerpt: Post excerpt

        Returns:
            Created post object from WP REST API
        """
        payload = {
            "title": title,
            "content": content,
            "status": status,
        }
        if categories:
            payload["categories"] = categories
        if tags:
            payload["tags"] = tags
        if slug:
            payload["slug"] = slug
        if excerpt:
            payload["excerpt"] = excerpt

        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                f"{self.api_base}/posts",
                headers=self._headers(),
                json=payload,
            )
            r.raise_for_status()
            post = r.json()
            log.info("Created WP post %s: %s", post.get("id"), title)
            return post

    async def push_markdown_post(
        self,
        title: str,
        body_markdown: str,
        status: str = "draft",
        excerpt: str = "",
        slug: Optional[str] = None,
    ) -> dict:
        """Convert markdown body to HTML and create a WP post.

        Returns: {wp_post_id, link, edit_link, status}
        """
        html = _md_to_html(body_markdown)
        post = await self.create_post(
            title=title,
            content=html,
            status=status,
            excerpt=excerpt or "",
            slug=slug,
        )
        wp_id = post.get("id")
        edit_link = f"{self.site_url}/wp-admin/post.php?post={wp_id}&action=edit"
        return {
            "wp_post_id": wp_id,
            "link":       post.get("link", ""),
            "edit_link":  edit_link,
            "status":     post.get("status", status),
        }

    async def update_post(self, post_id: int, **fields) -> dict:
        """Update an existing WordPress post.

        Args:
            post_id: WordPress post ID
            **fields: Any valid post fields (title, content, status, etc.)

        Returns:
            Updated post object
        """
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                f"{self.api_base}/posts/{post_id}",
                headers=self._headers(),
                json=fields,
            )
            r.raise_for_status()
            post = r.json()
            log.info("Updated WP post %s", post_id)
            return post

    async def get_posts(self, per_page: int = 10, status: str = "publish") -> list:
        """Get posts from WordPress.

        Args:
            per_page: Number of posts to return (max 100)
            status: Filter by status (publish, draft, pending, private, any)

        Returns:
            List of post objects
        """
        params = {"per_page": min(per_page, 100), "status": status}

        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(
                f"{self.api_base}/posts",
                headers=self._headers(),
                params=params,
            )
            r.raise_for_status()
            return r.json()

    async def upload_media(
        self,
        file_bytes: bytes,
        filename: str,
        alt_text: str = "",
    ) -> dict:
        """Upload media file to WordPress media library.

        Args:
            file_bytes: Raw file bytes
            filename: Filename with extension (e.g. image.jpg)
            alt_text: Alt text for accessibility

        Returns:
            Media object from WP REST API
        """
        # Determine content type from extension
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
        content_types = {
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "png": "image/png",
            "gif": "image/gif",
            "webp": "image/webp",
            "svg": "image/svg+xml",
            "pdf": "application/pdf",
            "mp4": "video/mp4",
        }
        content_type = content_types.get(ext, "application/octet-stream")

        headers = {
            "Authorization": self._auth_header,
            "Content-Type": content_type,
            "Content-Disposition": f'attachment; filename="{filename}"',
            "User-Agent": "HELM/1.0",
        }

        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(
                f"{self.api_base}/media",
                headers=headers,
                content=file_bytes,
            )
            r.raise_for_status()
            media = r.json()
            media_id = media.get("id")
            log.info("Uploaded media %s: %s", media_id, filename)

            # Set alt text if provided
            if alt_text and media_id:
                await c.post(
                    f"{self.api_base}/media/{media_id}",
                    headers=self._headers(),
                    json={"alt_text": alt_text},
                )

            return media

    async def get_categories(self) -> list:
        """Get all categories from WordPress.

        Returns:
            List of category objects
        """
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(
                f"{self.api_base}/categories",
                headers=self._headers(),
                params={"per_page": 100},
            )
            r.raise_for_status()
            return r.json()

    async def create_tag(self, name: str) -> dict:
        """Create a new tag in WordPress.

        Args:
            name: Tag name

        Returns:
            Created tag object
        """
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                f"{self.api_base}/tags",
                headers=self._headers(),
                json={"name": name},
            )
            r.raise_for_status()
            tag = r.json()
            log.info("Created WP tag %s: %s", tag.get("id"), name)
            return tag
