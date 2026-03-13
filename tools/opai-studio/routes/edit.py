"""OPAI Studio -- AI Image Editing routes.

Reuses shared/image_gen.py with reference images for AI-powered
editing operations (inpaint, remove, replace bg, upscale, etc.).
"""
from __future__ import annotations
import base64
import logging
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user
from image_gen import generate_image

import config
from core.supabase import sb_get, sb_post
from routes.generate import _today_count, DAILY_LIMIT

log = logging.getLogger("studio.routes.edit")
router = APIRouter()


class EditRegion(BaseModel):
    left: float
    top: float
    width: float
    height: float


class EditRequest(BaseModel):
    image_b64: str
    operation: str
    instruction: Optional[str] = None
    region: Optional[EditRegion] = None
    override_limit: bool = False


# Prompt templates per operation
OPERATION_PROMPTS = {
    "fill_bg": "Fill transparent or white areas with {instruction}. Keep existing content intact and unchanged. Blend naturally.",
    "replace_bg": "Replace the background with {instruction}. Keep the foreground subject completely intact and unchanged.",
    "remove_bg": "Remove the background from this image. {instruction}. Output the subject isolated on a clean white background.",
    "make_transparent": "Remove the background from this image. {instruction}. Output only the main subject with no background, suitable for a transparent PNG.",
    "remove": "Remove {instruction} from the image. Fill the removed area matching the surrounding background naturally.",
    "inpaint": "Replace the indicated area with {instruction}. Blend naturally with the surrounding image.",
    "outpaint": "Extend this image beyond its borders. Continue the scene naturally: {instruction}",
    "upscale": "Create a higher resolution version of this image. Enhance details and sharpness while maintaining the exact same composition and content.",
    "style": "Apply {instruction} style to this image. Maintain the composition and subjects, transform only the visual style.",
    "enhance": "Enhance the colors, contrast, and overall quality of this image. {instruction}",
}


@router.post("/api/edit")
async def edit_image(body: EditRequest, user: AuthUser = Depends(get_current_user)):
    """Apply an AI editing operation to an image region or full canvas."""

    # Validate operation
    if body.operation not in OPERATION_PROMPTS:
        raise HTTPException(400, f"Unknown operation: {body.operation}")

    # Enforce daily limit (shares counter with generate)
    count = await _today_count(user.id)
    if count >= DAILY_LIMIT and not body.override_limit:
        raise HTTPException(
            429,
            f"Daily limit reached ({count}/{DAILY_LIMIT}). "
            "Enable the override toggle to keep generating.",
        )

    # Build prompt from template
    instruction = body.instruction or "naturally"
    prompt = OPERATION_PROMPTS[body.operation].format(instruction=instruction)

    # Save the reference image to a temp file
    try:
        image_bytes = base64.b64decode(body.image_b64)
    except Exception:
        raise HTTPException(400, "Invalid base64 image data")

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp.write(image_bytes)
        ref_path = tmp.name

    try:
        result = await generate_image(
            prompt,
            reference_image_path=ref_path,
        )
    except Exception as e:
        log.error("AI edit failed: %s", e)
        raise HTTPException(500, f"AI edit failed: {e}")
    finally:
        # Clean up temp file
        Path(ref_path).unlink(missing_ok=True)

    # Log to studio_generations with source='edit'
    gen_id = str(uuid.uuid4())
    storage_key = f"_edits/{gen_id}.png"
    save_path = config.PROJECTS_DIR / storage_key
    save_path.parent.mkdir(parents=True, exist_ok=True)
    save_path.write_bytes(result["image_data"])

    await sb_post("studio_generations", {
        "user_id": user.id,
        "prompt": f"[edit:{body.operation}] {prompt}",
        "model": result["model"],
        "storage_key": storage_key,
        "duration_ms": result["duration_ms"],
    })

    return {
        "image_b64": result["image_b64"],
        "operation": body.operation,
        "duration_ms": result["duration_ms"],
        "usage": {
            "used": count + 1,
            "limit": DAILY_LIMIT,
            "remaining": max(0, DAILY_LIMIT - count - 1),
        },
    }
