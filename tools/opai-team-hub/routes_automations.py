"""OPAI Team Hub — Workspace Automations router."""

import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import config
from auth import get_current_user, AuthUser

logger = logging.getLogger("team-hub.automations")
router = APIRouter(prefix="/api")

TRIGGER_TYPES = {"status_changed", "priority_changed", "assignee_added",
                 "due_date_passed", "item_created"}
ACTION_TYPES = {"change_status", "change_priority", "add_assignee",
                "send_notification", "move_to_list", "add_tag"}


# ── Supabase helpers ─────────────────────────────────────────

def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Pydantic models ──────────────────────────────────────────

class CreateAutomation(BaseModel):
    name: str
    trigger_type: str
    trigger_config: dict = {}
    action_type: str
    action_config: dict = {}


class UpdateAutomation(BaseModel):
    name: Optional[str] = None
    trigger_type: Optional[str] = None
    trigger_config: Optional[dict] = None
    action_type: Optional[str] = None
    action_config: Optional[dict] = None
    active: Optional[bool] = None


# ── Membership check helper ──────────────────────────────────

async def _check_membership(client: httpx.AsyncClient, headers: dict,
                            ws_id: str, user_id: str, require_admin: bool = False):
    """Return role or raise."""
    resp = await client.get(
        _sb_url("team_membership"), headers=headers,
        params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user_id}"},
    )
    if resp.status_code >= 400 or not resp.json():
        raise HTTPException(status_code=404, detail="Workspace not found")
    role = resp.json()[0]["role"]
    if require_admin and role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return role


async def _get_automation(client: httpx.AsyncClient, headers: dict, auto_id: str):
    """Fetch a single automation or 404."""
    resp = await client.get(
        _sb_url("team_automations"), headers=headers,
        params={"id": f"eq.{auto_id}"},
    )
    if resp.status_code >= 400 or not resp.json():
        raise HTTPException(status_code=404, detail="Automation not found")
    return resp.json()[0]


# ── Endpoints ─────────────────────────────────────────────────

