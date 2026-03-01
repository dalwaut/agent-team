"""OPAI Shared — Claude API wrapper with Programmatic Tool Calling (PTC).

Provides a unified interface for Claude invocations:
- **API mode** (ANTHROPIC_API_KEY set): Uses Anthropic SDK with optional PTC
- **CLI fallback** (no key): Spawns `claude -p` subprocess (subscription-based)

PTC (Programmatic Tool Calling) lets Claude write Python code that orchestrates
tool calls in a sandbox. Tool results stay in the sandbox (never enter context),
and only print() output reaches Claude — reducing tokens by 37-98%.

Usage:
    from shared.claude_api import call_claude, call_claude_ptc

    # Standard call (auto-selects API or CLI)
    result = await call_claude("Evaluate this idea", system="You are PRDgent")

    # PTC call (API-only, falls back to standard if no key)
    result = await call_claude_ptc(
        prompt="Evaluate these 5 ideas and generate PRDs for the top ones",
        tools=[{"name": "evaluate_idea", ...}, {"name": "generate_prd", ...}],
    )
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("opai.claude_api")

# ── Pricing (for cost estimation) ─────────────────────────────────────────────

MODEL_PRICING = {
    "claude-sonnet-4-6":  {"input": 3.0, "output": 15.0},
    "claude-haiku-4-5":   {"input": 0.80, "output": 4.0},
    "claude-opus-4-6":    {"input": 15.0, "output": 75.0},
}

DEFAULT_MODEL = "claude-sonnet-4-6"

# ── NVM path helper ───────────────────────────────────────────────────────────

_nvm_bin = Path.home() / ".nvm/versions/node/v20.19.5/bin"


_CLI_STRIP_VARS = {"CLAUDECODE", "ANTHROPIC_API_KEY"}


def _cli_env() -> dict:
    """Build a clean env for Claude CLI (strips CLAUDECODE + API keys, injects nvm)."""
    env = {k: v for k, v in os.environ.items() if k not in _CLI_STRIP_VARS}
    if _nvm_bin.exists():
        env["PATH"] = str(_nvm_bin) + ":" + env.get("PATH", "")
    return env


# ── Standard call (API or CLI) ────────────────────────────────────────────────

async def call_claude(
    prompt: str,
    *,
    system: str | None = None,
    model: str = DEFAULT_MODEL,
    max_tokens: int = 8192,
    expect_json: bool = False,
    timeout: int = 300,
    api_key: str | None = None,
    cli_args: list[str] | None = None,
) -> dict:
    """Call Claude via API (if key available) or CLI fallback.

    Returns:
        {
            "content": str,       # Raw text response
            "parsed": dict|None,  # JSON-parsed if expect_json=True
            "tokens_used": int,   # Input + output (0 for CLI)
            "cost_usd": float,    # Estimated cost (0 for CLI/subscription)
            "model": str,
            "duration_ms": int,
            "mode": "api" | "cli",
        }
    """
    key = api_key if api_key is not None else os.getenv("ANTHROPIC_API_KEY", "")

    if key:
        return await _call_api(
            prompt, system=system, model=model, max_tokens=max_tokens,
            expect_json=expect_json, timeout=timeout, api_key=key,
        )
    else:
        return await _call_cli(
            prompt, system=system, model=model,
            expect_json=expect_json, timeout=timeout,
            extra_args=cli_args,
        )


async def _call_api(
    prompt: str,
    *,
    system: str | None,
    model: str,
    max_tokens: int,
    expect_json: bool,
    timeout: int,
    api_key: str,
) -> dict:
    """Invoke via Anthropic Messages API."""
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=api_key)
    start = time.time()

    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if system:
        kwargs["system"] = system

    try:
        response = await asyncio.wait_for(
            client.messages.create(**kwargs),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        raise RuntimeError(f"Claude API timed out after {timeout}s")

    duration_ms = int((time.time() - start) * 1000)
    content = response.content[0].text if response.content else ""
    inp = response.usage.input_tokens
    out = response.usage.output_tokens
    pricing = MODEL_PRICING.get(model, MODEL_PRICING[DEFAULT_MODEL])
    cost = (inp / 1e6 * pricing["input"]) + (out / 1e6 * pricing["output"])

    result = {
        "content": content,
        "parsed": None,
        "tokens_used": inp + out,
        "input_tokens": inp,
        "output_tokens": out,
        "cost_usd": round(cost, 6),
        "model": model,
        "duration_ms": duration_ms,
        "mode": "api",
    }

    if expect_json:
        result["parsed"] = _extract_json(content)

    return result


async def _call_cli(
    prompt: str,
    *,
    system: str | None,
    model: str,
    expect_json: bool,
    timeout: int,
    extra_args: list[str] | None = None,
) -> dict:
    """Invoke via Claude CLI subprocess (subscription-based)."""
    stdin_data = prompt
    if system:
        stdin_data = f"<system>\n{system}\n</system>\n\n{prompt}"

    # Map model names to CLI model flags
    model_flag = model
    if model and not model.startswith("claude-"):
        model_map = {"sonnet": "sonnet", "haiku": "haiku", "opus": "opus"}
        model_flag = model_map.get(model, model)

    cmd = ["claude", "-p", "--output-format", "text"]
    if model_flag:
        cmd.extend(["--model", model_flag])
    if extra_args:
        cmd.extend(extra_args)

    env = _cli_env()
    start = time.time()

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=str(Path("/workspace/synced/opai")),
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=stdin_data.encode()),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        raise RuntimeError(f"Claude CLI timed out after {timeout}s")

    duration_ms = int((time.time() - start) * 1000)

    if proc.returncode != 0:
        err = stderr.decode()[:500]
        out = stdout.decode()[:500]
        log.error("Claude CLI failed rc=%d stderr=%r stdout=%r cmd=%s", proc.returncode, err, out, cmd)
        raise RuntimeError(f"Claude CLI exited {proc.returncode}: {err or out}")

    content = stdout.decode().strip()

    result = {
        "content": content,
        "parsed": None,
        "tokens_used": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "model": f"cli:{model_flag}",
        "duration_ms": duration_ms,
        "mode": "cli",
    }

    if expect_json:
        result["parsed"] = _extract_json(content)

    return result


# ── PTC call (API-only, CLI fallback) ─────────────────────────────────────────

async def call_claude_ptc(
    prompt: str,
    tools: list[dict],
    *,
    system: str | None = None,
    model: str = DEFAULT_MODEL,
    max_tokens: int = 16384,
    timeout: int = 600,
    api_key: str | None = None,
    on_tool_call: Optional[callable] = None,
) -> dict:
    """Call Claude with Programmatic Tool Calling (PTC).

    PTC wraps tools in code_execution — Claude writes Python to orchestrate
    tool calls in a sandbox. Only print() output enters context.

    Args:
        prompt: User prompt
        tools: List of tool definitions (name, description, input_schema)
        system: Optional system prompt
        model: Model to use
        on_tool_call: Async callback(tool_name, tool_input) -> tool_result
                      Called when Claude's code invokes a tool
        timeout: Total timeout for the PTC session

    Returns same dict as call_claude, plus:
        "tool_calls": list of {name, input, result} dicts
        "ptc_enabled": bool
    """
    key = api_key if api_key is not None else os.getenv("ANTHROPIC_API_KEY", "")

    if not key:
        log.info("No API key — PTC unavailable, falling back to standard CLI call")
        result = await _call_cli(
            prompt, system=system, model=model,
            expect_json=True, timeout=timeout,
        )
        result["tool_calls"] = []
        result["ptc_enabled"] = False
        return result

    import anthropic

    client = anthropic.AsyncAnthropic(api_key=key)
    start = time.time()

    # Build PTC tool array: code_execution + user tools with allowed_callers
    ptc_tools = [
        {"type": "code_execution_20260120", "name": "code_execution"},
    ]
    for tool in tools:
        ptc_tools.append({
            "name": tool["name"],
            "description": tool.get("description", ""),
            "input_schema": tool.get("input_schema", {"type": "object", "properties": {}}),
            "allowed_callers": ["code_execution_20260120"],
        })

    messages = [{"role": "user", "content": prompt}]
    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "tools": ptc_tools,
        "messages": messages,
    }
    if system:
        kwargs["system"] = system

    tool_calls_log = []
    container_id = None

    # PTC loop: handle tool calls until we get a final response
    for _ in range(20):  # safety limit
        elapsed = time.time() - start
        remaining = timeout - elapsed
        if remaining <= 0:
            raise RuntimeError(f"PTC session timed out after {timeout}s")

        try:
            response = await asyncio.wait_for(
                client.messages.create(**kwargs),
                timeout=min(remaining, 180),
            )
        except asyncio.TimeoutError:
            raise RuntimeError(f"PTC API call timed out (elapsed {elapsed:.0f}s)")

        # Check for tool_use blocks that need execution
        tool_use_blocks = [
            b for b in response.content
            if b.type == "tool_use"
        ]

        if not tool_use_blocks:
            # Final response — no more tool calls
            break

        # Execute each tool call
        tool_results = []
        for block in tool_use_blocks:
            tool_name = block.name
            tool_input = block.input

            # Track container for code_execution reuse
            if hasattr(block, 'container') and block.container:
                container_id = block.container.get("id")

            if on_tool_call and tool_name != "code_execution":
                try:
                    result_content = await on_tool_call(tool_name, tool_input)
                except Exception as exc:
                    result_content = f"Error: {exc}"

                tool_calls_log.append({
                    "name": tool_name,
                    "input": tool_input,
                    "result": str(result_content)[:1000],
                })
            else:
                result_content = ""

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": str(result_content) if result_content else "",
            })

        # Continue conversation with tool results
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})
        kwargs["messages"] = messages

        # Reuse container if available
        if container_id:
            kwargs.setdefault("metadata", {})["container"] = {"id": container_id}

    duration_ms = int((time.time() - start) * 1000)

    # Extract final text from response
    content = ""
    for block in response.content:
        if hasattr(block, "text"):
            content += block.text

    inp = response.usage.input_tokens
    out = response.usage.output_tokens
    pricing = MODEL_PRICING.get(model, MODEL_PRICING[DEFAULT_MODEL])
    cost = (inp / 1e6 * pricing["input"]) + (out / 1e6 * pricing["output"])

    result = {
        "content": content,
        "parsed": _extract_json(content),
        "tokens_used": inp + out,
        "input_tokens": inp,
        "output_tokens": out,
        "cost_usd": round(cost, 6),
        "model": model,
        "duration_ms": duration_ms,
        "mode": "ptc",
        "tool_calls": tool_calls_log,
        "ptc_enabled": True,
    }

    return result


# ── JSON extraction helper ────────────────────────────────────────────────────

def _extract_json(text: str) -> dict | list | None:
    """Extract JSON from Claude response text, handling markdown fences."""
    if not text:
        return None

    # Try direct parse first
    text = text.strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass

    # Strip markdown fences
    if text.startswith("```"):
        lines = text.split("\n", 1)
        if len(lines) > 1:
            text = lines[1].rsplit("```", 1)[0].strip()
            try:
                return json.loads(text)
            except (json.JSONDecodeError, ValueError):
                pass

    # Regex: find first JSON object or array
    for pattern in [
        r'\{[\s\S]*\}',
        r'\[[\s\S]*\]',
    ]:
        match = re.search(pattern, text)
        if match:
            try:
                return json.loads(match.group())
            except (json.JSONDecodeError, ValueError):
                continue

    return None
