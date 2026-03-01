"""OPAI Bot Space — FastAPI app bootstrap."""

import asyncio
import logging
import resource
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

_start_time = time.time()

sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from dotenv import load_dotenv
load_dotenv()

import config

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("bot-space")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start scheduler on startup; seed catalog; clean up on shutdown."""
    # Seed catalog (no-op if already seeded)
    if config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY:
        try:
            from bot_registry import seed_catalog
            await seed_catalog(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
        except Exception as exc:
            log.warning("Catalog seed failed (non-fatal): %s", exc)

    # Start background scheduler
    from scheduler import scheduler_loop
    task = asyncio.create_task(scheduler_loop())
    log.info("[BOT-SPACE] Startup complete — scheduler running")

    yield

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    log.info("[BOT-SPACE] Shutdown complete")


app = FastAPI(
    title="OPAI Bot Space",
    version="1.0.0",
    description="Bot catalog, credits, and cron dispatcher for OPAI agent bots",
    lifespan=lifespan,
)

from routes_api import router
app.include_router(router)


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-bot-space",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


config.DATA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


@app.get("/dashboard/{path:path}")
async def dashboard_spa(path: str):
    return FileResponse(str(config.STATIC_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=True)
