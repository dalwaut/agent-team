"""DAM Bot — Step Executor.

Dispatches individual steps to the appropriate handler based on step_type.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

from core.agent_bridge import run_agent, run_squad
from core.supabase import sb_patch, sb_post
from core.realtime import broadcast_realtime

import config

log = logging.getLogger("dam.executor")

# Cache of agent roles from team.json (loaded once)
_team_roles: dict[str, dict] | None = None

DEFAULT_MODEL = "sonnet"


def _load_team_roles() -> dict[str, dict]:
    """Load agent roster from team.json, keyed by agent id."""
    global _team_roles
    if _team_roles is not None:
        return _team_roles
    try:
        data = json.loads(config.TEAM_JSON.read_text())
        _team_roles = {a["id"]: a for a in data.get("agents", []) if "id" in a}
    except Exception as exc:
        log.warning("Failed to load team.json: %s", exc)
        _team_roles = {}
    return _team_roles


def resolve_model(step_config: dict, session_model: str | None, agent_id: str | None = None) -> str:
    """Resolve model using cascade: step config > session pref > team.json agent > default."""
    # 1. Step-level model (set by planner in auto mode)
    step_model = step_config.get("model")
    if step_model:
        return step_model

    # 2. Session-level preference (if not "auto")
    if session_model and session_model != "auto":
        return session_model

    # 3. Agent-level model from team.json
    if agent_id:
        roles = _load_team_roles()
        agent_model = roles.get(agent_id, {}).get("model")
        if agent_model:
            return agent_model

    # 4. System default
    return DEFAULT_MODEL


async def execute_step(step: dict, session_id: str, session_model: str | None = None) -> dict:
    """Execute a single plan step. Returns the result dict.

    Args:
        session_model: Session-level model preference (None or "auto" means use step/agent defaults).
    """
    step_id = step["id"]
    step_type = step["step_type"]
    step_config = step.get("config", {})
    now = datetime.now(timezone.utc).isoformat()

    # Mark step as running
    await sb_patch(f"dam_steps?id=eq.{step_id}", {
        "status": "running",
        "started_at": now,
    })

    await _log(session_id, step_id, "info", f"Executing step: {step.get('title', step_type)}")
    await broadcast_realtime(session_id, {
        "type": "step_started",
        "step_id": step_id,
        "step_type": step_type,
    })

    start = time.time()
    result = {}

    try:
        if step_type == "agent_run":
            result = await _exec_agent(step_config, session_model)
        elif step_type == "squad_run":
            result = await _exec_squad(step_config)
        elif step_type == "tool_call":
            result = await _exec_tool(step_config)
        elif step_type == "skill_call":
            result = await _exec_skill(step_config)
        elif step_type == "approval_gate":
            # Approval gates are handled by the pipeline, not the executor
            result = {"output": "Approval gate — handled by pipeline", "success": True}
        elif step_type == "hook":
            result = await _exec_hook(step_config)
        else:
            result = {"output": "", "success": False, "error": f"Unknown step type: {step_type}"}

    except Exception as exc:
        log.error("Step %s execution error: %s", step_id, exc)
        result = {"output": "", "success": False, "error": str(exc)}

    duration_ms = int((time.time() - start) * 1000)
    status = "completed" if result.get("success") else "failed"
    completed_at = datetime.now(timezone.utc).isoformat()

    # Update step
    await sb_patch(f"dam_steps?id=eq.{step_id}", {
        "status": status,
        "result": result,
        "completed_at": completed_at,
        "duration_ms": duration_ms,
    })

    await _log(
        session_id, step_id,
        "info" if result.get("success") else "error",
        f"Step {status}: {step.get('title', '')} ({duration_ms}ms)",
    )

    await broadcast_realtime(session_id, {
        "type": "step_completed",
        "step_id": step_id,
        "status": status,
        "duration_ms": duration_ms,
    })

    return result


async def _exec_agent(step_config: dict, session_model: str | None = None) -> dict:
    """Execute an agent_run step with model resolution."""
    agent_id = step_config.get("agent_id", "")
    prompt = step_config.get("prompt", "")
    context_path = step_config.get("context_path")
    timeout = step_config.get("timeout", 300)

    if not agent_id or not prompt:
        return {"output": "", "success": False, "error": "agent_id and prompt required"}

    model = resolve_model(step_config, session_model, agent_id)
    log.info("Step agent=%s resolved model=%s", agent_id, model)

    return await run_agent(agent_id, prompt, context_path=context_path, timeout_seconds=timeout, model=model)


async def _exec_squad(config: dict) -> dict:
    """Execute a squad_run step."""
    squad_id = config.get("squad_id", "")
    if not squad_id:
        return {"output": "", "success": False, "error": "squad_id required"}

    return await run_squad(squad_id)


async def _exec_tool(config: dict) -> dict:
    """Execute a tool_call step (Phase 2 — stub for now)."""
    tool = config.get("tool", "")
    params = config.get("params", {})

    # Phase 1: stub responses for tool calls
    return {
        "output": f"Tool '{tool}' execution is a Phase 2 feature. Params: {params}",
        "success": True,
        "error": None,
        "stub": True,
    }


async def _exec_skill(config: dict) -> dict:
    """Execute a skill_call step (Phase 3 — stub for now)."""
    skill_name = config.get("skill_name", "")
    return {
        "output": f"Skill '{skill_name}' execution is a Phase 3 feature.",
        "success": True,
        "error": None,
        "stub": True,
    }


async def _exec_hook(config: dict) -> dict:
    """Execute a hook step (Phase 3 — stub for now)."""
    hook_name = config.get("hook_name", "")
    return {
        "output": f"Hook '{hook_name}' execution is a Phase 3 feature.",
        "success": True,
        "error": None,
        "stub": True,
    }


async def _log(session_id: str, step_id: str | None, level: str, message: str):
    """Write to dam_session_logs."""
    try:
        await sb_post("dam_session_logs", {
            "session_id": session_id,
            "step_id": step_id,
            "level": level,
            "message": message,
        })
    except Exception as exc:
        log.warning("Failed to write session log: %s", exc)
