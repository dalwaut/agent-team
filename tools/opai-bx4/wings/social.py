"""Bx4 — Social analytics wing."""

from __future__ import annotations

import logging

import httpx

import config
from core.advisor import run_analysis
from core.budget_filter import filter_and_rank

log = logging.getLogger("bx4.wings.social")

# Optimal posting frequencies per platform (posts per week)
PLATFORM_OPTIMAL_FREQ = {
    "instagram": (4, 7),
    "meta": (4, 7),
    "facebook": (4, 7),
    "twitter": (5, 10),
    "x": (5, 10),
    "linkedin": (3, 5),
    "tiktok": (3, 5),
}


def _headers(service_key: str) -> dict:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


async def get_latest_snapshots(
    company_id: str, supabase_url: str, service_key: str,
) -> list[dict]:
    """Fetch latest bx4_social_snapshots per platform for a company."""
    url = (
        f"{supabase_url}/rest/v1/bx4_social_snapshots"
        f"?company_id=eq.{company_id}&order=captured_at.desc&select=*"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers(service_key))
        r.raise_for_status()
        rows = r.json()

    # Deduplicate: keep only the latest per platform
    seen: dict[str, dict] = {}
    for row in rows:
        platform = row.get("platform", "unknown")
        if platform not in seen:
            seen[platform] = row
    return list(seen.values())


def compute_frequency_grade(posts_count: int, platform: str) -> tuple[int, str]:
    """Compute a posting frequency score (0-100) and grade (A-F).

    Based on platform-optimal posting frequencies per week.
    """
    platform_key = platform.lower()
    low, high = PLATFORM_OPTIMAL_FREQ.get(platform_key, (3, 7))

    if posts_count >= low and posts_count <= high:
        score = 100
    elif posts_count > high:
        # Slight penalty for overposting, but not severe
        excess = posts_count - high
        score = max(100 - (excess * 5), 60)
    else:
        # Penalty for underposting
        if low > 0:
            ratio = posts_count / low
        else:
            ratio = 1.0
        score = int(ratio * 100)
        score = max(score, 0)

    score = min(max(score, 0), 100)

    if score >= 85:
        grade = "A"
    elif score >= 70:
        grade = "B"
    elif score >= 55:
        grade = "C"
    elif score >= 40:
        grade = "D"
    else:
        grade = "F"

    return score, grade


def _parse_recommendations(text: str, wing: str) -> list[dict]:
    """Parse AI text response into structured recommendation dicts."""
    recs: list[dict] = []
    lines = text.strip().split("\n")
    current_rec: dict = {}

    for line in lines:
        stripped = line.strip()
        if not stripped:
            if current_rec.get("title"):
                recs.append(current_rec)
                current_rec = {}
            continue

        for sep in [". ", ") "]:
            if stripped[0].isdigit() and sep in stripped[:5]:
                if current_rec.get("title"):
                    recs.append(current_rec)
                idx = stripped.index(sep) + len(sep)
                current_rec = {
                    "title": stripped[idx:].strip("*").strip(),
                    "wing": wing,
                    "urgency": "medium",
                    "financial_impact": "neutral",
                    "raw_text": stripped,
                }
                break
        else:
            lower = stripped.lower()
            if lower.startswith("urgency:"):
                val = stripped.split(":", 1)[1].strip().lower()
                if val in ("critical", "high", "medium", "low"):
                    current_rec["urgency"] = val
            elif lower.startswith("financial_impact:") or lower.startswith("financial impact:"):
                val = stripped.split(":", 1)[1].strip().lower()
                if val in ("positive", "neutral", "negative"):
                    current_rec["financial_impact"] = val
            elif lower.startswith("why it matters:"):
                current_rec["why_it_matters"] = stripped.split(":", 1)[1].strip()
            elif lower.startswith("what to do:"):
                current_rec["what_to_do"] = stripped.split(":", 1)[1].strip()
            elif lower.startswith("data citation:"):
                current_rec["data_citation"] = stripped.split(":", 1)[1].strip()
            elif "raw_text" in current_rec:
                current_rec["raw_text"] += "\n" + stripped

    if current_rec.get("title"):
        recs.append(current_rec)

    if not recs and text.strip():
        recs.append({
            "title": "Social Analysis Summary",
            "wing": wing,
            "urgency": "medium",
            "financial_impact": "neutral",
            "raw_text": text.strip(),
        })

    return recs


async def _store_recommendations(
    company_id: str, recs: list[dict],
    supabase_url: str, service_key: str,
) -> None:
    """Store recommendations in bx4_recommendations."""
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    for rec in recs:
        payload = {
            "company_id": company_id,
            "wing": rec.get("wing", "social"),
            "title": rec.get("title", "Recommendation"),
            "urgency": rec.get("urgency", "medium"),
            "financial_impact": rec.get("financial_impact", "neutral"),
            "why_it_matters": rec.get("why_it_matters", ""),
            "what_to_do": rec.get("what_to_do", ""),
            "data_citation": rec.get("data_citation", ""),
            "raw_text": rec.get("raw_text", ""),
            "status": "pending",
        }
        try:
            url = f"{supabase_url}/rest/v1/bx4_recommendations"
            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(url, headers=headers, json=payload)
        except Exception as exc:
            log.warning("Failed to store recommendation: %s", exc)


async def analyze(
    company: dict,
    social_data: list[dict],
    snapshot: dict | None = None,
    goal: str | None = None,
) -> dict:
    """Run social wing analysis.

    Calls advisor with social context, computes platform scores.
    Returns {platform_scores: {...}, recommendations: [...]}.
    """
    company_id = company.get("id", "")
    snap = snapshot or {}

    # Build platform scores from social data
    platform_scores: dict[str, dict] = {}
    for item in social_data:
        platform = item.get("platform", "unknown")
        posts = item.get("posts_count", 0)
        freq_score, freq_grade = compute_frequency_grade(posts, platform)
        platform_scores[platform] = {
            "followers": item.get("followers", 0),
            "engagement_rate": item.get("engagement_rate", 0),
            "posts_this_week": posts,
            "frequency_score": freq_score,
            "frequency_grade": freq_grade,
        }

    # Inject social context into company dict for the advisor
    enriched_company = {**company}
    enriched_company["social_data"] = social_data
    enriched_company["platform_scores"] = platform_scores

    # Run AI analysis
    raw_text = await run_analysis(enriched_company, snap, "social", goal)

    # Parse into structured recommendations
    recs = _parse_recommendations(raw_text, "social")

    # Apply budget filter if snapshot available
    if snapshot:
        ranked = filter_and_rank(recs, snapshot)
    else:
        ranked = recs

    # Store recommendations
    await _store_recommendations(
        company_id, ranked,
        config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )

    return {
        "platform_scores": platform_scores,
        "recommendations": ranked,
    }


# -- Phase 3 additions --------------------------------------------------------

async def sync_ga_snapshot(account: dict, company_id: str) -> dict:
    """Pull GA4 data and store as a bx4_social_snapshots row.

    account: row from bx4_social_accounts (must have credentials_ref as GA4 JSON, property_id)
    Returns the stored snapshot or an error dict.
    """
    from connectors.google_analytics import fetch_ga_snapshot

    credentials_ref = account.get("credentials_ref", "")
    property_id = account.get("property_id", "")
    account_id = account.get("id", "")

    if not credentials_ref or not property_id:
        return {"stored": False, "error": "Missing credentials_ref or property_id"}

    try:
        result = await fetch_ga_snapshot(credentials_ref, property_id)
    except Exception as exc:
        log.error("GA4 fetch failed for account %s: %s", account_id, exc)
        return {"stored": False, "error": str(exc)}

    payload = {
        "company_id": company_id,
        "social_account_id": account_id,
        "platform": "google_analytics",
        "followers": result.get("followers", 0),
        "follower_delta": result.get("follower_delta", 0),
        "reach": result.get("reach", 0),
        "impressions": result.get("impressions", 0),
        "engagement_rate": result.get("engagement_rate", 0.0),
        "platform_health_score": result.get("platform_health_score", 0),
        "metrics_json": result.get("metrics_json", {}),
    }

    store_headers = {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    try:
        import httpx as _httpx
        async with _httpx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{config.SUPABASE_URL}/rest/v1/bx4_social_snapshots",
                headers=store_headers,
                json=payload,
            )
            r.raise_for_status()
            stored = r.json()
            stored_row = stored[0] if isinstance(stored, list) else stored
    except Exception as exc:
        log.error("Failed to store GA4 snapshot: %s", exc)
        return {"stored": False, "snapshot": result, "error": str(exc)}

    return {"stored": True, "snapshot": stored_row}


async def get_trend(
    account_id: str, company_id: str, days: int,
    supabase_url: str, service_key: str,
) -> list[dict]:
    """Fetch historical snapshots for trend chart.

    Returns list of {date, followers, engagement_rate, impressions, platform_health_score}
    ordered chronologically.
    """
    from datetime import datetime, timedelta, timezone
    import httpx as _httpx

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }

    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    url = (
        f"{supabase_url}/rest/v1/bx4_social_snapshots"
        f"?social_account_id=eq.{account_id}&company_id=eq.{company_id}"
        f"&captured_at=gte.{cutoff}&order=captured_at.asc"
        f"&select=captured_at,followers,engagement_rate,impressions,platform_health_score"
    )

    async with _httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=headers)
        r.raise_for_status()
        rows = r.json()

    trend = []
    for row in rows:
        trend.append({
            "date": row.get("captured_at", "")[:10],
            "followers": row.get("followers", 0),
            "engagement_rate": row.get("engagement_rate", 0.0),
            "impressions": row.get("impressions", 0),
            "platform_health_score": row.get("platform_health_score", 0),
        })
    return trend


async def aggregate_health(
    company_id: str, supabase_url: str, service_key: str,
) -> dict:
    """Compute aggregate social health across all platforms.

    Returns {health_score: int, grade: str, platform_count: int, platforms: {platform: score}}.
    """
    import httpx as _httpx

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }

    # Get all snapshots, latest per platform
    url = (
        f"{supabase_url}/rest/v1/bx4_social_snapshots"
        f"?company_id=eq.{company_id}&order=captured_at.desc"
        f"&select=platform,platform_health_score,account_id"
    )
    async with _httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=headers)
        r.raise_for_status()
        rows = r.json()

    # Deduplicate: latest per platform
    seen_platforms: dict = {}
    for row in rows:
        platform = row.get("platform", "unknown")
        if platform not in seen_platforms:
            seen_platforms[platform] = row.get("platform_health_score", 0) or 0

    if not seen_platforms:
        return {"health_score": 0, "grade": "F", "platform_count": 0, "platforms": {}}

    scores = list(seen_platforms.values())
    avg_score = int(sum(scores) / len(scores)) if scores else 0

    if avg_score >= 85:
        grade = "A"
    elif avg_score >= 70:
        grade = "B"
    elif avg_score >= 55:
        grade = "C"
    elif avg_score >= 40:
        grade = "D"
    else:
        grade = "F"

    return {
        "health_score": avg_score,
        "grade": grade,
        "platform_count": len(seen_platforms),
        "platforms": seen_platforms,
    }
