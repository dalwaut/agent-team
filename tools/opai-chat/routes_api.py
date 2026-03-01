"""OPAI Chat - REST API routes for conversations."""

import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from typing import List
from models import Conversation, ConversationSummary
from conversation_store import store
from auth import get_current_user, clear_profile_cache, AuthUser
from gemini_handler import transcribe_audio
from file_scanner import scan_for_malicious
import config

router = APIRouter(prefix="/api")

# ── File upload config ────────────────────────────────────────
ALLOWED_EXTENSIONS = {
    ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".toml",
    ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".sql",
    ".sh", ".bash", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
    ".log", ".ini", ".cfg", ".conf", ".env.example",
}
BLOCKED_EXTENSIONS = {
    ".exe", ".bat", ".ps1", ".dll", ".so", ".dylib", ".msi", ".cmd",
    ".com", ".scr", ".vbs", ".vbe", ".wsf", ".wsh", ".pif",
}
MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10 MB


@router.get("/conversations", response_model=List[ConversationSummary])
async def list_conversations(user: AuthUser = Depends(get_current_user)):
    """List conversations for the current user."""
    return store.list_conversations(user_id=user.id)


@router.get("/conversations/{conversation_id}", response_model=Conversation)
async def get_conversation(conversation_id: str, user: AuthUser = Depends(get_current_user)):
    """Get a full conversation by ID."""
    conversation = store.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    # Scope check: users can only see their own conversations
    if hasattr(conversation, 'user_id') and conversation.user_id and conversation.user_id != user.id and not user.is_admin:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@router.post("/conversations", response_model=Conversation)
async def create_conversation(title: str = "New Chat", model: str = None,
                              user: AuthUser = Depends(get_current_user)):
    """Create a new conversation."""
    if model is None:
        model = config.DEFAULT_MODEL
    return store.create_conversation(title, model, user_id=user.id)


@router.patch("/conversations/{conversation_id}", response_model=Conversation)
async def update_conversation(conversation_id: str, title: str = None,
                             model: str = None, tags: List[str] = None,
                             user: AuthUser = Depends(get_current_user)):
    """Update conversation metadata."""
    conversation = store.update_conversation(conversation_id, title, model, tags)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete a conversation."""
    success = store.delete_conversation(conversation_id)
    if not success:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"status": "deleted"}


@router.get("/models")
async def list_models(user: AuthUser = Depends(get_current_user)):
    """Get available models."""
    return config.MODELS


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...),
                     user: AuthUser = Depends(get_current_user)):
    """Transcribe audio using Gemini 2.5 Flash."""
    audio_bytes = await audio.read()
    if len(audio_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio file too large (max 20MB)")
    mime_type = audio.content_type or "audio/webm"
    try:
        text = await transcribe_audio(audio_bytes, mime_type)
        return {"text": text}
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/auth/config")
async def auth_config():
    """Return Supabase config for frontend auth.js initialization."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


@router.get("/files/browse")
async def browse_files(path: str = "/workspace/synced/opai",
                       user: AuthUser = Depends(get_current_user)):
    """Browse directory contents. Non-admins scoped to their sandbox."""
    from context_resolver import resolver

    # Scope non-admin users to their sandbox
    if not user.is_admin:
        user_root = str(config.USERS_ROOT / user.id)
        if not path.startswith(user_root):
            path = user_root

    try:
        items = resolver.list_directory(path)
        return {"path": path, "items": items}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/files/read")
async def read_file(path: str, user: AuthUser = Depends(get_current_user)):
    """Read a file."""
    from context_resolver import resolver
    try:
        content = resolver.read_file(path)
        return {"path": path, "content": content}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/files/search")
async def search_files(q: str, root: str = None,
                       user: AuthUser = Depends(get_current_user)):
    """Search for files."""
    from context_resolver import resolver
    try:
        matches = resolver.search_files(q, root)
        return {"query": q, "matches": matches}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/context/opai")
async def get_opai_context(user: AuthUser = Depends(get_current_user)):
    """Get OPAI system context."""
    from context_resolver import resolver
    return resolver.get_opai_context()


# ── File Upload ───────────────────────────────────────────────

async def lock_user_ai(user_id: str, reason: str):
    """Lock a user's AI access and notify admin."""
    now = datetime.now(timezone.utc).isoformat()
    supa_url = os.getenv("SUPABASE_URL", config.SUPABASE_URL)
    supa_key = os.getenv("SUPABASE_SERVICE_KEY", "")

    # PATCH profile
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{supa_url}/rest/v1/profiles?id=eq.{user_id}",
            headers={
                "apikey": supa_key,
                "Authorization": f"Bearer {supa_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={
                "ai_locked": True,
                "ai_locked_at": now,
                "ai_locked_reason": reason,
            },
        )

    clear_profile_cache(user_id)
    print(f"[SECURITY] AI locked for user {user_id}: {reason}")

    # Send admin email notification (fire-and-forget)
    email_script = str(config.OPAI_ROOT / "tools" / "opai-tasks" / "send-email.js")
    if Path(email_script).exists():
        try:
            subprocess.Popen(
                [
                    "node", email_script,
                    "--to", config.ADMIN_EMAIL,
                    "--subject", f"[OPAI SECURITY] AI Access Locked — User {user_id[:8]}",
                    "--body", f"User {user_id} had AI access locked.\n\nReason: {reason}\nTime: {now}",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass


@router.post("/files/upload")
async def upload_file(
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    """Upload a file from user device. Files are treated strictly as data."""
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    # Extension check
    ext = ""
    if "." in file.filename:
        ext = "." + file.filename.rsplit(".", 1)[-1].lower()

    if ext in BLOCKED_EXTENSIONS:
        raise HTTPException(400, f"File type {ext} is not allowed")

    if ext and ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"File type {ext} is not supported")

    # Read and size check
    content = await file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(413, f"File too large (max {MAX_UPLOAD_SIZE // 1024 // 1024}MB)")

    # Malicious content scan
    is_malicious, reason = scan_for_malicious(content, file.filename)
    if is_malicious:
        # Lock user AI access
        await lock_user_ai(user.id, f"Malicious upload ({file.filename}): {reason}")
        raise HTTPException(403, "File rejected — malicious content detected. Your AI access has been locked.")

    # Determine upload directory
    if user.sandbox_path:
        upload_dir = Path(user.sandbox_path) / "uploads"
    else:
        upload_dir = config.USERS_ROOT / user.id / "uploads"

    upload_dir.mkdir(parents=True, exist_ok=True)

    # Save with collision avoidance
    safe_name = file.filename.replace("/", "_").replace("\\", "_").replace("..", "_")
    dest = upload_dir / safe_name
    if dest.exists():
        stem = dest.stem
        suffix = dest.suffix
        dest = upload_dir / f"{stem}_{int(datetime.now(timezone.utc).timestamp())}{suffix}"

    dest.write_bytes(content)

    return {
        "path": str(dest),
        "filename": dest.name,
        "size": len(content),
    }
