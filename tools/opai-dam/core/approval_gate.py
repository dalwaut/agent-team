"""DAM Bot — Approval Gate.

Tiered HITL system controlled by per-session autonomy_level (1-10).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from core.supabase import sb_post, sb_patch, sb_get
from core.realtime import broadcast_realtime, broadcast_discord

log = logging.getLogger("dam.approval")

# Approval matrix: (action_category, autonomy_level) -> decision
# Returns: "auto" (proceed), "confirm" (needs approval), "ceo_gate", "block"
# 4 distinct tiers:
#   1 = Supervised   — confirms sandbox + external + publish + purchase, blocks irreversible
#   2 = Guided       — auto sandbox, confirms external + publish + purchase, blocks irreversible
#   3 = Autonomous   — auto sandbox, confirms external + publish + purchase, CEO-gates irreversible
#   4 = Full         — auto sandbox + external + publish, confirms purchase only, CEO-gates irreversible
APPROVAL_MATRIX = {
    "read":               {(1, 4): "auto"},
    "sandbox_write":      {(1, 1): "confirm", (2, 4): "auto"},
    "external_api_write": {(1, 3): "confirm", (4, 4): "auto"},
    "purchase":           {(1, 4): "confirm"},
    "content_publish":    {(1, 3): "confirm", (4, 4): "auto"},
    "large_financial":    {(1, 4): "ceo_gate"},
    "irreversible":       {(1, 2): "block", (3, 4): "ceo_gate"},
}


def classify_action(step_type: str, step_config: dict) -> str:
    """Classify a step into an action category for approval decisions."""
    if step_type == "approval_gate":
        risk = step_config.get("risk_level", "medium")
        if risk == "critical":
            return "large_financial"
        if risk == "high":
            return "irreversible"
        return "external_api_write"

    if step_type in ("agent_run", "squad_run"):
        return "sandbox_write"

    if step_type == "tool_call":
        tool = step_config.get("tool", "")
        if tool == "purchase":
            return "purchase"
        if tool == "browser":
            method = step_config.get("params", {}).get("action", "navigate")
            if method in ("click", "fill", "submit"):
                return "external_api_write"
            return "read"
        if tool == "api_caller":
            method = step_config.get("params", {}).get("method", "GET").upper()
            if method == "GET":
                return "read"
            return "external_api_write"
        return "sandbox_write"

    return "read"


def get_decision(action_category: str, autonomy_level: int) -> str:
    """Get approval decision for an action at a given autonomy level."""
    matrix = APPROVAL_MATRIX.get(action_category, {(1, 10): "confirm"})
    for (low, high), decision in matrix.items():
        if low <= autonomy_level <= high:
            return decision
    return "confirm"


async def check_approval(
    session_id: str,
    step_id: str,
    step_type: str,
    step_config: dict,
    autonomy_level: int,
    step_title: str = "",
) -> dict:
    """Check if a step needs approval. Returns {"decision": "auto|confirm|ceo_gate|block", ...}."""
    category = classify_action(step_type, step_config)
    decision = get_decision(category, autonomy_level)

    if step_config.get("approval_required") or (step_type == "approval_gate"):
        decision = max(decision, "confirm", key=lambda x: ["auto", "confirm", "ceo_gate", "block"].index(x))

    if decision == "auto":
        return {"decision": "auto", "category": category}

    # Create approval record
    risk_map = {"confirm": "medium", "ceo_gate": "high", "block": "critical"}
    risk_level = step_config.get("risk_level", risk_map.get(decision, "medium"))

    approval = await sb_post("dam_approvals", {
        "session_id": session_id,
        "step_id": step_id,
        "approval_type": decision,
        "risk_level": risk_level,
        "title": step_title or f"Approval needed: {step_type}",
        "description": step_config.get("reason", f"Action category: {category}"),
        "payload": step_config,
    })
    approval_row = approval[0] if isinstance(approval, list) else approval

    # Broadcast
    await broadcast_realtime(session_id, {
        "type": "approval_needed",
        "approval_id": approval_row["id"],
        "step_id": step_id,
        "title": step_title,
        "risk_level": risk_level,
    })

    await broadcast_discord(
        f"DAM Approval [{risk_level.upper()}]: {step_title}",
        level="warn" if risk_level in ("high", "critical") else "info",
    )

    return {
        "decision": decision,
        "category": category,
        "approval_id": approval_row["id"],
    }


async def resolve_approval(approval_id: str, approved: bool, user_id: str) -> dict:
    """Approve or reject a pending approval."""
    now = datetime.now(timezone.utc).isoformat()
    status = "approved" if approved else "rejected"

    result = await sb_patch(f"dam_approvals?id=eq.{approval_id}", {
        "status": status,
        "decided_by": user_id,
        "decided_at": now,
    })
    row = result[0] if isinstance(result, list) else result

    # Broadcast decision
    if row.get("session_id"):
        await broadcast_realtime(row["session_id"], {
            "type": "approval_resolved",
            "approval_id": approval_id,
            "status": status,
        })

    return row
