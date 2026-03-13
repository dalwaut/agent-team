"""Eliza Hub — Management dashboard for OPAI ElizaOS agents.

Agent lifecycle, knowledge branches, interaction audit, settings.
Port: 8083  |  Path: /eliza-hub/
"""
import logging
import sys
import time
from pathlib import Path

_start_time = time.time()

sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from dotenv import load_dotenv
load_dotenv()

import config

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from routes_agents import router as agents_router
from routes_knowledge import router as knowledge_router
from routes_audit import router as audit_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("eliza-hub")

app = FastAPI(
    title="Eliza Hub",
    version="1.0.0",
    description="OPAI ElizaOS management dashboard — agents, knowledge, audit",
)

app.include_router(agents_router)
app.include_router(knowledge_router)
app.include_router(audit_router)


# ── Health ──────────────────────────────────────────────────
@app.get("/health")
async def health():
    import httpx
    runtime_ok = False
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{config.ELIZA_RUNTIME_URL}/health")
            runtime_ok = r.status_code == 200
    except Exception:
        pass

    return {
        "service": "opai-eliza-hub",
        "status": "ok",
        "uptime": round(time.time() - _start_time),
        "runtime_connected": runtime_ok,
    }


# ── Auth config (same pattern as Brain) ────────────────────
@app.get("/api/auth/config")
def auth_config(request: Request):
    from_local = request.client and request.client.host in ("127.0.0.1", "::1", "localhost")
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
        "auth_disabled": from_local,
    }


config.STATIC_DIR.mkdir(parents=True, exist_ok=True)

log.info("[Eliza Hub] Startup — port %d", config.PORT)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static-assets")
app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
