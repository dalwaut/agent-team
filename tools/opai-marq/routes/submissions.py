"""Marq — Submission lifecycle routes."""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

from core.supabase import _sb_get, _sb_post, _sb_patch
from routes.apps import check_access

log = logging.getLogger("marq.routes.submissions")
router = APIRouter()


class SubmissionCreate(BaseModel):
    store: str
    version: str
    build_number: Optional[str] = None
    notes: Optional[str] = None


class SubmissionUpdate(BaseModel):
    status: Optional[str] = None
    build_number: Optional[str] = None
    rejection_reason: Optional[str] = None
    rejection_details: Optional[dict] = None
    notes: Optional[str] = None


@router.post("/api/apps/{app_id}/submissions")
async def create_submission(app_id: str, body: SubmissionCreate, user: AuthUser = Depends(get_current_user)):
    """Create a new submission for an app."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    # Prevent duplicate: same app + store + version with non-terminal status
    terminal = ("released", "rejected", "cancelled", "suspended", "withdrawn")
    existing = await _sb_get(
        f"mrq_submissions?app_id=eq.{app_id}&store=eq.{body.store}&version=eq.{body.version}&select=id,status"
    )
    active = [s for s in existing if s.get("status") not in terminal]
    if active:
        raise HTTPException(
            409,
            f"Active submission already exists for {body.store} v{body.version} "
            f"(status: {active[0].get('status')}). Complete or cancel it first."
        )

    payload = {
        "app_id": app_id,
        "store": body.store,
        "version": body.version,
        "status": "preparing",
    }
    if body.build_number:
        payload["build_number"] = body.build_number
    if body.notes:
        payload["notes"] = body.notes

    result = await _sb_post("mrq_submissions", payload)
    sub = result[0] if isinstance(result, list) else result

    # Log audit
    await _sb_post("mrq_audit_log", {
        "app_id": app_id,
        "actor_id": user.id,
        "actor_type": "user",
        "action": "submission_created",
        "summary": f"Submission created for {body.store} v{body.version}",
        "details": {"submission_id": sub.get("id"), "store": body.store, "version": body.version},
    })

    return sub


@router.patch("/api/submissions/{submission_id}")
async def update_submission(submission_id: str, body: SubmissionUpdate, user: AuthUser = Depends(get_current_user)):
    """Update a submission status. Triggers rejection-to-task flow on 'rejected'."""
    rows = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=app_id,status")
    if not rows:
        raise HTTPException(404, "Submission not found")
    if not await check_access(user, rows[0]["app_id"]):
        raise HTTPException(403, "Access denied")

    old_status = rows[0].get("status")
    app_id = rows[0]["app_id"]
    payload = body.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(400, "No fields to update")

    # Auto-set timestamps based on status
    if body.status == "submitted":
        payload["submitted_at"] = datetime.now(timezone.utc).isoformat()
    elif body.status in ("approved", "released", "rejected"):
        payload["reviewed_at"] = datetime.now(timezone.utc).isoformat()
    if body.status == "released":
        payload["released_at"] = datetime.now(timezone.utc).isoformat()

    result = await _sb_patch(f"mrq_submissions?id=eq.{submission_id}", payload)
    sub = result[0] if isinstance(result, list) and result else result

    # Create review event for status changes
    if body.status and body.status != old_status:
        await _sb_post("mrq_review_events", {
            "app_id": app_id,
            "submission_id": submission_id,
            "store": sub.get("store", "unknown"),
            "event_type": "status_change",
            "old_status": old_status,
            "new_status": body.status,
            "source": "manual",
            "parsed_summary": f"Status changed: {old_status} → {body.status}",
        })

    # Trigger rejection-to-task flow in background
    if body.status == "rejected" and old_status != "rejected":
        asyncio.create_task(_handle_rejection(app_id, submission_id))

    return sub


async def _handle_rejection(app_id: str, submission_id: str):
    """Background task: translate rejection and create TeamHub tasks."""
    try:
        from core.teamhub import ensure_app_workspace, add_comment
        from core.translator import create_rejection_tasks

        # Get full app and submission data
        apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
        subs = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=*")
        if not apps or not subs:
            log.error("Rejection handler: app or submission not found")
            return

        app = apps[0]
        submission = subs[0]

        # Ensure TeamHub workspace exists
        ws = await ensure_app_workspace(app)
        issues_list_id = ws.get("issues_list_id")
        if not issues_list_id:
            log.error("Rejection handler: no issues list ID for app %s", app_id)
            return

        # Create rejection tasks
        relays = await create_rejection_tasks(app, submission, issues_list_id)
        log.info("Rejection handler created %d tasks for submission %s", len(relays), submission_id)

        # Update submission with teamhub task references
        if relays:
            relay_ids = [r.get("teamhub_item_id") for r in relays if r.get("teamhub_item_id")]
            await _sb_patch(f"mrq_submissions?id=eq.{submission_id}", {
                "rejection_details": {
                    **(submission.get("rejection_details") or {}),
                    "teamhub_task_ids": relay_ids,
                    "tasks_created": len(relays),
                },
            })

    except Exception:
        log.exception("Rejection handler failed for submission %s", submission_id)


@router.get("/api/submissions/{submission_id}")
async def get_submission(submission_id: str, user: AuthUser = Depends(get_current_user)):
    """Get submission with pre-check results and task relays."""
    rows = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=*")
    if not rows:
        raise HTTPException(404, "Submission not found")

    sub = rows[0]
    if not await check_access(user, sub["app_id"]):
        raise HTTPException(403, "Access denied")

    # Attach pre-check results
    checks = await _sb_get(
        f"mrq_pre_checks?submission_id=eq.{submission_id}&order=category,check_id&select=*"
    )
    sub["pre_checks"] = checks

    # Attach review events
    events = await _sb_get(
        f"mrq_review_events?submission_id=eq.{submission_id}&order=created_at.desc&select=*"
    )
    sub["review_events"] = events

    # Attach task relays
    relays = await _sb_get(
        f"mrq_tasks_relay?submission_id=eq.{submission_id}&select=*"
    )
    sub["task_relays"] = relays

    return sub


@router.post("/api/submissions/{submission_id}/check-resubmit")
async def check_resubmission_readiness(submission_id: str, user: AuthUser = Depends(get_current_user)):
    """Check if a rejected submission is ready to resubmit.

    Checks all linked tasks are complete, then re-runs failed pre-checks.
    """
    rows = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=*")
    if not rows:
        raise HTTPException(404, "Submission not found")

    sub = rows[0]
    if not await check_access(user, sub["app_id"]):
        raise HTTPException(403, "Access denied")

    if sub.get("status") != "rejected":
        return {"ready": False, "reason": f"Submission is '{sub.get('status')}', not 'rejected'"}

    # Check task relays — all must be completed
    relays = await _sb_get(
        f"mrq_tasks_relay?submission_id=eq.{submission_id}&select=*"
    )

    open_tasks = [r for r in relays if r.get("status") not in ("completed", "closed")]
    if open_tasks:
        return {
            "ready": False,
            "reason": f"{len(open_tasks)} task(s) still open",
            "open_tasks": [r.get("teamhub_item_id") for r in open_tasks],
        }

    # All tasks complete — re-run checks
    from core.checker import run_all_checks, calculate_score, has_blockers

    apps = await _sb_get(f"mrq_apps?id=eq.{sub['app_id']}&select=*")
    metadata_rows = await _sb_get(
        f"mrq_metadata?app_id=eq.{sub['app_id']}&order=created_at.desc&limit=1&select=*"
    )
    screenshots = await _sb_get(f"mrq_screenshots?app_id=eq.{sub['app_id']}&select=*")

    app = apps[0] if apps else {}
    metadata = metadata_rows[0] if metadata_rows else {}

    results = await run_all_checks(app, metadata, sub, screenshots)
    score = calculate_score(results)
    blocked = has_blockers(results)

    # Update submission
    new_status = "ready" if not blocked else "pre_check_failed"
    await _sb_patch(f"mrq_submissions?id=eq.{submission_id}", {
        "pre_check_results": {"checks": results, "score": score, "has_blockers": blocked},
        "pre_check_score": score,
        "status": new_status,
    })

    return {
        "ready": not blocked,
        "score": score,
        "status": new_status,
        "passed": sum(1 for r in results if r.get("status") == "passed"),
        "failed": sum(1 for r in results if r.get("status") == "failed"),
    }


# ══════════════════════════════════════════════════════════════
# Store Workflow — Phase 4
# ══════════════════════════════════════════════════════════════

async def _get_connector(app_id: str, store: str):
    """Load connector for an app + store. Returns (connector, error_msg)."""
    from core.vault import load_credential

    creds = await _sb_get(
        f"mrq_store_credentials?app_id=eq.{app_id}&store=eq.{store}&is_active=eq.true&select=*&limit=1"
    )
    if not creds:
        return None, f"No active {store} credentials configured for this app"

    cred = creds[0]
    try:
        secret_data = load_credential(cred["vault_key"])
    except Exception as e:
        return None, f"Failed to load credentials: {e}"

    if store == "google":
        from connectors.google import GooglePlayConnector
        return GooglePlayConnector(secret_data), None
    elif store == "apple":
        from connectors.apple import AppleConnector
        return AppleConnector(
            issuer_id=cred.get("issuer_id", ""),
            key_id=cred.get("key_id", ""),
            private_key=secret_data.get("private_key", ""),
        ), None
    return None, f"Unknown store: {store}"


@router.post("/api/submissions/{submission_id}/push-metadata")
async def push_metadata_to_store(submission_id: str, user: AuthUser = Depends(get_current_user)):
    """Push metadata from Marq to the store (Google Play or Apple).

    Finds the latest metadata entry for this app/store/version and pushes it.
    """
    rows = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=*")
    if not rows:
        raise HTTPException(404, "Submission not found")
    sub = rows[0]
    if not await check_access(user, sub["app_id"]):
        raise HTTPException(403, "Access denied")

    store = sub["store"]
    app_id = sub["app_id"]
    version = sub.get("version", "1.0.0")

    # Get connector
    connector, error = await _get_connector(app_id, store)
    if not connector:
        raise HTTPException(400, error)

    # Get latest metadata for this store
    meta_rows = await _sb_get(
        f"mrq_metadata?app_id=eq.{app_id}&store=eq.{store}&order=created_at.desc&limit=1&select=*"
    )
    if not meta_rows:
        raise HTTPException(400, "No metadata found for this store. Create metadata first.")
    metadata = meta_rows[0]

    # Get app info
    apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
    app = apps[0] if apps else {}

    locale = metadata.get("locale", "en-US")

    if store == "google":
        package = app.get("package_name_android")
        if not package:
            raise HTTPException(400, "No Android package name configured")

        result = await connector.push_metadata(
            package,
            metadata={
                "app_name": metadata.get("app_name"),
                "short_description": metadata.get("short_description"),
                "full_description": metadata.get("full_description"),
            },
            language=locale,
        )

    elif store == "apple":
        # For Apple, we need the App Store Connect app ID from config
        creds = await _sb_get(
            f"mrq_store_credentials?app_id=eq.{app_id}&store=eq.apple&select=*&limit=1"
        )
        apple_app_id = creds[0].get("issuer_id") if creds else None  # Stored in config
        if not apple_app_id:
            raise HTTPException(400, "No Apple App Store Connect app ID configured")

        result = await connector.update_metadata(
            apple_app_id,
            version_string=version,
            metadata={
                "app_name": metadata.get("app_name"),
                "subtitle": metadata.get("subtitle"),
                "full_description": metadata.get("full_description"),
                "keywords": metadata.get("keywords"),
                "whats_new": metadata.get("whats_new"),
            },
            locale=locale,
        )
    else:
        raise HTTPException(400, f"Unknown store: {store}")

    # Audit log
    await _sb_post("mrq_audit_log", {
        "app_id": app_id,
        "actor_id": user.id,
        "actor_type": "user",
        "action": "metadata_pushed",
        "summary": f"Metadata pushed to {store} for v{version}",
        "details": {"submission_id": submission_id, "store": store, "result": result},
    })

    has_error = result.get("error")
    return {
        "ok": not has_error,
        "result": result,
        "error": has_error,
    }


@router.post("/api/submissions/{submission_id}/submit-to-store")
async def submit_to_store(submission_id: str, user: AuthUser = Depends(get_current_user)):
    """Submit a version for store review.

    For Google: Commits the current edit (assumes metadata/binary already pushed).
    For Apple: Calls submit_for_review on the version.
    """
    rows = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=*")
    if not rows:
        raise HTTPException(404, "Submission not found")
    sub = rows[0]
    if not await check_access(user, sub["app_id"]):
        raise HTTPException(403, "Access denied")

    store = sub["store"]
    app_id = sub["app_id"]

    connector, error = await _get_connector(app_id, store)
    if not connector:
        raise HTTPException(400, error)

    apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
    app = apps[0] if apps else {}

    result = {}
    if store == "google":
        package = app.get("package_name_android")
        if not package:
            raise HTTPException(400, "No Android package name configured")

        # Check first upload
        needs_first = await connector.check_first_upload(package)
        if needs_first:
            return {
                "ok": False,
                "error": "First binary upload must be done manually via Google Play Console. Upload your first AAB/APK there, then use Marq for subsequent releases.",
                "first_upload_required": True,
            }

        # For Google, submission happens via track update in the edit
        # The user should have already pushed metadata; we just mark the status
        result = {"submitted": True, "store": "google"}

    elif store == "apple":
        # Need version_id — look it up from Apple
        creds = await _sb_get(
            f"mrq_store_credentials?app_id=eq.{app_id}&store=eq.apple&select=*&limit=1"
        )
        job_config = creds[0] if creds else {}
        apple_app_id = job_config.get("key_id")  # We store apple app ID in key_id field

        if not apple_app_id:
            raise HTTPException(400, "No Apple app ID configured")

        versions = await connector.list_versions(apple_app_id)
        target_version = sub.get("version", "1.0.0")
        version_id = None
        for v in versions:
            if v.get("versionString") == target_version:
                version_id = v["id"]
                break

        if not version_id:
            raise HTTPException(400, f"Version {target_version} not found in App Store Connect")

        result = await connector.submit_for_review(version_id)

    # Update submission status
    await _sb_patch(f"mrq_submissions?id=eq.{submission_id}", {
        "status": "submitted",
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    })

    # Create event
    await _sb_post("mrq_review_events", {
        "app_id": app_id,
        "submission_id": submission_id,
        "store": store,
        "event_type": "submitted",
        "old_status": sub.get("status"),
        "new_status": "submitted",
        "source": "manual",
        "parsed_summary": f"Submitted to {store} for review",
    })

    await _sb_post("mrq_audit_log", {
        "app_id": app_id,
        "actor_id": user.id,
        "actor_type": "user",
        "action": "submitted_to_store",
        "summary": f"Submitted to {store} for review (v{sub.get('version', '?')})",
        "details": {"submission_id": submission_id, "result": result},
    })

    return {"ok": True, "result": result}


@router.get("/api/apps/{app_id}/store-status")
async def get_store_status(app_id: str, store: str = "google", user: AuthUser = Depends(get_current_user)):
    """Get live store status for an app (requires credentials)."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    connector, error = await _get_connector(app_id, store)
    if not connector:
        return {"configured": False, "error": error}

    apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
    app = apps[0] if apps else {}

    try:
        if store == "google":
            package = app.get("package_name_android")
            if not package:
                return {"configured": True, "error": "No Android package name"}
            status = await connector.get_track_status(package)
            return {"configured": True, "status": status, "error": None}

        elif store == "apple":
            creds = await _sb_get(
                f"mrq_store_credentials?app_id=eq.{app_id}&store=eq.apple&select=*&limit=1"
            )
            apple_app_id = creds[0].get("key_id") if creds else None
            if not apple_app_id:
                return {"configured": True, "error": "No Apple app ID"}
            versions = await connector.list_versions(apple_app_id)
            return {"configured": True, "versions": versions, "error": None}

    except Exception as e:
        return {"configured": True, "error": str(e)}
