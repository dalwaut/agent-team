"""Bx4 — Briefings wing: generation, storage, Discord/email dispatch."""

from __future__ import annotations

import logging

import anthropic
import httpx

import config

log = logging.getLogger("bx4.wings.briefings")


# ── Supabase helpers ──────────────────────────────────────────────────────────

def _sb_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_sb_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, payload: dict, prefer: str = "return=representation") -> list | dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url, headers={**_sb_headers(), "Prefer": prefer}, json=payload)
        r.raise_for_status()
        if prefer == "return=minimal":
            return {}
        return r.json()


async def _sb_patch(path: str, filter_str: str, payload: dict) -> None:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{filter_str}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.patch(url, headers={**_sb_headers(), "Prefer": "return=minimal"}, json=payload)
        r.raise_for_status()


def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)


# ── Briefing generation ───────────────────────────────────────────────────────

async def generate_briefing(
    company: dict,
    snapshot: dict | None,
    briefing_type: str,
    goal: str | None = None,
    recommendations: list[dict] | None = None,
) -> dict:
    """Generate a briefing using Claude. Returns {title, summary, content}."""
    s = snapshot or {}
    recs = recommendations or []
    co_name = company.get("name", "Unknown Company")

    # Summarize top recommendations for context
    rec_context = ""
    if recs:
        top = recs[:5]
        rec_context = "\n".join(
            f"- [{r.get('urgency', 'medium').upper()}] {r.get('title', '')} — {r.get('what_to_do', '')}"
            for r in top
        )

    snap_context = (
        f"Revenue: ${s.get('revenue', 0):,.0f} | "
        f"Expenses: ${s.get('expenses', 0):,.0f} | "
        f"Net: ${s.get('net', 0):,.0f} | "
        f"Cash: ${s.get('cash_on_hand', 0):,.0f} | "
        f"Runway: {s.get('runway_months', 'N/A')}mo | "
        f"Health: {s.get('health_score', 'N/A')}/100"
    ) if s else "No financial snapshot available."

    system_text = (
        "You are Bx4 — the BoutaByte Business Bot. You write crisp, actionable business briefings. "
        "Be direct, data-driven, and human. No fluff. Use markdown headers for structure."
    )

    if briefing_type in ("daily", "pulse"):
        user_msg = (
            f"Write a daily briefing for {co_name}.\n\n"
            f"Financial snapshot: {snap_context}\n"
            + (f"Active goal: {goal}\n" if goal else "")
            + (f"\nPriority actions:\n{rec_context}\n" if rec_context else "")
            + "\n## Today's Business Pulse\n"
            "3-5 key status points, most urgent first.\n\n"
            "## Priority Actions\n"
            "Top 3 actionable items with clear next steps.\n\n"
            "## Watch\n"
            "One risk or metric to monitor today."
        )
    else:
        user_msg = (
            f"Write a weekly executive briefing for {co_name}.\n\n"
            f"Financial snapshot: {snap_context}\n"
            + (f"Active goal: {goal}\n" if goal else "")
            + (f"\nPriority recommendations:\n{rec_context}\n" if rec_context else "")
            + "\n## Week in Review\n"
            "Business status summary — what moved this week.\n\n"
            "## Financial Highlights\n"
            "Key numbers and what they mean.\n\n"
            "## Top 3 Priorities This Week\n"
            "Ranked by urgency with clear owner and action.\n\n"
            "## Looking Ahead\n"
            "One strategic insight or upcoming decision."
        )

    client = _client()
    try:
        resp = client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=2048,
            system=system_text,
            messages=[{"role": "user", "content": user_msg}],
        )
        content = resp.content[0].text
    except Exception as exc:
        log.error("Briefing generation failed: %s", exc)
        content = f"Briefing generation error: {exc}"

    # Extract title from first header line
    lines = content.strip().split("\n")
    title_line = next((l for l in lines if l.strip().startswith("#")), lines[0] if lines else "")
    title = title_line.lstrip("#").strip() or f"{co_name} {briefing_type.title()} Briefing"

    # Build summary from first non-header paragraph
    summary_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            summary_lines.append(stripped)
        if len(summary_lines) >= 2:
            break
    summary = " ".join(summary_lines)[:280]

    return {"title": title, "summary": summary, "content": content}


# ── Storage ───────────────────────────────────────────────────────────────────

async def store_briefing(
    company_id: str,
    briefing_type: str,
    title: str,
    summary: str,
    content: str,
) -> dict:
    """Store a briefing in bx4_briefings. Returns the stored record."""
    payload = {
        "company_id": company_id,
        "type": briefing_type,
        "title": title,
        "summary": summary,
        "content": content,
    }
    result = await _sb_post("bx4_briefings", payload)
    if isinstance(result, list):
        return result[0] if result else payload
    return result or payload


# ── Dispatch ──────────────────────────────────────────────────────────────────

async def dispatch_discord(
    briefing: dict,
    company_name: str,
    guild_id: str | None = None,
) -> bool:
    """Send briefing to Discord via discord-bridge. Returns True on success."""
    msg = (
        f"**Bx4 {briefing.get('type', '').title()} Briefing — {company_name}**\n"
        f"_{briefing.get('title', '')}_\n\n"
        + briefing.get("content", "")[:1800]
    )
    payload: dict = {"content": msg}
    if guild_id:
        payload["guild_id"] = guild_id

    url = f"{config.DISCORD_BRIDGE_URL}/api/send"
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(url, json=payload)
            return r.status_code < 400
    except Exception as exc:
        log.warning("Discord dispatch failed: %s", exc)
        return False


async def dispatch_email(
    briefing: dict,
    to_email: str,
    company_name: str,
) -> bool:
    """Send briefing via email-agent. Returns True on success."""
    subject = f"Bx4 {briefing.get('type', '').title()} Briefing — {company_name}"
    body = briefing.get("content", "")

    url = getattr(config, "EMAIL_AGENT_URL", "http://127.0.0.1:8085")
    payload = {
        "to": to_email,
        "subject": subject,
        "body": body,
        "format": "text",
    }
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(f"{url}/api/send", json=payload)
            return r.status_code < 400
    except Exception as exc:
        log.warning("Email dispatch failed: %s", exc)
        return False


async def mark_dispatched(briefing_id: str, channel: str) -> None:
    """Mark a briefing as dispatched on the given channel."""
    if channel == "discord":
        await _sb_patch("bx4_briefings", f"id=eq.{briefing_id}", {"dispatched_discord": True})
    elif channel == "email":
        await _sb_patch("bx4_briefings", f"id=eq.{briefing_id}", {"dispatched_email": True})
