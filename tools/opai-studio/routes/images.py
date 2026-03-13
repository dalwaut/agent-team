"""OPAI Studio -- Image routes."""
from __future__ import annotations
import base64
import io
import logging
import sys
import uuid
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config
from core.supabase import sb_get, sb_post, sb_patch, sb_delete

log = logging.getLogger("studio.routes.images")
router = APIRouter()

ALLOWED_TYPES = {"image/png", "image/jpeg", "image/webp"}


class ImageCreate(BaseModel):
    name: str = "Untitled"
    width: int = 1024
    height: int = 1024
    preset_id: Optional[str] = None
    canvas_json: Optional[dict] = None

class ImageUpdate(BaseModel):
    name: Optional[str] = None
    tags: Optional[list[str]] = None
    canvas_json: Optional[dict] = None

class SaveCanvasBody(BaseModel):
    canvas_json: dict

class StoreB64Body(BaseModel):
    """Accept base64 image data and persist to disk, return a URL."""
    image_b64: str
    name: str = "image"
    project_id: Optional[str] = None


def _default_canvas(width: int, height: int) -> dict:
    """Create a default Fabric.js canvas JSON with white background."""
    return {
        "version": "5.3.1",
        "objects": [],
        "background": "#ffffff",
    }


@router.get("/api/images/{image_id}")
async def get_image(image_id: str, user: AuthUser = Depends(get_current_user)):
    rows = await sb_get(f"studio_images?id=eq.{image_id}&user_id=eq.{user.id}")
    if not rows:
        raise HTTPException(404, "Image not found")
    return rows[0]


@router.post("/api/projects/{project_id}/images")
async def create_image(project_id: str, body: ImageCreate, user: AuthUser = Depends(get_current_user)):
    projects = await sb_get(f"studio_projects?id=eq.{project_id}&user_id=eq.{user.id}&select=id")
    if not projects:
        raise HTTPException(404, "Project not found")

    width, height = body.width, body.height
    if body.preset_id:
        presets = await sb_get(f"studio_presets?id=eq.{body.preset_id}&select=width,height")
        if presets:
            width, height = presets[0]["width"], presets[0]["height"]

    canvas = body.canvas_json or _default_canvas(width, height)

    row = await sb_post("studio_images", {
        "project_id": project_id,
        "user_id": user.id,
        "name": body.name,
        "width": width,
        "height": height,
        "preset_id": body.preset_id,
        "canvas_json": canvas,
        "source_type": "blank",
    })
    return row


@router.patch("/api/images/{image_id}")
async def update_image(image_id: str, body: ImageUpdate, user: AuthUser = Depends(get_current_user)):
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    if not data:
        raise HTTPException(400, "No fields to update")
    row = await sb_patch(f"studio_images?id=eq.{image_id}&user_id=eq.{user.id}", data)
    return row


@router.delete("/api/images/{image_id}")
async def delete_image(image_id: str, user: AuthUser = Depends(get_current_user)):
    await sb_delete(f"studio_images?id=eq.{image_id}&user_id=eq.{user.id}")
    return {"ok": True}


