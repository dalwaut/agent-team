"""OPAI Engine — Workspace Manager (v3.5).

Manages isolated per-worker workspaces on local NVMe for fleet dispatches.

Base path: /workspace/local/agent-workspaces/

Directory structure per run:
  {worker-id}/
    current/           <- symlink to latest run dir
    runs/
      {run-id}/        <- isolated workspace for one execution
        output/        <- worker writes results here
        context/       <- injected task context files
    shared/            <- persistent across runs (knowledge, memory)
"""

import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path

import config

logger = logging.getLogger("opai-engine.workspace-manager")


def prepare_workspace(
    worker_id: str, run_id: str, task_context: dict | None = None
) -> Path:
    """Create an isolated workspace for a fleet dispatch run.

    Creates the run directory structure, symlinks shared resources,
    and writes task context files. Returns the workspace path.
    """
    base = config.AGENT_WORKSPACE_BASE / worker_id
    run_dir = base / "runs" / run_id
    output_dir = run_dir / "output"
    context_dir = run_dir / "context"
    shared_dir = base / "shared"

    # Create directories
    output_dir.mkdir(parents=True, exist_ok=True)
    context_dir.mkdir(parents=True, exist_ok=True)
    shared_dir.mkdir(parents=True, exist_ok=True)

    # Update 'current' symlink to point to this run
    current_link = base / "current"
    if current_link.is_symlink() or current_link.exists():
        current_link.unlink()
    current_link.symlink_to(run_dir)

    # Symlink shared resources into workspace
    _symlink_shared(run_dir, shared_dir)

    # Write task context
    if task_context:
        context_file = context_dir / "task.json"
        context_file.write_text(json.dumps(task_context, indent=2, default=str))

        # Also write a human-readable summary
        summary_file = context_dir / "task-summary.txt"
        lines = [f"{k}: {v}" for k, v in task_context.items()]
        summary_file.write_text("\n".join(lines))

    logger.info("Prepared workspace for %s run %s at %s", worker_id, run_id, run_dir)
    return run_dir


def _symlink_shared(run_dir: Path, shared_dir: Path):
    """Symlink shared resources into the run workspace."""
    # CLAUDE.md for agent context
    claude_md = config.OPAI_ROOT / "CLAUDE.md"
    if claude_md.is_file():
        target = run_dir / "CLAUDE.md"
        if not target.exists():
            target.symlink_to(claude_md)

    # Wiki for reference (symlink the directory)
    wiki_dir = config.OPAI_ROOT / "Library" / "opai-wiki"
    if wiki_dir.is_dir():
        target = shared_dir / "opai-wiki"
        if not target.exists():
            target.symlink_to(wiki_dir)

    # team.json for agent definitions
    team_json = config.TEAM_JSON
    if team_json.is_file():
        target = run_dir / "team.json"
        if not target.exists():
            target.symlink_to(team_json)


def collect_output(worker_id: str, run_id: str) -> dict:
    """Read output from a completed run and copy report to reports dir.

    Returns a summary dict with output file paths and content preview.
    """
    base = config.AGENT_WORKSPACE_BASE / worker_id
    run_dir = base / "runs" / run_id
    output_dir = run_dir / "output"

    if not output_dir.is_dir():
        return {"files": [], "summary": "No output directory"}

    files = list(output_dir.iterdir())
    if not files:
        return {"files": [], "summary": "Output directory empty"}

    # Copy outputs to reports
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    report_dir = config.REPORTS_DIR / today / "fleet" / f"{worker_id}-{run_id}"
    report_dir.mkdir(parents=True, exist_ok=True)

    collected = []
    for f in files:
        if f.is_file():
            dest = report_dir / f.name
            shutil.copy2(f, dest)
            collected.append(str(dest))

    # Read first output file for summary preview
    preview = ""
    if files and files[0].is_file():
        text = files[0].read_text(errors="replace")
        preview = text[:500] + ("..." if len(text) > 500 else "")

    logger.info(
        "Collected %d output files from %s run %s → %s",
        len(collected), worker_id, run_id, report_dir,
    )
    return {
        "files": collected,
        "report_dir": str(report_dir),
        "summary": preview,
    }


def cleanup_workspace(worker_id: str, run_id: str, keep_output: bool = True):
    """Remove a run directory. Optionally preserves output/ first."""
    base = config.AGENT_WORKSPACE_BASE / worker_id
    run_dir = base / "runs" / run_id

    if not run_dir.is_dir():
        return

    if keep_output:
        # Collect output before cleanup
        collect_output(worker_id, run_id)

    shutil.rmtree(run_dir, ignore_errors=True)
    logger.info("Cleaned up workspace %s run %s", worker_id, run_id)


def get_workspace_stats() -> dict:
    """Return disk usage, run count, and active workspaces."""
    base = config.AGENT_WORKSPACE_BASE

    if not base.is_dir():
        return {
            "base_path": str(base),
            "exists": False,
            "total_workers": 0,
            "active_workspaces": 0,
            "total_runs": 0,
            "disk_usage_mb": 0,
        }

    workers = [d for d in base.iterdir() if d.is_dir()]
    total_runs = 0
    active = 0

    for w in workers:
        runs_dir = w / "runs"
        if runs_dir.is_dir():
            runs = [r for r in runs_dir.iterdir() if r.is_dir()]
            total_runs += len(runs)
            if runs:
                active += 1

    # Disk usage (du-style, approximate)
    disk_mb = 0
    try:
        total_bytes = sum(
            f.stat().st_size
            for f in base.rglob("*")
            if f.is_file() and not f.is_symlink()
        )
        disk_mb = round(total_bytes / (1024 * 1024), 1)
    except OSError:
        pass

    return {
        "base_path": str(base),
        "exists": True,
        "total_workers": len(workers),
        "active_workspaces": active,
        "total_runs": total_runs,
        "disk_usage_mb": disk_mb,
    }


def get_worker_history(worker_id: str) -> list[dict]:
    """List past runs for a worker with timestamps and outcomes."""
    base = config.AGENT_WORKSPACE_BASE / worker_id / "runs"
    if not base.is_dir():
        return []

    history = []
    for run_dir in sorted(base.iterdir(), reverse=True):
        if not run_dir.is_dir():
            continue
        # Check for output
        output_dir = run_dir / "output"
        has_output = output_dir.is_dir() and any(output_dir.iterdir())

        # Check for task context
        context_file = run_dir / "context" / "task.json"
        task_info = {}
        if context_file.is_file():
            try:
                task_info = json.loads(context_file.read_text())
            except (json.JSONDecodeError, OSError):
                pass

        history.append({
            "run_id": run_dir.name,
            "created_at": datetime.fromtimestamp(
                run_dir.stat().st_ctime, tz=timezone.utc
            ).isoformat(),
            "has_output": has_output,
            "task_title": task_info.get("title", ""),
            "task_id": task_info.get("id", ""),
        })

    return history[:50]  # Last 50 runs
