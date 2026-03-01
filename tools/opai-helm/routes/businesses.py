"""HELM — Business CRUD and dashboard routes."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from slugify import slugify

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user, require_admin

import config
from core.supabase import _sb_get, _sb_post, _sb_patch

log = logging.getLogger("helm.routes.businesses")
router = APIRouter()


# -- Access check --

async def _check_access(user: AuthUser, business_id: str) -> bool:
    """Check if user has access to a business (via helm_business_access or admin)."""
    if user.is_admin:
        return True
    rows = await _sb_get(
        f"helm_business_access?business_id=eq.{business_id}&user_id=eq.{user.id}&select=id"
    )
    return bool(rows)


# -- Request models --

class BusinessCreate(BaseModel):
    name: str
    industry: Optional[str] = None


class BusinessUpdate(BaseModel):
    name: Optional[str] = None
    industry: Optional[str] = None
    stage: Optional[str] = None
    tagline: Optional[str] = None
    description: Optional[str] = None
    tone_of_voice: Optional[str] = None
    brand_voice_notes: Optional[str] = None
    never_say: Optional[List[str]] = None
    target_audience: Optional[str] = None
    value_proposition: Optional[str] = None
    primary_goal: Optional[str] = None
    pain_points: Optional[str] = None
    revenue_model: Optional[str] = None
    goals_3mo: Optional[str] = None
    goals_6mo: Optional[str] = None
    goals_12mo: Optional[str] = None
    content_pillars: Optional[str] = None
    avoid_topics: Optional[str] = None
    website: Optional[str] = None
    brand_color_primary: Optional[str] = None
    autonomy_level: Optional[int] = None
    monthly_revenue_target: Optional[float] = None
    monthly_lead_target: Optional[int] = None
    products: Optional[List[dict]] = None
    competitors: Optional[List[dict]] = None


# -- Endpoints --

@router.get("/api/businesses")
async def list_businesses(user: AuthUser = Depends(get_current_user)):
    """List businesses the current user has access to.

    Returns:
        {
          "businesses": [...],          # active (is_active=True)
          "pending_onboarding": [...],  # in-progress, not yet launched
        }
    """
    if user.is_admin:
        active = await _sb_get(
            "helm_businesses?is_active=eq.true&order=name.asc&select=*"
        ) or []
        return {"businesses": active, "pending_onboarding": []}

    access_rows = await _sb_get(
        f"helm_business_access?user_id=eq.{user.id}&select=business_id"
    )
    if not access_rows:
        return {"businesses": [], "pending_onboarding": []}

    ids = ",".join(r["business_id"] for r in access_rows)

    # Active businesses (launched)
    active = await _sb_get(
        f"helm_businesses?id=in.({ids})&is_active=eq.true&order=name.asc&select=*"
    ) or []

    # Inactive businesses (onboarding in progress — created but not launched yet)
    inactive = await _sb_get(
        f"helm_businesses?id=in.({ids})&is_active=eq.false&order=created_at.desc&select=id,name,slug,industry,stage,created_at"
    ) or []

    # For each inactive business, fetch their incomplete onboarding record
    pending_onboarding = []
    for biz in inactive:
        ob_rows = await _sb_get(
            f"helm_business_onboarding?business_id=eq.{biz['id']}"
            f"&completed_at=is.null&order=created_at.desc&limit=1"
            f"&select=id,current_step,created_at,step_data"
        )
        if ob_rows:
            ob = ob_rows[0]
            pending_onboarding.append({
                "business_id": biz["id"],
                "business_name": biz["name"],
                "business_slug": biz["slug"],
                "industry": biz.get("industry"),
                "onboarding_id": ob["id"],
                "current_step": ob.get("current_step") or 1,
                "started_at": ob.get("created_at"),
                "step_data": ob.get("step_data") or {},
            })

    return {"businesses": active, "pending_onboarding": pending_onboarding}


@router.post("/api/businesses")
async def create_business(body: BusinessCreate, user: AuthUser = Depends(get_current_user)):
    """Create a new business. Auto-generates slug from name."""
    slug = slugify(body.name)

    payload = {
        "name": body.name,
        "slug": slug,
        "is_active": True,
        "owner_id": user.id,
    }
    if body.industry:
        payload["industry"] = body.industry

    result = await _sb_post("helm_businesses", payload)
    business = result[0] if isinstance(result, list) else result
    business_id = business.get("id")

    # Auto-create owner access
    if business_id:
        await _sb_post("helm_business_access", {
            "business_id": business_id,
            "user_id": user.id,
            "role": "owner",
        }, upsert=True, on_conflict="business_id,user_id")

    return business


@router.get("/api/businesses/{business_id}")
async def get_business(business_id: str, user: AuthUser = Depends(get_current_user)):
    """Get full business profile."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(f"helm_businesses?id=eq.{business_id}&select=*")
    if not rows:
        raise HTTPException(404, "Business not found")

    return rows[0]


@router.patch("/api/businesses/{business_id}")
async def update_business(
    business_id: str,
    body: BusinessUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update business profile."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")

    result = await _sb_patch(f"helm_businesses?id=eq.{business_id}", update)
    return result[0] if isinstance(result, list) and result else update


@router.delete("/api/businesses/{business_id}")
async def delete_business(business_id: str, user: AuthUser = Depends(get_current_user)):
    """Soft delete business (set is_active=false)."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    await _sb_patch(f"helm_businesses?id=eq.{business_id}", {"is_active": False})
    return {"deleted": True}


@router.get("/api/businesses/{business_id}/settings")
async def get_business_settings(business_id: str, user: AuthUser = Depends(get_current_user)):
    """Get full business settings: profile + onboarding step_data + social + credentials."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(f"helm_businesses?id=eq.{business_id}&select=*")
    if not rows:
        raise HTTPException(404, "Business not found")
    business = rows[0]

    # Onboarding step_data (stores extra fields: goals, products, competitors, etc.)
    ob_rows = await _sb_get(
        f"helm_business_onboarding?business_id=eq.{business_id}&select=step_data,completed_at,current_step"
    )
    step_data = {}
    onboarding_meta = {}
    if ob_rows:
        step_data = ob_rows[0].get("step_data") or {}
        onboarding_meta = {
            "completed_at": ob_rows[0].get("completed_at"),
            "current_step": ob_rows[0].get("current_step"),
        }

    # Social accounts — pull from credential_refs for social platforms (source of truth)
    # Also merge in social_accounts rows (which have handle/followers data when available)
    SOCIAL_PLATFORMS = ("twitter", "linkedin", "instagram", "facebook", "tiktok", "youtube", "pinterest")
    social_cred_rows = await _sb_get(
        f"helm_business_credential_refs?business_id=eq.{business_id}"
        f"&service=in.({','.join(SOCIAL_PLATFORMS)})&is_active=eq.true"
        f"&select=id,service,label,last_verified_at"
    )
    sa_rows = await _sb_get(
        f"helm_business_social_accounts?business_id=eq.{business_id}&is_active=eq.true"
        f"&select=id,platform,handle,followers_count,auto_post_enabled"
    )
    # Build a handle lookup by platform
    sa_by_platform = {r["platform"]: r for r in (sa_rows or [])}
    social_rows = []
    for cr in (social_cred_rows or []):
        plat = cr["service"]
        sa = sa_by_platform.get(plat)
        social_rows.append({
            "id": cr["id"],
            "platform": plat,
            "label": cr.get("label") or f"{plat} account",
            "handle": sa["handle"] if sa else None,
            "followers_count": sa.get("followers_count") if sa else None,
            "auto_post_enabled": sa.get("auto_post_enabled") if sa else False,
            "last_verified_at": cr.get("last_verified_at"),
            "status": "connected" if cr.get("last_verified_at") else "pending",
        })

    # Credential refs (non-social: website, stripe, other services)
    cred_rows = await _sb_get(
        f"helm_business_credential_refs?business_id=eq.{business_id}&is_active=eq.true"
        f"&service=not.in.({','.join(SOCIAL_PLATFORMS)})&select=id,service,label,credential_type,last_verified_at"
    )

    # Schedules — auto-seed if none exist, include id for update operations
    schedule_rows = await _sb_get(
        f"helm_business_schedule?business_id=eq.{business_id}&order=job_type.asc&select=id,job_type,cron_expr,enabled,next_run_at,last_run_at,run_count,fail_count"
    )
    if not schedule_rows:
        from routes.schedule import seed_schedules
        await seed_schedules(business_id)
        schedule_rows = await _sb_get(
            f"helm_business_schedule?business_id=eq.{business_id}&order=job_type.asc&select=id,job_type,cron_expr,enabled,next_run_at,last_run_at,run_count,fail_count"
        )

    return {
        "business": business,
        "step_data": step_data,
        "onboarding": onboarding_meta,
        "social_accounts": social_rows or [],
        "credentials": cred_rows or [],
        "schedules": schedule_rows or [],
    }


@router.patch("/api/businesses/{business_id}/settings")
async def update_business_settings(
    business_id: str,
    body: BusinessUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update business profile (extended fields included)."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    update = body.model_dump(exclude_none=True)
    if update:
        await _sb_patch(f"helm_businesses?id=eq.{business_id}", update)

    # Always return the full refreshed row so the frontend stays in sync
    rows = await _sb_get(f"helm_businesses?id=eq.{business_id}&select=*")
    return rows[0] if rows else {}


@router.get("/api/businesses/{business_id}/dashboard")
async def get_dashboard(business_id: str, user: AuthUser = Depends(get_current_user)):
    """Get business dashboard with all KPIs."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(f"helm_businesses?id=eq.{business_id}&select=*")
    if not rows:
        raise HTTPException(404, "Business not found")
    business = rows[0]

    # Social accounts (from credential refs — only columns that exist)
    social_rows = await _sb_get(
        f"helm_business_credential_refs?business_id=eq.{business_id}"
        f"&service=in.(twitter,linkedin,instagram,facebook,tiktok,youtube)"
        f"&is_active=eq.true&select=id,service,label,last_verified_at"
    )
    social = [
        {
            "platform": r.get("service"),
            "display_name": r.get("label"),
            "status": "connected" if r.get("last_verified_at") else "pending",
            "followers": None,
            "engagement": None,
            "last_post_at": r.get("last_verified_at"),
        }
        for r in (social_rows or [])
    ]

    # Content queue — draft/review/scheduled items for display (last 20)
    content_queue = await _sb_get(
        f"helm_business_content?business_id=eq.{business_id}"
        f"&status=in.(draft,review,approved,scheduled)&order=created_at.desc&limit=20"
        f"&select=id,content_type,title,excerpt,platform,status,scheduled_at,created_at"
    )

    # Recent actions (last 10)
    recent_actions = await _sb_get(
        f"helm_business_actions?business_id=eq.{business_id}"
        f"&order=created_at.desc&limit=10&select=*"
    )

    # HITL pending items (full rows for preview cards)
    hitl_pending = await _sb_get(
        f"helm_business_hitl_queue?business_id=eq.{business_id}"
        f"&status=eq.pending&order=created_at.desc"
        f"&select=id,action_type,title,description,risk_level,expires_at,execution_payload"
    )

    # Goals list
    goals = await _sb_get(
        f"helm_business_goals?business_id=eq.{business_id}"
        f"&order=created_at.desc&select=*"
    )

    # Build stats block for KPI cards
    stats = {
        "health_score": 75,
        "mrr": None,
        "revenue_month": None,
        "new_subs": None,
        "churn": None,
    }

    return {
        "business": business,
        "stats": stats,
        "social": social,
        "content_queue": content_queue or [],
        "recent_actions": recent_actions or [],
        "hitl_pending": hitl_pending or [],
        "goals": goals or [],
    }


@router.post("/api/businesses/{business_id}/schedule/{job_type}/trigger")
async def trigger_job_now(
    business_id: str,
    job_type: str,
    user: AuthUser = Depends(get_current_user),
):
    """Force a scheduled job to run on next scheduler tick by setting next_run_at to now."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    rows = await _sb_get(
        f"helm_business_schedule?business_id=eq.{business_id}&job_type=eq.{job_type}&select=id"
    )
    if not rows:
        raise HTTPException(404, f"No schedule found for job_type={job_type}")

    from datetime import datetime, timezone
    now_z = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
    await _sb_patch(
        f"helm_business_schedule?business_id=eq.{business_id}&job_type=eq.{job_type}",
        {"next_run_at": now_z},
    )
    return {"triggered": True, "job_type": job_type}


