"""HELM — Site health check job.

Checks all configured websites for the business:
1. Vault-stored website credentials (legacy / manual)
2. helm_wp_connections — WordPress sites
3. helm_netlify_connections — Netlify/GitHub-based sites (if netlify_site_id set)
"""

import httpx
import logging
from datetime import datetime, timezone

log = logging.getLogger("helm.jobs.health_check")

_TIMEOUT = 15  # seconds per check


async def _check_url(url: str) -> dict:
    """HEAD request to a URL. Returns {status, status_code, response_ms}."""
    if not url.startswith("http"):
        url = f"https://{url}"

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as c:
            start = datetime.now(timezone.utc)
            r = await c.head(url)
            elapsed_ms = int((datetime.now(timezone.utc) - start).total_seconds() * 1000)

            if 200 <= r.status_code < 400:
                status = "up"
            elif r.status_code >= 500:
                status = "down"
            else:
                status = "degraded"

            return {"status": status, "status_code": r.status_code, "response_ms": elapsed_ms}

    except httpx.ConnectError:
        return {"status": "down", "status_code": None, "response_ms": None}
    except httpx.TimeoutException:
        return {"status": "timeout", "status_code": None, "response_ms": None}
    except Exception as exc:
        return {"status": "error", "status_code": None, "response_ms": None, "error": str(exc)}


async def run(business_id: str, job_config: dict):
    """Check uptime for all websites associated with this business."""
    from core.supabase import _sb_get, _sb_patch
    from core.hitl import log_action

    results = []

    # ── 1. Vault credential refs (website service) ────────────────────────────
    cred_rows = await _sb_get(
        f"helm_business_credential_refs?business_id=eq.{business_id}"
        f"&service=eq.website&is_active=eq.true&select=id,label,vault_key"
    )
    for cred in (cred_rows or []):
        label = cred.get("label", "Unknown site")
        try:
            from core.vault import load_credential
            cred_data = load_credential(cred["vault_key"])
            site_url = cred_data.get("site_url")
        except Exception as exc:
            results.append({"label": label, "status": "error", "error": f"Vault: {exc}"})
            continue

        if not site_url:
            continue

        check = await _check_url(site_url)
        check["label"] = label
        check["url"] = site_url
        results.append(check)

        # Update metadata on credential ref
        try:
            await _sb_patch(
                f"helm_business_credential_refs?id=eq.{cred['id']}",
                {"metadata": {
                    "last_check": datetime.now(timezone.utc).isoformat(),
                    "uptime_status": check["status"],
                    "status_code": check.get("status_code"),
                    "response_ms": check.get("response_ms"),
                }},
            )
        except Exception as exc:
            log.warning("Failed to update cred ref uptime for %s: %s", label, exc)

    # ── 2. WordPress connections ──────────────────────────────────────────────
    wp_rows = await _sb_get(
        f"helm_wp_connections?business_id=eq.{business_id}&is_active=eq.true&select=id,site_name,site_url"
    )
    for wp in (wp_rows or []):
        label = f"WP: {wp.get('site_name', wp.get('site_url', ''))}"
        site_url = wp.get("site_url", "")
        if not site_url:
            continue

        check = await _check_url(site_url)
        check["label"] = label
        check["url"] = site_url
        results.append(check)

        try:
            now_z = datetime.now(timezone.utc).isoformat()
            await _sb_patch(
                f"helm_wp_connections?id=eq.{wp['id']}",
                {"last_tested_at": now_z, "last_test_ok": check["status"] == "up"},
            )
        except Exception as exc:
            log.warning("Failed to update WP connection health for %s: %s", label, exc)

    # ── 3. Netlify connections (optional Netlify API ping) ────────────────────
    netlify_rows = await _sb_get(
        f"helm_netlify_connections?business_id=eq.{business_id}&is_active=eq.true"
        f"&select=id,site_name,netlify_site_id,github_repo"
    )
    for nl in (netlify_rows or []):
        label = f"Netlify: {nl.get('site_name', nl.get('github_repo', ''))}"
        site_id = nl.get("netlify_site_id")
        if not site_id:
            # No site ID to probe — skip URL check but log as configured
            results.append({"label": label, "status": "unknown", "note": "No netlify_site_id configured"})
            continue

        # Ping the Netlify site URL
        site_url = f"https://{site_id}.netlify.app"
        check = await _check_url(site_url)
        check["label"] = label
        check["url"] = site_url
        results.append(check)

        try:
            now_z = datetime.now(timezone.utc).isoformat()
            await _sb_patch(
                f"helm_netlify_connections?id=eq.{nl['id']}",
                {"last_tested_at": now_z, "last_test_ok": check["status"] == "up"},
            )
        except Exception as exc:
            log.warning("Failed to update Netlify connection health for %s: %s", label, exc)

    # ── Build summary ─────────────────────────────────────────────────────────
    if not results:
        await log_action(
            business_id=business_id,
            action_type="site_health_check",
            summary="No websites configured — skipped",
            status="success",
        )
        log.info("No sites to check for business %s", business_id)
        return

    down_sites = [r for r in results if r["status"] in ("down", "timeout", "error")]
    total = len(results)

    if down_sites:
        summary = f"Site health: {len(down_sites)}/{total} site(s) DOWN — {', '.join(r['label'] for r in down_sites)}"
        detail_status = "warning"
    else:
        summary = f"Site health: all {total} site(s) UP"
        detail_status = "success"

    await log_action(
        business_id=business_id,
        action_type="site_health_check",
        summary=summary,
        detail=str(results),
        status=detail_status,
    )

    log.info("Health check for business %s: %s", business_id, summary)
