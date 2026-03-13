"""OPAI Billing — Product/Price CRUD + Dashboard API (admin-only)."""

import stripe
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from auth import require_admin, AuthUser
import config
from stripe_client import bb_query

router = APIRouter(prefix="/api")

stripe.api_key = config.STRIPE_SECRET_KEY


# ── Models ─────────────────────────────────────────────────

class ProductCreate(BaseModel):
    name: str
    description: Optional[str] = ""
    category: Optional[str] = "opai"
    tier_mapping: Optional[str] = "starter"
    metadata: Optional[dict] = {}
    image_url: Optional[str] = None
    # Price info
    price_amount: Optional[int] = None  # cents
    price_currency: Optional[str] = "usd"
    price_type: Optional[str] = "recurring"  # recurring or one_time
    price_interval: Optional[str] = "month"  # month, year


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    tier_mapping: Optional[str] = None
    active: Optional[bool] = None
    metadata: Optional[dict] = None
    image_url: Optional[str] = None


class PriceCreate(BaseModel):
    product_id: str  # DB product UUID
    amount: int  # cents
    currency: str = "usd"
    type: str = "recurring"
    interval: Optional[str] = "month"
    nickname: Optional[str] = None


# ── Dashboard ──────────────────────────────────────────────

@router.get("/dashboard")
async def dashboard(user: AuthUser = Depends(require_admin)):
    """Revenue overview: MRR, active subs, recent transactions."""
    try:
        subs = await bb_query("subscriptions", "status=eq.active&select=id")
        active_count = len(subs)

        transactions = await bb_query(
            "payment_transactions",
            "select=*&order=created_at.desc&limit=10"
        )

        products = await bb_query("stripe_products", "active=eq.true&select=id")

        # Calculate MRR from active subscriptions
        mrr = 0
        if active_count > 0:
            active_subs = await bb_query(
                "subscriptions",
                "status=eq.active&select=*,stripe_prices:price_id(unit_amount,recurring_interval)"
            )
            for sub in active_subs:
                price_data = sub.get("stripe_prices") or {}
                amount = price_data.get("unit_amount", 0) or 0
                interval = price_data.get("recurring_interval", "month")
                if interval == "year":
                    mrr += amount / 12
                else:
                    mrr += amount

        return {
            "mrr": round(mrr / 100, 2),
            "active_subscriptions": active_count,
            "total_products": len(products),
            "recent_transactions": transactions,
        }
    except Exception as e:
        return {
            "mrr": 0,
            "active_subscriptions": 0,
            "total_products": 0,
            "recent_transactions": [],
            "error": str(e),
        }


# ── Products ───────────────────────────────────────────────

@router.get("/products")
async def list_products(user: AuthUser = Depends(require_admin)):
    """List all products with their prices."""
    products = await bb_query(
        "stripe_products",
        "select=*&order=created_at.desc"
    )
    prices = await bb_query(
        "stripe_prices",
        "select=*&active=eq.true"
    )

    # Group prices by product
    price_map = {}
    for p in prices:
        pid = p.get("product_id")
        if pid not in price_map:
            price_map[pid] = []
        price_map[pid].append(p)

    for prod in products:
        prod["prices"] = price_map.get(prod["id"], [])

    return {"products": products}


@router.post("/products")
async def create_product(body: ProductCreate, user: AuthUser = Depends(require_admin)):
    """Create product in DB and on Stripe."""
    stripe_product = None
    stripe_price = None

    if config.STRIPE_SECRET_KEY:
        try:
            stripe_product = stripe.Product.create(
                name=body.name,
                description=body.description or "",
                metadata={
                    "category": body.category or "opai",
                    "tier_mapping": body.tier_mapping or "starter",
                    **(body.metadata or {}),
                },
                images=[body.image_url] if body.image_url else [],
            )

            if body.price_amount:
                price_params = {
                    "product": stripe_product.id,
                    "unit_amount": body.price_amount,
                    "currency": body.price_currency,
                }
                if body.price_type == "recurring":
                    price_params["recurring"] = {"interval": body.price_interval or "month"}
                stripe_price = stripe.Price.create(**price_params)
        except stripe.StripeError as e:
            raise HTTPException(status_code=400, detail=f"Stripe error: {str(e)}")

    # Create in DB
    db_product = await bb_query("stripe_products", method="POST", body={
        "stripe_product_id": stripe_product.id if stripe_product else None,
        "name": body.name,
        "description": body.description or "",
        "category": body.category or "opai",
        "tier_mapping": body.tier_mapping or "starter",
        "active": True,
        "status": "active",
        "metadata": body.metadata or {},
        "images": [body.image_url] if body.image_url else [],
    })

    # Create price in DB
    if stripe_price and db_product:
        prod_id = db_product[0]["id"] if isinstance(db_product, list) else db_product["id"]
        await bb_query("stripe_prices", method="POST", body={
            "stripe_price_id": stripe_price.id,
            "product_id": prod_id,
            "unit_amount": body.price_amount,
            "currency": body.price_currency,
            "type": body.price_type,
            "recurring_interval": body.price_interval if body.price_type == "recurring" else None,
            "active": True,
        })

    return {"product": db_product[0] if isinstance(db_product, list) else db_product}


