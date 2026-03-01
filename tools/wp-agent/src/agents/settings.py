"""
Settings Agent - Manage WordPress site settings
"""

from typing import Optional
from .base import BaseAgent, AgentCapability


class SettingsAgent(BaseAgent):
    """Agent for managing WordPress site settings"""

    @property
    def name(self) -> str:
        return "settings"

    @property
    def description(self) -> str:
        return "View and update WordPress site settings"

    def _register_capabilities(self):
        self.register_capability(AgentCapability(
            name="get",
            description="Get all site settings",
            parameters=[],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="update",
            description="Update site settings",
            parameters=[
                {"name": "title", "type": "str", "description": "Site title"},
                {"name": "description", "type": "str", "description": "Site tagline"},
                {"name": "timezone_string", "type": "str", "description": "Timezone"},
                {"name": "date_format", "type": "str"},
                {"name": "time_format", "type": "str"},
                {"name": "start_of_week", "type": "int", "description": "0=Sunday, 1=Monday"},
                {"name": "language", "type": "str"},
                {"name": "posts_per_page", "type": "int"},
                {"name": "default_category", "type": "int"},
                {"name": "default_post_format", "type": "str"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="get-site-info",
            description="Get basic site information (public)",
            parameters=[],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get-post-types",
            description="Get registered post types",
            parameters=[],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get-statuses",
            description="Get available post statuses",
            parameters=[],
            http_method="GET"
        ))

    def action_get(self):
        return self.client.get("/wp/v2/settings")

    def action_update(
        self,
        title: Optional[str] = None,
        description: Optional[str] = None,
        timezone_string: Optional[str] = None,
        date_format: Optional[str] = None,
        time_format: Optional[str] = None,
        start_of_week: Optional[int] = None,
        language: Optional[str] = None,
        posts_per_page: Optional[int] = None,
        default_category: Optional[int] = None,
        default_post_format: Optional[str] = None
    ):
        data = {}
        if title is not None:
            data["title"] = title
        if description is not None:
            data["description"] = description
        if timezone_string is not None:
            data["timezone_string"] = timezone_string
        if date_format is not None:
            data["date_format"] = date_format
        if time_format is not None:
            data["time_format"] = time_format
        if start_of_week is not None:
            data["start_of_week"] = start_of_week
        if language is not None:
            data["language"] = language
        if posts_per_page is not None:
            data["posts_per_page"] = posts_per_page
        if default_category is not None:
            data["default_category"] = default_category
        if default_post_format is not None:
            data["default_post_format"] = default_post_format

        return self.client.put("/wp/v2/settings", data)

    def action_get_site_info(self):
        """Get public site information"""
        return self.client.get("/")

    def action_get_post_types(self):
        """Get registered post types"""
        return self.client.get("/wp/v2/types")

    def action_get_statuses(self):
        """Get available post statuses"""
        return self.client.get("/wp/v2/statuses")
