"""HELM — Competitor research job via NotebookLM.

Leverages NotebookLM's web research to build competitive intelligence
for managed businesses. Creates persistent per-business notebooks with
competitor data, then synthesizes analysis via grounded Q&A.
"""

import logging
from datetime import datetime, timezone

log = logging.getLogger("helm.jobs.competitor_research")


async def run(business_id: str, job_config: dict):
    """Run competitor research for a business using NotebookLM."""
    from core.supabase import _sb_get, _sb_post
    from core.hitl import log_action, create_hitl_item

    # Load business profile
    biz_rows = await _sb_get(f"helm_businesses?id=eq.{business_id}&select=*")
    if not biz_rows:
        log.warning("Business not found: %s", business_id)
        return
    business = biz_rows[0]
    biz_name = business.get("name", "Business")

    # Get competitors from job_config or business metadata
    competitors = job_config.get("competitors", [])
    if not competitors:
        meta = business.get("metadata", {}) or {}
        competitors = meta.get("competitors", [])

    if not competitors:
        log.info("No competitors configured for %s — skipping", biz_name)
        await log_action(
            business_id=business_id,
            action_type="competitor_research",
            summary=f"Competitor research skipped — no competitors configured",
            status="skipped",
        )
        return

    # Try NotebookLM
    try:
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
        from nlm import (
            is_available, get_client, ensure_notebook,
            add_source_url, research_topic, ask_notebook,
        )

        if not is_available():
            raise ImportError("NotebookLM not configured")

        client = await get_client()
        async with client:
            nb_id = await ensure_notebook(client, f"HELM Competitors: {biz_name}")

            # Add competitor URLs as sources
            for comp in competitors[:10]:
                url = comp if isinstance(comp, str) else comp.get("url", "")
                if url:
                    try:
                        await add_source_url(client, nb_id, url)
                    except Exception as e:
                        log.warning("[Competitor] Failed to add source %s: %s", url, e)

            # Research each competitor
            comp_names = []
            for comp in competitors[:5]:
                name = comp if isinstance(comp, str) else comp.get("name", comp.get("url", ""))
                comp_names.append(name)
                try:
                    await research_topic(
                        client, nb_id,
                        query=f"Latest updates, products, and strategy for {name}",
                    )
                except Exception as e:
                    log.warning("[Competitor] Research failed for %s: %s", name, e)

            # Synthesize competitive analysis
            analysis_prompt = (
                f"Provide a competitive analysis for {biz_name} against these competitors: "
                f"{', '.join(comp_names)}. Include: key differentiators, pricing comparison, "
                f"strengths and weaknesses, market positioning, and strategic recommendations."
            )
            analysis_result = await ask_notebook(client, nb_id, analysis_prompt)
            analysis_text = analysis_result.get("answer", "")

        # Save as knowledge entry
        if analysis_text:
            await _sb_post("helm_business_knowledge", {
                "business_id": business_id,
                "topic": "competitors",
                "title": f"Competitive Analysis — {datetime.now(timezone.utc).strftime('%Y-%m-%d')}",
                "content": analysis_text,
            })

        # Create HITL item for review
        await create_hitl_item(
            business_id=business_id,
            action_type="competitor_review",
            title=f"Competitor Research — {biz_name}",
            description=f"New competitive analysis against {len(comp_names)} competitors.",
            payload={
                "competitors": comp_names,
                "preview": analysis_text[:1200] + ("…" if len(analysis_text) > 1200 else ""),
            },
            risk_level="low",
            expires_hours=168,
        )

        await log_action(
            business_id=business_id,
            action_type="competitor_research",
            summary=f"Competitor research completed — {len(comp_names)} competitors analyzed via NotebookLM",
            detail=analysis_text[:1200] + ("…" if len(analysis_text) > 1200 else ""),
            status="success",
        )

        log.info("Competitor research completed for %s (%d competitors)", biz_name, len(comp_names))

    except (ImportError, Exception) as e:
        log.warning("[Competitor] NotebookLM unavailable for %s: %s — skipping", biz_name, e)
        await log_action(
            business_id=business_id,
            action_type="competitor_research",
            summary=f"Competitor research skipped — NotebookLM unavailable: {str(e)[:100]}",
            status="skipped",
        )
