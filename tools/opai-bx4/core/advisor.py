"""Bx4 — AI advisor engine using Anthropic Claude SDK."""

from __future__ import annotations

import logging

import anthropic

import config

log = logging.getLogger("bx4.advisor")

# ── Prompt layers ─────────────────────────────────────────────────────────────

_LAYER1_IDENTITY = """\
You are Bx4 -- the BoutaByte Business Bot. You are a senior business strategist, \
financial analyst, and operations advisor. You are pragmatic, data-driven, and direct. \
You exist to keep businesses profitable, growing, and operationally sound.

Non-negotiable rules:
- Every recommendation must include: a data citation, "Why it matters", and "What to do".
- Every recommendation must have urgency (Critical/High/Medium/Low) and financial_impact (Positive/Neutral/Negative).
- Spending recommendations always include: cost estimate, expected return, payback period.
- If data is missing or stale, say so -- never invent metrics.
- Be direct. No hedge language.
- Your north star: keep the business in the green and growing."""

_WING_PROMPTS = {
    "financial": (
        "Analyze cash flow, expense efficiency, revenue growth levers. "
        "Flag metrics outside industry norms. "
        "Output: ranked expense optimizations, cash flow risks, 90-day forecast range."
    ),
    "market": (
        "Research industry trends and competitive positioning. "
        "Focus: what market shifts affect THIS business. "
        "Output: 3 opportunities, 2 threats, 1 SWOT update."
    ),
    "social": (
        "Analyze platform analytics. Do NOT suggest content -- suggest strategy and "
        "resource allocation only. Output: platform health grades, frequency improvement "
        "plan, channel prioritization."
    ),
    "operations": (
        "Review goal progress and KPI status. Output: goal % update, top 3 blockers, "
        "milestone next steps, any new tasks needed."
    ),
}

_DEFAULT_GOAL = (
    "Maximize sustainable revenue growth while maintaining financial stability, "
    "building brand presence, and creating scalable operational systems."
)


def _build_layer2(company: dict, snapshot: dict | None) -> str:
    """Build Layer 2: Company context block."""
    s = snapshot or {}
    triage = "Yes" if s.get("triage_mode") else "No"
    return (
        f"## Company: {company.get('name', 'Unknown')}\n"
        f"Industry: {company.get('industry', 'N/A')} | "
        f"Stage: {company.get('stage', 'N/A')} | "
        f"Employees: {company.get('headcount', 'N/A')}\n"
        f"Revenue Model: {company.get('revenue_model', 'N/A')} | "
        f"Market: {company.get('geo_market', 'N/A')}\n"
        f"Active Goal: \"{company.get('active_goal', _DEFAULT_GOAL)}\"\n\n"
        f"## Financial Snapshot -- {s.get('period', 'N/A')}\n"
        f"Revenue: ${s.get('revenue', 0):,.2f} | "
        f"Expenses: ${s.get('expenses', 0):,.2f} | "
        f"Net: ${s.get('net', 0):,.2f}\n"
        f"Cash on Hand: ${s.get('cash_on_hand', 0):,.2f} | "
        f"Burn: ${s.get('burn_rate', 0):,.2f}/mo | "
        f"Runway: {s.get('runway_months', 'N/A')}mo\n"
        f"Health Score: {s.get('health_score', 'N/A')}/100 "
        f"({s.get('health_grade', 'N/A')})\n"
        f"Triage Mode: {triage}"
    )


def _build_layer4(goal: str | None) -> str:
    """Build Layer 4: Goal lens."""
    g = goal or _DEFAULT_GOAL
    return (
        f"# Goal Context\n"
        f"Primary objective: \"{g}\"\n"
        f"- Moves toward goal -> include, boost priority\n"
        f"- Protects ability to reach goal -> include\n"
        f"- Risks goal -> FLAG prominently first\n"
        f"- Unrelated -> only if critical/high urgency"
    )


