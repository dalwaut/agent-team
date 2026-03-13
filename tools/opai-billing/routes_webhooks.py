"""OPAI Billing — Stripe webhook handler.

No OPAI auth on this route — Stripe signature verification only.
"""

import json
import logging
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from audit import log_audit

import stripe
from fastapi import APIRouter, Request, HTTPException

import config
from stripe_client import bb_query, bb_admin_create_user
from provisioner import queue_provisioning

router = APIRouter(prefix="/api")
logger = logging.getLogger("opai-billing.webhooks")

stripe.api_key = config.STRIPE_SECRET_KEY


async def _log_event(event_id: str, event_type: str, payload: dict, processed: bool = False, error: str = None):
    """Log webhook event for idempotency and debugging."""
    try:
        await bb_query("stripe_webhook_events", method="POST", body={
            "stripe_event_id": event_id,
            "event_type": event_type,
            "processed": processed,
            "payload": payload,
            "error": error,
        })
    except Exception as e:
        logger.error(f"Failed to log webhook event {event_id}: {e}")


async def _is_duplicate(event_id: str) -> bool:
    """Check if we already processed this event."""
    try:
        existing = await bb_query(
            "stripe_webhook_events",
            f"stripe_event_id=eq.{event_id}&processed=eq.true&select=id"
        )
        return len(existing) > 0
    except Exception:
        return False


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook events."""
    body = await request.body()
    sig = request.headers.get("stripe-signature")

    if not sig:
        raise HTTPException(status_code=400, detail="Missing stripe-signature header")

    if not config.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=500, detail="Webhook secret not configured")

    try:
        event = stripe.Webhook.construct_event(
            body, sig, config.STRIPE_WEBHOOK_SECRET
        )
    except stripe.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid signature")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid payload")

    event_id = event.get("id", "unknown")
    event_type = event.get("type", "unknown")

    if await _is_duplicate(event_id):
        return {"status": "already_processed"}

    logger.info(f"Webhook received: {event_type} ({event_id})")

    try:
        if event_type == "checkout.session.completed":
            await _handle_checkout_completed(event)
        elif event_type == "invoice.payment_succeeded":
            await _handle_payment_succeeded(event)
        elif event_type == "invoice.payment_failed":
            await _handle_payment_failed(event)
        elif event_type == "customer.subscription.updated":
            await _handle_subscription_updated(event)
        elif event_type == "customer.subscription.deleted":
            await _handle_subscription_deleted(event)
        elif event_type == "product.updated":
            await _handle_product_updated(event)
        elif event_type == "price.updated":
            await _handle_price_updated(event)
        else:
            logger.info(f"Unhandled event type: {event_type}")

        await _log_event(event_id, event_type, event.get("data", {}), processed=True)

        # Audit trail for key billing events
        if event_type in ("checkout.session.completed", "invoice.payment_succeeded", "invoice.payment_failed"):
            tier_status = "completed" if event_type != "invoice.payment_failed" else "failed"
            try:
                log_audit(
                    tier="system",
                    service="opai-billing",
                    event=event_type.replace(".", "-"),
                    status=tier_status,
                    summary=f"Stripe {event_type} ({event_id[:20]})",
                    details={"stripe_event_id": event_id, "event_type": event_type},
                )
            except Exception:
                pass

    except Exception as e:
        logger.error(f"Error processing {event_type}: {e}")
        await _log_event(event_id, event_type, event.get("data", {}), processed=False, error=str(e))
        raise HTTPException(status_code=500, detail=f"Processing error: {str(e)}")

    return {"status": "ok"}


# ── Event Handlers ─────────────────────────────────────────

async def _handle_checkout_completed(event):
    """New purchase completed — create user, provision OPAI access."""
    session = event["data"]["object"]
    customer_id = session.get("customer")
    customer_email = session.get("customer_details", {}).get("email") or session.get("customer_email")
    subscription_id = session.get("subscription")
    mode = session.get("mode")

    if not customer_email:
        logger.error("Checkout completed but no customer email found")
        return

    logger.info(f"Checkout completed: {customer_email} (mode={mode})")

    user_id = None

    # Check if user already linked via stripe_customers
    if customer_id:
        existing_customers = await bb_query(
            "stripe_customers",
            f"stripe_customer_id=eq.{customer_id}&select=user_id"
        )
        if existing_customers:
            user_id = existing_customers[0]["user_id"]

    if not user_id:
        # Create new user or find existing
        try:
            new_user = await bb_admin_create_user(
                email=customer_email,
                metadata={
                    "display_name": customer_email.split("@")[0],
                    "role": "user",
                    "tier": "starter",
                },
            )
            user_id = new_user.get("id")
            logger.info(f"Created new user: {user_id}")
        except Exception as e:
            logger.info(f"User creation failed (may exist): {e}")

    # Create/update stripe_customers record
    if user_id and customer_id:
        try:
            await bb_query("stripe_customers", method="POST", body={
                "user_id": user_id,
                "stripe_customer_id": customer_id,
                "email": customer_email,
            })
        except Exception:
            try:
                await bb_query(
                    "stripe_customers",
                    f"user_id=eq.{user_id}",
                    method="PATCH",
                    body={"stripe_customer_id": customer_id, "email": customer_email},
                )
            except Exception:
                pass

    # Set OPAI access on profile
    if user_id:
        await bb_query(
            "profiles",
            f"id=eq.{user_id}",
            method="PATCH",
            body={
                "opai_access": True,
                "stripe_customer_id": customer_id,
                "tier": "starter",
            },
        )

    # If subscription mode, create subscription record
    if mode == "subscription" and subscription_id and user_id:
        try:
            stripe_sub = stripe.Subscription.retrieve(subscription_id)
            item = stripe_sub["items"]["data"][0] if stripe_sub.get("items", {}).get("data") else {}
            price = item.get("price", {})

            # Look up product for tier mapping
            tier_mapping = "starter"
            if price.get("product"):
                db_products = await bb_query(
                    "stripe_products",
                    f"stripe_product_id=eq.{price['product']}&select=tier_mapping"
                )
                if db_products:
                    tier_mapping = db_products[0].get("tier_mapping", "starter")

            # Find the DB price ID
            price_id = None
            if price.get("id"):
                db_prices = await bb_query(
                    "stripe_prices",
                    f"stripe_price_id=eq.{price['id']}&select=id"
                )
                if db_prices:
                    price_id = db_prices[0]["id"]

            await bb_query("subscriptions", method="POST", body={
                "user_id": user_id,
                "stripe_subscription_id": subscription_id,
                "price_id": price_id,
                "status": "active",
                "tier_mapping": tier_mapping,
                "current_period_start": stripe_sub.get("current_period_start"),
                "current_period_end": stripe_sub.get("current_period_end"),
            })

            # Update tier on profile
            await bb_query(
                "profiles",
                f"id=eq.{user_id}",
                method="PATCH",
                body={"tier": tier_mapping},
            )
        except Exception as e:
            logger.error(f"Error creating subscription record: {e}")

    # Queue OPAI provisioning
    if user_id:
        await queue_provisioning(
            user_id=user_id,
            trigger_event="checkout.session.completed",
            trigger_id=session.get("id"),
            metadata={"email": customer_email, "customer_id": customer_id},
        )


async def _handle_payment_succeeded(event):
    """Invoice paid — log transaction."""
    invoice = event["data"]["object"]
    customer_id = invoice.get("customer")
    amount = invoice.get("amount_paid", 0)
    currency = invoice.get("currency", "usd")

    user_id = None
    if customer_id:
        customers = await bb_query(
            "stripe_customers",
            f"stripe_customer_id=eq.{customer_id}&select=user_id"
        )
        if customers:
            user_id = customers[0]["user_id"]

    await bb_query("payment_transactions", method="POST", body={
        "user_id": user_id,
        "stripe_payment_intent_id": invoice.get("payment_intent"),
        "stripe_checkout_session_id": invoice.get("id"),
        "amount": amount,
        "currency": currency,
        "status": "succeeded",
        "customer_email": invoice.get("customer_email", ""),
    })


async def _handle_payment_failed(event):
    """Invoice payment failed — log."""
    invoice = event["data"]["object"]
    customer_id = invoice.get("customer")

    user_id = None
    if customer_id:
        customers = await bb_query(
            "stripe_customers",
            f"stripe_customer_id=eq.{customer_id}&select=user_id"
        )
        if customers:
            user_id = customers[0]["user_id"]

    await bb_query("payment_transactions", method="POST", body={
        "user_id": user_id,
        "stripe_payment_intent_id": invoice.get("payment_intent"),
        "amount": invoice.get("amount_due", 0),
        "currency": invoice.get("currency", "usd"),
        "status": "failed",
        "customer_email": invoice.get("customer_email", ""),
    })

    logger.warning(f"Payment failed for customer {customer_id}")


async def _handle_subscription_updated(event):
    """Subscription status changed — update DB."""
    sub = event["data"]["object"]
    stripe_sub_id = sub.get("id")
    status = sub.get("status")

    db_subs = await bb_query(
        "subscriptions",
        f"stripe_subscription_id=eq.{stripe_sub_id}&select=*"
    )
    if not db_subs:
        return

    update = {"status": status}
    if sub.get("current_period_end"):
        update["current_period_end"] = sub["current_period_end"]
    if sub.get("cancel_at_period_end") is not None:
        update["cancel_at_period_end"] = sub["cancel_at_period_end"]

    await bb_query(
        "subscriptions",
        f"stripe_subscription_id=eq.{stripe_sub_id}",
        method="PATCH",
        body=update,
    )

    # Update user tier
    user_id = db_subs[0].get("user_id")
    if user_id:
        if status == "active":
            tier = db_subs[0].get("tier_mapping", "starter")
            await bb_query("profiles", f"id=eq.{user_id}", method="PATCH", body={"tier": tier})
        elif status in ("canceled", "unpaid", "past_due"):
            await bb_query("profiles", f"id=eq.{user_id}", method="PATCH", body={"tier": "free"})


async def _handle_subscription_deleted(event):
    """Subscription canceled/expired — downgrade user."""
    sub = event["data"]["object"]
    stripe_sub_id = sub.get("id")

    db_subs = await bb_query(
        "subscriptions",
        f"stripe_subscription_id=eq.{stripe_sub_id}&select=*"
    )
    if not db_subs:
        return

    await bb_query(
        "subscriptions",
        f"stripe_subscription_id=eq.{stripe_sub_id}",
        method="PATCH",
        body={"status": "canceled"},
    )

    user_id = db_subs[0].get("user_id")
    if user_id:
        await bb_query(
            "profiles",
            f"id=eq.{user_id}",
            method="PATCH",
            body={"tier": "free", "opai_access": False},
        )


async def _handle_product_updated(event):
    """Stripe product updated — sync to DB."""
    product = event["data"]["object"]
    stripe_id = product.get("id")

    db_products = await bb_query(
        "stripe_products",
        f"stripe_product_id=eq.{stripe_id}&select=id"
    )
    if not db_products:
        return

    await bb_query(
        "stripe_products",
        f"stripe_product_id=eq.{stripe_id}",
        method="PATCH",
        body={
            "name": product.get("name"),
            "description": product.get("description", ""),
            "active": product.get("active", True),
        },
    )


async def _handle_price_updated(event):
    """Stripe price updated — sync to DB."""
    price = event["data"]["object"]
    stripe_id = price.get("id")

    db_prices = await bb_query(
        "stripe_prices",
        f"stripe_price_id=eq.{stripe_id}&select=id"
    )
    if not db_prices:
        return

    await bb_query(
        "stripe_prices",
        f"stripe_price_id=eq.{stripe_id}",
        method="PATCH",
        body={
            "unit_amount": price.get("unit_amount"),
            "active": price.get("active", True),
        },
    )
