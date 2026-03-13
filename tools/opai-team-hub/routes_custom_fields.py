"""OPAI Team Hub — Custom Fields API routes."""

from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import config
from auth import get_current_user, AuthUser

router = APIRouter(prefix="/api")


# ── Supabase helpers ─────────────────────────────────────────

def _sb_headers_service():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


async def _check_membership(client: httpx.AsyncClient, ws_id: str, user_id: str):
    """Return membership role or raise 404."""
    resp = await client.get(
        _sb_url("team_membership"),
        headers=_sb_headers_service(),
        params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user_id}"},
    )
    rows = resp.json() if resp.status_code < 400 else []
    if not rows:
        raise HTTPException(status_code=404, detail="Not a member of this workspace")
    return rows[0]["role"]


async def _require_admin(client: httpx.AsyncClient, ws_id: str, user_id: str):
    """Check membership and require owner or admin role."""
    role = await _check_membership(client, ws_id, user_id)
    if role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Admin or owner role required")
    return role


# ── Pydantic models ──────────────────────────────────────────

class CreateCustomField(BaseModel):
    name: str
    type: str = "text"
    options: list = []


class UpdateCustomField(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    options: Optional[list] = None
    orderindex: Optional[int] = None


class SetFieldValue(BaseModel):
    value: str


# ══════════════════════════════════════════════════════════════
# Custom Field Definitions
# ══════════════════════════════════════════════════════════════


@router.get("/workspaces/{ws_id}/custom-fields")
async def list_custom_fields(ws_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _check_membership(client, ws_id, user.id)
        resp = await client.get(
            _sb_url("team_custom_fields"),
            headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "order": "orderindex.asc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@router.post("/workspaces/{ws_id}/custom-fields", status_code=201)
async def create_custom_field(ws_id: str, req: CreateCustomField, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _require_admin(client, ws_id, user.id)

        valid_types = ("text", "number", "dropdown", "date", "checkbox", "url", "email")
        if req.type not in valid_types:
            raise HTTPException(status_code=400, detail=f"Invalid type. Must be one of: {', '.join(valid_types)}")

        resp = await client.post(
            _sb_url("team_custom_fields"),
            headers=headers,
            json={
                "workspace_id": ws_id,
                "name": req.name,
                "type": req.type,
                "options": req.options if req.type == "dropdown" else [],
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.patch("/custom-fields/{field_id}")
async def update_custom_field(field_id: str, req: UpdateCustomField, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Look up field to get workspace_id
        field_resp = await client.get(
            _sb_url("team_custom_fields"),
            headers=headers,
            params={"id": f"eq.{field_id}"},
        )
        if field_resp.status_code >= 400 or not field_resp.json():
            raise HTTPException(status_code=404, detail="Custom field not found")
        field = field_resp.json()[0]

        await _require_admin(client, field["workspace_id"], user.id)

        updates = {k: v for k, v in req.model_dump(exclude_unset=True).items() if v is not None}
        if not updates:
            return field

        resp = await client.patch(
            _sb_url("team_custom_fields"),
            headers=headers,
            params={"id": f"eq.{field_id}"},
            json=updates,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/custom-fields/{field_id}", status_code=204)
async def delete_custom_field(field_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Look up field to get workspace_id
        field_resp = await client.get(
            _sb_url("team_custom_fields"),
            headers=headers,
            params={"id": f"eq.{field_id}"},
        )
        if field_resp.status_code >= 400 or not field_resp.json():
            raise HTTPException(status_code=404, detail="Custom field not found")
        field = field_resp.json()[0]

        await _require_admin(client, field["workspace_id"], user.id)

        # Delete values first (cascade), then the field
        await client.delete(
            _sb_url("team_item_field_values"),
            headers=headers,
            params={"field_id": f"eq.{field_id}"},
        )
        resp = await client.delete(
            _sb_url("team_custom_fields"),
            headers=headers,
            params={"id": f"eq.{field_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)


# ══════════════════════════════════════════════════════════════
# Item Field Values
# ══════════════════════════════════════════════════════════════


@router.get("/items/{item_id}/field-values")
async def get_field_values(item_id: str):
    """Get all field values for an item, joined with field definitions."""
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _sb_url("team_item_field_values"),
            headers=headers,
            params={
                "item_id": f"eq.{item_id}",
                "select": "id,item_id,field_id,value,updated_at,field:team_custom_fields(id,name,type,options)",
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@router.put("/items/{item_id}/field-values/{field_id}")
async def set_field_value(item_id: str, field_id: str, req: SetFieldValue, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Look up item to get workspace_id for membership check
        item_resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}", "select": "id,workspace_id"},
        )
        if item_resp.status_code >= 400 or not item_resp.json():
            raise HTTPException(status_code=404, detail="Item not found")
        item = item_resp.json()[0]

        await _check_membership(client, item["workspace_id"], user.id)

        # Upsert: insert or update on conflict
        upsert_headers = {**headers, "Prefer": "return=representation,resolution=merge-duplicates"}
        resp = await client.post(
            _sb_url("team_item_field_values"),
            headers=upsert_headers,
            params={"on_conflict": "item_id,field_id"},
            json={
                "item_id": item_id,
                "field_id": field_id,
                "value": req.value,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/items/{item_id}/field-values/{field_id}", status_code=204)
async def delete_field_value(item_id: str, field_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers_service()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Look up item to get workspace_id for membership check
        item_resp = await client.get(
            _sb_url("team_items"),
            headers=headers,
            params={"id": f"eq.{item_id}", "select": "id,workspace_id"},
        )
        if item_resp.status_code >= 400 or not item_resp.json():
            raise HTTPException(status_code=404, detail="Item not found")
        item = item_resp.json()[0]

        await _check_membership(client, item["workspace_id"], user.id)

        resp = await client.delete(
            _sb_url("team_item_field_values"),
            headers=headers,
            params={"item_id": f"eq.{item_id}", "field_id": f"eq.{field_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
