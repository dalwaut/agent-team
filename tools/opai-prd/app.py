"""OPAI PRD Pipeline — FastAPI entrypoint."""

import resource
import sys
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

import config
from routes_api import router as api_router

_start_time = time.time()

app = FastAPI(
    title="OPAI PRD Pipeline",
    version="1.0.0",
    description="Product idea ingestion, PRDgent evaluation, and project scaffolding",
)

app.include_router(api_router)

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(static_dir / "index.html"))


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-prd",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


if __name__ == "__main__":
    import uvicorn
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False, log_level="info")
