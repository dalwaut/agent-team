"""
Search Agent - Search across WordPress content
"""

from typing import Optional, List
from .base import BaseAgent, AgentCapability


class SearchAgent(BaseAgent):
    """Agent for searching WordPress content"""

    @property
    def name(self) -> str:
        return "search"

    @property
    def description(self) -> str:
        return "Search across all WordPress content types"

    def _register_capabilities(self):
        self.register_capability(AgentCapability(
            name="search",
            description="Search all content",
            parameters=[
                {"name": "query", "type": "str", "required": True},
                {"name": "page", "type": "int", "default": 1},
                {"name": "per_page", "type": "int", "default": 10},
                {"name": "type", "type": "str", "description": "Limit to type: post, page, category, etc."},
                {"name": "subtype", "type": "str", "description": "Specific subtype"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="search-posts",
            description="Search only posts",
            parameters=[
                {"name": "query", "type": "str", "required": True},
                {"name": "page", "type": "int", "default": 1},
                {"name": "per_page", "type": "int", "default": 10},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="search-pages",
            description="Search only pages",
            parameters=[
                {"name": "query", "type": "str", "required": True},
                {"name": "page", "type": "int", "default": 1},
                {"name": "per_page", "type": "int", "default": 10},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="search-media",
            description="Search media library",
            parameters=[
                {"name": "query", "type": "str", "required": True},
                {"name": "page", "type": "int", "default": 1},
                {"name": "per_page", "type": "int", "default": 10},
            ],
            http_method="GET"
        ))

    def action_search(
        self,
        query: str,
        page: int = 1,
        per_page: int = 10,
        type: Optional[str] = None,
        subtype: Optional[str] = None
    ):
        params = {
            "search": query,
            "page": page,
            "per_page": min(per_page, 100),
        }
        if type:
            params["type"] = type
        if subtype:
            params["subtype"] = subtype

        return self.client.get("/wp/v2/search", params)

    def action_search_posts(self, query: str, page: int = 1, per_page: int = 10):
        return self.action_search(query, page, per_page, type="post", subtype="post")

    def action_search_pages(self, query: str, page: int = 1, per_page: int = 10):
        return self.action_search(query, page, per_page, type="post", subtype="page")

    def action_search_media(self, query: str, page: int = 1, per_page: int = 10):
        params = {
            "search": query,
            "page": page,
            "per_page": min(per_page, 100),
        }
        return self.client.get("/wp/v2/media", params)
