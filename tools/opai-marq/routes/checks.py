"""Marq — Pre-check results routes + auto-fix engine."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

from core.supabase import _sb_get, _sb_post, _sb_patch
from core.checker import run_all_checks, calculate_score, has_blockers
from routes.apps import check_access

log = logging.getLogger("marq.routes.checks")
router = APIRouter()


@router.post("/api/apps/{app_id}/run-checks")
async def run_checks(app_id: str, submission_id: str = None, user: AuthUser = Depends(get_current_user)):
    """Run all pre-submission checks for an app. Optionally link to a submission."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    # Get app data
    apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
    if not apps:
        raise HTTPException(404, "App not found")
    app = apps[0]

    # Get latest metadata
    metadata_rows = await _sb_get(
        f"mrq_metadata?app_id=eq.{app_id}&order=created_at.desc&limit=1&select=*"
    )
    metadata = metadata_rows[0] if metadata_rows else {}

    # Get screenshots
    screenshots = await _sb_get(f"mrq_screenshots?app_id=eq.{app_id}&select=*")

    # Get or create submission
    sub = None
    if submission_id:
        subs = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=*")
        sub = subs[0] if subs else None

    # Run checks
    results = await run_all_checks(app, metadata, sub or {}, screenshots)
    score = calculate_score(results)
    blocked = has_blockers(results)

    # Store results if linked to a submission
    if sub:
        for r in results:
            await _sb_post("mrq_pre_checks", {
                "submission_id": submission_id,
                "app_id": app_id,
                "check_id": r["check_id"],
                "category": r["category"],
                "severity": r["severity"],
                "status": r.get("status", "skipped"),
                "recommendation": r.get("recommendation"),
                "doc_url": r.get("doc_url"),
                "auto_fixable": r.get("auto_fixable", False),
                "details": r.get("details", {}),
            })

        # Update submission with results
        await _sb_patch(f"mrq_submissions?id=eq.{submission_id}", {
            "pre_check_results": {"checks": results, "score": score, "has_blockers": blocked},
            "pre_check_score": score,
            "status": "pre_check_failed" if blocked else "ready",
        })

    return {
        "score": score,
        "has_blockers": blocked,
        "total": len(results),
        "passed": sum(1 for r in results if r.get("status") == "passed"),
        "failed": sum(1 for r in results if r.get("status") == "failed"),
        "skipped": sum(1 for r in results if r.get("status") == "skipped"),
        "results": results,
    }