@router.get("/workspaces/{ws_id}/automations")
async def list_automations(ws_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _check_membership(client, headers, ws_id, user.id)
        resp = await client.get(
            _sb_url("team_automations"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "order": "created_at.desc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@router.post("/workspaces/{ws_id}/automations", status_code=201)
async def create_automation(ws_id: str, body: CreateAutomation,
                            user: AuthUser = Depends(get_current_user)):
    if body.trigger_type not in TRIGGER_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid trigger_type. Must be one of: {', '.join(sorted(TRIGGER_TYPES))}")
    if body.action_type not in ACTION_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid action_type. Must be one of: {', '.join(sorted(ACTION_TYPES))}")

    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _check_membership(client, headers, ws_id, user.id, require_admin=True)
        resp = await client.post(
            _sb_url("team_automations"), headers=headers,
            json={
                "workspace_id": ws_id,
                "name": body.name,
                "trigger_type": body.trigger_type,
                "trigger_config": body.trigger_config,
                "action_type": body.action_type,
                "action_config": body.action_config,
                "active": True,
            },
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.patch("/automations/{auto_id}")
async def update_automation(auto_id: str, body: UpdateAutomation,
                            user: AuthUser = Depends(get_current_user)):
    if body.trigger_type and body.trigger_type not in TRIGGER_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid trigger_type")
    if body.action_type and body.action_type not in ACTION_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid action_type")

    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        auto = await _get_automation(client, headers, auto_id)
        await _check_membership(client, headers, auto["workspace_id"], user.id, require_admin=True)

        update = {k: v for k, v in body.model_dump().items() if v is not None}
        if not update:
            return auto
        resp = await client.patch(
            _sb_url("team_automations"), headers=headers,
            params={"id": f"eq.{auto_id}"},
            json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/automations/{auto_id}", status_code=204)
async def delete_automation(auto_id: str, user: AuthUser = Depends(get_current_user)):
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        auto = await _get_automation(client, headers, auto_id)
        await _check_membership(client, headers, auto["workspace_id"], user.id, require_admin=True)

        resp = await client.delete(
            _sb_url("team_automations"), headers=headers,
            params={"id": f"eq.{auto_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return None


@router.post("/internal/check-due-automations")
async def check_due_automations():
    """Internal cron endpoint — find overdue items and fire due_date_passed automations."""
    headers = _sb_headers()
    now = datetime.now(timezone.utc).isoformat()
    fired = 0
    async with httpx.AsyncClient(timeout=10.0) as client:
        auto_resp = await client.get(
            _sb_url("team_automations"), headers=headers,
            params={"trigger_type": "eq.due_date_passed", "active": "eq.true"},
        )
        if auto_resp.status_code >= 400 or not auto_resp.json():
            return {"fired": 0}

        automations = auto_resp.json()
        ws_autos: Dict[str, list] = {}
        for a in automations:
            ws_autos.setdefault(a["workspace_id"], []).append(a)

        for ws_id, autos in ws_autos.items():
            try:
                items_resp = await client.get(
                    _sb_url("team_items"), headers=headers,
                    params={
                        "workspace_id": f"eq.{ws_id}",
                        "due_date": f"lt.{now}",
                        "status": "not.in.(done,closed,dismissed,failed)",
                        "select": "id,status,priority,list_id,created_by",
                    },
                )
                if items_resp.status_code >= 400 or not items_resp.json():
                    continue
                for item in items_resp.json():
                    for auto in autos:
                        try:
                            await _execute_action(client, headers, auto, item)
                            fired += 1
                        except Exception:
                            logger.exception("Due-date action failed for item %s", item["id"])
            except Exception:
                logger.exception("Due-date check failed for workspace %s", ws_id)
    return {"fired": fired}


# ── Action executor ───────────────────────────────────────────

async def _execute_action(client: httpx.AsyncClient, headers: dict,
                          automation: dict, item: dict):
    """Execute a single automation action on an item."""
    action = automation["action_type"]
    cfg = automation.get("action_config") or {}
    item_id = item["id"]

    if action == "change_status":
        await client.patch(
            _sb_url("team_items"), headers=headers,
            params={"id": f"eq.{item_id}"},
            json={"status": cfg["status"], "updated_at": datetime.now(timezone.utc).isoformat()},
        )
    elif action == "change_priority":
        await client.patch(
            _sb_url("team_items"), headers=headers,
            params={"id": f"eq.{item_id}"},
            json={"priority": cfg["priority"], "updated_at": datetime.now(timezone.utc).isoformat()},
        )
    elif action == "add_assignee":
        await client.post(
            _sb_url("team_assignments"), headers=headers,
            json={"item_id": item_id, "assignee_id": cfg["assignee_id"]},
        )
    elif action == "send_notification":
        # Notify item creator and current assignees
        targets = set()
        if item.get("created_by"):
            targets.add(item["created_by"])
        assign_resp = await client.get(
            _sb_url("team_assignments"), headers=headers,
            params={"item_id": f"eq.{item_id}", "select": "assignee_id"},
        )
        if assign_resp.status_code < 400:
            for a in assign_resp.json():
                targets.add(a["assignee_id"])
        for uid in targets:
            await client.post(
                _sb_url("team_notifications"), headers=headers,
                json={
                    "user_id": uid,
                    "workspace_id": automation["workspace_id"],
                    "item_id": item_id,
                    "type": "automation",
                    "title": f"Automation: {automation['name']}",
                    "body": cfg.get("message", f"Automation '{automation['name']}' fired"),
                },
            )
    elif action == "move_to_list":
        await client.patch(
            _sb_url("team_items"), headers=headers,
            params={"id": f"eq.{item_id}"},
            json={"list_id": cfg["list_id"], "updated_at": datetime.now(timezone.utc).isoformat()},
        )
    elif action == "add_tag":
        await client.post(
            _sb_url("team_item_tags"), headers=headers,
            json={"item_id": item_id, "tag_id": cfg["tag_id"]},
        )


# ── Evaluate automations (called from routes_api) ────────────

async def evaluate_automations(client: httpx.AsyncClient, headers: dict,
                               workspace_id: str, item_before: Optional[dict],
                               item_after: dict, changes: dict,
                               actor_id: str, depth: int = 0):
    """Check and fire matching automations after an item change.

    Called from routes_api create_item / update_item.
    depth prevents infinite recursion (max 3 levels).
    """
    if depth >= 3:
        return

    try:
        resp = await client.get(
            _sb_url("team_automations"), headers=headers,
            params={"workspace_id": f"eq.{workspace_id}", "active": "eq.true"},
        )
        if resp.status_code >= 400 or not resp.json():
            return
    except Exception:
        return

    for auto in resp.json():
        try:
            trigger = auto["trigger_type"]
            tcfg = auto.get("trigger_config") or {}
            matched = False

            if trigger == "item_created" and item_before is None:
                matched = True

            elif trigger == "status_changed" and "status" in changes:
                matched = True
                if tcfg.get("from_status") and (item_before or {}).get("status") != tcfg["from_status"]:
                    matched = False
                if tcfg.get("to_status") and item_after.get("status") != tcfg["to_status"]:
                    matched = False

            elif trigger == "priority_changed" and "priority" in changes:
                matched = True
                if tcfg.get("from_priority") and (item_before or {}).get("priority") != tcfg["from_priority"]:
                    matched = False
                if tcfg.get("to_priority") and item_after.get("priority") != tcfg["to_priority"]:
                    matched = False

            # assignee_added and due_date_passed handled externally
            if not matched:
                continue

            await _execute_action(client, headers, auto, item_after)

            # If action mutated the item, recurse with depth+1
            if auto["action_type"] in ("change_status", "change_priority", "move_to_list"):
                new_changes = {}
                if auto["action_type"] == "change_status":
                    new_changes["status"] = (auto.get("action_config") or {}).get("status")
                elif auto["action_type"] == "change_priority":
                    new_changes["priority"] = (auto.get("action_config") or {}).get("priority")
                elif auto["action_type"] == "move_to_list":
                    new_changes["list_id"] = (auto.get("action_config") or {}).get("list_id")

                new_after = {**item_after, **new_changes}
                await evaluate_automations(
                    client, headers, workspace_id,
                    item_after, new_after, new_changes,
                    actor_id, depth=depth + 1,
                )
        except Exception:
            logger.exception("Automation %s failed on item %s", auto.get("id"), item_after.get("id"))
