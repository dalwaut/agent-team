"""Eliza Hub — Agent CRUD + lifecycle proxy routes.

Manages agent records in Supabase and proxies lifecycle commands
(start/stop/restart/message) to the ElizaOS runtime at :8085.
"""
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

import config

try:
    from auth import get_user_from_request, AuthUser
except ImportError:
    async def get_user_from_request(request):
        return type("U", (), {"id": config.ADMIN_USER_ID})()
    AuthUser = None

log = logging.getLogger("eliza-hub.agents")
router = APIRouter(prefix="/api/agents", tags=["agents"])

ELIZA = config.ELIZA_RUNTIME_URL


# ── Helpers ────────────────────────────────────────────────

def supabase_available() -> bool:
    """Check if Supabase credentials are configured."""
    return bool(config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY)


async def supabase_request(method: str, path: str, body=None, params=None, user_id=None):
    """Make authenticated Supabase REST API call."""
    if not supabase_available():
        raise HTTPException(503, "Supabase not configured — using runtime-only mode")
    headers = {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.request(method, url, json=body, headers=headers, params=params)
        if resp.status_code >= 400:
            log.error(f"Supabase {method} {path}: {resp.status_code} — {resp.text}")
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        try:
            return resp.json()
        except Exception:
            return {"status": "ok"}


async def runtime_request(method: str, path: str, body=None):
    """Proxy request to ElizaOS runtime."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(method, f"{ELIZA}{path}", json=body)
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(502, "ElizaOS runtime is not reachable")
    except Exception as e:
        raise HTTPException(500, f"Runtime error: {str(e)}")


# ── Models ─────────────────────────────────────────────────

class AgentCreate(BaseModel):
    name: str
    slug: str
    character_file: dict = {}
    deployment_tier: str = "local"
    model: str = "claude-sonnet-4-6"
    plugins: list[str] = []
    knowledge_branch_id: Optional[str] = None
    workspace_id: Optional[str] = None
    platforms: list[str] = []
    rate_limit_rpm: int = 60
    rate_limit_daily: int = 1000
    max_tokens: int = 4096
    temperature: float = 0.7
    metadata: dict = {}


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    character_file: Optional[dict] = None
    deployment_tier: Optional[str] = None
    model: Optional[str] = None
    plugins: Optional[list[str]] = None
    knowledge_branch_id: Optional[str] = None
    platforms: Optional[list[str]] = None
    rate_limit_rpm: Optional[int] = None
    rate_limit_daily: Optional[int] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    metadata: Optional[dict] = None


class StartFromCharacter(BaseModel):
    characterFile: str


# ── Runtime routes (MUST be before parameterized /{agent_id} routes) ──

@router.get("/runtime/status")
async def runtime_status():
    """Get live status from ElizaOS runtime."""
    return await runtime_request("GET", "/health")


@router.get("/runtime/characters")
async def list_characters():
    """List available character files."""
    return await runtime_request("GET", "/api/characters")


@router.post("/runtime/start")
async def start_from_character(body: StartFromCharacter):
    """Start an agent directly from a character file (no Supabase required)."""
    result = await runtime_request("POST", "/api/agents/start", {
        "characterFile": body.characterFile,
    })
    return result


# ── CRUD ───────────────────────────────────────────────────

@router.get("")
async def list_agents(
    request: Request,
    status: Optional[str] = None,
    platform: Optional[str] = None,
    deployment: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(50, le=200),
    offset: int = 0,
):
    # When Supabase isn't configured, fall back to runtime API directly
    if not supabase_available():
        result = await runtime_request("GET", "/api/agents")
        agents = result.get("agents", [])
        if search:
            agents = [a for a in agents if search.lower() in a.get("name", "").lower()]
        if status:
            agents = [a for a in agents if a.get("status") == status]
        return {"agents": agents, "count": len(agents)}

    user = await get_user_from_request(request)
    params = {
        "select": "*",
        "owner_id": f"eq.{user.id}",
        "order": "created_at.desc",
        "limit": str(limit),
        "offset": str(offset),
    }
    if status:
        params["status"] = f"eq.{status}"
    if platform:
        params["platforms"] = f"cs.{{{platform}}}"
    if deployment:
        params["deployment_tier"] = f"eq.{deployment}"
    if search:
        params["name"] = f"ilike.%{search}%"

    agents = await supabase_request("GET", "eliza_agents", params=params)
    return {"agents": agents, "count": len(agents)}


@router.get("/{agent_id}")
async def get_agent(request: Request, agent_id: str):
    if not supabase_available():
        result = await runtime_request("GET", f"/api/agents/{agent_id}")
        if not result:
            raise HTTPException(404, "Agent not found")
        return result

    user = await get_user_from_request(request)
    params = {
        "id": f"eq.{agent_id}",
        "owner_id": f"eq.{user.id}",
        "select": "*",
    }
    agents = await supabase_request("GET", "eliza_agents", params=params)
    if not agents:
        raise HTTPException(404, "Agent not found")
    return agents[0]


@router.post("")
async def create_agent(request: Request, body: AgentCreate):
    user = await get_user_from_request(request)
    data = body.model_dump()
    data["owner_id"] = user.id

    result = await supabase_request("POST", "eliza_agents", body=data)

    # Log creation to audit
    agent = result[0] if isinstance(result, list) else result
    await supabase_request("POST", "eliza_audit_log", body={
        "agent_id": agent.get("id"),
        "owner_id": user.id,
        "action": "agent_created",
        "details": {"name": body.name, "slug": body.slug},
        "severity": "info",
    })

    return agent


@router.patch("/{agent_id}")
async def update_agent(request: Request, agent_id: str, body: AgentUpdate):
    user = await get_user_from_request(request)
    data = {k: v for k, v in body.model_dump().items() if v is not None}

    params = {
        "id": f"eq.{agent_id}",
        "owner_id": f"eq.{user.id}",
    }
    result = await supabase_request("PATCH", "eliza_agents", body=data, params=params)

    await supabase_request("POST", "eliza_audit_log", body={
        "agent_id": agent_id,
        "owner_id": user.id,
        "action": "agent_updated",
        "details": {"fields": list(data.keys())},
        "severity": "info",
    })

    agent = result[0] if isinstance(result, list) else result
    return agent


@router.delete("/{agent_id}")
async def delete_agent(request: Request, agent_id: str):
    user = await get_user_from_request(request)

    # Stop runtime first if running
    try:
        await runtime_request("POST", f"/api/agents/{agent_id}/stop")
    except Exception:
        pass

    params = {
        "id": f"eq.{agent_id}",
        "owner_id": f"eq.{user.id}",
    }
    await supabase_request("DELETE", "eliza_agents", params=params)

    await supabase_request("POST", "eliza_audit_log", body={
        "agent_id": agent_id,
        "owner_id": user.id,
        "action": "agent_deleted",
        "details": {},
        "severity": "info",
    })

    return {"success": True}


# ── Lifecycle proxies ──────────────────────────────────────

@router.post("/{agent_id}/start")
async def start_agent(request: Request, agent_id: str):
    user = await get_user_from_request(request)

    # Get agent config from Supabase
    params = {"id": f"eq.{agent_id}", "owner_id": f"eq.{user.id}", "select": "*"}
    agents = await supabase_request("GET", "eliza_agents", params=params)
    if not agents:
        raise HTTPException(404, "Agent not found")

    agent = agents[0]
    character = agent.get("character_file", {})
    character["id"] = agent_id
    character["owner_id"] = user.id

    # Start on runtime
    result = await runtime_request("POST", "/api/agents/start", {
        "character": character,
        "agentId": agent_id,
    })

    # Update status in DB
    await supabase_request("PATCH", "eliza_agents", body={"status": "running"}, params={
        "id": f"eq.{agent_id}", "owner_id": f"eq.{user.id}",
    })

    await supabase_request("POST", "eliza_audit_log", body={
        "agent_id": agent_id,
        "owner_id": user.id,
        "action": "agent_started",
        "details": {"runtime_response": result},
        "severity": "info",
    })

    return result


@router.post("/{agent_id}/stop")
async def stop_agent(request: Request, agent_id: str):
    user = await get_user_from_request(request)

    result = await runtime_request("POST", f"/api/agents/{agent_id}/stop")

    await supabase_request("PATCH", "eliza_agents", body={"status": "stopped"}, params={
        "id": f"eq.{agent_id}", "owner_id": f"eq.{user.id}",
    })

    await supabase_request("POST", "eliza_audit_log", body={
        "agent_id": agent_id,
        "owner_id": user.id,
        "action": "agent_stopped",
        "details": {},
        "severity": "info",
    })

    return result


@router.post("/{agent_id}/restart")
async def restart_agent(request: Request, agent_id: str):
    user = await get_user_from_request(request)
    result = await runtime_request("POST", f"/api/agents/{agent_id}/restart")

    await supabase_request("PATCH", "eliza_agents", body={"status": "running"}, params={
        "id": f"eq.{agent_id}", "owner_id": f"eq.{user.id}",
    })

    return result


@router.post("/{agent_id}/message")
async def message_agent(request: Request, agent_id: str):
    body = await request.json()
    result = await runtime_request("POST", f"/api/agents/{agent_id}/message", body)
    return result
