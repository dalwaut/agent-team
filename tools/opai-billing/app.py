"""OPAI Billing — Stripe billing management for OPAI."""

import resource
import sys
import time
from pathlib import Path

_start_time = time.time()

sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from dotenv import load_dotenv

load_dotenv()

import config
from routes_api import router as api_router
from routes_subscriptions import router as subs_router
from routes_webhooks import router as webhooks_router
from routes_checkout import router as checkout_router

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(
    title="OPAI Billing",
    version="1.0.0",
    description="Stripe billing management for OPAI",
)

# CORS for public checkout pages on opai.boutabyte.com
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://opai.boutabyte.com",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-billing",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


app.include_router(api_router)
app.include_router(subs_router)
app.include_router(webhooks_router)
app.include_router(checkout_router)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


@app.on_event("startup")
async def startup():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
