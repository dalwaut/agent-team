"""OP WordPress — AI assistant routes."""

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
        if sites:
            return sites[0]
        if not user.is_admin:
            from routes_sites import _get_shared_site_owner_ids
            for e in await _get_shared_site_owner_ids(client, user.id):
                oid = e.get("shared_by")
                if not oid:
                    continue
                r2 = await client.get(
                    f"{_sb_url('wp_sites')}?id=eq.{site_id}&user_id=eq.{oid}&select=*",
                    headers=_sb_headers_service())
                if r2.status_code == 200 and r2.json():
                    s = r2.json()[0]; s["_shared"] = True; return s
        raise HTTPException(404, "Site not found")


# ── Request Models ────────────────────────────────────────

class PlanRequest(BaseModel):
    site_id: str
    prompt: str
    template_id: Optional[str] = None


class ExecuteRequest(BaseModel):
    site_id: str
    plan: dict


class ChatRequest(BaseModel):
    site_id: str
    message: str
    history: Optional[List[dict]] = None


# ── AI Endpoints ──────────────────────────────────────────

@router.post("/ai/plan")
async def generate_plan(body: PlanRequest,
                        user: AuthUser = Depends(get_current_user)):
    """Generate an action plan from natural language."""
    site = await _get_site(body.site_id, user)

    from services.ai_assistant import generate_plan as ai_plan
    plan = await ai_plan(
        prompt=body.prompt,
        site_info=site,
        template_id=body.template_id,
    )

    if plan.get("error"):
        raise HTTPException(500, plan["error"])

    return plan


@router.post("/ai/execute")
async def execute_plan(body: ExecuteRequest,
                       user: AuthUser = Depends(get_current_user)):
    """Execute an approved action plan."""
    site = await _get_site(body.site_id, user)

    from services.site_manager import SiteCredentials
    from services.ai_assistant import execute_plan as ai_execute

    creds = SiteCredentials(site)
    result = await ai_execute(body.plan, site, creds)
    return result


@router.get("/ai/templates")
async def get_templates(user: AuthUser = Depends(get_current_user)):
    """List available AI task templates."""
    from services.ai_assistant import list_templates
    return list_templates()


@router.post("/ai/chat")
async def chat(body: ChatRequest,
               user: AuthUser = Depends(get_current_user)):
    """Conversational mode for site analysis."""
    site = await _get_site(body.site_id, user)

    from services.ai_assistant import chat as ai_chat
    response = await ai_chat(
        message=body.message,
        site_info=site,
        history=body.history,
    )
    return {"response": response}
