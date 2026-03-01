"""2nd Brain — Health route."""
import resource
import time

from fastapi import APIRouter

router = APIRouter()

_start_time = time.time()


@router.get("/health")
@router.get("/api/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "brain",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }
