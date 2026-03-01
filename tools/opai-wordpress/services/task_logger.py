"""Task logger — writes Push OP (and other WordPress system events) to the
OPAI audit log so they appear in the Task Control Panel's Audit tab.

System events like Push OP are audit-only (no task creation) per the TCP
redesign. The task list is reserved for actionable items.

Uses the shared audit helper for cross-process safe, tiered audit records.
"""

import logging
import sys
from pathlib import Path

log = logging.getLogger("opai-wordpress.task-logger")

# ── Shared audit helper ──────────────────────────────────
_OPAI_ROOT = Path(__file__).parent.parent.parent.parent  # /workspace/synced/opai
sys.path.insert(0, str(_OPAI_ROOT / "tools" / "shared"))
from audit import log_audit


# ── Public API ────────────────────────────────────────────

def log_push_op(
    plugin_version: str,
    results: list[dict],
    started_at: str,
    completed_at: str,
    duration_ms: int,
) -> dict:
    """Write an audit record for a Push OP run.

    Returns {"audit_id": ...} or {"error": ...}.
    """
    pushed = [r for r in results if r.get("status") == "pushed"]
    manual = [r for r in results if r.get("status") == "manual_required"]
    errors = [r for r in results if r.get("status") == "error"]
    total = len(results)

    summary = (
        f"Push OP v{plugin_version} — {len(pushed)}/{total} pushed"
        + (f", {len(manual)} manual" if manual else "")
        + (f", {len(errors)} errors" if errors else "")
    )

    status = "completed"
    if errors:
        status = "failed"
    elif manual:
        status = "partial"

    try:
        audit_id = log_audit(
            tier="system",
            service="opai-wordpress",
            event="push-op",
            status=status,
            summary=summary,
            duration_ms=duration_ms,
            details={
                "pluginVersion": plugin_version,
                "sitesTotal": total,
                "sitesPushed": len(pushed),
                "sitesManual": len(manual),
                "sitesError": len(errors),
                "isError": bool(errors),
                "errorMessage": f"{len(errors)} site(s) errored" if errors else None,
                "pushResults": results,
            },
        )
        log.info(
            "Logged Push OP run: audit=%s (%d/%d pushed)",
            audit_id, len(pushed), total,
        )
        return {"audit_id": audit_id}
    except Exception as exc:
        log.error("Failed to log Push OP to audit: %s", exc)
        return {"error": str(exc)}
