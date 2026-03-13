"""OPAI Billing — Public checkout routes (no OPAI auth required).

These endpoints are called from opai.boutabyte.com to create checkout sessions.
"""

import stripe
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

import config
from stripe_client import bb_query

router = APIRouter(prefix="/api/checkout")

stripe.api_key = config.STRIPE_SECRET_KEY


class CheckoutRequest(BaseModel):
    price_id: str  # Stripe price ID (e.g., price_xxx)
    email: Optional[str] = None
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


@router.get("/products")
async def list_published_products():
    """List products available for purchase (public — no auth)."""
    products = await bb_query(
        "stripe_products",
        "active=eq.true&category=eq.opai&select=id,name,description,images,tier_mapping,metadata"
    )
    prices = await bb_query(
        "stripe_prices",
        "active=eq.true&select=id,product_id,stripe_price_id,unit_amount,currency,type,recurring_interval,nickname"
    )

    # Group prices by product
    price_map = {}
    for p in prices:
        pid = p.get("product_id")
        if pid not in price_map:
            price_map[pid] = []
        price_map[pid].append(p)

    # Only return products that have at least one active price
    result = []
    for prod in products:
        prod_prices = price_map.get(prod["id"], [])
        if prod_prices:
            result.append({
                "id": prod["id"],
                "name": prod["name"],
                "description": prod["description"],
                "images": prod.get("images", []),
                "tier": prod.get("tier_mapping", "starter"),
                "prices": prod_prices,
            })

    return {"products": result}


@router.post("/session")
async def create_checkout_session(body: CheckoutRequest):
    """Create a Stripe Checkout Session for purchasing OPAI access."""
    if not config.STRIPE_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Stripe not configured")

    # Determine if this is a subscription or one-time payment
    # Look up the price to check its type
    try:
        stripe_price = stripe.Price.retrieve(body.price_id)
    except stripe.StripeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid price: {str(e)}")

    mode = "subscription" if stripe_price.type == "recurring" else "payment"

    success_url = body.success_url or f"{config.PUBLIC_SITE_URL}/welcome?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = body.cancel_url or f"{config.PUBLIC_SITE_URL}/about#pricing"

    session_params = {
        "mode": mode,
        "line_items": [{"price": body.price_id, "quantity": 1}],
        "success_url": success_url,
        "cancel_url": cancel_url,
        "allow_promotion_codes": True,
    }

    if body.email:
        session_params["customer_email"] = body.email

    try:
        session = stripe.checkout.Session.create(**session_params)
    except stripe.StripeError as e:
        raise HTTPException(status_code=400, detail=f"Checkout error: {str(e)}")

    return {"session_id": session.id, "url": session.url}
