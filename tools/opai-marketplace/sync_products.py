"""OPAI Marketplace — BoutaByte catalog sync.

Reads product data from BoutaByte's Supabase tables and upserts
into OPAI's marketplace_products table.
"""

import re

import httpx
import config


def _bb_headers():
    """Headers for BoutaByte Supabase REST API."""
    return {
        "apikey": config.BB_SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.BB_SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def _opai_headers():
    """Headers for OPAI Supabase REST API (service role)."""
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation",
    }


def _slugify(name: str) -> str:
    """Convert a product name to a URL-safe slug."""
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-")


# BoutaByte source tables → product_type mapping
_BB_TABLES = {
    "sub_apps": "webapp",
    "n8n_automations": "automation",
    "wp_plugins": "plugin",
    "mobile_apps": "mobile",
}


async def _fetch_bb_products(client: httpx.AsyncClient, table: str, product_type: str) -> list[dict]:
    """Fetch products from a BoutaByte Supabase table."""
    try:
        resp = await client.get(
            f"{config.BB_SUPABASE_URL}/rest/v1/{table}",
            headers=_bb_headers(),
            params={"select": "*"},
        )
        if resp.status_code >= 400:
            print(f"[marketplace] failed to fetch {table}: {resp.status_code}")
            return []

        rows = resp.json()
        products = []
        for row in rows:
            # Handle both lowercase and capitalized column names (BB2.0 n8n_automations uses capitals)
            row_id = row.get("id") or row.get("ID") or ""
            row_name = row.get("name") or row.get("Name") or row.get("title") or "Untitled"
            row_desc = row.get("description") or row.get("Description") or row.get("short_description") or ""
            row_category = row.get("category") or row.get("Category") or product_type

            products.append({
                "bb_id": str(row_id),
                "product_type": product_type,
                "name": row_name,
                "slug": _slugify(row_name if row_name != "Untitled" else f"{product_type}-{row_id}"),
                "description": row_desc,
                "icon": row.get("icon") or row.get("icon_url") or row.get("logo_url") or "",
                "tier_requirement": row.get("tier_requirement") or row.get("tier") or "free",
                "category": row_category,
                "tags": row.get("tags") or [],
                "bb_url": row.get("url") or row.get("live_url") or row.get("demo_url") or "",
                "is_active": row.get("is_active", True) if "is_active" in row else True,
                "metadata": {
                    k: v for k, v in row.items()
                    if k not in ("id", "name", "title", "description", "short_description",
                                 "icon", "icon_url", "logo_url", "tier", "category", "tags",
                                 "url", "live_url", "demo_url", "is_active")
                },
            })
        return products
    except Exception as e:
        print(f"[marketplace] error fetching {table}: {e}")
        return []


async def run_sync():
    """Sync all BoutaByte products into OPAI's marketplace_products table."""
    if not config.BB_SUPABASE_URL or not config.BB_SUPABASE_SERVICE_KEY:
        print("[marketplace] BB_SUPABASE_URL or BB_SUPABASE_SERVICE_KEY not set, skipping sync")
        return

    all_products = []

    async with httpx.AsyncClient(timeout=15.0) as client:
        for table, product_type in _BB_TABLES.items():
            products = await _fetch_bb_products(client, table, product_type)
            all_products.extend(products)

        if not all_products:
            print("[marketplace] no products fetched from BoutaByte")
            return

        # Upsert into OPAI marketplace_products (on bb_id conflict)
        # Supabase PostgREST upsert via Prefer: resolution=merge-duplicates
        opai_url = f"{config.SUPABASE_URL}/rest/v1/marketplace_products"

        # Ensure tier_requirement values are valid
        valid_tiers = set(config.TIER_ORDER.keys())
        for p in all_products:
            if p["tier_requirement"] not in valid_tiers:
                p["tier_requirement"] = "free"

        # Batch upsert (PostgREST supports arrays)
        resp = await client.post(
            opai_url,
            headers=_opai_headers(),
            json=all_products,
            params={"on_conflict": "bb_id"},
        )

        if resp.status_code >= 400:
            print(f"[marketplace] upsert failed: {resp.status_code} {resp.text[:200]}")
        else:
            print(f"[marketplace] synced {len(all_products)} products from BoutaByte")
