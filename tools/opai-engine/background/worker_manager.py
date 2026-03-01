"""OPAI Engine — Worker Manager.

Manages all registered workers: long-running services, hybrid apps, and task workers.

Workers with `managed: true` in workers.json are spawned directly by the Engine
(no systemd). Others still use systemd via their `systemd_unit` field.

Workers are registered in config/workers.json.
"""

import asyncio
import json
import logging
import os
import signal
import subprocess
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

import config

logger = logging.getLogger("opai-engine.workers")

WORKERS_JSON = config.OPAI_ROOT / "config" / "workers.json"
NVM_NODE_BIN = "/home/dallas/.nvm/versions/node/v20.19.5/bin"
VAULT_ENV_SCRIPT = config.OPAI_ROOT / "tools" / "opai-vault" / "scripts" / "vault-env.sh"
VAULT_API = "http://127.0.0.1:8105"


class RateLimiter:
    """Per-worker rate limiting using sliding window."""

    def __init__(self):
        self.counters: dict[str, deque] = {}

    def check(self, worker_id: str, max_per_hour: int) -> bool:
        if max_per_hour <= 0:
            return True
        now = time.time()
        q = self.counters.setdefault(worker_id, deque())
        while q and q[0] < now - 3600:
            q.popleft()
        if len(q) >= max_per_hour:
            return False
        q.append(now)
        return True

    def get_count(self, worker_id: str) -> int:
        now = time.time()
        q = self.counters.get(worker_id, deque())
        while q and q[0] < now - 3600:
            q.popleft()
        return len(q)


