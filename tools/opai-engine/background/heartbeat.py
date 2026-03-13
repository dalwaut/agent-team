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
from datetime import datetime, timezone, timedelta
from pathlib import Path

import httpx

import config
from audit import log_audit
from background.notifier import (
    check_hitl_escalations,
    check_telegram_recovery,
    flush_notifications,
    notify_activity_digest,
    notify_changes,
    notify_service_recovered,
    notify_synology_rescan,
)
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
        self._first_unhealthy_at: dict[str, float] = {}  # key → timestamp
        self._alerted_unhealthy: set[str] = set()  # keys we've sent "failed" alerts for
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

            # Send recovery notifications for Telegram-initiated restarts
            for c in changes:
                if c.get("type") == "recovered":
                    try:
                        await notify_service_recovered(c["title"])
                    except Exception as e:
                        logger.warning("Recovery notification failed: %s", e)

        # Flush queued notifications (HITL briefings, worker approvals)
        try:
            delivered = await flush_notifications()
            if delivered:
                logger.info("Delivered %d queued notifications", delivered)
        except Exception as e:
            logger.warning("Flush notifications failed: %s", e)

        # Check HITL escalations (unacknowledged items)
        try:
            escalated = await check_hitl_escalations(escalation_minutes=15)
            if escalated:
                logger.info("Sent %d HITL escalation(s)", escalated)
        except Exception as e:
            logger.warning("HITL escalation check failed: %s", e)

        # Periodic activity digest
        await self._check_activity_digest(snapshot)

        # Synology rescan monitor (temporary — auto-stops when rescan finishes)
        await self._check_synology_rescan(snapshot)

        # Check if daily note should be generated
        await self._check_daily_note(snapshot)

        # Check if memory consolidation should run
        await self._check_consolidation(snapshot)

        # Proactive intelligence — detect actionable patterns
        await self._check_proactive_intelligence(snapshot)

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
        worker_total = 0
        running_tasks = 0
        active_sessions = 0

        # 1. Worker manager status
        worker_status = self.worker_manager.get_status()
        for wid, ws in worker_status.items():
            wtype = ws.get("type")
            item = {
                "source": "worker",
                "status": "healthy" if ws.get("healthy") else (
                    "unhealthy" if ws.get("healthy") is False else "unknown"
                ),
                "managed": ws.get("managed", False),
                "running": ws.get("running"),
                "pid": ws.get("pid"),
                "restarts": ws.get("restarts", 0),
                "type": wtype,
            }
            # Add uptime for managed workers
            detail = self.worker_manager.get_worker_detail(wid)
            if detail and detail.get("uptime_seconds"):
                item["uptime_sec"] = detail["uptime_seconds"]

            work_items[f"worker:{wid}"] = item
            total += 1
            # Only count long-running/hybrid workers in healthy ratio
            if wtype in ("long-running", "hybrid"):
                worker_total += 1
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

        # 6. Agent feedback stats (lightweight — single query)
        feedback_stats = {"active_hints": 0, "recent_24h": 0, "gaps": 0, "corrections": 0}
        try:
            if config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY:
                sb_headers = {
                    "apikey": config.SUPABASE_SERVICE_KEY,
                    "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
                }
                fb_url = f"{config.SUPABASE_URL}/rest/v1/engine_agent_feedback"
                with httpx.Client(timeout=5) as hc:
                    # Total active hints
                    r = hc.get(fb_url, headers=sb_headers, params={
                        "active": "eq.true", "select": "id,feedback_type,created_at",
                        "limit": "1000",
                    })
                    if r.status_code == 200:
                        fb_items = r.json()
                        feedback_stats["active_hints"] = len(fb_items)
                        cutoff_24h = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
                        feedback_stats["recent_24h"] = sum(
                            1 for f in fb_items if (f.get("created_at") or "") > cutoff_24h
                        )
                        feedback_stats["gaps"] = sum(
                            1 for f in fb_items if f.get("feedback_type") == "missing_context"
                        )
                        feedback_stats["corrections"] = sum(
                            1 for f in fb_items if f.get("feedback_type") == "correction"
                        )
        except Exception as e:
            logger.debug("Agent feedback stats unavailable: %s", e)

        summary = {
            "total": total,
            "worker_total": worker_total,
            "healthy": healthy,
            "running_tasks": running_tasks,
            "completed_since_last": 0,  # Filled by _detect_changes
            "failed_since_last": 0,
            "stalled": 0,
            "active_sessions": active_sessions,
            "cpu": round(cpu, 1),
            "memory": round(memory, 1),
            "agent_feedback": feedback_stats,
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

            # Worker status transitions (10-minute grace period before alerting)
            if curr.get("source") == "worker":
                if curr.get("status") == "unhealthy":
                    if key not in self._first_unhealthy_at:
                        self._first_unhealthy_at[key] = time.time()
                    down_seconds = time.time() - self._first_unhealthy_at[key]
                    grace_minutes = 10
                    if (
                        key not in self._alerted_unhealthy
                        and down_seconds >= grace_minutes * 60
                    ):
                        changes.append({
                            "type": "failed",
                            "item": key,
                            "title": key.replace("worker:", ""),
                        })
                        self._alerted_unhealthy.add(key)
                        failed_count += 1
                elif curr.get("status") == "healthy":
                    # Clear grace timer and alert flag on recovery
                    self._first_unhealthy_at.pop(key, None)
                    self._alerted_unhealthy.discard(key)

                # Worker recovered — check if it was a Telegram-initiated restart
                if prev.get("status") == "unhealthy" and curr.get("status") == "healthy":
                    worker_id = key.replace("worker:", "")
                    if check_telegram_recovery(worker_id):
                        changes.append({
                            "type": "recovered",
                            "item": key,
                            "title": worker_id,
                        })

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

                    if w and w.get("restart_on_failure"):
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

    # ── Activity Digest ──────────────────────────────────────

    async def _check_activity_digest(self, snapshot: dict):
        """Send periodic activity digest to Server Status topic."""
        orch = config.load_orchestrator_config()
        hb_cfg = orch.get("heartbeat", {})
        interval = hb_cfg.get("digest_interval_cycles", 12)

        if interval <= 0 or self._cycle_count % interval != 0:
            return

        try:
            await notify_activity_digest(snapshot)
            logger.info("Activity digest sent (cycle %d)", self._cycle_count)
        except Exception as e:
            logger.warning("Activity digest failed: %s", e)

    # ── Synology Rescan Monitor (temporary) ─────────────────

    async def _check_synology_rescan(self, snapshot: dict):
        """Send rescan progress on same cadence as activity digest.

        Auto-stops when rescan finishes (notify_synology_rescan returns None).
        """
        orch = config.load_orchestrator_config()
        hb_cfg = orch.get("heartbeat", {})
        interval = hb_cfg.get("digest_interval_cycles", 12)

        if interval <= 0 or self._cycle_count % interval != 0:
            return

        try:
            result = await notify_synology_rescan()
            if result is True:
                logger.info("Synology rescan progress sent (cycle %d)", self._cycle_count)
            elif result is None:
                logger.info("Synology rescan complete or daemon idle — monitor inactive")
        except Exception as e:
            logger.warning("Synology rescan monitor failed: %s", e)

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

    # ── Proactive Intelligence ─────────────────────────────────

    async def _check_proactive_intelligence(self, snapshot: dict):
        """Determine if the system should act on anything without being asked.

        Runs every N heartbeat cycles (configurable). Detects patterns and
        either logs suggestions (default) or auto-acts on low-risk items.

        Detection rules:
          1. Overdue items in Team Hub with no assignee → suggest auto-routing
          2. Items in "assigned" for >2 hours with no progress → flag stall
          3. Patterns: same type of task completed 3+ times → suggest automation
          4. External NFS worker idle for >1hr with pending tasks → suggest dispatch
        """
        orch = config.load_orchestrator_config()
        pi_cfg = orch.get("proactive_intelligence", {})
        if not pi_cfg.get("enabled", True):
            return

        interval = pi_cfg.get("check_interval_cycles", 3)
        if self._cycle_count % interval != 0:
            return

        # Load proactive state
        pro_state = self._load_proactive_state()
        suggestions = []
        now = datetime.now(timezone.utc)
        max_suggestions = pi_cfg.get("max_suggestions_per_cycle", 5)

        # Already-suggested IDs (avoid duplicates within 24h)
        recent_ids = {
            s.get("item_id")
            for s in pro_state.get("recent_suggestions", [])
            if s.get("suggested_at", "") > (now - timedelta(hours=24)).isoformat()
        }

        try:
            # ── 1. Overdue unassigned Team Hub items ──
            overdue_min = pi_cfg.get("overdue_threshold_minutes", 60)
            overdue = await self._pi_find_overdue_items(overdue_min)
            for item in overdue:
                iid = item.get("id", "")
                if iid in recent_ids or len(suggestions) >= max_suggestions:
                    continue
                suggestions.append({
                    "type": "auto_route",
                    "item_id": iid,
                    "title": f"Unassigned for {item.get('age_min', 0)}m: {item.get('title', '')[:50]}",
                    "detail": f"Item has been in '{item.get('status', '?')}' with no assignee for {item.get('age_min', 0)} minutes.",
                    "recommended_action": "auto-route to available worker",
                    "priority": item.get("priority", "normal"),
                })

            # ── 2. Stalled assigned items ──
            stall_min = pi_cfg.get("assigned_stall_minutes", 120)
            stalled = await self._pi_find_stalled_assigned(stall_min)
            for item in stalled:
                iid = item.get("id", "")
                if iid in recent_ids or len(suggestions) >= max_suggestions:
                    continue
                suggestions.append({
                    "type": "stalled_assignment",
                    "item_id": iid,
                    "title": f"No progress in {item.get('age_min', 0)}m: {item.get('title', '')[:50]}",
                    "detail": f"Assigned to '{item.get('assignee', '?')}' but no status update.",
                    "recommended_action": "check agent status or reassign",
                    "priority": "high",
                })

            # ── 3. Pattern detection ──
            min_count = pi_cfg.get("pattern_detection_min_count", 3)
            patterns = self._pi_detect_patterns(pro_state, min_count)
            for pat in patterns:
                pid = f"pattern:{pat.get('category', '')}"
                if pid in recent_ids or len(suggestions) >= max_suggestions:
                    continue
                suggestions.append({
                    "type": "automation_opportunity",
                    "item_id": pid,
                    "title": f"Repeating pattern: {pat.get('category', '?')} ({pat.get('count', 0)} times)",
                    "detail": pat.get("detail", ""),
                    "recommended_action": "consider scheduling or auto-routing this category",
                    "priority": "low",
                })

            # ── 4. Idle NFS workers with pending work ──
            idle_min = pi_cfg.get("idle_worker_minutes", 60)
            idle_matches = self._pi_find_idle_workers_with_work(idle_min)
            for match in idle_matches:
                mid = f"idle-dispatch:{match.get('worker', '')}"
                if mid in recent_ids or len(suggestions) >= max_suggestions:
                    continue
                suggestions.append({
                    "type": "idle_worker_dispatch",
                    "item_id": mid,
                    "title": f"Idle NFS worker '{match.get('worker', '?')}' — {match.get('pending_count', 0)} tasks pending",
                    "detail": f"Worker has been idle for {match.get('idle_min', 0)}m while {match.get('pending_count', 0)} items await dispatch.",
                    "recommended_action": "dispatch pending work to this worker",
                    "priority": "normal",
                })

        except Exception as e:
            logger.warning("Proactive intelligence error: %s", e)
            return

        if not suggestions:
            return

        # Record suggestions
        for sug in suggestions:
            sug["suggested_at"] = now.isoformat()
            sug["acknowledged"] = False

        pro_state.setdefault("recent_suggestions", [])
        pro_state["recent_suggestions"] = (
            suggestions + pro_state["recent_suggestions"]
        )[:200]  # Keep last 200
        pro_state["last_check"] = now.isoformat()
        pro_state["total_suggestions"] = pro_state.get("total_suggestions", 0) + len(suggestions)
        self._save_proactive_state(pro_state)

        # PI suggestions are stored in proactive_state.json and audit log only.
        # Previously logged to Team Hub as items, but this created noise — disabled.

        logger.info(
            "Proactive intelligence: %d suggestions (cycle %d)",
            len(suggestions), self._cycle_count,
        )

        log_audit(
            tier="intelligence",
            service="opai-engine",
            event="proactive:suggestions",
            summary=f"Proactive intelligence generated {len(suggestions)} suggestions",
            details={"suggestions": [s.get("title", "") for s in suggestions]},
        )

    # ── PI: Team Hub Queries ──

    async def _pi_find_overdue_items(self, threshold_min: int) -> list[dict]:
        """Find Team Hub items in open/awaiting-human status with no assignee past threshold."""
        results = []
        now = datetime.now(timezone.utc)

        for status in ("open", "awaiting-human"):
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(
                        f"{config.TEAMHUB_INTERNAL}/list-items",
                        params={
                            "workspace_id": config.WORKERS_WORKSPACE_ID,
                            "status": status,
                            "limit": "20",
                        },
                    )
                    if r.status_code >= 400:
                        continue
                    data = r.json()
                    items = data.get("items", []) if isinstance(data, dict) else data
            except Exception:
                continue

            for item in items:
                # Skip items that have assignees
                assignments = item.get("assignments", [])
                if assignments:
                    continue

                # Skip items created by PI itself (prevents recursive self-feeding)
                title = item.get("title", "")
                if title.startswith("[PI]"):
                    continue

                created = item.get("created_at", "")
                if not created:
                    continue
                try:
                    created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                    age_min = int((now - created_dt).total_seconds() / 60)
                    if age_min >= threshold_min:
                        results.append({
                            "id": item.get("id", ""),
                            "title": item.get("title", ""),
                            "status": status,
                            "priority": item.get("priority", "medium"),
                            "age_min": age_min,
                        })
                except (ValueError, TypeError):
                    pass

        return results

    async def _pi_find_stalled_assigned(self, threshold_min: int) -> list[dict]:
        """Find Team Hub items in 'assigned' status that haven't progressed."""
        results = []
        now = datetime.now(timezone.utc)

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(
                    f"{config.TEAMHUB_INTERNAL}/list-items",
                    params={
                        "workspace_id": config.WORKERS_WORKSPACE_ID,
                        "status": "assigned",
                        "limit": "20",
                    },
                )
                if r.status_code >= 400:
                    return results
                data = r.json()
                items = data.get("items", []) if isinstance(data, dict) else data
        except Exception:
            return results

        for item in items:
            updated = item.get("updated_at", item.get("created_at", ""))
            if not updated:
                continue
            try:
                updated_dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                age_min = int((now - updated_dt).total_seconds() / 60)
                if age_min >= threshold_min:
                    assignee = ""
                    assignments = item.get("assignments", [])
                    if assignments:
                        assignee = assignments[0].get("assignee_id", "")
                    results.append({
                        "id": item.get("id", ""),
                        "title": item.get("title", ""),
                        "assignee": assignee,
                        "age_min": age_min,
                    })
            except (ValueError, TypeError):
                pass

        return results

    # ── PI: Pattern Detection ──

    def _pi_detect_patterns(self, pro_state: dict, min_count: int) -> list[dict]:
        """Detect repeating task patterns from fleet coordinator completions."""
        patterns = []
        try:
            if not config.FLEET_STATE_FILE.is_file():
                return patterns
            fleet = json.loads(config.FLEET_STATE_FILE.read_text())
            completions = fleet.get("recent_completions", [])

            # Count completions by worker_id (category proxy)
            from collections import Counter
            worker_counts = Counter(c.get("worker_id", "") for c in completions if c.get("status") == "completed")

            for worker_id, count in worker_counts.items():
                if count >= min_count and worker_id:
                    # Check if already suggested recently
                    patterns.append({
                        "category": worker_id,
                        "count": count,
                        "detail": f"Worker '{worker_id}' has completed {count} tasks recently. Consider scheduling regular runs.",
                    })
        except (json.JSONDecodeError, OSError):
            pass
        return patterns

    # ── PI: NFS Worker Idle Detection ──

    def _pi_find_idle_workers_with_work(self, idle_min: int) -> list[dict]:
        """Find NFS workers that are idle while pending work exists."""
        matches = []
        try:
            if not config.NFS_DISPATCHER_STATE_FILE.is_file():
                return matches
            nfs_state = json.loads(config.NFS_DISPATCHER_STATE_FILE.read_text())
            worker_health = nfs_state.get("worker_health", {})
            active_tasks = nfs_state.get("active_nfs_tasks", [])

            # Workers with tasks assigned
            busy_workers = {t.get("worker_slug") for t in active_tasks}

            # Check for pending Team Hub items that could be dispatched
            # (We approximate by checking if there are open items in the workspace)
            pending_count = 0
            try:
                if config.REGISTRY_JSON.is_file():
                    reg = json.loads(config.REGISTRY_JSON.read_text())
                    pending_count = sum(
                        1 for t in reg.get("tasks", {}).values()
                        if t.get("status") in ("pending", "approved")
                        and t.get("assignee") == "agent"
                    )
            except (json.JSONDecodeError, OSError):
                pass

            if pending_count == 0:
                return matches

            now = datetime.now(timezone.utc)
            for slug, health in worker_health.items():
                if slug in busy_workers:
                    continue
                if health.get("status") != "healthy":
                    continue

                # Check idle time from last_seen
                last_seen = health.get("last_seen", "")
                if not last_seen:
                    continue
                try:
                    seen_dt = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
                    idle = int((now - seen_dt).total_seconds() / 60)
                    # "idle" here means the worker is healthy but hasn't been given work
                    # For NFS workers, being healthy = available for dispatch
                    matches.append({
                        "worker": slug,
                        "idle_min": idle,
                        "pending_count": pending_count,
                    })
                except (ValueError, TypeError):
                    pass

        except (json.JSONDecodeError, OSError):
            pass
        return matches

    # ── PI: Team Hub Logging ──

    async def _pi_log_to_teamhub(self, suggestion: dict):
        """Log a proactive suggestion to Team Hub as an 'idea' item."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(
                    f"{config.TEAMHUB_INTERNAL}/create-item",
                    params={
                        "workspace_id": config.WORKERS_WORKSPACE_ID,
                        "user_id": config.SYSTEM_USER_ID,
                        "type": "idea",
                        "title": f"[PI] {suggestion.get('title', 'Proactive suggestion')[:80]}",
                        "description": (
                            f"**Type:** {suggestion.get('type', 'unknown')}\n\n"
                            f"{suggestion.get('detail', '')}\n\n"
                            f"**Recommended:** {suggestion.get('recommended_action', 'Review')}"
                        ),
                        "priority": suggestion.get("priority", "low"),
                        "status": "open",
                        "source": "proactive-intelligence",
                    },
                )
        except Exception as e:
            logger.debug("PI Team Hub log failed: %s", e)

    # ── PI: State Persistence ──

    def _load_proactive_state(self) -> dict:
        try:
            if config.PROACTIVE_STATE_FILE.is_file():
                return json.loads(config.PROACTIVE_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
        return {"recent_suggestions": [], "last_check": None, "total_suggestions": 0}

    def _save_proactive_state(self, state: dict):
        try:
            config.PROACTIVE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            config.PROACTIVE_STATE_FILE.write_text(
                json.dumps(state, indent=2, default=str)
            )
        except OSError as e:
            logger.error("Failed to save proactive state: %s", e)

    # ── State Persistence ─────────────────────────────────────

    def _save_state(self):
        """Persist heartbeat state to disk."""
        try:
            state = {
                "cycle_count": self._cycle_count,
                "daily_note_sent_date": self._daily_note_sent_date,
                "consolidation_run_date": self._consolidation_run_date,
                "consecutive_unhealthy": self._consecutive_unhealthy,
                "first_unhealthy_at": self._first_unhealthy_at,
                "alerted_unhealthy": list(self._alerted_unhealthy),
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
                self._first_unhealthy_at = state.get("first_unhealthy_at", {})
                self._alerted_unhealthy = set(state.get("alerted_unhealthy", []))
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
