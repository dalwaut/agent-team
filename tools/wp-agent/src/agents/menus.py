"""
Menus Agent - Manage WordPress navigation menus
"""

from typing import Optional, List, Dict, Any
from .base import BaseAgent, AgentCapability, ActionResult, ActionStatus


class MenusAgent(BaseAgent):
    """Agent for managing WordPress navigation menus"""

    @property
    def name(self) -> str:
        return "menus"

    @property
    def description(self) -> str:
        return "Create and manage navigation menus"

    def _register_capabilities(self):
        self.register_capability(AgentCapability(
            name="list",
            description="List all menus",
            parameters=[],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get",
            description="Get a menu by ID",
            parameters=[
                {"name": "menu_id", "type": "int", "required": True},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="create",
            description="Create a new menu",
            parameters=[
                {"name": "name", "type": "str", "required": True},
                {"name": "description", "type": "str"},
                {"name": "locations", "type": "list", "description": "Theme locations to assign"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="update",
            description="Update a menu",
            parameters=[
                {"name": "menu_id", "type": "int", "required": True},
                {"name": "name", "type": "str"},
                {"name": "description", "type": "str"},
                {"name": "locations", "type": "list"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete",
            description="Delete a menu",
            parameters=[
                {"name": "menu_id", "type": "int", "required": True},
                {"name": "force", "type": "bool", "default": True},
            ],
            http_method="DELETE"
        ))

        # Menu Items
        self.register_capability(AgentCapability(
            name="list-items",
            description="List menu items",
            parameters=[
                {"name": "menus", "type": "int", "description": "Filter by menu ID"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="add-item",
            description="Add an item to a menu",
            parameters=[
                {"name": "menus", "type": "int", "required": True, "description": "Menu ID"},
                {"name": "title", "type": "str", "required": True},
                {"name": "url", "type": "str", "description": "Custom URL"},
                {"name": "object_type", "type": "str", "description": "post, page, category, custom"},
                {"name": "object_id", "type": "int", "description": "ID of linked object"},
                {"name": "parent", "type": "int", "description": "Parent menu item ID"},
                {"name": "menu_order", "type": "int"},
                {"name": "target", "type": "str", "description": "_blank for new window"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="update-item",
            description="Update a menu item",
            parameters=[
                {"name": "item_id", "type": "int", "required": True},
                {"name": "title", "type": "str"},
                {"name": "url", "type": "str"},
                {"name": "parent", "type": "int"},
                {"name": "menu_order", "type": "int"},
                {"name": "target", "type": "str"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete-item",
            description="Delete a menu item",
            parameters=[
                {"name": "item_id", "type": "int", "required": True},
                {"name": "force", "type": "bool", "default": True},
            ],
            http_method="DELETE"
        ))

        self.register_capability(AgentCapability(
            name="list-locations",
            description="List available menu locations",
            parameters=[],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="assign-location",
            description="Assign a menu to a location",
            parameters=[
                {"name": "location", "type": "str", "required": True},
                {"name": "menu_id", "type": "int", "required": True},
            ],
            http_method="PUT"
        ))

    def action_list(self):
        return self.client.get("/wp/v2/menus")

    def action_get(self, menu_id: int):
        return self.client.get(f"/wp/v2/menus/{menu_id}")

    def action_create(
        self,
        name: str,
        description: Optional[str] = None,
        locations: Optional[List[str]] = None
    ):
        data = {"name": name}
        if description:
            data["description"] = description
        if locations:
            data["locations"] = locations

        return self.client.post("/wp/v2/menus", data)

    def action_update(
        self,
        menu_id: int,
        name: Optional[str] = None,
        description: Optional[str] = None,
        locations: Optional[List[str]] = None
    ):
        data = {}
        if name:
            data["name"] = name
        if description is not None:
            data["description"] = description
        if locations is not None:
            data["locations"] = locations

        return self.client.put(f"/wp/v2/menus/{menu_id}", data)

    def action_delete(self, menu_id: int, force: bool = True):
        params = {"force": "true"} if force else {}
        return self.client.delete(f"/wp/v2/menus/{menu_id}", params)

    # Menu Items
    def action_list_items(self, menus: Optional[int] = None):
        params = {}
        if menus:
            params["menus"] = menus
        return self.client.get("/wp/v2/menu-items", params)

    def action_add_item(
        self,
        menus: int,
        title: str,
        url: Optional[str] = None,
        object_type: str = "custom",
        object_id: Optional[int] = None,
        parent: Optional[int] = None,
        menu_order: int = 0,
        target: Optional[str] = None
    ):
        data = {
            "menus": menus,
            "title": title,
            "type": object_type,
            "menu_order": menu_order,
        }

        if url:
            data["url"] = url
        if object_id:
            data["object_id"] = object_id
        if parent:
            data["parent"] = parent
        if target:
            data["target"] = target

        return self.client.post("/wp/v2/menu-items", data)

    def action_update_item(
        self,
        item_id: int,
        title: Optional[str] = None,
        url: Optional[str] = None,
        parent: Optional[int] = None,
        menu_order: Optional[int] = None,
        target: Optional[str] = None
    ):
        data = {}
        if title:
            data["title"] = title
        if url:
            data["url"] = url
        if parent is not None:
            data["parent"] = parent
        if menu_order is not None:
            data["menu_order"] = menu_order
        if target is not None:
            data["target"] = target

        return self.client.put(f"/wp/v2/menu-items/{item_id}", data)

    def action_delete_item(self, item_id: int, force: bool = True):
        params = {"force": "true"} if force else {}
        return self.client.delete(f"/wp/v2/menu-items/{item_id}", params)

    def action_list_locations(self):
        return self.client.get("/wp/v2/menu-locations")

    def action_assign_location(self, location: str, menu_id: int):
        """Assign menu to a theme location"""
        # This typically requires updating through settings or theme mods
        # The exact implementation depends on how the theme handles it
        data = {"menu": menu_id}
        return self.client.put(f"/wp/v2/menu-locations/{location}", data)
