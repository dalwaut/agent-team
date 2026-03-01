"""Health check endpoints."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
@router.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "opai-browser",
    }
