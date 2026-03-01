"""HELM — Central Claude AI caller with layered system prompts.

Uses Anthropic SDK when ANTHROPIC_API_KEY is set.
Falls back to Claude CLI subprocess when key is absent (OPAI internal dev mode).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone

import config

log = logging.getLogger("helm.ai")

# Cost per token (Claude Sonnet 4.6) — only tracked when using SDK
INPUT_COST_PER_M = 3.0   # $3 per 1M input tokens
OUTPUT_COST_PER_M = 15.0  # $15 per 1M output tokens


TASK_INSTRUCTIONS = {
    "content_generate": (
        "You are writing content for this business's target audience. "
        "Write in the brand voice described above. Include a clear call-to-action (CTA). "
        "Use H2 and H3 headings for structure. Output in Markdown format. "
        "Target length: 1200-1800 words unless specified otherwise. "
        "Make the content actionable, specific, and valuable to the reader."
    ),
    "social_post": (
        "Write a social media post in the brand voice described above. "
        "Keep it concise and engaging. Include 1-3 relevant hashtags. "
        "Never start the post with 'I' or with a hashtag. "
        "Match the tone and style to the target platform."
    ),
    "parse_business_brief": (
        "Extract structured data from the uploaded business document. "
        "Return a JSON object with all fields you can identify. "
        "For each field, include:\n"
        '  - "value": the extracted value\n'
        '  - "confidence": a float 0.0-1.0 indicating how confident you are\n'
        '  - "source_excerpt": the verbatim text from the document that produced this value\n'
        "\n"
        "Fields to extract:\n"
        "  name, industry, business_type, stage, tagline, description, "
        "tone_of_voice, brand_voice_notes, never_say, target_audience, "
        "pain_points, products (array of {name, description, price}), "
        "revenue_model, goals_3mo, goals_6mo, goals_12mo, "
        "competitors (array of {name, url, notes}), "
        "content_pillars, avoid_topics, "
        "existing_urls (object with social handles and website URL).\n"
        "\n"
        "If a field is not found in the document, omit it entirely. "
        "Return ONLY valid JSON, no markdown fences."
    ),
    "report_weekly": (
        "Generate a weekly business report. Start with a 3-bullet executive summary. "
        "Then include sections for: Content Performance, Social Media, Revenue/Leads, "
        "and Operational Notes. Use concrete numbers where available. "
        "Use trend arrows: up-arrow for improving, down-arrow for declining, right-arrow for stable. "
        "End with exactly 3 specific, actionable recommendations. "
        "Output in Markdown format."
    ),
    "knowledge_update": (
        "Review the recent actions and business context provided. "
        "Suggest knowledge base additions, updates, or retirements. "
        "Return a JSON array of objects, each with:\n"
        '  - "topic": category (e.g., "audience", "product", "competitor")\n'
        '  - "title": short title for the knowledge entry\n'
        '  - "content": the knowledge content\n'
        '  - "action": one of "add", "update", "retire"\n'
        "\n"
        "Return ONLY valid JSON, no markdown fences."
    ),
}


def build_system_prompt(business: dict, task_type: str, extra_context: str = "") -> str:
    """Build layered system prompt for Claude calls."""
    parts = []

    # Layer 1: Identity
    parts.append(
        "You are HELM, an autonomous AI business manager. "
        "You operate businesses on behalf of their owners, handling content, "
        "social media, marketing, and operational tasks."
    )

    # Layer 2: Brand voice
    brand_voice = business.get("brand_voice_notes") or business.get("tone_of_voice")
    if brand_voice:
        parts.append(f"\n## Brand Voice\n{brand_voice}")

    never_say = business.get("never_say")
    if never_say:
        parts.append(f"\n## Never Say\nAvoid these words/phrases: {never_say}")

    # Layer 3: Goals
    goals = []
    for key in ("goals_3mo", "goals_6mo", "goals_12mo"):
        val = business.get(key)
        if val:
            label = key.replace("goals_", "").replace("mo", "-month")
            goals.append(f"- {label} goals: {val}")
    if goals:
        parts.append("\n## Business Goals\n" + "\n".join(goals))

    # Layer 4: Knowledge / extra context
    if extra_context:
        parts.append(f"\n## Additional Context\n{extra_context}")

    # Layer 5: Business profile summary
    biz_name = business.get("name", "Unknown Business")
    industry = business.get("industry", "")
    audience = business.get("target_audience", "")
    profile_lines = [f"\n## Business Profile\n- Name: {biz_name}"]
    if industry:
        profile_lines.append(f"- Industry: {industry}")
    if audience:
        profile_lines.append(f"- Target Audience: {audience}")
    desc = business.get("description")
    if desc:
        profile_lines.append(f"- Description: {desc}")
    parts.append("\n".join(profile_lines))

    # Layer 6: Task-specific instructions
    task_instr = TASK_INSTRUCTIONS.get(task_type, "")
    if task_instr:
        parts.append(f"\n## Task Instructions\n{task_instr}")

    return "\n".join(parts)


async def _call_claude_cli(system_prompt: str, user_prompt: str) -> str:
    """Call Claude via CLI subprocess (OPAI dev mode — no API key required)."""
    full_prompt = (
        f"<system>\n{system_prompt}\n</system>\n\n"
        f"{user_prompt}"
    )

    # Remove CLAUDECODE env var so nested claude spawn is allowed
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)

    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", "--output-format", "text",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(full_prompt.encode()),
            timeout=120,  # 2-minute timeout for long content generation
        )
        if proc.returncode != 0:
            err = stderr.decode()[:300]
            raise RuntimeError(f"Claude CLI exited {proc.returncode}: {err}")
        return stdout.decode().strip()
    except asyncio.TimeoutError:
        raise RuntimeError("Claude CLI timed out after 120s")


async def call_claude(
    business: dict,
    task_type: str,
    user_prompt: str,
    extra_context: str = "",
    max_tokens: int = 4096,
) -> dict:
    """Call Claude with layered business context. Returns result dict.

    Uses Anthropic SDK when ANTHROPIC_API_KEY is set.
    Falls back to Claude CLI subprocess otherwise (OPAI dev/internal mode).
    """
    system_prompt = build_system_prompt(business, task_type, extra_context)
    start = time.time()

    if config.ANTHROPIC_API_KEY:
        # ── SDK path (production / user-supplied API key) ──────────────────
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=config.ANTHROPIC_API_KEY)
        try:
            response = await client.messages.create(
                model=config.CLAUDE_MODEL,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            )
        except Exception as exc:
            log.error("Claude API error for task %s: %s", task_type, exc)
            raise

        duration_ms = int((time.time() - start) * 1000)
        content = response.content[0].text if response.content else ""
        input_tokens = response.usage.input_tokens
        output_tokens = response.usage.output_tokens
        total_tokens = input_tokens + output_tokens
        cost_usd = (input_tokens / 1_000_000 * INPUT_COST_PER_M) + (
            output_tokens / 1_000_000 * OUTPUT_COST_PER_M
        )
        return {
            "content": content,
            "tokens_used": total_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": round(cost_usd, 6),
            "model": config.CLAUDE_MODEL,
            "duration_ms": duration_ms,
        }

    else:
        # ── CLI path (OPAI internal — uses Claude Code subscription) ───────
        log.info("ANTHROPIC_API_KEY not set — using Claude CLI for task %s", task_type)
        try:
            content = await _call_claude_cli(system_prompt, user_prompt)
        except Exception as exc:
            log.error("Claude CLI error for task %s: %s", task_type, exc)
            raise

        duration_ms = int((time.time() - start) * 1000)
        return {
            "content": content,
            "tokens_used": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_usd": 0.0,
            "model": "claude-cli",
            "duration_ms": duration_ms,
        }
