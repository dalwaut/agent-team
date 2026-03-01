"""OPAI Docs — Documentation portal with auto-updating from wiki sources."""

import asyncio
import resource
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

_start_time = time.time()

# Add shared modules to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from dotenv import load_dotenv

load_dotenv()

import config
import generator
from routes_api import router
from audit import log_audit

from fastapi import FastAPI, Depends, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional

from auth import AuthUser, get_current_user


# ── Background watcher ───────────────────────────────────────

_scheduler_tick: int = config.WATCHER_INTERVAL
_scheduler_paused: bool = False


def get_scheduler_settings() -> dict:
    return {"tick_seconds": _scheduler_tick, "paused": _scheduler_paused}


def set_scheduler_settings(*, tick_seconds: int | None = None, paused: bool | None = None) -> dict:
    global _scheduler_tick, _scheduler_paused
    if tick_seconds is not None:
        _scheduler_tick = max(10, min(3600, tick_seconds))
    if paused is not None:
        _scheduler_paused = paused
    return get_scheduler_settings()


async def _watcher_loop():
    """Periodically check wiki sources and regenerate if changed."""
    while True:
        await asyncio.sleep(_scheduler_tick)
        if _scheduler_paused:
            continue
        try:
            if generator.check_for_changes():
                generator.generate()
                print(f"[watcher] Regenerated docs.json at {time.strftime('%H:%M:%S')}")
                try:
                    log_audit(
                        tier="health",
                        service="opai-docs",
                        event="docs-regenerated",
                        status="completed",
                        summary="Docs regenerated from wiki sources",
                    )
                except Exception:
                    pass
        except Exception as e:
            print(f"[watcher] Error: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start background watcher on startup."""
    # Generate initial docs if missing
    if not config.DOCS_JSON.exists():
        try:
            docs = generator.generate()
            print(f"[startup] Generated docs.json with {len(docs['sections'])} sections")
            try:
                log_audit(
                    tier="health",
                    service="opai-docs",
                    event="docs-regenerated",
                    status="completed",
                    summary=f"Startup: generated docs.json with {len(docs['sections'])} sections",
                )
            except Exception:
                pass
        except Exception as e:
            print(f"[startup] Failed to generate docs: {e}")

    task = asyncio.create_task(_watcher_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


# ── App ──────────────────────────────────────────────────────

app = FastAPI(
    title="OPAI Docs",
    version="1.0.0",
    description="Documentation portal for OPAI tools and system architecture",
    lifespan=lifespan,
)

config.DATA_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-docs",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


app.include_router(router)


# ── Scheduler Settings (heartbeat control) ─────────────────────────────────

class _SchedulerSettingsBody(BaseModel):
    tick_seconds: Optional[int] = None
    paused: Optional[bool] = None


@app.get("/api/scheduler/settings")
async def get_scheduler_settings_endpoint(user: AuthUser = Depends(get_current_user)):
    if getattr(user, "role", "") != "admin":
        raise HTTPException(403, "Admin only")
    return get_scheduler_settings()


@app.put("/api/scheduler/settings")
async def update_scheduler_settings_endpoint(body: _SchedulerSettingsBody, user: AuthUser = Depends(get_current_user)):
    if getattr(user, "role", "") != "admin":
        raise HTTPException(403, "Admin only")
    return set_scheduler_settings(tick_seconds=body.tick_seconds, paused=body.paused)


# Serve static frontend
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
