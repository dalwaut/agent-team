"""
FastAPI Web Server for WordPress Agent
Provides REST API endpoints for webapp integration
"""

from typing import Any, Dict, List, Optional
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.orchestrator import AgentOrchestrator


# Pydantic models for API
class ExecuteRequest(BaseModel):
    """Request model for execute endpoint"""
    agent: str
    action: str
    params: Dict[str, Any] = {}


class ActionResultResponse(BaseModel):
    """Response model for action results"""
    action: str
    status: str
    data: Any = None
    error: Optional[str] = None
    duration_ms: Optional[float] = None


class AgentInfo(BaseModel):
    """Agent information"""
    name: str
    description: str
    capabilities_count: int


class CapabilityInfo(BaseModel):
    """Capability information"""
    agent: str
    action: str
    description: str
    method: str
    full_name: str


# Create FastAPI app
app = FastAPI(
    title="WordPress Agent API",
    description="REST API for managing WordPress sites via agentic system",
    version="0.1.0",
)

# CORS middleware for webapp integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global orchestrator instance
orchestrator: Optional[AgentOrchestrator] = None


@app.on_event("startup")
async def startup():
    """Initialize orchestrator on startup"""
    global orchestrator
    orchestrator = AgentOrchestrator()
    orchestrator.initialize()


@app.get("/", tags=["System"])
async def root():
    """API root - system info"""
    if orchestrator:
        return orchestrator.to_dict()
    return {"status": "not_initialized"}


@app.get("/health", tags=["System"])
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "initialized": orchestrator is not None and orchestrator._initialized}


@app.get("/test", tags=["System"])
async def test_connection():
    """Test WordPress API connection"""
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    result = orchestrator.test_connection()
    return ActionResultResponse(
        action=result.action,
        status=result.status.value,
        data=result.data,
        error=result.error,
        duration_ms=result.duration_ms
    )


@app.get("/agents", response_model=List[AgentInfo], tags=["Agents"])
async def list_agents():
    """List all available agents"""
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    return orchestrator.list_agents()


@app.get("/agents/{agent_name}", tags=["Agents"])
async def get_agent(agent_name: str):
    """Get agent details"""
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    agent = orchestrator.get_agent(agent_name)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_name}")

    return agent.to_dict()


@app.get("/capabilities", response_model=List[CapabilityInfo], tags=["Capabilities"])
async def list_capabilities(agent: Optional[str] = Query(None, description="Filter by agent")):
    """List all capabilities, optionally filtered by agent"""
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    caps = orchestrator.list_all_capabilities()

    if agent:
        caps = [c for c in caps if c["agent"] == agent]

    return caps


@app.post("/execute", response_model=ActionResultResponse, tags=["Execute"])
async def execute(request: ExecuteRequest):
    """Execute an agent action"""
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    result = orchestrator.execute(request.agent, request.action, **request.params)

    return ActionResultResponse(
        action=result.action,
        status=result.status.value,
        data=result.data,
        error=result.error,
        duration_ms=result.duration_ms
    )


@app.post("/execute/{command}", response_model=ActionResultResponse, tags=["Execute"])
async def execute_command(command: str, params: Dict[str, Any] = Body(default={})):
    """
    Execute a command in format 'agent.action'

    Example: POST /execute/posts.list with body {"per_page": 5}
    """
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    result = orchestrator.execute_command(command, **params)

    return ActionResultResponse(
        action=result.action,
        status=result.status.value,
        data=result.data,
        error=result.error,
        duration_ms=result.duration_ms
    )


# Content-specific convenience endpoints
@app.get("/posts", tags=["Content"])
async def list_posts(
    page: int = 1,
    per_page: int = 10,
    search: Optional[str] = None,
    status: Optional[str] = None
):
    """List posts"""
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    params = {"page": page, "per_page": per_page}
    if search:
        params["search"] = search
    if status:
        params["status"] = status

    result = orchestrator.execute("posts", "list", **params)
    return {"status": result.status.value, "data": result.data, "error": result.error}


@app.get("/pages", tags=["Content"])
async def list_pages(
    page: int = 1,
    per_page: int = 10,
    search: Optional[str] = None
):
    """List pages"""
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    params = {"page": page, "per_page": per_page}
    if search:
        params["search"] = search

    result = orchestrator.execute("pages", "list", **params)
    return {"status": result.status.value, "data": result.data, "error": result.error}


@app.get("/media", tags=["Content"])
async def list_media(
    page: int = 1,
    per_page: int = 10,
    media_type: Optional[str] = None
):
    """List media items"""
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    params = {"page": page, "per_page": per_page}
    if media_type:
        params["media_type"] = media_type

    result = orchestrator.execute("media", "list", **params)
    return {"status": result.status.value, "data": result.data, "error": result.error}


def run_server(host: str = "0.0.0.0", port: int = 8000):
    """Run the API server"""
    import uvicorn
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run_server()
