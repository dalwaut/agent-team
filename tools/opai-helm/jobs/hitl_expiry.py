"""HELM — HITL expiry job. Marks expired pending HITL items as expired."""

import logging
from datetime import datetime, timezone

log = logging.getLogger("helm.jobs.hitl_expiry")


async def run(business_id: str, job_config: dict):
    """Mark expired HITL items (expires_at < now AND status=pending) as expired."""
    from core.supabase import _sb_get, _sb_patch
    from core.hitl import log_action

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'

    # Find expired pending items
    expired_rows = await _sb_get(
        f"helm_business_hitl_queue?business_id=eq.{business_id}"
        f"&status=eq.pending&expires_at=lt.{now}"
        f"&expires_at=not.is.null&select=id,title,action_type"
    )

    if not expired_rows:
        return

    count = 0
    for item in expired_rows:
        try:
            await _sb_patch(
                f"helm_business_hitl_queue?id=eq.{item['id']}",
                {
                    "status": "expired",
                    "reviewed_at": now,
                    "reviewer_notes": "Auto-expired by scheduler",
                },
            )
            count += 1
            log.info("Expired HITL item %s: %s", item["id"], item.get("title"))
        except Exception as exc:
            log.error("Failed to expire HITL item %s: %s", item["id"], exc)

    if count > 0:
        await log_action(
            business_id=business_id,
            action_type="hitl_expiry",
            summary=f"Expired {count} HITL item(s)",
            status="success",
        )

    log.info("HITL expiry check for business %s: %d expired", business_id, count)
