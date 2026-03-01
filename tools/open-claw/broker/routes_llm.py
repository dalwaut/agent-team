"""LLM Proxy — Broker-side endpoint that runs Claude CLI on behalf of containers.

Containers cannot call the Anthropic API directly (OPAI uses the Claude
subscription, not an API key). Instead they POST to /oc/api/llm/chat and
the broker runs `claude -p` as a subprocess.

Security:
- Authenticated via per-instance callback token (not admin JWT)
- Rate-limited per instance (requests/hour, tokens/day)
- Concurrent CLI calls capped by semaphore
- Full audit trail
"""

import asyncio
import json
import time
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

import config
from container_auth import require_container_auth

router = APIRouter(prefix="/oc/api/llm", tags=["llm-proxy"])

# ── Rate Limiting ────────────────────────────────────────────

# Per-instance tracking: {slug: {requests: [(timestamp, tokens)], ...}}
_usage = defaultdict(lambda: {"requests": [], "total_tokens": 0, "last_reset": time.time()})

# Limits per tier
TIER_LIMITS = {
    "internal": {"max_rpm": 30, "max_rph": 300, "max_tokens_day": 500_000},
    "starter":  {"max_rpm": 10, "max_rph": 100, "max_tokens_day": 100_000},
    "pro":      {"max_rpm": 20, "max_rph": 200, "max_tokens_day": 300_000},
}

# Semaphore: max concurrent claude CLI calls on the host
_cli_semaphore = asyncio.Semaphore(config.LLM_MAX_CONCURRENT)


def _check_rate_limit(slug: str, tier: str):
    """Check if the instance is within rate limits. Raises HTTPException if not."""
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["starter"])
    usage = _usage[slug]
    now = time.time()

    # Reset daily token counter every 24h
    if now - usage["last_reset"] > 86400:
        usage["total_tokens"] = 0
        usage["last_reset"] = now

    # Clean old request timestamps (keep last hour)
    usage["requests"] = [(ts, tok) for ts, tok in usage["requests"] if now - ts < 3600]

    # Check requests per minute
    recent_minute = [r for r in usage["requests"] if now - r[0] < 60]
    if len(recent_minute) >= limits["max_rpm"]:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit: {limits['max_rpm']} requests/minute exceeded",
        )

    # Check requests per hour
    if len(usage["requests"]) >= limits["max_rph"]:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit: {limits['max_rph']} requests/hour exceeded",
        )

    # Check daily token budget
    if usage["total_tokens"] >= limits["max_tokens_day"]:
        raise HTTPException(
            status_code=429,
            detail=f"Daily token budget ({limits['max_tokens_day']:,}) exhausted",
        )


def _record_usage(slug: str, tokens: int):
    """Record a completed request's usage."""
    usage = _usage[slug]
    usage["requests"].append((time.time(), tokens))
    usage["total_tokens"] += tokens


# ── Models ──────────────────────────────────────────────────

class LLMChatRequest(BaseModel):
    messages: list[dict]  # [{role: "user", content: "..."}, ...]
    system: Optional[str] = None
    max_tokens: int = 4096


class LLMChatResponse(BaseModel):
    reply: str
    model: str = "claude-cli"
    input_tokens: int = 0
    output_tokens: int = 0
    duration_ms: int = 0


# ── Claude CLI Runner ─────────────────────────────────────

async def _run_claude_cli(prompt: str, system: Optional[str] = None) -> dict:
    """Run `claude -p` and return the output.

    Uses asyncio subprocess so it doesn't block the event loop.
    The semaphore limits concurrent calls.
    """
    async with _cli_semaphore:
        cmd = [
            config.CLAUDE_CLI_PATH,
            "-p",
            prompt,
            "--output-format", "text",
        ]

        if system:
            cmd.extend(["--system-prompt", system])

        start = time.monotonic()

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_build_cli_env(),
            )

            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=config.LLM_REQUEST_TIMEOUT,
            )

        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            raise HTTPException(status_code=504, detail=f"Claude CLI timed out ({config.LLM_REQUEST_TIMEOUT}s)")

        duration_ms = int((time.monotonic() - start) * 1000)

        if proc.returncode != 0:
            error_msg = stderr.decode(errors="replace").strip()
            # Don't expose internal errors to containers
            raise HTTPException(
                status_code=502,
                detail=f"LLM request failed (exit {proc.returncode})",
            )

        reply = stdout.decode(errors="replace").strip()

        # Rough token estimation (no exact counts from CLI)
        input_tokens = len(prompt.split()) * 2  # rough estimate
        output_tokens = len(reply.split()) * 2

        return {
            "reply": reply,
            "model": "claude-cli",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "duration_ms": duration_ms,
        }


def _build_cli_env() -> dict:
    """Build a clean environment for the Claude CLI subprocess."""
    import os
    env = os.environ.copy()
    # Ensure nvm path is available
    nvm_bin = "/home/dallas/.nvm/versions/node/v20.19.5/bin"
    if nvm_bin not in env.get("PATH", ""):
        env["PATH"] = nvm_bin + ":" + env.get("PATH", "")
    # Remove CLAUDECODE to avoid nested-session detection
    env.pop("CLAUDECODE", None)
    return env


def _format_messages(messages: list[dict], system: Optional[str] = None) -> str:
    """Convert a chat-style messages array into a single prompt string for `claude -p`.

    For multi-turn conversations, we format as a structured prompt that gives
    Claude the conversation context.
    """
    parts = []

    if system:
        parts.append(f"<system>\n{system}\n</system>\n")

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role == "system":
            parts.append(f"<system>\n{content}\n</system>\n")
        elif role == "assistant":
            parts.append(f"<assistant>\n{content}\n</assistant>\n")
        else:
            parts.append(f"<user>\n{content}\n</user>\n")

    return "\n".join(parts)


# ── Endpoints ──────────────────────────────────────────────

@router.post("/chat", response_model=LLMChatResponse)
async def llm_chat(
    body: LLMChatRequest,
    container: dict = Depends(require_container_auth),
):
    """Proxy an LLM chat request from a container through the host Claude CLI.

    The container sends messages in chat format, and we convert them to a
    single prompt for `claude -p`.
    """
    slug = container["slug"]
    tier = container["tier"]

    # Rate limit check
    _check_rate_limit(slug, tier)

    # Format messages into a prompt
    prompt = _format_messages(body.messages, body.system)

    if not prompt.strip():
        raise HTTPException(status_code=400, detail="Empty prompt")

    # Run through Claude CLI
    result = await _run_claude_cli(prompt, body.system)

    # Record usage
    total_tokens = result["input_tokens"] + result["output_tokens"]
    _record_usage(slug, total_tokens)

    return LLMChatResponse(**result)


@router.get("/usage")
async def llm_usage(container: dict = Depends(require_container_auth)):
    """Get current LLM usage stats for the calling container."""
    slug = container["slug"]
    tier = container["tier"]
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["starter"])
    usage = _usage[slug]
    now = time.time()

    # Clean old
    recent = [(ts, tok) for ts, tok in usage["requests"] if now - ts < 3600]
    recent_minute = [r for r in recent if now - r[0] < 60]

    return {
        "slug": slug,
        "tier": tier,
        "requests_this_minute": len(recent_minute),
        "requests_this_hour": len(recent),
        "tokens_today": usage["total_tokens"],
        "limits": limits,
        "next_reset_in": max(0, int(86400 - (now - usage["last_reset"]))),
    }
