"""2nd Brain — FastAPI application.

Cognitive layer of OPAI: Library (note CRUD), Inbox (quick capture),
full-text search, knowledge graph, AI co-editor, and research synthesis.

Port: 8101  |  Path: /brain/
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

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from routes.health import router as health_router
from routes.nodes import router as nodes_router
from routes.inbox import router as inbox_router
from routes.search import router as search_router
from routes.graph import router as graph_router
from routes.ai import router as ai_router
from routes.research import router as research_router
from routes.canvas import router as canvas_router
from routes.tier import router as tier_router
from routes.snapshots import router as snapshots_router
from routes.schedule import router as schedule_router
from routes.suggestions import router as suggestions_router
from routes.youtube import router as youtube_router
from routes.instagram import router as instagram_router
from routes.relationships import router as relationships_router
from routes.library_sync import router as library_sync_router
from routes.notebooklm import router as notebooklm_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("brain")


@asynccontextmanager
async def lifespan(app: FastAPI):
    from scheduler import scheduler_loop
    task = asyncio.create_task(scheduler_loop())
    log.info("[Brain] Scheduler started")
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    log.info("[Brain] Scheduler stopped")


app = FastAPI(
    title="2nd Brain",
    version="2.0.0",
    description="Cognitive layer — Library, Inbox, knowledge graph with semantic search",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(nodes_router)
app.include_router(inbox_router)
app.include_router(search_router)
app.include_router(graph_router)
app.include_router(ai_router)
app.include_router(research_router)
app.include_router(canvas_router)
app.include_router(tier_router)
app.include_router(snapshots_router)
app.include_router(schedule_router)
app.include_router(suggestions_router)
app.include_router(youtube_router)
app.include_router(instagram_router)
app.include_router(relationships_router)
app.include_router(library_sync_router)
app.include_router(notebooklm_router)


@app.get("/api/auth/config")
def auth_config(request: Request):
    from_local = request.client and request.client.host in ("127.0.0.1", "::1", "localhost")
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
        "auth_disabled": from_local,
    }


config.DATA_DIR.mkdir(parents=True, exist_ok=True)
config.STATIC_DIR.mkdir(parents=True, exist_ok=True)

log.info("[Brain] Startup — port %d", config.PORT)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static-assets")
app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
