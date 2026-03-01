#!/usr/bin/env python3
"""
Post-Squad Hook — runs after every squad completes via run_squad.sh.

Actions:
  1. Parse all report markdown files in REPORT_DIR
  2. Extract P0/P1/P2 action items from each report
  3. Create tasks in tasks/registry.json for review/execution
  4. Send an email digest to Dallas@paradisewebfl.com

Usage (called automatically by run_squad.sh):
  python3 scripts/post_squad_hook.py --squad <name> --report-dir <path> --date <YYYY-MM-DD>

Flags:
  --no-email   Skip the email step (useful when running manually / dev)
  --no-tasks   Skip the task creation step
"""

import argparse
import json
import os
import re
import shutil
import smtplib
import subprocess
import sys
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent.resolve()
OPAI_ROOT  = SCRIPT_DIR.parent
REGISTRY_PATH = OPAI_ROOT / "tasks" / "registry.json"
AUDIT_PATH    = OPAI_ROOT / "tasks" / "audit.json"
EMAIL_ENV_PATH = OPAI_ROOT / "tools" / "opai-email-agent" / ".env"

TO_ADDRESS   = "Dallas@paradisewebfl.com"
FROM_ADDRESS = "Agent@paradisewebfl.com"

# Squads that should always trigger email + tasks (scheduled security runs)
ALWAYS_NOTIFY_SQUADS = {"dep_scan", "secrets_scan", "security_quick", "secure", "workspace", "audit", "evolve"}

# Squads that should send Telegram notification on completion
TELEGRAM_NOTIFY_SQUADS = {"rd", "incident", "secure", "evolve"}

# Squads whose primary report should be filed to notes/Improvements/
IMPROVEMENTS_SQUADS = {"rd"}

# ── Env loader (dotenv-lite) ───────────────────────────────────────────────────

def load_dotenv(path: Path) -> dict:
    """Load key=value pairs from a .env file."""
    env = {}
    if not path.is_file():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip().strip('"').strip("'")
    return env

# ── Report parser ──────────────────────────────────────────────────────────────

ACTION_PATTERN = re.compile(
    r"^[-*]\s*(P0|P1|P2)[:\s]+(.+)$", re.MULTILINE | re.IGNORECASE
)
FINDING_COUNT_PATTERN = re.compile(
    r"(?:Critical|High)\s*[:\|]\s*(\d+)", re.IGNORECASE
)


def parse_report(report_path: Path) -> dict:
    """Extract agent name, finding counts, and P0/P1/P2 items from a report."""
    text = report_path.read_text(errors="replace")
    agent = report_path.stem  # filename without .md

    # Count Critical/High findings
    critical_high = sum(int(m.group(1)) for m in FINDING_COUNT_PATTERN.finditer(text))

    # Extract P0/P1/P2 action items
    action_items = []
    for match in ACTION_PATTERN.finditer(text):
        priority = match.group(1).upper()
        description = match.group(2).strip()
        if description and len(description) > 5:
            action_items.append({"priority": priority, "description": description})

    # Determine overall severity for task priority mapping
    task_priority = "normal"
    if any(a["priority"] == "P0" for a in action_items) or critical_high >= 3:
        task_priority = "high"
    if critical_high >= 8:
        task_priority = "critical"

    return {
        "agent": agent,
        "path": str(report_path),
        "critical_high": critical_high,
        "action_items": action_items,
        "task_priority": task_priority,
        "word_count": len(text.split()),
    }


def parse_reports(report_dir: Path) -> list[dict]:
    """Parse all .md report files in a directory."""
    reports = []
    for md_file in sorted(report_dir.glob("*.md")):
        if md_file.name.startswith("."):
            continue
        try:
            reports.append(parse_report(md_file))
        except Exception as e:
            print(f"[hook] Warning: could not parse {md_file.name}: {e}", file=sys.stderr)
    return reports


# ── Task creation ──────────────────────────────────────────────────────────────

def read_registry() -> dict:
    try:
        if REGISTRY_PATH.is_file():
            return json.loads(REGISTRY_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {"tasks": {}}


def write_registry(registry: dict):
    registry["lastUpdated"] = datetime.now().isoformat() + "Z"
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(registry, indent=2))


