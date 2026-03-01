"""HELM — Weekly report generation job."""

import logging
from datetime import datetime, timedelta, timezone

log = logging.getLogger("helm.jobs.report_weekly")


async def run(business_id: str, job_config: dict):
    """Generate weekly business report using Claude AI."""
    from core.supabase import _sb_get, _sb_post
    from core.ai import call_claude
    from core.hitl import log_action, create_hitl_item

    # Load business profile
    biz_rows = await _sb_get(f"helm_businesses?id=eq.{business_id}&select=*")
    if not biz_rows:
        log.warning("Business not found: %s", business_id)
        return
    business = biz_rows[0]

    # Load recent actions (last 7 days) — use Z suffix, not +00:00 (breaks URL query)
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
    recent_actions = await _sb_get(
        f"helm_business_actions?business_id=eq.{business_id}"
        f"&created_at=gte.{week_ago}&order=created_at.desc&select=*"
    )

    # Load knowledge base entries (if any)
    knowledge = await _sb_get(
        f"helm_business_knowledge?business_id=eq.{business_id}&select=topic,title,content"
    )

    # Build extra context from recent actions and knowledge
    action_summary = "\n".join(
        f"- [{a.get('action_type')}] {a.get('summary')} ({a.get('status')}) — {a.get('created_at', '')[:10]}"
        for a in recent_actions[:50]
    )

    knowledge_summary = "\n".join(
        f"- {k.get('topic', 'general')}: {k.get('title', '')} — {k.get('content', '')[:200]}"
        for k in knowledge[:20]
    )

    extra_context = f"## Recent Actions (last 7 days)\n{action_summary or 'No actions this week.'}"
    if knowledge_summary:
        extra_context += f"\n\n## Knowledge Base\n{knowledge_summary}"

    # Call Claude
    result = await call_claude(
        business=business,
        task_type="report_weekly",
        user_prompt=(
            "Generate a weekly business report based on the context provided. "
            "Cover all automated actions taken, their outcomes, and recommend next steps."
        ),
        extra_context=extra_context,
        max_tokens=4096,
    )

    report_content = result.get("content", "")
    tokens_used = result.get("tokens_used", 0)
    cost_usd = result.get("cost_usd", 0)
    duration_ms = result.get("duration_ms", 0)

    # Save report to helm_business_reports
    # period_start/end are DATE columns — use YYYY-MM-DD only
    period_start_date = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d')
    period_end_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    report_row = await _sb_post("helm_business_reports", {
        "business_id": business_id,
        "report_type": "weekly_summary",
        "title": f"Weekly Report — {business.get('name', 'Business')} — {period_end_date}",
        "content": report_content,
        "tokens_used": tokens_used,
        "metrics": {"cost_usd": cost_usd, "duration_ms": duration_ms},
        "period_start": period_start_date,
        "period_end": period_end_date,
        "status": "ready",
    })
    report = report_row[0] if isinstance(report_row, list) else report_row
    report_id = report.get("id", "")

    # Create HITL item for review
    await create_hitl_item(
        business_id=business_id,
        action_type="report_review",
        title=f"Weekly Report — {business.get('name', 'Business')}",
        description="A new weekly report has been generated and needs your review.",
        payload={"report_id": report_id, "report_type": "weekly_summary", "preview": report_content[:1200] + ("…" if len(report_content) > 1200 else "")},
        risk_level="low",
        expires_hours=168,  # 1 week
    )

    # Log action — include report preview in detail so Actions tab can show it
    preview_text = report_content[:1200] + ("…" if len(report_content) > 1200 else "")
    await log_action(
        business_id=business_id,
        action_type="report_weekly",
        summary=f"Weekly report generated — {business.get('name', 'Business')} ({period_start_date} → {period_end_date})",
        detail=preview_text,
        status="success",
        tokens_used=tokens_used,
        cost_usd=cost_usd,
        duration_ms=duration_ms,
        resource_type="report",
        resource_id=report_id,
    )

    log.info("Weekly report generated for business %s (report %s)", business_id, report_id)
