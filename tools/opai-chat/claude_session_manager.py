"""Simplified Claude Code session manager using --print mode."""

import asyncio
import os
import subprocess
import json
from typing import AsyncGenerator, List, Dict


async def stream_claude_response(
    message: str,
    conversation_history: List[Dict[str, str]] = None,
    model: str = "sonnet"
) -> AsyncGenerator[str, None]:
    """Stream response from Claude Code CLI using --print mode.

    Args:
        message: User message to send
        conversation_history: Previous messages in the conversation
        model: Claude model to use (haiku, sonnet, opus)

    Yields:
        Text chunks from Claude's response
    """
    # Build prompt with conversation history
    full_prompt = ""
    if conversation_history:
        for msg in conversation_history:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "user":
                full_prompt += f"User: {content}\n\n"
            else:
                full_prompt += f"Assistant: {content}\n\n"

    full_prompt += f"User: {message}\n\nAssistant:"

    # Run claude --print
    cmd = [
        "claude",
        "--print",
        "--verbose",
        "--output-format=stream-json",
        "--model", model,
        full_prompt
    ]

    # Clean env: remove CLAUDECODE so the CLI doesn't refuse to run
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    print(f"[CLAUDE] Running: {' '.join(cmd[:4])}... (model={model})")

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd="/workspace/synced/opai"
    )

    # Stream output
    yielded_any = False
    try:
        while True:
            line = await process.stdout.readline()
            if not line:
                break

            try:
                data = json.loads(line.decode())
                event_type = data.get("type")

                # verbose stream-json format: extract text from assistant message
                if event_type == "assistant":
                    msg = data.get("message", {})
                    for part in msg.get("content", []):
                        if part.get("type") == "text":
                            text = part.get("text", "")
                            if text:
                                yielded_any = True
                                yield text

                # also handle content_delta if CLI ever uses that format
                elif event_type == "content_delta":
                    text = data.get("text", "")
                    if text:
                        yielded_any = True
                        yield text

            except json.JSONDecodeError:
                # Skip non-JSON lines
                continue

        await process.wait()

        # Log stderr if Claude produced no output
        if not yielded_any:
            stderr = await process.stderr.read()
            if stderr:
                print(f"[CLAUDE] stderr: {stderr.decode()[:500]}")
            print(f"[CLAUDE] No output. Exit code: {process.returncode}")

    except Exception as e:
        print(f"[CLAUDE] Error: {e}")
        process.kill()
        raise


# No session pool needed - each request is independent
session_pool = None  # Placeholder for compatibility