def generate_task_id(registry: dict) -> str:
    date_str = datetime.now().strftime("%Y%m%d")
    existing = [k for k in registry["tasks"] if k.startswith(f"t-{date_str}-")]
    n = len(existing) + 1
    while f"t-{date_str}-{n:03d}" in registry["tasks"]:
        n += 1
    return f"t-{date_str}-{n:03d}"


def task_already_exists(registry: dict, title: str) -> bool:
    """Avoid creating duplicate tasks for the same report on the same day."""
    today = datetime.now().strftime("%Y-%m-%d")
    for task in registry.get("tasks", {}).values():
        if (task.get("title", "") == title
                and task.get("status") not in ("completed", "cancelled")
                and (task.get("createdAt") or "").startswith(today)):
            return True
    return False


def create_run_tracking_task(squad: str, date_str: str, reports: list[dict],
                              report_dir: str, success: bool):
    """Create a single 'run completed' task in the registry for tracking purposes.

    This always creates a task for evolve and evolution runs so the TCP Tasks tab
    reflects every self-assessment and evolution planner execution.
    """
    registry = read_registry()
    now = datetime.now(timezone.utc).isoformat()

    SQUAD_TITLES = {
        "evolve":    "Self-Assessment completed",
        "evolution": "Evolution Plan generated",
    }
    title = f"[{SQUAD_TITLES.get(squad, squad.upper())}] — {date_str}"
    if task_already_exists(registry, title):
        return

    # Summarise findings across all reports
    total_critical = sum(r["critical_high"] for r in reports)
    total_actions  = sum(len(r["action_items"]) for r in reports)
    agent_names    = [r["agent"] for r in reports]

    report_links = "\n".join(
        f"- [{r['agent']}.md]({r['path']})" for r in reports if r["path"]
    )

    desc = (
        f"**Squad:** {squad}\n"
        f"**Run date:** {date_str}\n"
        f"**Status:** {'✅ Success' if success else '❌ Failed'}\n"
        f"**Agents run:** {', '.join(agent_names)}\n"
        f"**Critical/High findings:** {total_critical}\n"
        f"**Action items:** {total_actions}\n\n"
        f"### Reports\n{report_links or '_No reports_'}"
    )

    priority = "normal"
    if total_critical >= 3:
        priority = "high"
    if total_critical >= 8:
        priority = "critical"

    task_id = generate_task_id(registry)
    task = {
        "id": task_id,
        "title": title,
        "description": desc,
        "source": "self-assessment" if squad == "evolve" else "evolution-plan",
        "sourceRef": {"squad": squad, "reportDir": report_dir},
        "project": None,
        "client": None,
        "assignee": "human",
        "status": "pending",
        "priority": priority,
        "deadline": None,
        "routing": {"type": "run-report", "squads": [], "mode": "log"},
        "queueId": None,
        "createdAt": now,
        "updatedAt": None,
        "completedAt": None,
        "agentConfig": None,
        "attachments": [
            {"name": r["agent"] + ".md", "path": r["path"], "addedAt": now}
            for r in reports if r.get("path")
        ],
    }
    registry["tasks"][task_id] = task
    write_registry(registry)
    print(f"[hook] Run-tracking task created: {task_id} — {title}", file=sys.stderr)


