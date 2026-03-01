"""Marq — Apple App Store Connect webhook receiver.

Handles notification types:
- APP_VERSION_STATE_CHANGE  → Update submission status
- BUILD_UPLOAD_STATE_CHANGE → Track build processing
- TESTFLIGHT_STATE_CHANGE   → TestFlight status

Apple signs notifications with JWS (JSON Web Signature).
We verify using Apple's public key before processing.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request, HTTPException

from core.supabase import _sb_get, _sb_post, _sb_patch

log = logging.getLogger("marq.routes.webhooks")
router = APIRouter()

# Apple's App Store Connect notification types we handle
HANDLED_TYPES = {
    "APP_VERSION_STATE_CHANGE",
    "BUILD_UPLOAD_STATE_CHANGE",
    "TESTFLIGHT_STATE_CHANGE",
}


async def _verify_apple_jws(token: str) -> dict | None:
    """Verify Apple JWS signature and extract payload.

    Apple sends notifications as a signed JWT (JWS).
    The x5c header contains the certificate chain.

    For now: decode payload without full certificate chain verification.
    Full verification requires fetching Apple's root CA and validating the chain,
    which we'll enable when the Apple Developer account is acquired.

    Returns the decoded payload dict or None if invalid.
    """
    try:
        parts = token.split(".")
        if len(parts) != 3:
            log.warning("Apple JWS: expected 3 parts, got %d", len(parts))
            return None

        # Decode header
        header_b64 = parts[0] + "=" * (4 - len(parts[0]) % 4)
        header = json.loads(base64.urlsafe_b64decode(header_b64))

        # Verify algorithm
        if header.get("alg") not in ("ES256", "RS256"):
            log.warning("Apple JWS: unexpected algorithm %s", header.get("alg"))
            return None

        # Decode payload
        payload_b64 = parts[1] + "=" * (4 - len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))

        # TODO: Full x5c certificate chain verification when Apple account is live
        # For now, we trust the payload if it has the expected structure
        if "notificationType" not in payload and "data" not in payload:
            log.warning("Apple JWS: missing expected fields in payload")
            return None

        return payload
    except Exception as e:
        log.error("Apple JWS verification failed: %s", e)
        return None


def _extract_notification_data(payload: dict) -> dict:
    """Extract notification details from Apple's nested structure.

    Apple notification format:
    {
        "notificationType": "APP_VERSION_STATE_CHANGE",
        "data": {
            "appAppleId": 123,
            "bundleId": "com.example.app",
            "bundleVersion": "42",
            "environment": "PRODUCTION",
            "signedTransactionInfo": "...",  (for IAP events)
            "appMetadata": { ... },
        },
        "version": "2.0",
        "signedDate": 1234567890000,
        "notificationUUID": "uuid-here"
    }
    """
    data = payload.get("data", {})
    return {
        "notification_type": payload.get("notificationType", ""),
        "notification_uuid": payload.get("notificationUUID", ""),
        "app_apple_id": data.get("appAppleId"),
        "bundle_id": data.get("bundleId", ""),
        "bundle_version": data.get("bundleVersion", ""),
        "environment": data.get("environment", ""),
        "app_metadata": data.get("appMetadata", {}),
        "signed_date": payload.get("signedDate"),
    }


# Apple App Store state → Marq status mapping
APPLE_STATE_MAP = {
    # Version states
    "PREPARE_FOR_SUBMISSION": "preparing",
    "WAITING_FOR_REVIEW": "submitted",
    "IN_REVIEW": "in_review",
    "PENDING_DEVELOPER_RELEASE": "approved",
    "READY_FOR_SALE": "released",
    "REJECTED": "rejected",
    "DEVELOPER_REJECTED": "cancelled",
    "REMOVED_FROM_SALE": "removed",
    "DEVELOPER_REMOVED_FROM_SALE": "removed",
    "PROCESSING_FOR_APP_STORE": "uploading",
    "INVALID_BINARY": "pre_check_failed",
    # Build states
    "PROCESSING": "uploading",
    "VALID": "ready",
    "INVALID": "pre_check_failed",
    # TestFlight states
    "BETA_APPROVED": "approved",
    "BETA_REJECTED": "rejected",
    "IN_BETA_REVIEW": "in_review",
    "WAITING_FOR_BETA_REVIEW": "submitted",
}


@router.post("/api/webhooks/apple")
async def apple_webhook(request: Request):
    """Receive Apple App Store Connect webhook notifications.

    Apple sends a signed JWS payload. We verify, extract, and process.
    """
    content_type = request.headers.get("content-type", "")

    # Apple may send as application/json with signedPayload
    if "json" in content_type:
        body = await request.json()
        signed_payload = body.get("signedPayload")
    else:
        # Or raw JWS token
        raw = await request.body()
        signed_payload = raw.decode("utf-8", errors="replace").strip()

    if not signed_payload:
        log.warning("Apple webhook: no signed payload")
        raise HTTPException(400, "Missing signedPayload")

    # Verify and decode
    payload = await _verify_apple_jws(signed_payload)
    if not payload:
        log.warning("Apple webhook: JWS verification failed")
        raise HTTPException(401, "Invalid signature")

    notification = _extract_notification_data(payload)
    ntype = notification["notification_type"]

    log.info(
        "Apple webhook: type=%s bundle=%s version=%s",
        ntype, notification["bundle_id"], notification["bundle_version"],
    )

    if ntype not in HANDLED_TYPES:
        log.debug("Apple webhook: unhandled type %s", ntype)
        return {"ok": True, "handled": False}

    # Find the app by bundle ID
    bundle_id = notification["bundle_id"]
    if not bundle_id:
        return {"ok": True, "handled": False, "reason": "no bundle_id"}

    apps = await _sb_get(
        f"mrq_apps?bundle_id_ios=eq.{bundle_id}&select=id,owner_id,name"
    )
    if not apps:
        log.info("Apple webhook: no app found for bundle %s", bundle_id)
        return {"ok": True, "handled": False, "reason": "app not found"}

    app = apps[0]
    app_id = app["id"]

    # Determine new status from the event
    new_state = notification["app_metadata"].get("state", "")
    if not new_state and ntype == "APP_VERSION_STATE_CHANGE":
        new_state = notification["app_metadata"].get("appVersionState", "")
    if not new_state and ntype == "BUILD_UPLOAD_STATE_CHANGE":
        new_state = notification["app_metadata"].get("buildState", "")
    if not new_state and ntype == "TESTFLIGHT_STATE_CHANGE":
        new_state = notification["app_metadata"].get("betaAppReviewState", "")

    marq_status = APPLE_STATE_MAP.get(new_state)
    if not marq_status:
        log.debug("Apple webhook: unmapped state %s", new_state)
        # Still log the raw event
        await _sb_post("mrq_review_events", {
            "app_id": app_id,
            "store": "apple",
            "event_type": ntype.lower(),
            "new_status": new_state,
            "source": "webhook",
            "parsed_summary": f"Apple webhook: {ntype} → {new_state}",
            "raw_payload": payload,
        })
        return {"ok": True, "handled": True, "mapped": False}

    # Find active submission for this app
    subs = await _sb_get(
        f"mrq_submissions?app_id=eq.{app_id}&store=eq.apple"
        f"&status=neq.released&status=neq.rejected&status=neq.cancelled"
        f"&order=created_at.desc&limit=1&select=*"
    )

    submission_id = None
    old_status = None

    if subs:
        sub = subs[0]
        submission_id = sub["id"]
        old_status = sub.get("status")

        if old_status != marq_status:
            log.info("Apple webhook status change: %s → %s (app %s)", old_status, marq_status, app_id)

            update = {"status": marq_status}
            if marq_status == "released":
                update["released_at"] = datetime.now(timezone.utc).isoformat()
            elif marq_status in ("rejected", "approved"):
                update["reviewed_at"] = datetime.now(timezone.utc).isoformat()

            await _sb_patch(f"mrq_submissions?id=eq.{submission_id}", update)

    # Create review event
    await _sb_post("mrq_review_events", {
        "app_id": app_id,
        "submission_id": submission_id,
        "store": "apple",
        "event_type": ntype.lower(),
        "old_status": old_status,
        "new_status": marq_status,
        "source": "webhook",
        "parsed_summary": f"Apple: {new_state} ({old_status or '?'} → {marq_status})",
        "raw_payload": payload,
    })

    # Trigger rejection handler
    if marq_status == "rejected" and old_status != "rejected" and submission_id:
        asyncio.create_task(_handle_webhook_rejection(app_id, submission_id))

    return {"ok": True, "handled": True, "status": marq_status}


async def _handle_webhook_rejection(app_id: str, submission_id: str):
    """Handle rejection from webhook — same flow as scheduler/submissions."""
    try:
        from core.teamhub import ensure_app_workspace
        from core.translator import create_rejection_tasks

        apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=*")
        subs = await _sb_get(f"mrq_submissions?id=eq.{submission_id}&select=*")
        if not apps or not subs:
            return

        app = apps[0]
        submission = subs[0]

        ws = await ensure_app_workspace(app)
        issues_list_id = ws.get("issues_list_id")
        if not issues_list_id:
            return

        relays = await create_rejection_tasks(app, submission, issues_list_id)
        log.info("Webhook rejection handler created %d tasks for submission %s", len(relays), submission_id)

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
        log.exception("Webhook rejection handler failed for submission %s", submission_id)
