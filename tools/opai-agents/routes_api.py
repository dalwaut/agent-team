"""OPAI Agents — REST API endpoints for agents and squads."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from auth import get_current_user, require_admin, AuthUser
from services import agent_manager, squad_manager, executor, scheduler, workflow_manager, sandbox_bridge, ai_assistant
import config

router = APIRouter(prefix="/api")


# ── Models ─────────────────────────────────────────────────────


class AgentCreate(BaseModel):
    id: str
    name: str
    emoji: str = ""
    description: str = ""
    category: str = "quality"
    run_order: str = "parallel"
    depends_on: list[str] = []
    model: str = ""
    max_turns: int = 0
    no_project_context: bool = False
    prompt_content: str = ""


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    emoji: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    run_order: Optional[str] = None
    depends_on: Optional[list[str]] = None
    model: Optional[str] = None
    max_turns: Optional[int] = None
    no_project_context: Optional[bool] = None
    prompt_content: Optional[str] = None


class SquadCreate(BaseModel):
    id: str
    description: str = ""
    agents: list[str] = []


class SquadUpdate(BaseModel):
    description: Optional[str] = None
    agents: Optional[list[str]] = None


# ── Agents ─────────────────────────────────────────────────────


@router.get("/agents")
async def list_agents(user: AuthUser = Depends(get_current_user)):
    """List all agents (scoped by role)."""
    return {"agents": agent_manager.list_agents(user)}


@router.get("/agents/templates")
async def list_templates(user: AuthUser = Depends(get_current_user)):
    """List available specialist templates."""
    return {"templates": agent_manager.list_templates()}


@router.get("/agents/{agent_id}")
async def get_agent(agent_id: str, user: AuthUser = Depends(get_current_user)):
    """Get agent details + prompt content."""
    agent = agent_manager.get_agent(agent_id, user)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.post("/agents")
async def create_agent(data: AgentCreate, user: AuthUser = Depends(get_current_user)):
    """Create a new agent."""
    if data.run_order not in config.RUN_ORDERS:
        raise HTTPException(400, f"run_order must be one of: {config.RUN_ORDERS}")
    if data.category not in config.AGENT_CATEGORIES:
        raise HTTPException(400, f"category must be one of: {config.AGENT_CATEGORIES}")
    try:
        agent = agent_manager.create_agent(data.model_dump(), user)
        return agent
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.put("/agents/{agent_id}")
async def update_agent(agent_id: str, data: AgentUpdate, user: AuthUser = Depends(get_current_user)):
    """Update an existing agent."""
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    if "run_order" in update_data and update_data["run_order"] not in config.RUN_ORDERS:
        raise HTTPException(400, f"run_order must be one of: {config.RUN_ORDERS}")
    if "category" in update_data and update_data["category"] not in config.AGENT_CATEGORIES:
        raise HTTPException(400, f"category must be one of: {config.AGENT_CATEGORIES}")
    agent = agent_manager.update_agent(agent_id, update_data, user)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete an agent."""
    # Check squad membership first
    squads = agent_manager.get_squad_membership(agent_id, user)
    if squads:
        raise HTTPException(
            status_code=409,
            detail=f"Agent is member of squads: {', '.join(squads)}. Remove from squads first.",
        )
    if not agent_manager.delete_agent(agent_id, user):
        raise HTTPException(status_code=404, detail="Agent not found")
    return {"ok": True, "deleted": agent_id}


# ── Squads ─────────────────────────────────────────────────────


@router.get("/squads")
async def list_squads(user: AuthUser = Depends(get_current_user)):
    """List all squads with resolved agents."""
    return {"squads": squad_manager.list_squads(user)}


@router.get("/squads/{squad_id}")
async def get_squad(squad_id: str, user: AuthUser = Depends(get_current_user)):
    """Get squad details."""
    squad = squad_manager.get_squad(squad_id, user)
    if not squad:
        raise HTTPException(status_code=404, detail="Squad not found")
    return squad


