"""Bx4 — Operations wing."""

from __future__ import annotations

import json
import logging
import statistics
from datetime import datetime, timedelta, timezone

import anthropic
import httpx

import config
from core.advisor import run_analysis
from core.budget_filter import filter_and_rank

log = logging.getLogger("bx4.wings.operations")


def _headers(service_key: str) -> dict:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


async def get_goals(
    company_id: str, supabase_url: str, service_key: str,
) -> list[dict]:
    """Fetch bx4_company_goals for a company."""
    url = (
        f"{supabase_url}/rest/v1/bx4_company_goals"
        f"?company_id=eq.{company_id}&order=created_at.desc&select=*"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers(service_key))
        r.raise_for_status()
        return r.json()


async def get_kpis(
    company_id: str, supabase_url: str, service_key: str,
) -> list[dict]:
    """Fetch active bx4_kpis for a company."""
    url = (
        f"{supabase_url}/rest/v1/bx4_kpis"
        f"?company_id=eq.{company_id}&is_active=eq.true&order=created_at.desc&select=*"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers(service_key))
        r.raise_for_status()
        return r.json()


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
            "title": "Operations Analysis Summary",
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
            "wing": rec.get("wing", "operations"),
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
    goals: list,
    kpis: list,
    snapshot: dict | None = None,
    goal: str | None = None,
) -> dict:
    """Run operations wing analysis.

    Calls advisor with goals/KPI context, returns recommendations.
    Returns {goal_status: [...], kpi_status: [...], recommendations: [...]}.
    """
    company_id = company.get("id", "")
    snap = snapshot or {}

    # Inject operations context into company dict
    enriched_company = {**company}
    enriched_company["goals"] = goals
    enriched_company["kpis"] = kpis

    # Run AI analysis
    raw_text = await run_analysis(enriched_company, snap, "operations", goal)

    # Parse into structured recommendations
    recs = _parse_recommendations(raw_text, "operations")

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
        "goal_status": goals,
        "kpi_status": kpis,
        "recommendations": ranked,
    }


# ── Goal Decomposition ────────────────────────────────────────────────────────

async def decompose_goal(
    goal: dict,
    company: dict,
    snapshot: dict | None,
    supabase_url: str,
    service_key: str,
) -> dict:
    """Use Claude to break a goal into 4-6 ordered milestones.

    Stores each milestone as a bx4_company_goals row with parent_goal_id,
    then pushes each to Team Hub as a task.

    Returns {milestones: [...], team_hub_tasks_created: int}.
    """
    from core.taskhub import create_task as th_create_task

    goal_title = goal.get("title", "Unnamed Goal")
    goal_desc = goal.get("description", "")
    target_date = goal.get("target_date", "")
    co_name = company.get("name", "Unknown Company")
    s = snapshot or {}

    # Build context for Claude
    snap_ctx = (
        f"Revenue: ${s.get('revenue', 0):,.0f}/mo | "
        f"Cash: ${s.get('cash_on_hand', 0):,.0f} | "
        f"Runway: {s.get('runway_months', 'N/A')}mo"
    ) if s else "No financial data available."

    system_text = (
        "You are Bx4 — the BoutaByte Business Bot. You decompose business goals into "
        "concrete, time-bound milestones. Return only valid JSON."
    )

    user_msg = (
        f"Decompose this goal into 4-6 sequential milestones for {co_name}.\n\n"
        f"Goal: \"{goal_title}\"\n"
        + (f"Description: {goal_desc}\n" if goal_desc else "")
        + (f"Target completion: {target_date}\n" if target_date else "")
        + f"Financial context: {snap_ctx}\n\n"
        "Requirements:\n"
        "- Each milestone must be specific and measurable\n"
        "- Due dates are days from today (e.g. 30, 60, 90, 120)\n"
        "- Ordered by sequence (first to last)\n\n"
        "Return JSON array only:\n"
        '[{"title":"...", "description":"...", "due_days":30, "order_index":1}, ...]'
    )

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    try:
        resp = client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=1024,
            system=system_text,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw = resp.content[0].text.strip()
        # Extract JSON array from response
        if "[" in raw:
            raw = raw[raw.index("["):raw.rindex("]") + 1]
        milestone_plans = json.loads(raw)
    except Exception as exc:
        log.error("Goal decomposition Claude call failed: %s", exc)
        milestone_plans = [
            {"title": "Plan", "description": "Define the plan", "due_days": 30, "order_index": 1},
            {"title": "Execute", "description": "Execute the plan", "due_days": 60, "order_index": 2},
            {"title": "Review", "description": "Review and adjust", "due_days": 90, "order_index": 3},
        ]

    headers = {
        **_headers(service_key),
        "Prefer": "return=representation",
    }
    now = datetime.now(timezone.utc)
    tasks_created = 0
    stored_milestones = []

    for plan in milestone_plans[:6]:
        # Calculate due date
        due_days = int(plan.get("due_days", 30))
        due_date = (now + timedelta(days=due_days)).date().isoformat()

        payload = {
            "company_id": goal.get("company_id"),
            "parent_goal_id": goal.get("id"),
            "title": plan.get("title", "Milestone"),
            "description": plan.get("description", ""),
            "target_date": due_date,
            "status": "active",
            "is_milestone": True,
            "order_index": plan.get("order_index", 1),
            "progress_pct": 0,
        }

        try:
            url = f"{supabase_url}/rest/v1/bx4_company_goals"
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.post(url, headers=headers, json=payload)
                r.raise_for_status()
                result = r.json()
                stored = result[0] if isinstance(result, list) else result
        except Exception as exc:
            log.warning("Failed to store milestone: %s", exc)
            stored = payload

        # Push to Team Hub
        try:
            th_task = await th_create_task(
                {
                    "title": f"[Milestone] {plan.get('title','')} — {goal_title}",
                    "why_it_matters": f"Milestone toward goal: {goal_title}",
                    "what_to_do": plan.get("description", ""),
                    "urgency": "medium",
                    "financial_impact": "neutral",
                    "wing": "operations",
                },
                co_name,
            )
            if th_task and th_task.get("id") and stored.get("id"):
                # Update milestone with team_hub_task_id
                patch_url = f"{supabase_url}/rest/v1/bx4_company_goals?id=eq.{stored['id']}"
                async with httpx.AsyncClient(timeout=10) as c:
                    await c.patch(
                        patch_url,
                        headers={**_headers(service_key), "Prefer": "return=minimal"},
                        json={"team_hub_task_id": str(th_task["id"])},
                    )
                stored["team_hub_task_id"] = str(th_task["id"])
                tasks_created += 1
        except Exception as exc:
            log.warning("Failed to push milestone to Team Hub: %s", exc)

        stored_milestones.append(stored)

    return {
        "milestones": stored_milestones,
        "team_hub_tasks_created": tasks_created,
    }


# ── Anomaly Detection ─────────────────────────────────────────────────────────

async def detect_anomalies(
    company_id: str,
    supabase_url: str,
    service_key: str,
    z_threshold: float = 2.0,
    min_history: int = 5,
) -> dict:
    """Z-score anomaly detection on all active KPIs for a company.

    Fetches bx4_kpi_history per KPI, computes Z-score for the latest value,
    and flags KPIs where |Z| > z_threshold. Updates bx4_kpis in place.

    Returns {flagged: int, kpis_checked: int, anomalies: [...]}.
    """
    headers = _headers(service_key)

    # Fetch all active KPIs
    kpis_url = (
        f"{supabase_url}/rest/v1/bx4_kpis"
        f"?company_id=eq.{company_id}&is_active=eq.true&select=*"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(kpis_url, headers=headers)
        r.raise_for_status()
        kpis = r.json()

    flagged_count = 0
    anomalies = []

    for kpi in kpis:
        kpi_id = kpi.get("id")
        if not kpi_id:
            continue

        # Fetch history
        hist_url = (
            f"{supabase_url}/rest/v1/bx4_kpi_history"
            f"?kpi_id=eq.{kpi_id}&order=recorded_at.desc&limit=90&select=value"
        )
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(hist_url, headers=headers)
            r.raise_for_status()
            history = r.json()

        if len(history) < min_history:
            continue

        values = [float(h["value"]) for h in history if h.get("value") is not None]
        if len(values) < min_history:
            continue

        mean = statistics.mean(values)
        try:
            std = statistics.stdev(values)
        except statistics.StatisticsError:
            continue

        if std == 0:
            continue

        latest_val = values[0]
        z_score = (latest_val - mean) / std
        is_anomaly = abs(z_score) > z_threshold

        # Update KPI record
        import datetime
        patch_url = f"{supabase_url}/rest/v1/bx4_kpis?id=eq.{kpi_id}"
        patch_payload = {
            "anomaly_flag": is_anomaly,
            "z_score": round(z_score, 3),
            "anomaly_checked_at": datetime.datetime.utcnow().isoformat() + "Z",
        }
        patch_headers = {**headers, "Prefer": "return=minimal"}
        async with httpx.AsyncClient(timeout=10) as c:
            await c.patch(patch_url, headers=patch_headers, json=patch_payload)

        if is_anomaly:
            flagged_count += 1
            anomalies.append({
                "kpi_id": kpi_id,
                "name": kpi.get("name"),
                "current_value": latest_val,
                "z_score": round(z_score, 3),
                "mean": round(mean, 3),
                "direction": "high" if z_score > 0 else "low",
            })

    return {
        "kpis_checked": len(kpis),
        "flagged": flagged_count,
        "anomalies": anomalies,
    }


# ── ROI Scoring ───────────────────────────────────────────────────────────────

_URGENCY_WEIGHTS = {"critical": 4.0, "high": 2.5, "medium": 1.5, "low": 0.8}
_IMPACT_WEIGHTS = {"positive": 1.5, "neutral": 1.0, "negative": 0.4}


def roi_score_recommendation(rec: dict, snapshot: dict | None) -> float:
    """Compute a 0-10 ROI score for a recommendation.

    Combines urgency, financial impact, and snapshot distress level.
    Higher score = higher expected return relative to cost/effort.
    """
    s = snapshot or {}

    urgency = (rec.get("urgency") or "medium").lower()
    impact = (rec.get("financial_impact") or "neutral").lower()

    u_weight = _URGENCY_WEIGHTS.get(urgency, 1.5)
    i_weight = _IMPACT_WEIGHTS.get(impact, 1.0)

    # Distress multiplier: triage = 1.4, low runway = 1.2, healthy = 1.0
    if s.get("triage_mode"):
        distress = 1.4
    elif (s.get("runway_months") or 99) < 3:
        distress = 1.3
    elif (s.get("runway_months") or 99) < 6:
        distress = 1.15
    else:
        distress = 1.0

    raw = u_weight * i_weight * distress
    # Normalize: max possible ≈ 4.0 * 1.5 * 1.4 = 8.4 → scale to 10
    score = min(10.0, round(raw / 8.4 * 10, 1))
    return score
