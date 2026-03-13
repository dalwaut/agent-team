"""OPAI Studio -- AI Generation routes."""
from __future__ import annotations
import base64
import logging
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user
from image_gen import generate_image, get_available_models, get_transition_types, generate_scroll_frames

import config
from core.supabase import sb_get, sb_post, sb_patch

log = logging.getLogger("studio.routes.generate")
router = APIRouter()

DAILY_LIMIT = 50


class GenerateRequest(BaseModel):
    prompt: str
    model: str = "nano-banana-2"
    aspect_ratio: str = "1:1"
    image_size: str = "2K"
    preset_id: Optional[str] = None
    image_id: Optional[str] = None
    project_id: Optional[str] = None
    override_limit: bool = False


class ScrollFrameRequest(BaseModel):
    product_name: str
    product_type: str
    bg_color: str = "#000000"
    transition_type: str = "exploded"
    internal_parts: str = ""


async def _today_count(user_id: str) -> int:
    """Count how many generations this user has made today (UTC)."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z")
    rows = await sb_get(
        f"studio_generations?user_id=eq.{user_id}"
        f"&created_at=gte.{today}"
        f"&select=id"
    )
    return len(rows) if rows else 0


@router.get("/api/generate/models")
async def list_models():
    return {
        "models": get_available_models(),
        "transitions": get_transition_types(),
        "aspect_ratios": ["1:1", "3:4", "4:3", "9:16", "16:9"],
        "image_sizes": ["512px", "1K", "2K", "4K"],
    }


@router.get("/api/generate/usage")
async def generation_usage(user: AuthUser = Depends(get_current_user)):
    """Return today's generation count and the daily limit."""
    count = await _today_count(user.id)
    return {
        "used": count,
        "limit": DAILY_LIMIT,
        "remaining": max(0, DAILY_LIMIT - count),
    }


@router.post("/api/generate")
async def generate(body: GenerateRequest, user: AuthUser = Depends(get_current_user)):
    # Enforce daily limit unless override is set
    count = await _today_count(user.id)
    if count >= DAILY_LIMIT and not body.override_limit:
        raise HTTPException(
            429,
            f"Daily limit reached ({count}/{DAILY_LIMIT}). "
            "Enable the override toggle to keep generating.",
        )

    try:
        result = await generate_image(
            body.prompt,
            model=body.model,
            aspect_ratio=body.aspect_ratio,
            image_size=body.image_size,
        )
    except Exception as e:
        log.error("Generation failed: %s", e)
        raise HTTPException(500, f"Generation failed: {e}")

    # Determine where to save
    project_id = body.project_id
    if body.image_id:
        images = await sb_get(f"studio_images?id=eq.{body.image_id}&user_id=eq.{user.id}&select=project_id")
        if images:
            project_id = images[0]["project_id"]

    # Save generated image to disk
    gen_id = str(uuid.uuid4())
    storage_key = f"{project_id}/generations/{gen_id}.png" if project_id else f"_unassigned/{gen_id}.png"
    save_path = config.PROJECTS_DIR / storage_key
    save_path.parent.mkdir(parents=True, exist_ok=True)
    save_path.write_bytes(result["image_data"])

    # Log generation in DB
    gen_row = await sb_post("studio_generations", {
        "user_id": user.id,
        "image_id": body.image_id,
        "prompt": body.prompt,
        "model": result["model"],
        "aspect_ratio": body.aspect_ratio,
        "image_size": body.image_size,
        "preset_id": body.preset_id,
        "storage_key": storage_key,
        "duration_ms": result["duration_ms"],
    })

    return {
        "image_b64": result["image_b64"],
        "generation_id": gen_row["id"],
        "storage_key": storage_key,
        "duration_ms": result["duration_ms"],
        "model": result["model"],
        "prompt_used": body.prompt,
        "usage": {
            "used": count + 1,
            "limit": DAILY_LIMIT,
            "remaining": max(0, DAILY_LIMIT - count - 1),
        },
    }


@router.post("/api/generate/scroll-frames")
async def gen_scroll_frames(body: ScrollFrameRequest, user: AuthUser = Depends(get_current_user)):
    try:
        output_dir = str(config.PROJECTS_DIR / "_scroll-frames" / str(uuid.uuid4()))
        result = await generate_scroll_frames(
            product_name=body.product_name,
            product_type=body.product_type,
            bg_color=body.bg_color,
            transition_type=body.transition_type,
            internal_parts=body.internal_parts,
            output_dir=output_dir,
        )
    except Exception as e:
        log.error("Scroll frame generation failed: %s", e)
        raise HTTPException(500, f"Scroll frame generation failed: {e}")

    return result