@router.post("/api/images/{image_id}/upload")
async def upload_image(
    image_id: str,
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    images = await sb_get(f"studio_images?id=eq.{image_id}&user_id=eq.{user.id}&select=id,project_id")
    if not images:
        raise HTTPException(404, "Image not found")

    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"Unsupported type: {file.content_type}. Use PNG, JPEG, or WebP.")

    data = await file.read()
    if len(data) > config.MAX_UPLOAD_SIZE:
        raise HTTPException(400, f"File too large (max {config.MAX_UPLOAD_SIZE // (1024*1024)}MB)")

    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        w, h = img.size
        fmt = img.format or "PNG"
    except Exception:
        raise HTTPException(400, "Could not read image file")

    project_id = images[0]["project_id"]
    ext = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}.get(fmt, "png")
    file_id = str(uuid.uuid4())
    storage_key = f"{project_id}/images/{image_id}/{file_id}.{ext}"
    save_path = config.PROJECTS_DIR / storage_key
    save_path.parent.mkdir(parents=True, exist_ok=True)
    save_path.write_bytes(data)

    canvas = {
        "version": "5.3.1",
        "objects": [{
            "type": "image",
            "src": f"/api/assets/{storage_key}",
            "left": 0, "top": 0,
            "scaleX": 1, "scaleY": 1,
            "name": "Uploaded Image",
        }],
        "background": "#ffffff",
    }

    await sb_patch(f"studio_images?id=eq.{image_id}&user_id=eq.{user.id}", {
        "width": w,
        "height": h,
        "canvas_json": canvas,
        "source_type": "upload",
    })

    return {"ok": True, "width": w, "height": h, "format": fmt, "storage_key": storage_key}


@router.post("/api/images/{image_id}/save-canvas")
async def save_canvas(image_id: str, body: SaveCanvasBody, user: AuthUser = Depends(get_current_user)):
    """Save the current canvas state."""
    row = await sb_patch(f"studio_images?id=eq.{image_id}&user_id=eq.{user.id}", {
        "canvas_json": body.canvas_json,
    })
    return {"ok": True}


@router.post("/api/images/store-b64")
async def store_b64(body: StoreB64Body, user: AuthUser = Depends(get_current_user)):
    """Save base64 image data to disk and return a servable asset URL.

    Prevents massive data-URIs from bloating canvas_json.
    Frontend calls this before adding generated/pasted images to the canvas.
    """
    raw = body.image_b64
    if "," in raw and raw.index(",") < 100:
        raw = raw.split(",", 1)[1]

    try:
        data = base64.b64decode(raw)
    except Exception:
        raise HTTPException(400, "Invalid base64 data")

    if len(data) > config.MAX_UPLOAD_SIZE:
        raise HTTPException(400, "Image too large")

    ext = "png"
    if data[:3] == b"\xff\xd8\xff":
        ext = "jpg"
    elif data[:4] == b"RIFF" and len(data) > 11 and data[8:12] == b"WEBP":
        ext = "webp"

    project_id = body.project_id or "_shared"
    file_id = str(uuid.uuid4())
    storage_key = f"{project_id}/canvas/{file_id}.{ext}"
    save_path = config.PROJECTS_DIR / storage_key
    save_path.parent.mkdir(parents=True, exist_ok=True)
    save_path.write_bytes(data)

    asset_url = f"/api/assets/{storage_key}"
    return {"url": asset_url, "storage_key": storage_key, "size": len(data)}


@router.post("/api/images/upload-file")
async def upload_file_to_canvas(
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    """Upload an image file and return a servable URL for use on the canvas.

    Unlike /upload (which replaces an image's canvas), this just stores
    the file and returns a URL that can be added as a layer.
    """
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"Unsupported type: {file.content_type}. Use PNG, JPEG, or WebP.")

    data = await file.read()
    if len(data) > config.MAX_UPLOAD_SIZE:
        raise HTTPException(400, f"File too large (max {config.MAX_UPLOAD_SIZE // (1024*1024)}MB)")

    try:
        from PIL import Image as PILImage
        img = PILImage.open(io.BytesIO(data))
        w, h = img.size
    except Exception:
        raise HTTPException(400, "Could not read image file")

    ext = file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "png"
    if ext not in ("png", "jpg", "jpeg", "webp"):
        ext = "png"

    file_id = str(uuid.uuid4())
    storage_key = f"_uploads/{file_id}.{ext}"
    save_path = config.PROJECTS_DIR / storage_key
    save_path.parent.mkdir(parents=True, exist_ok=True)
    save_path.write_bytes(data)

    asset_url = f"/api/assets/{storage_key}"
    return {"url": asset_url, "width": w, "height": h, "storage_key": storage_key}
