"""
OPAI Docs — Backend API for secure workspace file viewing.

Serves workspace markdown files through an auth-gated API.
Static SPA + wiki files continue to be served by Caddy.
This backend handles only /api/* routes for file viewing.
"""

import os
import sys
from pathlib import Path

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
import aiofiles

# Shared auth
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from auth import get_current_user, AuthUser  # noqa: E402

# ── Config ──────────────────────────────────────────────────────
WORKSPACE_ROOT = Path(os.getenv("OPAI_WORKSPACE", "/workspace/synced/opai"))
MAX_FILE_SIZE = 2 * 1024 * 1024  # 2MB max for rendering

# Allowed base directories (relative to workspace root)
ALLOWED_DIRS = {
    "notes", "Library", "reports", "Templates", "workflows",
    "tools", "config", "scripts", "tasks", "Research", "Documents",
}

app = FastAPI(title="OPAI Docs API", docs_url=None, redoc_url=None)


# ── Path Safety ─────────────────────────────────────────────────

def _resolve_safe_path(relative_path: str) -> Path:
    """Resolve and validate a workspace-relative path. Prevents traversal."""
    clean = relative_path.strip().lstrip("/").lstrip("\\")

    if not clean:
        raise HTTPException(status_code=400, detail="Path is required")

    # Block obvious traversal
    if ".." in clean.split("/") or ".." in clean.split("\\"):
        raise HTTPException(status_code=403, detail="Path traversal denied")

    target = (WORKSPACE_ROOT / clean).resolve()
    root_resolved = WORKSPACE_ROOT.resolve()

    # Must remain inside workspace
    if not str(target).startswith(str(root_resolved) + os.sep) and target != root_resolved:
        raise HTTPException(status_code=403, detail="Access denied — path outside workspace")

    # Must be in an allowed top-level directory
    try:
        rel = target.relative_to(root_resolved)
        top_dir = rel.parts[0] if rel.parts else ""
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    if top_dir not in ALLOWED_DIRS:
        raise HTTPException(status_code=403, detail=f"Directory '{top_dir}' is not viewable")

    return target


def _is_binary(data: bytes, sample_size: int = 8192) -> bool:
    """Check if file content appears to be binary."""
    chunk = data[:sample_size]
    # Null bytes are a strong binary indicator
    if b"\x00" in chunk:
        return True
    # High ratio of non-text bytes
    non_text = sum(1 for b in chunk if b < 8 or (b > 13 and b < 32 and b != 27))
    return non_text / max(len(chunk), 1) > 0.1


# ── API Routes ──────────────────────────────────────────────────

@app.get("/view")
async def view_file(
    path: str = Query(..., description="Workspace-relative file path"),
    user: AuthUser = Depends(get_current_user),
):
    """Read a workspace file. Requires authentication."""
    target = _resolve_safe_path(path)

    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if not target.is_file():
        raise HTTPException(status_code=400, detail="Not a file")

    size = target.stat().st_size
    if size > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large for viewing")

    async with aiofiles.open(target, "rb") as f:
        raw = await f.read()

    if _is_binary(raw):
        raise HTTPException(status_code=415, detail="Binary files cannot be viewed")

    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        content = raw.decode("latin-1")

    # Determine file type for rendering hints
    suffix = target.suffix.lower()
    file_type = "markdown" if suffix in (".md", ".mdx") else "text"

    return {
        "path": path,
        "name": target.name,
        "content": content,
        "type": file_type,
        "size": size,
    }


@app.get("/health")
async def health():
    return {"status": "ok", "service": "opai-docs"}