@router.post("/squads")
async def create_squad(data: SquadCreate, user: AuthUser = Depends(get_current_user)):
    """Create a new squad."""
    try:
        squad = squad_manager.create_squad(data.model_dump(), user)
        return squad
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.put("/squads/{squad_id}")
async def update_squad(squad_id: str, data: SquadUpdate, user: AuthUser = Depends(get_current_user)):
    """Update a squad."""
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    try:
        squad = squad_manager.update_squad(squad_id, update_data, user)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if not squad:
        raise HTTPException(status_code=404, detail="Squad not found")
    return squad


@router.delete("/squads/{squad_id}")
async def delete_squad(squad_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete a squad."""
    if not squad_manager.delete_squad(squad_id, user):
        raise HTTPException(status_code=404, detail="Squad not found")
    return {"ok": True, "deleted": squad_id}


# ── Meta ───────────────────────────────────────────────────────


@router.get("/meta/categories")
async def get_categories():
    """Return valid agent categories."""
    return {"categories": config.AGENT_CATEGORIES}


@router.get("/meta/run-orders")
async def get_run_orders():
    """Return valid run order options."""
    return {"run_orders": config.RUN_ORDERS}


# ── Execution ─────────────────────────────────────────────────


@router.post("/run/squad/{squad_name}")
async def trigger_squad_run(squad_name: str, user: AuthUser = Depends(get_current_user)):
    """Trigger a squad run."""
    try:
        run = await executor.run_squad(squad_name, user)
        return run
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/run/agent/{agent_name}")
async def trigger_agent_run(agent_name: str, user: AuthUser = Depends(get_current_user)):
    """Trigger a single agent run."""
    try:
        run = await executor.run_agent(agent_name, user)
        return run
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/runs")
async def list_runs(limit: int = 50, user: AuthUser = Depends(get_current_user)):
    """List run history (active + completed)."""
    active = executor.get_active_runs()
    history = executor.get_run_history(limit)
    return {"active": active, "history": history}


@router.get("/runs/active")
async def active_runs(user: AuthUser = Depends(get_current_user)):
    """Get currently running jobs."""
    return {"runs": executor.get_active_runs()}


@router.get("/runs/{run_id}")
async def get_run(run_id: str, user: AuthUser = Depends(get_current_user)):
    """Get a specific run's details."""
    run = executor.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, user: AuthUser = Depends(get_current_user)):
    """Cancel a running job."""
    if not executor.cancel_run(run_id):
        raise HTTPException(status_code=404, detail="Run not found or already finished")
    return {"ok": True, "cancelled": run_id}


# ── Reports ───────────────────────────────────────────────────


@router.get("/reports/dates")
async def report_dates(user: AuthUser = Depends(get_current_user)):
    """List available report date directories."""
    return {"dates": executor.list_report_dates()}


@router.get("/reports/{date}")
async def list_reports(date: str, user: AuthUser = Depends(get_current_user)):
    """List reports in a date directory (or 'latest')."""
    reports = executor.list_reports(date)
    return {"date": date, "reports": reports}


@router.get("/reports/{date}/{name}")
async def read_report(date: str, name: str, user: AuthUser = Depends(get_current_user)):
    """Read a specific report."""
    report = executor.read_report(date, name)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


# ── Schedules ─────────────────────────────────────────────────


class ScheduleUpdate(BaseModel):
    cron: str


class ScheduleCreate(BaseModel):
    name: str
    cron: str


@router.get("/schedules")
async def list_schedules(user: AuthUser = Depends(require_admin)):
    """List all schedules (admin only)."""
    return {"schedules": scheduler.list_schedules()}


@router.get("/schedules/presets")
async def get_presets(user: AuthUser = Depends(get_current_user)):
    """Return available cron presets."""
    return {"presets": scheduler.get_presets()}


@router.get("/schedules/{name}")
async def get_schedule(name: str, user: AuthUser = Depends(require_admin)):
    """Get a specific schedule."""
    schedule = scheduler.get_schedule(name)
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return schedule


