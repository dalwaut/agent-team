"""DAM Bot — Pipeline Engine.

Executes plans step-by-step with dependency tracking, approval gates,
and hook injection points.
"""

from __future__ import annotations

import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from core.supabase import sb_get, sb_patch, sb_post
from core.executor import execute_step
from core.approval_gate import check_approval
from core.realtime import broadcast_realtime

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "shared"))
from audit import log_audit

log = logging.getLogger("dam.pipeline")


async def run_pipeline(session_id: str) -> dict:
    """Execute all steps in the active plan for a session.

    Respects dependency ordering, approval gates, and tracks progress.
    Returns summary dict.
    """
    # Load session
    sessions = await sb_get(f"dam_sessions?id=eq.{session_id}&select=*")
    if not sessions:
        raise ValueError(f"Session {session_id} not found")
    session = sessions[0]
    autonomy = session.get("autonomy_level", 7)

    # Model preference: "auto" means let planner/agent decide, else force that model
    model_pref = session.get("model_preference", "auto")
    session_model = None if model_pref == "auto" else model_pref

    # Load active plan
    plans = await sb_get(
        f"dam_plans?session_id=eq.{session_id}&is_active=eq.true&select=id"
    )
    if not plans:
        raise ValueError(f"No active plan for session {session_id}")
    plan_id = plans[0]["id"]

    # Load all steps, ordered
    steps = await sb_get(
        f"dam_steps?plan_id=eq.{plan_id}&select=*&order=ordinal.asc"
    )
    if not steps:
        return {"status": "completed", "steps_total": 0, "message": "No steps to execute"}

    # Update session status
    await sb_patch(f"dam_sessions?id=eq.{session_id}", {"status": "executing"})
    await broadcast_realtime(session_id, {"type": "pipeline_started", "total_steps": len(steps)})

    start_time = time.time()
    completed = 0
    failed = 0
    skipped = 0

    # Build step lookup for dependency checking
    step_map = {s["id"]: s for s in steps}

    for step in steps:
        step_id = step["id"]

        # Skip already completed/failed/skipped
        if step["status"] in ("completed", "failed", "skipped"):
            if step["status"] == "completed":
                completed += 1
            elif step["status"] == "failed":
                failed += 1
            else:
                skipped += 1
            continue

        # Check dependencies
        depends_on = step.get("depends_on") or []
        deps_met = True
        for dep_id in depends_on:
            dep = step_map.get(dep_id)
            if dep and dep["status"] != "completed":
                deps_met = False
                break

        if not deps_met:
            await sb_patch(f"dam_steps?id=eq.{step_id}", {"status": "blocked"})
            await _log(session_id, step_id, "warn", f"Step blocked — dependencies not met")
            skipped += 1
            continue

        # Check approval gate
        if step.get("approval_required") or step["step_type"] == "approval_gate":
            approval_result = await check_approval(
                session_id=session_id,
                step_id=step_id,
                step_type=step["step_type"],
                step_config=step.get("config", {}),
                autonomy_level=autonomy,
                step_title=step.get("title", ""),
            )

            if approval_result["decision"] == "block":
                await sb_patch(f"dam_steps?id=eq.{step_id}", {"status": "skipped"})
                await _log(session_id, step_id, "warn", "Step blocked by approval policy")
                skipped += 1
                continue

            if approval_result["decision"] in ("confirm", "ceo_gate"):
                # Mark step as awaiting approval and pause pipeline
                await sb_patch(f"dam_steps?id=eq.{step_id}", {"status": "awaiting_approval"})
                await sb_patch(f"dam_sessions?id=eq.{session_id}", {"status": "paused"})
                await _log(session_id, step_id, "info",
                           f"Pipeline paused — awaiting {approval_result['decision']}")

                duration_ms = int((time.time() - start_time) * 1000)
                log_audit(
                    tier="execution",
                    service="opai-dam",
                    event="pipeline-paused",
                    status="partial",
                    summary=f"Pipeline paused at step '{step.get('title', '')}' — awaiting approval",
                    duration_ms=duration_ms,
                    details={"session_id": session_id, "step_id": step_id},
                )

                return {
                    "status": "paused",
                    "paused_at_step": step_id,
                    "approval_id": approval_result.get("approval_id"),
                    "completed": completed,
                    "failed": failed,
                    "skipped": skipped,
                    "total": len(steps),
                }

        # Execute step (pass session-level model preference)
        result = await execute_step(step, session_id, session_model=session_model)

        # Update local state
        if result.get("success"):
            step["status"] = "completed"
            completed += 1
        else:
            step["status"] = "failed"
            failed += 1
            # On failure, skip dependent steps
            for other in steps:
                deps = other.get("depends_on") or []
                if step_id in deps and other["status"] == "pending":
                    await sb_patch(f"dam_steps?id=eq.{other['id']}", {"status": "skipped"})
                    other["status"] = "skipped"
                    skipped += 1

    # Pipeline complete
    duration_ms = int((time.time() - start_time) * 1000)
    final_status = "completed" if failed == 0 else "failed"

    await sb_patch(f"dam_sessions?id=eq.{session_id}", {"status": final_status})
    await broadcast_realtime(session_id, {
        "type": "pipeline_completed",
        "status": final_status,
        "completed": completed,
        "failed": failed,
        "skipped": skipped,
    })

    # TCP integration
    try:
        import httpx
        import config as cfg
        await _post_task(cfg, session, final_status, completed, failed, duration_ms)
    except Exception as exc:
        log.warning("Failed to post to Task Registry: %s", exc)

    log_audit(
        tier="execution",
        service="opai-dam",
        event="pipeline-complete",
        status="completed" if failed == 0 else "partial",
        summary=f"DAM session '{session.get('title', '')}': {completed} done, {failed} failed, {skipped} skipped",
        duration_ms=duration_ms,
        details={
            "session_id": session_id,
            "completed": completed,
            "failed": failed,
            "skipped": skipped,
        },
    )

    return {
        "status": final_status,
        "completed": completed,
        "failed": failed,
        "skipped": skipped,
        "total": len(steps),
        "duration_ms": duration_ms,
    }


async def resume_pipeline(session_id: str) -> dict:
    """Resume a paused pipeline after approval resolution."""
    sessions = await sb_get(f"dam_sessions?id=eq.{session_id}&select=status")
    if not sessions or sessions[0]["status"] != "paused":
        raise ValueError("Session is not paused")

    # Find the step awaiting approval
    steps = await sb_get(
        f"dam_steps?session_id=eq.{session_id}&status=eq.awaiting_approval&select=id"
    )

    if steps:
        step_id = steps[0]["id"]
        # Check if approval was granted
        approvals = await sb_get(
            f"dam_approvals?step_id=eq.{step_id}&status=eq.approved&select=id"
        )
        if approvals:
            # Mark step as pending so pipeline picks it up
            await sb_patch(f"dam_steps?id=eq.{step_id}", {"status": "pending"})
        else:
            # Check if rejected
            rejections = await sb_get(
                f"dam_approvals?step_id=eq.{step_id}&status=eq.rejected&select=id"
            )
            if rejections:
                await sb_patch(f"dam_steps?id=eq.{step_id}", {"status": "skipped"})

    return await run_pipeline(session_id)


async def _log(session_id: str, step_id: str | None, level: str, message: str):
    try:
        await sb_post("dam_session_logs", {
            "session_id": session_id,
            "step_id": step_id,
            "level": level,
            "message": message,
        })
    except Exception:
        pass


async def _post_task(cfg, session, status, completed, failed, duration_ms):
    import httpx
    task_entry = {
        "title": f"DAM: {session.get('title', 'Session')}",
        "type": "dam_session",
        "status": "completed" if status == "completed" else "failed",
        "agent": "dam-bot",
        "source": "dam",
        "tags": ["dam", "pipeline"],
    }
    async with httpx.AsyncClient(timeout=10) as c:
        await c.post(
            f"{cfg.TASKS_URL}/api/tasks",
            json=task_entry,
            headers={"Content-Type": "application/json"},
        )
