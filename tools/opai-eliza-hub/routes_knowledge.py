"""Eliza Hub — Knowledge branch management routes.

CRUD for knowledge branches, node assignment, sync triggers,
and Brain API integration.
"""
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

import config

try:
    from auth import get_user_from_request
except ImportError:
    async def get_user_from_request(request):
        return type("U", (), {"id": config.ADMIN_USER_ID})()

log = logging.getLogger("eliza-hub.knowledge")
router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


async def supabase_request(method: str, path: str, body=None, params=None):
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


# ── Models ─────────────────────────────────────────────────

class BranchCreate(BaseModel):
    name: str
    slug: str
    root_node_id: Optional[str] = None
    info_layer: str = "public"
    auto_sync: bool = False
    sync_criteria: dict = {}
    description: str = ""


class BranchUpdate(BaseModel):
    name: Optional[str] = None
    info_layer: Optional[str] = None
    auto_sync: Optional[bool] = None
    sync_criteria: Optional[dict] = None
    description: Optional[str] = None


# ── Branch CRUD ────────────────────────────────────────────

def supabase_available() -> bool:
    return bool(config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY)


@router.get("/branches")
async def list_branches(
    request: Request,
    info_layer: Optional[str] = None,
    search: Optional[str] = None,
):
    if not supabase_available():
        return {"branches": [], "note": "Knowledge branches require Supabase — not configured"}

    user = await get_user_from_request(request)
    params = {
        "select": "*,eliza_knowledge_branch_nodes(count)",
        "owner_id": f"eq.{user.id}",
        "order": "name.asc",
    }
    if info_layer:
        params["info_layer"] = f"eq.{info_layer}"
    if search:
        params["name"] = f"ilike.%{search}%"

    branches = await supabase_request("GET", "eliza_knowledge_branches", params=params)
    return {"branches": branches}


@router.get("/branches/{branch_id}")
async def get_branch(request: Request, branch_id: str):
    user = await get_user_from_request(request)
    params = {
        "id": f"eq.{branch_id}",
        "owner_id": f"eq.{user.id}",
        "select": "*",
    }
    branches = await supabase_request("GET", "eliza_knowledge_branches", params=params)
    if not branches:
        raise HTTPException(404, "Branch not found")
    return branches[0]


@router.post("/branches")
async def create_branch(request: Request, body: BranchCreate):
    user = await get_user_from_request(request)
    data = body.model_dump()
    data["owner_id"] = user.id

    result = await supabase_request("POST", "eliza_knowledge_branches", body=data)
    return result[0] if isinstance(result, list) else result


@router.patch("/branches/{branch_id}")
async def update_branch(request: Request, branch_id: str, body: BranchUpdate):
    user = await get_user_from_request(request)
    data = {k: v for k, v in body.model_dump().items() if v is not None}

    params = {
        "id": f"eq.{branch_id}",
        "owner_id": f"eq.{user.id}",
    }
    result = await supabase_request("PATCH", "eliza_knowledge_branches", body=data, params=params)
    return result[0] if isinstance(result, list) else result


@router.delete("/branches/{branch_id}")
async def delete_branch(request: Request, branch_id: str):
    user = await get_user_from_request(request)
    params = {
        "id": f"eq.{branch_id}",
        "owner_id": f"eq.{user.id}",
    }
    await supabase_request("DELETE", "eliza_knowledge_branches", params=params)
    return {"success": True}


# ── Branch node management ─────────────────────────────────

@router.get("/branches/{branch_id}/nodes")
async def list_branch_nodes(request: Request, branch_id: str):
    """List all nodes in a branch."""
    params = {
        "branch_id": f"eq.{branch_id}",
        "select": "id,node_id,added_at,added_by",
        "order": "added_at.desc",
    }
    nodes = await supabase_request("GET", "eliza_knowledge_branch_nodes", params=params)
    return {"nodes": nodes}


@router.post("/branches/{branch_id}/nodes")
async def add_node_to_branch(request: Request, branch_id: str):
    """Add a brain node to a knowledge branch."""
    body = await request.json()
    node_id = body.get("node_id")
    if not node_id:
        raise HTTPException(400, "node_id required")

    result = await supabase_request("POST", "eliza_knowledge_branch_nodes", body={
        "branch_id": branch_id,
        "node_id": node_id,
        "added_by": body.get("added_by", "manual"),
    })
    return result[0] if isinstance(result, list) else result


@router.delete("/branches/{branch_id}/nodes/{node_id}")
async def remove_node_from_branch(request: Request, branch_id: str, node_id: str):
    """Remove (prune) a node from a knowledge branch."""
    params = {
        "branch_id": f"eq.{branch_id}",
        "node_id": f"eq.{node_id}",
    }
    await supabase_request("DELETE", "eliza_knowledge_branch_nodes", params=params)
    return {"success": True}


# ── Brain integration ──────────────────────────────────────

@router.get("/brain-nodes")
async def list_brain_nodes(
    search: Optional[str] = None,
    type: Optional[str] = None,
    tag: Optional[str] = None,
    limit: int = Query(50, le=200),
):
    """List available Brain nodes for assignment to branches."""
    try:
        params = {"limit": limit}
        if search:
            params["q"] = search
        if type:
            params["type"] = type
        if tag:
            params["tag"] = tag

        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{config.BRAIN_URL}/api/nodes", params=params)
            if resp.status_code == 200:
                return resp.json()
            return {"nodes": [], "error": f"Brain API returned {resp.status_code}"}
    except httpx.ConnectError:
        return {"nodes": [], "error": "Brain service not reachable"}


# ── Sync trigger ───────────────────────────────────────────

@router.post("/branches/{branch_id}/sync")
async def trigger_sync(request: Request, branch_id: str):
    """Manually trigger a knowledge sync for a branch."""
    user = await get_user_from_request(request)

    # Get branch config
    params = {"id": f"eq.{branch_id}", "owner_id": f"eq.{user.id}", "select": "*"}
    branches = await supabase_request("GET", "eliza_knowledge_branches", params=params)
    if not branches:
        raise HTTPException(404, "Branch not found")

    branch = branches[0]
    criteria = branch.get("sync_criteria", {})
    if not criteria:
        return {"synced": 0, "message": "No sync criteria configured"}

    # Fetch matching nodes from Brain
    brain_params = {"limit": 200}
    if criteria.get("tags"):
        brain_params["tag"] = ",".join(criteria["tags"])
    if criteria.get("types"):
        brain_params["type"] = ",".join(criteria["types"])

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{config.BRAIN_URL}/api/nodes", params=brain_params)
            if resp.status_code != 200:
                return {"synced": 0, "error": "Brain API error"}
            brain_data = resp.json()
    except Exception:
        return {"synced": 0, "error": "Brain not reachable"}

    nodes = brain_data.get("nodes", [])
    synced = 0
    for node in nodes:
        # Skip nodes that don't match info_layer filter
        if criteria.get("info_layer_filter"):
            if node.get("info_layer") not in criteria["info_layer_filter"]:
                continue

        try:
            await supabase_request("POST", "eliza_knowledge_branch_nodes", body={
                "branch_id": branch_id,
                "node_id": node["id"],
                "added_by": "auto_sync",
            })
            synced += 1
        except Exception:
            pass  # Duplicate entries are expected

    return {"synced": synced, "total_matched": len(nodes)}
