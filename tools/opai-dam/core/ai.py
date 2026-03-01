"""DAM Bot — Claude AI caller.

Delegates to shared claude_api wrapper which handles:
- API mode (ANTHROPIC_API_KEY set): Anthropic SDK with optional PTC
- CLI fallback (no key): Claude CLI subprocess (subscription-based)

Preserves the same call_claude() interface used by planner, executor, etc.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

# Shared wrapper
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from claude_api import call_claude as _shared_call, call_claude_ptc, _extract_json  # noqa: E402

import config  # noqa: E402

log = logging.getLogger("dam.ai")

DAM_SYSTEM_PROMPT = """\
You are DAM Bot (Do Anything Mode), a meta-orchestrator for the OPAI platform.
Your role is to take any goal — a PRD, an idea, a business plan — and decompose it
into an executable plan of concrete steps that can be delegated to existing OPAI agents,
squads, and tools.

When decomposing a goal into steps, output a JSON array. Each step object has:
- "title": short action title
- "description": what this step does
- "step_type": one of "agent_run", "squad_run", "tool_call", "approval_gate", "hook", "skill_call"
- "config": type-specific config object
  - For agent_run: {"agent_id": "...", "prompt": "..."}
  - For squad_run: {"squad_id": "...", "context": "..."}
  - For tool_call: {"tool": "...", "params": {...}}
  - For approval_gate: {"reason": "...", "risk_level": "low|medium|high|critical"}
  - For skill_call: {"skill_name": "...", "params": {...}}
- "depends_on": array of step indices (0-based) this step waits for
- "approval_required": boolean — true if this step needs human approval before executing

Be practical and concrete. Use existing agents where possible. Add approval gates
before any irreversible, external-facing, or financial actions.

Output ONLY valid JSON — no markdown fences, no explanation.
"""


async def call_claude(
    user_prompt: str,
    system_prompt: str | None = None,
    max_tokens: int = 8192,
    expect_json: bool = False,
) -> dict:
    """Call Claude with optional system prompt. Returns result dict.

    Interface-compatible with the original DAM ai.py:
        {content, parsed, tokens_used, cost_usd, model, duration_ms}
    """
    system = system_prompt or DAM_SYSTEM_PROMPT
    model = config.CLAUDE_MODEL

    result = await _shared_call(
        user_prompt,
        system=system,
        model=model,
        max_tokens=max_tokens,
        expect_json=expect_json,
        timeout=180,
        api_key=config.ANTHROPIC_API_KEY or None,
    )

    log.info("Claude call: mode=%s, cost=$%.4f, duration=%dms",
             result["mode"], result["cost_usd"], result["duration_ms"])

    return result
