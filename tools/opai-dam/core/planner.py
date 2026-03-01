"""DAM Bot — Planner Engine.

Takes a user goal and decomposes it into an executable plan tree
using Claude for intelligent decomposition.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from core.ai import call_claude, DAM_SYSTEM_PROMPT
from core.supabase import sb_post, sb_patch, sb_get

import config

log = logging.getLogger("dam.planner")


async def _load_available_agents() -> list[dict]:
    """Load agent roster from team.json for context."""
    try:
        data = json.loads(config.TEAM_JSON.read_text())
        agents = data.get("agents", [])
        return [{"id": a.get("id"), "name": a.get("name"), "role": a.get("role")}
                for a in agents[:50]]
    except Exception:
        return []


async def create_plan(session_id: str, goal: str, context: dict | None = None, model_preference: str = "auto") -> dict:
    """Decompose a goal into a plan tree via Claude.

    Args:
        model_preference: Session model preference. When "auto", planner assigns
            optimal model per step. When a specific model, planner skips model assignment.

    Returns the created plan row (with plan_tree populated).
    """
    agents = await _load_available_agents()

    context_block = ""
    if context:
        context_block = f"\n\nAdditional context:\n{json.dumps(context, indent=2)}"

    model_instruction = ""
    if model_preference == "auto":
        model_instruction = (
            "\n\n## Model Assignment\n"
            "For each step, assign the optimal Claude model based on task complexity:\n"
            '- "haiku" — Low intensity: file reads, data classification, tagging, simple formatting, status checks\n'
            '- "sonnet" — Medium intensity: standard code generation, analysis, bug fixes, content writing, API integration\n'
            '- "opus" — High intensity: architecture design, complex multi-file refactors, security audits, strategic planning\n\n'
            'Include a "model" field (haiku/sonnet/opus) and a "model_reason" field (brief justification) '
            "in each step's config object.\n"
        )

    user_prompt = (
        f"## Goal\n{goal}\n\n"
        f"## Available Agents ({len(agents)} total)\n"
        f"{json.dumps(agents[:20], indent=2)}\n\n"
        f"## Available Squads\n"
        f"audit, evolve, incident, release, research, security, daily_ops, feedback\n\n"
        f"## Available Tools\n"
        f"browser, file_ops, api_caller, code_builder\n"
        f"{model_instruction}"
        f"{context_block}\n\n"
        f"Decompose this goal into a concrete step-by-step plan. "
        f"Output a JSON array of step objects."
    )

    result = await call_claude(user_prompt, expect_json=True)
    steps_raw = result.get("parsed") or []

    if not isinstance(steps_raw, list):
        steps_raw = [steps_raw] if steps_raw else []

    # Deactivate any existing active plans for this session
    try:
        existing = await sb_get(
            f"dam_plans?session_id=eq.{session_id}&is_active=eq.true&select=id,version"
        )
        for p in existing:
            await sb_patch(f"dam_plans?id=eq.{p['id']}", {"is_active": False})
    except Exception as exc:
        log.warning("Failed to deactivate old plans: %s", exc)

    # Get next version number
    try:
        all_plans = await sb_get(
            f"dam_plans?session_id=eq.{session_id}&select=version&order=version.desc&limit=1"
        )
        next_version = (all_plans[0]["version"] + 1) if all_plans else 1
    except Exception:
        next_version = 1

    # Create plan row
    plan_row = await sb_post("dam_plans", {
        "session_id": session_id,
        "version": next_version,
        "is_active": True,
        "plan_tree": steps_raw,
        "summary": result.get("content", "")[:500],
    })
    plan = plan_row[0] if isinstance(plan_row, list) else plan_row
    plan_id = plan["id"]

    # Create step rows
    step_ids = []
    for i, step_data in enumerate(steps_raw):
        depends_indices = step_data.get("depends_on", [])
        depends_uuids = [step_ids[idx] for idx in depends_indices if idx < len(step_ids)]

        step_row = await sb_post("dam_steps", {
            "plan_id": plan_id,
            "session_id": session_id,
            "ordinal": i,
            "title": step_data.get("title", f"Step {i + 1}"),
            "description": step_data.get("description", ""),
            "step_type": step_data.get("step_type", "agent_run"),
            "config": step_data.get("config", {}),
            "depends_on": depends_uuids,
            "approval_required": step_data.get("approval_required", False),
        })
        row = step_row[0] if isinstance(step_row, list) else step_row
        step_ids.append(row["id"])

    # Update session status
    await sb_patch(f"dam_sessions?id=eq.{session_id}", {"status": "planning"})

    plan["step_count"] = len(steps_raw)
    plan["ai_result"] = {
        "tokens_used": result.get("tokens_used", 0),
        "cost_usd": result.get("cost_usd", 0),
        "duration_ms": result.get("duration_ms", 0),
    }

    return plan


async def revise_plan(session_id: str, plan_id: str, feedback: str) -> dict:
    """Revise an existing plan based on user feedback."""
    # Load current plan
    plans = await sb_get(f"dam_plans?id=eq.{plan_id}&select=*")
    if not plans:
        raise ValueError(f"Plan {plan_id} not found")
    current_plan = plans[0]

    # Load session for goal + model preference
    sessions = await sb_get(f"dam_sessions?id=eq.{session_id}&select=goal,model_preference")
    goal = sessions[0]["goal"] if sessions else "Unknown goal"
    model_preference = sessions[0].get("model_preference", "auto") if sessions else "auto"

    user_prompt = (
        f"## Original Goal\n{goal}\n\n"
        f"## Current Plan\n{json.dumps(current_plan['plan_tree'], indent=2)}\n\n"
        f"## User Feedback\n{feedback}\n\n"
        f"Revise the plan based on this feedback. Output the complete updated JSON array."
    )

    result = await call_claude(user_prompt, expect_json=True)
    steps_raw = result.get("parsed") or current_plan["plan_tree"]

    # Create new plan version (deactivates old one via create_plan logic)
    return await create_plan(session_id, goal, context={"revision_feedback": feedback}, model_preference=model_preference)
