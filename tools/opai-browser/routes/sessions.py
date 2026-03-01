"""Browser session management endpoints."""

import sys
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

# Shared auth
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import require_admin, AuthUser

import session_manager

router = APIRouter(prefix="/api/sessions")


class SessionCreate(BaseModel):
    name: str


@router.get("")
async def list_sessions(user: AuthUser = Depends(require_admin)):
    """List all named browser sessions."""
    return {"sessions": session_manager.list_sessions()}


@router.post("")
async def create_session(body: SessionCreate, user: AuthUser = Depends(require_admin)):
    """Create a new named browser session."""
    name = body.name.strip().lower().replace(" ", "-")
    if not name or "/" in name or "." in name:
        raise HTTPException(status_code=400, detail="Invalid session name")

    result = session_manager.create_session(name)
    if "error" in result:
        raise HTTPException(status_code=409, detail=result["error"])
    return {"session": result}


@router.delete("/{name}")
async def delete_session(name: str, user: AuthUser = Depends(require_admin)):
    """Delete a named session and wipe its storage state."""
    success = session_manager.delete_session(name)
    if not success:
        raise HTTPException(status_code=404, detail=f"Session '{name}' not found")
    return {"status": "deleted", "name": name}
