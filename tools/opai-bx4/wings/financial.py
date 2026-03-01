"""Bx4 — Financial analysis wing."""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, date, timezone, timedelta
from typing import Optional

import httpx

import config
from core.advisor import run_analysis
from core.budget_filter import compute_health_score, filter_and_rank

log = logging.getLogger("bx4.wings.financial")


def _headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def get_snapshot(
    company_id: str, supabase_url: str, service_key: str,
) -> dict | None:
    """Fetch the latest bx4_financial_snapshots record for a company."""
    url = (
        f"{supabase_url}/rest/v1/bx4_financial_snapshots"
        f"?company_id=eq.{company_id}&order=generated_at.desc&limit=1&select=*"
    )
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=headers)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None


async def compute_snapshot_from_transactions(
    company_id: str,
    period_start: str,
    period_end: str,
    supabase_url: str,
    service_key: str,
) -> dict:
    """Aggregate bx4_transactions for a period into a snapshot dict.

    Positive amounts = revenue, negative amounts = expenses.
    """
    url = (
        f"{supabase_url}/rest/v1/bx4_transactions"
        f"?company_id=eq.{company_id}"
        f"&date=gte.{period_start}&date=lte.{period_end}"
        f"&select=amount,category,date"
    )
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers=headers)
        r.raise_for_status()
        rows = r.json()

    revenue = sum(row["amount"] for row in rows if row.get("amount", 0) > 0)
    expenses = sum(row["amount"] for row in rows if row.get("amount", 0) < 0)
    net = revenue + expenses  # expenses are negative

    return {
        "company_id": company_id,
        "period": f"{period_start} to {period_end}",
        "period_start": period_start,
        "period_end": period_end,
        "revenue": round(revenue, 2),
        "expenses": round(expenses, 2),
        "net": round(net, 2),
        "transaction_count": len(rows),
    }


