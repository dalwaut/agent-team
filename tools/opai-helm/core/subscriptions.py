"""HELM — Subscription access control helpers.

Checks whether a business has an active HELM subscription before allowing
access to generative features (content, social, AI operations).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import HTTPException

from core.supabase import _sb_get, _sb_patch

log = logging.getLogger("helm.core.subscriptions")


async def get_subscription(business_id: str) -> dict | None:
    """Return the most recent subscription row for a business, or None."""
    rows = await _sb_get(
        f"helm_subscriptions?business_id=eq.{business_id}"
        f"&order=created_at.desc&limit=1"
    )
    return rows[0] if rows else None


async def is_active(business_id: str) -> bool:
    """Return True if the business has an active or trialing subscription."""
    sub = await get_subscription(business_id)
    if not sub:
        return False
    return sub.get("status") in ("active", "trialing")


async def require_subscription(business_id: str) -> dict:
    """Raise 402 if the business has no active subscription.

    Returns the subscription row on success.
    """
    sub = await get_subscription(business_id)
    if not sub or sub.get("status") not in ("active", "trialing"):
        raise HTTPException(
            402,
            detail={
                "error": "no_active_subscription",
                "message": "This feature requires an active HELM subscription.",
                "upgrade_url": "/helm/",
            },
        )
    return sub


async def upsert_from_stripe(
    business_id: str,
    stripe_subscription_id: str,
    stripe_customer_id: str | None,
    stripe_session_id: str | None,
    status: str,
    plan: str | None,
    current_period_start: int | None,
    current_period_end: int | None,
    cancel_at_period_end: bool = False,
    metadata: dict | None = None,
) -> None:
    """Create or update a helm_subscription row from Stripe data."""
    # Convert Unix timestamps to ISO strings
    def _ts(unix: int | None) -> str | None:
        if unix is None:
            return None
        return datetime.fromtimestamp(unix, tz=timezone.utc).isoformat()

    row = {
        "business_id": str(business_id),
        "stripe_subscription_id": stripe_subscription_id,
        "stripe_customer_id": stripe_customer_id,
        "status": status,
        "plan": plan,
        "current_period_start": _ts(current_period_start),
        "current_period_end": _ts(current_period_end),
        "cancel_at_period_end": cancel_at_period_end,
        "metadata": metadata or {},
    }
    if stripe_session_id:
        row["stripe_session_id"] = stripe_session_id

    # Upsert on stripe_subscription_id
    from core.supabase import _sb_post
    try:
        await _sb_post(
            "helm_subscriptions",
            row,
            upsert=True,
            on_conflict="stripe_subscription_id",
        )
        log.info(
            "Subscription upserted for business %s — status=%s plan=%s",
            business_id, status, plan,
        )
    except Exception as exc:
        log.error("Failed to upsert subscription for %s: %s", business_id, exc)


async def cancel_subscription(business_id: str) -> None:
    """Mark a business's subscription as canceled in DB."""
    sub = await get_subscription(business_id)
    if sub:
        await _sb_patch(
            f"helm_subscriptions?business_id=eq.{business_id}",
            {
                "status": "canceled",
                "canceled_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        log.info("Subscription canceled for business %s", business_id)
