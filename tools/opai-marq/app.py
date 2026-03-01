"""Marq — App Store Publisher Agent — FastAPI application.

Port: 8103  |  Path: /marq/
"""

import asyncio
import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from dotenv import load_dotenv
load_dotenv()

import config

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

# Import checks package to trigger registration of all 31 checks
import core.checks  # noqa: F401

from routes.health import router as health_router
from routes.apps import router as apps_router
from routes.metadata import router as metadata_router
from routes.submissions import router as submissions_router
from routes.checks import router as checks_router
from routes.screenshots import router as screenshots_router
from routes.reviews import router as reviews_router
from routes.webhooks import router as webhooks_router
from routes.credentials import router as credentials_router
from routes.schedule import router as schedule_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("marq")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start scheduler on startup; clean up on shutdown."""
    from core.scheduler import scheduler_loop
    task = asyncio.create_task(scheduler_loop())
    log.info("[Marq] Startup complete — scheduler running on port %d", config.PORT)
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    log.info("[Marq] Shutdown complete")


app = FastAPI(
    title="Marq — App Store Publisher Agent",
    version=config.VERSION,
    description="The marquee — pre-submission checks, metadata, store submission, review monitoring, rejection-to-task relay",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(apps_router)
app.include_router(metadata_router)
app.include_router(submissions_router)
app.include_router(checks_router)
app.include_router(screenshots_router)
app.include_router(reviews_router)
app.include_router(webhooks_router)
app.include_router(credentials_router)
app.include_router(schedule_router)


@app.get("/api/auth/config")
def auth_config():
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


config.DATA_DIR.mkdir(parents=True, exist_ok=True)
config.STATIC_DIR.mkdir(parents=True, exist_ok=True)
config.VAULT_DIR.mkdir(parents=True, exist_ok=True)
ASSETS_DIR = config.DATA_DIR / "assets"
ASSETS_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static-assets")
app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=True)
