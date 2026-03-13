"""OPAI Engine — Vercel Demo Platform routes.

Ephemeral demo deployments to Vercel for customer presentations.
Max 3 active, 48h auto-review. Shells out to scripts/vercel-demo.sh.
"""

import json
import logging
import subprocess
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

import config
from auth import require_admin

logger = logging.getLogger("opai.demos")
router = APIRouter(prefix="/api/demos", tags=["demos"])

DEMO_SCRIPT = config.SCRIPTS_DIR / "vercel-demo.sh"
STATE_FILE = config.VERCEL_DEMOS_FILE


def _load_state() -> dict:
    """Load the demos state file."""
    try:
        if STATE_FILE.is_file():
            return json.loads(STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to load demos state: %s", e)
    return {"demos": {}, "config": {"max_active_demos": 3, "default_max_age_hours": 48}}


def _run_script(args: list[str], timeout: int = 120) -> dict:
    """Run vercel-demo.sh with given args."""
    cmd = ["bash", str(DEMO_SCRIPT)] + args
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, cwd=str(config.OPAI_ROOT)
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Deploy timed out"}
    except Exception as e:
        return {"success": False, "error": str(e)}


class DeployRequest(BaseModel):
    directory: str
    slug: str
    notes: Optional[str] = ""


@router.post("/deploy", dependencies=[Depends(require_admin)])
async def deploy_demo(req: DeployRequest):
    """Deploy a directory to Vercel as an ephemeral demo."""
    result = _run_script(["deploy", req.directory, req.slug, req.notes or ""], timeout=120)
    if not result["success"]:
        error = result.get("stderr", "") or result.get("error", "Deploy failed")
        # Check if limit reached (exit code 2)
        if result.get("returncode") == 2:
            return {"success": False, "error": "Demo limit reached (max 3 active)", "code": "LIMIT_REACHED"}
        return {"success": False, "error": error.strip()}

    # Parse the JSON output line from the script
    stdout = result.get("stdout", "")
    for line in stdout.strip().split("\n"):
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pass

    # Fallback — reload state to get URL
    state = _load_state()
    demo = state.get("demos", {}).get(req.slug, {})
    return {
        "success": True,
        "slug": req.slug,
        "url": demo.get("url", ""),
        "project": demo.get("vercel_project", ""),
    }


@router.get("")
async def list_demos():
    """List all active demos."""
    state = _load_state()
    demos = []
    for slug, d in state.get("demos", {}).items():
        if d.get("status") != "active":
            continue
        age_hours = 0
        try:
            dt = datetime.fromisoformat(d["deployed_at"].replace("Z", "+00:00"))
            age_hours = int((datetime.now(timezone.utc) - dt).total_seconds() / 3600)
        except (KeyError, ValueError):
            pass
        demos.append({
            "slug": slug,
            "url": d.get("url", ""),
            "project": d.get("vercel_project", ""),
            "source_dir": d.get("source_dir", ""),
            "deployed_at": d.get("deployed_at", ""),
            "age_hours": age_hours,
            "max_age_hours": d.get("max_age_hours", 48),
            "notes": d.get("notes", ""),
        })
    return {"demos": demos, "count": len(demos)}


@router.post("/{slug}/teardown", dependencies=[Depends(require_admin)])
async def teardown_demo(slug: str):
    """Teardown a specific demo by slug."""
    state = _load_state()
    if slug not in state.get("demos", {}) or state["demos"][slug].get("status") != "active":
        return {"success": False, "error": f"No active demo found: {slug}"}

    result = _run_script(["teardown", slug])
    if not result["success"]:
        return {"success": False, "error": result.get("stderr", "Teardown failed").strip()}
    return {"success": True, "slug": slug, "message": f"Demo '{slug}' removed"}


@router.post("/sweep", dependencies=[Depends(require_admin)])
async def sweep_demos():
    """Sweep stale demos past max age."""
    result = _run_script(["sweep"])
    return {
        "success": result["success"],
        "output": result.get("stdout", "").strip(),
    }


@router.post("/teardown-all", dependencies=[Depends(require_admin)])
async def teardown_all_demos():
    """Remove all active demos."""
    result = _run_script(["teardown-all"])
    return {
        "success": result["success"],
        "output": result.get("stdout", "").strip(),
    }
