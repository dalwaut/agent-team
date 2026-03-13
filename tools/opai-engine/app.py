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

from fastapi import FastAPI, Request
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

# Set root log level so opai.* loggers (INFO) actually emit
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(name)s: %(message)s")

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
from routes.action_items import router as action_items_router
from routes.nfs import router as nfs_router
from routes.nfs import set_dispatcher as set_nfs_dispatcher
from routes.assembly import router as assembly_router
from routes.assembly import set_pipeline as set_assembly_pipeline
from routes.demos import router as demos_router
from routes.mail import router as mail_router
from routes.mail import set_mail as set_worker_mail
from routes.google_chat import router as google_chat_router
from routes.notifications import router as notifications_router
from routes.newsletter import router as newsletter_router
from routes.newsletter import set_scheduler as set_newsletter_scheduler
from routes.notebooklm import router as notebooklm_router
from routes.agent_feedback import router as agent_feedback_router
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
from background.nfs_dispatcher import NfsDispatcher
from background.process_sweeper import process_sweeper_loop
from background.assembly import AssemblyPipeline
from services.worker_mail import WorkerMail
import services.task_processor as task_processor

logger = logging.getLogger("opai-engine")

# Shared instances
updater = UpdaterAgent()
resource_monitor = ResourceMonitor()
scheduler = Scheduler()
worker_manager = WorkerManager()
worker_mail = WorkerMail()
bottleneck_detector = BottleneckDetector()
fleet_coordinator = FleetCoordinator(worker_manager, scheduler, worker_mail)
nfs_dispatcher = NfsDispatcher(fleet_coordinator)
assembly_pipeline = AssemblyPipeline(fleet_coordinator, worker_manager, worker_mail)


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
    scheduler.worker_manager = worker_manager
    set_worker_manager(worker_manager)
    set_newsletter_scheduler(scheduler)

    # Wire worker mail to manager and set registry
    worker_manager._mail = worker_mail
    worker_mail.set_worker_registry(worker_manager.workers)
    set_worker_mail(worker_mail)

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

    # Initialize NFS dispatcher (v3.5 — external workers)
    set_nfs_dispatcher(nfs_dispatcher)

    # Initialize Assembly Line pipeline (v3.7)
    set_assembly_pipeline(assembly_pipeline)
    assembly_pipeline.resume_active_runs()

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
        asyncio.create_task(nfs_dispatcher.run(), name="nfs-dispatcher"),
        asyncio.create_task(process_sweeper_loop(worker_manager), name="process-sweeper"),
        asyncio.create_task(feedback_loop(), name="feedback-decay"),
    ]

    # NotebookLM wiki sync (daily, non-critical)
    try:
        from background.notebooklm_sync import sync_loop as nlm_sync_loop
        bg_tasks.append(asyncio.create_task(nlm_sync_loop(), name="notebooklm-sync"))
    except ImportError as e:
        logger.debug("NotebookLM sync not available: %s", e)

    # Fast chat poll loop (30s) — runs independently of cron scheduler
    try:
        from background.workspace_chat import chat_fast_loop
        bg_tasks.append(asyncio.create_task(chat_fast_loop(), name="chat-fast-loop"))
    except ImportError as e:
        logger.warning("Chat fast loop not available: %s", e)

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
app.include_router(action_items_router)
app.include_router(nfs_router)
app.include_router(assembly_router)
app.include_router(demos_router)
app.include_router(mail_router)
app.include_router(google_chat_router)
app.include_router(notifications_router)
app.include_router(newsletter_router)
app.include_router(notebooklm_router)
app.include_router(agent_feedback_router)
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

# Serve portal auth JS for direct access (when not through Caddy)
portal_static = Path(__file__).parent.parent / "opai-portal" / "static"
if portal_static.is_dir():
    app.mount("/auth/static", StaticFiles(directory=str(portal_static)), name="auth-static")


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


@app.get("/auth/config")
def root_auth_config(request: Request):
    """Auth config at root path — for direct access (not through Caddy)."""
    from_local = request.client and request.client.host in ("127.0.0.1", "::1", "localhost")
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
        "auth_disabled": bool(from_local),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )
