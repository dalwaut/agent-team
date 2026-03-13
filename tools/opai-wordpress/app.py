"""OP WordPress — Multi-site WordPress management for OPAI."""

import asyncio
import logging
import resource
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

logging.basicConfig(level=logging.INFO)

_start_time = time.time()

sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from dotenv import load_dotenv

load_dotenv()

import config
from routes_sites import router as sites_router
from routes_updates import router as updates_router
from routes_content import router as content_router
from routes_woo import router as woo_router
from routes_management import router as management_router
from routes_ai import router as ai_router
from routes_automation import router as automation_router
from routes_avada import router as avada_router
from routes_agents import router as agents_router

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle for OP WordPress."""
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Start background tasks
    from services.update_checker import background_checker
    from services.scheduler import scheduler_loop
    from services.connection_agent import connection_agent_loop
    from services.agent_scheduler import agent_scheduler_loop

    bg_tasks = [
        asyncio.create_task(background_checker()),
        asyncio.create_task(scheduler_loop()),
        asyncio.create_task(connection_agent_loop()),
        asyncio.create_task(agent_scheduler_loop()),
    ]

    yield

    # Graceful shutdown — cancel background tasks
    for task in bg_tasks:
        task.cancel()
    await asyncio.gather(*bg_tasks, return_exceptions=True)


app = FastAPI(
    title="OP WordPress",
    version="1.5.0",
    description="Multi-site WordPress management — ManageWP replacement",
    lifespan=lifespan,
)


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-wordpress",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


app.include_router(sites_router)
app.include_router(updates_router)
app.include_router(content_router)
app.include_router(woo_router)
app.include_router(management_router)
app.include_router(ai_router)
app.include_router(automation_router)
app.include_router(avada_router)
app.include_router(agents_router)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
