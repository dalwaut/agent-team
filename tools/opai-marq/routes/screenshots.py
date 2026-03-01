"""Marq — Screenshot/icon/asset upload, list, delete, reorder, and serving routes."""

from __future__ import annotations

import logging
import sys
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config
from core.supabase import _sb_get, _sb_post, _sb_patch, _sb_delete
from routes.apps import check_access

log = logging.getLogger("marq.routes.screenshots")
router = APIRouter()

ASSETS_DIR = config.DATA_DIR / "assets"


# ── List screenshots ─────────────────────────────────────────
@router.get("/api/apps/{app_id}/screenshots")
async def list_screenshots(app_id: str, user: AuthUser = Depends(get_current_user)):
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")
    return await _sb_get(
        f"mrq_screenshots?app_id=eq.{app_id}&order=device_type,display_order&select=*"
    )


# ── Upload screenshot ────────────────────────────────────────
@router.post("/api/apps/{app_id}/screenshots")
async def upload_screenshot(
    app_id: str,
    file: UploadFile = File(...),
    store: str = Form(...),
    device_type: str = Form(...),
    locale: str = Form("en-US"),
    display_order: int = Form(0),
    user: AuthUser = Depends(get_current_user),
):
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    # Validate content type
    ct = file.content_type or ""
    if ct not in ("image/png", "image/jpeg", "image/webp"):
        raise HTTPException(400, f"Unsupported image format: {ct}")

    # Read file
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 10MB)")

    # Get image dimensions
    width, height, fmt = _get_image_info(data)

    # Save to disk
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(ct, ".png")
    filename = f"{uuid.uuid4().hex}{ext}"
    asset_dir = ASSETS_DIR / app_id / "screenshots"
    asset_dir.mkdir(parents=True, exist_ok=True)
    filepath = asset_dir / filename
    filepath.write_bytes(data)

    storage_key = f"{app_id}/screenshots/{filename}"

    # Basic dimension validation
    is_valid = width > 0 and height > 0

    # Create DB record
    row = {
        "app_id": app_id,
        "store": store,
        "device_type": device_type,
        "locale": locale,
        "display_order": display_order,
        "storage_key": storage_key,
        "width": width,
        "height": height,
        "format": fmt,
        "is_valid": is_valid,
    }
    result = await _sb_post("mrq_screenshots", row)
    return result[0] if isinstance(result, list) and result else result


