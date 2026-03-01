"""Claude Code CLI helper — calls claude via subprocess, no API key required."""
import asyncio
import os
from asyncio.subprocess import PIPE


async def call_claude(
    prompt: str,
    model: str = "claude-sonnet-4-6",
    timeout: int = 120,
) -> str:
    """Invoke Claude via the Claude Code CLI.

    Strips CLAUDECODE env var so nested calls are not blocked.
    Returns the plain-text response string.
    Raises RuntimeError on timeout or non-zero exit.
    """
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    proc = await asyncio.create_subprocess_exec(
        "claude", "--print", "--output-format", "text", "--model", model, prompt,
        stdout=PIPE, stderr=PIPE,
        env=env,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"Claude CLI timed out after {timeout}s")
    if proc.returncode != 0:
        err = stderr.decode().strip()[:500]
        raise RuntimeError(f"Claude CLI exited {proc.returncode}: {err}")
    return stdout.decode().strip()
