"""
Pages Agent - Manage WordPress pages
"""

from typing import Optional, List, Dict, Any
from .base import BaseAgent, AgentCapability


class PagesAgent(BaseAgent):
    """Agent for managing WordPress pages"""

    @property
    def name(self) -> str:
        return "pages"

    @property
    def description(self) -> str:
        return "Create, read, update, and delete WordPress pages"

    def _register_capabilities(self):
        self.register_capability(AgentCapability(
            name="list",
            description="List all pages with optional filtering",
            parameters=[
                {"name": "page", "type": "int", "description": "Page number", "default": 1},
                {"name": "per_page", "type": "int", "description": "Pages per page (max 100)", "default": 10},
                {"name": "search", "type": "str", "description": "Search query"},
                {"name": "status", "type": "str", "description": "Page status"},
                {"name": "parent", "type": "int", "description": "Parent page ID"},
                {"name": "orderby", "type": "str", "description": "Sort field", "default": "menu_order"},
                {"name": "order", "type": "str", "description": "Sort order", "default": "asc"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get",
            description="Get a single page by ID",
            parameters=[
                {"name": "page_id", "type": "int", "description": "Page ID", "required": True},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="create",
            description="Create a new page",
            parameters=[
                {"name": "title", "type": "str", "description": "Page title", "required": True},
                {"name": "content", "type": "str", "description": "Page content (HTML)"},
                {"name": "status", "type": "str", "description": "Page status", "default": "draft"},
                {"name": "parent", "type": "int", "description": "Parent page ID"},
                {"name": "menu_order", "type": "int", "description": "Menu order"},
                {"name": "template", "type": "str", "description": "Page template"},
                {"name": "featured_media", "type": "int", "description": "Featured image ID"},
                {"name": "meta", "type": "dict", "description": "Custom meta fields"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="update",
            description="Update an existing page",
            parameters=[
                {"name": "page_id", "type": "int", "description": "Page ID", "required": True},
                {"name": "title", "type": "str", "description": "Page title"},
                {"name": "content", "type": "str", "description": "Page content"},
                {"name": "status", "type": "str", "description": "Page status"},
                {"name": "parent", "type": "int", "description": "Parent page ID"},
                {"name": "menu_order", "type": "int", "description": "Menu order"},
                {"name": "template", "type": "str", "description": "Page template"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete",
            description="Delete a page",
            parameters=[
                {"name": "page_id", "type": "int", "description": "Page ID", "required": True},
                {"name": "force", "type": "bool", "description": "Permanently delete", "default": False},
            ],
            http_method="DELETE"
        ))

        self.register_capability(AgentCapability(
            name="get-hierarchy",
            description="Get page hierarchy (parent-child structure)",
            parameters=[],
            http_method="GET"
        ))

    def action_list(
        self,
        page: int = 1,
        per_page: int = 10,
        search: Optional[str] = None,
        status: Optional[str] = None,
        parent: Optional[int] = None,
        orderby: str = "menu_order",
        order: str = "asc"
    ):
        """List pages with filtering"""
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
        if parent is not None:
            params["parent"] = parent

        return self.client.get("/wp/v2/pages", params)

    def action_get(self, page_id: int):
        """Get a single page"""
        return self.client.get(f"/wp/v2/pages/{page_id}")

    def action_create(
        self,
        title: str,
        content: str = "",
        status: str = "draft",
        parent: Optional[int] = None,
        menu_order: int = 0,
        template: Optional[str] = None,
        featured_media: Optional[int] = None,
        meta: Optional[Dict] = None
    ):
        """Create a new page"""
        data = {
            "title": title,
            "content": content,
            "status": status,
            "menu_order": menu_order,
        }

        if parent:
            data["parent"] = parent
        if template:
            data["template"] = template
        if featured_media:
            data["featured_media"] = featured_media
        if meta:
            data["meta"] = meta

        return self.client.post("/wp/v2/pages", data)

    def action_update(
        self,
        page_id: int,
        title: Optional[str] = None,
        content: Optional[str] = None,
        status: Optional[str] = None,
        parent: Optional[int] = None,
        menu_order: Optional[int] = None,
        template: Optional[str] = None
    ):
        """Update an existing page"""
        data = {}

        if title is not None:
            data["title"] = title
        if content is not None:
            data["content"] = content
        if status is not None:
            data["status"] = status
        if parent is not None:
            data["parent"] = parent
        if menu_order is not None:
            data["menu_order"] = menu_order
        if template is not None:
            data["template"] = template

        return self.client.put(f"/wp/v2/pages/{page_id}", data)

    def action_delete(self, page_id: int, force: bool = False):
        """Delete a page"""
        params = {"force": "true"} if force else {}
        return self.client.delete(f"/wp/v2/pages/{page_id}", params)

    def action_get_hierarchy(self):
        """Get page hierarchy as a tree structure"""
        from .base import ActionResult, ActionStatus

        # Get all pages
        result = self.client.get("/wp/v2/pages", {"per_page": 100})

        if not result.success:
            return result

        pages = result.data

        # Build hierarchy
        def build_tree(parent_id=0):
            children = []
            for page in pages:
                if page.get("parent", 0) == parent_id:
                    node = {
                        "id": page["id"],
                        "title": page["title"]["rendered"],
                        "slug": page["slug"],
                        "status": page["status"],
                        "menu_order": page.get("menu_order", 0),
                        "children": build_tree(page["id"])
                    }
                    children.append(node)
            return sorted(children, key=lambda x: x["menu_order"])

        hierarchy = build_tree(0)

        return ActionResult(
            action="get-hierarchy",
            status=ActionStatus.SUCCESS,
            data=hierarchy
        )
