"""
Comments Agent - Manage WordPress comments
"""

from typing import Optional, List
from .base import BaseAgent, AgentCapability, ActionResult, ActionStatus


class CommentsAgent(BaseAgent):
    """Agent for managing WordPress comments"""

    @property
    def name(self) -> str:
        return "comments"

    @property
    def description(self) -> str:
        return "Manage comments on posts and pages"

    def _register_capabilities(self):
        self.register_capability(AgentCapability(
            name="list",
            description="List comments with filtering",
            parameters=[
                {"name": "page", "type": "int", "default": 1},
                {"name": "per_page", "type": "int", "default": 10},
                {"name": "search", "type": "str"},
                {"name": "post", "type": "int", "description": "Filter by post ID"},
                {"name": "status", "type": "str", "description": "approved, hold, spam, trash"},
                {"name": "author", "type": "int"},
                {"name": "orderby", "type": "str", "default": "date"},
                {"name": "order", "type": "str", "default": "desc"},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="get",
            description="Get a comment by ID",
            parameters=[
                {"name": "comment_id", "type": "int", "required": True},
            ],
            http_method="GET"
        ))

        self.register_capability(AgentCapability(
            name="create",
            description="Create a new comment",
            parameters=[
                {"name": "post", "type": "int", "required": True},
                {"name": "content", "type": "str", "required": True},
                {"name": "author_name", "type": "str"},
                {"name": "author_email", "type": "str"},
                {"name": "author_url", "type": "str"},
                {"name": "parent", "type": "int", "description": "Parent comment for replies"},
                {"name": "status", "type": "str", "default": "approved"},
            ],
            http_method="POST"
        ))

        self.register_capability(AgentCapability(
            name="update",
            description="Update a comment",
            parameters=[
                {"name": "comment_id", "type": "int", "required": True},
                {"name": "content", "type": "str"},
                {"name": "status", "type": "str"},
                {"name": "author_name", "type": "str"},
                {"name": "author_email", "type": "str"},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="delete",
            description="Delete a comment",
            parameters=[
                {"name": "comment_id", "type": "int", "required": True},
                {"name": "force", "type": "bool", "default": False},
            ],
            http_method="DELETE"
        ))

        self.register_capability(AgentCapability(
            name="approve",
            description="Approve a pending comment",
            parameters=[
                {"name": "comment_id", "type": "int", "required": True},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="spam",
            description="Mark a comment as spam",
            parameters=[
                {"name": "comment_id", "type": "int", "required": True},
            ],
            http_method="PUT"
        ))

        self.register_capability(AgentCapability(
            name="bulk-moderate",
            description="Moderate multiple comments at once",
            parameters=[
                {"name": "comment_ids", "type": "list", "required": True},
                {"name": "action", "type": "str", "required": True, "description": "approve, spam, trash, delete"},
            ],
            http_method="PUT"
        ))

    def action_list(
        self,
        page: int = 1,
        per_page: int = 10,
        search: Optional[str] = None,
        post: Optional[int] = None,
        status: Optional[str] = None,
        author: Optional[int] = None,
        orderby: str = "date",
        order: str = "desc"
    ):
        params = {
            "page": page,
            "per_page": min(per_page, 100),
            "orderby": orderby,
            "order": order,
        }
        if search:
            params["search"] = search
        if post:
            params["post"] = post
        if status:
            params["status"] = status
        if author:
            params["author"] = author

        return self.client.get("/wp/v2/comments", params)

    def action_get(self, comment_id: int):
        return self.client.get(f"/wp/v2/comments/{comment_id}")

    def action_create(
        self,
        post: int,
        content: str,
        author_name: Optional[str] = None,
        author_email: Optional[str] = None,
        author_url: Optional[str] = None,
        parent: Optional[int] = None,
        status: str = "approved"
    ):
        data = {
            "post": post,
            "content": content,
            "status": status,
        }
        if author_name:
            data["author_name"] = author_name
        if author_email:
            data["author_email"] = author_email
        if author_url:
            data["author_url"] = author_url
        if parent:
            data["parent"] = parent

        return self.client.post("/wp/v2/comments", data)

    def action_update(
        self,
        comment_id: int,
        content: Optional[str] = None,
        status: Optional[str] = None,
        author_name: Optional[str] = None,
        author_email: Optional[str] = None
    ):
        data = {}
        if content:
            data["content"] = content
        if status:
            data["status"] = status
        if author_name:
            data["author_name"] = author_name
        if author_email:
            data["author_email"] = author_email

        return self.client.put(f"/wp/v2/comments/{comment_id}", data)

    def action_delete(self, comment_id: int, force: bool = False):
        params = {"force": "true"} if force else {}
        return self.client.delete(f"/wp/v2/comments/{comment_id}", params)

    def action_approve(self, comment_id: int):
        return self.action_update(comment_id, status="approved")

    def action_spam(self, comment_id: int):
        return self.action_update(comment_id, status="spam")

    def action_bulk_moderate(self, comment_ids: List[int], action: str):
        results = []

        for comment_id in comment_ids:
            if action == "approve":
                result = self.action_approve(comment_id)
            elif action == "spam":
                result = self.action_spam(comment_id)
            elif action == "trash":
                result = self.action_update(comment_id, status="trash")
            elif action == "delete":
                result = self.action_delete(comment_id, force=True)
            else:
                results.append({
                    "comment_id": comment_id,
                    "success": False,
                    "error": f"Unknown action: {action}"
                })
                continue

            results.append({
                "comment_id": comment_id,
                "success": result.success,
                "error": result.error
            })

        successful = sum(1 for r in results if r["success"])
        return ActionResult(
            action="bulk-moderate",
            status=ActionStatus.SUCCESS if successful > 0 else ActionStatus.FAILED,
            data={"total": len(results), "successful": successful, "results": results}
        )
