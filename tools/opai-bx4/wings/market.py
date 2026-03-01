"""Bx4 — Market analysis wing."""

from __future__ import annotations

import logging

import httpx

import config
from core.advisor import run_analysis
from core.budget_filter import filter_and_rank

log = logging.getLogger("bx4.wings.market")


def _headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


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
            "title": "Market Analysis Summary",
            "wing": wing,
            "urgency": "medium",
            "financial_impact": "neutral",
            "raw_text": text.strip(),
        })

    return recs


async def _store_analysis(
    company_id: str, raw_text: str, analysis_type: str,
    supabase_url: str, service_key: str,
) -> None:
    """Store market analysis in bx4_market_analyses."""
    url = f"{supabase_url}/rest/v1/bx4_market_analyses"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    payload = {
        "company_id": company_id,
        "analysis_type": analysis_type,
        "content": raw_text,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(url, headers=headers, json=payload)
    except Exception as exc:
        log.warning("Failed to store market analysis: %s", exc)


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
            "wing": rec.get("wing", "market"),
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
    company: dict, snapshot: dict | None = None, goal: str | None = None,
) -> dict:
    """Run market wing analysis.

    Calls advisor with wing='market', stores analysis and recommendations.
    Returns {analysis: {...}, recommendations: [...]}.
    """
    company_id = company.get("id", "")
    snap = snapshot or {}

    # Run AI analysis
    raw_text = await run_analysis(company, snap, "market", goal)

    # Store the analysis
    await _store_analysis(
        company_id, raw_text, "market",
        config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )

    # Parse into structured recommendations
    recs = _parse_recommendations(raw_text, "market")

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
        "analysis": {
            "company_id": company_id,
            "type": "market",
            "content": raw_text,
        },
        "recommendations": ranked,
    }


# -- Phase 3 additions --------------------------------------------------------

import anthropic as _anthropic


async def fetch_news(company: dict) -> list[dict]:
    """Use Claude with web_search to fetch industry news for the company.

    Returns list of {headline, summary, source, published_date}.
    Stores results in bx4_market_news. Returns up to 5 items.
    """
    import json as _json
    import re as _re

    company_id = company.get("id", "")
    industry = company.get("industry") or "business"
    name = company.get("name") or "the company"

    client = _anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

    try:
        msg = client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=2000,
            tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
            system="You are a business intelligence analyst specializing in market research and industry news.",
            messages=[{
                "role": "user",
                "content": (
                    f"Find the 5 most recent relevant news items for a {industry} company called {name}. "
                    "Return a JSON array of objects with headline, summary, source, published_date (YYYY-MM-DD). "
                    "Only return the JSON array, no other text."
                ),
            }],
        )
    except Exception as exc:
        log.error("Claude web_search failed in fetch_news: %s", exc)
        return []

    # Extract text from response
    raw_text = ""
    for block in msg.content:
        if hasattr(block, "text"):
            raw_text += block.text

    # Parse JSON
    items = []
    try:
        # Find JSON array in response
        match = _re.search(r"\[.*\]", raw_text, _re.DOTALL)
        if match:
            items = _json.loads(match.group(0))
        else:
            items = _json.loads(raw_text.strip())
    except Exception as exc:
        log.warning("Failed to parse news JSON: %s | raw: %s", exc, raw_text[:200])
        return []

    if not isinstance(items, list):
        return []

    # Store each item in bx4_market_news
    stored = []
    headers = {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    for item in items[:5]:
        if not isinstance(item, dict) or not item.get("headline"):
            continue
        payload = {
            "company_id": company_id,
            "headline": item.get("headline", ""),
            "summary": item.get("summary", ""),
            "source": item.get("source", ""),
            "published_date": item.get("published_date") or None,
        }
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.post(
                    f"{config.SUPABASE_URL}/rest/v1/bx4_market_news",
                    headers=headers,
                    json=payload,
                )
                r.raise_for_status()
                result = r.json()
                stored.append(result[0] if isinstance(result, list) else result)
        except Exception as exc:
            log.warning("Failed to store news item: %s", exc)
            stored.append(payload)

    return stored


async def competitor_research(company: dict, competitor: dict) -> dict:
    """Run Claude web_search research on a competitor.

    Returns {intel_summary, key_findings: list[str]}.
    Updates bx4_competitors row with intel_summary and last_research_at.
    """
    import re as _re
    from datetime import datetime, timezone

    company_name = company.get("name") or "the company"
    industry = company.get("industry") or "business"
    comp_name = competitor.get("name", "Unknown")
    comp_website = competitor.get("website", "")
    comp_id = competitor.get("id", "")

    client = _anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

    try:
        msg = client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=1500,
            tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
            system="You are a competitive intelligence analyst. Be concise and factual.",
            messages=[{
                "role": "user",
                "content": (
                    f"Research {comp_name} ({comp_website}) as a competitor to a {industry} business "
                    f"called {company_name}. Summarize: pricing model, key products/services, recent news, "
                    "and how they compare. Keep response under 300 words."
                ),
            }],
        )
    except Exception as exc:
        log.error("Claude web_search failed in competitor_research: %s", exc)
        return {"intel_summary": "", "key_findings": [], "error": str(exc)}

    # Extract text
    intel_summary = ""
    for block in msg.content:
        if hasattr(block, "text"):
            intel_summary += block.text

    intel_summary = intel_summary.strip()

    # Extract bullet points as key_findings
    key_findings = []
    for line in intel_summary.split("\n"):
        line = line.strip()
        if line.startswith(("-", "*", "•")) or (_re.match(r"^\d+\.", line)):
            finding = _re.sub(r"^[-*•]|^\d+\.", "", line).strip()
            if finding:
                key_findings.append(finding)

    # Update competitor in DB
    if comp_id:
        now = datetime.now(timezone.utc).isoformat()
        update_headers = {
            "apikey": config.SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                await c.patch(
                    f"{config.SUPABASE_URL}/rest/v1/bx4_competitors?id=eq.{comp_id}",
                    headers=update_headers,
                    json={"intel_summary": intel_summary, "last_research_at": now},
                )
        except Exception as exc:
            log.warning("Failed to update competitor intel: %s", exc)

    return {"intel_summary": intel_summary, "key_findings": key_findings}


async def draft_swot(company: dict, competitors: list, snapshot: dict | None) -> dict:
    """Auto-draft a SWOT analysis using Claude.

    Returns {strengths: [], weaknesses: [], opportunities: [], threats: [], raw_text: str}.
    Stores result in bx4_swot_analyses.
    """
    import json as _json
    import re as _re

    company_id = company.get("id", "")
    company_name = company.get("name") or "the company"
    industry = company.get("industry") or "business"
    stage = company.get("stage") or "unknown"

    # Build context
    context_parts = [
        f"Company: {company_name}",
        f"Industry: {industry}",
        f"Stage: {stage}",
    ]
    if company.get("geo_market"):
        context_parts.append(f"Market: {company.get('geo_market')}")
    if company.get("headcount"):
        context_parts.append(f"Headcount: {company.get('headcount')}")
    if snapshot:
        context_parts.append(f"Revenue: {snapshot.get('revenue', 'N/A')}")
        context_parts.append(f"Net: {snapshot.get('net', 'N/A')}")
        context_parts.append(f"Health score: {snapshot.get('health_score', 'N/A')}")
    if competitors:
        comp_names = [c.get("name", "Unknown") for c in competitors[:5]]
        context_parts.append(f"Competitors: {', '.join(comp_names)}")

    context = "\n".join(context_parts)

    client = _anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

    try:
        msg = client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=2000,
            system="You are a strategic business consultant. Return only valid JSON, no markdown code blocks.",
            messages=[{
                "role": "user",
                "content": (
                    f"Draft a SWOT analysis for the following business:\n\n{context}\n\n"
                    "Return a JSON object with exactly these keys: strengths (array of strings), "
                    "weaknesses (array of strings), opportunities (array of strings), threats (array of strings). "
                    "Each array should have 3-5 concise items. Return only the JSON object."
                ),
            }],
        )
    except Exception as exc:
        log.error("Claude failed in draft_swot: %s", exc)
        return {"strengths": [], "weaknesses": [], "opportunities": [], "threats": [], "raw_text": "", "error": str(exc)}

    raw_text = ""
    for block in msg.content:
        if hasattr(block, "text"):
            raw_text += block.text
    raw_text = raw_text.strip()

    # Parse JSON
    swot = {"strengths": [], "weaknesses": [], "opportunities": [], "threats": []}
    try:
        match = _re.search(r"\{.*\}", raw_text, _re.DOTALL)
        if match:
            parsed = _json.loads(match.group(0))
        else:
            parsed = _json.loads(raw_text)
        for key in swot:
            if key in parsed and isinstance(parsed[key], list):
                swot[key] = parsed[key]
    except Exception as exc:
        log.warning("Failed to parse SWOT JSON: %s | raw: %s", exc, raw_text[:200])

    # Store in bx4_swot_analyses
    if company_id:
        payload = {
            "company_id": company_id,
            "strengths": swot["strengths"],
            "weaknesses": swot["weaknesses"],
            "opportunities": swot["opportunities"],
            "threats": swot["threats"],
            "raw_text": raw_text,
        }
        store_headers = {
            "apikey": config.SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(
                    f"{config.SUPABASE_URL}/rest/v1/bx4_swot_analyses",
                    headers=store_headers,
                    json=payload,
                )
        except Exception as exc:
            log.warning("Failed to store SWOT: %s", exc)

    return {**swot, "raw_text": raw_text}


async def positioning_map(company: dict, competitors: list, analysis: dict | None) -> dict:
    """Generate a 2x2 market positioning map.

    Returns {axes: {x_label, y_label}, positions: [{name, x, y, is_self}]}.
    Uses Claude to choose appropriate axes and place company + competitors.
    """
    import json as _json
    import re as _re

    company_name = company.get("name") or "Our Company"
    industry = company.get("industry") or "business"

    context_parts = [
        f"Company: {company_name}",
        f"Industry: {industry}",
    ]
    if competitors:
        for comp in competitors[:6]:
            comp_desc = comp.get("name", "Unknown")
            if comp.get("intel_summary"):
                comp_desc += f" — {comp['intel_summary'][:100]}"
            context_parts.append(f"Competitor: {comp_desc}")
    if analysis and analysis.get("content"):
        context_parts.append(f"Market context: {analysis['content'][:300]}")

    context = "\n".join(context_parts)

    client = _anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

    try:
        msg = client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=1000,
            system="You are a strategic analyst. Return only valid JSON, no markdown code blocks.",
            messages=[{
                "role": "user",
                "content": (
                    f"Given this business landscape, create a 2x2 positioning map:\n\n{context}\n\n"
                    "Choose two meaningful competitive axes (e.g. Price vs Quality, Niche vs Broad, etc.). "
                    "Place the company and each competitor on a 0-10 scale for each axis. "
                    "Return JSON: {\"x_label\": \"...\", \"y_label\": \"...\", "
                    "\"positions\": [{\"name\": \"...\", \"x\": 5, \"y\": 7, \"is_self\": true}, ...]}. "
                    "Mark the main company with is_self: true. Return only the JSON."
                ),
            }],
        )
    except Exception as exc:
        log.error("Claude failed in positioning_map: %s", exc)
        return {"x_label": "Price", "y_label": "Quality", "positions": [], "error": str(exc)}

    raw_text = ""
    for block in msg.content:
        if hasattr(block, "text"):
            raw_text += block.text
    raw_text = raw_text.strip()

    result = {"x_label": "Price", "y_label": "Quality", "positions": []}
    try:
        match = _re.search(r"\{.*\}", raw_text, _re.DOTALL)
        if match:
            parsed = _json.loads(match.group(0))
        else:
            parsed = _json.loads(raw_text)
        result["x_label"] = parsed.get("x_label", "Price")
        result["y_label"] = parsed.get("y_label", "Quality")
        result["positions"] = parsed.get("positions", [])
    except Exception as exc:
        log.warning("Failed to parse positioning map JSON: %s | raw: %s", exc, raw_text[:200])

    return result
