"""OPAI Engine — Cron scheduler.

Rewrite of orchestrator.js cron logic in Python.
Uses croniter for cron expression parsing. Checks every 60 seconds.
"""

import asyncio
import json
import logging
import subprocess
import time
from datetime import datetime
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

        # Check parallel job limit
        max_parallel = self.orch_config.get("resources", {}).get("max_parallel_jobs", 3)
        if len(self.active_jobs) >= max_parallel:
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
            "self_assessment": lambda: self._run_squad("evolve"),
            "evolution": self._evolution_dry_run,
            "workspace_audit": lambda: self._run_squad("workspace"),
            "knowledge_sync": lambda: self._run_squad("knowledge"),
            "dep_scan_daily": lambda: self._run_squad("dep_scan"),
            "secrets_scan_daily": lambda: self._run_squad("secrets_scan"),
            "security_quick": lambda: self._run_squad("security_quick"),
            "incident_check": lambda: self._run_squad("incident"),
            "a11y_weekly": lambda: self._run_squad("a11y"),
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

    async def _run_squad(self, squad_name: str) -> bool:
        """Run an agent squad."""
        return await self._spawn_process(
            ["bash", str(config.SCRIPTS_DIR / "run_squad.sh"), "-s", squad_name],
            cwd=str(config.OPAI_ROOT),
            timeout=900,
        )

    async def _evolution_dry_run(self) -> bool:
        """Run evolution dry-run."""
        nvm_bin = Path.home() / ".nvm" / "versions" / "node" / "v20.19.5" / "bin"
        import os
        env = {**os.environ, "PATH": f"{nvm_bin}:{os.environ.get('PATH', '')}"}
        return await self._spawn_process(
            ["bash", str(config.SCRIPTS_DIR / "run_auto.sh"),
             "--mode", "safe", "--dry-run", "--yes", "--skip-preflight"],
            cwd=str(config.OPAI_ROOT),
            timeout=1200,
            env=env,
        )

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