# ── Upload icon ──────────────────────────────────────────────
@router.post("/api/apps/{app_id}/icon")
async def upload_icon(
    app_id: str,
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    ct = file.content_type or ""
    if ct != "image/png":
        raise HTTPException(400, "Icon must be PNG format")

    data = await file.read()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(400, "Icon too large (max 5MB)")

    width, height, _ = _get_image_info(data)

    if width not in (512, 1024) or height not in (512, 1024):
        log.warning("Icon dimensions %dx%d — expected 512x512 or 1024x1024", width, height)

    # Save to disk
    icon_dir = ASSETS_DIR / app_id
    icon_dir.mkdir(parents=True, exist_ok=True)
    filepath = icon_dir / "icon.png"
    filepath.write_bytes(data)

    storage_key = f"{app_id}/icon.png"

    # Update app record
    await _sb_patch(f"mrq_apps?id=eq.{app_id}", {"icon_storage_key": storage_key})

    return {"ok": True, "storage_key": storage_key, "width": width, "height": height}


# ── Serve asset files ────────────────────────────────────────
@router.get("/api/assets/{path:path}")
async def serve_asset(path: str, user: AuthUser = Depends(get_current_user)):
    # Extract app_id from path (first segment)
    parts = path.split("/")
    if len(parts) < 2:
        raise HTTPException(404, "Asset not found")
    app_id = parts[0]

    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    filepath = ASSETS_DIR / path
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(404, "Asset not found")

    # Prevent path traversal
    try:
        filepath.resolve().relative_to(ASSETS_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "Invalid path")

    media_type = "image/png"
    if filepath.suffix == ".jpg" or filepath.suffix == ".jpeg":
        media_type = "image/jpeg"
    elif filepath.suffix == ".webp":
        media_type = "image/webp"

    return FileResponse(str(filepath), media_type=media_type)


# ── Reorder screenshot ───────────────────────────────────────
from pydantic import BaseModel

class ReorderBody(BaseModel):
    direction: int = 1  # +1 = move right/down, -1 = move left/up

@router.patch("/api/screenshots/{screenshot_id}/reorder")
async def reorder_screenshot(
    screenshot_id: str,
    body: ReorderBody,
    user: AuthUser = Depends(get_current_user),
):
    rows = await _sb_get(f"mrq_screenshots?id=eq.{screenshot_id}&select=*")
    if not rows:
        raise HTTPException(404, "Screenshot not found")
    shot = rows[0]
    if not await check_access(user, shot["app_id"]):
        raise HTTPException(403, "Access denied")

    # Get all siblings in same group
    siblings = await _sb_get(
        f"mrq_screenshots?app_id=eq.{shot['app_id']}&store=eq.{shot['store']}&device_type=eq.{shot['device_type']}&order=display_order&select=id,display_order"
    )

    # Find current index
    idx = None
    for i, s in enumerate(siblings):
        if s["id"] == screenshot_id:
            idx = i
            break

    if idx is None:
        raise HTTPException(404, "Screenshot not found in group")

    direction = body.direction
    swap_idx = idx + direction

    if swap_idx < 0 or swap_idx >= len(siblings):
        return {"ok": True}

    # Swap display_order values
    a_id = siblings[idx]["id"]
    b_id = siblings[swap_idx]["id"]
    a_order = siblings[idx]["display_order"]
    b_order = siblings[swap_idx]["display_order"]

    await _sb_patch(f"mrq_screenshots?id=eq.{a_id}", {"display_order": b_order})
    await _sb_patch(f"mrq_screenshots?id=eq.{b_id}", {"display_order": a_order})

    return {"ok": True}


# ── Import from local OPAI file path ─────────────────────────
from pydantic import BaseModel as _BaseModel

class ImportFromPathBody(_BaseModel):
    file_path: str
    asset_type: str = "screenshot"  # "screenshot", "icon", "feature_graphic"
    store: str = "apple"
    device_type: str = "phone"
    locale: str = "en-US"
    display_order: int = 0


@router.post("/api/apps/{app_id}/import-from-path")
async def import_from_path(
    app_id: str,
    body: ImportFromPathBody,
    user: AuthUser = Depends(get_current_user),
):
    """Import an image from a local OPAI filesystem path into assets."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    from routes.apps import _get_user_root, _resolve_safe

    # Resolve the file within the user's allowed root
    user_root = _get_user_root(user)
    try:
        source = _resolve_safe(user_root, body.file_path)
    except HTTPException:
        raise HTTPException(403, "File path not accessible")

    if not source.is_file():
        raise HTTPException(404, "File not found: " + body.file_path)

    # Validate it's an image
    suffix = source.suffix.lower()
    if suffix not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(400, "Not a supported image format: " + suffix)

    data = source.read_bytes()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 10MB)")

    width, height, fmt = _get_image_info(data)

    if body.asset_type == "icon":
        # Save as icon
        icon_dir = ASSETS_DIR / app_id
        icon_dir.mkdir(parents=True, exist_ok=True)
        dest = icon_dir / "icon.png"
        dest.write_bytes(data)

        storage_key = f"{app_id}/icon.png"
        await _sb_patch(f"mrq_apps?id=eq.{app_id}", {"icon_storage_key": storage_key})

        return {"ok": True, "asset_type": "icon", "storage_key": storage_key, "width": width, "height": height}

    else:
        # Save as screenshot (or feature_graphic)
        ext = {".png": ".png", ".jpg": ".jpg", ".jpeg": ".jpg", ".webp": ".webp"}.get(suffix, ".png")
        filename = f"{uuid.uuid4().hex}{ext}"
        asset_dir = ASSETS_DIR / app_id / "screenshots"
        asset_dir.mkdir(parents=True, exist_ok=True)
        dest = asset_dir / filename
        dest.write_bytes(data)

        storage_key = f"{app_id}/screenshots/{filename}"
        is_valid = width > 0 and height > 0

        device_type = body.device_type
        if body.asset_type == "feature_graphic":
            device_type = "feature_graphic"

        row = {
            "app_id": app_id,
            "store": body.store,
            "device_type": device_type,
            "locale": body.locale,
            "display_order": body.display_order,
            "storage_key": storage_key,
            "width": width,
            "height": height,
            "format": fmt,
            "is_valid": is_valid,
        }
        result = await _sb_post("mrq_screenshots", row)
        created = result[0] if isinstance(result, list) and result else result
        return {"ok": True, "asset_type": body.asset_type, "screenshot": created}


# ── Delete screenshot ────────────────────────────────────────
@router.delete("/api/screenshots/{screenshot_id}")
async def delete_screenshot(screenshot_id: str, user: AuthUser = Depends(get_current_user)):
    rows = await _sb_get(f"mrq_screenshots?id=eq.{screenshot_id}&select=app_id,storage_key")
    if not rows:
        raise HTTPException(404, "Screenshot not found")
    if not await check_access(user, rows[0]["app_id"]):
        raise HTTPException(403, "Access denied")

    # Delete file from disk
    storage_key = rows[0].get("storage_key")
    if storage_key:
        filepath = ASSETS_DIR / storage_key
        if filepath.exists():
            filepath.unlink()

    await _sb_delete(f"mrq_screenshots?id=eq.{screenshot_id}")
    return {"ok": True}


# ── Helpers ──────────────────────────────────────────────────
def _get_image_info(data: bytes) -> tuple:
    """Get width, height, format from image bytes. Uses Pillow if available, fallback to basic PNG header parsing."""
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(data))
        fmt = (img.format or "PNG").upper()
        return img.width, img.height, fmt
    except ImportError:
        pass

    # Fallback: parse PNG header
    if data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 24:
        import struct
        w = struct.unpack('>I', data[16:20])[0]
        h = struct.unpack('>I', data[20:24])[0]
        return w, h, "PNG"

    # JPEG SOF marker parsing
    if data[:2] == b'\xff\xd8':
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                break
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                import struct
                h = struct.unpack('>H', data[i + 5:i + 7])[0]
                w = struct.unpack('>H', data[i + 7:i + 9])[0]
                return w, h, "JPEG"
            length = int.from_bytes(data[i + 2:i + 4], 'big')
            i += 2 + length

        return 0, 0, "JPEG"

    return 0, 0, "UNKNOWN"