@router.get("/api/submissions/{submission_id}/checks")
async def get_checks(submission_id: str, user: AuthUser = Depends(get_current_user)):
    """Get pre-check results for a submission."""
    subs = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=app_id")
    if not subs:
        raise HTTPException(404, "Submission not found")
    if not await check_access(user, subs[0]["app_id"]):
        raise HTTPException(403, "Access denied")

    return await _sb_get(
        f"mrq_pre_checks?submission_id=eq.{submission_id}&order=category,check_id&select=*"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Auto-Fix Engine
# ═══════════════════════════════════════════════════════════════════════════════

async def _get_app_and_metadata(app_id: str):
    """Helper to load app + latest metadata."""
    apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
    if not apps:
        raise HTTPException(404, "App not found")
    app = apps[0]

    metadata_rows = await _sb_get(
        f"mrq_metadata?app_id=eq.{app_id}&order=created_at.desc&limit=1&select=*"
    )
    metadata = metadata_rows[0] if metadata_rows else None
    return app, metadata


async def _fix_export_compliance(app_id: str, app: dict, metadata: dict | None):
    """Auto-set export_compliance_declared = true (most apps only use HTTPS)."""
    if not metadata:
        return {"fixed": False, "message": "No metadata entry exists. Create metadata first."}

    content_rating = metadata.get("content_rating_data") or {}
    content_rating["export_compliance_declared"] = True

    await _sb_patch(f"mrq_metadata?id=eq.{metadata['id']}", {
        "content_rating_data": content_rating,
    })
    return {"fixed": True, "message": "Set export_compliance_declared = true (HTTPS exemption)"}


async def _fix_keywords(app_id: str, app: dict, metadata: dict | None):
    """Generate keywords using AI from app docs."""
    if not metadata:
        return {"fixed": False, "message": "No metadata entry exists. Create metadata first."}

    from core.metadata_builder import generate_metadata
    draft = await generate_metadata(app, store=metadata.get("store", "apple"), locale=metadata.get("locale", "en-US"))

    if draft.get("_error"):
        return {"fixed": False, "message": "AI generation failed: " + draft["_error"]}

    keywords = draft.get("keywords", "")
    if not keywords:
        return {"fixed": False, "message": "AI could not generate keywords"}

    await _sb_patch(f"mrq_metadata?id=eq.{metadata['id']}", {"keywords": keywords})
    return {"fixed": True, "message": "Generated keywords: " + keywords[:60] + ("..." if len(keywords) > 60 else "")}


async def _fix_description(app_id: str, app: dict, metadata: dict | None):
    """Generate or improve description using AI."""
    if not metadata:
        return {"fixed": False, "message": "No metadata entry exists. Create metadata first."}

    from core.metadata_builder import generate_metadata
    draft = await generate_metadata(app, store=metadata.get("store", "apple"), locale=metadata.get("locale", "en-US"))

    if draft.get("_error"):
        return {"fixed": False, "message": "AI generation failed: " + draft["_error"]}

    updates = {}
    if draft.get("full_description") and not (metadata.get("full_description") or "").strip():
        updates["full_description"] = draft["full_description"]
    elif draft.get("full_description"):
        updates["full_description"] = draft["full_description"]

    if draft.get("short_description") and not (metadata.get("short_description") or "").strip():
        updates["short_description"] = draft["short_description"]

    if not updates:
        return {"fixed": False, "message": "Description already present and AI could not improve it"}

    await _sb_patch(f"mrq_metadata?id=eq.{metadata['id']}", updates)
    return {"fixed": True, "message": "Updated description from AI (" + str(len(updates.get("full_description", ""))) + " chars)"}


async def _fix_release_notes(app_id: str, app: dict, metadata: dict | None):
    """Generate release notes using AI."""
    if not metadata:
        return {"fixed": False, "message": "No metadata entry exists. Create metadata first."}

    from core.metadata_builder import generate_metadata
    draft = await generate_metadata(app, store=metadata.get("store", "apple"), locale=metadata.get("locale", "en-US"))

    if draft.get("_error"):
        return {"fixed": False, "message": "AI generation failed: " + draft["_error"]}

    whats_new = draft.get("whats_new", "")
    if not whats_new:
        return {"fixed": False, "message": "AI could not generate release notes"}

    await _sb_patch(f"mrq_metadata?id=eq.{metadata['id']}", {"whats_new": whats_new})
    return {"fixed": True, "message": "Generated release notes: " + whats_new[:60] + ("..." if len(whats_new) > 60 else "")}


async def _fix_app_name(app_id: str, app: dict, metadata: dict | None):
    """Generate an optimized app name using AI."""
    if not metadata:
        return {"fixed": False, "message": "No metadata entry exists. Create metadata first."}

    from core.metadata_builder import generate_metadata
    draft = await generate_metadata(app, store=metadata.get("store", "apple"), locale=metadata.get("locale", "en-US"))

    if draft.get("_error"):
        return {"fixed": False, "message": "AI generation failed: " + draft["_error"]}

    app_name = draft.get("app_name", "")
    if not app_name:
        return {"fixed": False, "message": "AI could not generate app name"}

    updates = {"app_name": app_name}
    if draft.get("subtitle"):
        updates["subtitle"] = draft["subtitle"]

    await _sb_patch(f"mrq_metadata?id=eq.{metadata['id']}", updates)
    return {"fixed": True, "message": "Set app name to: " + app_name}


async def _fix_localization(app_id: str, app: dict, metadata: dict | None):
    """Fill in missing recommended fields for the current locale."""
    if not metadata:
        return {"fixed": False, "message": "No metadata entry exists. Create metadata first."}

    from core.metadata_builder import generate_metadata
    draft = await generate_metadata(app, store=metadata.get("store", "apple"), locale=metadata.get("locale", "en-US"))

    if draft.get("_error"):
        return {"fixed": False, "message": "AI generation failed: " + draft["_error"]}

    updates = {}
    for field in ["app_name", "full_description", "short_description", "keywords", "whats_new"]:
        if not (metadata.get(field) or "").strip() and draft.get(field):
            updates[field] = draft[field]

    if not updates:
        return {"fixed": False, "message": "All required fields already filled"}

    await _sb_patch(f"mrq_metadata?id=eq.{metadata['id']}", updates)
    return {"fixed": True, "message": "Filled " + str(len(updates)) + " missing field(s): " + ", ".join(updates.keys())}


# Fix dispatcher
AUTO_FIX_HANDLERS = {
    "export_compliance": _fix_export_compliance,
    "keywords_optimization": _fix_keywords,
    "description_quality": _fix_description,
    "release_notes_present": _fix_release_notes,
    "app_name_length": _fix_app_name,
    "localization_completeness": _fix_localization,
}


@router.post("/api/apps/{app_id}/auto-fix/{check_id}")
async def auto_fix_check(app_id: str, check_id: str, user: AuthUser = Depends(get_current_user)):
    """Attempt to auto-fix a single failed check."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    handler = AUTO_FIX_HANDLERS.get(check_id)
    if not handler:
        return {"fixed": False, "message": "No auto-fix available for this check. Use the action button to fix manually."}

    app, metadata = await _get_app_and_metadata(app_id)

    try:
        result = await handler(app_id, app, metadata)
        log.info("Auto-fix %s for app %s: %s", check_id, app_id, result.get("message", ""))
        return result
    except Exception as e:
        log.exception("Auto-fix %s failed for app %s", check_id, app_id)
        return {"fixed": False, "message": f"Auto-fix error: {e}"}


@router.post("/api/apps/{app_id}/auto-fix-all")
async def auto_fix_all(app_id: str, user: AuthUser = Depends(get_current_user)):
    """Attempt to auto-fix all fixable failed checks."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    app, metadata = await _get_app_and_metadata(app_id)

    # Run checks first to see which ones are failing
    metadata_rows = await _sb_get(
        f"mrq_metadata?app_id=eq.{app_id}&order=created_at.desc&limit=1&select=*"
    )
    meta_for_check = metadata_rows[0] if metadata_rows else {}
    screenshots = await _sb_get(f"mrq_screenshots?app_id=eq.{app_id}&select=*")
    results = await run_all_checks(app, meta_for_check, {}, screenshots)

    failed_checks = [r["check_id"] for r in results if r.get("status") == "failed"]

    fix_results = []
    for check_id in failed_checks:
        handler = AUTO_FIX_HANDLERS.get(check_id)
        if not handler:
            continue

        try:
            # Re-fetch metadata after each fix (since previous fixes may have updated it)
            app, metadata = await _get_app_and_metadata(app_id)
            result = await handler(app_id, app, metadata)
            result["check_id"] = check_id
            fix_results.append(result)
            log.info("Auto-fix-all %s for app %s: %s", check_id, app_id, result.get("message", ""))
        except Exception as e:
            log.exception("Auto-fix-all %s failed for app %s", check_id, app_id)
            fix_results.append({"check_id": check_id, "fixed": False, "message": str(e)})

    return {"results": fix_results}
