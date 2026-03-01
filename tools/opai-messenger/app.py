"""OPAI Messenger - Internal team messaging service."""

import resource
import sys
import time
from pathlib import Path

_start_time = time.time()

# Add shared modules to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import config
from routes_api import router as api_router
from routes_ws import router as ws_router

app = FastAPI(
    title="OPAI Messenger",
    description="Internal team messaging for OPAI",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    print("[STARTUP] OPAI Messenger ready on port", config.PORT)


app.include_router(api_router)
app.include_router(ws_router)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/health")
async def health_check(request: Request):
    """Health check - localhost only."""
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1", "localhost"):
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-messenger",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


@app.get("/")
async def root():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
