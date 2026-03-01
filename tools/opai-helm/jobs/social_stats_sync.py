"""HELM — Social stats sync job (placeholder until social connectors are wired)."""

import logging

log = logging.getLogger("helm.jobs.social_stats_sync")


async def run(business_id: str, job_config: dict):
    """Placeholder: social_stats_sync job. Will pull platform analytics when connectors are ready."""
    from core.hitl import log_action

    log.info("social_stats_sync job ran for business %s (placeholder)", business_id)

    await log_action(
        business_id=business_id,
        action_type="social_stats_sync",
        summary="Social stats sync placeholder executed (connectors not yet wired)",
        status="success",
    )
