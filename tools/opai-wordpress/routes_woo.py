"""OP WordPress — WooCommerce routes."""

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional

import config
from auth import get_current_user, AuthUser

router = APIRouter(prefix="/api")


def _sb_headers_service():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


async def _get_site(site_id: str, user: AuthUser) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        url = f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.get(url, headers=_sb_headers_service())
        sites = resp.json() if resp.status_code == 200 else []
        if not sites:
            raise HTTPException(404, "Site not found")
        return sites[0]


def _get_woo(site: dict):
    from services.woo_client import create_woo_client
    client = create_woo_client(site)
    if not client:
        raise HTTPException(400, "WooCommerce is not enabled for this site")
    return client


# ── WooCommerce Status ───────────────────────────────────────

@router.get("/sites/{site_id}/woo/status")
async def woo_status(site_id: str, user: AuthUser = Depends(get_current_user)):
    """Check WooCommerce capabilities for this site."""
    site = await _get_site(site_id, user)
    if not site.get("is_woocommerce"):
        return {"enabled": False, "has_keys": False, "mode": "none"}
    has_keys = bool(site.get("woo_key") and site.get("woo_secret"))
    return {
        "enabled": True,
        "has_keys": has_keys,
        "mode": "full" if has_keys else "basic",
        "available": ["products", "categories"] if not has_keys
            else ["products", "categories", "orders", "customers", "coupons", "reports"],
        "unavailable": ["orders", "customers", "coupons", "reports", "bulk operations",
                         "create/edit/delete products"] if not has_keys else [],
    }


# ── Request Models ────────────────────────────────────────

class CreateProduct(BaseModel):
    name: str
    type: str = "simple"
    regular_price: Optional[str] = None
    description: Optional[str] = None
    short_description: Optional[str] = None
    categories: Optional[List[dict]] = None
    images: Optional[List[dict]] = None
    status: str = "draft"
    sku: Optional[str] = None
    manage_stock: bool = False
    stock_quantity: Optional[int] = None


class UpdateProduct(BaseModel):
    name: Optional[str] = None
    regular_price: Optional[str] = None
    sale_price: Optional[str] = None
    description: Optional[str] = None
    short_description: Optional[str] = None
    status: Optional[str] = None
    sku: Optional[str] = None
    manage_stock: Optional[bool] = None
    stock_quantity: Optional[int] = None
    categories: Optional[List[dict]] = None


class BulkProductUpdate(BaseModel):
    updates: List[dict]  # Each dict must have "id" + fields to update


# ── Products ──────────────────────────────────────────────

@router.get("/sites/{site_id}/woo/products")
async def list_products(site_id: str,
                        page: int = 1, per_page: int = 20,
                        search: str = None, category: int = None,
                        status: str = None,
                        user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.list_products(page=page, per_page=per_page,
                                   search=search, category=category, status=status)


@router.get("/sites/{site_id}/woo/products/{product_id}")
async def get_product(site_id: str, product_id: int,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.get_product(product_id)


@router.post("/sites/{site_id}/woo/products")
async def create_product(site_id: str, body: CreateProduct,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.create_product(body.dict(exclude_none=True))


@router.put("/sites/{site_id}/woo/products/{product_id}")
async def update_product(site_id: str, product_id: int, body: UpdateProduct,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.update_product(product_id, body.dict(exclude_none=True))


@router.delete("/sites/{site_id}/woo/products/{product_id}")
async def delete_product(site_id: str, product_id: int, force: bool = False,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.delete_product(product_id, force=force)


@router.post("/sites/{site_id}/woo/products/bulk")
async def bulk_update_products(site_id: str, body: BulkProductUpdate,
                               user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.bulk_update_products(body.updates)


# ── Orders ────────────────────────────────────────────────

@router.get("/sites/{site_id}/woo/orders")
async def list_orders(site_id: str,
                      page: int = 1, per_page: int = 20,
                      status: str = None, search: str = None,
                      user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.list_orders(page=page, per_page=per_page,
                                  status=status, search=search)


@router.get("/sites/{site_id}/woo/orders/{order_id}")
async def get_order(site_id: str, order_id: int,
                    user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.get_order(order_id)


@router.put("/sites/{site_id}/woo/orders/{order_id}")
async def update_order(site_id: str, order_id: int, body: dict,
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.update_order(order_id, body)


# ── Customers ─────────────────────────────────────────────

@router.get("/sites/{site_id}/woo/customers")
async def list_customers(site_id: str,
                         page: int = 1, per_page: int = 20,
                         search: str = None,
                         user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.list_customers(page=page, per_page=per_page, search=search)


@router.get("/sites/{site_id}/woo/customers/{customer_id}")
async def get_customer(site_id: str, customer_id: int,
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.get_customer(customer_id)


@router.get("/sites/{site_id}/woo/customers/{customer_id}/orders")
async def get_customer_orders(site_id: str, customer_id: int,
                              page: int = 1, per_page: int = 10,
                              user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.list_orders(page=page, per_page=per_page,
                                  customer=customer_id)


# ── Categories ────────────────────────────────────────────

@router.get("/sites/{site_id}/woo/categories")
async def list_product_categories(site_id: str,
                                  page: int = 1, per_page: int = 100,
                                  user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.list_product_categories(page=page, per_page=per_page)


# ── Reports ───────────────────────────────────────────────

@router.get("/sites/{site_id}/woo/reports/sales")
async def sales_report(site_id: str, period: str = "month",
                       user: AuthUser = Depends(get_current_user)):
    site = await _get_site(site_id, user)
    woo = _get_woo(site)
    return await woo.get_sales_report(period=period)