def build_prompt(
    company: dict,
    snapshot: dict | None,
    wing: str | None,
    mode: str,
    user_message: str | None,
    goal: str | None,
) -> list[dict]:
    """Assemble the 4-layer system prompt and return messages list for Anthropic API.

    Parameters
    ----------
    company : dict
        Company profile data.
    snapshot : dict | None
        Latest financial snapshot.
    wing : str | None
        Analysis wing (financial/market/social/operations) or None for chat.
    mode : str
        "analysis", "chat", or "pulse".
    user_message : str | None
        User message for chat mode.
    goal : str | None
        Active business goal.

    Returns
    -------
    list[dict]
        Messages list ready for ``anthropic.messages.create()``.
    """
    system_parts = [_LAYER1_IDENTITY, _build_layer2(company, snapshot)]

    if wing and wing in _WING_PROMPTS:
        system_parts.append(f"## Wing Focus: {wing.title()}\n{_WING_PROMPTS[wing]}")

    system_parts.append(_build_layer4(goal))

    system_text = "\n\n".join(system_parts)

    messages: list[dict] = []

    if mode == "analysis":
        messages.append({
            "role": "user",
            "content": (
                f"Run a full {wing or 'general'} analysis for {company.get('name', 'this company')}. "
                "Return structured recommendations as a numbered list. Each recommendation must include: "
                "title, urgency, financial_impact, data_citation, why_it_matters, what_to_do."
            ),
        })
    elif mode == "pulse":
        messages.append({
            "role": "user",
            "content": (
                f"Quick daily pulse for {company.get('name', 'this company')}. "
                "What needs attention today? Keep it under 5 bullet points. "
                "Lead with the most urgent item."
            ),
        })
    elif mode == "chat" and user_message:
        messages.append({"role": "user", "content": user_message})
    else:
        messages.append({"role": "user", "content": "Provide a general business status summary."})

    return [{"system": system_text, "messages": messages}]


def _get_client() -> anthropic.Anthropic:
    """Return an Anthropic client instance."""
    return anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)


async def run_analysis(
    company: dict, snapshot: dict, wing: str, goal: str | None = None
) -> str:
    """Run a full wing analysis via Claude. Returns the text response."""
    prompt_data = build_prompt(company, snapshot, wing, "analysis", None, goal)
    system_text = prompt_data[0]["system"]
    messages = prompt_data[0]["messages"]

    client = _get_client()
    try:
        response = client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=4096,
            system=system_text,
            messages=messages,
        )
        return response.content[0].text
    except Exception as exc:
        log.error("Advisor analysis failed for %s/%s: %s", company.get("name"), wing, exc)
        return f"Analysis error: {exc}"


async def chat(
    company: dict,
    snapshot: dict,
    user_message: str,
    history: list,
    goal: str | None = None,
) -> str:
    """Conversational advisor mode. Passes history for context continuity."""
    prompt_data = build_prompt(company, snapshot, None, "chat", user_message, goal)
    system_text = prompt_data[0]["system"]

    # Build messages from history + current message
    messages: list[dict] = []
    for msg in history:
        role = msg.get("role", "user")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": msg.get("content", "")})
    messages.append({"role": "user", "content": user_message})

    client = _get_client()
    try:
        response = client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=2048,
            system=system_text,
            messages=messages,
        )
        return response.content[0].text
    except Exception as exc:
        log.error("Advisor chat failed for %s: %s", company.get("name"), exc)
        return f"Chat error: {exc}"


async def quick_pulse(
    company: dict, snapshot: dict, goal: str | None = None
) -> str:
    """Quick 'what needs attention today' call with condensed prompt."""
    prompt_data = build_prompt(company, snapshot, None, "pulse", None, goal)
    system_text = prompt_data[0]["system"]
    messages = prompt_data[0]["messages"]

    client = _get_client()
    try:
        response = client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=1024,
            system=system_text,
            messages=messages,
        )
        return response.content[0].text
    except Exception as exc:
        log.error("Advisor pulse failed for %s: %s", company.get("name"), exc)
        return f"Pulse error: {exc}"
