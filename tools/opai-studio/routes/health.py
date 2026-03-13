"""OPAI Studio — Health check routes."""
import time
import config

from fastapi import APIRouter

router = APIRouter()

_start_time = time.time()


@router.get("/health")
@router.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "opai-studio",
        "port": config.PORT,
        "uptime_s": int(time.time() - _start_time),
    }


@router.get("/api/auth-config")
async def auth_config():
    """Return public Supabase config for client-side auth."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }
