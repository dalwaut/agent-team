"""Nightly business knowledge refresher — builds compact context for chat agent.

Queries Supabase for team members, workspaces, businesses, and WP sites,
then writes a compact markdown file that the chat agent loads into prompts.
No Claude calls — pure data aggregation.

Schedule: 02:30 daily (after consolidator + daily_evolve).
Output: tools/shared/business-context.md (~1.5-2KB, capped at 2048 chars).
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx

import config

logger = logging.getLogger("opai.knowledge_refresher")

OUTPUT_PATH = Path(__file__).resolve().parent.parent.parent / "shared" / "business-context.md"
MAX_OUTPUT_CHARS = 2048


# ── Supabase helpers (same pattern as chat_skills) ────────

def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Static reference data ────────────────────────────────

CLIENT_ABBREVIATIONS = {
    "VEC": "Visit Everglades City",
    "PW": "Paradise Web",
    "BB": "BoutaByte",
    "WE": "WautersEdge",
    "MDH": "Morning Dew Herbals",
    "MSDS": "MSDS Pros",
}

SYSTEMS_REFERENCE = (
    "Team Hub = task/project management (like ClickUp). "
    "HELM = autonomous business runner. "
    "Brain = knowledge graph + research. "
    "Vault = credential management. "
    "Studio = AI image generation."
)


# ── Data fetchers ─────────────────────────────────────────

async def _fetch_team_members() -> list[dict]:
    """Active team members from profiles."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                _sb_url("profiles"),
                headers=_sb_headers(),
                params={
                    "is_active": "eq.true",
                    "select": "full_name,email,role",
                    "limit": "50",
                },
            )
            if resp.status_code < 400:
                return resp.json()
    except Exception as e:
        logger.warning("Failed to fetch team members: %s", e)
    return []


async def _fetch_workspaces() -> list[dict]:
    """Shared workspaces (non-personal) from team_workspaces view."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                _sb_url("workspaces"),
                headers=_sb_headers(),
                params={
                    "is_personal": "eq.false",
                    "select": "name,slug",
                    "limit": "50",
                },
            )
            if resp.status_code < 400:
                return resp.json()
    except Exception as e:
        logger.warning("Failed to fetch workspaces: %s", e)
    return []


async def _fetch_businesses() -> list[dict]:
    """Active HELM businesses."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                _sb_url("helm_businesses"),
                headers=_sb_headers(),
                params={
                    "is_active": "eq.true",
                    "select": "name,industry,stage",
                    "limit": "30",
                },
            )
            if resp.status_code < 400:
                return resp.json()
    except Exception as e:
        logger.warning("Failed to fetch businesses: %s", e)
    return []


async def _fetch_wp_sites() -> list[dict]:
    """WordPress sites."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                _sb_url("wp_sites"),
                headers=_sb_headers(),
                params={
                    "select": "name,url,status",
                    "limit": "30",
                },
            )
            if resp.status_code < 400:
                return resp.json()
    except Exception as e:
        logger.warning("Failed to fetch WP sites: %s", e)
    return []


# ── Builder ───────────────────────────────────────────────

def _build_context(
    members: list[dict],
    workspaces: list[dict],
    businesses: list[dict],
    wp_sites: list[dict],
) -> str:
    """Build compact markdown context, capped at MAX_OUTPUT_CHARS."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"# Business Context (auto-generated {now})\n"]

    # Client abbreviations
    abbr_parts = [f"{k}={v}" for k, v in CLIENT_ABBREVIATIONS.items()]
    lines.append(f"**Client codes**: {', '.join(abbr_parts)}\n")

    # Systems
    lines.append(f"**Systems**: {SYSTEMS_REFERENCE}\n")

    # Team members
    if members:
        member_parts = []
        for m in members:
            name = m.get("full_name", "?")
            role = m.get("role", "")
            part = f"{name} ({role})" if role else name
            member_parts.append(part)
        lines.append(f"**Team**: {', '.join(member_parts)}\n")

    # Workspaces
    if workspaces:
        ws_names = [w.get("name", "?") for w in workspaces]
        lines.append(f"**Workspaces**: {', '.join(ws_names)}\n")

    # Businesses
    if businesses:
        biz_parts = []
        for b in businesses:
            name = b.get("name", "?")
            stage = b.get("stage", "")
            part = f"{name} ({stage})" if stage else name
            biz_parts.append(part)
        lines.append(f"**Businesses**: {', '.join(biz_parts)}\n")

    # WordPress sites
    if wp_sites:
        site_parts = []
        for s in wp_sites:
            name = s.get("name", "?")
            status = s.get("status", "")
            url = s.get("url", "")
            part = f"{name}"
            if url:
                part += f" ({url})"
            if status and status != "active":
                part += f" [{status}]"
            site_parts.append(part)
        lines.append(f"**WP Sites**: {', '.join(site_parts)}\n")

    result = "\n".join(lines)
    return result[:MAX_OUTPUT_CHARS]


# ── Main entry point ──────────────────────────────────────

async def run_knowledge_refresh() -> dict:
    """Run the nightly knowledge refresh. Returns summary dict."""
    logger.info("Knowledge refresher starting")

    members = await _fetch_team_members()
    workspaces = await _fetch_workspaces()
    businesses = await _fetch_businesses()
    wp_sites = await _fetch_wp_sites()

    context = _build_context(members, workspaces, businesses, wp_sites)

    # Write output
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(context)

    # Update state file
    state = {
        "last_run": datetime.now(timezone.utc).isoformat(),
        "output_chars": len(context),
        "counts": {
            "members": len(members),
            "workspaces": len(workspaces),
            "businesses": len(businesses),
            "wp_sites": len(wp_sites),
        },
    }
    try:
        config.KNOWLEDGE_REFRESHER_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.KNOWLEDGE_REFRESHER_STATE_FILE.write_text(json.dumps(state, indent=2))
    except OSError as e:
        logger.warning("Failed to write refresher state: %s", e)

    logger.info(
        "Knowledge refresher done: %d chars, %d members, %d workspaces, %d businesses, %d sites",
        len(context), len(members), len(workspaces), len(businesses), len(wp_sites),
    )
    return state
