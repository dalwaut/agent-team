"""OPAI Docs — API routes: filtered docs, regenerate, auth config."""

import json

from fastapi import APIRouter, Depends, HTTPException

import config
import generator
from auth import get_current_user, require_admin, AuthUser

router = APIRouter(prefix="/api")


def _load_docs() -> dict:
    """Load docs.json from disk."""
    if not config.DOCS_JSON.exists():
        raise HTTPException(status_code=503, detail="Documentation not yet generated")
    try:
        return json.loads(config.DOCS_JSON.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to load docs: {e}")


def _filter_for_user(docs: dict, user: AuthUser) -> dict:
    """Filter docs based on user role and allowed_apps."""
    is_admin = user.is_admin
    allowed_apps = set(user.allowed_apps) if user.allowed_apps else set()

    # Filter sections first (categories depend on which sections survive)
    filtered_sections = []
    for section in docs.get("sections", []):
        vis = section.get("visibility", "all")
        app_id = section.get("app_id")

        if is_admin:
            # Admins see everything
            pass
        elif app_id and app_id in allowed_apps:
            # User has explicit app access — show regardless of visibility
            pass
        elif vis == "admin":
            # Admin-only section and user doesn't have app access
            continue
        elif app_id and allowed_apps and app_id not in allowed_apps:
            # App-gated section user doesn't have access to
            continue

        # Copy section, stripping technical_md for non-admins
        s = dict(section)
        if not is_admin:
            s.pop("technical_md", None)
            # Strip technical_md from subsections too
            if s.get("subsections"):
                s["subsections"] = [
                    {k: v for k, v in sub.items() if k != "technical_md"}
                    for sub in s["subsections"]
                ]

        filtered_sections.append(s)

    # Filter categories — include any category that has at least one visible section
    visible_ids = {s["id"] for s in filtered_sections}
    filtered_categories = []
    for cat in docs.get("categories", []):
        cat = dict(cat)
        cat["sections"] = [sid for sid in cat.get("sections", []) if sid in visible_ids]
        if cat["sections"]:
            filtered_categories.append(cat)

    return {
        "version": docs.get("version", "1.0.0"),
        "generated_at": docs.get("generated_at", ""),
        "categories": filtered_categories,
        "sections": filtered_sections,
    }


@router.get("/docs")
async def get_docs(user: AuthUser = Depends(get_current_user)):
    """Return documentation filtered by user role and permissions."""
    docs = _load_docs()
    return _filter_for_user(docs, user)


@router.post("/docs/regenerate")
async def regenerate_docs(user: AuthUser = Depends(require_admin)):
    """Force regenerate docs.json from wiki sources."""
    try:
        docs = generator.generate()
        return {
            "ok": True,
            "generated_at": docs["generated_at"],
            "section_count": len(docs["sections"]),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")


@router.get("/auth/config")
async def auth_config():
    """Public endpoint: Supabase config for frontend auth."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }
