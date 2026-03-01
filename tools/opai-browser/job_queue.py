"""Async job queue — tracks browser tasks executed via Claude CLI subprocess."""

import asyncio
import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from collections import OrderedDict
from pathlib import Path

import config
import session_manager


class Job:
    """A single browser automation job."""

    def __init__(self, task: str, session: str = "default",
                 vision_ok: bool = False, max_turns: int = None,
                 timeout_sec: int = None, caller: str = None):
        self.id = str(uuid.uuid4())[:12]
        self.task = task
        self.session = session
        self.vision_ok = vision_ok
        self.max_turns = max_turns or config.DEFAULT_MAX_TURNS
        self.timeout_sec = timeout_sec or config.DEFAULT_TIMEOUT_SEC
        self.caller = caller or "api"
        self.status = "queued"  # queued | running | completed | failed | cancelled
        self.result = None
        self.error = None
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.started_at = None
        self.completed_at = None
        self._process: asyncio.subprocess.Process = None
        self._mcp_config_path: str = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "task": self.task,
            "session": self.session,
            "vision_ok": self.vision_ok,
            "max_turns": self.max_turns,
            "timeout_sec": self.timeout_sec,
            "caller": self.caller,
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
        }


class JobQueue:
    """In-memory job queue with async execution."""

    def __init__(self):
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._running = 0
        self._queue: asyncio.Queue = asyncio.Queue()
        self._worker_task: asyncio.Task = None

    def start(self):
        """Start the background worker."""
        self._worker_task = asyncio.create_task(self._worker())

    async def stop(self):
        """Stop the background worker."""
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass

    def submit(self, task: str, session: str = "default",
               vision_ok: bool = False, max_turns: int = None,
               timeout_sec: int = None, caller: str = None) -> Job:
        """Submit a new browser job."""
        job = Job(task, session, vision_ok, max_turns, timeout_sec, caller)
        self._jobs[job.id] = job
        self._trim_history()
        self._queue.put_nowait(job)
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list_jobs(self, limit: int = 50) -> list[dict]:
        """List recent jobs, newest first."""
        jobs = list(self._jobs.values())
        jobs.reverse()
        return [j.to_dict() for j in jobs[:limit]]

    def cancel(self, job_id: str) -> bool:
        """Cancel a running or queued job."""
        job = self._jobs.get(job_id)
        if not job:
            return False
        if job.status == "queued":
            job.status = "cancelled"
            job.completed_at = datetime.now(timezone.utc).isoformat()
            return True
        if job.status == "running" and job._process:
            try:
                job._process.kill()
            except ProcessLookupError:
                pass
            job.status = "cancelled"
            job.completed_at = datetime.now(timezone.utc).isoformat()
            return True
        return False

    async def _worker(self):
        """Background worker that processes jobs from the queue."""
        while True:
            job = await self._queue.get()
            if job.status == "cancelled":
                continue

            # Wait for a slot
            while self._running >= config.MAX_CONCURRENT_JOBS:
                await asyncio.sleep(1)

            asyncio.create_task(self._execute(job))

    async def _execute(self, job: Job):
        """Execute a single browser job via Claude CLI."""
        self._running += 1
        job.status = "running"
        job.started_at = datetime.now(timezone.utc).isoformat()

        try:
            # Ensure session directory exists
            session_dir = session_manager.get_session_dir(job.session)

            # Build temporary MCP config
            mcp_config = config.build_mcp_config(str(session_dir), job.vision_ok)
            tmp = tempfile.NamedTemporaryFile(
                mode="w", prefix="browser-job-", suffix=".json",
                dir="/tmp", delete=False
            )
            json.dump(mcp_config, tmp)
            tmp.close()
            job._mcp_config_path = tmp.name

            # Build prompt with anti-detection hints
            prompt = self._build_prompt(job)

            # Build Claude CLI command
            cmd = [
                config.CLAUDE_BIN,
                "-p", prompt,
                "--output-format", "text",
                "--max-turns", str(job.max_turns),
                "--mcp-config", tmp.name,
            ]

            # Build clean environment (must unset CLAUDECODE to allow nested spawn)
            env = os.environ.copy()
            env.pop("CLAUDECODE", None)
            env.pop("CLAUDE_CODE", None)
            # Ensure npx is on PATH
            env["PATH"] = config.NVM_BIN + ":" + env.get("PATH", "")

            # Run Claude CLI
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            job._process = proc

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=job.timeout_sec,
                )
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
                job.status = "failed"
                job.error = f"Job timed out after {job.timeout_sec}s"
                return

            if job.status == "cancelled":
                return

            if proc.returncode == 0:
                job.status = "completed"
                job.result = stdout.decode("utf-8", errors="replace").strip()
            else:
                job.status = "failed"
                err_text = stderr.decode("utf-8", errors="replace").strip()
                job.error = err_text or f"Claude CLI exited with code {proc.returncode}"

        except Exception as e:
            job.status = "failed"
            job.error = str(e)
        finally:
            self._running -= 1
            job.completed_at = datetime.now(timezone.utc).isoformat()
            job._process = None
            # Cleanup temp MCP config
            if job._mcp_config_path:
                try:
                    os.unlink(job._mcp_config_path)
                except OSError:
                    pass

    def _build_prompt(self, job: Job) -> str:
        """Build the Claude prompt for a browser job."""
        lines = [
            "You have access to a Playwright MCP browser tool. Use it to complete this task:",
            "",
            job.task,
            "",
            "Guidelines:",
            "- Navigate using accessibility tree snapshots, NOT screenshots",
            "- Click elements by their accessible name or role",
            "- Wait briefly between actions (natural pacing)",
            "- If a page has a cookie consent banner, dismiss it first",
            "- Extract and return the requested information as structured text",
        ]
        if not job.vision_ok:
            lines.append("- Do NOT take screenshots — use DOM/accessibility tree only")
        else:
            lines.append("- You may take screenshots ONLY if needed for CAPTCHAs or visual verification")

        return "\n".join(lines)

    def _trim_history(self):
        """Remove oldest completed jobs if over history limit."""
        while len(self._jobs) > config.JOB_HISTORY_MAX:
            oldest_key = next(iter(self._jobs))
            oldest = self._jobs[oldest_key]
            if oldest.status in ("completed", "failed", "cancelled"):
                del self._jobs[oldest_key]
            else:
                break


# Singleton
queue = JobQueue()
