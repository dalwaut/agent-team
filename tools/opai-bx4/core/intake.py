"""Bx4 — Onboarding Q&A intake flow."""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger("bx4.intake")

FOUNDATION_QUESTIONS = [
    {
        "index": 0,
        "phase": "foundation",
        "key": "company_description",
        "question": "What is your company name and what does it do?",
        "hint": "A quick 1-2 sentence pitch — this becomes the foundation for all advisor recommendations.",
        "type": "textarea",
        "placeholder": "e.g. Acme Corp builds AI-powered invoicing tools for freelancers, helping them get paid 3× faster...",
    },
    {
        "index": 1,
        "phase": "foundation",
        "key": "industry",
        "question": "What industry or niche are you in?",
        "hint": "Being specific helps us pull targeted market intelligence and competitor data.",
        "type": "text",
        "placeholder": "e.g. B2B SaaS, e-commerce, professional services, construction, healthcare tech...",
    },
    {
        "index": 2,
        "phase": "foundation",
        "key": "stage",
        "question": "What stage is your business at?",
        "hint": "This calibrates how aggressively your advisor recommends growth vs. stability actions.",
        "type": "select",
        "options": [
            {"value": "pre-revenue", "label": "Pre-revenue", "desc": "Building product, no paying customers yet"},
            {"value": "early-revenue", "label": "Early revenue", "desc": "First customers, proving the model"},
            {"value": "growth", "label": "Growth", "desc": "Scaling what works, expanding market"},
            {"value": "mature", "label": "Mature / Stable", "desc": "Established business, optimizing operations"},
        ],
    },
    {
        "index": 3,
        "phase": "foundation",
        "key": "headcount",
        "question": "How many people work in your business?",
        "hint": "Include full-time employees, part-time staff, and regular contractors.",
        "type": "number",
        "placeholder": "e.g. 3",
        "unit": "people",
    },
    {
        "index": 4,
        "phase": "foundation",
        "key": "revenue_model",
        "question": "What is your primary revenue model?",
        "hint": "How money actually comes in — shapes how we analyze your financial health.",
        "type": "chips",
        "options": [
            {"value": "subscriptions", "label": "Subscriptions / SaaS"},
            {"value": "services", "label": "Services / Consulting"},
            {"value": "product-sales", "label": "Product Sales"},
            {"value": "marketplace", "label": "Marketplace / Commission"},
            {"value": "advertising", "label": "Advertising / Media"},
            {"value": "licensing", "label": "Licensing / Royalties"},
        ],
        "allow_other": True,
    },
    {
        "index": 5,
        "phase": "foundation",
        "key": "geography",
        "question": "What geographic markets do you serve?",
        "hint": "Influences market intelligence sourcing and regulatory context in recommendations.",
        "type": "text",
        "placeholder": "e.g. United States, US + Canada, Global, Europe...",
    },
    {
        "index": 6,
        "phase": "foundation",
        "key": "monthly_revenue",
        "question": "What is your approximate monthly revenue?",
        "hint": "Rough estimate is fine — anchors your financial health score and triage detection.",
        "type": "currency",
        "placeholder": "0",
        "unit": "USD / month",
    },
    {
        "index": 7,
        "phase": "foundation",
        "key": "monthly_expenses",
        "question": "What are your approximate monthly expenses?",
        "hint": "All-in: payroll, tools, office, marketing, contractors, etc.",
        "type": "currency",
        "placeholder": "0",
        "unit": "USD / month",
    },
    {
        "index": 8,
        "phase": "foundation",
        "key": "primary_goal",
        "question": "What is your primary business goal for the next 90 days?",
        "hint": "This becomes your advisor's #1 priority filter — all recommendations scored against this goal.",
        "type": "textarea",
        "placeholder": "e.g. Reach $50K MRR, launch our second product line, reduce burn below $8K/month...",
    },
    {
        "index": 9,
        "phase": "foundation",
        "key": "biggest_challenge",
        "question": "What is your biggest challenge or concern right now?",
        "hint": "No challenge is too small or too vague — helps your advisor focus on what's most urgent.",
        "type": "textarea",
        "placeholder": "e.g. Customer churn, hiring the right people, cash flow, finding product-market fit...",
    },
]


def _headers(service_key: str) -> dict:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


async def get_next_question(
    company_id: str, supabase_url: str, service_key: str
) -> dict | None:
    """Fetch answered questions from bx4_onboarding_log and return next unanswered.

    Returns dict {index, question, phase} or None if all questions answered.
    """
    url = (
        f"{supabase_url}/rest/v1/bx4_onboarding_log"
        f"?company_id=eq.{company_id}&select=question"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers(service_key))
        r.raise_for_status()
        answered = {row["question"] for row in r.json()}

    for q in FOUNDATION_QUESTIONS:
        if q["question"] not in answered:
            return q

    return None


async def save_answer(
    company_id: str,
    question: str,
    answer: str,
    phase: str,
    supabase_url: str,
    service_key: str,
) -> None:
    """Insert answer to bx4_onboarding_log."""
    url = f"{supabase_url}/rest/v1/bx4_onboarding_log"
    payload = {
        "company_id": company_id,
        "question": question,
        "answer": answer,
        "phase": phase,
    }
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            url,
            headers={**_headers(service_key), "Prefer": "return=minimal"},
            json=payload,
        )
        r.raise_for_status()


async def get_company_brief(
    company_id: str, supabase_url: str, service_key: str
) -> str:
    """Summarize all answered questions into a compact text block for AI context."""
    url = (
        f"{supabase_url}/rest/v1/bx4_onboarding_log"
        f"?company_id=eq.{company_id}&order=created_at.asc&select=question,answer"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers(service_key))
        r.raise_for_status()
        rows = r.json()

    if not rows:
        return "No onboarding data available."

    lines = ["## Company Onboarding Brief"]
    for row in rows:
        lines.append(f"Q: {row['question']}")
        lines.append(f"A: {row['answer']}")
        lines.append("")

    return "\n".join(lines)
