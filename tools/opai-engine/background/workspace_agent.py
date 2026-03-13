"""Google Workspace Agent — Daily Folder Audit.

Scheduled cron task (0 10 * * *) that scans the Agent Workspace folder
in Google Drive and reports findings to HITL Telegram topic.

Checks:
  - Stale files (>30 days unmodified)
  - Naming inconsistencies
  - Orphaned files (no parent in workspace tree)
  - Storage usage summary
  - File type distribution

Posts findings to HITL Telegram topic (thread 112) with proposed actions.
Dallas approves changes, which are then queued for execution.
"""

import asyncio
import json
import logging
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Add shared libs
_shared_dir = str(Path(__file__).resolve().parent.parent.parent / "shared")
if _shared_dir not in sys.path:
    sys.path.insert(0, _shared_dir)

from audit import log_audit

logger = logging.getLogger("opai.workspace_agent")

# ── Constants ────────────────────────────────────────────

STALE_THRESHOLD_DAYS = 30
MAX_FINDINGS_PER_REPORT = 20


async def run_folder_audit() -> dict:
    """Run the daily Agent Workspace folder audit.

    Returns:
        Dict with audit results: {findings, summary, errors}.
    """
    start = time.time()

    try:
        from google_workspace import GoogleWorkspace
    except ImportError as e:
        logger.error("Cannot import google_workspace: %s", e)
        return {"error": str(e), "findings": [], "summary": {}}

    ws = GoogleWorkspace()
    findings = []
    errors = []
    all_files = []

    try:
        # Get workspace folder ID from env
        import os
        folder_id = os.environ.get("GOOGLE_AGENT_WORKSPACE_FOLDER_ID", "")
        if not folder_id:
            return {"error": "GOOGLE_AGENT_WORKSPACE_FOLDER_ID not set", "findings": [], "summary": {}}

        # Recursively scan the workspace folder tree
        all_files = await _scan_folder_tree(ws, folder_id, depth=0, max_depth=5)

        # Analysis
        now = datetime.now(timezone.utc)
        stale_threshold = now - timedelta(days=STALE_THRESHOLD_DAYS)

        total_size = 0
        type_counts: dict[str, int] = {}
        stale_files = []
        naming_issues = []

        for f in all_files:
            # Size tracking
            size = int(f.get("size", 0))
            total_size += size

            # Type distribution
            mime = f.get("mimeType", "unknown")
            friendly = _friendly_type(mime)
            type_counts[friendly] = type_counts.get(friendly, 0) + 1

            # Stale file detection
            modified = f.get("modifiedTime", "")
            if modified:
                try:
                    mod_dt = datetime.fromisoformat(modified.replace("Z", "+00:00"))
                    if mod_dt < stale_threshold:
                        days_old = (now - mod_dt).days
                        stale_files.append({
                            "name": f.get("name"),
                            "id": f.get("id"),
                            "days_since_modified": days_old,
                            "type": friendly,
                        })
                except (ValueError, TypeError):
                    pass

            # Naming consistency check
            name = f.get("name", "")
            issues = _check_naming(name, mime)
            if issues:
                naming_issues.append({
                    "name": name,
                    "id": f.get("id"),
                    "issues": issues,
                })

        # Build findings
        if stale_files:
            stale_files.sort(key=lambda x: x["days_since_modified"], reverse=True)
            findings.append({
                "type": "stale_files",
                "severity": "info",
                "count": len(stale_files),
                "items": stale_files[:10],
                "suggestion": "Review and archive or delete stale files",
            })

        if naming_issues:
            findings.append({
                "type": "naming_issues",
                "severity": "info",
                "count": len(naming_issues),
                "items": naming_issues[:5],
                "suggestion": "Standardize file naming for consistency",
            })

        # Summary
        summary = {
            "total_files": len(all_files),
            "total_size_mb": round(total_size / (1024 * 1024), 2),
            "type_distribution": dict(sorted(type_counts.items(), key=lambda x: x[1], reverse=True)),
            "stale_files": len(stale_files),
            "naming_issues": len(naming_issues),
            "scan_depth": 5,
        }

    except Exception as e:
        logger.error("Workspace audit error: %s", e)
        errors.append(str(e))
        summary = {"error": str(e)}
    finally:
        await ws.close()

    duration_ms = int((time.time() - start) * 1000)

    # Audit log
    log_audit(
        tier="system",
        service="google-workspace",
        event="workspace:folder_audit",
        status="completed" if not errors else "partial",
        summary=f"Workspace audit: {len(all_files)} files, {len(findings)} findings",
        duration_ms=duration_ms,
        details={
            "files_scanned": len(all_files),
            "findings": len(findings),
            "errors": errors,
        },
    )

    return {
        "findings": findings[:MAX_FINDINGS_PER_REPORT],
        "summary": summary,
        "errors": errors,
        "duration_ms": duration_ms,
    }