class WorkerManager:
    """Manages all registered workers."""

    def __init__(self):
        self.workers: dict = {}
        self.health: dict[str, Optional[bool]] = {}
        self.task_processes: dict[str, asyncio.subprocess.Process] = {}
        self.restart_counts: dict[str, int] = {}
        self.last_health_check: float = 0
        self.rate_limiter = RateLimiter()
        self._started_at: dict[str, float] = {}
        # Direct-managed process handles (non-systemd workers)
        self._managed_procs: dict[str, subprocess.Popen] = {}
        self._managed_logs: dict[str, deque] = {}  # Ring buffer per worker
        self._managed_auto_restart: dict[str, bool] = {}  # Track auto-restart intent

    def load(self):
        """Load worker registrations from config/workers.json."""
        try:
            data = json.loads(WORKERS_JSON.read_text())
            self.workers = data.get("workers", {})
            managed = sum(1 for w in self.workers.values() if w.get("managed"))
            logger.info(
                "Loaded %d workers (%d long-running, %d hybrid, %d task, %d engine-managed)",
                len(self.workers),
                sum(1 for w in self.workers.values() if w.get("type") == "long-running"),
                sum(1 for w in self.workers.values() if w.get("type") == "hybrid"),
                sum(1 for w in self.workers.values() if w.get("type") == "task"),
                managed,
            )
        except (json.JSONDecodeError, OSError) as e:
            logger.error("Failed to load workers.json: %s", e)
            self.workers = {}

    # ── Direct Process Management (engine-managed workers) ────

    def _is_managed(self, w: dict) -> bool:
        """Check if a worker is engine-managed (not systemd)."""
        return bool(w.get("managed"))

    def _build_managed_env(self, w: dict) -> dict:
        """Build environment for a directly-managed worker process."""
        env = dict(os.environ)
        env.pop("CLAUDECODE", None)
        env["NODE_ENV"] = "production"
        if NVM_NODE_BIN not in env.get("PATH", ""):
            env["PATH"] = f"{NVM_NODE_BIN}:{env.get('PATH', '')}"

        # Load vault credentials
        for vault_key in w.get("vault_keys", []):
            vault_env_file = Path(
                os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
            ) / "opai-vault" / f"{vault_key}.env"
            if vault_env_file.is_file():
                for line in vault_env_file.read_text().splitlines():
                    line = line.strip()
                    if "=" in line and not line.startswith("#"):
                        key, _, val = line.partition("=")
                        env[key] = val.strip('"')
            else:
                logger.warning("Vault env missing for %s: %s", vault_key, vault_env_file)

        # Load .env fallback
        entry = w.get("entry", "")
        if entry:
            dotenv = config.OPAI_ROOT / Path(entry).parent / ".env"
            if dotenv.is_file():
                for line in dotenv.read_text().splitlines():
                    line = line.strip()
                    if "=" in line and not line.startswith("#"):
                        key, _, val = line.partition("=")
                        if key not in env:  # vault takes priority
                            env[key] = val.strip('"')

        return env

    def _decrypt_vault_for(self, vault_key: str) -> bool:
        """Run vault-env.sh to decrypt credentials before process start."""
        if not VAULT_ENV_SCRIPT.is_file():
            logger.warning("vault-env.sh not found, skipping vault decrypt")
            return False
        try:
            result = subprocess.run(
                ["bash", str(VAULT_ENV_SCRIPT), vault_key],
                capture_output=True, text=True, timeout=15,
            )
            if result.returncode == 0:
                logger.info("Vault decrypted for %s", vault_key)
                return True
            logger.error("Vault decrypt failed for %s: %s", vault_key, result.stderr[:200])
            return False
        except Exception as e:
            logger.error("Vault decrypt error for %s: %s", vault_key, e)
            return False

    def _spawn_managed(self, worker_id: str, w: dict) -> dict:
        """Spawn a directly-managed worker process."""
        entry = w.get("entry")
        if not entry:
            return {"success": False, "error": f"No entry point for {worker_id}"}

        entry_path = config.OPAI_ROOT / entry
        if not entry_path.exists():
            return {"success": False, "error": f"Entry not found: {entry_path}"}

        # Decrypt vault credentials first
        for vault_key in w.get("vault_keys", []):
            self._decrypt_vault_for(vault_key)

        # Build command
        runtime = w.get("runtime", "node")
        if runtime == "node":
            cmd = ["node", str(entry_path)]
        elif runtime == "python":
            cmd = ["python3", str(entry_path)]
        elif entry_path.suffix == ".sh":
            cmd = ["bash", str(entry_path)]
        else:
            cmd = [str(entry_path)]

        cwd = str(entry_path.parent)
        env = self._build_managed_env(w)

        # Initialize log ring buffer (500 lines)
        self._managed_logs.setdefault(worker_id, deque(maxlen=500))

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,  # Merge stderr into stdout
                env=env,
                cwd=cwd,
                text=True,
                bufsize=1,  # Line buffered
            )
            self._managed_procs[worker_id] = proc
            self._started_at[worker_id] = time.time()
            self._managed_auto_restart[worker_id] = True

            # Start async log drain thread
            import threading
            threading.Thread(
                target=self._drain_logs, args=(worker_id, proc), daemon=True
            ).start()

            logger.info("Spawned managed worker %s (PID %d): %s", worker_id, proc.pid, " ".join(cmd))
            return {"success": True, "pid": proc.pid}
        except Exception as e:
            logger.error("Failed to spawn %s: %s", worker_id, e)
            return {"success": False, "error": str(e)}

    def _drain_logs(self, worker_id: str, proc: subprocess.Popen):
        """Background thread: drain stdout lines into ring buffer."""
        buf = self._managed_logs.get(worker_id)
        if not buf:
            return
        try:
            for line in proc.stdout:
                ts = datetime.now().strftime("%H:%M:%S")
                buf.append(f"[{ts}] {line.rstrip()}")
        except (ValueError, OSError):
            pass  # Pipe closed

    def _kill_managed(self, worker_id: str) -> dict:
        """Stop a directly-managed worker process."""
        proc = self._managed_procs.get(worker_id)
        if not proc:
            return {"success": False, "error": f"No managed process for {worker_id}"}

        self._managed_auto_restart[worker_id] = False  # Don't auto-restart after stop

        try:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            logger.info("Stopped managed worker %s (PID %d)", worker_id, proc.pid)
        except Exception as e:
            logger.error("Error stopping %s: %s", worker_id, e)
            return {"success": False, "error": str(e)}
        finally:
            self._managed_procs.pop(worker_id, None)
            self._started_at.pop(worker_id, None)

        return {"success": True}

    def _is_managed_running(self, worker_id: str) -> bool:
        """Check if a managed process is still running."""
        proc = self._managed_procs.get(worker_id)
        if not proc:
            return False
        return proc.poll() is None

    # ── Service Lifecycle (systemd-backed) ─────────────────────

    def _systemctl(self, action: str, unit: str) -> dict:
        """Run a systemctl --user command."""
        svc = unit if "." in unit else f"{unit}.service"
        try:
            result = subprocess.run(
                ["systemctl", "--user", action, svc],
                capture_output=True, text=True, timeout=15,
            )
            return {
                "success": result.returncode == 0,
                "output": result.stdout.strip(),
                "error": result.stderr.strip() if result.returncode != 0 else None,
            }
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "timeout"}

    def _is_active(self, unit: str) -> bool:
        """Check if a systemd unit is active."""
        result = self._systemctl("is-active", unit)
        return result.get("output") == "active"

    def start_worker(self, worker_id: str) -> dict:
        """Start a long-running or hybrid worker."""
        w = self.workers.get(worker_id)
        if not w:
            return {"success": False, "error": f"Unknown worker: {worker_id}"}

        if self._is_managed(w):
            return self._spawn_managed(worker_id, w)

        unit = w.get("systemd_unit")
        if not unit:
            return {"success": False, "error": f"Worker {worker_id} has no systemd_unit or managed flag"}

        result = self._systemctl("start", unit)
        if result["success"]:
            self._started_at[worker_id] = time.time()
            logger.info("Started worker %s (%s)", worker_id, unit)
        return result

    def stop_worker(self, worker_id: str) -> dict:
        """Stop a long-running or hybrid worker."""
        w = self.workers.get(worker_id)
        if not w:
            return {"success": False, "error": f"Unknown worker: {worker_id}"}

        if self._is_managed(w):
            return self._kill_managed(worker_id)

        unit = w.get("systemd_unit")
        if not unit:
            return {"success": False, "error": f"Worker {worker_id} has no systemd_unit"}

        result = self._systemctl("stop", unit)
        if result["success"]:
            self._started_at.pop(worker_id, None)
            logger.info("Stopped worker %s (%s)", worker_id, unit)
        return result

    def restart_worker(self, worker_id: str) -> dict:
        """Restart a worker."""
        w = self.workers.get(worker_id)
        if not w:
            return {"success": False, "error": f"Unknown worker: {worker_id}"}

        if self._is_managed(w):
            self._kill_managed(worker_id)
            result = self._spawn_managed(worker_id, w)
            if result["success"]:
                self.restart_counts[worker_id] = self.restart_counts.get(worker_id, 0) + 1
            return result

        unit = w.get("systemd_unit")
        if not unit:
            return {"success": False, "error": f"Worker {worker_id} has no systemd_unit"}

        result = self._systemctl("restart", unit)
        if result["success"]:
            self.restart_counts[worker_id] = self.restart_counts.get(worker_id, 0) + 1
            self._started_at[worker_id] = time.time()
            logger.info("Restarted worker %s (%s)", worker_id, unit)
        return result

    # ── Health Checks ──────────────────────────────────────────

    async def health_check_all(self) -> dict:
        """Check health of all long-running and hybrid workers."""
        results = {}

        async with httpx.AsyncClient(timeout=5.0) as client:
            for wid, w in self.workers.items():
                wtype = w.get("type")
                if wtype not in ("long-running", "hybrid"):
                    continue

                hc_url = w.get("health_check")
                unit = w.get("systemd_unit")

                if hc_url:
                    # HTTP health check
                    try:
                        r = await client.get(hc_url)
                        data = r.json() if r.status_code == 200 else {}
                        results[wid] = {
                            "healthy": r.status_code == 200,
                            "uptime_seconds": data.get("uptime_seconds"),
                            "memory_mb": data.get("memory_mb"),
                        }
                    except Exception:
                        results[wid] = {"healthy": False}
                elif self._is_managed(w):
                    # Direct process check
                    alive = self._is_managed_running(wid)
                    results[wid] = {"healthy": alive}
                elif unit:
                    # systemd process check
                    active = self._is_active(unit)
                    results[wid] = {"healthy": active}
                else:
                    results[wid] = {"healthy": None}

        self.health = {wid: r.get("healthy") for wid, r in results.items()}
        self.last_health_check = time.time()

        # Auto-restart crashed managed workers
        for wid, w in self.workers.items():
            if not self._is_managed(w):
                continue
            if not w.get("restart_on_failure"):
                continue
            if self._is_managed_running(wid):
                continue
            if not self._managed_auto_restart.get(wid, False):
                continue  # Explicitly stopped, don't restart
            max_restarts = w.get("max_restarts", 5)
            if self.restart_counts.get(wid, 0) >= max_restarts:
                continue
            delay = w.get("restart_delay_sec", 30)
            since = time.time() - self._started_at.get(wid, 0)
            if since < delay:
                continue  # Too soon to restart
            logger.warning("Auto-restarting crashed managed worker %s", wid)
            self._spawn_managed(wid, w)
            self.restart_counts[wid] = self.restart_counts.get(wid, 0) + 1

        return results

    # ── Task Workers (subprocess) ──────────────────────────────

    async def run_task_worker(
        self, worker_id: str, task_context: Optional[dict] = None,
        workspace_path: Optional[Path] = None,
    ) -> dict:
        """Run a task worker (one-shot) via claude CLI.

        Args:
            worker_id: Registered worker ID from workers.json.
            task_context: Optional dict injected into the prompt.
            workspace_path: Optional isolated workspace dir (from fleet coordinator).
                           When set, the worker runs in this directory and output
                           is also written to workspace_path/output/.
        """
        w = self.workers.get(worker_id)
        if not w:
            return {"status": "error", "error": f"Unknown worker: {worker_id}"}
        if w.get("type") != "task":
            return {"status": "error", "error": f"Worker {worker_id} is not a task worker"}

        guardrails = w.get("guardrails", {})
        max_per_hour = guardrails.get("max_actions_per_hour", 0)
        if max_per_hour and not self.rate_limiter.check(worker_id, max_per_hour):
            return {"status": "rate_limited", "error": "Rate limit exceeded"}

        # Load prompt
        prompt = self._load_prompt(w, task_context)
        if not prompt:
            return {"status": "error", "error": "Could not load prompt"}

        # Build command
        cmd = ["claude", "-p", "--output-format", "text"]
        max_turns = guardrails.get("max_turns")
        if max_turns:
            cmd.extend(["--max-turns", str(max_turns)])

        timeout = guardrails.get("timeout_minutes", 10) * 60

        # Build environment
        env = dict(os.environ)
        env.pop("CLAUDECODE", None)  # Prevent nested spawn blocking
        model = guardrails.get("model")
        if model:
            env["CLAUDE_MODEL"] = model
        # Ensure nvm node is on PATH for claude CLI
        if NVM_NODE_BIN not in env.get("PATH", ""):
            env["PATH"] = f"{NVM_NODE_BIN}:{env.get('PATH', '')}"

        # Fleet workspace support (v3.5)
        if workspace_path:
            env["AGENT_WORKSPACE"] = str(workspace_path)

        # Determine working directory
        cwd = str(workspace_path) if workspace_path else str(config.OPAI_ROOT)

        logger.info("Running task worker %s (timeout=%ds, cwd=%s)", worker_id, timeout, cwd)

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=cwd,
            )
            self.task_processes[worker_id] = proc

            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=prompt.encode()), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            self.task_processes.pop(worker_id, None)
            logger.warning("Task worker %s timed out after %ds", worker_id, timeout)
            return {"status": "timed_out", "error": f"Killed after {timeout}s"}
        except Exception as e:
            self.task_processes.pop(worker_id, None)
            return {"status": "error", "error": str(e)}

        self.task_processes.pop(worker_id, None)
        output_text = stdout.decode(errors="replace")

        # Save output to report file
        output_path = self._save_output(w, worker_id, output_text)

        # If fleet workspace, also write output there
        if workspace_path:
            try:
                ws_output_dir = workspace_path / "output"
                ws_output_dir.mkdir(parents=True, exist_ok=True)
                (ws_output_dir / "result.txt").write_text(output_text)
            except OSError as e:
                logger.warning("Failed to write workspace output: %s", e)

        status = "completed" if proc.returncode == 0 else "failed"
        logger.info(
            "Task worker %s %s (exit=%d, output=%s)",
            worker_id, status, proc.returncode, output_path,
        )

        return {
            "status": status,
            "exit_code": proc.returncode,
            "output_path": str(output_path) if output_path else None,
            "output_length": len(output_text),
        }

    def get_available_workers(self) -> list[str]:
        """Return task workers not currently running and within rate limits.

        Used by fleet coordinator for routing decisions.
        """
        available = []
        for wid, w in self.workers.items():
            if w.get("type") != "task":
                continue

            # Check not currently running
            if wid in self.task_processes:
                proc = self.task_processes[wid]
                if proc.returncode is None:
                    continue  # Still running

            # Check rate limit (peek, don't consume)
            guardrails = w.get("guardrails", {})
            max_per_hour = guardrails.get("max_actions_per_hour", 0)
            if max_per_hour:
                count = self.rate_limiter.get_count(wid)
                if count >= max_per_hour:
                    continue

            available.append(wid)

        return available

    def _load_prompt(self, w: dict, task_context: Optional[dict]) -> Optional[str]:
        """Load a worker's prompt file, optionally injecting task context.

        If prompt_protection is enabled, tries vault first (synchronous fallback
        reads the vault env file). Otherwise loads directly from the prompt file.
        """
        guardrails = w.get("guardrails", {})

        # Vault-protected prompts: check vault env file for prompt key
        if guardrails.get("prompt_protection"):
            for vault_key in w.get("vault_keys", []):
                vault_env_file = Path(
                    os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
                ) / "opai-vault" / f"{vault_key}.env"
                if vault_env_file.is_file():
                    for line in vault_env_file.read_text().splitlines():
                        if line.startswith("WORKER_PROMPT="):
                            prompt = line.split("=", 1)[1].strip('"')
                            if prompt and task_context:
                                prompt += self._format_context(task_context)
                            if prompt:
                                return prompt
            # Fall through to file if vault has no WORKER_PROMPT key

        prompt_file = w.get("prompt_file")
        if not prompt_file:
            return None

        prompt_path = config.OPAI_ROOT / prompt_file
        if not prompt_path.is_file():
            logger.error("Prompt file not found: %s", prompt_path)
            return None

        prompt = prompt_path.read_text()

        if task_context:
            prompt += self._format_context(task_context)

        return prompt

    @staticmethod
    def _format_context(task_context: dict) -> str:
        """Format task context as an appendable block."""
        block = "\n\n--- TASK CONTEXT ---\n"
        for key, val in task_context.items():
            block += f"{key}: {val}\n"
        block += "--- END CONTEXT ---\n"
        return block

    def _save_output(self, w: dict, worker_id: str, output: str) -> Optional[Path]:
        """Save task worker output to the configured report path."""
        pattern = w.get("output")
        if not pattern:
            return None

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        path_str = pattern.replace("{date}", today).replace("{worker-name}", worker_id)
        output_path = config.REPORTS_DIR / path_str
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output)
        return output_path

    # ── Worker Logs ────────────────────────────────────────────

    def get_worker_logs(self, worker_id: str, lines: int = 50) -> list[str]:
        """Get recent logs for a worker."""
        w = self.workers.get(worker_id)
        if not w:
            return []

        # Engine-managed: return from ring buffer
        if self._is_managed(w):
            buf = self._managed_logs.get(worker_id, deque())
            return list(buf)[-lines:]

        # Systemd-backed: query journalctl
        unit = w.get("systemd_unit")
        if not unit:
            return []

        svc = unit if "." in unit else f"{unit}.service"
        try:
            result = subprocess.run(
                ["journalctl", "--user", "-u", svc, "-n", str(lines), "--no-pager"],
                capture_output=True, text=True, timeout=10,
            )
            return result.stdout.strip().split("\n") if result.stdout.strip() else []
        except Exception:
            return []

    # ── Status / Dashboard ─────────────────────────────────────

    def get_status(self) -> dict:
        """Return worker status for the dashboard API."""
        result = {}
        for wid, w in self.workers.items():
            wtype = w.get("type", "unknown")

            running = None
            if self._is_managed(w):
                running = self._is_managed_running(wid)
            elif w.get("systemd_unit"):
                running = self._is_active(w["systemd_unit"])
            elif wid in self.task_processes:
                proc = self.task_processes[wid]
                running = proc.returncode is None

            managed = self._is_managed(w)
            pid = None
            if managed and wid in self._managed_procs:
                pid = self._managed_procs[wid].pid

            result[wid] = {
                "name": w.get("name", wid),
                "type": wtype,
                "runtime": w.get("runtime"),
                "port": w.get("port"),
                "healthy": self.health.get(wid),
                "running": running,
                "managed": managed,
                "pid": pid,
                "restarts": self.restart_counts.get(wid, 0),
                "rate_count": self.rate_limiter.get_count(wid),
                "trigger": w.get("trigger", {}).get("mode"),
            }
        return result

    def get_worker_detail(self, worker_id: str) -> Optional[dict]:
        """Return detailed info for a single worker."""
        w = self.workers.get(worker_id)
        if not w:
            return None

        running = None
        uptime = None
        managed = self._is_managed(w)
        pid = None

        if managed:
            running = self._is_managed_running(worker_id)
            if running and worker_id in self._managed_procs:
                pid = self._managed_procs[worker_id].pid
        elif w.get("systemd_unit"):
            running = self._is_active(w["systemd_unit"])

        if running and worker_id in self._started_at:
            uptime = int(time.time() - self._started_at[worker_id])

        return {
            **w,
            "id": worker_id,
            "running": running,
            "managed": managed,
            "pid": pid,
            "healthy": self.health.get(worker_id),
            "restarts": self.restart_counts.get(worker_id, 0),
            "uptime_seconds": uptime,
            "rate_count": self.rate_limiter.get_count(worker_id),
            "last_health_check": self.last_health_check,
        }

    # ── Managed Worker Lifecycle ─────────────────────────────────

    def startup_managed_workers(self):
        """Start all engine-managed workers on engine startup."""
        for wid, w in self.workers.items():
            if not self._is_managed(w):
                continue
            logger.info("Auto-starting managed worker: %s", wid)
            result = self._spawn_managed(wid, w)
            if not result.get("success"):
                logger.error("Failed to auto-start %s: %s", wid, result.get("error"))

    def shutdown_managed_workers(self):
        """Stop all engine-managed worker processes on engine shutdown."""
        for wid in list(self._managed_procs.keys()):
            logger.info("Shutting down managed worker: %s", wid)
            self._kill_managed(wid)

    # ── Prompt Loading (with vault protection) ─────────────────

    async def load_protected_prompt(self, worker_id: str) -> Optional[str]:
        """Load a worker prompt from vault if prompt_protection is enabled."""
        w = self.workers.get(worker_id)
        if not w:
            return None

        guardrails = w.get("guardrails", {})
        if not guardrails.get("prompt_protection"):
            return self._load_prompt(w, None)

        # Fetch from vault API
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{VAULT_API}/vault/api/secrets/prompts/{worker_id}")
                if r.status_code == 200:
                    data = r.json()
                    return data.get("value", "")
        except Exception as e:
            logger.warning("Vault prompt fetch failed for %s: %s", worker_id, e)

        # Fallback to file
        logger.info("Falling back to file prompt for %s", worker_id)
        return self._load_prompt(w, None)

    # ── Background Health Loop ─────────────────────────────────

    async def health_loop(self, interval: int = 60):
        """Periodically check health of all long-running/hybrid workers."""
        while True:
            try:
                await self.health_check_all()
            except Exception as e:
                logger.error("Worker health check failed: %s", e)
            await asyncio.sleep(interval)
