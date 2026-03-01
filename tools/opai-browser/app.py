"""OPAI Browser Automation — Headless Playwright via Claude CLI.

Port 8107, localhost only. Internal backend service.
Other OPAI tools POST jobs here; Claude Code uses Playwright MCP directly.
Admin debug UI at localhost:8107 for monitoring jobs/sessions.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import config
from job_queue import queue
from routes import health, jobs, sessions


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure default session directory exists
    config.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    (config.SESSIONS_DIR / "default").mkdir(exist_ok=True)
    # Start job worker
    queue.start()
    print(f"[opai-browser] Started on {config.HOST}:{config.PORT}")
    yield
    await queue.stop()


app = FastAPI(
    title="OPAI Browser Automation",
    version="1.0.0",
    docs_url="/docs",
    lifespan=lifespan,
)


# Localhost-only middleware
@app.middleware("http")
async def localhost_guard(request: Request, call_next):
    client_ip = request.client.host if request.client else "unknown"
    allowed = ("127.0.0.1", "::1", "localhost")
    if client_ip not in allowed and not client_ip.startswith("100."):
        return JSONResponse(
            status_code=403,
            content={"detail": "Browser service is localhost-only"},
        )
    return await call_next(request)


# Routes
app.include_router(health.router)
app.include_router(jobs.router)
app.include_router(sessions.router)

# Static admin UI
app.mount("/static", StaticFiles(directory=str(config.BROWSER_DIR / "static")), name="static")


# Serve index.html at root
@app.get("/")
async def root():
    from fastapi.responses import FileResponse
    return FileResponse(str(config.BROWSER_DIR / "static" / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=True)
