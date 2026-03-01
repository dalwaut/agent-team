"""HELM — GitHub REST API connector for Git-based content publishing.

Used to push Markdown/MDX content files to a GitHub repo that Netlify
(or any other platform) deploys from automatically.
"""

from __future__ import annotations

import base64
import logging
import re
from typing import Optional

import httpx

log = logging.getLogger("helm.connectors.github")

_GITHUB_API = "https://api.github.com"


def _slugify(text: str) -> str:
    """Convert a title to a URL-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    return slug[:80].strip("-")


def _build_frontmatter(title: str, date: str, extra: Optional[dict] = None) -> str:
    """Build YAML frontmatter block."""
    lines = [
        "---",
        f'title: "{title}"',
        f'date: "{date}"',
        "draft: false",
    ]
    if extra:
        for k, v in extra.items():
            if isinstance(v, str):
                lines.append(f'{k}: "{v}"')
            elif isinstance(v, bool):
                lines.append(f"{k}: {str(v).lower()}")
            else:
                lines.append(f"{k}: {v}")
    lines.append("---")
    return "\n".join(lines)


class GitHubConnector:
    """GitHub REST API v3 connector for file-based content commits."""

    def __init__(self, token: str, repo: str, branch: str = "main"):
        """Initialize connector.

        Args:
            token:  GitHub Personal Access Token (repo write scope)
            repo:   Repository in owner/name format (e.g. 'boutabyte/boutacare')
            branch: Branch to commit to (default: 'main')
        """
        self.token = token
        self.repo = repo
        self.branch = branch
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "HELM/1.0",
        }

    async def test_connection(self) -> dict:
        """Verify token and repo access.

        Returns:
            {ok: bool, repo: str, default_branch: str, error?: str}
        """
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{_GITHUB_API}/repos/{self.repo}",
                headers=self._headers,
            )
        if r.status_code == 200:
            data = r.json()
            return {
                "ok": True,
                "repo": data.get("full_name", self.repo),
                "default_branch": data.get("default_branch", "main"),
                "private": data.get("private", False),
            }
        return {"ok": False, "status": r.status_code, "error": r.text[:200]}

    async def get_file_sha(self, path: str) -> Optional[str]:
        """Get the SHA of an existing file (needed to update it).

        Returns None if the file doesn't exist yet.
        """
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{_GITHUB_API}/repos/{self.repo}/contents/{path}",
                headers=self._headers,
                params={"ref": self.branch},
            )
        if r.status_code == 200:
            return r.json().get("sha")
        return None

    async def commit_file(
        self,
        path: str,
        content: str,
        commit_message: str,
    ) -> dict:
        """Create or update a file in the repository.

        Args:
            path:           File path in repo (e.g. 'content/posts/my-post.md')
            content:        File content as a string (UTF-8)
            commit_message: Git commit message

        Returns:
            {
                "sha":     "<commit sha>",
                "html_url": "https://github.com/owner/repo/blob/main/path",
                "path":    path,
            }
        """
        # Check if file already exists (need SHA to update)
        existing_sha = await self.get_file_sha(path)

        payload: dict = {
            "message": commit_message,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "branch": self.branch,
        }
        if existing_sha:
            payload["sha"] = existing_sha

        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.put(
                f"{_GITHUB_API}/repos/{self.repo}/contents/{path}",
                headers=self._headers,
                json=payload,
            )
            r.raise_for_status()
            data = r.json()

        commit_sha = data.get("commit", {}).get("sha", "")
        content_obj = data.get("content", {})
        html_url = content_obj.get("html_url", "")

        log.info("GitHub commit %s: %s → %s", commit_sha[:8], path, self.repo)
        return {
            "sha": commit_sha,
            "html_url": html_url,
            "path": path,
        }

    async def push_markdown_post(
        self,
        title: str,
        body_markdown: str,
        content_dir: str = "content/posts",
        extra_frontmatter: Optional[dict] = None,
        date: Optional[str] = None,
    ) -> dict:
        """Write a Markdown post file with YAML frontmatter and commit it.

        Args:
            title:              Post title
            body_markdown:      Post body in Markdown (no frontmatter)
            content_dir:        Directory in repo to place the file
            extra_frontmatter:  Additional frontmatter key-value pairs
            date:               ISO date string (defaults to today)

        Returns:
            {
                "sha":      "<commit sha>",
                "html_url": "https://github.com/...",
                "path":     "content/posts/my-post.md",
                "slug":     "my-post",
            }
        """
        from datetime import date as _date_cls
        post_date = date or _date_cls.today().isoformat()
        slug = _slugify(title)
        filename = f"{post_date}-{slug}.md"
        path = content_dir.rstrip("/") + "/" + filename

        frontmatter = _build_frontmatter(title, post_date, extra_frontmatter)
        full_content = frontmatter + "\n\n" + body_markdown.strip() + "\n"

        commit_msg = f"feat(content): add post — {title[:60]}"
        result = await self.commit_file(path, full_content, commit_msg)
        result["slug"] = slug
        return result
