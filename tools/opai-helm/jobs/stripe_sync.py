"""HELM — Stripe sync job (placeholder until Stripe connector is wired)."""

import logging

log = logging.getLogger("helm.jobs.stripe_sync")


async def run(business_id: str, job_config: dict):
    """Placeholder: stripe_sync job. Will pull revenue data when Stripe connector is ready."""
    from core.hitl import log_action

    log.info("stripe_sync job ran for business %s (placeholder)", business_id)

    await log_action(
        business_id=business_id,
        action_type="stripe_sync",
        summary="Stripe sync placeholder executed (connector not yet wired)",
        status="success",
    )