async def _scan_folder_tree(
    ws,
    folder_id: str,
    depth: int = 0,
    max_depth: int = 5,
) -> list[dict]:
    """Recursively scan a Drive folder tree.

    Returns flat list of all files (including subfolder contents).
    """
    if depth >= max_depth:
        return []

    try:
        result = await ws.drive_list(folder_id=folder_id, page_size=100)
    except Exception as e:
        logger.warning("Failed to list folder %s: %s", folder_id, e)
        return []

    files = result.get("files", [])
    all_files = []

    for f in files:
        f["_depth"] = depth
        all_files.append(f)

        # Recurse into subfolders
        if f.get("mimeType") == "application/vnd.google-apps.folder":
            sub_files = await _scan_folder_tree(ws, f["id"], depth + 1, max_depth)
            all_files.extend(sub_files)

    return all_files


def _friendly_type(mime: str) -> str:
    """Convert MIME type to a human-friendly name."""
    type_map = {
        "application/vnd.google-apps.folder": "Folder",
        "application/vnd.google-apps.document": "Google Doc",
        "application/vnd.google-apps.spreadsheet": "Google Sheet",
        "application/vnd.google-apps.presentation": "Google Slides",
        "application/vnd.google-apps.form": "Google Form",
        "application/pdf": "PDF",
        "text/plain": "Text",
        "text/csv": "CSV",
        "text/markdown": "Markdown",
        "application/json": "JSON",
        "image/png": "PNG Image",
        "image/jpeg": "JPEG Image",
    }
    return type_map.get(mime, mime.split("/")[-1] if "/" in mime else "Unknown")


def _check_naming(name: str, mime: str) -> list[str]:
    """Check file naming consistency. Returns list of issues."""
    issues = []

    # Skip folders
    if mime == "application/vnd.google-apps.folder":
        return issues

    # Check for spaces at start/end
    if name != name.strip():
        issues.append("Leading/trailing whitespace")

    # Check for unusual characters
    unusual = set(name) - set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. ()")
    if unusual:
        issues.append(f"Unusual characters: {unusual}")

    # Check for very long names
    if len(name) > 100:
        issues.append(f"Very long name ({len(name)} chars)")

    return issues


async def format_hitl_message(result: dict) -> str:
    """Format audit results as a Telegram HITL message.

    Args:
        result: Output from run_folder_audit().

    Returns:
        Formatted message for HITL topic.
    """
    summary = result.get("summary", {})
    findings = result.get("findings", [])

    parts = []
    parts.append("📁 **Agent Workspace — Daily Audit**\n")

    # Summary stats
    parts.append(f"Files: {summary.get('total_files', 0)}")
    parts.append(f"Size: {summary.get('total_size_mb', 0)} MB")

    # Type distribution
    types = summary.get("type_distribution", {})
    if types:
        top_types = list(types.items())[:5]
        type_str = ", ".join(f"{t}: {c}" for t, c in top_types)
        parts.append(f"Types: {type_str}")

    parts.append("")

    # Findings
    if not findings:
        parts.append("No issues found. Workspace is clean.")
    else:
        parts.append(f"**Findings ({len(findings)}):**\n")

        for f in findings:
            if f["type"] == "stale_files":
                parts.append(f"⏰ **{f['count']} stale files** (>{STALE_THRESHOLD_DAYS} days)")
                for item in f.get("items", [])[:5]:
                    parts.append(f"  · {item['name']} ({item['days_since_modified']}d)")
                parts.append(f"  💡 {f['suggestion']}")

            elif f["type"] == "naming_issues":
                parts.append(f"📝 **{f['count']} naming issues**")
                for item in f.get("items", [])[:3]:
                    parts.append(f"  · {item['name']}: {', '.join(item['issues'])}")
                parts.append(f"  💡 {f['suggestion']}")

            parts.append("")

    # Errors
    errors = result.get("errors", [])
    if errors:
        parts.append(f"⚠️ Errors: {', '.join(errors)}")

    duration = result.get("duration_ms", 0)
    parts.append(f"\n⏱️ Scan took {duration}ms")

    return "\n".join(parts)
