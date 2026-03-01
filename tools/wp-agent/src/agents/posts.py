"""
Posts Agent - Manage WordPress posts
"""

from typing import Optional, List, Dict, Any
from .base import BaseAgent, AgentCapability


class PostsAgent(BaseAgent):
    """Agent for managing WordPress posts"""

    @property
    def name(self) -> str:
        return "posts"

    @property
    def description(self) -> str:
        return "Create, read, update, and delete WordPress posts"

    def _register_capabilities(self):
        self.register_capability(AgentCapability(
            name="list",
            description="List all posts with optional filtering",
            parameters=[
                {"name": "page", "type": "int", "description": "Page number", "default": 1},
                {"name": "per_page", "type": "int", "description": "Posts per page (max 100)", "default": 10},
                {"name": "search", "type": "str", "description": "Search query"},
                {"name": "status", "type": "str", "description": "Post status (publish, draft, pending, private)"},
                {"name": "categories", "type": "list", "description": "Category IDs to filter by"},
                {"name": "tags", "type": "list", "description": "Tag IDs to filter by"},
                {"name": "author", "type": "int", "description": "Author ID"},
                {"name": "orderby", "type": "str", "description": "Sort field (date, title, id)", "default": "date"},
                {"name": "order", "type": "str", "description": "Sort order (asc, desc)", "default": "desc"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get",
            description="Get a single post by ID",
            parameters=[
                {"name": "post_id", "type": "int", "description": "Post ID", "required": True},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="create",
            description="Create a new post",
            parameters=[
                {"name": "title", "type": "str", "description": "Post title", "required": True},
                {"name": "content", "type": "str", "description": "Post content (HTML)"},
                {"name": "status", "type": "str", "description": "Post status", "default": "draft"},
                {"name": "excerpt", "type": "str", "description": "Post excerpt"},
                {"name": "categories", "type": "list", "description": "Category IDs"},
                {"name": "tags", "type": "list", "description": "Tag IDs"},
                {"name": "featured_media", "type": "int", "description": "Featured image ID"},
                {"name": "author", "type": "int", "description": "Author ID"},
                {"name": "format", "type": "str", "description": "Post format"},
                {"name": "sticky", "type": "bool", "description": "Sticky post"},
                {"name": "meta", "type": "dict", "description": "Custom meta fields"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="update",
            description="Update an existing post",
            parameters=[
                {"name": "post_id", "type": "int", "description": "Post ID", "required": True},
                {"name": "title", "type": "str", "description": "Post title"},
                {"name": "content", "type": "str", "description": "Post content (HTML)"},
                {"name": "status", "type": "str", "description": "Post status"},
                {"name": "excerpt", "type": "str", "description": "Post excerpt"},
                {"name": "categories", "type": "list", "description": "Category IDs"},
                {"name": "tags", "type": "list", "description": "Tag IDs"},
                {"name": "featured_media", "type": "int", "description": "Featured image ID"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete",
            description="Delete a post (moves to trash or permanent delete)",
            parameters=[
                {"name": "post_id", "type": "int", "description": "Post ID", "required": True},
                {"name": "force", "type": "bool", "description": "Bypass trash and permanently delete", "default": False},
            ],
            http_method="DELETE"
        ))

        self.register_capability(AgentCapability(
            name="bulk-update-status",
            description="Update status of multiple posts",
            parameters=[
                {"name": "post_ids", "type": "list", "description": "List of post IDs", "required": True},
                {"name": "status", "type": "str", "description": "New status", "required": True},
            ],
            http_method="PUT"
        ))

    def action_list(
        self,
        page: int = 1,
        per_page: int = 10,
        search: Optional[str] = None,
        status: Optional[str] = None,
        categories: Optional[List[int]] = None,
        tags: Optional[List[int]] = None,
        author: Optional[int] = None,
        orderby: str = "date",
        order: str = "desc"
    ):
        """List posts with filtering"""
        params = {
            "page": page,
            "per_page": min(per_page, 100),
            "orderby": orderby,
            "order": order,
        }

        if search:
            params["search"] = search
        if status:
            params["status"] = status
        if categories:
            params["categories"] = ",".join(map(str, categories))
        if tags:
            params["tags"] = ",".join(map(str, tags))
        if author:
            params["author"] = author

        return self.client.get("/wp/v2/posts", params)

    def action_get(self, post_id: int):
        """Get a single post"""
        return self.client.get(f"/wp/v2/posts/{post_id}")

    def action_create(
        self,
        title: str,
        content: str = "",
        status: str = "draft",
        excerpt: Optional[str] = None,
        categories: Optional[List[int]] = None,
        tags: Optional[List[int]] = None,
        featured_media: Optional[int] = None,
        author: Optional[int] = None,
        format: Optional[str] = None,
        sticky: bool = False,
        meta: Optional[Dict] = None
    ):
        """Create a new post"""
        data = {
            "title": title,
            "content": content,
            "status": status,
            "sticky": sticky,
        }

        if excerpt:
            data["excerpt"] = excerpt
        if categories:
            data["categories"] = categories
        if tags:
            data["tags"] = tags
        if featured_media:
            data["featured_media"] = featured_media
        if author:
            data["author"] = author
        if format:
            data["format"] = format
        if meta:
            data["meta"] = meta

        return self.client.post("/wp/v2/posts", data)

    def action_update(
        self,
        post_id: int,
        title: Optional[str] = None,
        content: Optional[str] = None,
        status: Optional[str] = None,
        excerpt: Optional[str] = None,
        categories: Optional[List[int]] = None,
        tags: Optional[List[int]] = None,
        featured_media: Optional[int] = None
    ):
        """Update an existing post"""
        data = {}

        if title is not None:
            data["title"] = title
        if content is not None:
            data["content"] = content
        if status is not None:
            data["status"] = status
        if excerpt is not None:
            data["excerpt"] = excerpt
        if categories is not None:
            data["categories"] = categories
        if tags is not None:
            data["tags"] = tags
        if featured_media is not None:
            data["featured_media"] = featured_media

        return self.client.put(f"/wp/v2/posts/{post_id}", data)

    def action_delete(self, post_id: int, force: bool = False):
        """Delete a post"""
        params = {"force": "true"} if force else {}
        return self.client.delete(f"/wp/v2/posts/{post_id}", params)

    def action_bulk_update_status(self, post_ids: List[int], status: str):
        """Update status of multiple posts"""
        from .base import ActionResult, ActionStatus

        results = []
        for post_id in post_ids:
            result = self.action_update(post_id, status=status)
            results.append({
                "post_id": post_id,
                "success": result.success,
                "error": result.error
            })

        failed = [r for r in results if not r["success"]]
        return ActionResult(
            action="bulk-update-status",
            status=ActionStatus.SUCCESS if not failed else ActionStatus.FAILED,
            data=results,
            error=f"{len(failed)} posts failed to update" if failed else None
        )
