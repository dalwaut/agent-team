"""Bx4 — BoutaByte Business Bot — FastAPI application."""

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

from routes.companies import router as companies_router
from routes.financial import router as financial_router
from routes.advisor import router as advisor_router
from routes.settings import router as settings_router
from routes.intake import router as intake_router
from routes.credits import router as credits_router
from routes.social import router as social_router
from routes.market import router as market_router
from routes.briefings import router as briefings_router
from routes.health import router as health_router
from routes.operations import router as operations_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("bx4")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start scheduler on startup; clean up on shutdown."""
    from core.scheduler import scheduler_loop
    task = asyncio.create_task(scheduler_loop())
    log.info("[BX4] Startup complete — scheduler running on port %d", config.PORT)
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    log.info("[BX4] Shutdown complete")


app = FastAPI(
    title="Bx4 — BoutaByte Business Bot",
    version="1.0.0",
    description="AI-powered business advisor — financial, market, social, and operations analysis",
    lifespan=lifespan,
)

app.include_router(companies_router)
app.include_router(financial_router)
app.include_router(advisor_router)
app.include_router(settings_router)
app.include_router(intake_router)
app.include_router(credits_router)
app.include_router(social_router)
app.include_router(market_router)
app.include_router(briefings_router)
app.include_router(health_router)
app.include_router(operations_router)


@app.get("/api/auth/config")
def auth_config():
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


@app.get("/health")
@app.get("/api/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "bx4",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


config.DATA_DIR.mkdir(parents=True, exist_ok=True)
config.STATIC_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static-assets")
app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=True)
