"""OPAI Marketplace — REST API endpoints."""

import hmac
import hashlib
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

import config
from auth import get_current_user, require_admin, AuthUser

router = APIRouter(prefix="/api")


# ── Supabase helpers ─────────────────────────────────────────

def _sb_headers_service():
    """Build Supabase REST headers using the service role key."""
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Auth Config ──────────────────────────────────────────────

@router.get("/auth/config")
def auth_config():
    """Return Supabase config for frontend auth.js initialization."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
        "bb_platform_url": config.BB_PLATFORM_URL,
        "bb_supabase_url": config.BB_SUPABASE_URL,
    }


# ── Request models ───────────────────────────────────────────

class ToggleProductRequest(BaseModel):
    is_active: bool


class UserAccessRequest(BaseModel):
    user_id: str
    product_id: str


class SetTierRequest(BaseModel):
    marketplace_tier: str


class ProvisionN8nRequest(BaseModel):
    user_id: str


class BulkProvisionN8nRequest(BaseModel):
    user_ids: list[str]


class N8nLinkRequest(BaseModel):
    user_id: str
    n8n_email: str


class BBLinkRequest(BaseModel):
    user_id: str
    bb_user_id: str


# ── Products (User) ─────────────────────────────────────────

def _tier_level(tier: str) -> int:
    return config.TIER_ORDER.get(tier, 0)


@router.get("/products")
async def list_products(
    product_type: Optional[str] = None,
    page: int = 1,
    limit: int = Query(default=50, le=100),
    user: AuthUser = Depends(get_current_user),
):
    """List products filtered by user's tier + individual grants."""
    headers = _sb_headers_service()

    async with httpx.AsyncClient(timeout=10.0) as client:
        # Get user's marketplace tier from profile
        profile_resp = await client.get(
            _sb_url("profiles"),
            headers=headers,
            params={"id": f"eq.{user.id}", "select": "marketplace_tier"},
        )
        user_tier = "free"
        if profile_resp.status_code < 400:
            rows = profile_resp.json()
            if rows:
                user_tier = rows[0].get("marketplace_tier", "free") or "free"

        user_tier_level = _tier_level(user_tier)

        # Get individually granted product IDs
        grants_resp = await client.get(
            _sb_url("marketplace_user_access"),
            headers=headers,
            params={"user_id": f"eq.{user.id}", "select": "product_id"},
        )
        granted_ids = set()
        if grants_resp.status_code < 400:
            granted_ids = {g["product_id"] for g in grants_resp.json()}

        # Fetch all active products
        params: dict = {
            "is_active": "eq.true",
            "order": "product_type.asc,name.asc",
            "select": "id,bb_id,product_type,name,slug,description,icon,tier_requirement,category,tags,bb_url,metadata",
        }
        if product_type:
            params["product_type"] = f"eq.{product_type}"

        resp = await client.get(
            _sb_url("marketplace_products"),
            headers=headers,
            params=params,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        all_products = resp.json()

        # Filter: user sees products at or below their tier, plus individually granted
        filtered = []
        for p in all_products:
            product_tier_level = _tier_level(p.get("tier_requirement", "free"))
            if product_tier_level <= user_tier_level or p["id"] in granted_ids:
                filtered.append(p)

        # Paginate
        total = len(filtered)
        start = (page - 1) * limit
        end = start + limit
        page_products = filtered[start:end]

        return {"products": page_products, "total": total, "page": page, "limit": limit, "user_tier": user_tier}


@router.get("/products/{slug}")
async def get_product(slug: str, user: AuthUser = Depends(get_current_user)):
    """Get product detail by slug."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("marketplace_products"),
            headers=_sb_headers_service(),
            params={"slug": f"eq.{slug}", "is_active": "eq.true"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Product not found")
        return data[0]


# ── Products (Admin) ─────────────────────────────────────────

@router.post("/products/sync")
async def trigger_sync(user: AuthUser = Depends(require_admin)):
    """Trigger manual catalog sync from BoutaByte."""
    from sync_products import run_sync
    try:
        await run_sync()
        return {"ok": True, "message": "Catalog sync completed"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/products")
async def admin_list_products(
    product_type: Optional[str] = None,
    user: AuthUser = Depends(require_admin),
):
    """Full catalog with management controls (admin only)."""
    params: dict = {
        "order": "product_type.asc,name.asc",
        "select": "*",
    }
    if product_type:
        params["product_type"] = f"eq.{product_type}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("marketplace_products"),
            headers=_sb_headers_service(),
            params=params,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"products": resp.json()}


@router.post("/products/{product_id}/toggle")
async def toggle_product(
    product_id: str,
    req: ToggleProductRequest,
    user: AuthUser = Depends(require_admin),
):
    """Enable/disable a product in OPAI."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            _sb_url("marketplace_products"),
            headers=_sb_headers_service(),
            params={"id": f"eq.{product_id}"},
            json={"is_active": req.is_active},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True, "is_active": req.is_active}


# ── User Access (Admin) ─────────────────────────────────────

@router.post("/admin/user-access")
async def grant_user_access(
    req: UserAccessRequest,
    user: AuthUser = Depends(require_admin),
):
    """Grant a user access to a specific product."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _sb_url("marketplace_user_access"),
            headers=_sb_headers_service(),
            json={
                "user_id": req.user_id,
                "product_id": req.product_id,
                "granted_by": user.id,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


@router.delete("/admin/user-access")
async def revoke_user_access(
    req: UserAccessRequest,
    user: AuthUser = Depends(require_admin),
):
    """Revoke a user's access to a specific product."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            _sb_url("marketplace_user_access"),
            headers=_sb_headers_service(),
            params={
                "user_id": f"eq.{req.user_id}",
                "product_id": f"eq.{req.product_id}",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True}


@router.put("/admin/user-tier/{user_id}")
async def set_user_tier(
    user_id: str,
    req: SetTierRequest,
    user: AuthUser = Depends(require_admin),
):
    """Set a user's marketplace tier."""
    if req.marketplace_tier not in config.TIER_ORDER:
        raise HTTPException(status_code=400, detail=f"Invalid tier. Must be one of: {list(config.TIER_ORDER.keys())}")

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            _sb_url("profiles"),
            headers=_sb_headers_service(),
            params={"id": f"eq.{user_id}"},
            json={"marketplace_tier": req.marketplace_tier},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"ok": True, "marketplace_tier": req.marketplace_tier}


# ── n8n Provisioning ─────────────────────────────────────────

@router.get("/n8n/status")
async def n8n_status(user: AuthUser = Depends(get_current_user)):
    """Check current user's n8n provisioning status."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("profiles"),
            headers=_sb_headers_service(),
            params={
                "id": f"eq.{user.id}",
                "select": "n8n_provisioned,n8n_username,n8n_provisioned_at",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        rows = resp.json()
        if not rows:
            return {"provisioned": False}
        row = rows[0]
        return {
            "provisioned": row.get("n8n_provisioned", False),
            "username": row.get("n8n_username"),
            "provisioned_at": row.get("n8n_provisioned_at"),
        }


@router.post("/n8n/provision")
async def provision_n8n(
    req: ProvisionN8nRequest,
    user: AuthUser = Depends(require_admin),
):
    """Create n8n account for a specific user (admin only)."""
    from n8n_provisioner import provision_user
    result = await provision_user(req.user_id)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Provisioning failed"))
    return result


@router.post("/n8n/provision-bulk")
async def provision_n8n_bulk(
    req: BulkProvisionN8nRequest,
    user: AuthUser = Depends(require_admin),
):
    """Provision n8n for multiple users at once (admin only)."""
    from n8n_provisioner import provision_user
    results = []
    for uid in req.user_ids:
        result = await provision_user(uid)
        results.append({"user_id": uid, **result})
    return {"results": results}


# ── n8n Account Listing & Linking ─────────────────────────────

_n8n_cache: dict = {"accounts": [], "fetched_at": 0}


@router.get("/n8n/accounts")
async def n8n_accounts(user: AuthUser = Depends(require_admin)):
    """List all n8n users from VPS SQLite (cached 60s)."""
    import time
    now = time.time()
    if now - _n8n_cache["fetched_at"] < 60 and _n8n_cache["accounts"]:
        return {"accounts": _n8n_cache["accounts"]}

    from n8n_provisioner import list_n8n_users
    ok, users = list_n8n_users()
    if not ok:
        raise HTTPException(status_code=502, detail="Failed to fetch n8n accounts from VPS")

    _n8n_cache["accounts"] = users
    _n8n_cache["fetched_at"] = now
    return {"accounts": users}


@router.get("/n8n/lookup")
async def n8n_lookup(
    email: str = Query(...),
    user: AuthUser = Depends(require_admin),
):
    """Find a specific n8n account by email."""
    from n8n_provisioner import list_n8n_users
    ok, users = list_n8n_users()
    if not ok:
        raise HTTPException(status_code=502, detail="Failed to fetch n8n accounts from VPS")

    match = next((u for u in users if u["email"].lower() == email.lower()), None)
    if not match:
        return {"found": False}
    return {"found": True, **match}


@router.post("/n8n/link")
async def n8n_link(
    req: N8nLinkRequest,
    user: AuthUser = Depends(require_admin),
):
    """Link an OPAI user to an existing n8n account (no SSH needed)."""
    from n8n_provisioner import _update_opai_profile
    ok = await _update_opai_profile(req.user_id, req.n8n_email)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to update OPAI profile")
    return {"ok": True, "n8n_email": req.n8n_email}


@router.post("/n8n/sync-all")
async def n8n_sync_all(user: AuthUser = Depends(require_admin)):
    """Auto-link all OPAI users to n8n accounts by email match."""
    from n8n_provisioner import list_n8n_users, _update_opai_profile

    ok, n8n_users = list_n8n_users()
    if not ok:
        raise HTTPException(status_code=502, detail="Failed to fetch n8n accounts from VPS")

    n8n_by_email = {u["email"].lower(): u for u in n8n_users}

    results = {"linked": [], "skipped": []}

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Fetch all OPAI profiles
        opai_resp = await client.get(
            _sb_url("profiles"),
            headers=_sb_headers_service(),
            params={"select": "id,email,n8n_provisioned,n8n_username"},
        )
        if opai_resp.status_code >= 400:
            raise HTTPException(status_code=502, detail="Failed to fetch OPAI profiles")
        opai_users = opai_resp.json()

        for opai_user in opai_users:
            email = (opai_user.get("email") or "").lower()
            if not email:
                results["skipped"].append({"id": opai_user["id"], "reason": "no email"})
                continue

            if opai_user.get("n8n_provisioned"):
                results["skipped"].append({"id": opai_user["id"], "email": email, "reason": "already linked"})
                continue

            n8n_match = n8n_by_email.get(email)
            if not n8n_match:
                results["skipped"].append({"id": opai_user["id"], "email": email, "reason": "no n8n match"})
                continue

            ok = await _update_opai_profile(opai_user["id"], n8n_match["email"])
            if ok:
                results["linked"].append({"id": opai_user["id"], "email": email, "n8n_email": n8n_match["email"]})
            else:
                results["skipped"].append({"id": opai_user["id"], "email": email, "reason": "profile update failed"})

    return {
        "ok": True,
        "linked_count": len(results["linked"]),
        "skipped_count": len(results["skipped"]),
        **results,
    }


# ── BoutaByte User Association ────────────────────────────────

# BB tier "ultimate" maps to OPAI "unlimited"; all others match directly
_BB_TIER_MAP = {"ultimate": "unlimited"}


def _bb_headers():
    """Build Supabase REST headers for the BB2.0 project."""
    return {
        "apikey": config.BB_SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.BB_SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def _bb_url(path: str):
    return f"{config.BB_SUPABASE_URL}/rest/v1/{path}"


def _bb_auth_url(path: str):
    return f"{config.BB_SUPABASE_URL}/auth/v1/admin/{path}"


def _map_bb_tier(bb_tier: str) -> str:
    """Map a BB tier name to the OPAI equivalent."""
    if not bb_tier:
        return "free"
    return _BB_TIER_MAP.get(bb_tier, bb_tier)


@router.get("/bb/lookup")
async def bb_lookup(
    email: str = Query(...),
    user: AuthUser = Depends(require_admin),
):
    """Look up a BoutaByte user by email. Returns BB profile info if found."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Search BB auth users by email
        resp = await client.get(
            _bb_auth_url("users"),
            headers=_bb_headers(),
            params={"page": "1", "per_page": "50"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"BB auth lookup failed: {resp.text}")

        bb_users = resp.json().get("users", [])
        match = next((u for u in bb_users if u.get("email", "").lower() == email.lower()), None)
        if not match:
            return {"found": False}

        bb_uid = match["id"]

        # Fetch BB profile for tier info
        profile_resp = await client.get(
            _bb_url("profiles"),
            headers=_bb_headers(),
            params={"id": f"eq.{bb_uid}", "select": "id,display_name,tier,role"},
        )
        bb_profile = {}
        if profile_resp.status_code < 400:
            rows = profile_resp.json()
            if rows:
                bb_profile = rows[0]

        return {
            "found": True,
            "bb_user_id": bb_uid,
            "bb_email": match.get("email"),
            "bb_display_name": bb_profile.get("display_name", ""),
            "bb_tier": bb_profile.get("tier", "free"),
            "bb_role": bb_profile.get("role", ""),
        }


@router.post("/bb/link")
async def bb_link(
    req: BBLinkRequest,
    user: AuthUser = Depends(require_admin),
):
    """Link an OPAI user to a BB user and sync their tier."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Fetch BB profile to get tier
        profile_resp = await client.get(
            _bb_url("profiles"),
            headers=_bb_headers(),
            params={"id": f"eq.{req.bb_user_id}", "select": "id,display_name,tier"},
        )
        if profile_resp.status_code >= 400:
            raise HTTPException(status_code=502, detail="Failed to fetch BB profile")

        rows = profile_resp.json()
        if not rows:
            raise HTTPException(status_code=404, detail="BB user profile not found")

        bb_profile = rows[0]
        mapped_tier = _map_bb_tier(bb_profile.get("tier", "free"))

        # Update OPAI profile: link + sync tier
        patch_resp = await client.patch(
            _sb_url("profiles"),
            headers=_sb_headers_service(),
            params={"id": f"eq.{req.user_id}"},
            json={
                "bb_user_id": req.bb_user_id,
                "bb_linked_at": datetime.now(timezone.utc).isoformat(),
                "marketplace_tier": mapped_tier,
            },
        )
        if patch_resp.status_code >= 400:
            raise HTTPException(status_code=patch_resp.status_code, detail=patch_resp.text)

        return {
            "ok": True,
            "bb_display_name": bb_profile.get("display_name", ""),
            "bb_tier": bb_profile.get("tier", "free"),
            "synced_tier": mapped_tier,
        }


@router.post("/bb/sync-all")
async def bb_sync_all(user: AuthUser = Depends(require_admin)):
    """Auto-link all OPAI users to BB by email match and sync tiers."""
    results = {"linked": [], "skipped": [], "failed": []}

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Fetch all OPAI profiles
        opai_resp = await client.get(
            _sb_url("profiles"),
            headers=_sb_headers_service(),
            params={"select": "id,email,bb_user_id"},
        )
        if opai_resp.status_code >= 400:
            raise HTTPException(status_code=502, detail="Failed to fetch OPAI profiles")
        opai_users = opai_resp.json()

        # Fetch all BB auth users
        bb_resp = await client.get(
            _bb_auth_url("users"),
            headers=_bb_headers(),
            params={"page": "1", "per_page": "500"},
        )
        if bb_resp.status_code >= 400:
            raise HTTPException(status_code=502, detail="Failed to fetch BB users")
        bb_users = bb_resp.json().get("users", [])
        bb_by_email = {u["email"].lower(): u for u in bb_users if u.get("email")}

        for opai_user in opai_users:
            email = (opai_user.get("email") or "").lower()
            if not email:
                results["skipped"].append({"id": opai_user["id"], "reason": "no email"})
                continue

            if opai_user.get("bb_user_id"):
                # Already linked — still sync tier
                bb_uid = opai_user["bb_user_id"]
            else:
                bb_match = bb_by_email.get(email)
                if not bb_match:
                    results["skipped"].append({"id": opai_user["id"], "email": email, "reason": "no BB match"})
                    continue
                bb_uid = bb_match["id"]

            # Fetch BB profile for tier
            try:
                profile_resp = await client.get(
                    _bb_url("profiles"),
                    headers=_bb_headers(),
                    params={"id": f"eq.{bb_uid}", "select": "id,display_name,tier"},
                )
                if profile_resp.status_code >= 400:
                    results["failed"].append({"id": opai_user["id"], "email": email, "error": "BB profile fetch failed"})
                    continue

                rows = profile_resp.json()
                bb_tier = rows[0].get("tier", "free") if rows else "free"
                mapped_tier = _map_bb_tier(bb_tier)

                patch_resp = await client.patch(
                    _sb_url("profiles"),
                    headers=_sb_headers_service(),
                    params={"id": f"eq.{opai_user['id']}"},
                    json={
                        "bb_user_id": bb_uid,
                        "bb_linked_at": datetime.now(timezone.utc).isoformat(),
                        "marketplace_tier": mapped_tier,
                    },
                )
                if patch_resp.status_code >= 400:
                    results["failed"].append({"id": opai_user["id"], "email": email, "error": patch_resp.text})
                    continue

                results["linked"].append({"id": opai_user["id"], "email": email, "bb_tier": bb_tier, "synced_tier": mapped_tier})
            except Exception as e:
                results["failed"].append({"id": opai_user["id"], "email": email, "error": str(e)})

    return {
        "ok": True,
        "linked_count": len(results["linked"]),
        "skipped_count": len(results["skipped"]),
        "failed_count": len(results["failed"]),
        **results,
    }


# ── Webhook Sync Trigger ─────────────────────────────────────

@router.post("/sync/webhook")
async def webhook_sync(request: Request):
    """Event-driven catalog sync triggered by BB2.0 Supabase Database Webhook.

    Secured via HMAC-SHA256 signature in X-Webhook-Secret header.
    Called by an n8n workflow on the BoutaByte VPS whenever sub_apps,
    n8n_automations, wp_plugins, or mobile_apps tables change.
    """
    # Verify webhook secret
    if config.SYNC_WEBHOOK_SECRET:
        secret = request.headers.get("x-webhook-secret", "")
        if not hmac.compare_digest(secret, config.SYNC_WEBHOOK_SECRET):
            raise HTTPException(status_code=403, detail="Invalid webhook secret")

    from sync_products import run_sync
    try:
        await run_sync()
        return {"ok": True, "message": "Catalog sync triggered by webhook"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
