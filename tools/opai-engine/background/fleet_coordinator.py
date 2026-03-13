"""OPAI Engine — Fleet Coordinator (v3.5 + swarm enhancements).

Background loop that identifies actionable work, routes it to the right
worker, and tracks fleet activity. This is the "manager brain" that reads
heartbeat + tasks + health signals and orchestrates the workforce.

v3.6 additions:
- Worker mail: polls @coordinator inbox for dispatch requests + task proposals
- Hierarchical delegation: lead workers decompose complex tasks
- Auto-review pipeline: builders auto-trigger reviewer before completion
- Self-improvement: workers propose new tasks via PROPOSE_TASK output lines

Loop interval: every fleet_coordinator.interval_minutes (default 5 min).

Work identification is rule-based (not AI). Routing uses the configurable
routing map in orchestrator.json fleet_coordinator.routing.

State persists in data/fleet-state.json across restarts.
"""

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import httpx

import config
from audit import log_audit

logger = logging.getLogger("opai-engine.fleet-coordinator")

# Regex for parsing DISPATCH: and PROPOSE_TASK: lines from worker output
_KV_RE = re.compile(r'(\w+)=(?:"([^"]*)"|(\S+))')


class FleetCoordinator:
    """Fleet coordinator — identifies work, dispatches workers, tracks results."""

    def __init__(self, worker_manager, scheduler, worker_mail=None):
        self.worker_manager = worker_manager
        self.scheduler = scheduler
        self._mail = worker_mail
        self.state = self._load_state()
        self._cycle_count = 0

    # ── Persistence ─────────────────────────────────────────

    def _load_state(self) -> dict:
        try:
            if config.FLEET_STATE_FILE.is_file():
                return json.loads(config.FLEET_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
        return {
            "active_dispatches": [],
            "recent_completions": [],
            "queue_depth": 0,
            "last_cycle": None,
            "stats": {
                "dispatches_today": 0,
                "completions_today": 0,
                "failures_today": 0,
                "avg_completion_min": 0,
            },
        }

    def _save_state(self):
        config.FLEET_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.FLEET_STATE_FILE.write_text(
            json.dumps(self.state, indent=2, default=str)
        )

    def _reset_daily_stats_if_needed(self):
        """Reset daily counters at midnight."""
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if self.state.get("_stats_date") != today:
            self.state["stats"] = {
                "dispatches_today": 0,
                "completions_today": 0,
                "failures_today": 0,
                "avg_completion_min": 0,
            }
            self.state["_stats_date"] = today

    # ── Main Loop ───────────────────────────────────────────

    async def run(self):
        """Main background loop."""
        cfg = config.load_orchestrator_config().get("fleet_coordinator", {})
        if not cfg.get("enabled", True):
            logger.info("Fleet coordinator disabled")
            return

        interval = cfg.get("interval_minutes", 5) * 60
        logger.info("Fleet coordinator started (interval=%dm)", interval // 60)

        # Initial delay — let other systems stabilize
        await asyncio.sleep(60)

        while True:
            try:
                await self._cycle()
            except Exception as e:
                logger.error("Fleet coordinator cycle error: %s", e)
            await asyncio.sleep(interval)

    async def _cycle(self):
        """Execute one fleet coordinator cycle."""
        self._cycle_count += 1
        self._reset_daily_stats_if_needed()

        cfg = config.load_orchestrator_config().get("fleet_coordinator", {})

        # 1. Check active dispatches for completion/failure
        await self._check_active()

        # 1b. Poll mail for dispatch requests from lead workers
        await self._poll_dispatch_mail(cfg)

        # 1c. Process task proposals from workers
        await self._process_task_proposals()

        # 1d. Flush mirror messages to Team Hub
        if self._mail:
            await self._mail.flush_mirrors()

        # 2. Gather signals from all sources
        signals = self._gather_signals()

        # 3. Identify actionable work
        work_items = self._identify_work(signals, cfg)

        # 4. Route and dispatch work (up to concurrency limit)
        max_concurrent = cfg.get("max_concurrent_dispatches", 3)
        active_count = len(self.state.get("active_dispatches", []))
        slots_available = max(0, max_concurrent - active_count)

        dispatched = 0
        for item in work_items[:slots_available]:
            try:
                result = await self._dispatch_work(item, cfg)
                if result:
                    dispatched += 1
            except Exception as e:
                logger.error("Dispatch failed for %s: %s", item.get("id"), e)

        # 5. Update queue depth
        self.state["queue_depth"] = max(0, len(work_items) - dispatched)
        self.state["last_cycle"] = datetime.now(timezone.utc).isoformat()
        self._save_state()

        if dispatched or work_items:
            logger.info(
                "Fleet cycle #%d: %d signals, %d work items, %d dispatched, %d queued",
                self._cycle_count, len(signals), len(work_items),
                dispatched, self.state["queue_depth"],
            )

    # ── Signal Gathering ────────────────────────────────────

    def _gather_signals(self) -> dict:
        """Read all signal sources: heartbeat, tasks, bottleneck, feedback."""
        signals = {}

        # Heartbeat snapshot
        try:
            if config.HEARTBEAT_STATE_FILE.is_file():
                hb = json.loads(config.HEARTBEAT_STATE_FILE.read_text())
                signals["heartbeat"] = hb.get("last_snapshot", {})
        except (json.JSONDecodeError, OSError):
            pass

        # Pending tasks from registry
        try:
            if config.REGISTRY_JSON.is_file():
                reg = json.loads(config.REGISTRY_JSON.read_text())
                tasks = reg.get("tasks", {})
                signals["pending_tasks"] = [
                    t for t in tasks.values()
                    if t.get("status") in ("approved", "pending")
                    and t.get("assignee") == "agent"
                ]
        except (json.JSONDecodeError, OSError):
            pass

        # Bottleneck suggestions (unactioned)
        try:
            if config.BOTTLENECK_SUGGESTIONS_FILE.is_file():
                bn = json.loads(config.BOTTLENECK_SUGGESTIONS_FILE.read_text())
                signals["bottleneck_suggestions"] = [
                    s for s in bn.get("suggestions", [])
                    if s.get("status") == "pending"
                ]
        except (json.JSONDecodeError, OSError):
            pass

        return signals

    # ── Work Identification ─────────────────────────────────

    def _identify_work(self, signals: dict, cfg: dict) -> list[dict]:
        """Rule-based work identification. Returns ordered list of work items."""
        work_items = []
        auto_dispatch = cfg.get("auto_dispatch_approved", True)
        escalation_hours = cfg.get("escalation_threshold_hours", 1)
        stale_hours = cfg.get("stale_task_threshold_hours", 24)
        now = datetime.now(timezone.utc)

        # Already-dispatched task IDs (avoid double dispatch)
        active_task_ids = {
            d.get("task_id") for d in self.state.get("active_dispatches", [])
        }
        recent_task_ids = {
            c.get("task_id") for c in self.state.get("recent_completions", [])
        }
        skip_ids = active_task_ids | recent_task_ids

        # 1. Approved tasks ready for dispatch
        for task in signals.get("pending_tasks", []):
            tid = task.get("id", "")
            if tid in skip_ids:
                continue

            status = task.get("status", "")
            routing = task.get("routing", {})

            # Only auto-dispatch approved tasks (or if auto_dispatch_approved is on)
            if status == "approved" or (status == "pending" and auto_dispatch and routing.get("mode") == "execute"):
                work_items.append({
                    "id": tid,
                    "type": "task_dispatch",
                    "title": task.get("title", ""),
                    "priority": self._priority_weight(task.get("priority", "normal")),
                    "task": task,
                    "category": routing.get("type", "default"),
                    "agent_type": routing.get("agentType", ""),
                })

            # 2. High-priority tasks waiting too long → escalate
            if task.get("priority") == "high" and status == "pending":
                created = task.get("createdAt", "")
                try:
                    created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                    wait_hours = (now - created_dt).total_seconds() / 3600
                    if wait_hours > escalation_hours and tid not in skip_ids:
                        # Already added above if auto_dispatch; just log escalation
                        logger.warning(
                            "High-priority task %s waiting %.1fh (threshold: %dh)",
                            tid, wait_hours, escalation_hours,
                        )
                except (ValueError, TypeError):
                    pass

            # 3. Stale tasks notification
            if status == "pending":
                created = task.get("createdAt", "")
                try:
                    created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                    age_hours = (now - created_dt).total_seconds() / 3600
                    if age_hours > stale_hours:
                        logger.info("Stale task %s: pending for %.0fh", tid, age_hours)
                except (ValueError, TypeError):
                    pass

        # 4. Heartbeat unhealthy items persisting across cycles
        heartbeat = signals.get("heartbeat", {})
        items = heartbeat.get("items", [])
        for item in items:
            if item.get("status") == "unhealthy":
                item_id = item.get("id", "")
                # Fleet coordinator just logs these — heartbeat already handles restarts
                logger.debug("Heartbeat unhealthy: %s", item_id)

        # Sort by priority (highest first)
        work_items.sort(key=lambda w: w.get("priority", 0), reverse=True)
        return work_items

    @staticmethod
    def _priority_weight(priority: str) -> int:
        return {"critical": 4, "high": 3, "normal": 2, "low": 1}.get(priority, 2)

    # ── Work Routing & Dispatch ─────────────────────────────

    def _route_work(self, work_item: dict, cfg: dict) -> Optional[str]:
        """Match a work item to a worker ID using the routing map.

        Routing priority:
        1. Explicit agent_type from task routing
        1b. Lead worker delegation for complex tasks
        2. Category-based routing from orchestrator config
        3. Capability-based scoring from worker intent blocks
        4. Fallback to default worker
        """
        routing_map = cfg.get("routing", {})

        # 1. Try explicit agent type from task routing
        agent_type = work_item.get("agent_type", "")
        if agent_type and agent_type in self.worker_manager.workers:
            return agent_type

        # 1b. Route complex tasks to lead workers (delegation)
        delegation_cfg = cfg.get("delegation", {})
        if delegation_cfg.get("enabled"):
            task = work_item.get("task", {})
            description = task.get("description", "")
            use_lead = task.get("routing", {}).get("use_lead", False)
            # Route to lead if description is long or explicitly requested
            if use_lead or len(description) > 500:
                lead_workers = delegation_cfg.get("lead_workers", [])
                for lead_id in lead_workers:
                    if lead_id in self.worker_manager.workers:
                        available = self.worker_manager.get_available_workers()
                        if lead_id in available:
                            logger.info(
                                "Routing to lead worker %s (desc_len=%d, use_lead=%s)",
                                lead_id, len(description), use_lead,
                            )
                            return lead_id

        # 2. Try category-based routing
        category = work_item.get("category", "")
        worker_id = routing_map.get(category)
        if worker_id and worker_id in self.worker_manager.workers:
            return worker_id

        # 3. Capability-based scoring using intent blocks
        task = work_item.get("task", {})
        text = f"{work_item.get('title', '')} {task.get('title', '')} {task.get('description', '')}".lower()
        if text.strip():
            best_worker = None
            best_score = 0
            for wid, w in self.worker_manager.workers.items():
                if w.get("type") != "task":
                    continue
                intent = w.get("intent", {})
                capabilities = intent.get("capabilities", [])
                if not capabilities:
                    continue
                score = sum(1 for cap in capabilities if cap.lower() in text)
                if score > best_score:
                    best_score = score
                    best_worker = wid

            if best_worker and best_score > 0:
                logger.info(
                    "Auto-routed to %s via capability match (score=%d)",
                    best_worker, best_score,
                )
                return best_worker

        # 4. Fallback to default
        default = routing_map.get("default", "project-builder")
        if default in self.worker_manager.workers:
            return default

        return None

    async def _dispatch_work(self, work_item: dict, cfg: dict) -> Optional[str]:
        """Route and dispatch a single work item. Returns dispatch_id or None."""
        worker_id = self._route_work(work_item, cfg)
        if not worker_id:
            logger.warning(
                "No worker found for work item %s (category=%s)",
                work_item.get("id"), work_item.get("category"),
            )
            return None

        # Check worker is a task worker and available
        worker = self.worker_manager.workers.get(worker_id, {})
        if worker.get("type") != "task":
            logger.debug("Worker %s is not a task worker, skipping", worker_id)
            return None

        # Check rate limit
        guardrails = worker.get("guardrails", {})
        max_per_hour = guardrails.get("max_actions_per_hour", 0)
        if max_per_hour and not self.worker_manager.rate_limiter.check(worker_id, max_per_hour):
            logger.info("Worker %s rate limited, skipping", worker_id)
            return None

        # Check not already running
        if worker_id in self.worker_manager.task_processes:
            proc = self.worker_manager.task_processes[worker_id]
            if proc.returncode is None:
                logger.debug("Worker %s already running, skipping", worker_id)
                return None

        # Generate dispatch ID
        now = datetime.now(timezone.utc)
        dispatch_id = f"fd-{now.strftime('%Y%m%d')}-{self._cycle_count:03d}-{worker_id[:10]}"

        # Prepare workspace
        from services.workspace_manager import prepare_workspace
        task = work_item.get("task", {})
        task_context = {
            "id": task.get("id", work_item.get("id", "")),
            "title": task.get("title", work_item.get("title", "")),
            "description": task.get("description", ""),
            "priority": task.get("priority", "normal"),
            "dispatch_id": dispatch_id,
        }
        workspace = prepare_workspace(worker_id, dispatch_id, task_context)

        # Record active dispatch
        dispatch_record = {
            "dispatch_id": dispatch_id,
            "task_id": work_item.get("id", ""),
            "worker_id": worker_id,
            "started_at": now.isoformat(),
            "workspace": str(workspace),
            "title": work_item.get("title", ""),
        }
        self.state.setdefault("active_dispatches", []).append(dispatch_record)
        self.state["stats"]["dispatches_today"] = (
            self.state["stats"].get("dispatches_today", 0) + 1
        )
        self._save_state()

        # Dispatch via worker_manager (async, non-blocking)
        asyncio.create_task(
            self._run_and_track(dispatch_id, worker_id, task_context, workspace)
        )

        log_audit(
            tier="execution",
            service="fleet-coordinator",
            event="fleet_dispatch",
            summary=f"Dispatched {worker_id} for task {work_item.get('id', '')}",
            details={"dispatch_id": dispatch_id, "worker_id": worker_id},
        )

        logger.info(
            "Dispatched %s → %s (dispatch_id=%s)",
            work_item.get("id", ""), worker_id, dispatch_id,
        )
        return dispatch_id

    async def _run_and_track(
        self, dispatch_id: str, worker_id: str, task_context: dict, workspace: Path
    ):
        """Run the worker and handle completion/failure.

        Post-completion enhancements (v3.6):
        - Parse DISPATCH: lines from lead worker output → send as mail to @coordinator
        - Parse PROPOSE_TASK: lines → send as new_task mail to @coordinator
        - Auto-review pipeline: builder completions trigger project-reviewer
        - Notify parent lead worker on sub-worker completion
        """
        start_time = time.time()

        # Create or update Team Hub item → in-progress
        th_item_id = task_context.get("teamhub_item_id")
        if th_item_id:
            await self._th_update_status(th_item_id, "in-progress")
        else:
            th_item_id = await self._th_create_work_item(task_context, worker_id)

        try:
            result = await self.worker_manager.run_task_worker(
                worker_id,
                task_context=task_context,
                workspace_path=workspace,
            )
        except Exception as e:
            result = {"status": "error", "error": str(e)}

        elapsed_min = round((time.time() - start_time) / 60, 1)

        # Collect output
        from services.workspace_manager import collect_output, cleanup_workspace
        output_info = collect_output(worker_id, dispatch_id)

        # ── v3.6: Parse worker output for DISPATCH and PROPOSE_TASK lines ──
        output_text = ""
        if output_info.get("report_dir"):
            result_file = Path(output_info["report_dir"]) / "result.md"
            if result_file.is_file():
                try:
                    output_text = result_file.read_text()
                except OSError:
                    pass
        # Also try the standard output path
        if not output_text and result.get("output_path"):
            try:
                output_text = Path(result["output_path"]).read_text()
            except (OSError, TypeError):
                pass

        # Parse DISPATCH: lines from lead workers → send via mail
        if self._mail and output_text:
            dispatch_requests = self._parse_dispatch_lines(output_text, worker_id, dispatch_id)
            for dreq in dispatch_requests:
                self._mail.send(
                    from_worker=worker_id,
                    to_worker="@coordinator",
                    type="dispatch",
                    subject=dreq.get("title", "Sub-task dispatch"),
                    body=json.dumps(dreq),
                    dispatch_id=dispatch_id,
                    teamhub_item_id=th_item_id,
                )

            # Parse PROPOSE_TASK: lines → send via mail
            proposals = self._parse_task_proposals(output_text, worker_id, dispatch_id)
            for prop in proposals:
                self._mail.send(
                    from_worker=worker_id,
                    to_worker="@coordinator",
                    type="new_task",
                    subject=prop.get("title", "Proposed task"),
                    body=json.dumps(prop),
                    dispatch_id=dispatch_id,
                    teamhub_item_id=th_item_id,
                )

        # Remove from active dispatches
        self.state["active_dispatches"] = [
            d for d in self.state.get("active_dispatches", [])
            if d.get("dispatch_id") != dispatch_id
        ]

        # Extract evaluation from worker result
        evaluation = result.get("evaluation", {})

        # Record completion
        completion = {
            "dispatch_id": dispatch_id,
            "task_id": task_context.get("id", ""),
            "worker_id": worker_id,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "status": result.get("status", "unknown"),
            "elapsed_min": elapsed_min,
            "output_summary": output_info.get("summary", "")[:200],
            "report_dir": output_info.get("report_dir", ""),
            "evaluation": evaluation,
        }
        completions = self.state.setdefault("recent_completions", [])
        completions.insert(0, completion)
        self.state["recent_completions"] = completions[:100]  # Keep last 100

        # Determine final task status — failed evaluation → "review" instead of "completed"
        if result.get("status") == "completed" and evaluation and not evaluation.get("passed", True):
            final_status = "review"
        elif result.get("status") == "completed":
            final_status = "completed"
        else:
            final_status = "failed"

        # ── v3.6: Auto-review pipeline ──
        cfg = config.load_orchestrator_config().get("fleet_coordinator", {})
        review_cfg = cfg.get("review_pipeline", {})
        if (
            review_cfg.get("enabled")
            and final_status == "completed"
            and evaluation.get("passed", True)
            and worker_id in review_cfg.get("auto_review_workers", [])
        ):
            review_result = await self._dispatch_auto_review(
                dispatch_id, worker_id, task_context, workspace,
                output_info, elapsed_min, review_cfg,
            )
            if review_result is not None:
                final_status = review_result  # "completed" or "review"

        # Update stats
        if final_status in ("completed", "review"):
            self.state["stats"]["completions_today"] = (
                self.state["stats"].get("completions_today", 0) + 1
            )
            # Update rolling average
            prev_avg = self.state["stats"].get("avg_completion_min", 0)
            prev_count = self.state["stats"].get("completions_today", 1)
            self.state["stats"]["avg_completion_min"] = round(
                (prev_avg * (prev_count - 1) + elapsed_min) / prev_count, 1
            )
        else:
            self.state["stats"]["failures_today"] = (
                self.state["stats"].get("failures_today", 0) + 1
            )

        self._save_state()

        # Update task status in registry
        self._update_task_status(task_context.get("id", ""), final_status)

        # Cleanup workspace (keep output)
        cleanup_workspace(worker_id, dispatch_id, keep_output=True)

        # Update DEV.md if this dispatch is tied to a project
        self._update_dev_md(task_context, worker_id, final_status, elapsed_min)

        # Send notification for completions/failures
        try:
            from background.notifier import send_telegram
            if evaluation:
                eval_tag = "[PASS]" if evaluation.get("passed", True) else f"[FAIL: {', '.join(evaluation.get('reasons', [])[:2])}]"
            else:
                eval_tag = ""
            status_emoji = "done" if final_status == "completed" else ("REVIEW" if final_status == "review" else "FAILED")
            msg = (
                f"Fleet [{status_emoji}]: {worker_id} finished "
                f"'{task_context.get('title', '')[:60]}' "
                f"in {elapsed_min}min {eval_tag}"
            )
            await send_telegram(msg)
        except Exception:
            pass  # Notifications are best-effort

        # Check personal notification watches
        try:
            from background.notifier import check_and_fire_personal_notifications
            check_and_fire_personal_notifications(
                task_id=task_context.get("id", ""),
                teamhub_item_id=th_item_id or "",
                status=final_status,
                title=task_context.get("title", ""),
                worker=worker_id,
                duration=f"{elapsed_min}min",
                summary=output_info.get("summary", "")[:300],
            )
        except Exception:
            pass  # Non-critical

        # Update Team Hub item with completion status
        if th_item_id:
            th_status = "done" if final_status == "completed" else ("review" if final_status == "review" else "failed")
            await self._th_update_status(th_item_id, th_status)
            summary = output_info.get("summary", "")[:500] or f"Completed in {elapsed_min}min"
            await self._th_add_comment(
                th_item_id,
                f"**{result.get('status', 'unknown').upper()}** ({elapsed_min}min)\n\n{summary}",
                author=worker_id,
            )

        # ── v3.6: Notify parent lead worker via mail on sub-worker completion ──
        parent_worker = task_context.get("parent_worker")
        if parent_worker and self._mail:
            self._mail.send(
                from_worker=worker_id,
                to_worker=parent_worker,
                type="worker_done",
                subject=f"Sub-task completed: {task_context.get('title', '')[:60]}",
                body=f"Status: {final_status}, Elapsed: {elapsed_min}min\n"
                     f"Summary: {output_info.get('summary', '')[:300]}",
                dispatch_id=dispatch_id,
                teamhub_item_id=th_item_id,
            )

        logger.info(
            "Fleet dispatch %s completed: %s (%.1f min)",
            dispatch_id, result.get("status"), elapsed_min,
        )

    def _update_dev_md(self, task_context: dict, worker_id: str, status: str, elapsed_min: float):
        """Update DEV.md in a project directory after fleet dispatch completion.

        Appends build history entry and done item using structured comment markers.
        No AI cost — pure regex replacement.
        """
        project_path = task_context.get("project") or task_context.get("project_path", "")
        if not project_path:
            # Try to extract from sourceRef
            source_ref = task_context.get("sourceRef", "")
            if isinstance(source_ref, str) and "Projects/" in source_ref:
                project_path = source_ref
            elif isinstance(source_ref, dict):
                project_path = source_ref.get("project_path", "")

        if not project_path:
            return

        # Normalize path
        if not project_path.startswith("/"):
            dev_md_path = config.OPAI_ROOT / project_path / "DEV.md"
        else:
            dev_md_path = Path(project_path) / "DEV.md"

        if not dev_md_path.is_file():
            return

        try:
            content = dev_md_path.read_text()
            now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
            task_title = task_context.get("title", "Fleet task")[:80]

            # Append to build history
            history_entry = f"| {now} | {worker_id} | {status} | {task_title} ({elapsed_min}min) |"
            content = content.replace(
                "<!-- HISTORY_END -->",
                f"{history_entry}\n<!-- HISTORY_END -->",
            )

            # Append to done section if completed
            if status in ("completed", "review"):
                done_entry = f"- [{now}] {task_title} (by {worker_id})"
                content = content.replace(
                    "<!-- DONE_END -->",
                    f"{done_entry}\n<!-- DONE_END -->",
                )

            # Update active agents table — remove this worker
            # (Simple approach: clear "—" placeholder rows aren't tracked individually)

            dev_md_path.write_text(content)
            logger.info("Updated DEV.md for %s: %s", project_path, status)
        except Exception as e:
            logger.warning("Failed to update DEV.md at %s: %s", dev_md_path, e)

    def _update_task_status(self, task_id: str, status: str):
        """Update task status in the registry."""
        if not task_id:
            return
        try:
            if not config.REGISTRY_JSON.is_file():
                return
            reg = json.loads(config.REGISTRY_JSON.read_text())
            tasks = reg.get("tasks", {})
            if task_id in tasks:
                tasks[task_id]["status"] = status
                tasks[task_id]["updatedAt"] = datetime.now(timezone.utc).isoformat()
                if status == "completed":
                    tasks[task_id]["completedAt"] = datetime.now(timezone.utc).isoformat()
                config.REGISTRY_JSON.write_text(json.dumps(reg, indent=2, default=str))
        except Exception as e:
            logger.error("Failed to update task %s status: %s", task_id, e)

    # ── Active Dispatch Monitoring ──────────────────────────

    async def _check_active(self):
        """Check active dispatches — detect stuck or zombie processes."""
        now = datetime.now(timezone.utc)
        stale = []

        for dispatch in self.state.get("active_dispatches", []):
            started = dispatch.get("started_at", "")
            try:
                started_dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                continue

            # Check if dispatch has been running too long (>30 min = likely stuck)
            elapsed = (now - started_dt).total_seconds()
            if elapsed > 1800:
                worker_id = dispatch.get("worker_id", "")
                # Check if process is actually still running
                if worker_id in self.worker_manager.task_processes:
                    proc = self.worker_manager.task_processes[worker_id]
                    if proc.returncode is not None:
                        # Process finished but dispatch not cleaned up
                        stale.append(dispatch)
                else:
                    # Process not tracked anymore — dispatch is orphaned
                    stale.append(dispatch)

        # Clean up stale dispatches
        for dispatch in stale:
            dispatch_id = dispatch.get("dispatch_id", "")
            logger.warning("Cleaning up stale dispatch: %s", dispatch_id)
            self.state["active_dispatches"] = [
                d for d in self.state["active_dispatches"]
                if d.get("dispatch_id") != dispatch_id
            ]
            self.state["stats"]["failures_today"] = (
                self.state["stats"].get("failures_today", 0) + 1
            )

        if stale:
            self._save_state()

    # ── Dispatch Line Parsing (Lead Worker Output) ──────────

    @staticmethod
    def _parse_dispatch_lines(output: str, worker_id: str, dispatch_id: str) -> list[dict]:
        """Parse DISPATCH: lines from lead worker output.

        Format: DISPATCH: worker=project-builder title="Implement X" description="..." priority=normal
        Returns list of dispatch request dicts.
        """
        results = []
        for line in output.splitlines():
            line = line.strip()
            if not line.startswith("DISPATCH:"):
                continue
            payload = line[len("DISPATCH:"):].strip()
            kvs = {m.group(1): (m.group(2) if m.group(2) is not None else m.group(3)) for m in _KV_RE.finditer(payload)}
            if kvs.get("worker") and kvs.get("title"):
                kvs["parent_worker"] = worker_id
                kvs["parent_dispatch_id"] = dispatch_id
                results.append(kvs)
        return results

    @staticmethod
    def _parse_task_proposals(output: str, worker_id: str, dispatch_id: str) -> list[dict]:
        """Parse PROPOSE_TASK: lines from worker output.

        Format: PROPOSE_TASK: title="Fix auth bug" reason="Found during review" priority=normal
        Returns list of proposal dicts.
        """
        results = []
        for line in output.splitlines():
            line = line.strip()
            if not line.startswith("PROPOSE_TASK:"):
                continue
            payload = line[len("PROPOSE_TASK:"):].strip()
            kvs = {m.group(1): (m.group(2) if m.group(2) is not None else m.group(3)) for m in _KV_RE.finditer(payload)}
            if kvs.get("title"):
                kvs["proposed_by"] = worker_id
                kvs["source_dispatch_id"] = dispatch_id
                results.append(kvs)
        return results

    # ── Dispatch Mail Polling (Lead Worker Requests) ──────

    async def _poll_dispatch_mail(self, cfg: dict):
        """Poll @coordinator inbox for dispatch requests from lead workers.

        Verifies sender has delegation_capable guardrail and respects
        max_delegation_depth before dispatching sub-workers.
        """
        if not self._mail:
            return

        delegation_cfg = cfg.get("delegation", {})
        if not delegation_cfg.get("enabled"):
            return

        max_depth = delegation_cfg.get("max_delegation_depth", 2)

        messages = self._mail.check_inbox("@coordinator", unread_only=True, types=["dispatch"])
        for msg in messages:
            self._mail.read_message(msg["id"])  # Mark as read

            sender = msg.get("from_worker", "")
            sender_worker = self.worker_manager.workers.get(sender, {})
            if not sender_worker.get("guardrails", {}).get("delegation_capable"):
                logger.warning(
                    "Dispatch request from non-delegating worker %s — rejected", sender,
                )
                if self._mail:
                    self._mail.send(
                        from_worker="@coordinator",
                        to_worker=sender,
                        type="error",
                        subject="Dispatch rejected: not delegation_capable",
                        body="Your worker config does not have delegation_capable=true.",
                        thread_id=msg["id"],
                    )
                continue

            # Parse dispatch request from body (JSON)
            try:
                req = json.loads(msg.get("body", "{}"))
            except json.JSONDecodeError:
                logger.warning("Invalid dispatch request body from %s", sender)
                continue

            # Check delegation depth
            depth = req.get("_delegation_depth", 1)
            if depth >= max_depth:
                logger.warning(
                    "Dispatch from %s rejected: delegation depth %d >= max %d",
                    sender, depth, max_depth,
                )
                if self._mail:
                    self._mail.send(
                        from_worker="@coordinator",
                        to_worker=sender,
                        type="error",
                        subject="Dispatch rejected: max delegation depth exceeded",
                        body=f"Current depth {depth} >= max {max_depth}.",
                        thread_id=msg["id"],
                    )
                continue

            target_worker = req.get("worker", "")
            if target_worker not in self.worker_manager.workers:
                logger.warning("Dispatch target %s not found", target_worker)
                continue

            # Build work item for dispatch
            work_item = {
                "id": f"mail-{msg['id']}",
                "type": "task_dispatch",
                "title": req.get("title", msg.get("subject", "")),
                "priority": self._priority_weight(req.get("priority", "normal")),
                "task": {
                    "title": req.get("title", ""),
                    "description": req.get("description", ""),
                    "priority": req.get("priority", "normal"),
                    "parent_worker": sender,
                    "parent_dispatch_id": req.get("parent_dispatch_id", msg.get("dispatch_id", "")),
                    "_delegation_depth": depth + 1,
                },
                "category": "default",
                "agent_type": target_worker,
            }

            dispatch_id = await self._dispatch_work(work_item, cfg)
            if dispatch_id:
                self._mail.send(
                    from_worker="@coordinator",
                    to_worker=sender,
                    type="status",
                    subject=f"Dispatched: {req.get('title', '')[:50]}",
                    body=f"Sub-worker {target_worker} dispatched (dispatch_id={dispatch_id})",
                    thread_id=msg["id"],
                )
                logger.info(
                    "Mail dispatch: %s requested %s → dispatched (id=%s)",
                    sender, target_worker, dispatch_id,
                )

    # ── Auto-Review Pipeline ──────────────────────────────

    async def _dispatch_auto_review(
        self,
        dispatch_id: str,
        builder_id: str,
        task_context: dict,
        workspace: Path,
        output_info: dict,
        builder_elapsed: float,
        review_cfg: dict,
    ) -> Optional[str]:
        """Auto-dispatch reviewer after builder completes successfully.

        Returns final_status override: "completed" if review passes,
        "review" if review fails (needs HITL). Returns None if review
        couldn't be dispatched.
        """
        reviewer_id = review_cfg.get("reviewer_worker", "project-reviewer")
        if reviewer_id not in self.worker_manager.workers:
            logger.warning("Auto-review: reviewer %s not found", reviewer_id)
            return None

        # Write builder output into workspace for reviewer to read
        try:
            context_dir = workspace / "context"
            context_dir.mkdir(parents=True, exist_ok=True)
            summary = output_info.get("summary", "")[:2000] or "No summary available"
            (context_dir / "builder-output.md").write_text(
                f"# Builder Output ({builder_id})\n\n"
                f"Dispatch: {dispatch_id}\n"
                f"Elapsed: {builder_elapsed}min\n\n"
                f"## Summary\n{summary}\n"
            )
        except OSError as e:
            logger.warning("Auto-review: failed to write builder output: %s", e)
            return None

        # Build review context
        review_context = {
            **task_context,
            "review_mode": "auto-review",
            "builder_worker": builder_id,
            "builder_dispatch_id": dispatch_id,
            "builder_elapsed_min": builder_elapsed,
        }

        logger.info(
            "Auto-review: dispatching %s to review %s output (dispatch=%s)",
            reviewer_id, builder_id, dispatch_id,
        )

        try:
            review_result = await self.worker_manager.run_task_worker(
                reviewer_id,
                task_context=review_context,
                workspace_path=workspace,
            )
        except Exception as e:
            logger.error("Auto-review failed: %s", e)
            return None

        review_eval = review_result.get("evaluation", {})
        review_passed = review_eval.get("passed", False)

        # Send combined notification
        try:
            from background.notifier import send_telegram
            tag = "[BUILD+REVIEW PASS]" if review_passed else "[BUILD+REVIEW FAIL]"
            await send_telegram(
                f"Fleet {tag}: {builder_id} + {reviewer_id} for "
                f"'{task_context.get('title', '')[:50]}'"
            )
        except Exception:
            pass

        # Send worker_done mail with combined results
        if self._mail:
            self._mail.send(
                from_worker=reviewer_id,
                to_worker=builder_id,
                type="worker_done",
                subject=f"Review {'passed' if review_passed else 'failed'}: {task_context.get('title', '')[:50]}",
                body=f"Review evaluation: {json.dumps(review_eval)}",
                dispatch_id=dispatch_id,
            )

        return "completed" if review_passed else "review"

    # ── Task Proposal Processing ──────────────────────────

    async def _process_task_proposals(self):
        """Process new_task proposals from worker mail.

        Creates registry entries with status 'proposed' (human gate).
        Sends Telegram notification with approve/dismiss buttons.
        """
        if not self._mail:
            return

        messages = self._mail.check_inbox("@coordinator", unread_only=True, types=["new_task"])
        for msg in messages:
            self._mail.read_message(msg["id"])  # Mark as read

            try:
                proposal = json.loads(msg.get("body", "{}"))
            except json.JSONDecodeError:
                continue

            title = proposal.get("title", msg.get("subject", "Proposed task"))
            reason = proposal.get("reason", "")
            priority = proposal.get("priority", "normal")
            proposed_by = proposal.get("proposed_by", msg.get("from_worker", "unknown"))

            # Create registry entry with "proposed" status
            task_id = f"prop-{int(time.time())}-{proposed_by[:8]}"
            new_task = {
                "id": task_id,
                "title": f"[Proposed] {title}",
                "description": f"Proposed by {proposed_by}: {reason}",
                "status": "proposed",
                "priority": priority,
                "assignee": "agent",
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "source": f"worker-proposal:{proposed_by}",
                "routing": {"mode": "execute", "type": "default"},
            }

            try:
                if config.REGISTRY_JSON.is_file():
                    reg = json.loads(config.REGISTRY_JSON.read_text())
                else:
                    reg = {"tasks": {}}
                reg.setdefault("tasks", {})[task_id] = new_task
                config.REGISTRY_JSON.write_text(json.dumps(reg, indent=2, default=str))
            except Exception as e:
                logger.error("Failed to create proposed task %s: %s", task_id, e)
                continue

            # Create Team Hub item for visibility
            th_item_id = await self._th_create_work_item(
                {"title": f"[Proposed] {title}", "description": reason, "priority": priority},
                proposed_by,
            )

            # Send Telegram notification with approve/dismiss buttons
            try:
                from background.notifier import send_telegram_with_buttons
                await send_telegram_with_buttons(
                    f"*Task Proposed* by `{proposed_by}`\n\n"
                    f"*{title}*\n{reason[:200]}",
                    buttons=[[
                        {"text": "Approve", "callback_data": f"task_approve:{task_id}"},
                        {"text": "Dismiss", "callback_data": f"task_dismiss:{task_id}"},
                    ]],
                )
            except Exception:
                pass

            # Confirm back to proposing worker
            self._mail.send(
                from_worker="@coordinator",
                to_worker=proposed_by,
                type="status",
                subject=f"Proposal received: {title[:50]}",
                body=f"Task {task_id} created with status 'proposed'. Awaiting human approval.",
                thread_id=msg["id"],
            )

            logger.info(
                "Task proposal from %s: %s (id=%s)", proposed_by, title, task_id,
            )

    # ── Team Hub Integration ─────────────────────────────────

    async def _th_update_status(self, teamhub_item_id: str, status: str):
        """Update a Team Hub item status. Best-effort, non-blocking."""
        if not teamhub_item_id:
            return
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{config.TEAMHUB_INTERNAL}/update-item",
                    params={"item_id": teamhub_item_id, "status": status},
                )
        except Exception as e:
            logger.debug("TH status update failed: %s", e)

    async def _th_add_comment(self, teamhub_item_id: str, content: str, author: str = "system"):
        """Add a comment to a Team Hub item. Best-effort."""
        if not teamhub_item_id:
            return
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(
                    f"{config.TEAMHUB_INTERNAL}/add-comment",
                    params={
                        "item_id": teamhub_item_id,
                        "content": content,
                        "author_id": author,
                    },
                )
        except Exception as e:
            logger.debug("TH comment failed: %s", e)

    async def _th_create_work_item(self, task_context: dict, worker_id: str) -> str | None:
        """Create a Team Hub item for a dispatched task. Returns item ID or None."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.post(
                    f"{config.TEAMHUB_INTERNAL}/create-item",
                    params={
                        "workspace_id": config.WORKERS_WORKSPACE_ID,
                        "user_id": config.SYSTEM_USER_ID,
                        "type": "task",
                        "title": task_context.get("title", "Dispatched task"),
                        "description": task_context.get("description", ""),
                        "priority": task_context.get("priority", "normal"),
                        "status": "in-progress",
                        "list_id": config.ACTIVE_WORK_LIST_ID,
                        "source": "fleet-coordinator",
                        "assignee_id": worker_id,
                    },
                )
                if r.status_code < 400:
                    item = r.json()
                    return item.get("id")
        except Exception as e:
            logger.debug("TH create work item failed: %s", e)
        return None

    # ── Public API Methods ──────────────────────────────────

    def get_status(self) -> dict:
        """Return fleet state for the API."""
        return {
            "active_dispatches": self.state.get("active_dispatches", []),
            "queue_depth": self.state.get("queue_depth", 0),
            "last_cycle": self.state.get("last_cycle"),
            "cycle_count": self._cycle_count,
            "stats": self.state.get("stats", {}),
        }

    def get_history(self, limit: int = 50) -> list[dict]:
        """Return recent dispatch history."""
        return self.state.get("recent_completions", [])[:limit]

    async def manual_dispatch(self, task_id: str, worker_id: str | None = None) -> dict:
        """Manually dispatch a task to a specific (or auto-routed) worker."""
        # Load the task
        try:
            reg = json.loads(config.REGISTRY_JSON.read_text())
            task = reg.get("tasks", {}).get(task_id)
        except (json.JSONDecodeError, OSError):
            return {"success": False, "error": "Cannot read task registry"}

        if not task:
            return {"success": False, "error": f"Task {task_id} not found"}

        cfg = config.load_orchestrator_config().get("fleet_coordinator", {})

        work_item = {
            "id": task_id,
            "type": "task_dispatch",
            "title": task.get("title", ""),
            "priority": self._priority_weight(task.get("priority", "normal")),
            "task": task,
            "category": task.get("routing", {}).get("type", "default"),
            "agent_type": worker_id or task.get("routing", {}).get("agentType", ""),
        }

        # Override routing if worker_id specified
        if worker_id:
            work_item["agent_type"] = worker_id

        # Resolve the routed worker before dispatch (for response)
        routed_worker = self._route_work(work_item, cfg)

        dispatch_id = await self._dispatch_work(work_item, cfg)
        if dispatch_id:
            return {
                "success": True,
                "dispatch_id": dispatch_id,
                "worker_id": routed_worker,
                "auto_routed": worker_id is None,
            }
        return {"success": False, "error": "Dispatch failed — check worker availability"}

    async def cancel_dispatch(self, dispatch_id: str) -> dict:
        """Cancel an active dispatch."""
        dispatch = None
        for d in self.state.get("active_dispatches", []):
            if d.get("dispatch_id") == dispatch_id:
                dispatch = d
                break

        if not dispatch:
            return {"success": False, "error": f"Dispatch {dispatch_id} not found"}

        worker_id = dispatch.get("worker_id", "")

        # Kill the worker process if running
        if worker_id in self.worker_manager.task_processes:
            proc = self.worker_manager.task_processes[worker_id]
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                self.worker_manager.task_processes.pop(worker_id, None)

        # Remove from active dispatches
        self.state["active_dispatches"] = [
            d for d in self.state["active_dispatches"]
            if d.get("dispatch_id") != dispatch_id
        ]
        self._save_state()

        logger.info("Cancelled dispatch %s (worker: %s)", dispatch_id, worker_id)
        return {"success": True, "dispatch_id": dispatch_id}