def _parse_recommendations(text: str, wing: str) -> list[dict]:
    """Parse AI text response into structured recommendation dicts.

    Extracts numbered items and maps to structured format. Falls back to
    a single recommendation wrapping the entire text if parsing fails.
    """
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

        # Detect numbered items like "1. Title" or "1) Title"
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
            # Accumulate detail lines
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

    # Fallback: if no recommendations parsed, wrap the entire text
    if not recs and text.strip():
        recs.append({
            "title": "Financial Analysis Summary",
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
            "wing": rec.get("wing", "financial"),
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


async def _log_action(
    company_id: str, action: str, result: str,
    supabase_url: str, service_key: str,
    user_id: str | None = None,
) -> None:
    """Log an action to bx4_action_log."""
    url = f"{supabase_url}/rest/v1/bx4_action_log"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    payload = {
        "company_id": company_id,
        "action": action,
        "result": result,
        "user_id": user_id,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(url, headers=headers, json=payload)
    except Exception as exc:
        log.warning("Failed to log action: %s", exc)


async def analyze(
    company: dict, snapshot: dict, goal: str | None = None,
) -> dict:
    """Run financial wing analysis.

    Calls advisor, parses recommendations, applies budget filter, stores, and logs.
    Returns {recommendations: [...], snapshot: {...}}.
    """
    company_id = company.get("id", "")

    # Enrich snapshot with health score if missing
    if "health_score" not in snapshot or snapshot["health_score"] is None:
        score, grade = compute_health_score(snapshot)
        snapshot["health_score"] = score
        snapshot["health_grade"] = grade

    # Run AI analysis
    raw_text = await run_analysis(company, snapshot, "financial", goal)

    # Parse into structured recommendations
    recs = _parse_recommendations(raw_text, "financial")

    # Apply budget filter
    ranked = filter_and_rank(recs, snapshot)

    # Store recommendations
    await _store_recommendations(
        company_id, ranked,
        config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )

    # Log the action
    await _log_action(
        company_id, "wing_analysis",
        f"financial: {len(ranked)} recommendations",
        config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY,
    )

    return {
        "recommendations": ranked,
        "snapshot": snapshot,
    }


# ── Cash Flow Forecasting ──────────────────────────────────────────────────────

async def compute_cashflow(
    company_id: str,
    days: int,
    supabase_url: str,
    service_key: str,
) -> list[dict]:
    """Aggregate daily actuals from bx4_transactions for the last `days` days.

    Returns a list of {date, revenue, expenses, net, cumulative_net}.
    """
    since = (date.today() - timedelta(days=days)).isoformat()
    url = (
        f"{supabase_url}/rest/v1/bx4_transactions"
        f"?company_id=eq.{company_id}&date=gte.{since}"
        f"&select=date,amount&order=date.asc"
    )
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    }
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers=headers)
        r.raise_for_status()
        rows = r.json()

    # Aggregate by date
    daily: dict[str, dict] = defaultdict(lambda: {"revenue": 0.0, "expenses": 0.0})
    for row in rows:
        d = row.get("date", "")
        amt = float(row.get("amount", 0))
        if amt > 0:
            daily[d]["revenue"] += amt
        else:
            daily[d]["expenses"] += amt

    # Build ordered list with cumulative net
    result = []
    cumulative = 0.0
    for d in sorted(daily.keys()):
        rev = round(daily[d]["revenue"], 2)
        exp = round(daily[d]["expenses"], 2)
        net = round(rev + exp, 2)
        cumulative = round(cumulative + net, 2)
        result.append({
            "date": d,
            "revenue": rev,
            "expenses": exp,
            "net": net,
            "cumulative_net": cumulative,
        })

    return result


def forecast_cashflow(actuals: list[dict], forecast_days: int = 90) -> dict:
    """Generate 3 forecast bands from actuals.

    Conservative: worst-case (lowest quartile of monthly net)
    Baseline: trailing 3-month average
    Optimistic: best-case (highest quartile of monthly net)

    Returns {conservative: [...], baseline: [...], optimistic: [...]}
    Each band: list of {date, projected_net, cumulative_net}.
    """
    if not actuals:
        return {"conservative": [], "baseline": [], "optimistic": []}

    # Compute monthly average net from actuals
    monthly: dict[str, float] = defaultdict(float)
    for row in actuals:
        month = row["date"][:7]  # YYYY-MM
        monthly[month] = monthly[month] + row["net"]

    nets = sorted(monthly.values())
    n = len(nets)
    if n == 0:
        return {"conservative": [], "baseline": [], "optimistic": []}

    # Monthly rates
    baseline_monthly = sum(nets) / n
    conservative_monthly = nets[0] if n == 1 else sum(nets[:max(1, n // 4)]) / max(1, n // 4)
    optimistic_monthly  = nets[-1] if n == 1 else sum(nets[-(max(1, n // 4)):]) / max(1, n // 4)

    # Daily rates
    b_daily = baseline_monthly / 30
    c_daily = conservative_monthly / 30
    o_daily = optimistic_monthly / 30

    # Seed cumulative from last actual
    last_cum = actuals[-1]["cumulative_net"] if actuals else 0.0

    def _band(daily_rate: float) -> list[dict]:
        points = []
        cum = last_cum
        start = date.today()
        for i in range(1, forecast_days + 1):
            d = (start + timedelta(days=i)).isoformat()
            projected = round(daily_rate, 2)
            cum = round(cum + projected, 2)
            points.append({"date": d, "projected_net": projected, "cumulative_net": cum})
        return points

    return {
        "conservative": _band(c_daily),
        "baseline":     _band(b_daily),
        "optimistic":   _band(o_daily),
    }


# ── Revenue Breakdown ──────────────────────────────────────────────────────────

async def revenue_breakdown(
    company_id: str,
    supabase_url: str,
    service_key: str,
    days: int = 90,
) -> dict:
    """Revenue breakdown by category and source over the last `days` days.

    Returns {by_category: [...], by_source: [...], by_month: [...], total_revenue, total_expenses}.
    """
    since = (date.today() - timedelta(days=days)).isoformat()
    url = (
        f"{supabase_url}/rest/v1/bx4_transactions"
        f"?company_id=eq.{company_id}&date=gte.{since}"
        f"&select=date,amount,category,source"
    )
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers=headers)
        r.raise_for_status()
        rows = r.json()

    by_cat: dict[str, float] = defaultdict(float)
    by_src: dict[str, float] = defaultdict(float)
    by_month: dict[str, dict] = defaultdict(lambda: {"revenue": 0.0, "expenses": 0.0})
    total_rev = 0.0
    total_exp = 0.0

    for row in rows:
        amt = float(row.get("amount", 0))
        cat = row.get("category") or "uncategorized"
        src = row.get("source") or "manual"
        month = (row.get("date") or "")[:7]

        if amt > 0:
            by_cat[cat] += amt
            by_src[src] += amt
            by_month[month]["revenue"] += amt
            total_rev += amt
        else:
            by_month[month]["expenses"] += amt
            total_exp += amt

    return {
        "total_revenue": round(total_rev, 2),
        "total_expenses": round(total_exp, 2),
        "by_category": [
            {"category": k, "amount": round(v, 2), "pct": round(v / total_rev * 100, 1) if total_rev else 0}
            for k, v in sorted(by_cat.items(), key=lambda x: -x[1])
        ],
        "by_source": [
            {"source": k, "amount": round(v, 2), "pct": round(v / total_rev * 100, 1) if total_rev else 0}
            for k, v in sorted(by_src.items(), key=lambda x: -x[1])
        ],
        "by_month": [
            {
                "month": m,
                "revenue": round(by_month[m]["revenue"], 2),
                "expenses": round(by_month[m]["expenses"], 2),
                "net": round(by_month[m]["revenue"] + by_month[m]["expenses"], 2),
            }
            for m in sorted(by_month.keys())
        ],
        "period_days": days,
    }


# ── Expense Audit ─────────────────────────────────────────────────────────────

async def expense_audit(
    company: dict,
    snapshot: Optional[dict],
    supabase_url: str,
    service_key: str,
) -> dict:
    """Run an AI-powered expense audit (fat-trim report).

    Fetches recent expense transactions, builds a summary, sends to Claude,
    stores result in bx4_expense_audits, and returns findings.
    """
    company_id = company.get("id", "")
    since = (date.today() - timedelta(days=90)).isoformat()

    url = (
        f"{supabase_url}/rest/v1/bx4_transactions"
        f"?company_id=eq.{company_id}&amount=lt.0&date=gte.{since}"
        f"&select=description,amount,category,source,date&order=amount.asc&limit=200"
    )
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers=headers)
        r.raise_for_status()
        expenses = r.json()

    if not expenses:
        return {"findings": [], "potential_savings": 0, "message": "No expense data found in last 90 days"}

    # Aggregate by description for the AI prompt
    exp_summary: dict[str, dict] = defaultdict(lambda: {"total": 0.0, "count": 0})
    for e in expenses:
        desc = (e.get("description") or "Unknown").strip()[:60]
        exp_summary[desc]["total"] += float(e.get("amount", 0))
        exp_summary[desc]["count"] += 1

    # Build expense list for prompt (top 30 by total)
    sorted_exp = sorted(exp_summary.items(), key=lambda x: x[1]["total"])[:30]
    exp_text = "\n".join(
        f"  - {desc}: ${abs(data['total']):.2f} ({data['count']}x)"
        for desc, data in sorted_exp
    )

    prompt = f"""Analyze these business expenses for {company.get('name', 'the company')} over the last 90 days and identify waste, duplicates, or cost-reduction opportunities.

EXPENSE SUMMARY (last 90 days):
{exp_text}

For each issue found, respond with exactly this format:
FINDING: [description]
CATEGORY: [subscription|service|overhead|vendor|other]
CURRENT_COST: $[monthly estimate]
POTENTIAL_SAVING: $[monthly saving if actioned]
ACTION: [specific action to take]
IMPORTANCE: [critical|high|medium|low]
---

Focus on: duplicate tools, unused subscriptions, overpriced vendors, and anything inconsistent with a {company.get('stage','established')}-stage {company.get('industry','business')}.
Only list genuine opportunities. If expenses look lean, say so."""

    import anthropic
    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    msg = client.messages.create(
        model=config.CLAUDE_MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )
    report_text = msg.content[0].text if msg.content else ""

    # Parse findings
    findings = []
    potential_savings = 0.0
    for block in report_text.split("---"):
        block = block.strip()
        if not block or "FINDING:" not in block:
            continue
        finding: dict = {}
        for line in block.split("\n"):
            if ":" in line:
                k, _, v = line.partition(":")
                key = k.strip().upper().replace(" ", "_")
                val = v.strip()
                finding[key] = val
                if key == "POTENTIAL_SAVING":
                    try:
                        potential_savings += float(val.replace("$", "").replace(",", ""))
                    except ValueError:
                        pass
        if finding.get("FINDING"):
            findings.append(finding)

    # Store in bx4_expense_audits
    audit_payload = {
        "company_id": company_id,
        "findings_json": findings,
        "potential_savings": round(potential_savings, 2),
        "report_text": report_text,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(
                f"{supabase_url}/rest/v1/bx4_expense_audits",
                headers={**headers, "Content-Type": "application/json", "Prefer": "return=minimal"},
                json=audit_payload,
            )
    except Exception as exc:
        log.warning("Failed to store expense audit: %s", exc)

    return {
        "findings": findings,
        "potential_savings": round(potential_savings, 2),
        "report_text": report_text,
        "expenses_analyzed": len(expenses),
    }


# ── Scenario Modeler ──────────────────────────────────────────────────────────

def scenario_model(snapshot: dict, variable: str, change_pct: float) -> dict:
    """What-if scenario modeling on a financial snapshot.

    Args:
        snapshot:   Current financial snapshot dict.
        variable:   One of: revenue | expenses | burn_rate | headcount
        change_pct: Percentage change e.g. -20 (20% drop), +15 (15% increase)

    Returns the recalculated snapshot with before/after comparison.
    """
    ALLOWED = ("revenue", "expenses", "burn_rate", "headcount")
    if variable not in ALLOWED:
        return {"error": f"Variable must be one of: {', '.join(ALLOWED)}"}

    factor = 1 + (change_pct / 100.0)
    original = {k: snapshot.get(k, 0) for k in ("revenue", "expenses", "net", "burn_rate", "cash_on_hand", "runway_months")}

    modified = dict(original)

    if variable == "revenue":
        modified["revenue"] = round(original["revenue"] * factor, 2)
        modified["net"] = round(modified["revenue"] + original["expenses"], 2)
    elif variable == "expenses":
        # Expenses stored as negative; increasing expenses = more negative
        modified["expenses"] = round(original["expenses"] * factor, 2)
        modified["net"] = round(original["revenue"] + modified["expenses"], 2)
    elif variable == "burn_rate":
        modified["burn_rate"] = round(original["burn_rate"] * factor, 2)
    elif variable == "headcount":
        # Rough estimate: headcount drives ~40% of burn
        headcount_impact = original.get("burn_rate", 0) * 0.4 * (factor - 1)
        modified["burn_rate"] = round(original["burn_rate"] + headcount_impact, 2)
        modified["expenses"] = round(original["expenses"] - headcount_impact, 2)
        modified["net"] = round(original["revenue"] + modified["expenses"], 2)

    # Recalculate runway
    burn = abs(modified.get("burn_rate") or modified.get("expenses", 0))
    if burn > 0 and snapshot.get("cash_on_hand"):
        modified["runway_months"] = round(snapshot["cash_on_hand"] / burn, 1)
    else:
        modified["runway_months"] = original["runway_months"]

    # Recompute health score
    from core.budget_filter import compute_health_score
    combined = {**snapshot, **modified}
    score, grade = compute_health_score(combined)

    delta_net = round(modified.get("net", 0) - original.get("net", 0), 2)
    direction = "improved" if delta_net > 0 else ("worsened" if delta_net < 0 else "unchanged")

    return {
        "scenario": {"variable": variable, "change_pct": change_pct},
        "before": original,
        "after": modified,
        "delta_net": delta_net,
        "health_score_after": score,
        "health_grade_after": grade,
        "direction": direction,
        "summary": (
            f"If {variable} changes by {change_pct:+.0f}%, monthly net "
            f"{'improves' if delta_net >= 0 else 'drops'} by ${abs(delta_net):,.2f}. "
            f"Runway: {modified['runway_months']:.1f} months. "
            f"Health grade: {grade}."
        ),
    }
