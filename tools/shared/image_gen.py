"""OPAI Shared Image Generation — Nano Banana 2 (Gemini) image generation.

Generates images via Google's Gemini API using Nano Banana 2 (Gemini 3.1 Flash Image)
with built-in prompt templates for 3D scroll animation websites.

Usage in any OPAI FastAPI service:

    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
    from image_gen import generate_image, generate_scroll_frames

    # Basic image generation
    result = await generate_image("A premium keyboard on white background")

    # Scroll animation frame pair (start + end)
    frames = await generate_scroll_frames(
        product_name="MK-1 Keyboard",
        product_type="mechanical keyboard",
        bg_color="#000000",
        transition_type="exploded",
        internal_parts="switches, PCB, plate, stabilizers, keycaps",
    )

Models available:
    - gemini-3.1-flash-image-preview  (Nano Banana 2 — default, fastest)
    - gemini-3-pro-image-preview      (Nano Banana Pro — highest quality)
    - gemini-2.5-flash-image          (Nano Banana v1 — legacy)

Free tier: 500 images/day at 1024x1024 (no credit card required).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

import httpx

log = logging.getLogger("opai.image_gen")

# ── Configuration ────────────────────────────────────────────────────────────

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models"

MODELS = {
    "nano-banana-2": "gemini-3.1-flash-image-preview",
    "nano-banana-pro": "gemini-3-pro-image-preview",
    "nano-banana": "gemini-2.5-flash-image",
}
DEFAULT_MODEL = "nano-banana-2"

ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"]
IMAGE_SIZES = ["512px", "1K", "2K", "4K"]


def _get_api_key() -> str:
    """Get Gemini API key from environment."""
    key = os.getenv("GEMINI_API_KEY", "")
    if not key:
        raise ValueError(
            "GEMINI_API_KEY not set. Add it to your .env or vault."
        )
    return key


def _resolve_model(model: str) -> str:
    """Resolve friendly model name to Gemini model ID."""
    return MODELS.get(model, model)


# ── Core Generation ──────────────────────────────────────────────────────────

async def generate_image(
    prompt: str,
    *,
    model: str = DEFAULT_MODEL,
    aspect_ratio: str = "1:1",
    image_size: str = "2K",
    reference_image_path: Optional[str] = None,
    output_path: Optional[str] = None,
    timeout: int = 120,
) -> dict:
    """Generate an image using Nano Banana 2 (Gemini Image API).

    Args:
        prompt: Text description of the image to generate.
        model: Model name ('nano-banana-2', 'nano-banana-pro', or full model ID).
        aspect_ratio: Image aspect ratio (1:1, 3:4, 4:3, 9:16, 16:9).
        image_size: Output size (512px, 1K, 2K, 4K).
        reference_image_path: Optional path to a reference image for style/content guidance.
        output_path: Optional file path to save the generated image. Auto-creates dirs.
        timeout: Request timeout in seconds.

    Returns:
        {
            "image_data": bytes,         # Raw image bytes (PNG)
            "image_b64": str,            # Base64-encoded image
            "text": str | None,          # Any text response from the model
            "saved_to": str | None,      # File path if output_path was provided
            "model": str,
            "duration_ms": int,
        }
    """
    api_key = _get_api_key()
    model_id = _resolve_model(model)
    url = f"{GEMINI_API_URL}/{model_id}:generateContent?key={api_key}"

    # Build request parts
    parts = []

    # Add reference image if provided
    if reference_image_path:
        ref_path = Path(reference_image_path)
        if not ref_path.exists():
            raise FileNotFoundError(f"Reference image not found: {reference_image_path}")

        mime_type = _guess_mime(ref_path)
        img_b64 = base64.b64encode(ref_path.read_bytes()).decode("utf-8")
        parts.append({
            "inlineData": {
                "mimeType": mime_type,
                "data": img_b64,
            }
        })

    # Add text prompt
    parts.append({"text": prompt})

    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {
                "aspectRatio": aspect_ratio,
                "imageSize": image_size,
            },
        },
    }

    start = time.time()

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload)

        if resp.status_code != 200:
            error_body = resp.text[:500]
            log.error("Gemini image API error %d: %s", resp.status_code, error_body)
            raise RuntimeError(f"Gemini API error {resp.status_code}: {error_body}")

        data = resp.json()

    duration_ms = int((time.time() - start) * 1000)

    # Extract image and text from response
    image_data = None
    image_b64 = None
    text_response = None

    candidates = data.get("candidates", [])
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")

    parts = candidates[0].get("content", {}).get("parts", [])
    for part in parts:
        if "text" in part:
            text_response = part["text"]
        elif "inlineData" in part:
            image_b64 = part["inlineData"]["data"]
            image_data = base64.b64decode(image_b64)

    if not image_data:
        raise RuntimeError(
            f"No image in response. Text: {text_response or 'none'}"
        )

    # Save if output path provided
    saved_to = None
    if output_path:
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(image_data)
        saved_to = str(out)
        log.info("Image saved to %s (%d bytes)", saved_to, len(image_data))

    return {
        "image_data": image_data,
        "image_b64": image_b64,
        "text": text_response,
        "saved_to": saved_to,
        "model": model_id,
        "duration_ms": duration_ms,
    }


# ── Scroll Animation Templates ──────────────────────────────────────────────

TRANSITION_TYPES = {
    "exploded": {
        "description": "Product components separate and float apart",
        "end_prompt_template": (
            "Create a cinematic end-frame image that reveals the inner world of {product_name} "
            "in a visually striking way. Render an exploded technical view of the same "
            "{product_type}, with every major component precisely separated and floating in "
            "perfect alignment, suspended in mid-air against a {bg_color} background. "
            "Show the internal structure clearly and beautifully, including {internal_parts}, "
            "along with precision-machined components and materials that communicate "
            "craftsmanship and engineering depth. "
            "Hyper-realistic product visualization. Ultra-sharp focus, zero motion blur. "
            "Studio rim lighting. Premium, engineered, Apple-style industrial design aesthetic. "
            "Clean, dramatic, and modern. No labels, annotations, UI, text, or diagrams. "
            "Pure solid {bg_color} background, no gradients or textures."
        ),
    },
    "xray": {
        "description": "Product becomes transparent showing internal components",
        "end_prompt_template": (
            "X-ray image of the {product_name} showing all internal component parts in great "
            "detail. The outer shell becomes transparent revealing {internal_parts} underneath. "
            "Keep the {bg_color} background. No text, no labels. "
            "Ultra-sharp, hyper-realistic, cinematic quality."
        ),
    },
    "build": {
        "description": "Product assembles from nothing/blank background",
        "end_prompt_template": (
            "Fully assembled {product_name} ({product_type}) floating in the center of the "
            "frame on a {bg_color} background. Premium product photography, studio lighting, "
            "crisp and clean. The product looks polished, finished, and world-class. "
            "No text, no labels. Ultra-sharp focus."
        ),
    },
    "material": {
        "description": "Cross-section revealing materials and layers",
        "end_prompt_template": (
            "Cross-section view of {product_name} ({product_type}) revealing the internal "
            "layers and materials: {internal_parts}. Clean cutaway showing the engineering "
            "and material quality. Premium visualization on {bg_color} background. "
            "No text, no labels, no annotations. Hyper-realistic, studio lighting."
        ),
    },
}

START_FRAME_TEMPLATE = (
    "Create a high-quality product image of {product_name} ({product_type}). "
    "Place the product floating in the center of the frame with a slight, natural tilt, "
    "similar to premium ads. Use clean, soft studio lighting with subtle highlights "
    "and shadows so the product looks glossy, dimensional, and premium. "
    "Simple, minimal, distraction-free composition. "
    "Pure solid {bg_color} background. No reflections, no textures, no environmental elements. "
    "Product perfectly centered with generous negative space around it. "
    "High-resolution still image. Clean background for easy compositing. "
    "The final image should look like a top-tier commercial ad frame."
)

VIDEO_PROMPT_TEMPLATE = (
    "Smooth, cinematic transition. The {product_name} gradually {transition_action}. "
    "Keep the movement smooth, deliberate, and controlled. No chaotic motion. "
    "Maintain {bg_color} background throughout. Ultra-sharp, no motion blur. "
    "Premium, high-end feel."
)

TRANSITION_ACTIONS = {
    "exploded": "separates into its individual components, each piece floating apart in perfect alignment",
    "xray": "becomes transparent, revealing the internal components and engineering underneath",
    "build": "assembles from scattered components into its final complete form",
    "material": "splits along a cross-section revealing the internal layers and materials",
}


async def generate_scroll_frames(
    product_name: str,
    product_type: str,
    bg_color: str = "#000000",
    transition_type: str = "exploded",
    internal_parts: str = "",
    output_dir: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    aspect_ratio: str = "1:1",
    image_size: str = "2K",
) -> dict:
    """Generate start and end frames for a 3D scroll animation.

    Uses the Nano Banana 2 prompt templates from the Animated Website Resources
    reference to create a matched pair of images suitable for video transition.

    Args:
        product_name: Name of the product (e.g., "MK-1 Keyboard").
        product_type: Type of product (e.g., "mechanical keyboard").
        bg_color: Background color hex (MUST match your website bg).
        transition_type: One of 'exploded', 'xray', 'build', 'material'.
        internal_parts: Comma-separated internal components to show.
        output_dir: Directory to save frames. Creates start_frame.png + end_frame.png.
        model: Nano Banana model to use.
        aspect_ratio: Image aspect ratio.
        image_size: Output resolution.

    Returns:
        {
            "start_frame": { generate_image result },
            "end_frame": { generate_image result },
            "video_prompt": str,  # Ready-to-use prompt for Cling 3.0 / VO 3.1
            "transition_type": str,
            "product_name": str,
        }
    """
    if transition_type not in TRANSITION_TYPES:
        raise ValueError(
            f"Unknown transition type '{transition_type}'. "
            f"Options: {list(TRANSITION_TYPES.keys())}"
        )

    template_vars = {
        "product_name": product_name,
        "product_type": product_type,
        "bg_color": bg_color,
        "internal_parts": internal_parts or "internal components",
    }

    # Build prompts from templates
    start_prompt = START_FRAME_TEMPLATE.format(**template_vars)
    end_prompt = TRANSITION_TYPES[transition_type]["end_prompt_template"].format(**template_vars)

    # Generate start frame
    start_output = str(Path(output_dir) / "start_frame.png") if output_dir else None
    log.info("Generating start frame for %s...", product_name)
    start_frame = await generate_image(
        start_prompt,
        model=model,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
        output_path=start_output,
    )

    # Generate end frame using start frame as reference
    end_output = str(Path(output_dir) / "end_frame.png") if output_dir else None
    ref_path = start_output  # Use saved start frame as reference
    log.info("Generating end frame for %s (transition: %s)...", product_name, transition_type)
    end_frame = await generate_image(
        end_prompt,
        model=model,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
        reference_image_path=ref_path,
        output_path=end_output,
    )

    # Build video prompt for Cling 3.0 / VO 3.1
    video_prompt = VIDEO_PROMPT_TEMPLATE.format(
        product_name=product_name,
        transition_action=TRANSITION_ACTIONS[transition_type],
        bg_color=bg_color,
    )

    # Strip image bytes from return to keep it serializable
    for frame in [start_frame, end_frame]:
        frame.pop("image_data", None)

    return {
        "start_frame": start_frame,
        "end_frame": end_frame,
        "video_prompt": video_prompt,
        "transition_type": transition_type,
        "product_name": product_name,
    }


# ── Helpers ──────────────────────────────────────────────────────────────────

def _guess_mime(path: Path) -> str:
    """Guess MIME type from file extension."""
    ext = path.suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(ext, "image/png")


def get_available_models() -> dict:
    """Return available model names and their Gemini IDs."""
    return dict(MODELS)


def get_transition_types() -> dict:
    """Return available transition types with descriptions."""
    return {k: v["description"] for k, v in TRANSITION_TYPES.items()}
