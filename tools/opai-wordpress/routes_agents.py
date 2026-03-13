"""OP WordPress — WP Agents routes (CRUD + run + scan history + link actions)."""

import asyncio
import base64
import logging
import re
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import config
from auth import get_current_user, AuthUser

log = logging.getLogger("opai-wordpress.agents")

router = APIRouter(prefix="/api")

# Schedule → cron mapping
_SCHEDULE_CRON = {
    "weekly": "0 3 * * 1",      # Monday 3 AM
    "monthly": "0 3 1 * *",     # 1st of month 3 AM
}


def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Request Models ────────────────────────────────────────

class CreateAgent(BaseModel):
    template_id: str
    name: str
    config: dict = {}
    schedule: str = "manual"
    enabled: bool = True


class UpdateAgent(BaseModel):
    name: Optional[str] = None
    config: Optional[dict] = None
    schedule: Optional[str] = None
    enabled: Optional[bool] = None


# ── Helpers ───────────────────────────────────────────────

def _compute_next_run(schedule: str) -> Optional[str]:
    """Compute next_run_at from schedule label. Returns ISO string or None."""
    cron = _SCHEDULE_CRON.get(schedule)
    if not cron:
        return None
    from services.scheduler import _compute_next_run as _calc
    return _calc(cron, "America/Chicago")


