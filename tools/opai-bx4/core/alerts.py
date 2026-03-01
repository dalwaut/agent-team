"""Bx4 — Threshold monitoring and alert management."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx
import config

log = logging.getLogger("bx4.alerts")


def _headers(service_key: str) -> dict:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


def _evaluate_condition(alert: dict, snapshot: dict) -> bool:
    """Evaluate whether an alert condition is met against the snapshot.

    Alert format: {metric: "runway_months", operator: "lt", threshold: 2}
    Supported operators: lt, lte, gt, gte, eq
    """
    metric = alert.get("metric", "")
    operator = alert.get("operator", "lt")
    threshold = alert.get("threshold", 0)
    value = snapshot.get(metric)

    if value is None:
        return False

    try:
        value = float(value)
        threshold = float(threshold)
    except (ValueError, TypeError):
        return False

    if operator == "lt":
        return value < threshold
    elif operator == "lte":
        return value <= threshold
    elif operator == "gt":
        return value > threshold
    elif operator == "gte":
        return value >= threshold
    elif operator == "eq":
        return value == threshold
    return False


async def _get_setting(company_id: str, key: str, service_key: str) -> str | None:
    """Fetch a setting value for the company (falls back to global)."""
    url = (
        f"{config.SUPABASE_URL}/rest/v1/bx4_settings"
        f"?company_id=eq.{company_id}&key=eq.{key}&select=value&limit=1"
    )
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.get(url, headers=_headers(service_key))
        rows = r.json() if r.status_code == 200 else []
    if rows:
        return rows[0].get("value")
    # Try global
    url2 = (
        f"{config.SUPABASE_URL}/rest/v1/bx4_settings"
        f"?company_id=is.null&key=eq.{key}&select=value&limit=1"
    )
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.get(url2, headers=_headers(service_key))
        rows2 = r.json() if r.status_code == 200 else []
    return rows2[0].get("value") if rows2 else None


async def dispatch_alert_notifications(
    alert: dict,
    company_id: str,
    company_name: str,
    service_key: str,
) -> None:
    """Send alert notification via Discord and/or email per company settings."""
    notify_discord = await _get_setting(company_id, "notify_discord", service_key)
    notify_email = await _get_setting(company_id, "notify_email", service_key)
    alert_email = await _get_setting(company_id, "notify_email_address", service_key)

    severity = alert.get("severity", "medium").upper()
    label = alert.get("label", "Alert")
    condition = alert.get("condition", "")

    msg = (
        f"**[BX4 ALERT — {severity}] {company_name}**\n"
        f"**{label}**\n"
        f"Condition: `{condition}`\n"
        f"Triggered: {alert.get('fired_at', '')}"
    )

    now = datetime.now(timezone.utc).isoformat()
    dispatched = False

    if notify_discord and notify_discord.lower() != "false":
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(
                    f"{config.DISCORD_BRIDGE_URL}/api/send",
                    json={"content": msg},
                )
            dispatched = True
        except Exception as exc:
            log.warning("Alert Discord dispatch failed: %s", exc)

    if notify_email and notify_email.lower() != "false" and alert_email:
        try:
            email_url = getattr(config, "EMAIL_AGENT_URL", "http://127.0.0.1:8085")
            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(
                    f"{email_url}/api/send",
                    json={
                        "to": alert_email,
                        "subject": f"Bx4 Alert: {label} — {company_name}",
                        "body": msg.replace("**", "").replace("`", ""),
                        "format": "text",
                    },
                )
            dispatched = True
        except Exception as exc:
            log.warning("Alert email dispatch failed: %s", exc)

    if dispatched and alert.get("id"):
        patch_url = f"{config.SUPABASE_URL}/rest/v1/bx4_alerts?id=eq.{alert['id']}"
        async with httpx.AsyncClient(timeout=5) as c:
            await c.patch(
                patch_url,
                headers={**_headers(service_key), "Prefer": "return=minimal"},
                json={"dispatched_at": now},
            )


async def check_alerts(
    company_id: str, snapshot: dict,
    supabase_url: str, service_key: str,
) -> list[dict]:
    """Fetch alerts for company, evaluate against snapshot, fire if conditions met.

    Returns list of newly fired alerts.
    """
    url = (
        f"{supabase_url}/rest/v1/bx4_alerts"
        f"?company_id=eq.{company_id}&is_active=eq.true&select=*"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers(service_key))
        r.raise_for_status()
        alerts = r.json()

    newly_fired: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    for alert in alerts:
        already_fired = alert.get("fired_at") is not None
        resolved = alert.get("resolved_at") is not None

        if already_fired and not resolved:
            # Already active, skip
            continue

        if _evaluate_condition(alert, snapshot):
            # Fire the alert
            patch_url = (
                f"{supabase_url}/rest/v1/bx4_alerts"
                f"?id=eq.{alert['id']}"
            )
            async with httpx.AsyncClient(timeout=10) as c:
                await c.patch(
                    patch_url,
                    headers={**_headers(service_key), "Prefer": "return=minimal"},
                    json={"fired_at": now, "resolved_at": None},
                )
            alert["fired_at"] = now
            newly_fired.append(alert)
            # Dispatch notifications (non-blocking)
            try:
                company_name = snapshot.get("company_name", "Company")
                await dispatch_alert_notifications(alert, company_id, company_name, service_key)
            except Exception as _exc:
                log.warning("Alert notification dispatch error: %s", _exc)
        elif already_fired and not resolved:
            pass  # Already handled above
        elif already_fired and resolved:
            # Was resolved, check if condition re-triggers
            if _evaluate_condition(alert, snapshot):
                patch_url = (
                    f"{supabase_url}/rest/v1/bx4_alerts"
                    f"?id=eq.{alert['id']}"
                )
                async with httpx.AsyncClient(timeout=10) as c:
                    await c.patch(
                        patch_url,
                        headers={**_headers(service_key), "Prefer": "return=minimal"},
                        json={"fired_at": now, "resolved_at": None},
                    )
                alert["fired_at"] = now
                newly_fired.append(alert)

    return newly_fired


async def get_active_alerts(
    company_id: str, supabase_url: str, service_key: str,
) -> list[dict]:
    """Fetch currently fired (fired_at IS NOT NULL, resolved_at IS NULL) alerts."""
    url = (
        f"{supabase_url}/rest/v1/bx4_alerts"
        f"?company_id=eq.{company_id}"
        f"&fired_at=not.is.null&resolved_at=is.null"
        f"&is_active=eq.true&select=*"
    )
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url, headers=_headers(service_key))
        r.raise_for_status()
        return r.json()