def create_tasks_from_reports(squad: str, date_str: str, reports: list[dict]):
    """Create review tasks in the task registry for each agent report with findings."""
    registry = read_registry()
    now = datetime.now().isoformat() + "Z"
    created = 0

    for report in reports:
        agent = report["agent"]
        action_items = report["action_items"]
        if not action_items and report["critical_high"] == 0:
            continue  # No findings, no task needed

        # Build task title
        title = f"[{squad.upper()}] Review {agent} report — {date_str}"

        if task_already_exists(registry, title):
            print(f"[hook] Task already exists for {agent}, skipping", file=sys.stderr)
            continue

        # Build description
        p0_items = [a for a in action_items if a["priority"] == "P0"]
        p1_items = [a for a in action_items if a["priority"] == "P1"]
        p2_items = [a for a in action_items if a["priority"] == "P2"]

        desc_lines = [
            f"**Agent**: {agent}",
            f"**Squad**: {squad}",
            f"**Report**: {report['path']}",
            f"**Critical/High findings**: {report['critical_high']}",
            "",
        ]
        if p0_items:
            desc_lines.append("### P0 — Do Now")
            desc_lines.extend(f"- {a['description']}" for a in p0_items[:5])
        if p1_items:
            desc_lines.append("\n### P1 — This Sprint")
            desc_lines.extend(f"- {a['description']}" for a in p1_items[:5])
        if p2_items:
            desc_lines.append("\n### P2 — Backlog")
            desc_lines.extend(f"- {a['description']}" for a in p2_items[:3])

        task_id = generate_task_id(registry)
        task = {
            "id": task_id,
            "title": title,
            "description": "\n".join(desc_lines),
            "source": "agent-report",
            "sourceRef": {"squad": squad, "agent": agent, "reportPath": report["path"]},
            "project": None,
            "client": None,
            "assignee": "human",
            "status": "pending",
            "priority": report["task_priority"],
            "deadline": None,
            "routing": {
                "type": "agent-report",
                "squads": ["security", "review"],
                "mode": "propose",
            },
            "queueId": None,
            "createdAt": now,
            "updatedAt": None,
            "completedAt": None,
            "agentConfig": None,
            "attachments": [{"name": f"{agent}.md", "path": report["path"], "addedAt": now}],
        }

        registry["tasks"][task_id] = task
        created += 1
        print(f"[hook] Created task {task_id}: {title}", file=sys.stderr)

    if created > 0:
        write_registry(registry)
        print(f"[hook] {created} task(s) created in registry", file=sys.stderr)
    else:
        print("[hook] No new tasks needed (no findings or all already tracked)", file=sys.stderr)


# ── Email ──────────────────────────────────────────────────────────────────────

def build_email_html(squad: str, date_str: str, reports: list[dict]) -> str:
    total_findings = sum(r["critical_high"] for r in reports)
    total_actions  = sum(len(r["action_items"]) for r in reports)

    sections = []
    for r in reports:
        if not r["action_items"] and r["critical_high"] == 0:
            color = "#27ae60"
            status = "Clean"
        elif any(a["priority"] == "P0" for a in r["action_items"]):
            color = "#c0392b"
            status = "Action Required"
        elif r["critical_high"] > 0:
            color = "#e67e22"
            status = "Review Recommended"
        else:
            color = "#2980b9"
            status = "Advisory"

        items_html = ""
        for a in r["action_items"][:8]:
            badge_color = {"P0": "#c0392b", "P1": "#e67e22", "P2": "#7f8c8d"}.get(a["priority"], "#7f8c8d")
            items_html += (
                f'<li style="margin:4px 0">'
                f'<span style="background:{badge_color};color:#fff;border-radius:3px;'
                f'padding:1px 6px;font-size:11px;font-weight:bold">{a["priority"]}</span> '
                f'{a["description"]}</li>'
            )

        sections.append(f"""
        <div style="border-left:4px solid {color};padding:12px 16px;margin:12px 0;background:#f9f9f9;border-radius:0 6px 6px 0">
          <div style="font-weight:bold;font-size:15px;color:#2c3e50">{r['agent']}
            <span style="float:right;font-size:12px;background:{color};color:#fff;border-radius:3px;padding:2px 8px">{status}</span>
          </div>
          <div style="font-size:12px;color:#7f8c8d;margin:4px 0">
            Critical/High findings: <strong>{r['critical_high']}</strong> &nbsp;|&nbsp;
            Action items: <strong>{len(r['action_items'])}</strong>
          </div>
          {"<ul style='margin:8px 0;padding-left:18px'>" + items_html + "</ul>" if items_html else ""}
        </div>
        """)

    return f"""
    <html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#2c3e50">
      <div style="background:#2c3e50;padding:20px 24px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px">OPAI Agent Report — {squad.upper()}</h1>
        <div style="color:#bdc3c7;font-size:13px;margin-top:6px">{date_str}</div>
      </div>
      <div style="padding:20px 24px;border:1px solid #ecf0f1;border-top:none;border-radius:0 0 8px 8px">
        <div style="display:flex;gap:16px;margin-bottom:16px">
          <div style="flex:1;text-align:center;background:#ecf0f1;border-radius:6px;padding:12px">
            <div style="font-size:24px;font-weight:bold;color:#e74c3c">{total_findings}</div>
            <div style="font-size:12px;color:#7f8c8d">Critical/High Findings</div>
          </div>
          <div style="flex:1;text-align:center;background:#ecf0f1;border-radius:6px;padding:12px">
            <div style="font-size:24px;font-weight:bold;color:#e67e22">{total_actions}</div>
            <div style="font-size:12px;color:#7f8c8d">Action Items</div>
          </div>
          <div style="flex:1;text-align:center;background:#ecf0f1;border-radius:6px;padding:12px">
            <div style="font-size:24px;font-weight:bold;color:#3498db">{len(reports)}</div>
            <div style="font-size:12px;color:#7f8c8d">Agents Run</div>
          </div>
        </div>
        {"".join(sections)}
        <div style="margin-top:20px;padding:12px;background:#f0f8ff;border-radius:6px;font-size:12px;color:#5d6d7e">
          <strong>Review tasks have been created in the OPAI Task Control Panel.</strong><br>
          Visit the Tasks panel to approve, delegate, or dismiss each finding.
        </div>
        <div style="margin-top:12px;font-size:11px;color:#bdc3c7;text-align:center">
          Sent automatically by OPAI Agent System &bull; {date_str}
        </div>
      </div>
    </body></html>
    """


