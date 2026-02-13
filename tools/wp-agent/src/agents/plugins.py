"""
Plugins Agent - Manage WordPress plugins
"""

from typing import Optional
from .base import BaseAgent, AgentCapability


class PluginsAgent(BaseAgent):
    """Agent for managing WordPress plugins (requires admin privileges)"""

    @property
    def name(self) -> str:
        return "plugins"

    @property
    def description(self) -> str:
        return "View and manage WordPress plugins"

    def _register_capabilities(self):
        self.register_capability(AgentCapability(
            name="list",
            description="List all plugins",
            parameters=[
                {"name": "status", "type": "str", "description": "Filter by status (active, inactive)"},
                {"name": "search", "type": "str"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get",
            description="Get plugin details",
            parameters=[
                {"name": "plugin", "type": "str", "required": True, "description": "Plugin slug (folder/file.php)"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="activate",
            description="Activate a plugin",
            parameters=[
                {"name": "plugin", "type": "str", "required": True},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="deactivate",
            description="Deactivate a plugin",
            parameters=[
                {"name": "plugin", "type": "str", "required": True},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete",
            description="Delete a plugin",
            parameters=[
                {"name": "plugin", "type": "str", "required": True},
            ],
            http_method="DELETE"
        ))

        # Themes
        self.register_capability(AgentCapability(
            name="list-themes",
            description="List all themes",
            parameters=[
                {"name": "status", "type": "str", "description": "Filter by status"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get-active-theme",
            description="Get current active theme",
            parameters=[],
            http_method="GET"
        ))

    def action_list(
        self,
        status: Optional[str] = None,
        search: Optional[str] = None
    ):
        params = {}
        if status:
            params["status"] = status
        if search:
            params["search"] = search

        return self.client.get("/wp/v2/plugins", params)

    def action_get(self, plugin: str):
        # Plugin slug needs URL encoding (slashes)
        encoded = plugin.replace("/", "%2F")
        return self.client.get(f"/wp/v2/plugins/{encoded}")

    def action_activate(self, plugin: str):
        encoded = plugin.replace("/", "%2F")
        return self.client.put(f"/wp/v2/plugins/{encoded}", {"status": "active"})

    def action_deactivate(self, plugin: str):
        encoded = plugin.replace("/", "%2F")
        return self.client.put(f"/wp/v2/plugins/{encoded}", {"status": "inactive"})

    def action_delete(self, plugin: str):
        encoded = plugin.replace("/", "%2F")
        return self.client.delete(f"/wp/v2/plugins/{encoded}")

    # Themes
    def action_list_themes(self, status: Optional[str] = None):
        params = {}
        if status:
            params["status"] = status
        return self.client.get("/wp/v2/themes", params)

    def action_get_active_theme(self):
        """Get the currently active theme"""
        result = self.client.get("/wp/v2/themes", {"status": "active"})
        if result.success and result.data:
            # Return first active theme
            return result
        return result
