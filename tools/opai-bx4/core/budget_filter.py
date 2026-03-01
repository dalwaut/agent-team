"""Bx4 — Budget-aware recommendation scoring and health score computation."""

from __future__ import annotations

URGENCY_WEIGHTS = {"critical": 4, "high": 3, "medium": 2, "low": 1}

IMPACT_MULTIPLIERS = {"positive": 2.0, "neutral": 1.0, "negative": 0.3}

FINANCIAL_WINGS = {"financial"}


def is_triage(snapshot: dict) -> bool:
    """Return True if the business is in triage mode.

    Triage triggers:
    - runway_months < 2
    - health_score < 40
    - net < 0 (simplified cash-flow-negative check for Phase 1)
    """
    if snapshot.get("runway_months", 99) < 2:
        return True
    if snapshot.get("health_score", 100) < 40:
        return True
    if snapshot.get("net", 0) < 0:
        return True
    return False


def score_recommendation(rec: dict, snapshot: dict) -> float:
    """Score a single recommendation based on urgency, impact, and triage state.

    Returns a float score (higher = more important).
    """
    urgency = rec.get("urgency", "medium").lower()
    impact = rec.get("financial_impact", "neutral").lower()
    wing = rec.get("wing", "").lower()

    base = URGENCY_WEIGHTS.get(urgency, 1)
    multiplier = IMPACT_MULTIPLIERS.get(impact, 1.0)
    score = base * multiplier

    # In triage mode, suppress non-financial wing recommendations
    triage = is_triage(snapshot)
    if triage and wing not in FINANCIAL_WINGS:
        score *= 0.1

    return round(score, 4)


def filter_and_rank(recs: list[dict], snapshot: dict) -> list[dict]:
    """Score all recommendations, sort descending, annotate with metadata.

    Adds ``_score`` and ``triage_mode`` fields to each recommendation dict.
    Returns a new sorted list (does not mutate originals).
    """
    triage = is_triage(snapshot)
    scored: list[dict] = []
    for rec in recs:
        entry = {**rec}
        entry["_score"] = score_recommendation(rec, snapshot)
        entry["triage_mode"] = triage
        scored.append(entry)

    scored.sort(key=lambda r: r["_score"], reverse=True)
    return scored


def compute_health_score(snapshot: dict) -> tuple[int, str]:
    """Compute a 0-100 health score from financial snapshot data.

    Components (weighted):
    - liquidity  (25%): cash / burn_rate mapped to months of runway, capped at 12
    - revenue_growth_rate (20%): percentage growth, capped at +/- 100
    - gross_margin (20%): percentage, capped at 0-100
    - expense_efficiency (15%): 1 - (expenses / revenue), capped at 0-1

    Remaining 20% reserved for future KPI/social/ops signals (scored at 50 baseline).

    Returns (score 0-100, grade letter).
    """
    # --- Liquidity (25%) ---
    cash = snapshot.get("cash_on_hand", 0) or 0
    burn = snapshot.get("burn_rate", 0) or 0
    if burn > 0:
        runway_months = cash / burn
    else:
        runway_months = 12  # no burn = healthy
    # Map 0-12 months to 0-100
    liquidity_score = min(max(runway_months / 12, 0), 1) * 100

    # --- Revenue growth (20%) ---
    growth = snapshot.get("revenue_growth_rate", 0) or 0
    # Clamp to -100..+100, then shift to 0-100 scale (0% growth = 50)
    clamped = min(max(growth, -100), 100)
    growth_score = (clamped + 100) / 2

    # --- Gross margin (20%) ---
    margin = snapshot.get("gross_margin", 0) or 0
    margin_score = min(max(margin, 0), 100)

    # --- Expense efficiency (15%) ---
    revenue = snapshot.get("revenue", 0) or 0
    expenses = abs(snapshot.get("expenses", 0) or 0)
    if revenue > 0:
        efficiency = 1 - (expenses / revenue)
        efficiency = min(max(efficiency, 0), 1)
    else:
        efficiency = 0
    efficiency_score = efficiency * 100

    # --- Future reserve (20%) ---
    reserve_score = 50

    # Weighted average
    score = (
        liquidity_score * 0.25
        + growth_score * 0.20
        + margin_score * 0.20
        + efficiency_score * 0.15
        + reserve_score * 0.20
    )
    score = int(round(min(max(score, 0), 100)))

    # Grade
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
