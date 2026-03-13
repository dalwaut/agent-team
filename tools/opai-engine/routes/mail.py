"""OPAI Engine — Worker Mail API endpoints.

REST API for the inter-worker mail system. Used by dashboard and debugging.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from auth import require_admin

router = APIRouter(prefix="/api/mail")

# WorkerMail instance set by app.py during startup
_mail = None


def set_mail(mail_instance):
    global _mail
    _mail = mail_instance


def _get_mail():
    if _mail is None:
        raise HTTPException(503, "Worker mail not initialized")
    return _mail


# ── Models ──────────────────────────────────────────────

class SendRequest(BaseModel):
    from_worker: str
    to_worker: str
    type: str = "status"
    subject: str
    body: str = ""
    thread_id: Optional[int] = None
    dispatch_id: Optional[str] = None
    teamhub_item_id: Optional[str] = None


class ReplyRequest(BaseModel):
    from_worker: str
    body: str


# ── Endpoints ───────────────────────────────────────────

@router.get("/inbox/{worker_id}", dependencies=[Depends(require_admin)])
def get_inbox(worker_id: str, unread_only: bool = True, limit: int = 50):
    """Check a worker's inbox."""
    mail = _get_mail()
    messages = mail.check_inbox(worker_id, unread_only=unread_only, limit=limit)
    return {"worker_id": worker_id, "count": len(messages), "messages": messages}


@router.get("/message/{msg_id}", dependencies=[Depends(require_admin)])
def get_message(msg_id: int):
    """Read a single message (marks as read)."""
    mail = _get_mail()
    msg = mail.read_message(msg_id)
    if not msg:
        raise HTTPException(404, f"Message {msg_id} not found")
    return msg


@router.get("/thread/{thread_id}", dependencies=[Depends(require_admin)])
def get_thread(thread_id: int):
    """Read an entire thread."""
    mail = _get_mail()
    messages = mail.get_thread(thread_id)
    return {"thread_id": thread_id, "count": len(messages), "messages": messages}


@router.post("/send", dependencies=[Depends(require_admin)])
def send_message(req: SendRequest):
    """Send a new message."""
    mail = _get_mail()
    msg_id = mail.send(
        from_worker=req.from_worker,
        to_worker=req.to_worker,
        type=req.type,
        subject=req.subject,
        body=req.body,
        thread_id=req.thread_id,
        dispatch_id=req.dispatch_id,
        teamhub_item_id=req.teamhub_item_id,
    )
    return {"success": True, "message_id": msg_id}


@router.post("/reply/{msg_id}", dependencies=[Depends(require_admin)])
def reply_message(msg_id: int, req: ReplyRequest):
    """Reply to an existing message."""
    mail = _get_mail()
    try:
        new_id = mail.reply(msg_id, req.from_worker, req.body)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"success": True, "message_id": new_id}


@router.get("/stats", dependencies=[Depends(require_admin)])
def get_stats():
    """Get mail system statistics."""
    mail = _get_mail()
    return mail.get_stats()
