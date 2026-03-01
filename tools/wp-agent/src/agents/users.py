"""
Users Agent - Manage WordPress users
"""

from typing import Optional, List
from .base import BaseAgent, AgentCapability


class UsersAgent(BaseAgent):
    """Agent for managing WordPress users"""

    @property
    def name(self) -> str:
        return "users"

    @property
    def description(self) -> str:
        return "Manage WordPress users and their profiles"

    def _register_capabilities(self):
        self.register_capability(AgentCapability(
            name="list",
            description="List all users",
            parameters=[
                {"name": "page", "type": "int", "default": 1},
                {"name": "per_page", "type": "int", "default": 10},
                {"name": "search", "type": "str"},
                {"name": "roles", "type": "list", "description": "Filter by roles"},
                {"name": "orderby", "type": "str", "default": "name"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get",
            description="Get a user by ID",
            parameters=[
                {"name": "user_id", "type": "int", "required": True},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="me",
            description="Get current authenticated user",
            parameters=[],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="create",
            description="Create a new user",
            parameters=[
                {"name": "username", "type": "str", "required": True},
                {"name": "email", "type": "str", "required": True},
                {"name": "password", "type": "str", "required": True},
                {"name": "name", "type": "str"},
                {"name": "first_name", "type": "str"},
                {"name": "last_name", "type": "str"},
                {"name": "roles", "type": "list", "default": ["subscriber"]},
                {"name": "description", "type": "str"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="update",
            description="Update a user",
            parameters=[
                {"name": "user_id", "type": "int", "required": True},
                {"name": "email", "type": "str"},
                {"name": "name", "type": "str"},
                {"name": "first_name", "type": "str"},
                {"name": "last_name", "type": "str"},
                {"name": "roles", "type": "list"},
                {"name": "description", "type": "str"},
                {"name": "password", "type": "str"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete",
            description="Delete a user",
            parameters=[
                {"name": "user_id", "type": "int", "required": True},
                {"name": "reassign", "type": "int", "description": "Reassign content to this user ID"},
                {"name": "force", "type": "bool", "default": True},
            ],
            http_method="DELETE"
        ))

        self.register_capability(AgentCapability(
            name="list-roles",
            description="List available user roles",
            parameters=[],
            http_method="GET"
        ))

    def action_list(
        self,
        page: int = 1,
        per_page: int = 10,
        search: Optional[str] = None,
        roles: Optional[List[str]] = None,
        orderby: str = "name"
    ):
        params = {
            "page": page,
            "per_page": min(per_page, 100),
            "orderby": orderby,
        }
        if search:
            params["search"] = search
        if roles:
            params["roles"] = ",".join(roles)

        return self.client.get("/wp/v2/users", params)

    def action_get(self, user_id: int):
        return self.client.get(f"/wp/v2/users/{user_id}")

    def action_me(self):
        return self.client.get("/wp/v2/users/me")

    def action_create(
        self,
        username: str,
        email: str,
        password: str,
        name: Optional[str] = None,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        roles: Optional[List[str]] = None,
        description: Optional[str] = None
    ):
        data = {
            "username": username,
            "email": email,
            "password": password,
            "roles": roles or ["subscriber"],
        }
        if name:
            data["name"] = name
        if first_name:
            data["first_name"] = first_name
        if last_name:
            data["last_name"] = last_name
        if description:
            data["description"] = description

        return self.client.post("/wp/v2/users", data)

    def action_update(
        self,
        user_id: int,
        email: Optional[str] = None,
        name: Optional[str] = None,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        roles: Optional[List[str]] = None,
        description: Optional[str] = None,
        password: Optional[str] = None
    ):
        data = {}
        if email:
            data["email"] = email
        if name:
            data["name"] = name
        if first_name:
            data["first_name"] = first_name
        if last_name:
            data["last_name"] = last_name
        if roles:
            data["roles"] = roles
        if description is not None:
            data["description"] = description
        if password:
            data["password"] = password

        return self.client.put(f"/wp/v2/users/{user_id}", data)

    def action_delete(self, user_id: int, reassign: Optional[int] = None, force: bool = True):
        params = {}
        if force:
            params["force"] = "true"
        if reassign:
            params["reassign"] = reassign

        return self.client.delete(f"/wp/v2/users/{user_id}", params)

    def action_list_roles(self):
        """List available roles (derived from users endpoint schema)"""
        from .base import ActionResult, ActionStatus

        # WordPress doesn't have a direct roles endpoint
        # We can get roles from the users endpoint OPTIONS or from site info
        result = self.client.get("/wp/v2/users", {"per_page": 1, "context": "edit"})

        if not result.success:
            return result

        # Standard WordPress roles
        roles = [
            {"slug": "administrator", "name": "Administrator", "capabilities": "Full access"},
            {"slug": "editor", "name": "Editor", "capabilities": "Manage all content"},
            {"slug": "author", "name": "Author", "capabilities": "Write and manage own posts"},
            {"slug": "contributor", "name": "Contributor", "capabilities": "Write posts, cannot publish"},
            {"slug": "subscriber", "name": "Subscriber", "capabilities": "Read only"},
        ]

        return ActionResult(
            action="list-roles",
            status=ActionStatus.SUCCESS,
            data=roles
        )
