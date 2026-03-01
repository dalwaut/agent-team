"""OPAI Engine — Proactive Heartbeat (v3 Phase 3.0).

Background loop that aggregates work items from scheduler, worker manager,
task registry, and resource monitor. Detects changes, handles stalls,
and sends Telegram notifications.

Pure aggregation layer — reads from existing tracking systems without
modifying them (except restart_worker for stall recovery).
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import config
from audit import log_audit
from background.notifier import notify_changes
from background.resource_monitor import get_resource_state

logger = logging.getLogger("opai-engine.heartbeat")


class Heartbeat:
    """Proactive heartbeat — aggregates, detects, notifies."""

    def __init__(self, scheduler, worker_manager):
        self.scheduler = scheduler
        self.worker_manager = worker_manager
        self._state_file = config.HEARTBEAT_STATE_FILE
        self._previous_snapshot: dict | None = None
        self._cycle_count = 0
        self._daily_note_sent_date: str | None = None
        self._consolidation_run_date: str | None = None
        self._consecutive_unhealthy: dict[str, int] = {}
        self._consolidator = None  # Set by app.py after init
        self._load_state()

    # ── Main Loop ─────────────────────────────────────────────

    async def loop(self):
        """Main heartbeat loop — runs every interval_minutes."""
        logger.info("Heartbeat loop started")
        await asyncio.sleep(10)  # Initial delay for startup

        while True:
            try:
                await self._cycle()
            except Exception as e:
                logger.error("Heartbeat cycle error: %s", e)
            interval = self._get_interval_seconds()
            await asyncio.sleep(interval)

    async def _cycle(self):
        """Execute one heartbeat cycle."""
        start = time.time()
        self._cycle_count += 1

        # Build current snapshot
        snapshot = self._build_snapshot()

        # Detect changes vs previous snapshot
        changes = self._detect_changes(snapshot)

        # Handle stalls (auto-restart managed workers)
        stall_changes = await self._handle_stalls(snapshot)
        changes.extend(stall_changes)

        # Attach changes to snapshot
        snapshot["changes"] = changes
        snapshot["cycle_number"] = self._cycle_count

        # Send notifications if there are changes
        if changes:
            try:
                await notify_changes(changes, snapshot.get("summary", {}))
            except Exception as e:
                logger.warning("Notification failed: %s", e)

        # Check if daily note should be generated
        await self._check_daily_note(snapshot)

        # Check if memory consolidation should run
        await self._check_consolidation(snapshot)

        # Save state
        self._previous_snapshot = snapshot
        self._save_state()

        duration_ms = int((time.time() - start) * 1000)
        logger.info(
            "Heartbeat cycle %d: %d items, %d changes, %dms",
            self._cycle_count,
            snapshot.get("summary", {}).get("total", 0),
            len(changes),
            duration_ms,
        )

        log_audit(
            tier="health",
            service="opai-engine",
            event="heartbeat:cycle",
            status="completed",
            summary=(
                f"Heartbeat #{self._cycle_count} — "
                f"{snapshot['summary']['total']} items, "
                f"{len(changes)} changes"
            ),
            duration_ms=duration_ms,
            details={
                "cycle": self._cycle_count,
                "changes_count": len(changes),
                "summary": snapshot.get("summary", {}),
            },
        )

    # ── Snapshot Building ─────────────────────────────────────

    def _build_snapshot(self) -> dict:
        """Aggregate work items from all tracking systems."""
        now = datetime.now(timezone.utc).isoformat()
        work_items = {}
        total = 0
        healthy = 0
        running_tasks = 0
        active_sessions = 0

        # 1. Worker manager status
        worker_status = self.worker_manager.get_status()
        for wid, ws in worker_status.items():
            item = {
                "source": "worker",
                "status": "healthy" if ws.get("healthy") else (
                    "unhealthy" if ws.get("healthy") is False else "unknown"
                ),
                "managed": ws.get("managed", False),
                "running": ws.get("running"),
                "pid": ws.get("pid"),
                "restarts": ws.get("restarts", 0),
                "type": ws.get("type"),
            }
            # Add uptime for managed workers
            detail = self.worker_manager.get_worker_detail(wid)
            if detail and detail.get("uptime_seconds"):
                item["uptime_sec"] = detail["uptime_seconds"]

            work_items[f"worker:{wid}"] = item
            total += 1
            if ws.get("healthy"):
                healthy += 1

        # 2. Scheduler active jobs
        for job_id, job in self.scheduler.active_jobs.items():
            work_items[f"scheduler:{job_id}"] = {
                "source": "scheduler",
                "status": "running",
                "type": job.get("type"),
                "started_at": job.get("startTime"),
            }
            total += 1

        # 3. Task registry
        try:
            if config.REGISTRY_JSON.is_file():
                registry = json.loads(config.REGISTRY_JSON.read_text())
                tasks = registry.get("tasks", {})
                for tid, task in tasks.items():
                    status = task.get("status", "unknown")
                    if status in ("completed", "cancelled", "archived"):
                        continue  # Skip finished tasks
                    work_items[f"task:{tid}"] = {
                        "source": "task_registry",
                        "status": status,
                        "title": task.get("title", ""),
                        "assignee": task.get("assignee", ""),
                        "started_at": task.get("updatedAt"),
                        "priority": task.get("priority", "normal"),
                    }
                    total += 1
                    if status == "running":
                        running_tasks += 1
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to read task registry: %s", e)

        # 4. Claude sessions (lightweight)
        try:
            from services.session_collector import get_concurrency_snapshot
            snap = get_concurrency_snapshot()
            active_sessions = snap.get("active", 0)
            for proc in snap.get("processes", []):
                work_items[f"session:{proc['pid']}"] = {
                    "source": "claude_session",
                    "type": proc.get("type", "unknown"),
                    "pid": proc["pid"],
                    "uptime_sec": proc.get("uptime_seconds", 0),
                }
                total += 1
        except Exception as e:
            logger.debug("Session snapshot unavailable: %s", e)

        # 5. Resource state
        res = get_resource_state()
        cpu = res.get("cpu", 0)
        memory = res.get("memory", 0)

        summary = {
            "total": total,
            "healthy": healthy,
            "running_tasks": running_tasks,
            "completed_since_last": 0,  # Filled by _detect_changes
            "failed_since_last": 0,
            "stalled": 0,
            "active_sessions": active_sessions,
            "cpu": round(cpu, 1),
            "memory": round(memory, 1),
        }

        return {
            "snapshot_at": now,
            "cycle_number": self._cycle_count,
            "work_items": work_items,
            "summary": summary,
            "changes": [],
        }

    # ── Change Detection ──────────────────────────────────────

    def _detect_changes(self, current: dict) -> list[dict]:
        """Diff current vs previous snapshot to find completions, failures, stalls."""
        changes = []
        if not self._previous_snapshot:
            return changes

        prev_items = self._previous_snapshot.get("work_items", {})
        curr_items = current.get("work_items", {})
        summary = current.get("summary", {})
        completed_count = 0
        failed_count = 0

        # Items that were in previous but not in current = completed or removed
        for key, prev in prev_items.items():
            if key not in curr_items:
                source = prev.get("source")
                prev_status = prev.get("status")

                if source == "scheduler" and prev_status == "running":
                    # Scheduler job finished
                    changes.append({
                        "type": "completed",
                        "item": key,
                        "title": prev.get("type", key),
                        "duration": self._format_duration(prev.get("started_at")),
                    })
                    completed_count += 1
                elif source == "task_registry" and prev_status == "running":
                    changes.append({
                        "type": "completed",
                        "item": key,
                        "title": prev.get("title", key),
                    })
                    completed_count += 1

        # Items whose status changed
        for key, curr in curr_items.items():
            prev = prev_items.get(key)
            if not prev:
                continue

            # Worker went from healthy to unhealthy
            if curr.get("source") == "worker":
                if prev.get("status") == "healthy" and curr.get("status") == "unhealthy":
                    changes.append({
                        "type": "failed",
                        "item": key,
                        "title": key.replace("worker:", ""),
                    })
                    failed_count += 1

            # Task status changed to failed
            if curr.get("source") == "task_registry":
                if prev.get("status") != "failed" and curr.get("status") == "failed":
                    changes.append({
                        "type": "failed",
                        "item": key,
                        "title": curr.get("title", key),
                    })
                    failed_count += 1

        summary["completed_since_last"] = completed_count
        summary["failed_since_last"] = failed_count

        return changes

    # ── Stall Detection & Recovery ────────────────────────────

    async def _handle_stalls(self, snapshot: dict) -> list[dict]:
        """Detect and handle stalled work items."""
        changes = []
        now = time.time()
        orch = config.load_orchestrator_config()
        hb_cfg = orch.get("heartbeat", {})
        stall_minutes = hb_cfg.get("stall_threshold_minutes", 60)

        work_items = snapshot.get("work_items", {})

        for key, item in work_items.items():
            source = item.get("source")

            # Managed workers: unhealthy for 2+ consecutive snapshots
            if source == "worker" and item.get("status") == "unhealthy":
                self._consecutive_unhealthy[key] = (
                    self._consecutive_unhealthy.get(key, 0) + 1
                )

                if self._consecutive_unhealthy[key] >= 2:
                    worker_id = key.replace("worker:", "")
                    w = self.worker_manager.workers.get(worker_id)

                    if w and w.get("managed") and w.get("restart_on_failure"):
                        max_restarts = w.get("max_restarts", 5)
                        current_restarts = self.worker_manager.restart_counts.get(
                            worker_id, 0
                        )
                        if current_restarts < max_restarts:
                            logger.warning(
                                "Heartbeat stall recovery: restarting %s "
                                "(unhealthy for %d cycles)",
                                worker_id,
                                self._consecutive_unhealthy[key],
                            )
                            result = self.worker_manager.restart_worker(worker_id)
                            action = (
                                f"Auto-restarted (attempt {current_restarts + 1}/{max_restarts})"
                                if result.get("success")
                                else f"Restart failed: {result.get('error', 'unknown')}"
                            )
                            changes.append({
                                "type": "restarted" if result.get("success") else "stall_detected",
                                "item": key,
                                "title": worker_id,
                                "action": action,
                            })
                            self._consecutive_unhealthy[key] = 0

                            log_audit(
                                tier="health",
                                service="opai-engine",
                                event="heartbeat:restart",
                                status="completed" if result.get("success") else "failed",
                                summary=f"Heartbeat auto-restart: {worker_id} — {action}",
                                details={"worker_id": worker_id, "result": result},
                            )
                        else:
                            changes.append({
                                "type": "stall_detected",
                                "item": key,
                                "title": worker_id,
                                "action": f"Max restarts ({max_restarts}) reached — needs manual intervention",
                            })

                            log_audit(
                                tier="health",
                                service="opai-engine",
                                event="heartbeat:stall",
                                status="failed",
                                summary=f"Stall: {worker_id} — max restarts reached",
                            )
                    else:
                        # Non-managed or no auto-restart — just log
                        if self._consecutive_unhealthy[key] == 2:
                            changes.append({
                                "type": "stall_detected",
                                "item": key,
                                "title": worker_id,
                                "action": "Logged for manual review (not auto-restartable)",
                            })
                            log_audit(
                                tier="health",
                                service="opai-engine",
                                event="heartbeat:stall",
                                status="failed",
                                summary=f"Stall detected: {worker_id} — not auto-restartable",
                            )
            elif source == "worker":
                # Reset consecutive unhealthy counter when healthy
                self._consecutive_unhealthy.pop(key, None)

            # Task registry: running for too long
            if source == "task_registry" and item.get("status") == "running":
                started = item.get("started_at")
                if started:
                    try:
                        started_ts = datetime.fromisoformat(
                            started.replace("Z", "+00:00")
                        ).timestamp()
                        elapsed_min = (now - started_ts) / 60
                        if elapsed_min > stall_minutes * 2:
                            task_id = key.replace("task:", "")
                            changes.append({
                                "type": "stall_detected",
                                "item": key,
                                "title": item.get("title", task_id),
                                "action": f"Running for {elapsed_min:.0f}m (threshold: {stall_minutes * 2}m)",
                            })
                    except (ValueError, TypeError):
                        pass

        snapshot["summary"]["stalled"] = sum(
            1 for c in changes if c["type"] == "stall_detected"
        )

        return changes

    # ── Daily Note Trigger ────────────────────────────────────

    async def _check_daily_note(self, snapshot: dict):
        """At configured hour, trigger daily note generation."""
        orch = config.load_orchestrator_config()
        hb_cfg = orch.get("heartbeat", {})
        note_hour = hb_cfg.get("daily_note_hour", 23)
        note_minute = hb_cfg.get("daily_note_minute", 55)

        now = datetime.now()
        today_str = now.strftime("%Y-%m-%d")

        # Already sent today?
        if self._daily_note_sent_date == today_str:
            return

        # Check if we're past the configured time
        if now.hour > note_hour or (now.hour == note_hour and now.minute >= note_minute):
            try:
                from background.daily_note import generate_daily_note

                await generate_daily_note(self)
                self._daily_note_sent_date = today_str
                logger.info("Daily note generated for %s", today_str)
            except Exception as e:
                logger.error("Daily note generation failed: %s", e)

    # ── Consolidation Trigger ─────────────────────────────────

    async def _check_consolidation(self, snapshot: dict):
        """At configured hour, trigger memory consolidation."""
        if not self._consolidator:
            return

        orch = config.load_orchestrator_config()
        cons_cfg = orch.get("consolidator", {})
        if not cons_cfg.get("enabled", True):
            return

        cons_hour = cons_cfg.get("hour", 1)
        cons_minute = cons_cfg.get("minute", 0)

        now = datetime.now()
        today_str = now.strftime("%Y-%m-%d")

        # Already ran today?
        if self._consolidation_run_date == today_str:
            return

        # Check if we're past the configured time
        if now.hour > cons_hour or (now.hour == cons_hour and now.minute >= cons_minute):
            try:
                await self._consolidator.run(self)
                self._consolidation_run_date = today_str
                logger.info("Memory consolidation completed for %s", today_str)
            except Exception as e:
                logger.error("Memory consolidation failed: %s", e)

    # ── State Persistence ─────────────────────────────────────

    def _save_state(self):
        """Persist heartbeat state to disk."""
        try:
            state = {
                "cycle_count": self._cycle_count,
                "daily_note_sent_date": self._daily_note_sent_date,
                "consolidation_run_date": self._consolidation_run_date,
                "consecutive_unhealthy": self._consecutive_unhealthy,
                "last_snapshot": self._previous_snapshot,
                "saved_at": datetime.now(timezone.utc).isoformat(),
            }
            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            self._state_file.write_text(json.dumps(state, indent=2, default=str))
        except Exception as e:
            logger.error("Failed to save heartbeat state: %s", e)

    def _load_state(self):
        """Restore heartbeat state from disk."""
        try:
            if self._state_file.is_file():
                state = json.loads(self._state_file.read_text())
                self._cycle_count = state.get("cycle_count", 0)
                self._daily_note_sent_date = state.get("daily_note_sent_date")
                self._consolidation_run_date = state.get("consolidation_run_date")
                self._consecutive_unhealthy = state.get("consecutive_unhealthy", {})
                self._previous_snapshot = state.get("last_snapshot")
                logger.info(
                    "Heartbeat state restored: cycle %d", self._cycle_count
                )
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to load heartbeat state: %s", e)

    # ── Public API ────────────────────────────────────────────

    def get_latest(self) -> dict:
        """Return the most recent snapshot (for API route)."""
        if self._previous_snapshot:
            return self._previous_snapshot
        return {
            "snapshot_at": None,
            "cycle_number": self._cycle_count,
            "work_items": {},
            "summary": {
                "total": 0, "healthy": 0, "running_tasks": 0,
                "completed_since_last": 0, "failed_since_last": 0,
                "stalled": 0, "active_sessions": 0, "cpu": 0, "memory": 0,
            },
            "changes": [],
            "message": "No heartbeat cycle completed yet",
        }

    async def trigger(self) -> dict:
        """Force an immediate heartbeat cycle (for API/testing)."""
        await self._cycle()
        return self.get_latest()

    # ── Helpers ────────────────────────────────────────────────

    def _get_interval_seconds(self) -> int:
        orch = config.load_orchestrator_config()
        minutes = orch.get("heartbeat", {}).get("interval_minutes", 30)
        return minutes * 60

    @staticmethod
    def _format_duration(started_at) -> str:
        """Format a duration from a start timestamp to now."""
        if not started_at:
            return ""
        try:
            if isinstance(started_at, (int, float)):
                elapsed = time.time() - started_at
            else:
                ts = datetime.fromisoformat(
                    str(started_at).replace("Z", "+00:00")
                ).timestamp()
                elapsed = time.time() - ts

            if elapsed < 60:
                return f"{int(elapsed)}s"
            elif elapsed < 3600:
                return f"{int(elapsed / 60)}m"
            else:
                hours = int(elapsed / 3600)
                mins = int((elapsed % 3600) / 60)
                return f"{hours}h {mins}m"
        except (ValueError, TypeError):
            return ""
