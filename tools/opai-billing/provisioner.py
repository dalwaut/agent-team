"""OPAI Billing — Auto-provisioning pipeline.

When a new user purchases OPAI access, this module handles:
1. Creating their OPAI profile (on OPAI Supabase)
2. Setting up sandbox access
3. Queuing n8n account creation
4. Sending welcome email

This runs asynchronously after checkout completion.
"""

import logging

from stripe_client import bb_query

logger = logging.getLogger("opai-billing.provisioner")


async def queue_provisioning(
    user_id: str,
    trigger_event: str,
    trigger_id: str = None,
    metadata: dict = None,
):
    """Add a provisioning task to the queue."""
    steps = [
        {"name": "create_opai_profile", "status": "pending"},
        {"name": "provision_sandbox", "status": "pending"},
        {"name": "provision_n8n", "status": "pending"},
        {"name": "send_welcome_email", "status": "pending"},
    ]

    try:
        await bb_query("provisioning_queue", method="POST", body={
            "user_id": user_id,
            "trigger_event": trigger_event,
            "trigger_id": trigger_id,
            "steps": steps,
            "status": "pending",
            "metadata": metadata or {},
        })
        logger.info(f"Provisioning queued for user {user_id}")
    except Exception as e:
        logger.error(f"Failed to queue provisioning for {user_id}: {e}")


async def process_provisioning_queue():
    """Process pending provisioning tasks.

    This is called periodically or can be triggered manually.
    Full provisioning (sandbox, n8n, email) requires OPAI server-side
    infrastructure — for now we queue the tasks and the orchestrator
    or manual admin action completes them.
    """
    pending = await bb_query(
        "provisioning_queue",
        "status=eq.pending&select=*&order=created_at.asc&limit=10"
    )

    for task in pending:
        task_id = task["id"]
        user_id = task["user_id"]
        email = task.get("metadata", {}).get("email", "")

        logger.info(f"Processing provisioning for {email} ({user_id})")

        # Mark as in-progress
        await bb_query(
            "provisioning_queue",
            f"id=eq.{task_id}",
            method="PATCH",
            body={"status": "in_progress"},
        )

        steps = task.get("steps", [])
        all_done = True

        for step in steps:
            if step["status"] == "completed":
                continue

            try:
                if step["name"] == "create_opai_profile":
                    # Create profile on OPAI Supabase
                    # This will be handled by the OPAI portal on first login
                    step["status"] = "completed"
                    logger.info(f"  OPAI profile will be created on first login")

                elif step["name"] == "provision_sandbox":
                    # Sandbox provisioning requires server-side access
                    # Queue for orchestrator/manual
                    step["status"] = "queued"
                    all_done = False
                    logger.info(f"  Sandbox provisioning queued for orchestrator")

                elif step["name"] == "provision_n8n":
                    # n8n provisioning requires BB VPS access
                    step["status"] = "queued"
                    all_done = False
                    logger.info(f"  n8n provisioning queued for orchestrator")

                elif step["name"] == "send_welcome_email":
                    # Welcome email — will be sent via n8n workflow
                    step["status"] = "queued"
                    all_done = False
                    logger.info(f"  Welcome email queued for n8n workflow")

            except Exception as e:
                step["status"] = "error"
                step["error"] = str(e)
                all_done = False
                logger.error(f"  Step {step['name']} failed: {e}")

        # Update steps and status
        final_status = "completed" if all_done else "partial"
        await bb_query(
            "provisioning_queue",
            f"id=eq.{task_id}",
            method="PATCH",
            body={"steps": steps, "status": final_status},
        )

    return len(pending)
