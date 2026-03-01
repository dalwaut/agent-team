"""OPAI Task Control Panel — FastAPI entrypoint."""

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
import services

# Ensure the module directory is on the path
sys.path.insert(0, str(Path(__file__).parent))
# Add shared modules (auth) to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from routes_api import router as api_router

# Monitor routers (merged into TCP as Health tab)
from monitor.routes_api import router as monitor_api_router
from monitor.routes_users import router as monitor_users_router
from monitor.routes_ws import router as monitor_ws_router
from monitor.updater import UpdaterAgent
from monitor import routes_api as monitor_routes_api_mod


# ── Suppress noisy health-check access logs ────────────────
class _HealthCheckFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if '"GET /health ' in msg:
            return False
        return True

logging.getLogger("uvicorn.access").addFilter(_HealthCheckFilter())


updater = UpdaterAgent()


@asynccontextmanager
async def lifespan(app):
    """Startup: clean stale jobs, launch auto-executor loop + updater agent."""
    services.cleanup_stale_jobs()

    # Wire updater reference into monitor routes
    monitor_routes_api_mod._updater = updater

    # Ensure updater data directory exists
    from monitor import config as mon_config
    mon_config.UPDATER_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

    async def _auto_executor_loop():
        while True:
            await asyncio.sleep(30)
            try:
                services.auto_execute_cycle()
            except Exception as e:
                logging.getLogger("opai-tasks").error("auto_execute_cycle error: %s", e)

    executor_task = asyncio.create_task(_auto_executor_loop())
    updater_task = asyncio.create_task(updater.run())

    yield

    executor_task.cancel()
    updater_task.cancel()
    try:
        await updater_task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="OPAI Task Control Panel",
    version="1.0.0",
    description="OPAI Task Management — View, filter, delegate, and manage tasks",
    lifespan=lifespan,
)

# Mount TCP router
app.include_router(api_router)

# Mount Monitor routers (Health tab)
app.include_router(monitor_api_router)
app.include_router(monitor_users_router)
app.include_router(monitor_ws_router)

# Serve static files
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def index():
    """Serve the task control panel."""
    return FileResponse(str(static_dir / "index.html"))


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-tasks",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


if __name__ == "__main__":
    import uvicorn

    # Load .env if present
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    uvicorn.run(
        "app:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )
