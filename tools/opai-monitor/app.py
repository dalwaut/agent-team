"""OPAI Monitor — FastAPI entrypoint."""

import asyncio
import logging
import resource
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

_start_time = time.time()

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

import config


# ── Suppress noisy health-check access logs ────────────────
class _HealthCheckFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if '"GET /health ' in msg:
            return False
        return True

logging.getLogger("uvicorn.access").addFilter(_HealthCheckFilter())

# Ensure the module directory is on the path
sys.path.insert(0, str(Path(__file__).parent))
# Add shared modules (auth) to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from routes_api import router as api_router
from routes_users import router as users_router
from routes_ws import router as ws_router
from updater import UpdaterAgent


updater = UpdaterAgent()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start background tasks on startup, clean up on shutdown."""
    # Ensure data directory exists
    config.UPDATER_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Start the updater agent
    updater_task = asyncio.create_task(updater.run())

    yield

    # Shutdown
    updater_task.cancel()
    try:
        await updater_task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="OPAI Monitor",
    version="1.0.0",
    description="OPAI Agentic Hub — Web Dashboard",
    lifespan=lifespan,
)

# Mount routers
app.include_router(api_router)
app.include_router(users_router)
app.include_router(ws_router)

# Serve static files
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def index():
    """Serve the dashboard."""
    return FileResponse(
        str(static_dir / "index.html"),
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-monitor",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )
