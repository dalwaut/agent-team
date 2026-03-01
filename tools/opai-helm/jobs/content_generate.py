"""HELM — Content generation job. Creates content drafts using Claude AI."""

import logging

log = logging.getLogger("helm.jobs.content_generate")


async def run(business_id: str, job_config: dict):
    """Generate content for a business using Claude AI."""
    from core.supabase import _sb_get, _sb_post
    from core.ai import call_claude
    from core.hitl import log_action, create_hitl_item

    # Load business profile
    biz_rows = await _sb_get(f"helm_businesses?id=eq.{business_id}&select=*")
    if not biz_rows:
        log.warning("Business not found: %s", business_id)
        return
    business = biz_rows[0]

    # Determine content topic from job_config or use default prompt
    topic = job_config.get("topic", "")
    content_type = job_config.get("content_type", "blog_post")
    platform = job_config.get("platform", "website")

    if topic:
        prompt = f"Write a {content_type} about: {topic}"
    else:
        # Auto-generate based on business goals and content pillars
        pillars = business.get("content_pillars", "")
        goals = business.get("goals_3mo", "")
        prompt = (
            f"Generate a {content_type} for this business. "
            f"Choose a topic that aligns with the business goals and content pillars. "
        )
        if pillars:
            prompt += f"Content pillars: {pillars}. "
        if goals:
            prompt += f"Current 3-month goals: {goals}. "
        prompt += "Choose the most impactful topic and write the full piece."

    # Load knowledge for extra context
    knowledge = await _sb_get(
        f"helm_business_knowledge?business_id=eq.{business_id}&select=topic,title,content"
    )
    extra_context = ""
    if knowledge:
        extra_context = "## Business Knowledge Base\n" + "\n".join(
            f"- {k.get('topic', 'general')}: {k.get('title', '')} — {k.get('content', '')[:200]}"
            for k in knowledge[:15]
        )

    # Load recent content feedback — informs style/direction for this run
    from datetime import datetime, timedelta, timezone
    feedback_since = (datetime.now(timezone.utc) - timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
    feedback_rows = await _sb_get(
        f"helm_business_actions?business_id=eq.{business_id}"
        f"&action_type=eq.content_feedback&created_at=gte.{feedback_since}"
        f"&order=created_at.desc&select=detail,created_at&limit=5"
    )
    if feedback_rows:
        feedback_lines = "\n".join(
            f"- {r.get('detail', '')}" for r in feedback_rows if r.get("detail")
        )
        if feedback_lines:
            extra_context += f"\n\n## Recent Feedback on Past Content\nApply these notes to improve this piece:\n{feedback_lines}"

    # Determine task type based on content_type
    task_type = "social_post" if content_type in ("social_post", "tweet", "linkedin_post") else "content_generate"

    # Call Claude
    result = await call_claude(
        business=business,
        task_type=task_type,
        user_prompt=prompt,
        extra_context=extra_context,
        max_tokens=4096 if task_type == "content_generate" else 1024,
    )

    content_text = result.get("content", "")
    tokens_used = result.get("tokens_used", 0)
    cost_usd = result.get("cost_usd", 0)
    duration_ms = result.get("duration_ms", 0)

    # Save draft to helm_business_content
    content_row = await _sb_post("helm_business_content", {
        "business_id": business_id,
        "content_type": content_type,
        "platform": platform,
        "title": topic or f"Auto-generated {content_type}",
        "body": content_text,
        "status": "draft",
        "tokens_used": tokens_used,
        "cost_usd": cost_usd,
    })
    content = content_row[0] if isinstance(content_row, list) else content_row
    content_id = content.get("id", "")

    # Build a readable title for this piece
    content_title = topic or f"Auto-generated {content_type.replace('_', ' ')}"

    # Check if HITL is required
    hitl_required = business.get("hitl_required", True)
    if hitl_required:
        await create_hitl_item(
            business_id=business_id,
            action_type="content_review",
            title=f"Review: {content_title}",
            description=f"New {content_type.replace('_', ' ')} ready for review — approve to publish.",
            payload={
                "content_id": content_id,
                "content_type": content_type,
                "platform": platform,
                "preview": content_text[:1200] + ("…" if len(content_text) > 1200 else ""),
            },
            risk_level="low",
            expires_hours=72,
        )

    # Log action — include content preview in detail so Actions tab can show it
    preview_text = content_text[:1200] + ("…" if len(content_text) > 1200 else "")
    await log_action(
        business_id=business_id,
        action_type="content_generate",
        summary=f'New {content_type.replace("_", " ")}: "{content_title}"',
        detail=preview_text,
        status="success",
        tokens_used=tokens_used,
        cost_usd=cost_usd,
        duration_ms=duration_ms,
        resource_type="content",
        resource_id=content_id,
    )

    log.info("Content generated for business %s: %s (content %s)", business_id, content_type, content_id)
