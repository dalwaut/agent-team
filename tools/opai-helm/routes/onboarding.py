"""HELM — Onboarding wizard endpoints."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from slugify import slugify

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config
from core.supabase import _sb_get, _sb_post, _sb_patch
from core.vault import store_credential
from core.ai import call_claude

log = logging.getLogger("helm.routes.onboarding")
router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".md", ".txt"}
UPLOADS_DIR = config.DATA_DIR / "uploads"
TEMPLATE_PATH = Path("/workspace/synced/opai/Templates/helm-business-brief.md")


# ── Request models ──────────────────────────────────────────────────────────

class WebsiteStep(BaseModel):
    platform: str
    site_url: Optional[str] = None
    username: Optional[str] = None
    app_password: Optional[str] = None


class SocialStep(BaseModel):
    platform: str
    credentials: dict


class StripeStep(BaseModel):
    stripe_api_key: str
    stripe_webhook_secret: Optional[str] = None
    publishable_key: Optional[str] = None


class AccountCheck(BaseModel):
    platform: str


class ConfirmProfile(BaseModel):
    profile: dict


class StepAdvance(BaseModel):
    step: int


# ── Helpers ─────────────────────────────────────────────────────────────────

async def _get_onboarding_and_check(onboarding_id: str, user: AuthUser) -> dict:
    """Fetch onboarding row and verify user has access to the business."""
    ob_rows = await _sb_get(
        f"helm_business_onboarding?id=eq.{onboarding_id}&select=*"
    )
    if not ob_rows:
        raise HTTPException(404, "Onboarding not found")
    ob = ob_rows[0]

    if not user.is_admin:
        access = await _sb_get(
            f"helm_business_access?business_id=eq.{ob['business_id']}"
            f"&user_id=eq.{user.id}&select=role"
        )
        if not access:
            raise HTTPException(403, "Access denied")

    return ob


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/api/onboarding/template")
async def download_template():
    """Download the HELM Business Brief template as a Markdown file."""
    if not TEMPLATE_PATH.exists():
        raise HTTPException(404, "Template not found")
    return FileResponse(
        path=str(TEMPLATE_PATH),
        filename="HELM-Business-Brief-Template.md",
        media_type="text/markdown",
    )


@router.post("/api/onboarding")
async def start_onboarding(
    # File/text upload mode fields
    file: Optional[UploadFile] = File(None),
    text_content: Optional[str] = Form(None),
    # Form mode fields (sent as JSON via apiFetch sets Content-Type: application/json)
    user: AuthUser = Depends(get_current_user),
):
    """
    Unified Step 1 endpoint. Accepts either:
      - FormData with optional file + text_content (upload mode)
      - JSON body with name/industry/pitch etc. (form mode) — handled by start_onboarding_json below
    Creates business stub + onboarding record, saves any uploaded content.
    """
    # Derive a business name from uploaded content or use a placeholder
    name = "New Business"
    if text_content:
        # Try to extract first line as name
        first_line = text_content.strip().split("\n")[0].strip("#").strip()
        if first_line:
            name = first_line[:80]

    slug_base = slugify(name) or "business"
    # Ensure unique slug
    slug = slug_base
    existing = await _sb_get(f"helm_businesses?slug=eq.{slug}&select=id")
    if existing:
        import uuid as _uuid
        slug = f"{slug_base}-{str(_uuid.uuid4())[:8]}"

    # Create business stub (is_active=False until launch)
    biz_result = await _sb_post("helm_businesses", {
        "name": name,
        "slug": slug,
        "industry": "Other",
        "is_active": False,
        "owner_id": user.id,
    })
    business = biz_result[0] if isinstance(biz_result, list) else biz_result
    business_id = business["id"]

    # Grant owner access
    await _sb_post("helm_business_access", {
        "business_id": business_id,
        "user_id": user.id,
        "role": "owner",
    }, upsert=True, on_conflict="business_id,user_id")

    # Create onboarding record
    ob_result = await _sb_post("helm_business_onboarding", {
        "business_id": business_id,
        "current_step": 1,
    }, upsert=True, on_conflict="business_id")
    ob = ob_result[0] if isinstance(ob_result, list) else ob_result
    onboarding_id = ob["id"]

    # Save any uploaded content
    if file or text_content:
        upload_dir = UPLOADS_DIR / onboarding_id
        upload_dir.mkdir(parents=True, exist_ok=True)

        if file and file.filename:
            ext = Path(file.filename).suffix.lower()
            if ext not in ALLOWED_EXTENSIONS:
                raise HTTPException(400, f"Unsupported file type: {ext}")
            content = await file.read()
            (upload_dir / file.filename).write_bytes(content)
            log.info("Saved upload: %s (%d bytes)", file.filename, len(content))

        if text_content:
            (upload_dir / "brief.txt").write_text(text_content, encoding="utf-8")
            log.info("Saved text brief (%d chars)", len(text_content))

    return {
        "business_id": business_id,
        "onboarding_id": onboarding_id,
        "step": 1,
    }


@router.post("/api/onboarding/form")
async def start_onboarding_form(
    body: dict,
    user: AuthUser = Depends(get_current_user),
):
    """
    Form mode: JSON body with name, industry, business_type, pitch, target_audience.
    Creates business stub + onboarding record.
    """
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Business name is required")

    slug_base = slugify(name) or "business"
    slug = slug_base
    existing = await _sb_get(f"helm_businesses?slug=eq.{slug}&select=id")
    if existing:
        import uuid as _uuid
        slug = f"{slug_base}-{str(_uuid.uuid4())[:8]}"

    biz_result = await _sb_post("helm_businesses", {
        "name": name,
        "slug": slug,
        "industry": body.get("industry") or "Other",
        "is_active": False,
        "owner_id": user.id,
        "target_audience": body.get("target_audience") or None,
        "description": body.get("pitch") or None,
    })
    business = biz_result[0] if isinstance(biz_result, list) else biz_result
    business_id = business["id"]

    await _sb_post("helm_business_access", {
        "business_id": business_id,
        "user_id": user.id,
        "role": "owner",
    }, upsert=True, on_conflict="business_id,user_id")

    # Map known fields to business columns directly
    biz_update = {}
    if body.get("value_proposition"):
        biz_update["value_proposition"] = body["value_proposition"]
    if body.get("tone_of_voice"):
        biz_update["tone_of_voice"] = body["tone_of_voice"]
    if body.get("goal_90_day"):
        biz_update["primary_goal"] = body["goal_90_day"]
    if biz_update:
        await _sb_patch(f"helm_businesses?id=eq.{business_id}", biz_update)

    ob_result = await _sb_post("helm_business_onboarding", {
        "business_id": business_id,
        "current_step": 1,
        "step_data": {"form": body},
    }, upsert=True, on_conflict="business_id")
    ob = ob_result[0] if isinstance(ob_result, list) else ob_result

    return {
        "business_id": business_id,
        "onboarding_id": ob["id"],
        "step": 1,
    }


@router.post("/api/onboarding/{onboarding_id}/upload")
async def upload_document(
    onboarding_id: str,
    file: Optional[UploadFile] = File(None),
    text_body: Optional[str] = Form(None),
    user: AuthUser = Depends(get_current_user),
):
    """Accept additional file upload or text for an existing onboarding session."""
    ob = await _get_onboarding_and_check(onboarding_id, user)

    upload_dir = UPLOADS_DIR / onboarding_id
    upload_dir.mkdir(parents=True, exist_ok=True)

    if file and file.filename:
        ext = Path(file.filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(400, f"Unsupported file type: {ext}")
        content = await file.read()
        (upload_dir / file.filename).write_bytes(content)

    elif text_body:
        (upload_dir / "brief.txt").write_text(text_body, encoding="utf-8")

    else:
        raise HTTPException(400, "Provide either a file or text_body")

    return {"file_saved": True}


@router.get("/api/onboarding/{onboarding_id}/parse")
async def parse_document(
    onboarding_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """SSE: stream parse progress then return extracted JSON."""
    ob = await _get_onboarding_and_check(onboarding_id, user)

    upload_dir = UPLOADS_DIR / onboarding_id

    # Build file content from uploads (if any)
    file_content = ""
    if upload_dir.exists():
        for f in upload_dir.iterdir():
            if f.suffix.lower() in (".txt", ".md"):
                file_content += f.read_text(encoding="utf-8", errors="replace") + "\n"
            elif f.suffix.lower() in (".pdf", ".docx"):
                file_content += f"[{f.suffix.upper()} file: {f.name}]\n"

    # Also pull any form data stored in step_data
    step_data = ob.get("step_data") or {}
    form_data = step_data.get("form") or {}
    if form_data:
        file_content += "\n## Form Submission\n"
        for k, v in form_data.items():
            if v:
                file_content += f"- {k}: {v}\n"

    async def event_stream():
        yield f"data: {json.dumps({'type': 'progress', 'step': 'reading', 'message': 'Reading business info...'})}\n\n"

        # Form mode: data is already structured — skip Claude entirely
        if form_data and not file_content.strip():
            fields = _form_to_fields(form_data)
            yield f"data: {json.dumps({'type': 'progress', 'step': 'extracting', 'message': f'Found {len(fields)} fields from your form.'})}\n\n"
            yield f"data: {json.dumps({'type': 'complete', 'fields': fields})}\n\n"
            yield "data: [DONE]\n\n"
            return

        # Upload mode: try Claude, graceful fallback
        yield f"data: {json.dumps({'type': 'progress', 'step': 'analyzing', 'message': 'Analyzing with AI...'})}\n\n"

        try:
            biz_rows = await _sb_get(f"helm_businesses?id=eq.{ob['business_id']}&select=name")
            biz_name = biz_rows[0]["name"] if biz_rows else "Business"

            result = await call_claude(
                business={"name": biz_name},
                task_type="parse_business_brief",
                user_prompt=f"Parse this business brief and return structured JSON:\n\n{file_content}",
                max_tokens=4096,
            )

            yield f"data: {json.dumps({'type': 'progress', 'step': 'extracting', 'message': 'Structuring extracted data...'})}\n\n"

            content = result.get("content", "")
            try:
                parsed_dict = json.loads(content)
            except json.JSONDecodeError:
                start = content.find("{")
                end = content.rfind("}") + 1
                parsed_dict = json.loads(content[start:end]) if start >= 0 and end > start else {}

            # Convert parsed dict → fields array
            fields = [
                {"field_name": k.replace("_", " ").title(), "key": k, "value": str(v), "confidence": 0.8}
                for k, v in parsed_dict.items()
                if v and not k.startswith("parse_")
            ]
            # Merge with any form data at lower position
            if form_data:
                fields = _form_to_fields(form_data) + [f for f in fields if f["key"] not in {x["key"] for x in _form_to_fields(form_data)}]

            yield f"data: {json.dumps({'type': 'complete', 'fields': fields, 'tokens_used': result.get('tokens_used', 0)})}\n\n"

        except Exception as exc:
            log.error("Parse error: %s", exc)
            # Fall back to form data only
            fields = _form_to_fields(form_data) if form_data else []
            if not fields:
                fields = [{"field_name": "Note", "key": "parse_error", "value": f"AI unavailable: {exc}. Fill fields in next step.", "confidence": 0.0}]
            yield f"data: {json.dumps({'type': 'complete', 'fields': fields})}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/api/onboarding/{onboarding_id}/confirm")
async def confirm_profile(
    onboarding_id: str,
    body: ConfirmProfile,
    user: AuthUser = Depends(get_current_user),
):
    """Save confirmed business profile, advance to step 3."""
    ob = await _get_onboarding_and_check(onboarding_id, user)
    business_id = ob["business_id"]

    allowed_fields = {
        "name", "industry", "stage", "tagline", "description",
        "tone_of_voice", "brand_voice_notes", "never_say", "target_audience",
        "value_proposition", "primary_goal", "autonomy_level",
        "monthly_revenue_target", "monthly_lead_target",
        "goals_3mo", "goals_6mo", "goals_12mo",
        "content_pillars", "avoid_topics", "revenue_model",
        "pain_points", "products", "competitors", "website",
        "brand_color_primary",
    }
    update = {k: v for k, v in body.profile.items() if k in allowed_fields and v is not None}
    if update:
        await _sb_patch(f"helm_businesses?id=eq.{business_id}", update)

    await _sb_patch(
        f"helm_business_onboarding?id=eq.{onboarding_id}",
        {"current_step": 3},
    )
    return {"confirmed": True, "step": 3}


@router.put("/api/onboarding/{onboarding_id}/fields")
async def save_fields(
    onboarding_id: str,
    body: dict,
    user: AuthUser = Depends(get_current_user),
):
    """Save reviewed/edited parsed fields back to onboarding step_data."""
    ob = await _get_onboarding_and_check(onboarding_id, user)
    existing = ob.get("step_data") or {}
    existing["fields"] = body.get("fields", [])
    await _sb_patch(
        f"helm_business_onboarding?id=eq.{onboarding_id}",
        {"step_data": existing},
    )
    return {"saved": True}


@router.post("/api/onboarding/{onboarding_id}/website")
async def save_website(
    onboarding_id: str,
    body: WebsiteStep,
    user: AuthUser = Depends(get_current_user),
):
    """Save website platform choice + credentials to vault."""
    ob = await _get_onboarding_and_check(onboarding_id, user)
    business_id = ob["business_id"]

    if body.platform != "none" and body.site_url:
        cred_data = {"platform": body.platform, "site_url": body.site_url}
        if body.username:
            cred_data["username"] = body.username
        if body.app_password:
            cred_data["app_password"] = body.app_password

        vault_key = store_credential(business_id, "website", cred_data)
        await _sb_post("helm_business_credential_refs", {
            "business_id": business_id,
            "service": "website",
            "label": f"{body.platform} - {body.site_url}",
            "vault_key": vault_key,
            "is_active": True,
        }, upsert=True, on_conflict="vault_key")
        # Also write the URL directly to the business record for easy display
        await _sb_patch(f"helm_businesses?id=eq.{business_id}", {"website": body.site_url})

    await _sb_patch(f"helm_business_onboarding?id=eq.{onboarding_id}", {"current_step": 4})
    return {"saved": True, "step": 4}


@router.post("/api/onboarding/{onboarding_id}/social")
async def save_social(
    onboarding_id: str,
    body: SocialStep,
    user: AuthUser = Depends(get_current_user),
):
    """Save social platform credentials to vault."""
    ob = await _get_onboarding_and_check(onboarding_id, user)
    business_id = ob["business_id"]

    vault_key = store_credential(business_id, body.platform, body.credentials)

    await _sb_post("helm_business_credential_refs", {
        "business_id": business_id,
        "service": body.platform,
        "label": f"{body.platform} account",
        "vault_key": vault_key,
        "is_active": True,
    }, upsert=True, on_conflict="vault_key")

    # Also upsert into helm_business_social_accounts so the social panel populates
    handle = body.credentials.get("handle") or body.credentials.get("username") or body.credentials.get("page_name") or ""
    if handle and body.platform in ("twitter", "linkedin", "instagram", "facebook", "tiktok", "youtube", "pinterest"):
        await _sb_post("helm_business_social_accounts", {
            "business_id": business_id,
            "platform": body.platform,
            "handle": handle,
            "credentials_ref": vault_key,
            "is_active": True,
        }, upsert=True, on_conflict="business_id,platform,handle")

    return {"saved": True, "platform": body.platform}


@router.patch("/api/onboarding/{onboarding_id}/step")
async def advance_step(
    onboarding_id: str,
    body: StepAdvance,
    user: AuthUser = Depends(get_current_user),
):
    """Save current step progress so a refresh can resume at the right place."""
    ob = await _get_onboarding_and_check(onboarding_id, user)
    # Only advance — never go backwards (prevents stale retries from resetting progress)
    if body.step > (ob.get("current_step") or 0):
        await _sb_patch(
            f"helm_business_onboarding?id=eq.{onboarding_id}",
            {"current_step": body.step},
        )
    return {"step": max(body.step, ob.get("current_step") or 0)}


@router.post("/api/onboarding/{onboarding_id}/stripe")
async def save_stripe(
    onboarding_id: str,
    body: StripeStep,
    user: AuthUser = Depends(get_current_user),
):
    """Save Stripe credentials to vault."""
    ob = await _get_onboarding_and_check(onboarding_id, user)
    business_id = ob["business_id"]

    cred_data = {"api_key": body.stripe_api_key}
    if body.stripe_webhook_secret:
        cred_data["webhook_secret"] = body.stripe_webhook_secret
    if body.publishable_key:
        cred_data["publishable_key"] = body.publishable_key

    vault_key = store_credential(business_id, "stripe", cred_data)

    await _sb_post("helm_business_credential_refs", {
        "business_id": business_id,
        "service": "stripe",
        "label": "Stripe account",
        "vault_key": vault_key,
        "is_active": True,
    }, upsert=True, on_conflict="vault_key")

    await _sb_patch(f"helm_business_onboarding?id=eq.{onboarding_id}", {"current_step": 6})
    return {"saved": True, "step": 6}


@router.post("/api/onboarding/{onboarding_id}/account-check")
async def account_check(
    onboarding_id: str,
    body: AccountCheck,
    user: AuthUser = Depends(get_current_user),
):
    """Check if HELM has credentials for a social platform. Returns null = not connected."""
    ob = await _get_onboarding_and_check(onboarding_id, user)
    existing = await _sb_get(
        f"helm_business_credential_refs?business_id=eq.{ob['business_id']}"
        f"&service=eq.{body.platform}&select=id"
    )
    return {"has_account": bool(existing), "platform": body.platform}


@router.get("/api/onboarding/{onboarding_id}/generate")
async def generate_content_calendar(
    onboarding_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """SSE: generate initial content calendar."""
    ob = await _get_onboarding_and_check(onboarding_id, user)
    business_id = ob["business_id"]

    # Track progress: user has reached step 7 (AI generation)
    if (ob.get("current_step") or 0) < 7:
        await _sb_patch(
            f"helm_business_onboarding?id=eq.{onboarding_id}",
            {"current_step": 7},
        )

    biz_rows = await _sb_get(f"helm_businesses?id=eq.{business_id}&select=*")
    if not biz_rows:
        raise HTTPException(404, "Business not found")
    business = biz_rows[0]

    async def event_stream():
        yield f"data: {json.dumps({'type': 'progress', 'step': 'loading', 'message': 'Loading business profile...'})}\n\n"
        yield f"data: {json.dumps({'type': 'progress', 'step': 'generating', 'message': 'Building your Week 1 plan...'})}\n\n"

        try:
            result = await call_claude(
                business=business,
                task_type="content_generate",
                user_prompt=(
                    "Generate a 4-week content calendar. "
                    "Include 3 blog posts per week and 5 social posts per week. "
                    "For each: title, type, platform, relative publish date, brief description, CTA."
                ),
                max_tokens=4096,
            )
            yield f"data: {json.dumps({'type': 'progress', 'step': 'finalizing', 'message': 'Finalizing content calendar...'})}\n\n"
            yield f"data: {json.dumps({'type': 'result', 'content': result.get('content', ''), 'tokens_used': result.get('tokens_used', 0)})}\n\n"
        except Exception as exc:
            log.error("Content calendar error: %s", exc)
            yield f"data: {json.dumps({'type': 'result', 'content': 'AI generation unavailable — calendar will be populated once an API key is configured.', 'tokens_used': 0})}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/api/onboarding/{onboarding_id}/launch")
async def launch_business(
    onboarding_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Finalize onboarding: activate business, create schedule, mark complete."""
    ob = await _get_onboarding_and_check(onboarding_id, user)
    business_id = ob["business_id"]

    await _sb_patch(f"helm_businesses?id=eq.{business_id}", {"is_active": True})

    from datetime import datetime, timezone
    from croniter import croniter
    now = datetime.now(timezone.utc)

    default_schedules = [
        {"job_type": "content_generate", "cron_expr": "0 9 * * 1,3,5", "immediate": True},
        {"job_type": "report_weekly",    "cron_expr": "0 8 * * 1"},
        {"job_type": "site_health_check","cron_expr": "0 */6 * * *"},
        {"job_type": "hitl_expiry",      "cron_expr": "0 * * * *"},
    ]
    for sched in default_schedules:
        # Run content_generate immediately on launch; others follow their cron
        if sched.get("immediate"):
            next_run = now
        else:
            next_run = croniter(sched["cron_expr"], now).get_next(datetime)
        await _sb_post("helm_business_schedule", {
            "business_id": business_id,
            "job_type": sched["job_type"],
            "cron_expr": sched["cron_expr"],
            "enabled": True,
            "next_run_at": next_run.isoformat(),
        }, upsert=True, on_conflict="business_id,job_type")

    # Log the launch action so dashboard shows immediate activity
    await _sb_post("helm_business_actions", {
        "business_id": business_id,
        "action_type": "helm_launched",
        "summary": "HELM activated — autonomous business management is now running",
        "status": "success",
        "actor": "system",
    })

    # Mark complete via completed_at (avoids the CHECK 1-8 constraint on current_step)
    from datetime import datetime, timezone
    await _sb_patch(
        f"helm_business_onboarding?id=eq.{onboarding_id}",
        {"current_step": 8, "completed_at": datetime.now(timezone.utc).isoformat()},
    )

    return {"launched": True, "business_id": business_id}