@router.post("/schedules")
async def create_schedule(data: ScheduleCreate, user: AuthUser = Depends(require_admin)):
    """Create a new schedule (admin only)."""
    try:
        return scheduler.create_schedule(data.name, data.cron)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/schedules/{name}")
async def update_schedule(name: str, data: ScheduleUpdate, user: AuthUser = Depends(require_admin)):
    """Update a schedule's cron expression (admin only)."""
    try:
        schedule = scheduler.update_schedule(name, data.cron)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return schedule


@router.delete("/schedules/{name}")
async def delete_schedule(name: str, user: AuthUser = Depends(require_admin)):
    """Delete a schedule (admin only)."""
    if not scheduler.delete_schedule(name):
        raise HTTPException(status_code=404, detail="Schedule not found")
    return {"ok": True, "deleted": name}


# ── Workflows ─────────────────────────────────────────────────


class WorkflowStep(BaseModel):
    squad: str
    on_fail: str = "stop"
    custom_prompt: Optional[str] = None


class WorkflowCreate(BaseModel):
    id: str
    description: str = ""
    steps: list[WorkflowStep] = []
    flow: Optional[dict] = None
    triggers: Optional[dict] = None


class WorkflowUpdate(BaseModel):
    description: Optional[str] = None
    steps: Optional[list[WorkflowStep]] = None
    flow: Optional[dict] = None
    triggers: Optional[dict] = None


class AIBuildRequest(BaseModel):
    prompt: str


@router.get("/workflows")
async def list_workflows(user: AuthUser = Depends(get_current_user)):
    """List all workflows."""
    return {"workflows": workflow_manager.list_workflows(user)}


@router.get("/workflows/{workflow_id}")
async def get_workflow(workflow_id: str, user: AuthUser = Depends(get_current_user)):
    """Get workflow details."""
    wf = workflow_manager.get_workflow(workflow_id, user)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return wf


@router.post("/workflows")
async def create_workflow(data: WorkflowCreate, user: AuthUser = Depends(get_current_user)):
    """Create a workflow."""
    try:
        return workflow_manager.create_workflow(data.model_dump(), user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/workflows/{workflow_id}")
async def update_workflow(workflow_id: str, data: WorkflowUpdate, user: AuthUser = Depends(get_current_user)):
    """Update a workflow."""
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    if "steps" in update_data:
        update_data["steps"] = [s.model_dump() if hasattr(s, "model_dump") else s for s in update_data["steps"]]
    try:
        wf = workflow_manager.update_workflow(workflow_id, update_data, user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return wf


@router.delete("/workflows/{workflow_id}")
async def delete_workflow(workflow_id: str, user: AuthUser = Depends(get_current_user)):
    """Delete a workflow."""
    if not workflow_manager.delete_workflow(workflow_id, user):
        raise HTTPException(status_code=404, detail="Workflow not found")
    return {"ok": True, "deleted": workflow_id}


# ── AI Flow Builder ───────────────────────────────────


@router.post("/flow/ai-build")
async def ai_build_flow(data: AIBuildRequest, user: AuthUser = Depends(get_current_user)):
    """Use AI to generate a flow from natural language."""
    try:
        result = await ai_assistant.build_flow(data.prompt, user)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI build failed: {str(e)}")


# ── Sandbox ───────────────────────────────────────────────────


@router.get("/sandbox/info")
async def sandbox_info(user: AuthUser = Depends(get_current_user)):
    """Get sandbox info for current user."""
    info = sandbox_bridge.get_sandbox_info(user)
    if not info:
        raise HTTPException(status_code=404, detail="No sandbox configured")
    return info


@router.post("/sandbox/init")
async def init_sandbox(user: AuthUser = Depends(get_current_user)):
    """Initialize agents directory in user's sandbox."""
    try:
        return sandbox_bridge.init_sandbox_agents(user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
