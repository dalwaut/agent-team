"""OPAI Terminal — Admin-only web terminal with PTY backend.

Provides a browser-based bash shell via xterm.js + WebSocket + PTY.
Also provides a Claude Code terminal at /ws/claude.
Restricted to admin users only. All commands are audit-logged.
"""

import asyncio
import fcntl
import json
import os
import pty
import resource
import signal
import struct
import sys
import termios
import time
from datetime import datetime
from pathlib import Path

_start_time = time.time()

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

import config

# Add shared auth to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from auth import authenticate_websocket, AUTH_DISABLED


app = FastAPI(
    title="OPAI Terminal",
    version="1.0.0",
    description="OPAI Admin Terminal — Browser-based shell access",
)


def _audit_log(user_email: str, event: str, detail: str = ""):
    """Append to audit log."""
    try:
        ts = datetime.utcnow().isoformat() + "Z"
        line = f"[{ts}] user={user_email} event={event}"
        if detail:
            line += f" detail={detail}"
        with open(config.AUDIT_LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


async def _run_pty_session(websocket: WebSocket, user, exec_args: list[str],
                           cwd: str = "/workspace/synced/opai",
                           extra_env: dict[str, str] | None = None,
                           session_type: str = "terminal"):
    """Shared PTY session handler for both bash and claude terminals.

    Args:
        websocket: Authenticated WebSocket connection.
        user: AuthUser from authenticate_websocket.
        exec_args: Command + args to exec (e.g. ["/bin/bash", "--login"]).
        cwd: Working directory for the child process.
        extra_env: Additional env vars to set in the child.
        session_type: Label for audit log entries.
    """
    _audit_log(user.email, f"{session_type}_connect")

    await websocket.send_json({
        "type": "connected",
        "message": f"{session_type.title()} ready — {user.display_name}",
    })

    # Fork PTY — pty.fork() returns (pid, master_fd)
    # pid=0 in child process, pid=child_pid in parent
    child_pid, fd = pty.fork()

    if child_pid == 0:
        # Child process
        os.chdir(cwd)
        os.environ["TERM"] = "xterm-256color"
        os.environ["OPAI_TERMINAL_USER"] = user.email
        # Strip CLAUDECODE to avoid nested session issues
        os.environ.pop("CLAUDECODE", None)
        if extra_env:
            os.environ.update(extra_env)
        os.execvp(exec_args[0], exec_args)
        os._exit(1)

    # Parent process — relay between WebSocket and PTY
    last_activity = time.time()

    # Set PTY to non-blocking
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    async def read_pty():
        nonlocal last_activity
        try:
            while True:
                await asyncio.sleep(0.02)
                try:
                    data = os.read(fd, 4096)
                    if data:
                        last_activity = time.time()
                        await websocket.send_text(data.decode("utf-8", errors="replace"))
                except (OSError, BlockingIOError):
                    try:
                        pid, status = os.waitpid(child_pid, os.WNOHANG)
                        if pid != 0:
                            break
                    except ChildProcessError:
                        break
        except Exception:
            pass

    async def write_pty():
        nonlocal last_activity
        try:
            while True:
                raw = await websocket.receive_text()
                last_activity = time.time()
                try:
                    msg = json.loads(raw)
                    if msg.get("type") == "resize":
                        cols = msg.get("cols", 80)
                        rows = msg.get("rows", 24)
                        winsize = struct.pack("HHHH", rows, cols, 0, 0)
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
                        continue
                    if msg.get("type") == "ping":
                        await websocket.send_json({"type": "pong"})
                        continue
                except (json.JSONDecodeError, TypeError):
                    pass
                os.write(fd, raw.encode("utf-8"))
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    async def idle_watchdog():
        while True:
            await asyncio.sleep(60)
            if time.time() - last_activity > config.IDLE_TIMEOUT:
                _audit_log(user.email, f"{session_type}_idle_timeout")
                try:
                    await websocket.send_json({
                        "type": "system",
                        "message": f"\r\n[Session timed out after {config.IDLE_TIMEOUT // 60} minutes of inactivity]\r\n",
                    })
                    await websocket.close(code=4002, reason="Idle timeout")
                except Exception:
                    pass
                return

    tasks = [
        asyncio.create_task(read_pty()),
        asyncio.create_task(write_pty()),
        asyncio.create_task(idle_watchdog()),
    ]

    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
    finally:
        # Clean up child process — must not block the event loop
        try:
            os.kill(child_pid, signal.SIGTERM)
        except (ProcessLookupError, ChildProcessError, PermissionError):
            pass

        # Non-blocking wait with a timeout so we don't hang
        for _ in range(20):  # up to 2 seconds
            try:
                pid, _ = os.waitpid(child_pid, os.WNOHANG)
                if pid != 0:
                    break
            except (ChildProcessError, OSError):
                break
            await asyncio.sleep(0.1)
        else:
            # Force kill if still alive
            try:
                os.kill(child_pid, signal.SIGKILL)
                os.waitpid(child_pid, os.WNOHANG)
            except (ProcessLookupError, ChildProcessError, PermissionError, OSError):
                pass

        try:
            os.close(fd)
        except OSError:
            pass
        _audit_log(user.email, f"{session_type}_disconnect")


async def _authenticate_admin(websocket: WebSocket):
    """Accept WebSocket, authenticate, require admin. Returns user or None."""
    await websocket.accept()
    try:
        user = await authenticate_websocket(websocket)
        if not user.is_admin:
            await websocket.close(code=4003, reason="Admin access required")
            return None
        return user
    except Exception:
        return None


# ── WebSocket endpoints ───────────────────────────────────

@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    """Bash terminal WebSocket."""
    user = await _authenticate_admin(websocket)
    if not user:
        return
    await _run_pty_session(
        websocket, user,
        exec_args=["/bin/bash", "--login"],
        session_type="terminal",
    )


@app.websocket("/ws/claude")
async def websocket_claude(websocket: WebSocket):
    """Claude Code terminal WebSocket."""
    user = await _authenticate_admin(websocket)
    if not user:
        return

    # Source nvm so node/claude are on PATH
    # We exec bash -c which sources nvm and then runs claude
    nvm_dir = os.path.expanduser("~/.nvm")
    shell_cmd = f'export NVM_DIR="{nvm_dir}" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && exec claude'

    await _run_pty_session(
        websocket, user,
        exec_args=["/bin/bash", "-c", shell_cmd],
        session_type="claude",
    )


# ── HTTP routes ────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


@app.get("/claude")
async def claude_page():
    return FileResponse(str(config.STATIC_DIR / "claude.html"))


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-terminal",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


# Static files
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
