"""OPAI Engine — Unified scheduler, monitor, and task manager.

Merges Orchestrator + Monitor + TCP + Feedback into a single FastAPI service.
Port 8080. Background loops handle scheduling, health monitoring, auto-execution,
resource tracking, component scanning, and stale job cleanup.
"""

import asyncio
import logging
import resource
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

_start_time = time.time()

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

import config


# ── Suppress noisy health-check access logs ────────────────
class _HealthCheckFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if '"GET /health ' in msg:
            return False
        return True


logging.getLogger("uvicorn.access").addFilter(_HealthCheckFilter())

# Ensure the module directory is on the path
sys.path.insert(0, str(Path(__file__).parent))
# Add shared modules (auth, audit) to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from routes.health import router as health_router
from routes.monitor import router as monitor_router
from routes.tasks import router as tasks_router
from routes.feedback import router as feedback_router
from routes.audit import router as audit_router
from routes.suggestions import router as suggestions_router
from routes.users import router as users_router
from routes.claude_usage import router as claude_router
from routes.workers import router as workers_router
from routes.workers import set_manager as set_worker_manager
from routes.heartbeat import router as heartbeat_router
from routes.heartbeat import set_heartbeat
from routes.consolidator import router as consolidator_router
from routes.consolidator import set_consolidator
from routes.command_channels import router as command_channels_router
from routes.bottleneck import router as bottleneck_router
from routes.bottleneck import set_detector as set_bottleneck_detector
from routes.fleet import router as fleet_router
from routes.fleet import set_coordinator as set_fleet_coordinator
from ws.streams import router as ws_router

from background.updater import UpdaterAgent
from background.bottleneck_detector import BottleneckDetector
from background.scheduler import Scheduler
from background.auto_executor import auto_executor_loop
from background.service_monitor import service_monitor_loop
from background.resource_monitor import ResourceMonitor
from background.stale_job_sweeper import stale_job_sweeper_loop
from background.feedback_loop import feedback_loop
from background.worker_manager import WorkerManager
from background.heartbeat import Heartbeat
from background.consolidator import MemoryConsolidator
from background.fleet_coordinator import FleetCoordinator
import services.task_processor as task_processor

logger = logging.getLogger("opai-engine")

# Shared instances
updater = UpdaterAgent()
resource_monitor = ResourceMonitor()
scheduler = Scheduler()
worker_manager = WorkerManager()
bottleneck_detector = BottleneckDetector()
fleet_coordinator = FleetCoordinator(worker_manager, scheduler)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start all background tasks on startup, cancel on shutdown."""
    # Ensure data directories exist
    config.ENGINE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.UPDATER_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Clean stale jobs from previous session
    task_processor.cleanup_stale_jobs()

    # Load scheduler config and worker registrations
    scheduler.load()
    worker_manager.load()
    set_worker_manager(worker_manager)

    # Initialize heartbeat (after scheduler + worker_manager)
    heartbeat = Heartbeat(scheduler, worker_manager)
    set_heartbeat(heartbeat)

    # Initialize consolidator and connect to heartbeat
    consolidator = MemoryConsolidator()
    heartbeat._consolidator = consolidator
    set_consolidator(consolidator, heartbeat)

    # Initialize bottleneck detector
    set_bottleneck_detector(bottleneck_detector)

    # Initialize fleet coordinator (v3.5)
    set_fleet_coordinator(fleet_coordinator)

    # Start engine-managed worker processes
    worker_manager.startup_managed_workers()

    # Start all background loops
    bg_tasks = [
        asyncio.create_task(scheduler.loop(), name="scheduler"),
        asyncio.create_task(service_monitor_loop(), name="service-monitor"),
        asyncio.create_task(auto_executor_loop(), name="auto-executor"),
        asyncio.create_task(resource_monitor.loop(), name="resource-monitor"),
        asyncio.create_task(updater.run(), name="updater"),
        asyncio.create_task(stale_job_sweeper_loop(), name="stale-sweeper"),
        asyncio.create_task(worker_manager.health_loop(), name="worker-health"),
        asyncio.create_task(heartbeat.loop(), name="heartbeat"),
        asyncio.create_task(bottleneck_detector.run(), name="bottleneck-detector"),
        asyncio.create_task(fleet_coordinator.run(), name="fleet-coordinator"),
    ]

    yield

    # Shutdown: stop managed workers and cancel background tasks
    worker_manager.shutdown_managed_workers()
    for t in bg_tasks:
        t.cancel()
    await asyncio.gather(*bg_tasks, return_exceptions=True)


app = FastAPI(
    title="OPAI Engine",
    version="3.5.0",
    description="OPAI Engine — Unified scheduler, monitor, and task manager",
    lifespan=lifespan,
)

# Mount route modules
app.include_router(health_router)
app.include_router(monitor_router)
app.include_router(tasks_router)
app.include_router(feedback_router)
app.include_router(audit_router)
app.include_router(suggestions_router)
app.include_router(users_router)
app.include_router(claude_router)
app.include_router(workers_router)
app.include_router(heartbeat_router)
app.include_router(consolidator_router)
app.include_router(command_channels_router)
app.include_router(bottleneck_router)
app.include_router(fleet_router)
app.include_router(ws_router)

# Serve static files (dashboard UI)
static_dir = Path(__file__).parent / "static"


@app.get("/")
async def index():
    """Serve the engine dashboard."""
    index_html = static_dir / "index.html"
    if index_html.is_file():
        return FileResponse(
            str(index_html),
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )
    return {"service": "opai-engine", "version": "3.5.0", "status": "ok"}


# Static files at /static/ — does not shadow API routes
if static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-engine",
        "version": "3.5.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


@app.get("/api/health")
def api_health():
    """Alias so services probing /api/health also work."""
    return health()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )
