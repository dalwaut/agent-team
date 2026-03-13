"""OPAI Studio â Asset serving routes."""
from __future__ import annotations
import logging
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

import config

log = logging.getLogger("studio.routes.assets")
router = APIRouter()

MIME_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
}


@router.get("/api/assets/{path:path}")
async def serve_asset(path: str):
    """Serve a project asset file with path traversal protection."""
    try:
        resolved = (config.PROJECTS_DIR / path).resolve()
        resolved.relative_to(config.PROJECTS_DIR.resolve())
    except (ValueError, RuntimeError):
        raise HTTPException(403, "Access denied")

    if not resolved.is_file():
        raise HTTPException(404, "Asset not found")

    mime = MIME_MAP.get(resolved.suffix.lower(), "application/octet-stream")
    return FileResponse(str(resolved), media_type=mime)
