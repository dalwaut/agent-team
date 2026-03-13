"""OPAI Engine — Cron scheduler.

Rewrite of orchestrator.js cron logic in Python.
Uses croniter for cron expression parsing. Checks every 60 seconds.
"""

import asyncio
import json
import logging
import os
import shutil
import smtplib
import subprocess
import time
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

from croniter import croniter

import config
from audit import log_audit

logger = logging.getLogger("opai-engine.scheduler")


class Scheduler:
    """Cron-based task scheduler replacing Node.js orchestrator."""

    def __init__(self):
        self.orch_config: dict = {}
        self.schedules: dict[str, str] = {}
        self.last_run: dict[str, float] = {}
        self.active_jobs: dict[str, dict] = {}
        self.stats = {"total_jobs_run": 0, "total_jobs_failed": 0, "total_restarts": 0}
        self._state_file = config.ENGINE_STATE_FILE

    def load(self):
        """Load schedules from orchestrator.json and restore state."""
        self.orch_config = config.load_orchestrator_config()
        self.schedules = self.orch_config.get("schedules", {})
        self._load_state()
        logger.info("Scheduler loaded: %d schedules", len(self.schedules))

    def _load_state(self):
        """Restore last_run times from engine-state.json."""
        try:
            if self._state_file.is_file():
                state = json.loads(self._state_file.read_text())
                sched_state = state.get("scheduler", {})
                # Convert ISO strings back to timestamps
                for name, ts_str in sched_state.get("last_run", {}).items():
                    try:
                        self.last_run[name] = datetime.fromisoformat(ts_str).timestamp()
                    except (ValueError, TypeError):
                        pass
                self.stats = state.get("stats", self.stats)
        except (json.JSONDecodeError, OSError):
            pass

    def _save_state(self):
        """Persist scheduler state."""
        try:
            # Read existing state to merge
            state = {}
            if self._state_file.is_file():
                try:
                    state = json.loads(self._state_file.read_text())
                except (json.JSONDecodeError, OSError):
                    pass

            state["engine"] = {
                "version": "2.0.0",
                "started_at": state.get("engine", {}).get("started_at", datetime.now().isoformat()),
            }
            state["scheduler"] = {
                "last_run": {
                    name: datetime.fromtimestamp(ts).isoformat()
                    for name, ts in self.last_run.items()
                },
            }
            state["active_jobs"] = self.active_jobs
            state["stats"] = self.stats

            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            self._state_file.write_text(json.dumps(state, indent=2))
        except Exception as e:
            logger.error("Failed to save state: %s", e)

    def _should_run(self, name: str, cron_expr: str, now: datetime) -> bool:
        """Check if a scheduled task should run now."""
        last = self.last_run.get(name, 0)
        if not last:
            # First time — run if cron matches current minute
            try:
                c = croniter(cron_expr, now)
                c.get_prev(datetime)
                return True
            except (ValueError, KeyError):
                return False

        # Don't run more than once per minute
        if now.timestamp() - last < 60:
            return False

        try:
            c = croniter(cron_expr, datetime.fromtimestamp(last))
            next_run = c.get_next(datetime)
            return next_run <= now
        except (ValueError, KeyError):
            return False

    async def loop(self):
        """Main scheduler loop — checks every 60 seconds."""
        logger.info("Scheduler loop started")
        # Initial delay to let other services start
        await asyncio.sleep(10)

        while True:
            try:
                now = datetime.now()
                for name, cron_expr in self.schedules.items():
                    if self._should_run(name, cron_expr, now):
                        logger.info("Scheduled task triggered: %s", name)
                        asyncio.create_task(self._execute(name))
                        self.last_run[name] = now.timestamp()
                        self._save_state()
            except Exception as e:
                logger.error("Scheduler loop error: %s", e)

            await asyncio.sleep(60)

    async def _execute(self, task_name: str):
        """Execute a scheduled task."""
        # Check resource availability
        from background.resource_monitor import get_resource_state
        res = get_resource_state()
        if res and not res.get("can_execute", True):
            logger.warning("Deferring %s due to resource constraints", task_name)
            return

        # Check parallel job limit — lightweight tasks bypass the gate
        _LIGHTWEIGHT_TASKS = {
            "daily_agent_newsletter", "health_check", "coedit_activity_check",
            "workspace_mention_poll", "workspace_chat_poll", "knowledge_refresh",
        }
        max_parallel = self.orch_config.get("resources", {}).get("max_parallel_jobs", 3)
        if len(self.active_jobs) >= max_parallel and task_name not in _LIGHTWEIGHT_TASKS:
            logger.warning("Deferring %s due to parallel job limit (%d/%d)", task_name, len(self.active_jobs), max_parallel)
            return

        start_time = time.time()
        job_id = f"{task_name}-{int(start_time)}"
        self.active_jobs[job_id] = {"type": task_name, "startTime": start_time}

        try:
            success = await self._dispatch(task_name)
            duration = int((time.time() - start_time) * 1000)

            if success:
                self.stats["total_jobs_run"] = self.stats.get("total_jobs_run", 0) + 1
            else:
                self.stats["total_jobs_failed"] = self.stats.get("total_jobs_failed", 0) + 1

            log_audit(
                tier="system",
                service="opai-engine",
                event=f"schedule:{task_name}",
                status="completed" if success else "failed",
                summary=f"Scheduled task {task_name} {'completed' if success else 'failed'} — {duration}ms",
                duration_ms=duration,
            )
        except Exception as e:
            self.stats["total_jobs_failed"] = self.stats.get("total_jobs_failed", 0) + 1
            logger.error("Scheduled task %s failed: %s", task_name, e)
        finally:
            self.active_jobs.pop(job_id, None)
            self._save_state()

    async def _dispatch(self, task_name: str) -> bool:
        """Route a scheduled task to its handler."""
        handlers = {
            "health_check": self._health_check,
            "email_check": self._email_check,
            "task_process": self._task_process,
            "feedback_process": self._feedback_process,
            "feedback_act": self._feedback_act,
            "user_sandbox_scan": self._sandbox_scan,
            "daily_evolve": self._daily_evolve,
            "workspace_audit": lambda: self._run_squad("workspace"),
            "knowledge_sync": lambda: self._run_squad("knowledge"),
            "dep_scan_daily": lambda: self._run_squad("dep_scan"),
            "secrets_scan_daily": lambda: self._run_squad("secrets_scan"),
            "security_quick": lambda: self._run_squad("security_quick"),
            "incident_check": lambda: self._run_squad("incident"),
            "a11y_weekly": lambda: self._run_squad("a11y"),
            "context_harvest": self._context_harvest,
            "workspace_folder_audit": self._workspace_folder_audit,
            "workspace_mention_poll": self._workspace_mention_poll,
            "workspace_chat_poll": self._workspace_chat_poll,
            "coedit_activity_check": self._coedit_activity_check,
            "daily_agent_newsletter": self._daily_agent_newsletter,
            "knowledge_refresh": self._knowledge_refresh,
        }

        handler = handlers.get(task_name)
        if handler:
            return await handler()
        else:
            logger.warning("Unknown scheduled task: %s", task_name)
            return False

    async def _health_check(self) -> bool:
        """Trigger service health monitoring."""
        from background.service_monitor import check_all_services
        await check_all_services()
        return True

    async def _email_check(self) -> bool:
        """Run email check."""
        return await self._spawn_process(
            ["node", "index.js", "--check"],
            cwd=str(config.EMAIL_CHECKER_DIR),
            timeout=300,
        )

    async def _task_process(self) -> bool:
        """Process task registry."""
        import services.task_processor as tp
        try:
            tp.auto_execute_cycle()
            return True
        except Exception as e:
            logger.error("Task process error: %s", e)
            return False

    async def _feedback_process(self) -> bool:
        """Run feedback processor."""
        return await self._spawn_process(
            ["node", "index.js"],
            cwd=str(config.TOOLS_DIR / "feedback-processor"),
            timeout=300,
        )

    async def _feedback_act(self) -> bool:
        """Run feedback actor."""
        return await self._spawn_process(
            ["node", "feedback-actor.js"],
            cwd=str(config.TOOLS_DIR / "feedback-processor"),
            timeout=120,
        )

    async def _sandbox_scan(self) -> bool:
        """Scan user sandboxes for pending tasks."""
        sandbox_cfg = self.orch_config.get("sandbox", {})
        if not sandbox_cfg.get("enabled"):
            return True
        # Delegate to the sandbox scanner (reusing orchestrator logic)
        from background.sandbox_scanner import scan_user_sandboxes
        await scan_user_sandboxes(sandbox_cfg)
        return True

    async def _context_harvest(self) -> bool:
        """Run the context harvester worker and save journal output."""
        try:
            result = await self.worker_manager.run_task_worker("context-harvester")
            if result.get("status") in ("completed", "failed"):
                # Write summary to journal-latest.json
                import config as cfg
                cfg.JOURNAL_DIR.mkdir(parents=True, exist_ok=True)
                journal_entry = {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "status": result.get("status"),
                    "output_path": result.get("output_path"),
                    "output_length": result.get("output_length", 0),
                    "evaluation": result.get("evaluation", {}),
                }
                cfg.JOURNAL_LATEST.write_text(json.dumps(journal_entry, indent=2, default=str))
                logger.info("Context harvest complete: %s", result.get("status"))
                return result.get("status") == "completed"
            return False
        except Exception as e:
            logger.error("Context harvest failed: %s", e)
            return False

    async def _workspace_folder_audit(self) -> bool:
        """Run daily Google Workspace Agent folder audit."""
        try:
            from background.workspace_agent import run_folder_audit, format_hitl_message
            result = await run_folder_audit()

            if result.get("error"):
                logger.error("Workspace folder audit error: %s", result["error"])
                return False

            # Post findings to HITL if there are any
            findings = result.get("findings", [])
            if findings:
                try:
                    from background import notifier
                    message = await format_hitl_message(result)
                    notifier.queue_notification(
                        message,
                        topic="hitl",
                        buttons=[
                            {"text": "Acknowledge", "callback_data": "hitl:approve:workspace_audit"},
                            {"text": "Dismiss", "callback_data": "hitl:dismiss:workspace_audit"},
                        ],
                    )
                except Exception as e:
                    logger.warning("HITL notification failed: %s", e)

            logger.info(
                "Workspace folder audit: %d files, %d findings",
                result.get("summary", {}).get("total_files", 0),
                len(findings),
            )
            return True
        except ImportError as e:
            logger.warning("Workspace audit skipped (missing deps): %s", e)
            return True
        except Exception as e:
            logger.error("Workspace folder audit failed: %s", e)
            return False

    async def _workspace_mention_poll(self) -> bool:
        """Poll Google Docs for @agent mention commands."""
        try:
            from background.workspace_mentions import poll_workspace_mentions
            stats = await poll_workspace_mentions()
            logger.info(
                "Mention poll: %d docs, %d processed",
                stats.get("docs_scanned", 0),
                stats.get("commands_processed", 0),
            )
            return stats.get("errors", 0) == 0
        except ImportError as e:
            logger.warning("Workspace mentions skipped (missing deps): %s", e)
            return True
        except Exception as e:
            logger.error("Workspace mention poll failed: %s", e)
            return False

    async def _workspace_chat_poll(self) -> bool:
        """Poll Google Chat for messages to respond to."""
        try:
            from background.workspace_chat import poll_workspace_chat
            stats = await poll_workspace_chat()
            logger.info(
                "Chat poll: %d spaces, %d processed",
                stats.get("spaces_scanned", 0),
                stats.get("commands_processed", 0),
            )
            return stats.get("errors", 0) == 0
        except ImportError as e:
            logger.warning("Workspace chat skipped (missing deps): %s", e)
            return True
        except Exception as e:
            logger.error("Workspace chat poll failed: %s", e)
            return False

    async def _coedit_activity_check(self) -> bool:
        """Check all active co-edit sessions for human activity and timeouts."""
        try:
            coedit_cfg = self.orch_config.get("coedit", {})
            if not coedit_cfg.get("enabled", True):
                return True

            timeout_min = coedit_cfg.get("timeout_minutes", 10)

            from background.workspace_coedit import (
                get_active_sessions,
                update_human_activity,
                check_timeouts,
            )

            sessions = get_active_sessions()
            if not sessions:
                return True

            # For each active session, check Drive revisions for human edits
            from google_workspace import GoogleWorkspace
            ws = GoogleWorkspace()

            try:
                for session in sessions:
                    doc_id = session.get("doc_id")
                    baseline = session.get("revision_baseline")
                    if not doc_id:
                        continue

                    try:
                        revisions = await ws.docs_get_revisions(doc_id, page_size=10)
                    except Exception as e:
                        logger.warning("Failed to fetch revisions for %s: %s", doc_id, e)
                        continue

                    # Check if any revision since baseline was by a human (not agent@)
                    found_human = False
                    latest_rev_id = baseline
                    for rev in revisions:
                        rev_id = rev.get("id", "")
                        # Skip revisions at or before baseline
                        if baseline and rev_id <= str(baseline):
                            continue

                        user_email = rev.get("lastModifyingUser", {}).get("emailAddress", "")
                        if user_email and user_email.lower() != "agent@paradisewebfl.com":
                            found_human = True
                            latest_rev_id = rev_id

                    if found_human:
                        update_human_activity(doc_id, latest_rev_id)

                # Check timeouts
                timed_out = check_timeouts(timeout_min)

                # Notify for timed-out sessions
                for session in timed_out:
                    doc_title = session.get("doc_title", "Untitled")
                    doc_id = session.get("doc_id", "")

                    # Post comment on the doc
                    try:
                        await ws.docs_add_comment(
                            doc_id,
                            f"Co-edit deactivated — no activity for {timeout_min} minutes. "
                            "Say @agent join to resume.",
                        )
                    except Exception as e:
                        logger.warning("Failed to post timeout comment on %s: %s", doc_title, e)

                    # Telegram notification
                    try:
                        from background import notifier
                        await notifier.send_telegram(
                            f"\U0001F4DD *Co-edit timeout*: _{doc_title}_\n"
                            f"No human activity for {timeout_min} min — session deactivated.",
                            parse_mode="Markdown",
                            thread_id=notifier._hitl_thread_id,
                        )
                    except Exception as e:
                        logger.warning("Failed to send coedit timeout notification: %s", e)

                if timed_out:
                    logger.info("Co-edit activity check: %d sessions timed out", len(timed_out))

            finally:
                await ws.close()

            return True

        except ImportError as e:
            logger.warning("Co-edit activity check skipped (missing deps): %s", e)
            return True
        except Exception as e:
            logger.error("Co-edit activity check failed: %s", e)
            return False

    async def _knowledge_refresh(self) -> bool:
        """Refresh business context file for chat agent."""
        try:
            from background.knowledge_refresher import run_knowledge_refresh
            result = await run_knowledge_refresh()
            logger.info("Knowledge refresh complete: %d chars", result.get("output_chars", 0))
            return True
        except Exception as e:
            logger.error("Knowledge refresh failed: %s", e)
            return False

    async def _daily_agent_newsletter(self) -> bool:
        """Send daily Chat Agent newsletter with activity, gaps, and feature announcements.

        Sends when ANY of these have content:
        - Feature announcements (new capabilities deployed)
        - TeamHub activity from Chat yesterday
        - Capability gaps from yesterday
        Skips only when all three are empty.
        """
        from datetime import timedelta

        today = datetime.now().strftime("%Y-%m-%d")
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        data_dir = config.ENGINE_DIR / "data"

        # ── Feature announcements (unannounced entries) ──
        announcements = []
        announcements_file = data_dir / "feature-announcements.json"
        try:
            if announcements_file.is_file():
                all_announcements = json.loads(announcements_file.read_text())
                announcements = [a for a in all_announcements if not a.get("announced")]
        except Exception as e:
            logger.warning("Failed to read feature announcements: %s", e)

        # ── Capability change detection (git-based) ──
        # If no explicit announcements, check for recent feature commits
        # touching workspace/chat/teamhub/coedit files
        if not announcements:
            try:
                capability_paths = [
                    "tools/opai-engine/background/workspace_",
                    "tools/opai-engine/background/chat_skills",
                    "tools/opai-team-hub/",
                    "tools/shared/google_workspace",
                    "Library/opai-wiki/integrations/google-workspace",
                ]
                # Check git log for feat: commits in last 48h touching capability files
                result = await asyncio.create_subprocess_exec(
                    "git", "log", "--oneline", "--since=48 hours ago",
                    "--diff-filter=ACMR", "--name-only",
                    "--grep=feat:", "--grep=feature", "--all-match",
                    cwd=str(config.OPAI_ROOT),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await asyncio.wait_for(result.communicate(), timeout=10)
                git_output = stdout.decode(errors="replace")

                has_capability_change = any(
                    cap_path in git_output
                    for cap_path in capability_paths
                )
                if has_capability_change:
                    logger.info("Git capability change detected but no announcement file — skipping auto-generation")
            except Exception:
                pass  # Git check is best-effort

        # ── Gaps from yesterday ──
        gaps = []
        gaps_file = data_dir / "chat-gaps.json"
        try:
            if gaps_file.is_file():
                all_gaps = json.loads(gaps_file.read_text())
                gaps = [g for g in all_gaps if g.get("timestamp", "").startswith(yesterday)]
        except Exception as e:
            logger.warning("Failed to read chat gaps: %s", e)

        # ── TeamHub activity from yesterday ──
        activity = []
        activity_file = data_dir / "chat-activity.json"
        try:
            if activity_file.is_file():
                all_activity = json.loads(activity_file.read_text())
                activity = [a for a in all_activity if a.get("timestamp", "").startswith(yesterday)]
        except Exception as e:
            logger.warning("Failed to read chat activity: %s", e)

        # Skip if nothing to report
        if not gaps and not activity and not announcements:
            logger.info("Daily agent newsletter: nothing to report — skipping")
            return True

        # ── Build email ──
        is_announcement = bool(announcements)

        if is_announcement:
            headline = announcements[0].get("headline", "New Features Available")
            subject = f"[Paradise Web] {headline}"
        elif activity or gaps:
            subject = f"[Agent Newsletter] {yesterday}"
        else:
            subject = f"[Agent Newsletter] {today}"

        # Build plain text
        plain_lines = []
        if announcements:
            for ann in announcements:
                plain_lines.append(ann.get("headline", "New Features"))
                plain_lines.append(ann.get("subheadline", ""))
                plain_lines.append("")
                for section in ann.get("sections", []):
                    plain_lines.append(f"== {section['title']} ==")
                    for item in section.get("items", []):
                        plain_lines.append(f"  - {item}")
                    plain_lines.append("")
                if ann.get("footer"):
                    plain_lines.append(ann["footer"])
                plain_lines.append("")

        if activity:
            plain_lines.append(f"== TeamHub Activity ({len(activity)} actions) ==")
            for a in activity[:20]:
                action = a.get("action", "?")
                title = a.get("title", a.get("item_id", "?"))
                plain_lines.append(f"  - {action}: {title}")
            plain_lines.append("")

        if gaps:
            plain_lines.append(f"== Capability Gaps ({len(gaps)}) ==")
            for g in gaps[:20]:
                sender = g.get("sender", "?")
                msg_text = g.get("message", "?")[:80]
                reason = g.get("reason", "unrecognized")
                plain_lines.append(f'  - {sender}: "{msg_text}" [{reason}]')
            plain_lines.append("")

        plain_lines.append("---")
        plain_lines.append("Sent by Paradise Web AI Agent")
        plain_body = "\n".join(plain_lines)

        # Build HTML
        html = self._build_newsletter_html(today, activity, gaps, announcements)

        # ── Determine recipients ──
        recipients = ["Dallas@paradisewebfl.com", "Denise@paradisewebfl.com"]
        if announcements:
            # Announcements may specify additional recipients
            for ann in announcements:
                for r in ann.get("recipients", []):
                    if r not in recipients:
                        recipients.append(r)

        # ── Send via SMTP ──
        # Try vault runtime env first, fall back to .env file, then os.environ
        vault_env_path = Path(f"/run/user/{os.getuid()}/opai-vault/opai-email-agent.env")
        dotenv_path = config.OPAI_ROOT / "tools" / "opai-email-agent" / ".env"
        smtp_creds = self._load_dotenv(vault_env_path) or self._load_dotenv(dotenv_path)

        smtp_host = smtp_creds.get("AGENT_SMTP_HOST") or os.environ.get("AGENT_SMTP_HOST", "smtp.gmail.com")
        smtp_port = int(smtp_creds.get("AGENT_SMTP_PORT") or os.environ.get("AGENT_SMTP_PORT", "465"))
        smtp_user = smtp_creds.get("AGENT_SMTP_USER") or os.environ.get("AGENT_SMTP_USER", "")
        smtp_pass = smtp_creds.get("AGENT_SMTP_PASS") or os.environ.get("AGENT_SMTP_PASS", "")

        if not smtp_user or not smtp_pass:
            logger.warning("SMTP credentials not configured — skipping agent newsletter")
            return True

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = "Agent@paradisewebfl.com"
        msg["To"] = recipients[0]
        if len(recipients) > 1:
            msg["Cc"] = ", ".join(recipients[1:])
        msg.attach(MIMEText(plain_body, "plain"))
        msg.attach(MIMEText(html, "html"))

        try:
            if smtp_port == 465:
                with smtplib.SMTP_SSL(smtp_host, smtp_port) as server:
                    server.login(smtp_user, smtp_pass)
                    server.sendmail("Agent@paradisewebfl.com", recipients, msg.as_string())
            else:
                with smtplib.SMTP(smtp_host, smtp_port) as server:
                    server.starttls()
                    server.login(smtp_user, smtp_pass)
                    server.sendmail("Agent@paradisewebfl.com", recipients, msg.as_string())
            logger.info(
                "Agent newsletter sent: %d announcements, %d activity, %d gaps",
                len(announcements), len(activity), len(gaps),
            )
        except Exception as e:
            logger.error("Agent newsletter send failed: %s", e)
            return False

        # ── Mark announcements as sent ──
        if announcements:
            try:
                all_announcements = json.loads(announcements_file.read_text())
                for ann in all_announcements:
                    if not ann.get("announced"):
                        ann["announced"] = True
                        ann["announced_at"] = datetime.now(timezone.utc).isoformat()
                announcements_file.write_text(json.dumps(all_announcements, indent=2))
                logger.info("Marked %d announcements as sent", len(announcements))
            except Exception as e:
                logger.warning("Failed to mark announcements as sent: %s", e)

        return True

    @staticmethod
    def _build_newsletter_html(date_str: str, activity: list, gaps: list,
                               announcements: list = None) -> str:
        """Build HTML for the Chat Agent newsletter (announcements + daily report)."""

        ICON_MAP = {
            "chat": "💬", "tasks": "✅", "docs": "📄",
            "coedit": "✏️", "teamhub": "📋", "default": "🔹",
        }
        SECTION_COLORS = ["#2980b9", "#27ae60", "#8e44ad", "#e67e22", "#16a085"]

        # ── Announcement sections ─────────────────────────────────────────
        announcement_html = ""
        if announcements:
            for ann in announcements:
                headline = ann.get("headline", "New Features")
                subheadline = ann.get("subheadline", "")
                footer = ann.get("footer", "")

                ann_header = f"""
                <div style="text-align:center;margin-bottom:20px">
                  <h2 style="margin:0 0 6px;font-size:22px;color:#1a1a2e">{headline}</h2>
                  <div style="font-size:14px;color:#5d6d7e;line-height:1.5">{subheadline}</div>
                </div>"""

                sections_html = ""
                for idx, section in enumerate(ann.get("sections", [])):
                    icon = ICON_MAP.get(section.get("icon", ""), ICON_MAP["default"])
                    color = SECTION_COLORS[idx % len(SECTION_COLORS)]
                    title = section.get("title", "")

                    items_html = ""
                    for item in section.get("items", []):
                        items_html += (
                            f'<tr><td style="padding:6px 0;font-size:13px;color:#34495e;'
                            f'border-bottom:1px solid #f0f0f0;line-height:1.5">'
                            f'{item}</td></tr>'
                        )

                    sections_html += f"""
                    <div style="margin:16px 0;border:1px solid #e8e8e8;border-radius:8px;overflow:hidden">
                      <div style="background:{color};padding:10px 16px;display:flex;align-items:center">
                        <span style="font-size:20px;margin-right:10px">{icon}</span>
                        <span style="color:#fff;font-weight:bold;font-size:15px">{title}</span>
                      </div>
                      <table style="width:100%;border-collapse:collapse;padding:0 16px">
                        <tbody style="padding:8px 16px">{items_html}</tbody>
                      </table>
                    </div>"""

                ann_footer = ""
                if footer:
                    ann_footer = f"""
                    <div style="margin:20px 0 8px;padding:14px 16px;background:#eafaf1;border-radius:6px;
                                font-size:13px;color:#27ae60;text-align:center;line-height:1.5">
                      {footer}
                    </div>"""

                announcement_html += ann_header + sections_html + ann_footer

        # ── Activity section ──────────────────────────────────────────────
        activity_html = ""
        if activity:
            rows = ""
            for a in activity[:25]:
                action = a.get("action", "?")
                title = a.get("title", a.get("item_id", "?"))
                ts = a.get("timestamp", "")[:16].replace("T", " ")
                color = {"task_created": "#27ae60", "task_updated": "#2980b9"}.get(action, "#7f8c8d")
                rows += (
                    f'<tr><td style="padding:4px 8px;border-bottom:1px solid #ecf0f1;font-size:12px">{ts}</td>'
                    f'<td style="padding:4px 8px;border-bottom:1px solid #ecf0f1">'
                    f'<span style="background:{color};color:#fff;border-radius:3px;padding:1px 6px;'
                    f'font-size:11px">{action}</span></td>'
                    f'<td style="padding:4px 8px;border-bottom:1px solid #ecf0f1">{title}</td></tr>'
                )
            activity_html = f"""
            <div style="border-left:4px solid #2980b9;padding:12px 16px;margin:12px 0;background:#f0f8ff;border-radius:0 6px 6px 0">
              <div style="font-weight:bold;font-size:15px;color:#2980b9;margin-bottom:8px">
                TeamHub Activity ({len(activity)})
              </div>
              <table style="width:100%;border-collapse:collapse;font-size:13px">{rows}</table>
            </div>"""

        # ── Gaps section ──────────────────────────────────────────────────
        gaps_html = ""
        if gaps:
            items = ""
            for g in gaps[:25]:
                sender = g.get("sender", "?")
                msg = g.get("message", "?")[:100]
                reason = g.get("reason", "unrecognized")
                items += (
                    f'<li style="margin:4px 0;font-size:13px">'
                    f'<strong>{sender}</strong>: "{msg}" '
                    f'<span style="color:#7f8c8d;font-size:11px">[{reason}]</span></li>'
                )
            gaps_html = f"""
            <div style="border-left:4px solid #e67e22;padding:12px 16px;margin:12px 0;background:#fef9f0;border-radius:0 6px 6px 0">
              <div style="font-weight:bold;font-size:15px;color:#e67e22;margin-bottom:8px">
                Capability Gaps ({len(gaps)})
              </div>
              <ul style="margin:8px 0;padding-left:18px">{items}</ul>
            </div>"""

        # ── Determine title / layout ──────────────────────────────────────
        is_announcement = bool(announcements)
        if is_announcement:
            header_title = "New Features for Your Team"
            header_subtitle = date_str
        else:
            header_title = "Chat Agent Daily Report"
            header_subtitle = date_str

        # Stats bar only when there's daily data
        stats_html = ""
        if activity or gaps:
            stats_html = f"""
            <div style="display:flex;gap:12px;margin-bottom:16px">
              <div style="flex:1;text-align:center;background:#ecf0f1;border-radius:6px;padding:10px">
                <div style="font-size:20px;font-weight:bold;color:#2980b9">{len(activity)}</div>
                <div style="font-size:11px;color:#7f8c8d">TeamHub Actions</div>
              </div>
              <div style="flex:1;text-align:center;background:#ecf0f1;border-radius:6px;padding:10px">
                <div style="font-size:20px;font-weight:bold;color:#e67e22">{len(gaps)}</div>
                <div style="font-size:11px;color:#7f8c8d">Gaps Detected</div>
              </div>
            </div>"""

        # Divider between announcement and daily sections
        divider = ""
        if announcement_html and (activity_html or gaps_html):
            divider = '<hr style="border:none;border-top:2px solid #ecf0f1;margin:24px 0">'

        # Footer text
        if is_announcement and not activity and not gaps:
            footer_text = f"Sent by Paradise Web AI Agent &mdash; {date_str}"
        else:
            footer_text = (
                f"This report covers Chat Agent activity for {date_str}. "
                f"Gaps indicate requests the agent couldn't handle &mdash; potential areas for expansion."
            )

        return f"""
        <html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#2c3e50">
          <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px;border-radius:8px 8px 0 0;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:22px">{header_title}</h1>
            <div style="color:#bdc3c7;font-size:13px;margin-top:8px">{header_subtitle}</div>
          </div>
          <div style="padding:24px;border:1px solid #ecf0f1;border-top:none;border-radius:0 0 8px 8px">
            {announcement_html}
            {divider}
            {stats_html}
            {activity_html}
            {gaps_html}
            <div style="margin-top:24px;padding:12px;background:#f8f9fa;border-radius:6px;font-size:12px;color:#5d6d7e;text-align:center">
              {footer_text}
            </div>
            <div style="margin-top:12px;font-size:11px;color:#bdc3c7;text-align:center">
              Paradise Web AI Agent &bull; {date_str}
            </div>
          </div>
        </body></html>"""

    @staticmethod
    def _claude_env() -> dict:
        """Build env dict with nvm bin on PATH for claude CLI access."""
        nvm_bin = Path.home() / ".nvm" / "versions" / "node" / "v20.19.5" / "bin"
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        if nvm_bin.exists():
            env["PATH"] = f"{nvm_bin}:{env.get('PATH', '')}"
        return env

    async def _run_squad(self, squad_name: str) -> bool:
        """Run an agent squad."""
        return await self._spawn_process(
            ["bash", str(config.SCRIPTS_DIR / "run_squad.sh"), "-s", squad_name, "--skip-preflight"],
            cwd=str(config.OPAI_ROOT),
            timeout=1800,
            env=self._claude_env(),
        )

    # ── Daily evolve automation ──────────────────────────────────────────────

    async def _daily_evolve(self) -> bool:
        """Consolidated daily evolution: auto_safe → apply fixes → evolve → email.

        Phase 1: Run auto_safe squad (accuracy, health, security, reviewer, executor_safe)
        Phase 2: Apply safe fixes from executor_safe plan via Claude CLI
        Phase 3: Run evolve squad (self_assessment)
        Phase 4: Send consolidated email with applied fixes + approval items
        """
        today = datetime.now().strftime("%Y-%m-%d")
        report_dir = config.OPAI_ROOT / "reports" / today
        latest_dir = config.OPAI_ROOT / "reports" / "latest"
        logger.info("Daily evolve started for %s", today)

        # Pre-phase: archive old report dirs (>14 days)
        self._archive_old_reports()

        # Phase 1: Run auto_safe squad
        logger.info("Phase 1: Running auto_safe squad")
        phase1_ok = await self._spawn_process(
            ["bash", str(config.SCRIPTS_DIR / "run_squad.sh"),
             "-s", "auto_safe", "--skip-preflight"],
            cwd=str(config.OPAI_ROOT),
            timeout=1800,
            env=self._claude_env(),
        )
        if not phase1_ok:
            logger.error("Phase 1 (auto_safe) failed — continuing to evolve anyway")

        # Phase 2: Apply safe fixes from executor_safe plan
        logger.info("Phase 2: Applying safe fixes")
        applied_fixes = []
        try:
            applied_fixes = await self._apply_safe_fixes(today)
            logger.info("Phase 2 complete: %d fixes applied", len(applied_fixes))
        except Exception as e:
            logger.error("Phase 2 (apply fixes) error: %s", e)

        # Phase 3: Run evolve squad (self_assessment)
        logger.info("Phase 3: Running evolve squad")
        phase3_ok = await self._spawn_process(
            ["bash", str(config.SCRIPTS_DIR / "run_squad.sh"),
             "-s", "evolve", "--skip-preflight"],
            cwd=str(config.OPAI_ROOT),
            timeout=1800,
            env=self._claude_env(),
        )
        if not phase3_ok:
            logger.warning("Phase 3 (evolve) failed")

        # Phase 3.5: Meta-assessment (verify the assessment pipeline itself)
        phases = self.orch_config.get("evolve", {}).get("daily_evolve", {}).get("phases", [])
        if "meta_assess" in phases:
            logger.info("Phase 3.5: Running meta-assessment")
            try:
                meta_prompt = (config.SCRIPTS_DIR / "prompt_meta_assessment.txt").read_text()
                meta_proc = await asyncio.create_subprocess_exec(
                    "claude", "-p", "--model", "sonnet",
                    "--max-turns", "20",
                    "--allowedTools", "Read,Glob,Grep",
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(config.OPAI_ROOT),
                    env=self._claude_env(),
                )
                meta_stdout, _ = await asyncio.wait_for(
                    meta_proc.communicate(input=meta_prompt.encode()),
                    timeout=600,
                )
                meta_output = meta_stdout.decode(errors="replace")
                meta_report = f"# Meta-Assessment Report — {today}\n\n{meta_output}"

                # Save to latest/ and dated dir
                (latest_dir / "meta_assessment.md").write_text(meta_report)
                report_dir.mkdir(parents=True, exist_ok=True)
                (report_dir / "meta_assessment.md").write_text(meta_report)
                logger.info("Phase 3.5 complete: meta-assessment saved")
            except asyncio.TimeoutError:
                logger.warning("Phase 3.5 (meta_assess) timed out")
            except FileNotFoundError:
                logger.error("claude CLI not found — cannot run meta-assessment")
            except Exception as e:
                logger.error("Phase 3.5 (meta_assess) error: %s", e)

        # Phase 4: Send consolidated email
        logger.info("Phase 4: Sending consolidated email")
        try:
            await self._send_evolve_email(today, applied_fixes, latest_dir)
        except Exception as e:
            logger.error("Phase 4 (email) error: %s", e)

        return phase1_ok or phase3_ok

    def _archive_old_reports(self):
        """Archive report directories older than 14 days."""
        reports_root = config.OPAI_ROOT / "reports"
        archive_dir = reports_root / "Archive"
        cutoff = datetime.now().timestamp() - (14 * 86400)

        for entry in reports_root.iterdir():
            if not entry.is_dir():
                continue
            # Only process dated directories (YYYY-MM-DD)
            try:
                dir_date = datetime.strptime(entry.name, "%Y-%m-%d")
            except ValueError:
                continue
            if dir_date.timestamp() < cutoff:
                try:
                    archive_dir.mkdir(parents=True, exist_ok=True)
                    dest = archive_dir / entry.name
                    if dest.exists():
                        shutil.rmtree(dest)
                    shutil.move(str(entry), str(dest))
                    logger.info("Archived old report dir: %s", entry.name)
                except Exception as e:
                    logger.warning("Failed to archive %s: %s", entry.name, e)

    async def _apply_safe_fixes(self, date_str: str) -> list[dict]:
        """Read executor_safe plan and apply fixes via Claude CLI.

        Returns list of dicts: [{"file": ..., "action": ..., "status": ...}, ...]
        """
        latest_dir = config.OPAI_ROOT / "reports" / "latest"
        plan_path = latest_dir / "executor_safe.md"

        if not plan_path.is_file():
            logger.info("No executor_safe plan found — skipping apply")
            return []

        plan_text = plan_path.read_text(errors="replace")
        if not plan_text.strip() or "no fixes" in plan_text.lower()[:200]:
            logger.info("Executor safe plan is empty or has no fixes")
            return []

        # Build the apply prompt
        apply_prompt = (
            "You are the OPAI Safe Executor. Apply ONLY the fixes listed below. "
            "Each fix has been pre-approved as safe (formatting, config typos, "
            "missing imports, dead code removal). Do NOT make any changes beyond "
            "what is explicitly listed. For each fix, edit the file and confirm "
            "what you changed.\n\n"
            f"## Executor Safe Plan\n\n{plan_text}\n\n"
            "After applying all fixes, output a summary in this format:\n"
            "APPLIED: <file> — <action>\n"
            "SKIPPED: <file> — <reason>\n"
        )

        # Run claude -p to apply fixes
        result_path = config.OPAI_ROOT / "reports" / date_str / "executor_safe_result.md"
        result_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            proc = await asyncio.create_subprocess_exec(
                "claude", "-p", "--model", "sonnet",
                "--max-turns", "35",
                "--allowedTools", "Read,Edit,Glob,Grep,Bash(git diff:*)",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(config.OPAI_ROOT),
                env=self._claude_env(),
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=apply_prompt.encode()),
                timeout=600,
            )
            output = stdout.decode(errors="replace")
            result_path.write_text(f"# Executor Safe Result — {date_str}\n\n{output}")

            # Also save to latest/
            latest_result = latest_dir / "executor_safe_result.md"
            latest_result.write_text(f"# Executor Safe Result — {date_str}\n\n{output}")

        except asyncio.TimeoutError:
            logger.warning("Claude apply timed out")
            result_path.write_text(f"# Executor Safe Result — {date_str}\n\nTIMEOUT after 600s")
            return []
        except FileNotFoundError:
            logger.error("claude CLI not found — cannot apply fixes")
            return []
        except Exception as e:
            logger.error("Apply fixes error: %s", e)
            return []

        # Parse applied fixes from output
        applied = []
        import re
        for line in output.splitlines():
            m = re.match(r"^APPLIED:\s*(.+?)\s*[—–-]\s*(.+)$", line)
            if m:
                applied.append({"file": m.group(1).strip(), "action": m.group(2).strip(), "status": "applied"})
            m2 = re.match(r"^SKIPPED:\s*(.+?)\s*[—–-]\s*(.+)$", line)
            if m2:
                applied.append({"file": m2.group(1).strip(), "action": m2.group(2).strip(), "status": "skipped"})

        return applied

    async def _send_evolve_email(self, date_str: str, applied_fixes: list[dict],
                                  latest_dir: Path):
        """Send consolidated daily evolution email."""
        # Load SMTP credentials — vault runtime env → .env fallback → os.environ
        vault_env_path = Path(f"/run/user/{os.getuid()}/opai-vault/opai-email-agent.env")
        dotenv_path = config.OPAI_ROOT / "tools" / "opai-email-agent" / ".env"
        smtp_creds = self._load_dotenv(vault_env_path) or self._load_dotenv(dotenv_path)

        smtp_host = smtp_creds.get("AGENT_SMTP_HOST") or os.environ.get("AGENT_SMTP_HOST", "smtp.gmail.com")
        smtp_port = int(smtp_creds.get("AGENT_SMTP_PORT") or os.environ.get("AGENT_SMTP_PORT", "465"))
        smtp_user = smtp_creds.get("AGENT_SMTP_USER") or os.environ.get("AGENT_SMTP_USER", "")
        smtp_pass = smtp_creds.get("AGENT_SMTP_PASS") or os.environ.get("AGENT_SMTP_PASS", "")

        if not smtp_user or not smtp_pass:
            logger.warning("SMTP credentials not configured — skipping evolve email")
            return

        # Parse self_assessment report for P0/P1/P2 items
        assessment_path = latest_dir / "self_assessment.md"
        approval_items = []
        assessment_status = "N/A"
        if assessment_path.is_file():
            import re
            text = assessment_path.read_text(errors="replace")
            assessment_status = "PASS" if "health.*good" in text.lower() or "all.*pass" in text.lower() else "REVIEW"
            for m in re.finditer(r"^[-*]\s*(P0|P1|P2)[:\s]+(.+)$", text, re.MULTILINE | re.IGNORECASE):
                approval_items.append({"priority": m.group(1).upper(), "description": m.group(2).strip()})

        # Build counts
        n_applied = sum(1 for f in applied_fixes if f["status"] == "applied")
        n_skipped = sum(1 for f in applied_fixes if f["status"] == "skipped")
        fixes_status = f"APPLIED ({n_applied})" if n_applied > 0 else "SKIPPED"

        # Build HTML email
        html = self._build_evolve_html(
            date_str, applied_fixes, approval_items,
            assessment_status, fixes_status, n_applied, n_skipped,
        )

        # Build plain text fallback
        plain_lines = [f"OPAI Daily Evolution — {date_str}", ""]
        if applied_fixes:
            plain_lines.append("== Applied (Safe) ==")
            for f in applied_fixes:
                plain_lines.append(f"  [{f['status'].upper()}] {f['file']} — {f['action']}")
            plain_lines.append("")
        if approval_items:
            plain_lines.append("== Needs Your Approval ==")
            for item in approval_items:
                plain_lines.append(f"  [{item['priority']}] {item['description']}")
        plain_body = "\n".join(plain_lines)

        # Compose and send
        severity = "ACTION REQUIRED" if any(i["priority"] == "P0" for i in approval_items) else "Daily Report"
        subject = f"[OPAI EVOLVE] {severity} — {date_str} ({n_applied} fixes applied, {len(approval_items)} need approval)"

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = "Agent@paradisewebfl.com"
        msg["To"] = "Dallas@paradisewebfl.com"
        msg.attach(MIMEText(plain_body, "plain"))
        msg.attach(MIMEText(html, "html"))

        try:
            if smtp_port == 465:
                with smtplib.SMTP_SSL(smtp_host, smtp_port) as server:
                    server.login(smtp_user, smtp_pass)
                    server.sendmail("Agent@paradisewebfl.com", ["Dallas@paradisewebfl.com"], msg.as_string())
            else:
                with smtplib.SMTP(smtp_host, smtp_port) as server:
                    server.starttls()
                    server.login(smtp_user, smtp_pass)
                    server.sendmail("Agent@paradisewebfl.com", ["Dallas@paradisewebfl.com"], msg.as_string())
            logger.info("Daily evolve email sent")
        except Exception as e:
            logger.error("Evolve email send failed: %s", e)

    @staticmethod
    def _build_evolve_html(date_str: str, applied_fixes: list[dict],
                            approval_items: list[dict], assessment_status: str,
                            fixes_status: str, n_applied: int, n_skipped: int) -> str:
        """Build HTML for the daily evolution email."""
        # Status badge colors
        assess_color = "#27ae60" if assessment_status == "PASS" else "#e67e22"
        fixes_color = "#27ae60" if n_applied > 0 else "#7f8c8d"

        # Applied fixes section
        applied_html = ""
        if applied_fixes:
            rows = ""
            for f in applied_fixes:
                sc = "#27ae60" if f["status"] == "applied" else "#7f8c8d"
                rows += (
                    f'<tr><td style="padding:6px 8px;border-bottom:1px solid #ecf0f1">'
                    f'<span style="background:{sc};color:#fff;border-radius:3px;padding:1px 6px;'
                    f'font-size:11px">{f["status"].upper()}</span></td>'
                    f'<td style="padding:6px 8px;border-bottom:1px solid #ecf0f1;font-family:monospace;'
                    f'font-size:12px">{f["file"]}</td>'
                    f'<td style="padding:6px 8px;border-bottom:1px solid #ecf0f1">{f["action"]}</td></tr>'
                )
            applied_html = f"""
            <div style="border-left:4px solid #27ae60;padding:12px 16px;margin:12px 0;background:#f0faf0;border-radius:0 6px 6px 0">
              <div style="font-weight:bold;font-size:15px;color:#27ae60;margin-bottom:8px">Applied (Safe — No Action Needed)</div>
              <table style="width:100%;border-collapse:collapse;font-size:13px">{rows}</table>
            </div>"""
        else:
            applied_html = """
            <div style="border-left:4px solid #7f8c8d;padding:12px 16px;margin:12px 0;background:#f9f9f9;border-radius:0 6px 6px 0">
              <div style="font-weight:bold;font-size:14px;color:#7f8c8d">No safe fixes to apply today</div>
            </div>"""

        # Approval items section
        approval_html = ""
        if approval_items:
            items = ""
            for item in approval_items:
                badge_color = {"P0": "#c0392b", "P1": "#e67e22", "P2": "#7f8c8d"}.get(item["priority"], "#7f8c8d")
                items += (
                    f'<li style="margin:6px 0">'
                    f'<span style="background:{badge_color};color:#fff;border-radius:3px;'
                    f'padding:1px 6px;font-size:11px;font-weight:bold">{item["priority"]}</span> '
                    f'{item["description"]}</li>'
                )
            approval_html = f"""
            <div style="border-left:4px solid #e67e22;padding:12px 16px;margin:12px 0;background:#fef9f0;border-radius:0 6px 6px 0">
              <div style="font-weight:bold;font-size:15px;color:#e67e22;margin-bottom:8px">Needs Your Approval</div>
              <ul style="margin:8px 0;padding-left:18px">{items}</ul>
            </div>"""
        else:
            approval_html = """
            <div style="border-left:4px solid #27ae60;padding:12px 16px;margin:12px 0;background:#f0faf0;border-radius:0 6px 6px 0">
              <div style="font-weight:bold;font-size:14px;color:#27ae60">No items requiring approval</div>
            </div>"""

        return f"""
        <html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#2c3e50">
          <div style="background:#1a1a2e;padding:20px 24px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:20px">OPAI Daily Evolution Report</h1>
            <div style="color:#bdc3c7;font-size:13px;margin-top:6px">{date_str}</div>
          </div>
          <div style="padding:20px 24px;border:1px solid #ecf0f1;border-top:none;border-radius:0 0 8px 8px">
            <div style="display:flex;gap:12px;margin-bottom:16px">
              <div style="flex:1;text-align:center;background:#ecf0f1;border-radius:6px;padding:10px">
                <div style="font-size:14px;font-weight:bold;color:{assess_color}">{assessment_status}</div>
                <div style="font-size:11px;color:#7f8c8d">Assessment</div>
              </div>
              <div style="flex:1;text-align:center;background:#ecf0f1;border-radius:6px;padding:10px">
                <div style="font-size:14px;font-weight:bold;color:{fixes_color}">{fixes_status}</div>
                <div style="font-size:11px;color:#7f8c8d">Safe Fixes</div>
              </div>
              <div style="flex:1;text-align:center;background:#ecf0f1;border-radius:6px;padding:10px">
                <div style="font-size:20px;font-weight:bold;color:#e67e22">{len(approval_items)}</div>
                <div style="font-size:11px;color:#7f8c8d">Need Approval</div>
              </div>
            </div>
            {applied_html}
            {approval_html}
            <div style="margin-top:20px;padding:12px;background:#f0f8ff;border-radius:6px;font-size:12px;color:#5d6d7e">
              <strong>Review tasks have been created in the OPAI Task Control Panel.</strong><br>
              Safe fixes were auto-applied. Items above marked "Needs Approval" require your sign-off.
            </div>
            <div style="margin-top:12px;font-size:11px;color:#bdc3c7;text-align:center">
              Sent automatically by OPAI Daily Evolution &bull; {date_str}
            </div>
          </div>
        </body></html>"""

    @staticmethod
    def _load_dotenv(path: Path) -> dict:
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

    async def _spawn_process(self, cmd: list, cwd: str = None,
                             timeout: int = 300, env: dict = None) -> bool:
        """Spawn a subprocess and wait for completion."""
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                logger.warning("Process timed out: %s", " ".join(cmd[:3]))
                proc.terminate()
                await asyncio.sleep(5)
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                return False

            return proc.returncode == 0
        except FileNotFoundError:
            logger.error("Command not found: %s", cmd[0])
            return False
        except Exception as e:
            logger.error("Spawn error: %s", e)
            return False
