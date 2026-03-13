"""OPAI Team Hub — Space hierarchy routes (folders, lists, statuses, files, templates)."""

from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from pydantic import BaseModel

import config
from auth import get_current_user, AuthUser
from audit import log_audit

router = APIRouter(prefix="/api")

TIMEOUT = 10.0

TEMPLATES = {
    "standard": {
        "description": "Development + Marketing + Admin folders",
        "folders": [
            {"name": "Development", "lists": ["Backlog", "Sprint", "Bugs"]},
            {"name": "Marketing", "lists": ["Content Calendar", "Campaigns", "Assets"]},
            {"name": "Admin", "lists": ["Meetings", "Documents"]},
        ],
    },
    "client": {
        "description": "Deliverables + Communication folders",
        "folders": [
            {"name": "Deliverables", "lists": ["Active", "Review", "Complete"]},
            {"name": "Communication", "lists": ["Meetings", "Notes", "Feedback"]},
        ],
    },
    "simple": {
        "description": "Flat lists, no folders",
        "lists": ["To Do", "In Progress", "Done"],
    },
    "kanban": {
        "description": "Single list for kanban board workflow",
        "lists": ["Board"],
    },
}


def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


async def _check_membership(client, ws_id, user_id):
    resp = await client.get(
        _sb_url("team_membership"),
        headers=_sb_headers(),
        params={"workspace_id": f"eq.{ws_id}", "user_id": f"eq.{user_id}"},
    )
    rows = resp.json() if resp.status_code < 400 else []
    if not rows:
        raise HTTPException(status_code=404, detail="Not a member of this space")
    return rows[0]["role"]


# ══════════════════════════════════════════════════════════════
# Statuses
# ══════════════════════════════════════════════════════════════


@router.get("/workspaces/{ws_id}/statuses")
async def list_statuses(ws_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)

        # Check if workspace belongs to a hub
        ws_resp = await client.get(
            _sb_url("team_workspaces"), headers=_sb_headers(),
            params={"id": f"eq.{ws_id}", "select": "hub_id"},
        )
        hub_id = None
        if ws_resp.status_code < 400 and ws_resp.json():
            hub_id = ws_resp.json()[0].get("hub_id")

        if hub_id:
            # Return hub-level statuses (shared across all hub workspaces)
            resp = await client.get(
                _sb_url("team_statuses"), headers=_sb_headers(),
                params={"hub_id": f"eq.{hub_id}", "workspace_id": "is.null", "order": "orderindex.asc"},
            )
        else:
            # Fall back to workspace-level statuses
            resp = await client.get(
                _sb_url("team_statuses"), headers=_sb_headers(),
                params={"workspace_id": f"eq.{ws_id}", "order": "orderindex.asc"},
            )

        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"statuses": resp.json(), "hub_id": hub_id}


class CreateStatus(BaseModel):
    name: str
    color: str = "#595d66"
    type: str = "active"


