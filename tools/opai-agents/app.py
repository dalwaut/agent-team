"""OPAI Agents — Agent Studio for managing agents, squads, and orchestration."""

import resource
import sys
import time
from pathlib import Path

_start_time = time.time()

# Add shared modules to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from dotenv import load_dotenv

load_dotenv()

import config
from auth import get_current_user, require_admin, AuthUser

from fastapi import FastAPI, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(
    title="OPAI Agents",
    version="1.0.0",
    description="Agent Studio — create and orchestrate AI agent teams",
)


# ── Health ─────────────────────────────────────────────────────


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-agents",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


# ── Auth Config ────────────────────────────────────────────────


@app.get("/api/auth/config")
def auth_config():
    """Return Supabase config for frontend auth initialization."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── API Routes ─────────────────────────────────────────────────

from routes_api import router as api_router

app.include_router(api_router)


# ── Static Files (must be last) ────────────────────────────────

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=True)
