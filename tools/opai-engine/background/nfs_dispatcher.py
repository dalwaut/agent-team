"""OPAI Engine — NFS Dispatcher (v3.5).

Background loop that bridges the Engine to external ClaudeClaw workers
communicating via NFS drop-folders. Each worker has:

    /workspace/users/_clawbots/{slug}/
        inbox/{task-id}/   — Engine writes context.json + READY sentinel
        outbox/{task-id}/  — Worker writes result.json + DONE sentinel
        status/            — heartbeat.json, capabilities.json
        config/            — worker-profile.json, CLAUDE.md
        knowledge/         — symlinks to shared knowledge
        logs/              — worker activity logs

Also syncs HITL items to /workspace/users/_admin/hitl/ for GravityClaw
to read and respond to.

Loop interval: nfs_dispatcher.poll_interval_seconds (default 30s).
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

import config
from audit import log_audit

logger = logging.getLogger("opai-engine.nfs-dispatcher")


class NfsDispatcher:
    """NFS drop-folder dispatcher for external ClaudeClaw workers."""

    def __init__(self, fleet_coordinator=None):
        self._fleet = fleet_coordinator
        self.state = self._load_state()
        self._cycle_count = 0

    # ── Persistence ──────────────────────────────────────────

    def _load_state(self) -> dict:
        try:
            if config.NFS_DISPATCHER_STATE_FILE.is_file():
                return json.loads(config.NFS_DISPATCHER_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
        return {
            "active_nfs_tasks": [],
            "recent_collections": [],
            "worker_health": {},
            "hitl_synced": [],
            "last_cycle": None,
            "stats": {
                "dispatches_today": 0,
                "collections_today": 0,
                "failures_today": 0,
            },
        }

    def _save_state(self):
        config.NFS_DISPATCHER_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.NFS_DISPATCHER_STATE_FILE.write_text(
            json.dumps(self.state, indent=2, default=str)
        )

    def _reset_daily_stats_if_needed(self):
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if self.state.get("_stats_date") != today:
            self.state["stats"] = {
                "dispatches_today": 0,
                "collections_today": 0,
                "failures_today": 0,
            }
            self.state["_stats_date"] = today

    # ── Main Loop ────────────────────────────────────────────

    async def run(self):
        """Main background loop."""
        nfs_cfg = config.load_orchestrator_config().get("nfs_dispatcher", {})
        if not nfs_cfg.get("enabled", False):
            logger.info("NFS dispatcher disabled")
            return

        interval = nfs_cfg.get("poll_interval_seconds", 30)
        logger.info("NFS dispatcher started (interval=%ds)", interval)

        # Initial delay — let other systems stabilize
        await asyncio.sleep(45)

        while True:
            try:
                await self._cycle(nfs_cfg)
            except Exception as e:
                logger.error("NFS dispatcher cycle error: %s", e)
            await asyncio.sleep(interval)

    async def _cycle(self, nfs_cfg: dict | None = None):
        """Execute one NFS dispatcher cycle."""
        self._cycle_count += 1
        self._reset_daily_stats_if_needed()

        if nfs_cfg is None:
            nfs_cfg = config.load_orchestrator_config().get("nfs_dispatcher", {})

        base = Path(nfs_cfg.get("base_path", str(config.NFS_CLAWBOTS_BASE)))
        if not base.is_dir():
            logger.debug("NFS base path %s not available", base)
            return

        workers = self._discover_workers(base)

        # 1. Poll outboxes for completed work
        collected = await self._poll_outboxes(workers)

        # 2. Check worker health via heartbeat files
        self._check_worker_health(workers, nfs_cfg)

        # 3. Sync HITL items to admin folder for GravityClaw
        if nfs_cfg.get("hitl_sync_enabled", True):
            await self._sync_hitl_to_admin(nfs_cfg)

        # 4. Poll admin responses
        if nfs_cfg.get("admin_response_poll", True):
            await self._poll_admin_responses(nfs_cfg)

        # 5. Check active NFS tasks for staleness
        self._check_active_tasks(nfs_cfg)

        self.state["last_cycle"] = datetime.now(timezone.utc).isoformat()
        self._save_state()

        if collected or self._cycle_count % 60 == 0:
            logger.info(
                "NFS cycle #%d: %d workers, %d collected, %d active",
                self._cycle_count,
                len(workers),
                collected,
                len(self.state.get("active_nfs_tasks", [])),
            )

    # ── Worker Discovery ─────────────────────────────────────

    def _discover_workers(self, base: Path) -> dict[str, Path]:
        """Discover all worker slugs under the base path."""
        workers = {}
        try:
            for entry in base.iterdir():
                if entry.is_dir() and not entry.name.startswith("."):
                    workers[entry.name] = entry
        except OSError:
            pass
        return workers

    def _get_registered_workers(self) -> dict:
        """Get registered NFS workers from workers.json config."""
        try:
            if config.OPAI_ROOT.joinpath("config", "workers.json").is_file():
                wj = json.loads(
                    config.OPAI_ROOT.joinpath("config", "workers.json").read_text()
                )
                nfs_ext = wj.get("workers", {}).get("nfs-external", {})
                return nfs_ext.get("registered_workers", {})
        except (json.JSONDecodeError, OSError):
            pass
        return {}

    # ── Dispatch to NFS ──────────────────────────────────────

    async def dispatch_to_nfs(
        self,
        worker_slug: str,
        teamhub_item_id: str | None,
        task_context: dict,
    ) -> dict:
        """Write execution context to a worker's inbox.

        Creates: inbox/{task-id}/context.json + workspace/ + READY sentinel.
        Returns dispatch info dict.
        """
        base = config.NFS_CLAWBOTS_BASE / worker_slug
        if not base.is_dir():
            return {"success": False, "error": f"Worker path not found: {worker_slug}"}

        task_id = task_context.get("id", f"nfs-{int(time.time())}")
        inbox_dir = base / "inbox" / task_id

        try:
            inbox_dir.mkdir(parents=True, exist_ok=True)
            (inbox_dir / "workspace").mkdir(exist_ok=True)

            # Write context file
            context = {
                "task_id": task_id,
                "teamhub_item_id": teamhub_item_id,
                "title": task_context.get("title", ""),
                "description": task_context.get("description", ""),
                "priority": task_context.get("priority", "normal"),
                "dispatched_at": datetime.now(timezone.utc).isoformat(),
                "dispatched_by": "opai-engine",
                "instructions": task_context.get("instructions", ""),
                "files": task_context.get("files", []),
            }
            (inbox_dir / "context.json").write_text(
                json.dumps(context, indent=2)
            )

            # Copy any provided workspace files
            for f in task_context.get("files", []):
                src = Path(f.get("source", ""))
                if src.is_file():
                    dest = inbox_dir / "workspace" / src.name
                    dest.write_bytes(src.read_bytes())

            # Write READY sentinel last (signals "ready to pick up")
            (inbox_dir / "READY").write_text(
                datetime.now(timezone.utc).isoformat()
            )

        except OSError as e:
            logger.error("NFS dispatch to %s failed: %s", worker_slug, e)
            return {"success": False, "error": str(e)}

        # Track active task
        dispatch_record = {
            "task_id": task_id,
            "worker_slug": worker_slug,
            "teamhub_item_id": teamhub_item_id,
            "dispatched_at": datetime.now(timezone.utc).isoformat(),
            "title": task_context.get("title", ""),
        }
        self.state.setdefault("active_nfs_tasks", []).append(dispatch_record)
        self.state["stats"]["dispatches_today"] = (
            self.state["stats"].get("dispatches_today", 0) + 1
        )
        self._save_state()

        # Update Team Hub item if we have one
        if teamhub_item_id:
            await self._th_update_status(teamhub_item_id, "assigned")
            await self._th_add_comment(
                teamhub_item_id,
                f"Dispatched to NFS worker **{worker_slug}** via drop-folder.",
                author="nfs-dispatcher",
            )

        log_audit(
            tier="execution",
            service="nfs-dispatcher",
            event="nfs_dispatch",
            summary=f"Dispatched {task_id} to NFS worker {worker_slug}",
            details=dispatch_record,
        )

        logger.info("NFS dispatched %s → %s", task_id, worker_slug)
        return {"success": True, "task_id": task_id, "worker_slug": worker_slug}

    # ── Poll Outboxes ────────────────────────────────────────

    async def _poll_outboxes(self, workers: dict[str, Path]) -> int:
        """Scan all worker outboxes for DONE sentinels. Returns count collected."""
        collected = 0
        for slug, worker_path in workers.items():
            outbox = worker_path / "outbox"
            if not outbox.is_dir():
                continue
            try:
                for task_dir in outbox.iterdir():
                    if not task_dir.is_dir():
                        continue
                    done_sentinel = task_dir / "DONE"
                    if done_sentinel.is_file():
                        await self._collect_result(slug, task_dir)
                        collected += 1
            except OSError:
                pass
        return collected

    async def _collect_result(self, worker_slug: str, task_dir: Path):
        """Collect a completed task result from a worker's outbox."""
        task_id = task_dir.name

        # Read result.json
        result = {}
        result_file = task_dir / "result.json"
        if result_file.is_file():
            try:
                result = json.loads(result_file.read_text())
            except (json.JSONDecodeError, OSError):
                result = {"status": "completed", "note": "result.json unreadable"}

        teamhub_item_id = result.get("teamhub_item_id")
        status = result.get("status", "completed")
        summary = result.get("summary", "")[:500]

        # Find matching active task to get teamhub_item_id if not in result
        if not teamhub_item_id:
            for active in self.state.get("active_nfs_tasks", []):
                if active.get("task_id") == task_id and active.get("worker_slug") == worker_slug:
                    teamhub_item_id = active.get("teamhub_item_id")
                    break

        # Update Team Hub
        if teamhub_item_id:
            th_status = "done" if status == "completed" else "failed"
            await self._th_update_status(teamhub_item_id, th_status)
            await self._th_add_comment(
                teamhub_item_id,
                f"**{status.upper()}** — NFS worker {worker_slug}\n\n{summary}",
                author=worker_slug,
            )

        # Copy output files to reports
        output_dir = task_dir / "output"
        if output_dir.is_dir():
            date_str = datetime.now().strftime("%Y-%m-%d")
            report_dest = config.REPORTS_DIR / date_str
            report_dest.mkdir(parents=True, exist_ok=True)
            try:
                for f in output_dir.iterdir():
                    if f.is_file():
                        (report_dest / f"nfs-{worker_slug}-{f.name}").write_bytes(
                            f.read_bytes()
                        )
            except OSError as e:
                logger.warning("Failed to copy NFS output: %s", e)

        # Record collection
        collection = {
            "task_id": task_id,
            "worker_slug": worker_slug,
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "summary": summary[:200],
        }
        collections = self.state.setdefault("recent_collections", [])
        collections.insert(0, collection)
        self.state["recent_collections"] = collections[:100]

        # Remove from active tasks
        self.state["active_nfs_tasks"] = [
            t for t in self.state.get("active_nfs_tasks", [])
            if not (t.get("task_id") == task_id and t.get("worker_slug") == worker_slug)
        ]
        self.state["stats"]["collections_today"] = (
            self.state["stats"].get("collections_today", 0) + 1
        )

        # Clean up the outbox task dir (move to logs)
        try:
            logs_dir = config.NFS_CLAWBOTS_BASE / worker_slug / "logs"
            logs_dir.mkdir(parents=True, exist_ok=True)
            archive = logs_dir / f"completed-{task_id}"
            task_dir.rename(archive)
        except OSError:
            pass  # Leave in outbox if rename fails

        # Notify
        try:
            from background.notifier import send_telegram
            emoji = "done" if status == "completed" else "FAILED"
            await send_telegram(
                f"NFS [{emoji}]: {worker_slug} finished '{result.get('title', task_id)[:50]}'"
            )
        except Exception:
            pass

        log_audit(
            tier="execution",
            service="nfs-dispatcher",
            event="nfs_collected",
            summary=f"Collected {task_id} from NFS worker {worker_slug}: {status}",
            details=collection,
        )

        logger.info("NFS collected %s from %s: %s", task_id, worker_slug, status)

    # ── Worker Health ────────────────────────────────────────

    def _check_worker_health(self, workers: dict[str, Path], nfs_cfg: dict):
        """Read heartbeat.json from each worker, flag stale."""
        stale_minutes = nfs_cfg.get("heartbeat_stale_minutes", 10)
        now = time.time()
        health = {}

        for slug, worker_path in workers.items():
            hb_file = worker_path / "status" / "heartbeat.json"
            entry = {"slug": slug, "status": "unknown", "last_seen": None}

            if hb_file.is_file():
                try:
                    hb = json.loads(hb_file.read_text())
                    last_seen = hb.get("last_seen", "")
                    entry["last_seen"] = last_seen
                    entry["current_task"] = hb.get("current_task")
                    entry["load"] = hb.get("load")

                    # Parse last_seen to check staleness
                    if last_seen:
                        from datetime import datetime as dt
                        seen_dt = dt.fromisoformat(last_seen.replace("Z", "+00:00"))
                        age_min = (datetime.now(timezone.utc) - seen_dt).total_seconds() / 60
                        if age_min > stale_minutes:
                            entry["status"] = "stale"
                        elif hb.get("alive", True):
                            entry["status"] = "healthy"
                        else:
                            entry["status"] = "offline"
                    else:
                        entry["status"] = "no-heartbeat"
                except (json.JSONDecodeError, OSError, ValueError):
                    entry["status"] = "error"
            else:
                entry["status"] = "no-heartbeat"

            # Check capabilities
            cap_file = worker_path / "status" / "capabilities.json"
            if cap_file.is_file():
                try:
                    entry["capabilities"] = json.loads(cap_file.read_text())
                except (json.JSONDecodeError, OSError):
                    pass

            health[slug] = entry

        self.state["worker_health"] = health

    # ── HITL Sync to Admin ───────────────────────────────────

    async def _sync_hitl_to_admin(self, nfs_cfg: dict):
        """Render awaiting-human Team Hub items as .md files in _admin/hitl/."""
        admin_path = Path(nfs_cfg.get("admin_hitl_path", str(config.NFS_ADMIN_HITL)))
        if not admin_path.is_dir():
            try:
                admin_path.mkdir(parents=True, exist_ok=True)
            except OSError:
                return

        # Fetch awaiting-human items from Team Hub
        items = []
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(
                    f"{config.TEAMHUB_INTERNAL}/list-items",
                    params={
                        "workspace_id": config.WORKERS_WORKSPACE_ID,
                        "status": "awaiting-human",
                    },
                )
                if r.status_code < 400:
                    items = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
        except Exception as e:
            logger.debug("HITL sync fetch failed: %s", e)
            return

        # Track which IDs we've synced
        synced_ids = set()

        for item in items:
            item_id = item.get("id", "")
            if not item_id:
                continue
            synced_ids.add(item_id)

            md_file = admin_path / f"{item_id}.md"
            if md_file.is_file():
                continue  # Already synced

            # Render briefing
            briefing = f"""# HITL Decision Required

**Item:** {item_id}
**Title:** {item.get('title', 'Untitled')}
**Priority:** {item.get('priority', 'normal')}
**Created:** {item.get('created_at', 'unknown')}
**Source:** {item.get('source', 'unknown')}

## Description
{item.get('description', 'No description provided.')}

## Actions
Write your decision to `{item_id}.response` in this directory:

- `approve` — Approve and proceed
- `run` — Approve and dispatch immediately
- `dismiss` — Dismiss / not needed
- `reject:reason` — Reject with reason

Example: echo "approve" > {item_id}.response
"""
            try:
                md_file.write_text(briefing)
            except OSError as e:
                logger.warning("Failed to write HITL briefing %s: %s", item_id, e)

        # Clean up .md files for items no longer awaiting-human
        try:
            for f in admin_path.iterdir():
                if f.suffix == ".md" and f.stem not in synced_ids:
                    f.unlink(missing_ok=True)
                    # Also remove the response file if it exists
                    resp = admin_path / f"{f.stem}.response"
                    resp.unlink(missing_ok=True)
        except OSError:
            pass

        self.state["hitl_synced"] = list(synced_ids)

    # ── Poll Admin Responses ─────────────────────────────────

    async def _poll_admin_responses(self, nfs_cfg: dict):
        """Check for .response files in _admin/hitl/ and translate to actions."""
        admin_path = Path(nfs_cfg.get("admin_hitl_path", str(config.NFS_ADMIN_HITL)))
        if not admin_path.is_dir():
            return

        try:
            for f in admin_path.iterdir():
                if f.suffix != ".response" or not f.is_file():
                    continue

                item_id = f.stem
                action_text = f.read_text().strip().lower()

                if not action_text:
                    continue

                # Parse action
                action = action_text.split(":")[0]
                reason = ":".join(action_text.split(":")[1:]).strip() if ":" in action_text else ""

                # Map to Team Hub status
                status_map = {
                    "approve": "assigned",
                    "run": "in-progress",
                    "dismiss": "dismissed",
                    "reject": "dismissed",
                }
                new_status = status_map.get(action)
                if not new_status:
                    logger.warning("Unknown admin response action: %s", action)
                    continue

                # Update Team Hub
                await self._th_update_status(item_id, new_status)
                if reason:
                    await self._th_add_comment(
                        item_id,
                        f"**Admin response:** {action}\n\n{reason}",
                        author="admin-gc",
                    )

                # If "run" — dispatch via fleet coordinator
                if action == "run" and self._fleet:
                    # Find the task in the Team Hub item to dispatch
                    logger.info("Admin requested run for %s — dispatch pending", item_id)

                # Clean up response + briefing
                f.unlink(missing_ok=True)
                md_file = admin_path / f"{item_id}.md"
                md_file.unlink(missing_ok=True)

                log_audit(
                    tier="execution",
                    service="nfs-dispatcher",
                    event="admin_response",
                    summary=f"Admin responded to HITL {item_id}: {action}",
                    details={"item_id": item_id, "action": action, "reason": reason},
                )

                logger.info("Admin response: %s → %s for %s", action, new_status, item_id)

        except OSError as e:
            logger.debug("Admin response poll error: %s", e)

    # ── Active Task Staleness ────────────────────────────────

    def _check_active_tasks(self, nfs_cfg: dict):
        """Flag active NFS tasks that have been pending too long."""
        stale_minutes = nfs_cfg.get("heartbeat_stale_minutes", 10) * 3  # 3x worker stale
        now = datetime.now(timezone.utc)

        for task in self.state.get("active_nfs_tasks", []):
            dispatched = task.get("dispatched_at", "")
            try:
                dispatched_dt = datetime.fromisoformat(dispatched.replace("Z", "+00:00"))
                age_min = (now - dispatched_dt).total_seconds() / 60
                if age_min > stale_minutes:
                    task["stale"] = True
                    logger.warning(
                        "NFS task %s on %s stale (%.0f min)",
                        task.get("task_id"), task.get("worker_slug"), age_min,
                    )
            except (ValueError, TypeError):
                pass

    # ── Team Hub Helpers ─────────────────────────────────────

    async def _th_update_status(self, item_id: str, status: str):
        if not item_id:
            return
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{config.TEAMHUB_INTERNAL}/update-item",
                    params={"item_id": item_id, "status": status},
                )
        except Exception as e:
            logger.debug("TH status update failed: %s", e)

    async def _th_add_comment(self, item_id: str, content: str, author: str = "system"):
        if not item_id:
            return
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(
                    f"{config.TEAMHUB_INTERNAL}/add-comment",
                    params={
                        "item_id": item_id,
                        "content": content,
                        "author_id": author,
                    },
                )
        except Exception as e:
            logger.debug("TH comment failed: %s", e)

    # ── Public API ───────────────────────────────────────────

    def get_status(self) -> dict:
        """Return NFS dispatcher state for the API."""
        return {
            "active_nfs_tasks": self.state.get("active_nfs_tasks", []),
            "worker_health": self.state.get("worker_health", {}),
            "hitl_synced": self.state.get("hitl_synced", []),
            "last_cycle": self.state.get("last_cycle"),
            "cycle_count": self._cycle_count,
            "stats": self.state.get("stats", {}),
        }

    def get_history(self, limit: int = 50) -> list[dict]:
        """Return recent NFS collection history."""
        return self.state.get("recent_collections", [])[:limit]

    def get_worker_health(self) -> dict:
        """Return health status of all NFS workers."""
        return self.state.get("worker_health", {})