async def _verify_site_access(site_id: str, user: AuthUser):
    """Verify user owns the site, has it shared via TeamHub, or is admin.

    Returns the site row. For shared sites the row includes the owner's user_id
    so downstream queries can filter agents/scans by the site owner.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        # 1. Try direct ownership (or admin sees all)
        url = f"{_sb_url('wp_sites')}?id=eq.{site_id}&select=*"
        if not user.is_admin:
            url += f"&user_id=eq.{user.id}"
        resp = await client.get(url, headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch site")
        sites = resp.json()
        if sites:
            return sites[0]

        # 2. Check if site is shared with this user via TeamHub
        if not user.is_admin:
            from routes_sites import _get_shared_site_owner_ids
            shared_entries = await _get_shared_site_owner_ids(client, user.id)
            if shared_entries:
                shared_owner_ids = [e["shared_by"] for e in shared_entries if e.get("shared_by")]
                for owner_id in shared_owner_ids:
                    url2 = (f"{_sb_url('wp_sites')}?id=eq.{site_id}"
                            f"&user_id=eq.{owner_id}&select=*")
                    resp2 = await client.get(url2, headers=_sb_headers())
                    if resp2.status_code == 200 and resp2.json():
                        site = resp2.json()[0]
                        site["_shared"] = True
                        return site

        raise HTTPException(404, "Site not found")


# ── Agent CRUD ────────────────────────────────────────────

@router.get("/sites/{site_id}/agents")
async def list_agents(site_id: str, user: AuthUser = Depends(get_current_user)):
    """List agents for a site."""
    site = await _verify_site_access(site_id, user)

    # Use site owner's user_id for agent queries (shared users see owner's agents)
    owner_id = site["user_id"]
    params = f"?site_id=eq.{site_id}&select=*&order=created_at.desc"
    if not user.is_admin:
        params += f"&user_id=eq.{owner_id}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{_sb_url('wp_agents')}{params}", headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch agents")
        return resp.json()


@router.post("/sites/{site_id}/agents")
async def create_agent(site_id: str, body: CreateAgent,
                       user: AuthUser = Depends(get_current_user)):
    """Create a new agent for a site. Shared users create agents under the site owner."""
    site = await _verify_site_access(site_id, user)

    # Use site owner's user_id so agents are visible in listings
    # (list_agents filters by owner_id = site["user_id"])
    owner_id = site["user_id"]

    cron = _SCHEDULE_CRON.get(body.schedule)
    next_run = _compute_next_run(body.schedule)

    row = {
        "site_id": site_id,
        "user_id": owner_id,
        "template_id": body.template_id,
        "name": body.name,
        "config": body.config,
        "schedule": body.schedule,
        "enabled": body.enabled,
        "cron_expression": cron,
        "next_run_at": next_run,
        "status": "idle",
    }

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_sb_url("wp_agents"), headers=_sb_headers(), json=row)
        if resp.status_code not in (200, 201):
            raise HTTPException(500, f"Failed to create agent: {resp.text}")
        return resp.json()[0]


@router.get("/sites/{site_id}/agents/{agent_id}")
async def get_agent(site_id: str, agent_id: str,
                    user: AuthUser = Depends(get_current_user)):
    """Get a single agent."""
    site = await _verify_site_access(site_id, user)
    owner_id = site["user_id"]

    async with httpx.AsyncClient(timeout=10) as client:
        url = f"{_sb_url('wp_agents')}?id=eq.{agent_id}&site_id=eq.{site_id}&select=*"
        if not user.is_admin:
            url += f"&user_id=eq.{owner_id}"
        resp = await client.get(url, headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch agent")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, "Agent not found")
        return rows[0]


@router.patch("/sites/{site_id}/agents/{agent_id}")
async def update_agent(site_id: str, agent_id: str, body: UpdateAgent,
                       user: AuthUser = Depends(get_current_user)):
    """Update agent config/schedule."""
    site = await _verify_site_access(site_id, user)
    owner_id = site["user_id"]

    update = {k: v for k, v in body.dict().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")

    # Recompute cron/next_run if schedule changed
    if "schedule" in update:
        update["cron_expression"] = _SCHEDULE_CRON.get(update["schedule"])
        update["next_run_at"] = _compute_next_run(update["schedule"])

    update["updated_at"] = "now()"

    async with httpx.AsyncClient(timeout=10) as client:
        url = f"{_sb_url('wp_agents')}?id=eq.{agent_id}&site_id=eq.{site_id}"
        if not user.is_admin:
            url += f"&user_id=eq.{owner_id}"
        resp = await client.patch(url, headers=_sb_headers(), json=update)
        if resp.status_code not in (200, 204):
            raise HTTPException(500, f"Failed to update agent: {resp.text}")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, "Agent not found")
        return rows[0]


@router.delete("/sites/{site_id}/agents/{agent_id}")
async def delete_agent(site_id: str, agent_id: str,
                       user: AuthUser = Depends(get_current_user)):
    """Remove an agent."""
    site = await _verify_site_access(site_id, user)
    owner_id = site["user_id"]

    async with httpx.AsyncClient(timeout=10) as client:
        url = f"{_sb_url('wp_agents')}?id=eq.{agent_id}&site_id=eq.{site_id}"
        if not user.is_admin:
            url += f"&user_id=eq.{owner_id}"
        resp = await client.delete(url, headers=_sb_headers())
        if resp.status_code not in (200, 204):
            raise HTTPException(500, "Failed to delete agent")
    return {"ok": True}


# ── Run ───────────────────────────────────────────────────

@router.post("/sites/{site_id}/agents/{agent_id}/run")
async def run_agent(site_id: str, agent_id: str,
                    user: AuthUser = Depends(get_current_user)):
    """Manually trigger an agent run. Returns immediately, runs in background."""
    site = await _verify_site_access(site_id, user)
    agent = await get_agent(site_id, agent_id, user)

    if agent["status"] == "running":
        raise HTTPException(409, "Agent is already running")

    # Mark as running
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{_sb_url('wp_agents')}?id=eq.{agent_id}",
            headers=_sb_headers(),
            json={"status": "running"},
        )

    # Launch task in background
    if agent["template_id"] == "broken-link-scanner":
        asyncio.create_task(_run_scan_task(site, agent, user.id))
    elif agent["template_id"] == "performance-auditor":
        asyncio.create_task(_run_audit_task(site, agent, user.id))
    else:
        # Reset status for unsupported templates
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_agents')}?id=eq.{agent_id}",
                headers=_sb_headers(),
                json={"status": "idle"},
            )
        raise HTTPException(400, f"Agent template '{agent['template_id']}' not yet implemented")

    return {"ok": True, "message": "Agent run started"}


async def _run_scan_task(site: dict, agent: dict, user_id: str):
    """Background wrapper for running a scan and updating agent status."""
    try:
        from services.broken_link_scanner import run_scan
        await run_scan(site, agent, user_id)
    except Exception as e:
        log.error("Agent %s scan failed: %s", agent["id"], e)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.patch(
                    f"{_sb_url('wp_agents')}?id=eq.{agent['id']}",
                    headers=_sb_headers(),
                    json={"status": "failed", "last_run_at": "now()"},
                )
        except Exception:
            pass


async def _run_audit_task(site: dict, agent: dict, user_id: str):
    """Background wrapper for running a performance audit."""
    try:
        from services.performance_auditor import run_audit
        await run_audit(site, agent, user_id)
    except Exception as e:
        log.error("Agent %s audit failed: %s", agent["id"], e)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.patch(
                    f"{_sb_url('wp_agents')}?id=eq.{agent['id']}",
                    headers=_sb_headers(),
                    json={"status": "failed", "last_run_at": "now()"},
                )
        except Exception:
            pass


# ── Scan History ──────────────────────────────────────────

@router.get("/sites/{site_id}/agents/{agent_id}/scans")
async def list_scans(site_id: str, agent_id: str, limit: int = 10,
                     user: AuthUser = Depends(get_current_user)):
    """List scan history for an agent."""
    await _verify_site_access(site_id, user)

    params = (
        f"?agent_id=eq.{agent_id}&site_id=eq.{site_id}"
        f"&select=id,started_at,completed_at,status,total_links,checked_links,broken_links,warning_links,scope,report_sent"
        f"&order=started_at.desc&limit={limit}"
    )

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{_sb_url('wp_link_scans')}{params}", headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch scans")
        return resp.json()


@router.get("/scans/{scan_id}")
async def get_scan(scan_id: str, user: AuthUser = Depends(get_current_user)):
    """Get full scan results."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Fetch the scan first (service key), then verify access via site ownership/sharing
        url = f"{_sb_url('wp_link_scans')}?id=eq.{scan_id}&select=*"
        resp = await client.get(url, headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch scan")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, "Scan not found")

        scan = rows[0]

        # Verify user has access to this scan's site
        if not user.is_admin:
            await _verify_site_access(scan["site_id"], user)

        return scan


# ── Performance Audit History ─────────────────────────────

@router.get("/sites/{site_id}/agents/{agent_id}/audits")
async def list_audits(site_id: str, agent_id: str, limit: int = 10,
                      user: AuthUser = Depends(get_current_user)):
    """List performance audit history for an agent."""
    await _verify_site_access(site_id, user)

    params = (
        f"?agent_id=eq.{agent_id}&site_id=eq.{site_id}"
        f"&select=id,started_at,completed_at,status,overall_score,pages_audited,pages_checked,"
        f"issues_found,critical_issues,avg_lcp,avg_fcp,avg_cls,avg_ttfb,avg_tbt,scope,report_sent"
        f"&order=started_at.desc&limit={limit}"
    )

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_performance_audits')}{params}", headers=_sb_headers()
        )
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch audits")
        return resp.json()


@router.get("/audits/{audit_id}")
async def get_audit(audit_id: str, user: AuthUser = Depends(get_current_user)):
    """Get full performance audit results."""
    async with httpx.AsyncClient(timeout=10) as client:
        url = f"{_sb_url('wp_performance_audits')}?id=eq.{audit_id}&select=*"
        resp = await client.get(url, headers=_sb_headers())
        if resp.status_code != 200:
            raise HTTPException(500, "Failed to fetch audit")
        rows = resp.json()
        if not rows:
            raise HTTPException(404, "Audit not found")

        audit = rows[0]
        if not user.is_admin:
            await _verify_site_access(audit["site_id"], user)
        return audit


# ── Link Actions ─────────────────────────────────────────

class RemoveLinkBody(BaseModel):
    post_id: int
    post_type: str = "post"
    broken_url: str
    action: str = "unlink"  # "unlink" (keep text) or "remove" (delete tag + text)


@router.post("/sites/{site_id}/remove-link")
async def remove_link(site_id: str, body: RemoveLinkBody,
                      user: AuthUser = Depends(get_current_user)):
    """Remove or unlink a broken link from a WP post/page."""
    site = await _verify_site_access(site_id, user)

    wp_type = "pages" if body.post_type == "page" else "posts"
    cred = base64.b64encode(
        f"{site['username']}:{site['app_password']}".encode()
    ).decode()
    wp_headers = {
        "Authorization": f"Basic {cred}",
        "Content-Type": "application/json",
    }
    api_base = site.get("api_base", "/wp-json")
    base_url = site["url"].rstrip("/")

    # Fetch the post content
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{base_url}{api_base}/wp/v2/{wp_type}/{body.post_id}?_fields=id,content",
            headers=wp_headers,
        )
        if resp.status_code != 200:
            raise HTTPException(400, f"Failed to fetch post: {resp.text}")
        post = resp.json()

    content_raw = post.get("content", {})
    html = content_raw.get("rendered", "") if isinstance(content_raw, dict) else str(content_raw)
    if not html:
        raise HTTPException(400, "Post has no content")

    # Parse and modify HTML
    soup = BeautifulSoup(html, "html.parser")
    modified = False

    for a_tag in soup.find_all("a", href=True):
        if a_tag["href"].strip() == body.broken_url:
            if body.action == "remove":
                a_tag.decompose()
            else:
                # Unlink: replace <a> with its text content
                a_tag.replace_with(a_tag.get_text())
            modified = True

    if not modified:
        raise HTTPException(404, "Link not found in post content")

    new_html = str(soup)

    # Update the post
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{base_url}{api_base}/wp/v2/{wp_type}/{body.post_id}",
            headers=wp_headers,
            json={"content": new_html},
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(500, f"Failed to update post: {resp.text}")

    return {"ok": True, "message": f"Link {'removed' if body.action == 'remove' else 'unlinked'} from post"}


class DismissLinkBody(BaseModel):
    scan_id: str
    broken_url: str
    post_id: int


@router.post("/sites/{site_id}/dismiss-link")
async def dismiss_link(site_id: str, body: DismissLinkBody,
                       user: AuthUser = Depends(get_current_user)):
    """Dismiss a broken link from scan results (remove from results array)."""
    await _verify_site_access(site_id, user)

    # Fetch the scan
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_sb_url('wp_link_scans')}?id=eq.{body.scan_id}&select=*",
            headers=_sb_headers(),
        )
        if resp.status_code != 200 or not resp.json():
            raise HTTPException(404, "Scan not found")
        scan = resp.json()[0]

    results = scan.get("results") or []
    new_results = [
        r for r in results
        if not (r.get("url") == body.broken_url and r.get("post_id") == body.post_id)
    ]

    if len(new_results) == len(results):
        return {"ok": True, "message": "Link already dismissed"}

    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{_sb_url('wp_link_scans')}?id=eq.{body.scan_id}",
            headers=_sb_headers(),
            json={"results": new_results, "broken_links": len(new_results)},
        )

    return {"ok": True, "message": "Link dismissed"}


class AiFixBody(BaseModel):
    post_id: int
    post_type: str = "post"
    broken_url: str
    scan_id: Optional[str] = None


@router.post("/sites/{site_id}/ai-fix-link")
async def ai_fix_link_endpoint(site_id: str, body: AiFixBody,
                                user: AuthUser = Depends(get_current_user)):
    """AI Fix: re-verify a broken link, find the correct URL, apply the fix."""
    site = await _verify_site_access(site_id, user)

    from services.broken_link_scanner import ai_fix_link
    result = await ai_fix_link(body.broken_url)

    action = result["action"]
    new_url = result.get("new_url")

    # Apply the fix to the WP post
    if action in ("replace", "unlink"):
        wp_type = "pages" if body.post_type == "page" else "posts"
        cred = base64.b64encode(
            f"{site['username']}:{site['app_password']}".encode()
        ).decode()
        wp_headers = {
            "Authorization": f"Basic {cred}",
            "Content-Type": "application/json",
        }
        api_base = site.get("api_base", "/wp-json")
        base_url = site["url"].rstrip("/")

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{base_url}{api_base}/wp/v2/{wp_type}/{body.post_id}?_fields=id,content",
                    headers=wp_headers,
                )
                if resp.status_code != 200:
                    return {**result, "applied": False, "error": "Could not fetch post"}
                post = resp.json()

            content_raw = post.get("content", {})
            html = content_raw.get("rendered", "") if isinstance(content_raw, dict) else str(content_raw)

            soup = BeautifulSoup(html, "html.parser")
            modified = False
            for a_tag in soup.find_all("a", href=True):
                if a_tag["href"].strip() == body.broken_url:
                    if action == "replace" and new_url:
                        a_tag["href"] = new_url
                    else:
                        a_tag.replace_with(a_tag.get_text())
                    modified = True

            if modified:
                async with httpx.AsyncClient(timeout=15) as client:
                    resp = await client.post(
                        f"{base_url}{api_base}/wp/v2/{wp_type}/{body.post_id}",
                        headers=wp_headers,
                        json={"content": str(soup)},
                    )
                    if resp.status_code not in (200, 201):
                        return {**result, "applied": False, "error": "Failed to update post"}

            result["applied"] = modified
        except Exception as e:
            log.error("AI fix apply error: %s", e)
            result["applied"] = False
            result["error"] = str(e)
    else:
        # "none" — false positive, no change needed
        result["applied"] = True

    # Update scan results if scan_id provided
    if body.scan_id and result.get("applied"):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{_sb_url('wp_link_scans')}?id=eq.{body.scan_id}&select=results,broken_links",
                    headers=_sb_headers(),
                )
                if resp.status_code == 200 and resp.json():
                    scan = resp.json()[0]
                    results_arr = scan.get("results") or []
                    new_results = []
                    for r in results_arr:
                        if r.get("url") == body.broken_url and r.get("post_id") == body.post_id:
                            r["error_type"] = (
                                "valid" if result["status"] == "valid"
                                else "repaired" if result["status"] == "repaired"
                                else "unlinked"
                            )
                            r["context"] = result["message"]
                            if new_url:
                                r["new_url"] = new_url
                        new_results.append(r)
                    await client.patch(
                        f"{_sb_url('wp_link_scans')}?id=eq.{body.scan_id}",
                        headers=_sb_headers(),
                        json={"results": new_results},
                    )
        except Exception as e:
            log.warning("Failed to update scan results: %s", e)

    return result