class SocialHandleUpdate(BaseModel):
    platform: str
    handle: str


@router.patch("/api/businesses/{business_id}/social-accounts/handle")
async def set_social_handle(
    business_id: str,
    body: SocialHandleUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Set or update the handle for a social platform account."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    # Get the credential_ref vault_key for this platform
    cred = await _sb_get(
        f"helm_business_credential_refs?business_id=eq.{business_id}&service=eq.{body.platform}&is_active=eq.true&select=vault_key"
    )
    vault_key = cred[0]["vault_key"] if cred else None

    await _sb_post("helm_business_social_accounts", {
        "business_id": business_id,
        "platform": body.platform,
        "handle": body.handle,
        "credentials_ref": vault_key,
        "is_active": True,
    }, upsert=True, on_conflict="business_id,platform,handle")
    return {"saved": True, "platform": body.platform, "handle": body.handle}


@router.delete("/api/businesses/{business_id}/social-accounts/{platform}")
async def remove_social_account(
    business_id: str,
    platform: str,
    user: AuthUser = Depends(get_current_user),
):
    """Soft-delete a social account by platform — disables both credential_ref and social_accounts row."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    # Disable credential ref
    await _sb_patch(
        f"helm_business_credential_refs?business_id=eq.{business_id}&service=eq.{platform}",
        {"is_active": False},
    )
    # Disable social_accounts row if it exists
    await _sb_patch(
        f"helm_business_social_accounts?business_id=eq.{business_id}&platform=eq.{platform}",
        {"is_active": False},
    )
    return {"removed": True}


@router.get("/api/businesses/{business_id}/content/{content_id}")
async def get_content_item(
    business_id: str,
    content_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Fetch full content text from helm_business_content."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    rows = await _sb_get(
        f"helm_business_content?id=eq.{content_id}&business_id=eq.{business_id}&select=id,content_type,platform,title,body,status,created_at"
    )
    if not rows:
        raise HTTPException(404, "Content not found")
    row = rows[0]
    # Normalise: expose body as content_text for the frontend
    row["content_text"] = row.get("body", "")
    return row


@router.get("/api/businesses/{business_id}/report/{report_id}")
async def get_report_item(
    business_id: str,
    report_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Fetch full report content from helm_business_reports."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    rows = await _sb_get(
        f"helm_business_reports?id=eq.{report_id}&business_id=eq.{business_id}&select=id,report_type,title,content,period_start,period_end,status,created_at"
    )
    if not rows:
        raise HTTPException(404, "Report not found")
    return rows[0]


class ContentUpdate(BaseModel):
    body: Optional[str] = None
    title: Optional[str] = None
    status: Optional[str] = None


@router.patch("/api/businesses/{business_id}/content/{content_id}")
async def update_content_item(
    business_id: str,
    content_id: str,
    payload: ContentUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update editable fields of a content draft."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    updates = {k: v for k, v in payload.dict().items() if v is not None}
    if not updates:
        raise HTTPException(400, "No fields to update")
    from datetime import datetime, timezone
    updates["updated_at"] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
    await _sb_patch(
        f"helm_business_content?id=eq.{content_id}&business_id=eq.{business_id}",
        updates,
    )
    return {"updated": True}


class ContentFeedback(BaseModel):
    resource_id: str
    resource_type: str  # 'content' or 'report'
    feedback_text: str


@router.post("/api/businesses/{business_id}/content-feedback")
async def log_content_feedback(
    business_id: str,
    payload: ContentFeedback,
    user: AuthUser = Depends(get_current_user),
):
    """Log user feedback for a content or report item — used to tune next generation."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    from core.hitl import log_action
    await log_action(
        business_id=business_id,
        action_type="content_feedback",
        summary=f"Feedback on {payload.resource_type} {payload.resource_id[:8]}…",
        detail=payload.feedback_text,
        status="success",
        resource_type=payload.resource_type,
        resource_id=payload.resource_id,
    )
    return {"logged": True}


# ── WordPress Connection ──────────────────────────────────────────────────────

class WPConnectionCreate(BaseModel):
    site_name:        str = "WordPress Site"
    site_url:         str
    username:         str
    app_password:     str
    default_status:   str = "draft"
    default_category: Optional[str] = None


class WPConnectionUpdate(BaseModel):
    site_name:        Optional[str] = None
    site_url:         Optional[str] = None
    username:         Optional[str] = None
    app_password:     Optional[str] = None
    default_status:   Optional[str] = None
    default_category: Optional[str] = None
    is_active:        Optional[bool] = None


@router.get("/api/businesses/{business_id}/wp-connections")
async def list_wp_connections(
    business_id: str,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    rows = await _sb_get(
        f"helm_wp_connections?business_id=eq.{business_id}&is_active=eq.true"
        f"&order=created_at.asc&select=id,site_name,site_url,username,default_status,last_tested_at,last_test_ok"
    )
    return rows or []


@router.post("/api/businesses/{business_id}/wp-connections")
async def create_wp_connection(
    business_id: str,
    payload: WPConnectionCreate,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    row = await _sb_post("helm_wp_connections", {
        "business_id":     business_id,
        "site_name":       payload.site_name,
        "site_url":        payload.site_url.rstrip("/"),
        "username":        payload.username,
        "app_password":    payload.app_password,
        "default_status":  payload.default_status,
        "default_category": payload.default_category,
    }, upsert=True, on_conflict="business_id")
    created = row[0] if isinstance(row, list) else row
    return created


@router.post("/api/businesses/{business_id}/wp-connections/{conn_id}/test")
async def test_wp_connection(
    business_id: str,
    conn_id: str,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    rows = await _sb_get(
        f"helm_wp_connections?id=eq.{conn_id}&business_id=eq.{business_id}&select=*"
    )
    if not rows:
        raise HTTPException(404, "WP connection not found")
    conn = rows[0]

    from connectors.wordpress import WordPressConnector
    from datetime import datetime, timezone
    wp = WordPressConnector(conn["site_url"], conn["username"], conn["app_password"])
    result = await wp.test_connection()

    now_z = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
    await _sb_patch(
        f"helm_wp_connections?id=eq.{conn_id}",
        {"last_tested_at": now_z, "last_test_ok": result.get("ok", False)},
    )
    return result


@router.delete("/api/businesses/{business_id}/wp-connections/{conn_id}")
async def delete_wp_connection(
    business_id: str,
    conn_id: str,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    await _sb_patch(
        f"helm_wp_connections?id=eq.{conn_id}&business_id=eq.{business_id}",
        {"is_active": False},
    )
    return {"removed": True}


class WPPushRequest(BaseModel):
    connection_id: Optional[str] = None


@router.post("/api/businesses/{business_id}/content/{content_id}/push-to-wp")
async def push_content_to_wp(
    business_id: str,
    content_id: str,
    payload: WPPushRequest = WPPushRequest(),
    user: AuthUser = Depends(get_current_user),
):
    """Push an approved content item to the connected WordPress site as a draft post."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    # Load content
    content_rows = await _sb_get(
        f"helm_business_content?id=eq.{content_id}&business_id=eq.{business_id}&select=*"
    )
    if not content_rows:
        raise HTTPException(404, "Content not found")
    content = content_rows[0]

    if content.get("status") not in ("approved", "draft"):
        raise HTTPException(400, f"Content status is '{content.get('status')}' — approve it first")

    # Load WP connection — use specified connection_id or fall back to first active
    if payload.connection_id:
        wp_rows = await _sb_get(
            f"helm_wp_connections?id=eq.{payload.connection_id}&business_id=eq.{business_id}&select=*"
        )
    else:
        wp_rows = await _sb_get(
            f"helm_wp_connections?business_id=eq.{business_id}&is_active=eq.true&limit=1&select=*"
        )
    if not wp_rows:
        raise HTTPException(400, "No WordPress connection configured for this business")
    conn = wp_rows[0]

    from connectors.wordpress import WordPressConnector
    from core.hitl import log_action
    from datetime import datetime, timezone

    wp = WordPressConnector(conn["site_url"], conn["username"], conn["app_password"])

    body = content.get("body", "") or ""
    title = content.get("title", "Untitled")
    push_status = conn.get("default_status", "draft")

    try:
        result = await wp.push_markdown_post(
            title=title,
            body_markdown=body,
            status=push_status,
        )
    except Exception as exc:
        raise HTTPException(502, f"WordPress push failed: {exc}")

    # Store WP post details back on the content row
    now_z = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
    new_status = "published" if push_status == "publish" else "wp_draft"
    await _sb_patch(
        f"helm_business_content?id=eq.{content_id}",
        {
            "external_id":   str(result["wp_post_id"]),
            "published_url": result["link"] or result["edit_link"],
            "status":        new_status,
            "updated_at":    now_z,
            **({"published_at": now_z} if push_status == "publish" else {}),
        },
    )

    await log_action(
        business_id=business_id,
        action_type="wp_publish",
        summary=f'Pushed to WordPress: "{title}" — {push_status}',
        detail=result["edit_link"],
        status="success",
        resource_type="content",
        resource_id=content_id,
    )

    return {
        "pushed": True,
        "wp_post_id": result["wp_post_id"],
        "edit_link":  result["edit_link"],
        "link":       result["link"],
        "wp_status":  result["status"],
    }


# ── Netlify / GitHub Connection ───────────────────────────────────────────────

class NetlifyConnectionCreate(BaseModel):
    site_name:      str = "Netlify Site"
    github_repo:    str          # "owner/repo"
    github_branch:  str = "main"
    github_token:   str
    content_path:   str = "content/posts"
    netlify_site_id: Optional[str] = None


class NetlifyPushRequest(BaseModel):
    connection_id: Optional[str] = None


@router.get("/api/businesses/{business_id}/netlify-connections")
async def list_netlify_connections(
    business_id: str,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    rows = await _sb_get(
        f"helm_netlify_connections?business_id=eq.{business_id}&is_active=eq.true&select=id,site_name,github_repo,github_branch,content_path,netlify_site_id,last_tested_at,last_test_ok"
    )
    return rows or []


@router.post("/api/businesses/{business_id}/netlify-connections")
async def create_netlify_connection(
    business_id: str,
    payload: NetlifyConnectionCreate,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    row = await _sb_post("helm_netlify_connections", {
        "business_id":    business_id,
        "site_name":      payload.site_name,
        "github_repo":    payload.github_repo.strip(),
        "github_branch":  payload.github_branch.strip() or "main",
        "github_token":   payload.github_token.strip(),
        "content_path":   payload.content_path.strip().strip("/") or "content/posts",
        "netlify_site_id": payload.netlify_site_id or None,
    }, upsert=True, on_conflict="business_id")
    return row


@router.post("/api/businesses/{business_id}/netlify-connections/{conn_id}/test")
async def test_netlify_connection(
    business_id: str,
    conn_id: str,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    rows = await _sb_get(
        f"helm_netlify_connections?id=eq.{conn_id}&business_id=eq.{business_id}&select=*"
    )
    if not rows:
        raise HTTPException(404, "Connection not found")
    conn = rows[0]

    from connectors.github import GitHubConnector
    from datetime import datetime, timezone

    gh = GitHubConnector(conn["github_token"], conn["github_repo"], conn["github_branch"])
    result = await gh.test_connection()

    now_z = datetime.now(timezone.utc).isoformat()
    await _sb_patch(
        f"helm_netlify_connections?id=eq.{conn_id}",
        {"last_tested_at": now_z, "last_test_ok": result["ok"]},
    )
    return result


@router.delete("/api/businesses/{business_id}/netlify-connections/{conn_id}")
async def delete_netlify_connection(
    business_id: str,
    conn_id: str,
    user: AuthUser = Depends(get_current_user),
):
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    await _sb_patch(
        f"helm_netlify_connections?id=eq.{conn_id}&business_id=eq.{business_id}",
        {"is_active": False},
    )
    return {"deleted": True}


@router.post("/api/businesses/{business_id}/content/{content_id}/push-to-netlify")
async def push_content_to_netlify(
    business_id: str,
    content_id: str,
    payload: NetlifyPushRequest = NetlifyPushRequest(),
    user: AuthUser = Depends(get_current_user),
):
    """Push an approved content item to GitHub — Netlify auto-deploys from the new commit."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")

    # Load content
    content_rows = await _sb_get(
        f"helm_business_content?id=eq.{content_id}&business_id=eq.{business_id}&select=*"
    )
    if not content_rows:
        raise HTTPException(404, "Content not found")
    content = content_rows[0]

    if content.get("status") not in ("approved", "draft"):
        raise HTTPException(400, f"Content status is '{content.get('status')}' — approve it first")

    # Load Netlify/GitHub connection
    if payload.connection_id:
        conn_rows = await _sb_get(
            f"helm_netlify_connections?id=eq.{payload.connection_id}&business_id=eq.{business_id}&select=*"
        )
    else:
        conn_rows = await _sb_get(
            f"helm_netlify_connections?business_id=eq.{business_id}&is_active=eq.true&limit=1&select=*"
        )
    if not conn_rows:
        raise HTTPException(400, "No Netlify/GitHub connection configured for this business")
    conn = conn_rows[0]

    from connectors.github import GitHubConnector
    from core.hitl import log_action
    from datetime import datetime, timezone

    gh = GitHubConnector(
        token=conn["github_token"],
        repo=conn["github_repo"],
        branch=conn["github_branch"],
    )

    title = content.get("title", "Untitled")
    body = content.get("body", "") or ""
    content_dir = conn.get("content_path", "content/posts")

    try:
        result = await gh.push_markdown_post(
            title=title,
            body_markdown=body,
            content_dir=content_dir,
        )
    except Exception as exc:
        raise HTTPException(502, f"GitHub commit failed: {exc}")

    # Update content row
    now_z = datetime.now(timezone.utc).isoformat()
    await _sb_patch(
        f"helm_business_content?id=eq.{content_id}",
        {
            "external_id":   result["sha"][:12],
            "published_url": result["html_url"],
            "status":        "netlify_committed",
            "updated_at":    now_z,
        },
    )

    await log_action(
        business_id=business_id,
        action_type="netlify_push",
        summary=f'Committed to GitHub: "{title}" → {conn["github_repo"]}/{result["path"]}',
        detail=result["html_url"],
        status="success",
        resource_type="content",
        resource_id=content_id,
    )

    return {
        "pushed": True,
        "sha":      result["sha"],
        "path":     result["path"],
        "html_url": result["html_url"],
        "repo":     conn["github_repo"],
        "branch":   conn["github_branch"],
    }


@router.delete("/api/businesses/{business_id}/credentials/{cred_id}")
async def remove_credential(
    business_id: str,
    cred_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Soft-delete a credential ref (set is_active=false)."""
    if not await _check_access(user, business_id):
        raise HTTPException(403, "Access denied")
    await _sb_patch(
        f"helm_business_credential_refs?id=eq.{cred_id}&business_id=eq.{business_id}",
        {"is_active": False},
    )
    return {"removed": True}
