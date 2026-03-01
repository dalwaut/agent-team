"""HELM — Webhook receiver routes (Stripe subscription lifecycle, etc.)."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import stripe
from fastapi import APIRouter, HTTPException, Request

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))

import config
from core.subscriptions import upsert_from_stripe, cancel_subscription

log = logging.getLogger("helm.routes.webhooks")
router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


@router.post("/stripe")
async def stripe_webhook(request: Request):
    """Handle Stripe subscription lifecycle events.

    Events handled:
    - customer.subscription.updated → sync status + period to helm_subscriptions
    - customer.subscription.deleted → mark canceled
    - customer.subscription.paused  → mark paused
    - invoice.payment_failed        → mark past_due
    """
    webhook_secret = config.stripe_webhook_secret()
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    if webhook_secret and sig_header:
        sc = stripe.StripeClient(config.stripe_key())
        try:
            event = sc.construct_event(payload, sig_header, webhook_secret)
        except stripe.SignatureVerificationError:
            raise HTTPException(400, "Invalid Stripe signature")
    else:
        import json
        try:
            event = json.loads(payload)
        except Exception:
            raise HTTPException(400, "Invalid payload")

    event_type = event.get("type") if isinstance(event, dict) else getattr(event, "type", "")
    obj = (event.get("data", {}).get("object", {})
           if isinstance(event, dict)
           else event.data.object)

    def _attr(o, key):
        return o.get(key) if isinstance(o, dict) else getattr(o, key, None)

    if event_type in ("customer.subscription.updated", "customer.subscription.created"):
        sub_id = _attr(obj, "id")
        customer_id = _attr(obj, "customer")
        status = _attr(obj, "status")
        plan = None
        items = _attr(obj, "items")
        if items:
            data = items.get("data") if isinstance(items, dict) else getattr(items, "data", [])
            if data:
                price = _attr(data[0], "price")
                if price:
                    pid = _attr(price, "id") if price else None
                    # Map price ID → plan name
                    for env_key, plan_name in [
                        (config.STRIPE_PRICE_HOSTING_STARTER, "starter"),
                        (config.STRIPE_PRICE_HOSTING_PRO, "pro"),
                        (config.STRIPE_PRICE_HOSTING_BUSINESS, "business"),
                        (config.STRIPE_TEST_PRICE_HOSTING_STARTER, "starter"),
                        (config.STRIPE_TEST_PRICE_HOSTING_PRO, "pro"),
                        (config.STRIPE_TEST_PRICE_HOSTING_BUSINESS, "business"),
                    ]:
                        if pid and pid == env_key:
                            plan = plan_name
                            break

        period_start = _attr(obj, "current_period_start")
        period_end = _attr(obj, "current_period_end")
        cancel_at_period_end = _attr(obj, "cancel_at_period_end") or False
        meta = _attr(obj, "metadata") or {}
        business_id = meta.get("business_id") if isinstance(meta, dict) else getattr(meta, "business_id", None)

        if business_id:
            await upsert_from_stripe(
                business_id=business_id,
                stripe_subscription_id=sub_id,
                stripe_customer_id=str(customer_id) if customer_id else None,
                stripe_session_id=None,
                status=status,
                plan=plan,
                current_period_start=period_start,
                current_period_end=period_end,
                cancel_at_period_end=cancel_at_period_end,
                metadata=meta if isinstance(meta, dict) else {},
            )
            log.info("Subscription %s updated for business %s — status=%s", sub_id, business_id, status)

    elif event_type == "customer.subscription.deleted":
        sub_id = _attr(obj, "id")
        meta = _attr(obj, "metadata") or {}
        business_id = meta.get("business_id") if isinstance(meta, dict) else getattr(meta, "business_id", None)
        if business_id:
            await cancel_subscription(business_id)
            log.info("Subscription %s deleted — business %s access revoked", sub_id, business_id)

    elif event_type == "customer.subscription.paused":
        sub_id = _attr(obj, "id")
        meta = _attr(obj, "metadata") or {}
        business_id = meta.get("business_id") if isinstance(meta, dict) else getattr(meta, "business_id", None)
        if business_id:
            from core.supabase import _sb_patch
            await _sb_patch(
                f"helm_subscriptions?stripe_subscription_id=eq.{sub_id}",
                {"status": "paused"},
            )
            log.info("Subscription %s paused for business %s", sub_id, business_id)

    elif event_type == "invoice.payment_failed":
        sub_id = _attr(obj, "subscription")
        if sub_id:
            from core.supabase import _sb_patch
            await _sb_patch(
                f"helm_subscriptions?stripe_subscription_id=eq.{sub_id}",
                {"status": "past_due"},
            )
            log.info("Invoice payment failed for subscription %s — marked past_due", sub_id)

    return {"received": True}