@router.post("/workspaces/{ws_id}/statuses")
async def create_status(ws_id: str, req: CreateStatus, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        role = await _check_membership(client, ws_id, user.id)
        if role != "owner":
            raise HTTPException(status_code=403, detail="Only the workspace owner can manage statuses")
        # Get max orderindex
        existing = await client.get(
            _sb_url("team_statuses"),
            headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "order": "orderindex.desc", "limit": "1"},
        )
        max_order = existing.json()[0]["orderindex"] + 1 if existing.json() else 0
        resp = await client.post(
            _sb_url("team_statuses"),
            headers=_sb_headers(),
            json={"workspace_id": ws_id, "name": req.name, "color": req.color,
                  "type": req.type, "orderindex": max_order},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


class UpdateStatus(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    type: Optional[str] = None
    orderindex: Optional[int] = None


@router.patch("/statuses/{status_id}")
async def update_status(status_id: str, req: UpdateStatus, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        st = await client.get(_sb_url("team_statuses"), headers=_sb_headers(),
                              params={"id": f"eq.{status_id}"})
        if st.status_code >= 400 or not st.json():
            raise HTTPException(status_code=404, detail="Status not found")
        role = await _check_membership(client, st.json()[0]["workspace_id"], user.id)
        if role != "owner":
            raise HTTPException(status_code=403, detail="Only the workspace owner can manage statuses")
        update = {k: v for k, v in req.model_dump().items() if v is not None}
        if not update:
            return st.json()[0]
        resp = await client.patch(
            _sb_url("team_statuses"), headers=_sb_headers(),
            params={"id": f"eq.{status_id}"}, json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/statuses/{status_id}")
async def delete_status(status_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        st = await client.get(_sb_url("team_statuses"), headers=_sb_headers(),
                              params={"id": f"eq.{status_id}"})
        if st.status_code >= 400 or not st.json():
            raise HTTPException(status_code=404, detail="Status not found")
        role = await _check_membership(client, st.json()[0]["workspace_id"], user.id)
        if role != "owner":
            raise HTTPException(status_code=403, detail="Only the workspace owner can manage statuses")
        await client.delete(_sb_url("team_statuses"), headers=_sb_headers(),
                            params={"id": f"eq.{status_id}"})
        return {"ok": True}


# ══════════════════════════════════════════════════════════════
# Calendar
# ══════════════════════════════════════════════════════════════


@router.get("/workspaces/{ws_id}/gantt")
async def gantt_data(ws_id: str, user: AuthUser = Depends(get_current_user)):
    """Return items with date ranges + dependencies for Gantt rendering."""
    headers = _sb_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        # Items with at least a due_date or start_date
        items_resp = await client.get(
            _sb_url("team_items"), headers=headers,
            params={
                "workspace_id": f"eq.{ws_id}",
                "parent_id": "is.null",
                "select": "id,title,status,priority,start_date,due_date,time_estimate,time_logged,list_id,custom_id",
                "order": "start_date.asc.nullslast,due_date.asc.nullslast",
                "limit": "500",
            },
        )
        items = items_resp.json() if items_resp.status_code < 400 else []
        # Dependencies for this workspace's items
        item_ids = [i["id"] for i in items]
        deps = []
        if item_ids:
            deps_resp = await client.get(
                _sb_url("team_item_dependencies"), headers=headers,
                params={"source_id": f"in.({','.join(item_ids)})"},
            )
            deps = deps_resp.json() if deps_resp.status_code < 400 else []
        # Statuses for coloring
        st_resp = await client.get(
            _sb_url("team_statuses"), headers=headers,
            params={"workspace_id": f"eq.{ws_id}", "order": "orderindex.asc"},
        )
        statuses = st_resp.json() if st_resp.status_code < 400 else []
        return {"items": items, "dependencies": deps, "statuses": statuses}


@router.get("/workspaces/{ws_id}/calendar")
async def calendar_items(
    ws_id: str,
    month: str = Query(..., description="YYYY-MM"),
    user: AuthUser = Depends(get_current_user),
):
    """Get items with due dates for a given month (with ±7 day spillover)."""
    from datetime import datetime, timedelta

    try:
        dt = datetime.strptime(month, "%Y-%m")
    except ValueError:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    # First day of month minus 7 days
    start = dt.replace(day=1) - timedelta(days=7)
    # Last day of month plus 7 days
    if dt.month == 12:
        end = dt.replace(year=dt.year + 1, month=1, day=1) + timedelta(days=7)
    else:
        end = dt.replace(month=dt.month + 1, day=1) + timedelta(days=7)

    start_str = start.strftime("%Y-%m-%d")
    end_str = end.strftime("%Y-%m-%d")

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        resp = await client.get(
            _sb_url("team_items"), headers=_sb_headers(),
            params={
                "workspace_id": f"eq.{ws_id}",
                "due_date": f"gte.{start_str}",
                "select": "id,title,status,priority,due_date,follow_up_date,list_id",
                "order": "due_date.asc",
                "limit": "500",
            },
            # PostgREST: duplicate param for range filter
            # We use headers to add a second filter
        )
        # Filter end date client-side since PostgREST doesn't support duplicate params easily
        items = [i for i in (resp.json() if resp.status_code < 400 else []) if i.get("due_date", "") <= end_str]
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        # Fetch statuses for coloring
        st_resp = await client.get(
            _sb_url("team_statuses"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "order": "orderindex.asc"},
        )
        statuses = st_resp.json() if st_resp.status_code < 400 else []

        return {"items": items, "statuses": statuses}


@router.get("/calendar/all")
async def calendar_all_spaces(
    month: str = Query(..., description="YYYY-MM"),
    user: AuthUser = Depends(get_current_user),
):
    """Get items with due dates across ALL user spaces for a given month."""
    from datetime import datetime, timedelta

    try:
        dt = datetime.strptime(month, "%Y-%m")
    except ValueError:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    start = dt.replace(day=1) - timedelta(days=7)
    if dt.month == 12:
        end = dt.replace(year=dt.year + 1, month=1, day=1) + timedelta(days=7)
    else:
        end = dt.replace(month=dt.month + 1, day=1) + timedelta(days=7)

    start_str = start.strftime("%Y-%m-%d")
    end_str = end.strftime("%Y-%m-%d")

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # Get all workspaces the user is a member of
        mem_resp = await client.get(
            _sb_url("team_membership"), headers=_sb_headers(),
            params={"user_id": f"eq.{user.id}", "select": "workspace_id"},
        )
        memberships = mem_resp.json() if mem_resp.status_code < 400 else []
        ws_ids = [m["workspace_id"] for m in memberships]

        if not ws_ids:
            return {"items": [], "statuses": [], "spaces": []}

        # Fetch items across all spaces with due dates in range
        ws_filter = ",".join(ws_ids)
        resp = await client.get(
            _sb_url("team_items"), headers=_sb_headers(),
            params={
                "workspace_id": f"in.({ws_filter})",
                "due_date": f"gte.{start_str}",
                "select": "id,title,status,priority,due_date,follow_up_date,list_id,workspace_id",
                "order": "due_date.asc",
                "limit": "500",
            },
        )
        items = [i for i in (resp.json() if resp.status_code < 400 else []) if i.get("due_date", "") <= end_str]

        # Fetch statuses for all spaces (for coloring)
        st_resp = await client.get(
            _sb_url("team_statuses"), headers=_sb_headers(),
            params={
                "workspace_id": f"in.({ws_filter})",
                "order": "orderindex.asc",
            },
        )
        statuses = st_resp.json() if st_resp.status_code < 400 else []

        # Fetch space names for labels
        ws_resp = await client.get(
            _sb_url("team_workspaces"), headers=_sb_headers(),
            params={
                "id": f"in.({ws_filter})",
                "select": "id,name,color",
            },
        )
        spaces = ws_resp.json() if ws_resp.status_code < 400 else []

        return {"items": items, "statuses": statuses, "spaces": spaces}


# ══════════════════════════════════════════════════════════════
# Folders
# ══════════════════════════════════════════════════════════════


@router.get("/workspaces/{ws_id}/folders")
async def list_folders(ws_id: str, user: AuthUser = Depends(get_current_user)):
    """Get folders + lists hierarchy for a workspace."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        folders_resp = await client.get(
            _sb_url("team_folders"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "order": "orderindex.asc,name.asc"},
        )
        lists_resp = await client.get(
            _sb_url("team_lists"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "order": "orderindex.asc,name.asc"},
        )
        folders = folders_resp.json() if folders_resp.status_code < 400 else []
        all_lists = lists_resp.json() if lists_resp.status_code < 400 else []

        # Group lists by folder
        folder_lists = {}
        folderless = []
        for lst in all_lists:
            if lst.get("folder_id"):
                folder_lists.setdefault(lst["folder_id"], []).append(lst)
            else:
                folderless.append(lst)

        for f in folders:
            f["lists"] = folder_lists.get(f["id"], [])

        # Count items per list (and uncategorized)
        items_resp = await client.get(
            _sb_url("team_items"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "select": "list_id"},
        )
        items = items_resp.json() if items_resp.status_code < 400 else []
        count_map = {}
        uncategorized_count = 0
        for item in items:
            lid = item.get("list_id")
            if lid:
                count_map[lid] = count_map.get(lid, 0) + 1
            else:
                uncategorized_count += 1

        for lst in all_lists:
            lst["task_count"] = count_map.get(lst["id"], 0)

        # Add virtual "All Items" list for items with no list_id
        if uncategorized_count > 0:
            folderless.insert(0, {
                "id": f"__uncategorized__{ws_id}",
                "workspace_id": ws_id,
                "folder_id": None,
                "name": "All Items",
                "orderindex": -1,
                "task_count": uncategorized_count,
            })

        # Fetch docs for the workspace
        docs_resp = await client.get(
            _sb_url("team_docs"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "order": "updated_at.desc",
                    "select": "id,title,folder_id,list_id,item_id,source,updated_at"},
        )
        all_docs = docs_resp.json() if docs_resp.status_code < 400 else []

        # Group docs by folder
        folder_docs = {}
        folderless_docs = []
        for doc in all_docs:
            if doc.get("folder_id"):
                folder_docs.setdefault(doc["folder_id"], []).append(doc)
            elif not doc.get("list_id") and not doc.get("item_id"):
                folderless_docs.append(doc)

        for f in folders:
            f["docs"] = folder_docs.get(f["id"], [])

        return {"folders": folders, "folderless_lists": folderless, "docs": folderless_docs}


class CreateFolder(BaseModel):
    name: str


class UpdateFolder(BaseModel):
    name: Optional[str] = None
    workspace_id: Optional[str] = None


@router.post("/workspaces/{ws_id}/folders")
async def create_folder(ws_id: str, req: CreateFolder, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        resp = await client.post(
            _sb_url("team_folders"), headers=_sb_headers(),
            json={"workspace_id": ws_id, "name": req.name, "created_by": user.id},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.patch("/folders/{folder_id}")
async def update_folder(folder_id: str, req: UpdateFolder, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        f = await client.get(_sb_url("team_folders"), headers=_sb_headers(),
                             params={"id": f"eq.{folder_id}"})
        if not f.json():
            raise HTTPException(status_code=404, detail="Folder not found")
        await _check_membership(client, f.json()[0]["workspace_id"], user.id)
        update = {}
        if req.name is not None:
            update["name"] = req.name
        if req.workspace_id is not None:
            # Verify membership in target space
            await _check_membership(client, req.workspace_id, user.id)
            update["workspace_id"] = req.workspace_id
        if not update:
            return f.json()[0]
        resp = await client.patch(
            _sb_url("team_folders"), headers=_sb_headers(),
            params={"id": f"eq.{folder_id}"}, json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        f = await client.get(_sb_url("team_folders"), headers=_sb_headers(),
                             params={"id": f"eq.{folder_id}"})
        if not f.json():
            raise HTTPException(status_code=404, detail="Folder not found")
        role = await _check_membership(client, f.json()[0]["workspace_id"], user.id)
        if role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Admin access required")
        await client.delete(_sb_url("team_folders"), headers=_sb_headers(),
                            params={"id": f"eq.{folder_id}"})
        return {"ok": True}


# ══════════════════════════════════════════════════════════════
# Lists
# ══════════════════════════════════════════════════════════════


class CreateList(BaseModel):
    name: str
    folder_id: Optional[str] = None


class UpdateList(BaseModel):
    name: Optional[str] = None
    folder_id: Optional[str] = None
    workspace_id: Optional[str] = None
    id_prefix: Optional[str] = None


@router.post("/workspaces/{ws_id}/lists")
async def create_list(ws_id: str, req: CreateList, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        data = {"workspace_id": ws_id, "name": req.name, "created_by": user.id}
        if req.folder_id:
            data["folder_id"] = req.folder_id
        resp = await client.post(_sb_url("team_lists"), headers=_sb_headers(), json=data)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.get("/lists/{list_id}/items")
async def list_items_by_list(
    list_id: str,
    status: Optional[str] = None,
    include_subtasks: bool = Query(default=False),
    limit: int = Query(default=200, le=500),
    user: AuthUser = Depends(get_current_user),
):
    """Get all items in a specific list (or uncategorized items)."""
    item_select = "id,type,title,description,status,priority,due_date,follow_up_date,created_by,source,list_id,folder_id,workspace_id,parent_id,custom_id,created_at,updated_at"
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # Handle virtual "uncategorized" list (items with no list_id)
        is_uncategorized = list_id.startswith("__uncategorized__")
        if is_uncategorized:
            ws_id = list_id.replace("__uncategorized__", "")
            await _check_membership(client, ws_id, user.id)
            params = {
                "workspace_id": f"eq.{ws_id}",
                "list_id": "is.null",
                "select": item_select,
                "order": "created_at.desc",
                "limit": str(limit),
            }
        else:
            # Get list to verify workspace
            lst = await client.get(_sb_url("team_lists"), headers=_sb_headers(),
                                   params={"id": f"eq.{list_id}"})
            if lst.status_code >= 400 or not lst.json():
                raise HTTPException(status_code=404, detail="List not found")
            ws_id = lst.json()[0]["workspace_id"]
            await _check_membership(client, ws_id, user.id)
            params = {
                "list_id": f"eq.{list_id}",
                "select": item_select,
                "order": "created_at.desc",
                "limit": str(limit),
            }

        # By default, only show top-level items (not subtasks)
        if not include_subtasks:
            params["parent_id"] = "is.null"

        if status:
            params["status"] = f"eq.{status}"

        resp = await client.get(_sb_url("team_items"), headers=_sb_headers(), params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        items = resp.json()

        # Fetch assignments for all items
        if items:
            item_ids = [i["id"] for i in items]
            assign_resp = await client.get(
                _sb_url("team_assignments"), headers=_sb_headers(),
                params={"item_id": f"in.({','.join(item_ids)})",
                        "select": "item_id,assignee_type,assignee_id"},
            )
            assigns = assign_resp.json() if assign_resp.status_code < 400 else []
            assign_map = {}
            for a in assigns:
                assign_map.setdefault(a["item_id"], []).append(a)

            # Fetch tags
            tags_resp = await client.get(
                _sb_url("team_item_tags"), headers=_sb_headers(),
                params={"item_id": f"in.({','.join(item_ids)})", "select": "item_id,tag_id"},
            )
            item_tag_ids = {}
            all_tag_ids = set()
            for it in (tags_resp.json() if tags_resp.status_code < 400 else []):
                item_tag_ids.setdefault(it["item_id"], []).append(it["tag_id"])
                all_tag_ids.add(it["tag_id"])

            tag_map = {}
            if all_tag_ids:
                tg_resp = await client.get(
                    _sb_url("team_tags"), headers=_sb_headers(),
                    params={"id": f"in.({','.join(all_tag_ids)})", "select": "id,name,color"},
                )
                for tg in (tg_resp.json() if tg_resp.status_code < 400 else []):
                    tag_map[tg["id"]] = tg

            # Fetch subtask counts
            sub_resp = await client.get(
                _sb_url("team_items"), headers=_sb_headers(),
                params={
                    "parent_id": f"in.({','.join(item_ids)})",
                    "select": "parent_id,status",
                },
            )
            sub_counts = {}
            sub_done = {}
            for s in (sub_resp.json() if sub_resp.status_code < 400 else []):
                pid = s["parent_id"]
                sub_counts[pid] = sub_counts.get(pid, 0) + 1
                if s.get("status") in ("done", "closed"):
                    sub_done[pid] = sub_done.get(pid, 0) + 1

            # Enrich items
            for item in items:
                item["assignees"] = assign_map.get(item["id"], [])
                item["tags"] = [tag_map[tid] for tid in item_tag_ids.get(item["id"], []) if tid in tag_map]
                item["subtask_count"] = sub_counts.get(item["id"], 0)
                item["subtask_done"] = sub_done.get(item["id"], 0)

        # Fetch statuses for this workspace
        st_resp = await client.get(
            _sb_url("team_statuses"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "order": "orderindex.asc"},
        )
        statuses = st_resp.json() if st_resp.status_code < 400 else []

        list_info = {"id": list_id, "name": "All Items", "workspace_id": ws_id} if is_uncategorized else lst.json()[0]
        return {"items": items, "statuses": statuses, "list": list_info}


@router.patch("/lists/{list_id}")
async def update_list(list_id: str, req: UpdateList, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        lst = await client.get(_sb_url("team_lists"), headers=_sb_headers(),
                               params={"id": f"eq.{list_id}"})
        if not lst.json():
            raise HTTPException(status_code=404, detail="List not found")
        await _check_membership(client, lst.json()[0]["workspace_id"], user.id)
        update = {}
        if req.name is not None:
            update["name"] = req.name
        if req.id_prefix is not None:
            update["id_prefix"] = req.id_prefix if req.id_prefix else None
        if req.folder_id is not None:
            update["folder_id"] = req.folder_id if req.folder_id else None
        if req.workspace_id is not None:
            await _check_membership(client, req.workspace_id, user.id)
            update["workspace_id"] = req.workspace_id
            # Clear folder_id when moving across spaces (folder won't exist in new space)
            if req.folder_id is None:
                update["folder_id"] = None
        if not update:
            return lst.json()[0]
        resp = await client.patch(
            _sb_url("team_lists"), headers=_sb_headers(),
            params={"id": f"eq.{list_id}"}, json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/lists/{list_id}")
async def delete_list(list_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        lst = await client.get(_sb_url("team_lists"), headers=_sb_headers(),
                               params={"id": f"eq.{list_id}"})
        if not lst.json():
            raise HTTPException(status_code=404, detail="List not found")
        role = await _check_membership(client, lst.json()[0]["workspace_id"], user.id)
        if role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Admin access required")
        await client.delete(_sb_url("team_lists"), headers=_sb_headers(),
                            params={"id": f"eq.{list_id}"})
        return {"ok": True}


# ══════════════════════════════════════════════════════════════
# Create item in list
# ══════════════════════════════════════════════════════════════


class CreateItemInList(BaseModel):
    title: str
    type: str = "task"
    description: str = ""
    status: str = "open"
    priority: str = "medium"
    due_date: Optional[str] = None
    parent_id: Optional[str] = None


@router.post("/lists/{list_id}/items")
async def create_item_in_list(list_id: str, req: CreateItemInList, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        lst = await client.get(_sb_url("team_lists"), headers=_sb_headers(),
                               params={"id": f"eq.{list_id}"})
        if not lst.json():
            raise HTTPException(status_code=404, detail="List not found")
        lst_data = lst.json()[0]
        await _check_membership(client, lst_data["workspace_id"], user.id)

        item_data = {
            "workspace_id": lst_data["workspace_id"],
            "list_id": list_id,
            "folder_id": lst_data.get("folder_id"),
            "type": req.type,
            "title": req.title,
            "description": req.description,
            "status": req.status,
            "priority": req.priority,
            "source": "web",
            "created_by": user.id,
        }
        if req.due_date:
            item_data["due_date"] = req.due_date
        if req.parent_id:
            item_data["parent_id"] = req.parent_id

        # Auto-generate custom_id if list has id_prefix
        if lst_data.get("id_prefix"):
            prefix = lst_data["id_prefix"]
            new_counter = (lst_data.get("id_counter") or 0) + 1
            item_data["custom_id"] = f"{prefix}-{new_counter:03d}"
            await client.patch(
                _sb_url("team_lists"), headers=_sb_headers(),
                params={"id": f"eq.{list_id}"},
                json={"id_counter": new_counter},
            )

        resp = await client.post(_sb_url("team_items"), headers=_sb_headers(), json=item_data)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        item = resp.json()[0]

        # Auto-assign creator so the item appears in their dashboard tiles
        try:
            await client.post(_sb_url("team_assignments"), headers=_sb_headers(), json={
                "item_id": item["id"],
                "assignee_type": "user",
                "assignee_id": user.id,
                "assigned_by": user.id,
            })
        except Exception:
            pass  # non-critical — item still created

        return item


# ══════════════════════════════════════════════════════════════
# Files
# ══════════════════════════════════════════════════════════════


@router.get("/workspaces/{ws_id}/files")
async def list_files(
    ws_id: str,
    folder_id: Optional[str] = None,
    list_id: Optional[str] = None,
    item_id: Optional[str] = None,
    user: AuthUser = Depends(get_current_user),
):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        params = {"workspace_id": f"eq.{ws_id}", "order": "created_at.desc"}
        if folder_id:
            params["folder_id"] = f"eq.{folder_id}"
        if list_id:
            params["list_id"] = f"eq.{list_id}"
        if item_id:
            params["item_id"] = f"eq.{item_id}"
        resp = await client.get(_sb_url("team_files"), headers=_sb_headers(), params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        files = resp.json()
        # Enrich with profile info
        if files:
            uploader_ids = list({f["uploaded_by"] for f in files})
            profiles = await client.get(
                _sb_url("profiles"), headers=_sb_headers(),
                params={"id": f"in.({','.join(uploader_ids)})", "select": "id,display_name,email"},
            )
            pmap = {p["id"]: p for p in (profiles.json() if profiles.status_code < 400 else [])}
            for f in files:
                p = pmap.get(f["uploaded_by"], {})
                f["uploader_name"] = p.get("display_name") or p.get("email", "Unknown")

        return {"files": files}


class RegisterFile(BaseModel):
    file_name: str
    file_path: str
    file_size: int = 0
    mime_type: str = "application/octet-stream"
    folder_id: Optional[str] = None
    list_id: Optional[str] = None
    item_id: Optional[str] = None


@router.post("/workspaces/{ws_id}/files")
async def register_file(ws_id: str, req: RegisterFile, user: AuthUser = Depends(get_current_user)):
    """Register a file uploaded to Supabase Storage in the team_files table."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        data = {
            "workspace_id": ws_id,
            "file_name": req.file_name,
            "file_path": req.file_path,
            "file_size": req.file_size,
            "mime_type": req.mime_type,
            "uploaded_by": user.id,
            "shared": True,
        }
        if req.folder_id:
            data["folder_id"] = req.folder_id
        if req.list_id:
            data["list_id"] = req.list_id
        if req.item_id:
            data["item_id"] = req.item_id
        resp = await client.post(_sb_url("team_files"), headers=_sb_headers(), json=data)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/files/{file_id}")
async def delete_file(file_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        f = await client.get(_sb_url("team_files"), headers=_sb_headers(),
                             params={"id": f"eq.{file_id}"})
        if not f.json():
            raise HTTPException(status_code=404, detail="File not found")
        fdata = f.json()[0]
        role = await _check_membership(client, fdata["workspace_id"], user.id)
        if fdata["uploaded_by"] != user.id and role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Cannot delete this file")

        # Delete from Storage (non-fatal — file may already be gone)
        try:
            await client.delete(
                f"{config.SUPABASE_URL}/storage/v1/object/team-files/{fdata['file_path']}",
                headers={"apikey": config.SUPABASE_ANON_KEY,
                         "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}"},
            )
        except Exception:
            pass  # Storage file missing is fine, still delete the DB record
        # Delete record
        await client.delete(_sb_url("team_files"), headers=_sb_headers(),
                            params={"id": f"eq.{file_id}"})
        return {"ok": True}


# ══════════════════════════════════════════════════════════════
# Dashboards
# ══════════════════════════════════════════════════════════════


@router.get("/workspaces/{ws_id}/dashboard")
async def get_dashboard(ws_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        dash = await client.get(
            _sb_url("team_dashboards"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "limit": "1"},
        )
        if dash.status_code >= 400 or not dash.json():
            return {"dashboard": None, "widgets": []}
        dashboard = dash.json()[0]

        widgets = await client.get(
            _sb_url("team_dashboard_widgets"), headers=_sb_headers(),
            params={"dashboard_id": f"eq.{dashboard['id']}"},
        )
        dashboard["widgets"] = widgets.json() if widgets.status_code < 400 else []

        # Gather data for widgets
        items_resp = await client.get(
            _sb_url("team_items"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}",
                    "select": "id,title,status,priority,due_date,created_by,created_at,updated_at"},
        )
        items = items_resp.json() if items_resp.status_code < 400 else []

        # Status counts
        status_counts = {}
        priority_counts = {}
        for item in items:
            s = item.get("status", "open")
            status_counts[s] = status_counts.get(s, 0) + 1
            p = item.get("priority", "medium")
            priority_counts[p] = priority_counts.get(p, 0) + 1

        # Due soon (next 7 days) — compare as date strings since due_date
        # is a Supabase date column ("YYYY-MM-DD", no timezone)
        from datetime import date, timedelta
        today_str = date.today().isoformat()
        week_str = (date.today() + timedelta(days=7)).isoformat()
        due_soon = []
        for item in items:
            dd = item.get("due_date")
            if dd:
                # Normalize: strip any time/TZ suffix, keep YYYY-MM-DD
                dd_date = dd[:10]
                if today_str <= dd_date <= week_str:
                    due_soon.append(item)
        due_soon.sort(key=lambda x: x.get("due_date", ""))

        # Open tasks (not done/closed/Complete)
        closed_statuses = {"done", "closed", "Complete", "Approved"}
        open_tasks = [i for i in items if i.get("status") not in closed_statuses]
        open_tasks.sort(key=lambda x: x.get("updated_at", ""), reverse=True)

        # Recent activity
        activity_resp = await client.get(
            _sb_url("team_activity"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "order": "created_at.desc", "limit": "10"},
        )
        activity = activity_resp.json() if activity_resp.status_code < 400 else []

        # Statuses with colors
        st_resp = await client.get(
            _sb_url("team_statuses"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "order": "orderindex.asc"},
        )
        statuses = st_resp.json() if st_resp.status_code < 400 else []

        return {
            "dashboard": dashboard,
            "data": {
                "status_counts": status_counts,
                "priority_counts": priority_counts,
                "open_tasks": open_tasks[:20],
                "due_soon": due_soon[:10],
                "activity": activity,
                "total_items": len(items),
                "open_count": len(open_tasks),
                "statuses": statuses,
            },
        }


class AddWidget(BaseModel):
    widget_type: str
    title: str = ""
    config: dict = {}
    position: dict = {"x": 0, "y": 0, "w": 4, "h": 3}


@router.post("/workspaces/{ws_id}/dashboard/widgets")
async def add_widget(ws_id: str, req: AddWidget, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        role = await _check_membership(client, ws_id, user.id)
        if role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Admin access required")
        dash = await client.get(
            _sb_url("team_dashboards"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "limit": "1"},
        )
        if not dash.json():
            raise HTTPException(status_code=404, detail="No dashboard found")
        resp = await client.post(
            _sb_url("team_dashboard_widgets"), headers=_sb_headers(),
            json={"dashboard_id": dash.json()[0]["id"], "widget_type": req.widget_type,
                  "title": req.title, "config": req.config, "position": req.position},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/dashboard/widgets/{widget_id}")
async def remove_widget(widget_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        w = await client.get(_sb_url("team_dashboard_widgets"), headers=_sb_headers(),
                             params={"id": f"eq.{widget_id}"})
        if not w.json():
            raise HTTPException(status_code=404, detail="Widget not found")
        await client.delete(_sb_url("team_dashboard_widgets"), headers=_sb_headers(),
                            params={"id": f"eq.{widget_id}"})
        return {"ok": True}


# ══════════════════════════════════════════════════════════════
# Templates
# ══════════════════════════════════════════════════════════════


@router.get("/templates")
async def list_templates(user: AuthUser = Depends(get_current_user)):
    """Return builtin templates + user-saved templates grouped as personal/shared."""
    builtin = {k: {"name": k, "description": v.get("description", "")} for k, v in TEMPLATES.items()}
    personal = []
    shared = []
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                _sb_url("team_templates"), headers=_sb_headers(),
                params={"or": f"(owner_id.eq.{user.id},shared.eq.true)", "order": "created_at.desc"},
            )
            if resp.status_code < 400:
                all_tpls = resp.json()
                # Collect unique owner IDs for shared templates to resolve display names
                owner_ids = {t["owner_id"] for t in all_tpls if t.get("shared") and t["owner_id"] != user.id}
                pmap = {}
                if owner_ids:
                    presp = await client.get(
                        _sb_url("profiles"), headers=_sb_headers(),
                        params={"id": f"in.({','.join(owner_ids)})", "select": "id,display_name,email"},
                    )
                    if presp.status_code < 400:
                        pmap = {p["id"]: p.get("display_name") or p.get("email", "Unknown") for p in presp.json()}
                for t in all_tpls:
                    if t["owner_id"] == user.id and not t.get("shared"):
                        personal.append(t)
                    else:
                        t["owner_name"] = pmap.get(t["owner_id"], "You") if t["owner_id"] != user.id else "You"
                        shared.append(t)
    except Exception:
        pass
    return {"builtin": builtin, "saved": personal + shared, "personal": personal, "shared": shared}


class SaveTemplate(BaseModel):
    name: str
    description: str = ""
    shared: bool = False
    structure: dict = {}  # {folders:[{name,lists:[]}], lists:[]}


@router.post("/templates")
async def save_template(req: SaveTemplate, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            _sb_url("team_templates"), headers=_sb_headers(),
            json={"name": req.name, "description": req.description, "shared": req.shared,
                  "structure": req.structure, "owner_id": user.id},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


class UpdateTemplate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    shared: Optional[bool] = None
    structure: Optional[dict] = None


@router.patch("/templates/{tpl_id}")
async def update_template(tpl_id: str, req: UpdateTemplate, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        existing = await client.get(
            _sb_url("team_templates"), headers=_sb_headers(),
            params={"id": f"eq.{tpl_id}"},
        )
        if existing.status_code >= 400 or not existing.json():
            raise HTTPException(status_code=404, detail="Template not found")
        if existing.json()[0]["owner_id"] != user.id:
            raise HTTPException(status_code=403, detail="Not template owner")
        update = {k: v for k, v in req.model_dump().items() if v is not None}
        if not update:
            return existing.json()[0]
        resp = await client.patch(
            _sb_url("team_templates"), headers=_sb_headers(),
            params={"id": f"eq.{tpl_id}"}, json=update,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.delete("/templates/{tpl_id}")
async def delete_template(tpl_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        existing = await client.get(
            _sb_url("team_templates"), headers=_sb_headers(),
            params={"id": f"eq.{tpl_id}"},
        )
        if existing.status_code >= 400 or not existing.json():
            raise HTTPException(status_code=404, detail="Template not found")
        if existing.json()[0]["owner_id"] != user.id:
            raise HTTPException(status_code=403, detail="Not template owner")
        await client.delete(
            _sb_url("team_templates"), headers=_sb_headers(),
            params={"id": f"eq.{tpl_id}"},
        )
        return {"ok": True}


class ApplyTemplate(BaseModel):
    space_name: str
    template: str = ""       # builtin key (e.g. "standard")
    template_id: str = ""    # saved template UUID
    color: str = "#6c5ce7"
    icon: str = ""
    prefix: str = ""         # optional name prefix for folders/lists
    structure: Optional[dict] = None  # inline structure (bypasses template lookup)


def _prefixed(name: str, prefix: str) -> str:
    """Prepend prefix to a name if provided."""
    if prefix:
        return f"{prefix} - {name}"
    return name


@router.post("/templates/apply")
async def apply_template(req: ApplyTemplate, user: AuthUser = Depends(get_current_user)):
    # Resolve structure: inline > saved template > builtin > blank
    structure = None
    if req.structure is not None:
        structure = req.structure
    elif req.template_id:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                _sb_url("team_templates"), headers=_sb_headers(),
                params={"id": f"eq.{req.template_id}"},
            )
            if resp.status_code >= 400 or not resp.json():
                raise HTTPException(status_code=404, detail="Saved template not found")
            structure = resp.json()[0].get("structure", {})
    elif req.template:
        structure = TEMPLATES.get(req.template)
        if not structure:
            raise HTTPException(status_code=400, detail=f"Unknown template: {req.template}")
    else:
        structure = {}  # blank space, no folders/lists

    prefix = req.prefix.strip() if req.prefix else ""

    import time
    slug = req.space_name.lower().replace(" ", "-")[:30] + "-" + str(int(time.time()) % 100000)

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Create workspace/space
        ws_resp = await client.post(
            _sb_url("team_workspaces"), headers=_sb_headers(),
            json={"name": req.space_name, "slug": slug, "icon": req.icon or "",
                  "color": req.color, "owner_id": user.id},
        )
        if ws_resp.status_code >= 400:
            raise HTTPException(status_code=ws_resp.status_code, detail=ws_resp.text)
        ws = ws_resp.json()[0]
        ws_id = ws["id"]

        # Add creator as owner
        await client.post(
            _sb_url("team_membership"), headers=_sb_headers(),
            json={"user_id": user.id, "workspace_id": ws_id, "role": "owner"},
        )

        created = {"space": req.space_name, "folders": [], "lists": [], "tasks": []}

        # Helper to create tasks inside a list
        async def _create_tasks(tasks, list_id, folder_id=None):
            for task_title in tasks:
                t_resp = await client.post(
                    _sb_url("team_items"), headers=_sb_headers(),
                    json={
                        "workspace_id": ws_id, "list_id": list_id,
                        "folder_id": folder_id, "type": "task",
                        "title": task_title, "status": "open",
                        "priority": "medium", "source": "template",
                        "created_by": user.id,
                    },
                )
                if t_resp.status_code < 400:
                    created["tasks"].append(task_title)

        # Create folders and their lists
        for folder_def in structure.get("folders", []):
            folder_name = _prefixed(folder_def["name"], prefix)
            f_resp = await client.post(
                _sb_url("team_folders"), headers=_sb_headers(),
                json={"workspace_id": ws_id, "name": folder_name, "created_by": user.id},
            )
            if f_resp.status_code >= 400:
                continue
            folder = f_resp.json()[0]
            created["folders"].append(folder_name)
            for list_entry in folder_def.get("lists", []):
                # Support both string (legacy) and object {name, tasks} format
                if isinstance(list_entry, str):
                    list_name = list_entry
                    tasks = []
                else:
                    list_name = list_entry.get("name", list_entry) if isinstance(list_entry, dict) else str(list_entry)
                    tasks = list_entry.get("tasks", []) if isinstance(list_entry, dict) else []
                display_name = _prefixed(list_name, prefix)
                l_resp = await client.post(
                    _sb_url("team_lists"), headers=_sb_headers(),
                    json={"workspace_id": ws_id, "folder_id": folder["id"],
                          "name": display_name, "created_by": user.id},
                )
                if l_resp.status_code < 400:
                    created["lists"].append(display_name)
                    if tasks:
                        await _create_tasks(tasks, l_resp.json()[0]["id"], folder["id"])

        # Create folderless lists
        for list_entry in structure.get("lists", []):
            if isinstance(list_entry, str):
                list_name = list_entry
                tasks = []
            else:
                list_name = list_entry.get("name", list_entry) if isinstance(list_entry, dict) else str(list_entry)
                tasks = list_entry.get("tasks", []) if isinstance(list_entry, dict) else []
            display_name = _prefixed(list_name, prefix)
            l_resp = await client.post(
                _sb_url("team_lists"), headers=_sb_headers(),
                json={"workspace_id": ws_id, "name": display_name, "created_by": user.id},
            )
            if l_resp.status_code < 400:
                created["lists"].append(display_name)
                if tasks:
                    await _create_tasks(tasks, l_resp.json()[0]["id"])

        try:
            log_audit(
                tier="system",
                service="opai-team-hub",
                event="space-created",
                status="completed",
                summary=f"Space created: {req.space_name}",
                details={"workspace_id": ws_id, "template": req.template or req.template_id or "custom"},
            )
        except Exception:
            pass

        return {"ok": True, "workspace": ws, "created": created}


# ══════════════════════════════════════════════════════════════
# Invite (platform-level)
# ══════════════════════════════════════════════════════════════


class InviteUser(BaseModel):
    email: str
    workspace_id: Optional[str] = None
    role: str = "member"


@router.post("/invite")
async def invite_user(req: InviteUser, user: AuthUser = Depends(get_current_user)):
    """Invite a user to the OPAI platform + optionally a workspace."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # Try Supabase auth invite
        resp = await client.post(
            f"{config.SUPABASE_URL}/auth/v1/invite",
            headers={"apikey": config.SUPABASE_ANON_KEY,
                     "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
                     "Content-Type": "application/json"},
            json={"email": req.email},
        )
        invite_type = "invite"
        if resp.status_code >= 400:
            # User might already exist — generate magic link
            link_resp = await client.post(
                f"{config.SUPABASE_URL}/auth/v1/admin/generate_link",
                headers={"apikey": config.SUPABASE_ANON_KEY,
                         "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
                         "Content-Type": "application/json"},
                json={"type": "magiclink", "email": req.email},
            )
            if link_resp.status_code >= 400:
                raise HTTPException(status_code=400, detail="Failed to invite user")
            invite_type = "existing_user"

        # If workspace specified, create workspace invitation
        if req.workspace_id:
            # Find user by email
            profile = await client.get(
                _sb_url("profiles"), headers=_sb_headers(),
                params={"email": f"eq.{req.email}", "select": "id"},
            )
            invitee_id = profile.json()[0]["id"] if profile.json() else None

            await client.post(
                _sb_url("team_invitations"), headers=_sb_headers(),
                json={"workspace_id": req.workspace_id, "inviter_id": user.id,
                      "invitee_id": invitee_id, "invitee_email": req.email, "role": req.role},
            )

        return {"ok": True, "type": invite_type}


# ══════════════════════════════════════════════════════════════
# Workspace Assignees (OPAI profiles + ClickUp usernames)
# ══════════════════════════════════════════════════════════════


@router.get("/workspaces/{ws_id}/assignees")
async def list_assignees(ws_id: str, user: AuthUser = Depends(get_current_user)):
    """Get all unique assignees for a workspace (OPAI users + ClickUp names)."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)

        # Get all item IDs in this workspace
        items_resp = await client.get(
            _sb_url("team_items"), headers=_sb_headers(),
            params={"workspace_id": f"eq.{ws_id}", "select": "id"},
        )
        items = items_resp.json() if items_resp.status_code < 400 else []
        if not items:
            return {"assignees": []}

        item_ids = [i["id"] for i in items]
        # Batch in chunks of 200 for the IN filter
        all_assignee_ids = set()
        for i in range(0, len(item_ids), 200):
            chunk = item_ids[i:i + 200]
            resp = await client.get(
                _sb_url("team_assignments"), headers=_sb_headers(),
                params={
                    "item_id": f"in.({','.join(chunk)})",
                    "select": "assignee_id",
                },
            )
            for row in (resp.json() if resp.status_code < 400 else []):
                all_assignee_ids.add(row["assignee_id"])

        # Only return real OPAI users — skip clickup: placeholders
        result = []
        opai_ids = []
        for aid in sorted(all_assignee_ids):
            if aid.startswith("clickup:"):
                continue  # Skip ClickUp placeholder assignees
            else:
                opai_ids.append(aid)

        # Resolve OPAI profiles
        if opai_ids:
            profiles_resp = await client.get(
                _sb_url("profiles"), headers=_sb_headers(),
                params={"id": f"in.({','.join(opai_ids)})", "select": "id,display_name,email"},
            )
            for p in (profiles_resp.json() if profiles_resp.status_code < 400 else []):
                result.append({
                    "id": p["id"],
                    "name": p.get("display_name") or p.get("email", "Unknown"),
                    "type": "opai",
                })

        # Sort: OPAI users first, then ClickUp
        result.sort(key=lambda x: (0 if x["type"] == "opai" else 1, x["name"].lower()))
        return {"assignees": result}


# ══════════════════════════════════════════════════════════════
# Members (profiles enrichment for the workspace)
# ══════════════════════════════════════════════════════════════


@router.get("/profiles")
async def list_profiles(user: AuthUser = Depends(get_current_user)):
    """Get all OPAI user profiles (for assignee dropdowns)."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            _sb_url("profiles"), headers=_sb_headers(),
            params={"select": "id,email,display_name,is_active", "order": "display_name.asc"},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"profiles": resp.json()}


# ══════════════════════════════════════════════════════════════
# Docs
# ══════════════════════════════════════════════════════════════


class CreateDoc(BaseModel):
    title: str
    content: str = ""
    folder_id: Optional[str] = None
    list_id: Optional[str] = None
    item_id: Optional[str] = None


class UpdateDoc(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    folder_id: Optional[str] = None
    list_id: Optional[str] = None
    item_id: Optional[str] = None


@router.get("/workspaces/{ws_id}/docs")
async def list_docs(
    ws_id: str,
    folder_id: Optional[str] = None,
    list_id: Optional[str] = None,
    item_id: Optional[str] = None,
    user: AuthUser = Depends(get_current_user),
):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        params = {"workspace_id": f"eq.{ws_id}", "order": "updated_at.desc",
                  "select": "id,workspace_id,folder_id,list_id,item_id,title,source,source_id,created_by,created_at,updated_at"}
        if folder_id:
            params["folder_id"] = f"eq.{folder_id}"
        if list_id:
            params["list_id"] = f"eq.{list_id}"
        if item_id:
            params["item_id"] = f"eq.{item_id}"
        resp = await client.get(_sb_url("team_docs"), headers=_sb_headers(), params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        docs = resp.json()
        if docs:
            author_ids = list({d["created_by"] for d in docs})
            profiles = await client.get(
                _sb_url("profiles"), headers=_sb_headers(),
                params={"id": f"in.({','.join(author_ids)})", "select": "id,display_name,email"},
            )
            pmap = {p["id"]: p for p in (profiles.json() if profiles.status_code < 400 else [])}
            for d in docs:
                p = pmap.get(d["created_by"], {})
                d["author_name"] = p.get("display_name") or p.get("email", "Unknown")

        return {"docs": docs}


@router.post("/workspaces/{ws_id}/docs")
async def create_doc(ws_id: str, req: CreateDoc, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await _check_membership(client, ws_id, user.id)
        data = {
            "workspace_id": ws_id,
            "title": req.title,
            "content": req.content,
            "created_by": user.id,
            "source": "native",
        }
        if req.folder_id:
            data["folder_id"] = req.folder_id
        if req.list_id:
            data["list_id"] = req.list_id
        if req.item_id:
            data["item_id"] = req.item_id
        resp = await client.post(_sb_url("team_docs"), headers=_sb_headers(), json=data)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.get("/docs/{doc_id}")
async def get_doc(doc_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(_sb_url("team_docs"), headers=_sb_headers(),
                                params={"id": f"eq.{doc_id}"})
        if resp.status_code >= 400 or not resp.json():
            raise HTTPException(status_code=404, detail="Doc not found")
        doc = resp.json()[0]
        await _check_membership(client, doc["workspace_id"], user.id)

        # Fetch pages
        pages_resp = await client.get(
            _sb_url("team_doc_pages"), headers=_sb_headers(),
            params={"doc_id": f"eq.{doc_id}", "order": "orderindex.asc"},
        )
        doc["pages"] = pages_resp.json() if pages_resp.status_code < 400 else []

        # Author name
        p_resp = await client.get(
            _sb_url("profiles"), headers=_sb_headers(),
            params={"id": f"eq.{doc['created_by']}", "select": "id,display_name,email"},
        )
        if p_resp.status_code < 400 and p_resp.json():
            p = p_resp.json()[0]
            doc["author_name"] = p.get("display_name") or p.get("email", "Unknown")

        return doc


@router.put("/docs/{doc_id}")
async def update_doc(doc_id: str, req: UpdateDoc, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(_sb_url("team_docs"), headers=_sb_headers(),
                                params={"id": f"eq.{doc_id}"})
        if resp.status_code >= 400 or not resp.json():
            raise HTTPException(status_code=404, detail="Doc not found")
        doc = resp.json()[0]
        role = await _check_membership(client, doc["workspace_id"], user.id)
        if doc["created_by"] != user.id and role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Cannot edit this doc")

        updates = {}
        if req.title is not None:
            updates["title"] = req.title
        if req.content is not None:
            updates["content"] = req.content
        if req.folder_id is not None:
            updates["folder_id"] = req.folder_id or None
        if req.list_id is not None:
            updates["list_id"] = req.list_id or None
        if req.item_id is not None:
            updates["item_id"] = req.item_id or None
        if not updates:
            return doc
        updates["updated_at"] = "now()"

        upd = await client.patch(
            _sb_url("team_docs"), headers=_sb_headers(),
            params={"id": f"eq.{doc_id}"},
            json=updates,
        )
        if upd.status_code >= 400:
            raise HTTPException(status_code=upd.status_code, detail=upd.text)
        return upd.json()[0]


@router.delete("/docs/{doc_id}")
async def delete_doc(doc_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(_sb_url("team_docs"), headers=_sb_headers(),
                                params={"id": f"eq.{doc_id}"})
        if resp.status_code >= 400 or not resp.json():
            raise HTTPException(status_code=404, detail="Doc not found")
        doc = resp.json()[0]
        role = await _check_membership(client, doc["workspace_id"], user.id)
        if doc["created_by"] != user.id and role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Cannot delete this doc")
        await client.delete(_sb_url("team_docs"), headers=_sb_headers(),
                            params={"id": f"eq.{doc_id}"})
        return {"ok": True}


# ── Doc Pages ───────────────────────────────────────────────────


class CreateDocPage(BaseModel):
    title: str = "Untitled"
    content: str = ""


class UpdateDocPage(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    orderindex: Optional[int] = None


@router.post("/docs/{doc_id}/pages")
async def create_doc_page(doc_id: str, req: CreateDocPage, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        doc_resp = await client.get(_sb_url("team_docs"), headers=_sb_headers(),
                                    params={"id": f"eq.{doc_id}"})
        if doc_resp.status_code >= 400 or not doc_resp.json():
            raise HTTPException(status_code=404, detail="Doc not found")
        doc = doc_resp.json()[0]
        await _check_membership(client, doc["workspace_id"], user.id)

        # Get max orderindex
        existing = await client.get(
            _sb_url("team_doc_pages"), headers=_sb_headers(),
            params={"doc_id": f"eq.{doc_id}", "order": "orderindex.desc", "limit": "1"},
        )
        max_order = existing.json()[0]["orderindex"] if (existing.status_code < 400 and existing.json()) else -1

        resp = await client.post(_sb_url("team_doc_pages"), headers=_sb_headers(), json={
            "doc_id": doc_id,
            "title": req.title,
            "content": req.content,
            "orderindex": max_order + 1,
        })
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0]


@router.put("/docs/{doc_id}/pages/{page_id}")
async def update_doc_page(doc_id: str, page_id: str, req: UpdateDocPage, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        doc_resp = await client.get(_sb_url("team_docs"), headers=_sb_headers(),
                                    params={"id": f"eq.{doc_id}"})
        if doc_resp.status_code >= 400 or not doc_resp.json():
            raise HTTPException(status_code=404, detail="Doc not found")
        doc = doc_resp.json()[0]
        role = await _check_membership(client, doc["workspace_id"], user.id)
        if doc["created_by"] != user.id and role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Cannot edit this doc")

        updates = {}
        if req.title is not None:
            updates["title"] = req.title
        if req.content is not None:
            updates["content"] = req.content
        if req.orderindex is not None:
            updates["orderindex"] = req.orderindex
        if not updates:
            return {"ok": True}
        updates["updated_at"] = "now()"

        resp = await client.patch(
            _sb_url("team_doc_pages"), headers=_sb_headers(),
            params={"id": f"eq.{page_id}", "doc_id": f"eq.{doc_id}"},
            json=updates,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()[0] if resp.json() else {"ok": True}


@router.delete("/docs/{doc_id}/pages/{page_id}")
async def delete_doc_page(doc_id: str, page_id: str, user: AuthUser = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        doc_resp = await client.get(_sb_url("team_docs"), headers=_sb_headers(),
                                    params={"id": f"eq.{doc_id}"})
        if doc_resp.status_code >= 400 or not doc_resp.json():
            raise HTTPException(status_code=404, detail="Doc not found")
        doc = doc_resp.json()[0]
        role = await _check_membership(client, doc["workspace_id"], user.id)
        if doc["created_by"] != user.id and role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Cannot delete from this doc")
        await client.delete(_sb_url("team_doc_pages"), headers=_sb_headers(),
                            params={"id": f"eq.{page_id}", "doc_id": f"eq.{doc_id}"})
        return {"ok": True}
