"""
Taxonomy Agent - Manage categories, tags, and custom taxonomies
"""

from typing import Optional, List, Dict, Any
from .base import BaseAgent, AgentCapability, ActionResult, ActionStatus


class TaxonomyAgent(BaseAgent):
    """Agent for managing WordPress taxonomies (categories, tags, custom)"""

    @property
    def name(self) -> str:
        return "taxonomy"

    @property
    def description(self) -> str:
        return "Manage categories, tags, and custom taxonomies"

    def _register_capabilities(self):
        # Categories
        self.register_capability(AgentCapability(
            name="list-categories",
            description="List all categories",
            parameters=[
                {"name": "page", "type": "int", "default": 1},
                {"name": "per_page", "type": "int", "default": 100},
                {"name": "search", "type": "str"},
                {"name": "parent", "type": "int"},
                {"name": "hide_empty", "type": "bool", "default": False},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="create-category",
            description="Create a new category",
            parameters=[
                {"name": "name", "type": "str", "required": True},
                {"name": "slug", "type": "str"},
                {"name": "description", "type": "str"},
                {"name": "parent", "type": "int"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="update-category",
            description="Update a category",
            parameters=[
                {"name": "category_id", "type": "int", "required": True},
                {"name": "name", "type": "str"},
                {"name": "slug", "type": "str"},
                {"name": "description", "type": "str"},
                {"name": "parent", "type": "int"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete-category",
            description="Delete a category",
            parameters=[
                {"name": "category_id", "type": "int", "required": True},
                {"name": "force", "type": "bool", "default": True},
            ],
            http_method="DELETE"
        ))

        # Tags
        self.register_capability(AgentCapability(
            name="list-tags",
            description="List all tags",
            parameters=[
                {"name": "page", "type": "int", "default": 1},
                {"name": "per_page", "type": "int", "default": 100},
                {"name": "search", "type": "str"},
                {"name": "hide_empty", "type": "bool", "default": False},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="create-tag",
            description="Create a new tag",
            parameters=[
                {"name": "name", "type": "str", "required": True},
                {"name": "slug", "type": "str"},
                {"name": "description", "type": "str"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="update-tag",
            description="Update a tag",
            parameters=[
                {"name": "tag_id", "type": "int", "required": True},
                {"name": "name", "type": "str"},
                {"name": "slug", "type": "str"},
                {"name": "description", "type": "str"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete-tag",
            description="Delete a tag",
            parameters=[
                {"name": "tag_id", "type": "int", "required": True},
                {"name": "force", "type": "bool", "default": True},
            ],
            http_method="DELETE"
        ))

        # General taxonomy operations
        self.register_capability(AgentCapability(
            name="list-taxonomies",
            description="List all registered taxonomies",
            parameters=[],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="bulk-create-categories",
            description="Create multiple categories at once",
            parameters=[
                {"name": "categories", "type": "list", "required": True, "description": "List of category objects with name, slug, description, parent"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="bulk-create-tags",
            description="Create multiple tags at once",
            parameters=[
                {"name": "tags", "type": "list", "required": True, "description": "List of tag objects with name, slug, description"},
            ],
            http_method="POST"
        ))

    # Categories
    def action_list_categories(
        self,
        page: int = 1,
        per_page: int = 100,
        search: Optional[str] = None,
        parent: Optional[int] = None,
        hide_empty: bool = False
    ):
        params = {
            "page": page,
            "per_page": min(per_page, 100),
            "hide_empty": hide_empty,
        }
        if search:
            params["search"] = search
        if parent is not None:
            params["parent"] = parent

        return self.client.get("/wp/v2/categories", params)

    def action_create_category(
        self,
        name: str,
        slug: Optional[str] = None,
        description: Optional[str] = None,
        parent: Optional[int] = None
    ):
        data = {"name": name}
        if slug:
            data["slug"] = slug
        if description:
            data["description"] = description
        if parent:
            data["parent"] = parent

        return self.client.post("/wp/v2/categories", data)

    def action_update_category(
        self,
        category_id: int,
        name: Optional[str] = None,
        slug: Optional[str] = None,
        description: Optional[str] = None,
        parent: Optional[int] = None
    ):
        data = {}
        if name:
            data["name"] = name
        if slug:
            data["slug"] = slug
        if description is not None:
            data["description"] = description
        if parent is not None:
            data["parent"] = parent

        return self.client.put(f"/wp/v2/categories/{category_id}", data)

    def action_delete_category(self, category_id: int, force: bool = True):
        params = {"force": "true"} if force else {}
        return self.client.delete(f"/wp/v2/categories/{category_id}", params)

    # Tags
    def action_list_tags(
        self,
        page: int = 1,
        per_page: int = 100,
        search: Optional[str] = None,
        hide_empty: bool = False
    ):
        params = {
            "page": page,
            "per_page": min(per_page, 100),
            "hide_empty": hide_empty,
        }
        if search:
            params["search"] = search

        return self.client.get("/wp/v2/tags", params)

    def action_create_tag(
        self,
        name: str,
        slug: Optional[str] = None,
        description: Optional[str] = None
    ):
        data = {"name": name}
        if slug:
            data["slug"] = slug
        if description:
            data["description"] = description

        return self.client.post("/wp/v2/tags", data)

    def action_update_tag(
        self,
        tag_id: int,
        name: Optional[str] = None,
        slug: Optional[str] = None,
        description: Optional[str] = None
    ):
        data = {}
        if name:
            data["name"] = name
        if slug:
            data["slug"] = slug
        if description is not None:
            data["description"] = description

        return self.client.put(f"/wp/v2/tags/{tag_id}", data)

    def action_delete_tag(self, tag_id: int, force: bool = True):
        params = {"force": "true"} if force else {}
        return self.client.delete(f"/wp/v2/tags/{tag_id}", params)

    # General
    def action_list_taxonomies(self):
        return self.client.get("/wp/v2/taxonomies")

    def action_bulk_create_categories(self, categories: List[Dict[str, Any]]):
        results = []
        for cat in categories:
            result = self.action_create_category(
                name=cat["name"],
                slug=cat.get("slug"),
                description=cat.get("description"),
                parent=cat.get("parent")
            )
            results.append({
                "name": cat["name"],
                "success": result.success,
                "id": result.data.get("id") if result.success else None,
                "error": result.error
            })

        successful = sum(1 for r in results if r["success"])
        return ActionResult(
            action="bulk-create-categories",
            status=ActionStatus.SUCCESS if successful > 0 else ActionStatus.FAILED,
            data={"total": len(results), "successful": successful, "results": results}
        )

    def action_bulk_create_tags(self, tags: List[Dict[str, Any]]):
        results = []
        for tag in tags:
            result = self.action_create_tag(
                name=tag["name"],
                slug=tag.get("slug"),
                description=tag.get("description")
            )
            results.append({
                "name": tag["name"],
                "success": result.success,
                "id": result.data.get("id") if result.success else None,
                "error": result.error
            })

        successful = sum(1 for r in results if r["success"])
        return ActionResult(
            action="bulk-create-tags",
            status=ActionStatus.SUCCESS if successful > 0 else ActionStatus.FAILED,
            data={"total": len(results), "successful": successful, "results": results}
        )
