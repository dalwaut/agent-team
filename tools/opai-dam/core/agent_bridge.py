"""DAM Bot — Agent Bridge.

Interface to existing OPAI agent system — calls `claude -p` subprocess
exactly like TCP's auto-executor.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

import config

log = logging.getLogger("dam.agent_bridge")

# Short name → full model ID mapping
MODEL_MAP = {
    "haiku": "claude-haiku-4-5-20251001",
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-6",
}


async def run_agent(
    agent_id: str,
    prompt: str,
    context_path: str | None = None,
    timeout_seconds: int = 300,
    model: str | None = None,
) -> dict:
    """Run a single OPAI agent via claude -p subprocess.

    Args:
        model: Claude model to use (e.g. "haiku", "sonnet", "opus").
               Mapped to full model IDs before passing to --model flag.

    Returns: {"output": str, "duration_ms": int, "success": bool, "error": str|None, "model": str|None}
    """
    # Build prompt with agent identity
    prompt_file = config.OPAI_ROOT / "scripts" / f"prompt_{agent_id}.txt"
    system_context = ""
    if prompt_file.is_file():
        system_context = prompt_file.read_text()[:4000]

    full_prompt = ""
    if system_context:
        full_prompt += f"<system>\n{system_context}\n</system>\n\n"
    full_prompt += prompt

    # Build command
    cmd = ["claude", "-p", "--output-format", "text"]
    if model:
        model_id = MODEL_MAP.get(model, model)
        cmd.extend(["--model", model_id])
        log.info("Agent %s using model: %s (%s)", agent_id, model, model_id)
    if context_path:
        cmd.extend(["--cwd", context_path])

    env = os.environ.copy()
    env.pop("CLAUDECODE", None)

    start = time.time()
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(full_prompt.encode()),
            timeout=timeout_seconds,
        )
        duration_ms = int((time.time() - start) * 1000)

        if proc.returncode != 0:
            err = stderr.decode()[:500]
            return {
                "output": "",
                "duration_ms": duration_ms,
                "success": False,
                "error": f"Agent {agent_id} exited {proc.returncode}: {err}",
                "model": model,
            }

        return {
            "output": stdout.decode().strip(),
            "duration_ms": duration_ms,
            "success": True,
            "error": None,
            "model": model,
        }

    except asyncio.TimeoutError:
        duration_ms = int((time.time() - start) * 1000)
        return {
            "output": "",
            "duration_ms": duration_ms,
            "success": False,
            "error": f"Agent {agent_id} timed out after {timeout_seconds}s",
            "model": model,
        }
    except Exception as exc:
        duration_ms = int((time.time() - start) * 1000)
        return {
            "output": "",
            "duration_ms": duration_ms,
            "success": False,
            "error": str(exc),
            "model": model,
        }


async def run_squad(
    squad_id: str,
    context: str | None = None,
    timeout_seconds: int = 600,
) -> dict:
    """Run an OPAI squad via run_squad.sh.

    Returns: {"output": str, "duration_ms": int, "success": bool, "error": str|None}
    """
    script = config.OPAI_ROOT / "scripts" / "run_squad.sh"
    if not script.is_file():
        return {
            "output": "",
            "duration_ms": 0,
            "success": False,
            "error": "run_squad.sh not found",
        }

    cmd = [str(script), "-s", squad_id]

    env = os.environ.copy()
    env.pop("CLAUDECODE", None)

    start = time.time()
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=str(config.OPAI_ROOT),
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout_seconds,
        )
        duration_ms = int((time.time() - start) * 1000)

        return {
            "output": stdout.decode()[-2000:],
            "duration_ms": duration_ms,
            "success": proc.returncode == 0,
            "error": stderr.decode()[:500] if proc.returncode != 0 else None,
        }

    except asyncio.TimeoutError:
        duration_ms = int((time.time() - start) * 1000)
        return {
            "output": "",
            "duration_ms": duration_ms,
            "success": False,
            "error": f"Squad {squad_id} timed out after {timeout_seconds}s",
        }
