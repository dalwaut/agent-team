"""WooCommerce REST API client — uses WC consumer key/secret auth."""

import logging
from typing import Optional
from urllib.parse import urljoin

import httpx

log = logging.getLogger("opai-wordpress.woo-client")


class WooClient:
    """WooCommerce REST API v3 client with consumer key/secret auth."""

    def __init__(self, site_url: str, consumer_key: str, consumer_secret: str):
        self.base_url = f"{site_url.rstrip('/')}/wp-json/wc/v3"
        self.auth = (consumer_key, consumer_secret)

    async def _request(self, method: str, endpoint: str,
                       params: dict = None, json: dict = None) -> dict:
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(
                method, url,
                params=params,
                json=json,
                auth=self.auth,
            )
            if resp.status_code >= 400:
                return {
                    "success": False,
                    "status_code": resp.status_code,
                    "error": resp.text,
                    "data": None,
                }
            return {
                "success": True,
                "status_code": resp.status_code,
                "data": resp.json(),
                "error": None,
            }

    # ── Products ──────────────────────────────────────────────

    async def list_products(self, page: int = 1, per_page: int = 20,
                            search: str = None, category: int = None,
                            status: str = None, orderby: str = "date",
                            order: str = "desc") -> dict:
        params = {"page": page, "per_page": per_page, "orderby": orderby, "order": order}
        if search:
            params["search"] = search
        if category:
            params["category"] = category
        if status:
            params["status"] = status
        return await self._request("GET", "products", params=params)

    async def get_product(self, product_id: int) -> dict:
        return await self._request("GET", f"products/{product_id}")

    async def create_product(self, data: dict) -> dict:
        return await self._request("POST", "products", json=data)

    async def update_product(self, product_id: int, data: dict) -> dict:
        return await self._request("PUT", f"products/{product_id}", json=data)

    async def delete_product(self, product_id: int, force: bool = False) -> dict:
        return await self._request("DELETE", f"products/{product_id}",
                                   params={"force": force})

    async def bulk_update_products(self, updates: list[dict]) -> dict:
        return await self._request("POST", "products/batch", json={"update": updates})

    # ── Orders ────────────────────────────────────────────────

    async def list_orders(self, page: int = 1, per_page: int = 20,
                          status: str = None, search: str = None,
                          customer: int = None) -> dict:
        params = {"page": page, "per_page": per_page}
        if status:
            params["status"] = status
        if search:
            params["search"] = search
        if customer:
            params["customer"] = customer
        return await self._request("GET", "orders", params=params)

    async def get_order(self, order_id: int) -> dict:
        return await self._request("GET", f"orders/{order_id}")

    async def update_order(self, order_id: int, data: dict) -> dict:
        return await self._request("PUT", f"orders/{order_id}", json=data)

    # ── Customers ─────────────────────────────────────────────

    async def list_customers(self, page: int = 1, per_page: int = 20,
                             search: str = None) -> dict:
        params = {"page": page, "per_page": per_page}
        if search:
            params["search"] = search
        return await self._request("GET", "customers", params=params)

    async def get_customer(self, customer_id: int) -> dict:
        return await self._request("GET", f"customers/{customer_id}")

    # ── Product Categories ────────────────────────────────────

    async def list_product_categories(self, page: int = 1, per_page: int = 100) -> dict:
        return await self._request("GET", "products/categories",
                                   params={"page": page, "per_page": per_page})

    async def create_product_category(self, data: dict) -> dict:
        return await self._request("POST", "products/categories", json=data)

    # ── Coupons ───────────────────────────────────────────────

    async def list_coupons(self, page: int = 1, per_page: int = 20) -> dict:
        return await self._request("GET", "coupons",
                                   params={"page": page, "per_page": per_page})

    # ── Reports ───────────────────────────────────────────────

    async def get_sales_report(self, period: str = "month") -> dict:
        return await self._request("GET", "reports/sales",
                                   params={"period": period})

    async def get_top_sellers(self, period: str = "month") -> dict:
        return await self._request("GET", "reports/top_sellers",
                                   params={"period": period})