def send_report_email(squad: str, date_str: str, reports: list[dict]):
    """Send HTML email digest via SMTP using email agent credentials."""
    env = load_dotenv(EMAIL_ENV_PATH)

    smtp_host = env.get("AGENT_SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(env.get("AGENT_SMTP_PORT", "465"))
    smtp_user = env.get("AGENT_SMTP_USER", "")
    smtp_pass = env.get("AGENT_SMTP_PASS", "")

    if not smtp_user or not smtp_pass:
        print("[hook] SMTP credentials not configured — skipping email", file=sys.stderr)
        return

    total_findings = sum(r["critical_high"] for r in reports)
    severity_tag = "ACTION REQUIRED" if total_findings >= 5 else ("Review Needed" if total_findings > 0 else "Clean")
    subject = f"[OPAI {squad.upper()}] {severity_tag} — {date_str} ({total_findings} critical/high)"

    html_body = build_email_html(squad, date_str, reports)

    # Plain text fallback
    plain_lines = [f"OPAI Agent Report — {squad.upper()} — {date_str}", ""]
    for r in reports:
        plain_lines.append(f"## {r['agent']} ({r['critical_high']} critical/high, {len(r['action_items'])} actions)")
        for a in r["action_items"][:5]:
            plain_lines.append(f"  [{a['priority']}] {a['description']}")
        plain_lines.append("")
    plain_body = "\n".join(plain_lines)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = FROM_ADDRESS
    msg["To"] = TO_ADDRESS
    msg.attach(MIMEText(plain_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    try:
        if smtp_port == 465:
            with smtplib.SMTP_SSL(smtp_host, smtp_port) as server:
                server.login(smtp_user, smtp_pass)
                server.sendmail(FROM_ADDRESS, [TO_ADDRESS], msg.as_string())
        else:
            with smtplib.SMTP(smtp_host, smtp_port) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.sendmail(FROM_ADDRESS, [TO_ADDRESS], msg.as_string())
        print(f"[hook] Email sent to {TO_ADDRESS} (subject: {subject})", file=sys.stderr)
    except Exception as e:
        print(f"[hook] Email send failed: {e}", file=sys.stderr)


# ── Telegram notification ─────────────────────────────────────────────────────

TG_NOTIFY_SCRIPT = SCRIPT_DIR / "tg-notify.sh"


def send_telegram_notification(squad: str, date_str: str, reports: list[dict],
                                duration_sec: int, brief_path: str = None):
    """Send a Telegram message summarising the squad run."""
    if not TG_NOTIFY_SCRIPT.is_file():
        print("[hook] tg-notify.sh not found — skipping Telegram", file=sys.stderr)
        return

    total_findings = sum(r["critical_high"] for r in reports)
    total_actions = sum(len(r["action_items"]) for r in reports)
    agent_names = [r["agent"] for r in reports]
    duration_str = f"{duration_sec // 60}m {duration_sec % 60}s" if duration_sec else "n/a"

    # Build message
    lines = [
        f"<b>Squad Complete: {squad.upper()}</b>",
        f"{'━' * 20}",
        "",
        f"Agents: {', '.join(agent_names)}",
        f"Findings: {total_findings} critical/high",
        f"Actions: {total_actions}",
        f"Duration: {duration_str}",
    ]

    # For R&D squads, include the brief path
    if brief_path:
        lines.append("")
        lines.append(f"Brief: <code>{brief_path}</code>")

    # Add verdict if R&D brief
    if squad == "rd" and reports:
        # Try to extract verdict from report
        for r in reports:
            if r["agent"] == "rd_analyst":
                try:
                    text = Path(r["path"]).read_text(errors="replace")
                    verdict_match = re.search(r"\*\*Verdict:\*\*\s*(\w+)", text)
                    title_match = re.search(r"^#\s*R&D Brief:\s*(.+)$", text, re.MULTILINE)
                    if title_match:
                        lines.insert(2, f"Topic: {title_match.group(1).strip()}")
                    if verdict_match:
                        lines.append(f"Verdict: <b>{verdict_match.group(1)}</b>")
                except Exception:
                    pass

    message = "\n".join(lines)

    try:
        result = subprocess.run(
            [str(TG_NOTIFY_SCRIPT), "--html", message],
            capture_output=True, text=True, timeout=20,
        )
        if result.returncode == 0:
            print(f"[hook] Telegram notification sent for {squad}", file=sys.stderr)
        else:
            print(f"[hook] Telegram send failed: {result.stderr.strip()}", file=sys.stderr)
    except Exception as e:
        print(f"[hook] Telegram error (non-fatal): {e}", file=sys.stderr)


# ── R&D brief filing ─────────────────────────────────────────────────────────

IMPROVEMENTS_DIR = OPAI_ROOT / "notes" / "Improvements"


def file_rd_brief(reports: list[dict], date_str: str) -> str:
    """Copy the rd_analyst report to notes/Improvements/ with a descriptive name.

    Returns the filed path, or empty string if not applicable.
    """
    for r in reports:
        if r["agent"] != "rd_analyst":
            continue

        report_path = Path(r["path"])
        if not report_path.is_file():
            continue

        text = report_path.read_text(errors="replace")

        # Extract title from "# R&D Brief: <title>" heading
        title_match = re.search(r"^#\s*R&D Brief:\s*(.+)$", text, re.MULTILINE)
        if title_match:
            raw_title = title_match.group(1).strip()
            # Convert to kebab-case slug
            slug = re.sub(r"[^a-z0-9]+", "-", raw_title.lower()).strip("-")[:60]
        else:
            slug = f"rd-brief-{date_str}"

        IMPROVEMENTS_DIR.mkdir(parents=True, exist_ok=True)
        dest = IMPROVEMENTS_DIR / f"{slug}.md"

        # Don't overwrite if it already exists
        if dest.exists():
            dest = IMPROVEMENTS_DIR / f"{slug}-{date_str}.md"

        shutil.copy2(str(report_path), str(dest))
        print(f"[hook] R&D brief filed to {dest}", file=sys.stderr)
        return str(dest.relative_to(OPAI_ROOT))

    return ""


# ── Audit log (using shared audit helper) ─────────────────────────────────────

sys.path.insert(0, str(OPAI_ROOT / "tools" / "shared"))
from audit import log_audit


SQUAD_NAMES = {
    "evolve": "Self-Assessment (evolve squad)",
    "audit": "System Audit",
    "workspace": "Workspace Audit",
    "dep_scan": "Dependency Scanner",
    "secrets_scan": "Secrets Detector",
    "security_quick": "Security Quick Scan",
    "secure": "Full Security Audit",
    "incident": "Incident Responder",
    "a11y": "Accessibility Audit",
    "knowledge": "Knowledge Sync",
}


def write_squad_audit_entry(squad: str, date_str: str, reports: list[dict],
                             duration_sec: int, report_dir: str, success: bool):
    """Write a tiered audit record for a squad run using the shared audit helper."""
    summary_file = str(Path(report_dir) / "_run_summary.md")
    agent_name = SQUAD_NAMES.get(squad, f"{squad} squad")
    total_findings = sum(r["critical_high"] for r in reports)
    total_actions = sum(len(r["action_items"]) for r in reports)

    summary = f"{agent_name} — {len(reports)} agents, {total_findings} findings, {total_actions} actions"

    try:
        audit_id = log_audit(
            tier="execution",
            service="opai-orchestrator",
            event=f"squad-{squad}",
            status="completed" if success else "failed",
            summary=summary,
            duration_ms=duration_sec * 1000,
            details={
                "squadName": squad,
                "agentName": agent_name,
                "agentsRun": [r["agent"] for r in reports],
                "totalFindings": total_findings,
                "totalActions": total_actions,
                "reportDir": report_dir,
                "reportFile": summary_file if Path(summary_file).exists() else None,
            },
        )
        print(f"[hook] Audit entry written: {audit_id}", file=sys.stderr)
    except Exception as e:
        print(f"[hook] Audit write error (non-fatal): {e}", file=sys.stderr)


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Post-squad hook: create tasks + send email")
    parser.add_argument("--squad",      required=True, help="Squad name that just ran")
    parser.add_argument("--report-dir", required=True, help="Path to report directory")
    parser.add_argument("--date",       default=datetime.now().strftime("%Y-%m-%d"))
    parser.add_argument("--duration",   type=int, default=0, help="Run duration in seconds")
    parser.add_argument("--no-email",   action="store_true", help="Skip email")
    parser.add_argument("--no-tasks",   action="store_true", help="Skip task creation")
    parser.add_argument("--no-audit",   action="store_true", help="Skip audit entry")
    args = parser.parse_args()

    report_dir = Path(args.report_dir)
    if not report_dir.is_dir():
        print(f"[hook] Report dir not found: {report_dir}", file=sys.stderr)
        sys.exit(0)  # Non-fatal

    reports = parse_reports(report_dir)
    if not reports:
        print("[hook] No reports found, nothing to do", file=sys.stderr)
        sys.exit(0)

    print(f"[hook] Processing {len(reports)} report(s) for squad '{args.squad}'", file=sys.stderr)

    # Always write an audit entry for every squad run (no findings filter)
    if not args.no_audit:
        try:
            write_squad_audit_entry(
                squad=args.squad,
                date_str=args.date,
                reports=reports,
                duration_sec=args.duration,
                report_dir=str(report_dir),
                success=True,
            )
        except Exception as e:
            print(f"[hook] Audit entry error (non-fatal): {e}", file=sys.stderr)

    # Evolve/evolution runs are now audit-only — no run-tracking tasks needed.
    # Findings from these runs are surfaced via the evolve reports UI.

    # Always create finding tasks for squads in ALWAYS_NOTIFY_SQUADS; for others, only if findings exist
    should_notify = (
        args.squad in ALWAYS_NOTIFY_SQUADS
        or any(r["critical_high"] > 0 or r["action_items"] for r in reports)
    )

    if not should_notify:
        print("[hook] No findings and not a monitored squad — skipping tasks and email", file=sys.stderr)
        print("[hook] Post-squad hook complete", file=sys.stderr)
        sys.exit(0)

    if not args.no_tasks:
        try:
            create_tasks_from_reports(args.squad, args.date, reports)
        except Exception as e:
            print(f"[hook] Task creation error (non-fatal): {e}", file=sys.stderr)

    if not args.no_email:
        try:
            send_report_email(args.squad, args.date, reports)
        except Exception as e:
            print(f"[hook] Email error (non-fatal): {e}", file=sys.stderr)

    # File R&D briefs to notes/Improvements/
    brief_path = ""
    if args.squad in IMPROVEMENTS_SQUADS:
        try:
            brief_path = file_rd_brief(reports, args.date)
        except Exception as e:
            print(f"[hook] R&D brief filing error (non-fatal): {e}", file=sys.stderr)

    # Telegram notification for configured squads
    if args.squad in TELEGRAM_NOTIFY_SQUADS:
        try:
            send_telegram_notification(
                squad=args.squad,
                date_str=args.date,
                reports=reports,
                duration_sec=args.duration,
                brief_path=brief_path,
            )
        except Exception as e:
            print(f"[hook] Telegram error (non-fatal): {e}", file=sys.stderr)

    print("[hook] Post-squad hook complete", file=sys.stderr)


if __name__ == "__main__":
    main()
