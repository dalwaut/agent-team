"""OPAI Engine — Health & system endpoints.

Migrated from opai-monitor/routes_api.py health/system section.
"""

import subprocess

import httpx
from fastapi import APIRouter, Depends, HTTPException

import config
from services import collectors
from services.service_controller import (
    control_service, start_all_services, kill_agent, kill_all_agents,
)
from auth import require_admin

router = APIRouter(prefix="/api")


# ── Health Summary ────────────────────────────────────────

@router.get("/health/summary")
async def health_summary():
    """Aggregated health check across all OPAI services. No auth required."""
    results = {}
    overall = "healthy"

    async with httpx.AsyncClient(timeout=2.0) as client:
        for name, port in config.HEALTH_SERVICES.items():
            try:
                resp = await client.get(f"http://127.0.0.1:{port}/health")
                data = resp.json()
                results[name] = {
                    "status": "healthy",
                    "uptime_seconds": data.get("uptime_seconds"),
                    "memory_mb": data.get("memory_mb"),
                }
            except Exception:
                results[name] = {"status": "unreachable"}
                overall = "degraded"

    # systemd-only services
    for unit in config.SYSTEMD_ONLY:
        svc_name = unit if "." in unit else f"{unit}.service"
        try:
            result = subprocess.run(
                ["systemctl", "--user", "is-active", svc_name],
                capture_output=True, text=True, timeout=3,
            )
            active = result.stdout.strip() == "active"
            results[unit] = {"status": "healthy" if active else "inactive"}
            if not active:
                overall = "degraded"
        except Exception:
            results[unit] = {"status": "unknown"}

    return {"status": overall, "services": results}


# ── System ────────────────────────────────────────────────

@router.get("/system/stats")
def system_stats():
    """CPU, RAM, disk stats. No auth required."""
    return collectors.get_system_stats()


@router.get("/system/services")
def system_services():
    return collectors.get_service_statuses()


@router.post("/system/start-all", dependencies=[Depends(require_admin)])
def start_all():
    return start_all_services()


@router.post("/system/services/{name}/{action}", dependencies=[Depends(require_admin)])
def service_control(name: str, action: str):
    result = control_service(name, action)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


# ── Agents ────────────────────────────────────────────────

@router.get("/agents")
def list_agents():
    return collectors.get_running_agents()


@router.get("/agents/{pid}")
def get_agent_detail(pid: int):
    detail = collectors.get_agent_detail(pid)
    if not detail:
        raise HTTPException(404, "Agent not found or not a claude process")
    return detail


@router.post("/agents/{pid}/kill", dependencies=[Depends(require_admin)])
def kill_agent_endpoint(pid: int):
    result = kill_agent(pid)
    if not result["success"]:
        raise HTTPException(400, result["error"])
    return result


@router.post("/agents/kill-all", dependencies=[Depends(require_admin)])
def kill_all_agents_endpoint():
    return kill_all_agents()


# ── Auth Config ───────────────────────────────────────────

@router.get("/auth/config")
def auth_config():
    """Return Supabase config for frontend auth.js initialization."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── Backward-Compatibility Aliases ───────────────────────
# Portal and other tools fetch from /api/monitor/... paths.
# Engine uses /api/... directly. These aliases maintain compat.

@router.get("/monitor/health/summary")
async def monitor_health_summary():
    return await health_summary()

@router.get("/monitor/system/stats")
def monitor_system_stats():
    return system_stats()

@router.get("/monitor/system/services")
def monitor_system_services():
    return system_services()