@router.put("/products/{product_id}")
async def update_product(product_id: str, body: ProductUpdate, user: AuthUser = Depends(require_admin)):
    """Update product in DB and on Stripe."""
    products = await bb_query("stripe_products", f"id=eq.{product_id}&select=*")
    if not products:
        raise HTTPException(status_code=404, detail="Product not found")
    product = products[0]

    # Update on Stripe
    if config.STRIPE_SECRET_KEY and product.get("stripe_product_id"):
        try:
            update_data = {}
            if body.name is not None:
                update_data["name"] = body.name
            if body.description is not None:
                update_data["description"] = body.description
            if body.active is not None:
                update_data["active"] = body.active
            if body.image_url is not None:
                update_data["images"] = [body.image_url] if body.image_url else []
            if update_data:
                stripe.Product.modify(product["stripe_product_id"], **update_data)
        except stripe.StripeError as e:
            raise HTTPException(status_code=400, detail=f"Stripe error: {str(e)}")

    # Update in DB
    db_update = {}
    if body.name is not None:
        db_update["name"] = body.name
    if body.description is not None:
        db_update["description"] = body.description
    if body.category is not None:
        db_update["category"] = body.category
    if body.tier_mapping is not None:
        db_update["tier_mapping"] = body.tier_mapping
    if body.active is not None:
        db_update["active"] = body.active
    if body.metadata is not None:
        db_update["metadata"] = body.metadata
    if body.image_url is not None:
        db_update["images"] = [body.image_url] if body.image_url else []

    if db_update:
        result = await bb_query(
            "stripe_products",
            f"id=eq.{product_id}",
            method="PATCH",
            body=db_update,
        )
        return {"product": result[0] if result else product}

    return {"product": product}


@router.delete("/products/{product_id}")
async def archive_product(product_id: str, user: AuthUser = Depends(require_admin)):
    """Soft-delete: archive product (deactivate on Stripe)."""
    products = await bb_query("stripe_products", f"id=eq.{product_id}&select=*")
    if not products:
        raise HTTPException(status_code=404, detail="Product not found")
    product = products[0]

    if config.STRIPE_SECRET_KEY and product.get("stripe_product_id"):
        try:
            stripe.Product.modify(product["stripe_product_id"], active=False)
        except stripe.StripeError:
            pass

    await bb_query(
        "stripe_products",
        f"id=eq.{product_id}",
        method="PATCH",
        body={"active": False, "status": "archived"},
    )

    return {"success": True}


