"""DAM Bot — Do Anything Mode — FastAPI application.

Port: 8104  |  Path: /dam/
Meta-orchestrator: takes any goal and executes it end-to-end.
"""

import asyncio
import logging
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
from routes.sessions import router as sessions_router
from routes.plans import router as plans_router
from routes.steps import router as steps_router
from routes.approvals import router as approvals_router
from routes.skills import router as skills_router
from routes.hooks import router as hooks_router
from routes.improvements import router as improvements_router
from routes.stream import router as stream_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("dam")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start scheduler on startup; clean up on shutdown."""
    from core.scheduler import scheduler_loop
    task = asyncio.create_task(scheduler_loop())
    log.info("[DAM Bot] Startup complete — scheduler running on port %d", config.PORT)
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    log.info("[DAM Bot] Shutdown complete")


app = FastAPI(
    title="DAM Bot — Do Anything Mode",
    version=config.VERSION,
    description="Meta-orchestrator: takes any goal and executes it end-to-end with minimal human intervention",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(sessions_router)
app.include_router(plans_router)
app.include_router(steps_router)
app.include_router(approvals_router)
app.include_router(skills_router)
app.include_router(hooks_router)
app.include_router(improvements_router)
app.include_router(stream_router)


@app.get("/api/auth/config")
def auth_config():
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


config.DATA_DIR.mkdir(parents=True, exist_ok=True)
config.STATIC_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static-assets")
app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=True)
