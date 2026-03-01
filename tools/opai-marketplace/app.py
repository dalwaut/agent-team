"""OPAI Marketplace — BoutaByte product catalog + n8n provisioning."""

import asyncio
import resource
import sys
import time
from pathlib import Path

_start_time = time.time()

# Add shared modules to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from dotenv import load_dotenv

load_dotenv()

import config
from routes_api import router
from sync_products import run_sync

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(
    title="OPAI Marketplace",
    version="1.0.0",
    description="BoutaByte product catalog with n8n provisioning",
)


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-marketplace",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


app.include_router(router)

# Serve static frontend
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


@app.on_event("startup")
async def startup():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    # Run one initial sync on startup to populate/refresh the catalog
    if config.BB_SUPABASE_URL and config.BB_SUPABASE_SERVICE_KEY:
        asyncio.create_task(_initial_sync())


async def _initial_sync():
    """One-time sync on service startup."""
    await asyncio.sleep(3)
    try:
        await run_sync()
    except Exception as e:
        print(f"[marketplace] initial sync error: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