@router.post("/products/import")
async def import_from_stripe(user: AuthUser = Depends(require_admin)):
    """Import all products and prices from Stripe into DB."""
    if not config.STRIPE_SECRET_KEY:
        raise HTTPException(status_code=400, detail="Stripe not configured")

    imported_products = 0
    imported_prices = 0

    try:
        stripe_products = stripe.Product.list(limit=100, active=True)

        for sp in stripe_products.auto_paging_iter():
            existing = await bb_query(
                "stripe_products",
                f"stripe_product_id=eq.{sp.id}&select=id"
            )
            if existing:
                continue

            db_prod = await bb_query("stripe_products", method="POST", body={
                "stripe_product_id": sp.id,
                "name": sp.name,
                "description": sp.description or "",
                "category": sp.metadata.get("category", "opai") if sp.metadata else "opai",
                "tier_mapping": sp.metadata.get("tier_mapping", "starter") if sp.metadata else "starter",
                "active": sp.active,
                "status": "active" if sp.active else "archived",
                "metadata": dict(sp.metadata) if sp.metadata else {},
                "images": list(sp.images) if sp.images else [],
            })
            imported_products += 1

            if db_prod:
                prod_db_id = db_prod[0]["id"] if isinstance(db_prod, list) else db_prod["id"]
                stripe_prices = stripe.Price.list(product=sp.id, active=True)
                for price in stripe_prices.auto_paging_iter():
                    existing_price = await bb_query(
                        "stripe_prices",
                        f"stripe_price_id=eq.{price.id}&select=id"
                    )
                    if existing_price:
                        continue

                    await bb_query("stripe_prices", method="POST", body={
                        "stripe_price_id": price.id,
                        "product_id": prod_db_id,
                        "unit_amount": price.unit_amount,
                        "currency": price.currency,
                        "type": price.type,
                        "recurring_interval": price.recurring.interval if price.recurring else None,
                        "recurring_interval_count": price.recurring.interval_count if price.recurring else None,
                        "active": price.active,
                        "nickname": price.nickname,
                    })
                    imported_prices += 1

    except stripe.StripeError as e:
        raise HTTPException(status_code=400, detail=f"Stripe error: {str(e)}")

    return {
        "imported_products": imported_products,
        "imported_prices": imported_prices,
    }


@router.post("/products/{product_id}/push")
async def push_to_stripe(product_id: str, user: AuthUser = Depends(require_admin)):
    """Push a local product to Stripe."""
    if not config.STRIPE_SECRET_KEY:
        raise HTTPException(status_code=400, detail="Stripe not configured")

    products = await bb_query("stripe_products", f"id=eq.{product_id}&select=*")
    if not products:
        raise HTTPException(status_code=404, detail="Product not found")
    product = products[0]

    try:
        if product.get("stripe_product_id"):
            stripe.Product.modify(
                product["stripe_product_id"],
                name=product["name"],
                description=product.get("description", ""),
                metadata={
                    "category": product.get("category", "opai"),
                    "tier_mapping": product.get("tier_mapping", "starter"),
                },
            )
            return {"success": True, "stripe_product_id": product["stripe_product_id"]}
        else:
            sp = stripe.Product.create(
                name=product["name"],
                description=product.get("description", ""),
                metadata={
                    "category": product.get("category", "opai"),
                    "tier_mapping": product.get("tier_mapping", "starter"),
                },
            )
            await bb_query(
                "stripe_products",
                f"id=eq.{product_id}",
                method="PATCH",
                body={"stripe_product_id": sp.id},
            )
            return {"success": True, "stripe_product_id": sp.id}
    except stripe.StripeError as e:
        raise HTTPException(status_code=400, detail=f"Stripe error: {str(e)}")


# ── Prices ─────────────────────────────────────────────────

@router.post("/prices")
async def create_price(body: PriceCreate, user: AuthUser = Depends(require_admin)):
    """Create a price for a product."""
    products = await bb_query("stripe_products", f"id=eq.{body.product_id}&select=*")
    if not products:
        raise HTTPException(status_code=404, detail="Product not found")
    product = products[0]

    stripe_price = None
    if config.STRIPE_SECRET_KEY and product.get("stripe_product_id"):
        try:
            price_params = {
                "product": product["stripe_product_id"],
                "unit_amount": body.amount,
                "currency": body.currency,
            }
            if body.type == "recurring":
                price_params["recurring"] = {"interval": body.interval or "month"}
            if body.nickname:
                price_params["nickname"] = body.nickname
            stripe_price = stripe.Price.create(**price_params)
        except stripe.StripeError as e:
            raise HTTPException(status_code=400, detail=f"Stripe error: {str(e)}")

    db_price = await bb_query("stripe_prices", method="POST", body={
        "stripe_price_id": stripe_price.id if stripe_price else None,
        "product_id": body.product_id,
        "unit_amount": body.amount,
        "currency": body.currency,
        "type": body.type,
        "recurring_interval": body.interval if body.type == "recurring" else None,
        "active": True,
        "nickname": body.nickname,
    })

    return {"price": db_price[0] if isinstance(db_price, list) else db_price}


@router.get("/transactions")
async def list_transactions(
    page: int = 0,
    limit: int = 25,
    user: AuthUser = Depends(require_admin),
):
    """List payment transactions (paginated)."""
    offset = page * limit
    transactions = await bb_query(
        "payment_transactions",
        f"select=*&order=created_at.desc&limit={limit}&offset={offset}"
    )
    return {"transactions": transactions, "page": page, "limit": limit}