class WooFallbackClient:
    """Fallback WC client using WP application password auth.

    When no WC consumer keys are configured, we can still access the WC REST
    API using the site's WP application password for basic read operations
    (products, categories).  Write operations and sensitive data (orders,
    customers, reports) are NOT available through this fallback.
    """

    def __init__(self, site_url: str, username: str, app_password: str):
        self.base_url = f"{site_url.rstrip('/')}/wp-json/wc/v3"
        self.auth = (username, app_password)
        self.is_fallback = True

    async def _request(self, method: str, endpoint: str,
                       params: dict = None, json: dict = None) -> dict:
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(
                method, url,
                params=params,
                json=json,
                auth=self.auth,
            )
            if resp.status_code >= 400:
                return {
                    "success": False,
                    "status_code": resp.status_code,
                    "error": resp.text,
                    "data": None,
                }
            return {
                "success": True,
                "status_code": resp.status_code,
                "data": resp.json(),
                "error": None,
            }

    # ── Available in fallback mode ─────────────────────────────

    async def list_products(self, **kwargs) -> dict:
        params = {"page": kwargs.get("page", 1), "per_page": kwargs.get("per_page", 20)}
        if kwargs.get("search"):
            params["search"] = kwargs["search"]
        if kwargs.get("category"):
            params["category"] = kwargs["category"]
        if kwargs.get("status"):
            params["status"] = kwargs["status"]
        return await self._request("GET", "products", params=params)

    async def get_product(self, product_id: int) -> dict:
        return await self._request("GET", f"products/{product_id}")

    async def list_product_categories(self, **kwargs) -> dict:
        params = {"page": kwargs.get("page", 1), "per_page": kwargs.get("per_page", 100)}
        return await self._request("GET", "products/categories", params=params)

    # ── Not available in fallback mode ─────────────────────────

    def _requires_keys(self, feature: str):
        from fastapi import HTTPException
        raise HTTPException(
            403,
            f"{feature} requires WooCommerce API keys. "
            "Edit the site and add your WC Consumer Key and Secret."
        )

    async def create_product(self, data: dict) -> dict:
        self._requires_keys("Creating products")

    async def update_product(self, product_id: int, data: dict) -> dict:
        self._requires_keys("Updating products")

    async def delete_product(self, product_id: int, force: bool = False) -> dict:
        self._requires_keys("Deleting products")

    async def bulk_update_products(self, updates: list) -> dict:
        self._requires_keys("Bulk product operations")

    async def list_orders(self, **kwargs) -> dict:
        self._requires_keys("Order management")

    async def get_order(self, order_id: int) -> dict:
        self._requires_keys("Order management")

    async def update_order(self, order_id: int, data: dict) -> dict:
        self._requires_keys("Order management")

    async def list_customers(self, **kwargs) -> dict:
        self._requires_keys("Customer data")

    async def get_customer(self, customer_id: int) -> dict:
        self._requires_keys("Customer data")

    async def list_coupons(self, **kwargs) -> dict:
        self._requires_keys("Coupon management")

    async def get_sales_report(self, **kwargs) -> dict:
        self._requires_keys("Sales reports")

    async def get_top_sellers(self, **kwargs) -> dict:
        self._requires_keys("Sales reports")

    async def create_product_category(self, data: dict) -> dict:
        self._requires_keys("Creating categories")


def create_woo_client(site: dict):
    """Create a WooClient from a wp_sites row.

    Returns full WooClient if consumer keys are configured,
    WooFallbackClient (basic read-only) if WooCommerce is enabled but no keys,
    or None if WooCommerce is not enabled.
    """
    if not site.get("is_woocommerce"):
        return None
    if site.get("woo_key") and site.get("woo_secret"):
        return WooClient(site["url"], site["woo_key"], site["woo_secret"])
    # Fallback: use WP application password for basic product access
    return WooFallbackClient(site["url"], site["username"], site["app_password"])
