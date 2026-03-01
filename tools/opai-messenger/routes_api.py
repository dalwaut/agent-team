"""OPAI Messenger - REST API routes."""

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from pydantic import BaseModel
import httpx
import config
from auth import get_current_user, AuthUser

router = APIRouter(prefix="/api")

# ── Helpers ───────────────────────────────────────────────


def _sb_headers(service_key: bool = True):
    """Supabase REST headers using service key."""
    key = config.SUPABASE_SERVICE_KEY or config.SUPABASE_ANON_KEY
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(path: str) -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{path}"


# ── Auth Config ───────────────────────────────────────────


@router.get("/auth/config")
async def auth_config():
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── Users ─────────────────────────────────────────────────


@router.get("/users")
async def list_users(user: AuthUser = Depends(get_current_user)):
    """List all active users for starting conversations."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _sb_url("profiles?is_active=eq.true&select=id,email,display_name,role&order=display_name"),
            headers=_sb_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Failed to fetch users")
        return resp.json()


# ── Channels ──────────────────────────────────────────────


class CreateChannelRequest(BaseModel):
    type: str = "dm"  # 'dm' or 'group'
    name: Optional[str] = None  # Required for groups
    member_ids: list[str]  # User IDs to add


@router.get("/channels")
async def list_channels(user: AuthUser = Depends(get_current_user)):
    """List user's channels with unread counts and last message."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Get channels the user is a member of
        resp = await client.get(
            _sb_url(
                "dm_channel_members?user_id=eq." + user.id
                + "&select=channel_id,last_read_at,"
                + "channel:dm_channels(id,type,name,created_by,updated_at)"
            ),
            headers=_sb_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Failed to fetch channels")

        memberships = resp.json()
        channel_ids = [m["channel_id"] for m in memberships]

        if not channel_ids:
            return []

        # Get members for all channels (for DM display names)
        ids_filter = ",".join(channel_ids)
        members_resp = await client.get(
            _sb_url(
                f"dm_channel_members?channel_id=in.({ids_filter})"
                + "&select=channel_id,user_id,user:profiles(id,display_name,email)"
            ),
            headers=_sb_headers(),
        )
        members_by_channel = {}
        if members_resp.status_code == 200:
            for m in members_resp.json():
                cid = m["channel_id"]
                members_by_channel.setdefault(cid, []).append(m.get("user"))

        # Get last message for each channel
        last_msgs = {}
        for cid in channel_ids:
            msg_resp = await client.get(
                _sb_url(
                    f"dm_messages?channel_id=eq.{cid}&deleted_at=is.null"
                    + "&select=id,content,sender_id,created_at,sender:profiles(display_name)"
                    + "&order=created_at.desc&limit=1"
                ),
                headers=_sb_headers(),
            )
            if msg_resp.status_code == 200:
                msgs = msg_resp.json()
                if msgs:
                    last_msgs[cid] = msgs[0]

        # Get unread counts
        result = []
        for membership in memberships:
            ch = membership.get("channel")
            if not ch:
                continue
            cid = ch["id"]
            last_read = membership["last_read_at"]

            # Count messages after last_read
            count_resp = await client.get(
                _sb_url(
                    f"dm_messages?channel_id=eq.{cid}&deleted_at=is.null"
                    + f"&created_at=gt.{last_read}"
                    + f"&sender_id=neq.{user.id}"
                ),
                headers={**_sb_headers(), "Prefer": "count=exact"},
            )
            unread = 0
            if count_resp.status_code == 200:
                cr = count_resp.headers.get("content-range", "")
                if "/" in cr:
                    total = cr.split("/")[-1]
                    unread = int(total) if total != "*" else 0

            members = members_by_channel.get(cid, [])
            # For DMs, use the other person's name
            display_name = ch.get("name")
            if ch["type"] == "dm" and not display_name:
                other = [m for m in members if m and m["id"] != user.id]
                display_name = other[0]["display_name"] if other else "Unknown"

            result.append({
                "id": cid,
                "type": ch["type"],
                "name": display_name,
                "members": members,
                "last_message": last_msgs.get(cid),
                "unread_count": unread,
                "updated_at": ch["updated_at"],
            })

        # Sort by last message time
        result.sort(
            key=lambda c: (c.get("last_message") or {}).get("created_at", ""),
            reverse=True,
        )
        return result


@router.post("/channels")
async def create_channel(req: CreateChannelRequest, user: AuthUser = Depends(get_current_user)):
    """Create a DM or group channel."""
    if req.type == "group" and not req.name:
        raise HTTPException(status_code=400, detail="Group channels require a name")

    if user.id not in req.member_ids:
        req.member_ids.append(user.id)

    async with httpx.AsyncClient(timeout=10) as client:
        # For DMs, check if one already exists between these two users
        if req.type == "dm" and len(req.member_ids) == 2:
            other_id = [mid for mid in req.member_ids if mid != user.id][0]
            # Find existing DM channel
            existing_resp = await client.get(
                _sb_url(
                    "dm_channel_members?user_id=eq." + user.id
                    + "&select=channel_id,channel:dm_channels(id,type)"
                ),
                headers=_sb_headers(),
            )
            if existing_resp.status_code == 200:
                for m in existing_resp.json():
                    ch = m.get("channel")
                    if ch and ch["type"] == "dm":
                        # Check if other user is also a member
                        check_resp = await client.get(
                            _sb_url(
                                f"dm_channel_members?channel_id=eq.{ch['id']}&user_id=eq.{other_id}"
                            ),
                            headers=_sb_headers(),
                        )
                        if check_resp.status_code == 200 and check_resp.json():
                            return {"id": ch["id"], "type": "dm", "existing": True}

        # Create channel
        ch_resp = await client.post(
            _sb_url("dm_channels"),
            headers=_sb_headers(),
            json={"type": req.type, "name": req.name, "created_by": user.id},
        )
        if ch_resp.status_code not in (200, 201):
            raise HTTPException(status_code=500, detail="Failed to create channel")

        channel = ch_resp.json()[0]
        channel_id = channel["id"]

        # Add members
        members_data = [
            {"channel_id": channel_id, "user_id": mid}
            for mid in req.member_ids
        ]
        await client.post(
            _sb_url("dm_channel_members"),
            headers=_sb_headers(),
            json=members_data,
        )

        return {"id": channel_id, "type": req.type, "existing": False}


# ── Messages ─────────────────────────────────────────────


class SendMessageRequest(BaseModel):
    content: str
    reply_to: Optional[str] = None


class EditMessageRequest(BaseModel):
    content: str


@router.get("/channels/{channel_id}/messages")
async def get_messages(
    channel_id: str,
    before: Optional[str] = Query(None, description="Cursor: created_at timestamp"),
    limit: int = Query(50, ge=1, le=100),
    user: AuthUser = Depends(get_current_user),
):
    """Get paginated messages for a channel."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Verify membership
        mem_resp = await client.get(
            _sb_url(f"dm_channel_members?channel_id=eq.{channel_id}&user_id=eq.{user.id}"),
            headers=_sb_headers(),
        )
        if mem_resp.status_code != 200 or not mem_resp.json():
            raise HTTPException(status_code=403, detail="Not a member of this channel")

        url = _sb_url(
            f"dm_messages?channel_id=eq.{channel_id}"
            + "&select=id,content,sender_id,reply_to,file_url,file_name,file_type,"
            + "edited_at,deleted_at,created_at,"
            + "sender:profiles(id,display_name,email),"
            + "reactions:dm_reactions(id,emoji,user_id,user:profiles(display_name))"
            + f"&order=created_at.desc&limit={limit}"
        )
        if before:
            url += f"&created_at=lt.{before}"

        resp = await client.get(url, headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Failed to fetch messages")

        messages = resp.json()

        # If message is soft-deleted, hide content
        for msg in messages:
            if msg.get("deleted_at"):
                msg["content"] = ""
                msg["file_url"] = None

        # Fetch reply-to messages
        reply_ids = [m["reply_to"] for m in messages if m.get("reply_to")]
        reply_map = {}
        if reply_ids:
            ids_str = ",".join(reply_ids)
            reply_resp = await client.get(
                _sb_url(
                    f"dm_messages?id=in.({ids_str})"
                    + "&select=id,content,sender_id,sender:profiles(display_name)"
                ),
                headers=_sb_headers(),
            )
            if reply_resp.status_code == 200:
                for r in reply_resp.json():
                    reply_map[r["id"]] = r

        for msg in messages:
            if msg.get("reply_to") and msg["reply_to"] in reply_map:
                msg["reply_message"] = reply_map[msg["reply_to"]]

        return {"messages": list(reversed(messages)), "has_more": len(messages) == limit}


@router.post("/channels/{channel_id}/messages")
async def send_message(
    channel_id: str,
    req: SendMessageRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Send a message to a channel."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Verify membership
        mem_resp = await client.get(
            _sb_url(f"dm_channel_members?channel_id=eq.{channel_id}&user_id=eq.{user.id}"),
            headers=_sb_headers(),
        )
        if mem_resp.status_code != 200 or not mem_resp.json():
            raise HTTPException(status_code=403, detail="Not a member of this channel")

        msg_data = {
            "channel_id": channel_id,
            "sender_id": user.id,
            "content": req.content,
        }
        if req.reply_to:
            msg_data["reply_to"] = req.reply_to

        resp = await client.post(
            _sb_url("dm_messages"),
            headers=_sb_headers(),
            json=msg_data,
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=500, detail="Failed to send message")

        msg = resp.json()[0]

        # Update channel updated_at
        await client.patch(
            _sb_url(f"dm_channels?id=eq.{channel_id}"),
            headers=_sb_headers(),
            json={"updated_at": msg["created_at"]},
        )

        # Auto-mark as read for sender
        await client.patch(
            _sb_url(f"dm_channel_members?channel_id=eq.{channel_id}&user_id=eq.{user.id}"),
            headers=_sb_headers(),
            json={"last_read_at": msg["created_at"]},
        )

        return msg


@router.patch("/channels/{channel_id}/read")
async def mark_read(channel_id: str, user: AuthUser = Depends(get_current_user)):
    """Mark a channel as read."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _sb_url(f"dm_channel_members?channel_id=eq.{channel_id}&user_id=eq.{user.id}"),
            headers=_sb_headers(),
            json={"last_read_at": now},
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(status_code=resp.status_code, detail="Failed to mark as read")
        return {"ok": True}


@router.patch("/messages/{message_id}")
async def edit_message(
    message_id: str,
    req: EditMessageRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Edit a message (own messages only)."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _sb_url(f"dm_messages?id=eq.{message_id}&sender_id=eq.{user.id}"),
            headers=_sb_headers(),
            json={"content": req.content, "edited_at": now},
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(status_code=resp.status_code, detail="Failed to edit message")
        result = resp.json()
        return result[0] if result else {"ok": True}


@router.delete("/messages/{message_id}")
async def delete_message(message_id: str, user: AuthUser = Depends(get_current_user)):
    """Soft-delete a message (own messages only)."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _sb_url(f"dm_messages?id=eq.{message_id}&sender_id=eq.{user.id}"),
            headers=_sb_headers(),
            json={"deleted_at": now, "content": ""},
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(status_code=resp.status_code, detail="Failed to delete message")
        return {"ok": True}


# ── Reactions ─────────────────────────────────────────────


class ReactionRequest(BaseModel):
    emoji: str


@router.post("/messages/{message_id}/reactions")
async def add_reaction(
    message_id: str,
    req: ReactionRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Add an emoji reaction to a message."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _sb_url("dm_reactions"),
            headers={**_sb_headers(), "Prefer": "return=representation,resolution=merge-duplicates"},
            json={"message_id": message_id, "user_id": user.id, "emoji": req.emoji},
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=500, detail="Failed to add reaction")
        return {"ok": True}


@router.delete("/messages/{message_id}/reactions/{emoji}")
async def remove_reaction(
    message_id: str,
    emoji: str,
    user: AuthUser = Depends(get_current_user),
):
    """Remove an emoji reaction."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.delete(
            _sb_url(f"dm_reactions?message_id=eq.{message_id}&user_id=eq.{user.id}&emoji=eq.{emoji}"),
            headers=_sb_headers(),
        )
        if resp.status_code not in (200, 204):
            raise HTTPException(status_code=resp.status_code, detail="Failed to remove reaction")
        return {"ok": True}


# ── Search ────────────────────────────────────────────────


@router.get("/messages/search")
async def search_messages(
    q: str = Query(..., min_length=2),
    limit: int = Query(20, ge=1, le=50),
    user: AuthUser = Depends(get_current_user),
):
    """Full-text search across user's channels."""
    # Convert query to tsquery format
    terms = q.strip().split()
    tsquery = " & ".join(terms)

    async with httpx.AsyncClient(timeout=10) as client:
        # Get user's channel IDs
        ch_resp = await client.get(
            _sb_url(f"dm_channel_members?user_id=eq.{user.id}&select=channel_id"),
            headers=_sb_headers(),
        )
        if ch_resp.status_code != 200:
            return {"results": []}

        channel_ids = [m["channel_id"] for m in ch_resp.json()]
        if not channel_ids:
            return {"results": []}

        ids_str = ",".join(channel_ids)

        # Use Supabase RPC or raw text search via PostgREST fts
        resp = await client.get(
            _sb_url(
                f"dm_messages?channel_id=in.({ids_str})"
                + f"&content=fts.{tsquery}"
                + "&deleted_at=is.null"
                + "&select=id,content,sender_id,channel_id,created_at,"
                + "sender:profiles(display_name),"
                + "channel:dm_channels(id,name,type)"
                + f"&order=created_at.desc&limit={limit}"
            ),
            headers=_sb_headers(),
        )
        if resp.status_code != 200:
            return {"results": []}

        return {"results": resp.json()}


# ── File Upload ───────────────────────────────────────────


@router.post("/upload")
async def upload_file(
    channel_id: str = Query(...),
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    """Upload a file to Supabase Storage and return the URL."""
    if file.content_type and file.content_type not in config.ALLOWED_FILE_TYPES:
        raise HTTPException(status_code=400, detail=f"File type not allowed: {file.content_type}")

    content = await file.read()
    if len(content) > config.MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large (max 10MB)")

    import uuid
    ext = file.filename.rsplit(".", 1)[-1] if "." in (file.filename or "") else "bin"
    storage_path = f"{channel_id}/{uuid.uuid4().hex}.{ext}"

    key = config.SUPABASE_SERVICE_KEY or config.SUPABASE_ANON_KEY
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{config.SUPABASE_URL}/storage/v1/object/{config.STORAGE_BUCKET}/{storage_path}",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": file.content_type or "application/octet-stream",
            },
            content=content,
        )

        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=500, detail="Failed to upload file")

        public_url = f"{config.SUPABASE_URL}/storage/v1/object/public/{config.STORAGE_BUCKET}/{storage_path}"

        return {
            "url": public_url,
            "file_name": file.filename,
            "file_type": file.content_type,
        }


# ── Group Management ─────────────────────────────────────


class UpdateGroupRequest(BaseModel):
    name: Optional[str] = None
    add_members: Optional[list[str]] = None
    remove_members: Optional[list[str]] = None


@router.patch("/channels/{channel_id}")
async def update_channel(
    channel_id: str,
    req: UpdateGroupRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Update group name or manage members."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Verify user is a member
        mem_resp = await client.get(
            _sb_url(f"dm_channel_members?channel_id=eq.{channel_id}&user_id=eq.{user.id}"),
            headers=_sb_headers(),
        )
        if mem_resp.status_code != 200 or not mem_resp.json():
            raise HTTPException(status_code=403, detail="Not a member of this channel")

        if req.name:
            await client.patch(
                _sb_url(f"dm_channels?id=eq.{channel_id}"),
                headers=_sb_headers(),
                json={"name": req.name},
            )

        if req.add_members:
            members_data = [
                {"channel_id": channel_id, "user_id": mid}
                for mid in req.add_members
            ]
            await client.post(
                _sb_url("dm_channel_members"),
                headers={**_sb_headers(), "Prefer": "return=representation,resolution=merge-duplicates"},
                json=members_data,
            )

        if req.remove_members:
            for mid in req.remove_members:
                if mid == user.id:
                    continue  # Can't remove yourself this way
                await client.delete(
                    _sb_url(f"dm_channel_members?channel_id=eq.{channel_id}&user_id=eq.{mid}"),
                    headers=_sb_headers(),
                )

        return {"ok": True}
