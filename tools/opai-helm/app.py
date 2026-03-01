"""HELM — Autonomous Business Runner — FastAPI application.

Port: 8102  |  Path: /helm/
"""

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
from fastapi.staticfiles import StaticFiles

from routes.health import router as health_router
from routes.businesses import router as businesses_router
from routes.onboarding import router as onboarding_router
from routes.actions import router as actions_router
from routes.credentials import router as credentials_router
from routes.content import router as content_router
from routes.social import router as social_router
from routes.webhooks import router as webhooks_router
from routes.website_builder import router as website_builder_router
from routes.schedule import router as schedule_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("helm")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start scheduler on startup; clean up on shutdown."""
    from core.scheduler import scheduler_loop
    task = asyncio.create_task(scheduler_loop())
    log.info("[HELM] Startup complete — scheduler running on port %d", config.PORT)
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    log.info("[HELM] Shutdown complete")


app = FastAPI(
    title="HELM — Autonomous Business Runner",
    version=config.VERSION,
    description="Handsfree Enterprise Launch Machine — AI runs your business: content, social, revenue, ops",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(businesses_router)
app.include_router(onboarding_router)
app.include_router(actions_router)
app.include_router(credentials_router)
app.include_router(content_router)
app.include_router(social_router)
app.include_router(webhooks_router)
app.include_router(website_builder_router)
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

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static-assets")
app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=True)
