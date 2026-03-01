"""Marq — Review monitoring, AI response drafting, and response management.

Review flow:
1. Scheduler fetches reviews from stores → stored in mrq_review_responses (status: pending)
2. User requests AI draft → Claude generates response → status: draft_ready
3. User reviews draft, edits if needed → approves → status: approved
4. Approved response sent to store via connector API → status: sent
5. Skipped reviews marked as 'skipped'

Rate limits:
- Google: 350 chars, ~2000 replies/day
- Apple: 5970 chars
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

from core.supabase import _sb_get, _sb_patch, _sb_post
from routes.apps import check_access

log = logging.getLogger("marq.routes.reviews")
router = APIRouter()


class ResponseApproval(BaseModel):
    status: str  # approved / skipped
    response_text: Optional[str] = None


class DraftRequest(BaseModel):
    tone: Optional[str] = "professional"  # professional / friendly / empathetic


# ══════════════════════════════════════════════════════════════
# List & Stats
# ══════════════════════════════════════════════════════════════

@router.get("/api/apps/{app_id}/reviews")
async def list_reviews(
    app_id: str,
    store: Optional[str] = None,
    status: Optional[str] = None,
    min_rating: Optional[int] = None,
    max_rating: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
    user: AuthUser = Depends(get_current_user),
):
    """List reviews with optional filters."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    query = f"mrq_review_responses?app_id=eq.{app_id}"
    if store:
        query += f"&store=eq.{store}"
    if status:
        query += f"&status=eq.{status}"
    if min_rating is not None:
        query += f"&rating=gte.{min_rating}"
    if max_rating is not None:
        query += f"&rating=lte.{max_rating}"
    query += f"&order=created_at.desc&limit={limit}&offset={offset}&select=*"

    return await _sb_get(query)


@router.get("/api/apps/{app_id}/review-stats")
async def review_stats(app_id: str, user: AuthUser = Depends(get_current_user)):
    """Get review statistics: counts by rating, store, status."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    reviews = await _sb_get(
        f"mrq_review_responses?app_id=eq.{app_id}&select=rating,store,status"
    )

    # Star distribution
    stars = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    by_store = {}
    by_status = {}

    for r in reviews:
        rating = r.get("rating", 0)
        if 1 <= rating <= 5:
            stars[rating] += 1
        store = r.get("store", "unknown")
        by_store[store] = by_store.get(store, 0) + 1
        st = r.get("status", "unknown")
        by_status[st] = by_status.get(st, 0) + 1

    total = len(reviews)
    avg = sum(r.get("rating", 0) for r in reviews) / total if total > 0 else 0

    return {
        "total": total,
        "average_rating": round(avg, 1),
        "star_distribution": stars,
        "by_store": by_store,
        "by_status": by_status,
    }


@router.get("/api/apps/{app_id}/review-events")
async def list_review_events(app_id: str, limit: int = 50, user: AuthUser = Depends(get_current_user)):
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")
    return await _sb_get(
        f"mrq_review_events?app_id=eq.{app_id}&order=created_at.desc&limit={limit}&select=*"
    )


# ══════════════════════════════════════════════════════════════
# AI Draft Generation
# ══════════════════════════════════════════════════════════════

@router.post("/api/reviews/{response_id}/generate-draft")
async def generate_draft(response_id: str, body: DraftRequest = DraftRequest(), user: AuthUser = Depends(get_current_user)):
    """Generate an AI draft response for a review."""
    rows = await _sb_get(f"mrq_review_responses?id=eq.{response_id}&select=*")
    if not rows:
        raise HTTPException(404, "Review not found")

    review = rows[0]
    if not await check_access(user, review["app_id"]):
        raise HTTPException(403, "Access denied")

    # Get app context
    apps = await _sb_get(f"mrq_apps?id=eq.{review['app_id']}&select=name,platform")
    app_name = apps[0]["name"] if apps else "the app"

    store = review.get("store", "google")
    char_limit = 350 if store == "google" else 5970

    draft = await _draft_review_response(
        app_name=app_name,
        store=store,
        rating=review.get("rating", 0),
        review_text=review.get("review_text", ""),
        tone=body.tone,
        char_limit=char_limit,
    )

    # Update the review record
    await _sb_patch(f"mrq_review_responses?id=eq.{response_id}", {
        "response_draft": draft,
        "status": "draft_ready",
    })

    return {"draft": draft, "char_limit": char_limit, "length": len(draft)}


@router.post("/api/apps/{app_id}/reviews/batch-draft")
async def batch_draft(app_id: str, body: DraftRequest = DraftRequest(), user: AuthUser = Depends(get_current_user)):
    """Generate AI drafts for all pending reviews of an app."""
    if not await check_access(user, app_id):
        raise HTTPException(403, "Access denied")

    pending = await _sb_get(
        f"mrq_review_responses?app_id=eq.{app_id}&status=eq.pending&select=*&limit=20"
    )

    if not pending:
        return {"drafted": 0, "message": "No pending reviews"}

    apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=name,platform")
    app_name = apps[0]["name"] if apps else "the app"

    drafted = 0
    for review in pending:
        try:
            store = review.get("store", "google")
            char_limit = 350 if store == "google" else 5970

            draft = await _draft_review_response(
                app_name=app_name,
                store=store,
                rating=review.get("rating", 0),
                review_text=review.get("review_text", ""),
                tone=body.tone,
                char_limit=char_limit,
            )

            await _sb_patch(f"mrq_review_responses?id=eq.{review['id']}", {
                "response_draft": draft,
                "status": "draft_ready",
            })
            drafted += 1
        except Exception as e:
            log.warning("Failed to draft response for review %s: %s", review["id"], e)

    return {"drafted": drafted, "total_pending": len(pending)}


async def _draft_review_response(
    app_name: str,
    store: str,
    rating: int,
    review_text: str,
    tone: str = "professional",
    char_limit: int = 350,
) -> str:
    """Use Claude to draft a review response."""
    from core.claude_cli import call_claude

    prompt = f"""Draft a {tone} response to this {store} app store review for "{app_name}".

Review rating: {rating}/5 stars
Review text: "{review_text}"

Requirements:
- Maximum {char_limit} characters (STRICT limit — response will be truncated if over)
- Be {tone} in tone
- If the review is positive (4-5 stars): thank them, mention a specific point they raised
- If the review is negative (1-2 stars): empathize, acknowledge the issue, mention you're working on improvements
- If mixed (3 stars): thank them, address their concern, highlight positive aspects
- Never be defensive or dismissive
- Never make promises about specific features or timelines
- Never ask them to email support unless there's a specific technical issue
- Keep it concise and genuine
- Do NOT include any prefix like "Response:" or quotes — just the response text

Respond with ONLY the response text, nothing else."""

    try:
        draft = await call_claude(prompt, model="claude-haiku-4-5-20251001", timeout=30)
        # Ensure within char limit
        if len(draft) > char_limit:
            draft = draft[:char_limit - 3] + "..."
        return draft
    except Exception as e:
        log.error("AI draft failed: %s", e)
        # Fallback generic response
        if rating >= 4:
            return f"Thank you for your kind review! We're glad you're enjoying {app_name}."
        elif rating <= 2:
            return f"Thank you for your feedback. We take all reviews seriously and are working to improve {app_name}."
        else:
            return f"Thank you for your review of {app_name}. We appreciate your feedback and are always working to improve."


# ══════════════════════════════════════════════════════════════
# Approval & Sending
# ══════════════════════════════════════════════════════════════

@router.patch("/api/reviews/{response_id}/approve")
async def approve_response(response_id: str, body: ResponseApproval, user: AuthUser = Depends(get_current_user)):
    """Approve or skip a review response draft.

    If approved, optionally provide edited response_text to override the draft.
    """
    rows = await _sb_get(f"mrq_review_responses?id=eq.{response_id}&select=*")
    if not rows:
        raise HTTPException(404, "Review response not found")

    review = rows[0]
    if not await check_access(user, review["app_id"]):
        raise HTTPException(403, "Access denied")

    if body.status == "approved":
        text = body.response_text or review.get("response_draft", "")
        if not text:
            raise HTTPException(400, "No response text to approve")

        await _sb_patch(f"mrq_review_responses?id=eq.{response_id}", {
            "status": "approved",
            "response_sent": text,
        })

        # Auto-send in background
        asyncio.create_task(_send_review_response(review["app_id"], response_id))

    elif body.status == "skipped":
        await _sb_patch(f"mrq_review_responses?id=eq.{response_id}", {
            "status": "skipped",
        })
    else:
        raise HTTPException(400, f"Invalid status: {body.status}")

    result = await _sb_get(f"mrq_review_responses?id=eq.{response_id}&select=*")
    return result[0] if result else {"ok": True}


async def _send_review_response(app_id: str, response_id: str):
    """Background task: send approved response to store."""
    try:
        rows = await _sb_get(f"mrq_review_responses?id=eq.{response_id}&select=*")
        if not rows:
            return
        review = rows[0]
        store = review.get("store")
        review_store_id = review.get("review_id")
        text = review.get("response_sent", "")

        if not review_store_id or not text:
            log.warning("Cannot send: missing review_id or response text for %s", response_id)
            return

        # Load connector
        from core.vault import load_credential
        creds = await _sb_get(
            f"mrq_store_credentials?app_id=eq.{app_id}&store=eq.{store}&is_active=eq.true&select=*&limit=1"
        )
        if not creds:
            log.warning("No credentials to send review response for app %s store %s", app_id, store)
            await _sb_patch(f"mrq_review_responses?id=eq.{response_id}", {
                "status": "approved",  # Keep approved, just can't send
            })
            return

        cred = creds[0]
        secret_data = load_credential(cred["vault_key"])

        if store == "google":
            from connectors.google import GooglePlayConnector
            connector = GooglePlayConnector(secret_data)

            apps = await _sb_get(f"mrq_apps?id=eq.{app_id}&select=package_name_android")
            package = apps[0].get("package_name_android") if apps else None
            if not package:
                log.warning("No package name for Google review reply, app %s", app_id)
                return

            # Google enforces 350 char limit
            if len(text) > 350:
                text = text[:347] + "..."

            result = await connector.reply_to_review(package, review_store_id, text)
            log.info("Google review reply sent for %s: %s", review_store_id, result)

        elif store == "apple":
            from connectors.apple import AppleConnector
            connector = AppleConnector(
                issuer_id=cred.get("issuer_id", ""),
                key_id=cred.get("key_id", ""),
                private_key=secret_data.get("private_key", ""),
            )

            result = await connector.reply_to_review(review_store_id, text)
            log.info("Apple review reply sent for %s: %s", review_store_id, result)

        # Mark as sent
        await _sb_patch(f"mrq_review_responses?id=eq.{response_id}", {
            "status": "sent",
            "sent_at": datetime.now(timezone.utc).isoformat(),
        })

        # Audit log
        await _sb_post("mrq_audit_log", {
            "app_id": app_id,
            "actor_type": "system",
            "action": "review_reply_sent",
            "summary": f"Review reply sent to {store} for review {review_store_id}",
            "details": {"response_id": response_id, "store": store},
        })

    except Exception as e:
        log.exception("Failed to send review response %s: %s", response_id, e)
        # Don't change status — keep as approved so user can retry
