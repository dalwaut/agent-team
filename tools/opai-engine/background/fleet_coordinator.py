"""OPAI Engine — Fleet Coordinator (v3.5).

Background loop that identifies actionable work, routes it to the right
worker, and tracks fleet activity. This is the "manager brain" that reads
heartbeat + tasks + health signals and orchestrates the workforce.

Loop interval: every fleet_coordinator.interval_minutes (default 5 min).

Work identification is rule-based (not AI). Routing uses the configurable
routing map in orchestrator.json fleet_coordinator.routing.

State persists in data/fleet-state.json across restarts.
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import config
from audit import log_audit

logger = logging.getLogger("opai-engine.fleet-coordinator")


class FleetCoordinator:
    """Fleet coordinator — identifies work, dispatches workers, tracks results."""

    def __init__(self, worker_manager, scheduler):
        self.worker_manager = worker_manager
        self.scheduler = scheduler
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
                signals["heartbeat"] = hb.get("latest_snapshot", {})
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
        """Match a work item to a worker ID using the routing map."""
        routing_map = cfg.get("routing", {})

        # Try explicit agent type from task routing
        agent_type = work_item.get("agent_type", "")
        if agent_type and agent_type in self.worker_manager.workers:
            return agent_type

        # Try category-based routing
        category = work_item.get("category", "")
        worker_id = routing_map.get(category)
        if worker_id and worker_id in self.worker_manager.workers:
            return worker_id

        # Fallback to default
        default = routing_map.get("default", "self-assessor")
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
            "fleet_dispatch",
            detail=f"Dispatched {worker_id} for task {work_item.get('id', '')}",
            extra={"dispatch_id": dispatch_id, "worker_id": worker_id},
        )

        logger.info(
            "Dispatched %s → %s (dispatch_id=%s)",
            work_item.get("id", ""), worker_id, dispatch_id,
        )
        return dispatch_id

    async def _run_and_track(
        self, dispatch_id: str, worker_id: str, task_context: dict, workspace: Path
    ):
        """Run the worker and handle completion/failure."""
        start_time = time.time()

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

        # Remove from active dispatches
        self.state["active_dispatches"] = [
            d for d in self.state.get("active_dispatches", [])
            if d.get("dispatch_id") != dispatch_id
        ]

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
        }
        completions = self.state.setdefault("recent_completions", [])
        completions.insert(0, completion)
        self.state["recent_completions"] = completions[:100]  # Keep last 100

        # Update stats
        if result.get("status") == "completed":
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
        self._update_task_status(
            task_context.get("id", ""),
            "completed" if result.get("status") == "completed" else "failed",
        )

        # Cleanup workspace (keep output)
        cleanup_workspace(worker_id, dispatch_id, keep_output=True)

        # Send notification for completions/failures
        try:
            from background.notifier import send_telegram
            status_emoji = "done" if result.get("status") == "completed" else "FAILED"
            msg = (
                f"Fleet [{status_emoji}]: {worker_id} finished "
                f"'{task_context.get('title', '')[:60]}' "
                f"in {elapsed_min}min"
            )
            await send_telegram(msg)
        except Exception:
            pass  # Notifications are best-effort

        logger.info(
            "Fleet dispatch %s completed: %s (%.1f min)",
            dispatch_id, result.get("status"), elapsed_min,
        )

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

        dispatch_id = await self._dispatch_work(work_item, cfg)
        if dispatch_id:
            return {"success": True, "dispatch_id": dispatch_id}
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
