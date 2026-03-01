"""Bx4 — Team Hub integration for pushing recommendations as tasks."""

from __future__ import annotations

import logging

import httpx

import config

log = logging.getLogger("bx4.taskhub")


async def create_task(recommendation: dict, company_name: str) -> dict | None:
    """POST to Team Hub internal endpoint to create a task from a recommendation.

    Returns {id} or None on failure. Non-blocking.
    """
    try:
        payload = {
            "title": recommendation.get("title", "Bx4 Recommendation"),
            "description": (
                f"[Bx4 - {company_name}] "
                f"Urgency: {recommendation.get('urgency', 'medium')} | "
                f"Impact: {recommendation.get('financial_impact', 'neutral')}\n\n"
                f"Why it matters: {recommendation.get('why_it_matters', 'N/A')}\n\n"
                f"What to do: {recommendation.get('what_to_do', 'N/A')}"
            ),
            "priority": recommendation.get("urgency", "medium").lower(),
            "source": "bx4",
            "tags": ["bx4", recommendation.get("wing", "general")],
        }
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{config.TEAM_HUB_URL}/api/tasks",
                json=payload,
            )
            r.raise_for_status()
            data = r.json()
            return {"id": data.get("id", data.get("task_id"))}
    except Exception as exc:
        log.warning("Failed to push task to Team Hub: %s", exc)
        return None


async def get_task_status(task_id: str) -> str | None:
    """GET task status from Team Hub. Returns status string or None on failure."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{config.TEAM_HUB_URL}/api/tasks/{task_id}")
            r.raise_for_status()
            data = r.json()
            return data.get("status")
    except Exception as exc:
        log.warning("Failed to get task status from Team Hub: %s", exc)
        return None
