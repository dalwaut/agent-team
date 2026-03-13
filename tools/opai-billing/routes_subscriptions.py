"""OPAI Billing — Subscription management API (admin-only)."""

import stripe
from fastapi import APIRouter, Depends, HTTPException

from auth import require_admin, AuthUser
import config
from stripe_client import bb_query

router = APIRouter(prefix="/api")

stripe.api_key = config.STRIPE_SECRET_KEY


@router.get("/subscriptions")
async def list_subscriptions(user: AuthUser = Depends(require_admin)):
    """List all subscriptions with user info."""
    subs = await bb_query(
        "subscriptions",
        "select=*,stripe_prices:price_id(unit_amount,currency,recurring_interval)&order=created_at.desc"
    )

    # Enrich with user info and flatten price data
    for sub in subs:
        price_data = sub.pop("stripe_prices", None) or {}
        sub["unit_amount"] = price_data.get("unit_amount", 0)
        sub["currency"] = price_data.get("currency", "usd")
        sub["recurring_interval"] = price_data.get("recurring_interval", "month")

        uid = sub.get("user_id")
        if uid:
            profiles = await bb_query("profiles", f"id=eq.{uid}&select=display_name")
            if profiles:
                sub["user_display_name"] = profiles[0].get("display_name", "")

    return {"subscriptions": subs}


@router.post("/subscriptions/{sub_id}/cancel")
async def cancel_subscription(
    sub_id: str,
    immediate: bool = False,
    user: AuthUser = Depends(require_admin),
):
    """Cancel a subscription (at period end by default, or immediately)."""
    subs = await bb_query("subscriptions", f"id=eq.{sub_id}&select=*")
    if not subs:
        raise HTTPException(status_code=404, detail="Subscription not found")
    sub = subs[0]

    stripe_sub_id = sub.get("stripe_subscription_id")
    if stripe_sub_id and config.STRIPE_SECRET_KEY:
        try:
            if immediate:
                stripe.Subscription.cancel(stripe_sub_id)
            else:
                stripe.Subscription.modify(
                    stripe_sub_id,
                    cancel_at_period_end=True,
                )
        except stripe.StripeError as e:
            raise HTTPException(status_code=400, detail=f"Stripe error: {str(e)}")

    new_status = "canceled" if immediate else "canceling"
    await bb_query(
        "subscriptions",
        f"id=eq.{sub_id}",
        method="PATCH",
        body={"status": new_status},
    )

    return {"success": True, "status": new_status}


@router.post("/subscriptions/{sub_id}/pause")
async def pause_subscription(sub_id: str, user: AuthUser = Depends(require_admin)):
    """Pause a subscription."""
    subs = await bb_query("subscriptions", f"id=eq.{sub_id}&select=*")
    if not subs:
        raise HTTPException(status_code=404, detail="Subscription not found")
    sub = subs[0]

    stripe_sub_id = sub.get("stripe_subscription_id")
    if stripe_sub_id and config.STRIPE_SECRET_KEY:
        try:
            stripe.Subscription.modify(
                stripe_sub_id,
                pause_collection={"behavior": "void"},
            )
        except stripe.StripeError as e:
            raise HTTPException(status_code=400, detail=f"Stripe error: {str(e)}")

    await bb_query(
        "subscriptions",
        f"id=eq.{sub_id}",
        method="PATCH",
        body={"status": "paused"},
    )

    return {"success": True, "status": "paused"}


@router.post("/subscriptions/{sub_id}/resume")
async def resume_subscription(sub_id: str, user: AuthUser = Depends(require_admin)):
    """Resume a paused subscription."""
    subs = await bb_query("subscriptions", f"id=eq.{sub_id}&select=*")
    if not subs:
        raise HTTPException(status_code=404, detail="Subscription not found")
    sub = subs[0]

    stripe_sub_id = sub.get("stripe_subscription_id")
    if stripe_sub_id and config.STRIPE_SECRET_KEY:
        try:
            stripe.Subscription.modify(
                stripe_sub_id,
                pause_collection="",
            )
        except stripe.StripeError as e:
            raise HTTPException(status_code=400, detail=f"Stripe error: {str(e)}")

    await bb_query(
        "subscriptions",
        f"id=eq.{sub_id}",
        method="PATCH",
        body={"status": "active"},
    )

    return {"success": True, "status": "active"}


@router.delete("/subscriptions/{sub_id}/revoke")
async def revoke_subscription(sub_id: str, user: AuthUser = Depends(require_admin)):
    """Cancel subscription AND deactivate user account."""
    subs = await bb_query("subscriptions", f"id=eq.{sub_id}&select=*")
    if not subs:
        raise HTTPException(status_code=404, detail="Subscription not found")
    sub = subs[0]

    # Cancel on Stripe
    stripe_sub_id = sub.get("stripe_subscription_id")
    if stripe_sub_id and config.STRIPE_SECRET_KEY:
        try:
            stripe.Subscription.cancel(stripe_sub_id)
        except stripe.StripeError:
            pass

    # Update subscription status
    await bb_query(
        "subscriptions",
        f"id=eq.{sub_id}",
        method="PATCH",
        body={"status": "canceled"},
    )

    # Deactivate user OPAI access
    uid = sub.get("user_id")
    if uid:
        await bb_query(
            "profiles",
            f"id=eq.{uid}",
            method="PATCH",
            body={"opai_access": False, "tier": "free"},
        )

    return {"success": True, "status": "revoked"}
