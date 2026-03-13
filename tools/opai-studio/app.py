"""OPAI Studio — AI Image Generation & Editing Suite.

Port: 8108  |  Path: /studio/
"""
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
from routes.projects import router as projects_router
from routes.images import router as images_router
from routes.generate import router as generate_router
from routes.edit import router as edit_router
from routes.assets import router as assets_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("studio")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure data dirs exist
    config.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    log.info("[Studio] Ready on port %d (%.1fs startup)", config.PORT, time.time() - _start_time)
    yield
    log.info("[Studio] Shutting down")


app = FastAPI(
    title="OPAI Studio",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)

# ── Routers ──────────────────────────────────────────────────────────────────
app.include_router(health_router)
app.include_router(projects_router)
app.include_router(images_router)
app.include_router(generate_router)
app.include_router(edit_router)
app.include_router(assets_router)

# ── Static ───────────────────────────────────────────────────────────────────
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


# ── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )
