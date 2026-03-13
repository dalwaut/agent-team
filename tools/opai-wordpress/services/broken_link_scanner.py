"""Broken Link Scanner — crawls WP posts/pages, checks links, reports results."""

import asyncio
import base64
import logging
import os
import re
import smtplib
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

import config

log = logging.getLogger("opai-wordpress.link-scanner")


def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


def _wp_auth(site: dict) -> str:
    """Build Basic Auth header value."""
    cred = base64.b64encode(
        f"{site['username']}:{site['app_password']}".encode()
    ).decode()
    return f"Basic {cred}"


def _wp_api(site: dict, path: str) -> str:
    base_url = site["url"].rstrip("/")
    api_base = site.get("api_base", "/wp-json")
    return f"{base_url}{api_base}{path}"


# ── Main entry point ─────────────────────────────────────────

async def run_scan(site: dict, agent: dict, user_id: str) -> dict:
    """Run a full broken link scan. Called from routes or scheduler."""
    agent_id = agent["id"]
    site_id = site["id"]
    agent_config = agent.get("config") or {}
    scope = agent_config.get("scope", "All posts & pages")

    # Create scan record
    scan_row = {
        "site_id": site_id,
        "agent_id": agent_id,
        "user_id": user_id,
        "status": "running",
        "scope": scope,
        "report_email": agent_config.get("report_email", ""),
    }

    scan_id = None
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_sb_url("wp_link_scans"), headers=_sb_headers(), json=scan_row)
        if resp.status_code in (200, 201) and resp.json():
            scan_id = resp.json()[0]["id"]

    if not scan_id:
        log.error("Failed to create scan record for agent %s", agent_id)
        await _update_agent_status(agent_id, "failed")
        return {}

    try:
        # 1. Fetch content from WP
        posts = await _fetch_content(site, scope)
        log.info("Fetched %d items from %s (scope: %s)", len(posts), site.get("name"), scope)

        # 2. Extract links
        all_links = _extract_links(posts, site["url"])
        unique_urls = list({link["url"] for link in all_links})
        log.info("Found %d unique URLs across %d posts", len(unique_urls), len(posts))

        # Set total_links upfront so frontend can show progress denominator
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_link_scans')}?id=eq.{scan_id}",
                headers=_sb_headers(),
                json={"total_links": len(unique_urls)},
            )

        # 3. Check links with incremental progress updates
        check_results = await _check_links_with_progress(
            unique_urls, all_links, scan_id, site_url=site["url"]
        )

        # 4. Build final broken results
        broken = _build_broken_results(all_links, check_results)
        broken_count = sum(1 for b in broken if b.get("severity") == "broken")
        warning_count = sum(1 for b in broken if b.get("severity") == "warning")
        log.info("Found %d broken + %d warnings on %s",
                 broken_count, warning_count, site.get("name"))

        # 5. Final scan record update (completed)
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_link_scans')}?id=eq.{scan_id}",
                headers=_sb_headers(),
                json={
                    "status": "completed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "total_links": len(unique_urls),
                    "checked_links": len(unique_urls),
                    "broken_links": broken_count,
                    "warning_links": warning_count,
                    "results": broken,
                },
            )

        # 6. Flag posts in WordPress (if enabled)
        if agent_config.get("flag_posts", True) and broken:
            await _flag_posts(site, broken)

        # 7. Email report (if configured)
        report_mode = agent_config.get("report", "In-app report")
        if report_mode in ("Email report", "Both"):
            email = agent_config.get("report_email", "")
            if email:
                sent = _send_email_report(site, broken, len(unique_urls), email)
                if sent:
                    async with httpx.AsyncClient(timeout=10) as client:
                        await client.patch(
                            f"{_sb_url('wp_link_scans')}?id=eq.{scan_id}",
                            headers=_sb_headers(),
                            json={"report_sent": True},
                        )

        # 8. Update agent status
        await _update_agent_status(agent_id, "idle")

        return {
            "scan_id": scan_id,
            "total_links": len(unique_urls),
            "broken_links": broken_count,
            "warning_links": warning_count,
        }

    except Exception as e:
        log.error("Scan failed for agent %s: %s", agent_id, e, exc_info=True)
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_link_scans')}?id=eq.{scan_id}",
                headers=_sb_headers(),
                json={
                    "status": "failed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        await _update_agent_status(agent_id, "failed")
        return {}


async def _update_agent_status(agent_id: str, status: str):
    """Update agent status and last_run_at."""
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{_sb_url('wp_agents')}?id=eq.{agent_id}",
            headers=_sb_headers(),
            json={"status": status, "last_run_at": "now()"},
        )


# ── 1. Fetch WP content ──────────────────────────────────────

async def _fetch_content(site: dict, scope: str) -> list:
    """Fetch posts and/or pages from WP REST API."""
    headers = {"Authorization": _wp_auth(site)}
    items = []

    # Determine what to fetch
    fetch_posts = scope in ("All posts & pages", "Posts only", "Recently published (30 days)")
    fetch_pages = scope in ("All posts & pages", "Pages only")

    async with httpx.AsyncClient(timeout=30) as client:
        if fetch_posts:
            items.extend(await _paginate_wp(client, site, headers, "posts", scope))
        if fetch_pages:
            items.extend(await _paginate_wp(client, site, headers, "pages", scope))

    return items


async def _paginate_wp(client: httpx.AsyncClient, site: dict, headers: dict,
                       post_type: str, scope: str) -> list:
    """Paginate through WP REST API results."""
    items = []
    page = 1
    per_page = 100

    # Build base params
    params = f"per_page={per_page}&status=publish&_fields=id,title,link,content,type"

    # Date filter for "Recently published"
    if scope == "Recently published (30 days)":
        from datetime import timedelta
        after = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        params += f"&after={after}"

    while True:
        url = _wp_api(site, f"/wp/v2/{post_type}?{params}&page={page}")
        try:
            resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                break
            batch = resp.json()
            if not batch:
                break
            items.extend(batch)
            # Check if there are more pages
            total_pages = int(resp.headers.get("X-WP-TotalPages", "1"))
            if page >= total_pages:
                break
            page += 1
        except Exception as e:
            log.warning("WP API pagination error (page %d, %s): %s", page, post_type, e)
            break

    return items


# ── 2. Extract links ─────────────────────────────────────────

def _extract_links(posts: list, site_url: str) -> list:
    """Extract all <a href> URLs from post/page content."""
    links = []

    for post in posts:
        content = post.get("content", {})
        html = content.get("rendered", "") if isinstance(content, dict) else str(content)
        if not html:
            continue

        title = post.get("title", {})
        post_title = title.get("rendered", "") if isinstance(title, dict) else str(title)
        post_id = post.get("id")
        post_url = post.get("link", "")
        post_type = post.get("type", "post")

        soup = BeautifulSoup(html, "html.parser")
        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"].strip()

            # Skip anchors, mailto, tel, javascript
            if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
                continue

            # Convert relative URLs to absolute
            if not href.startswith(("http://", "https://")):
                href = urljoin(site_url.rstrip("/") + "/", href)

            links.append({
                "url": href,
                "post_id": post_id,
                "post_title": post_title,
                "post_url": post_url,
                "post_type": post_type,
            })

    return links


# ── Severity classification ───────────────────────────────────

# "broken" = confirmed dead, user should act.  "warning" = possibly fine, likely scanner artifact.
_BROKEN_CODES = {404, 410}  # Definitely gone
_WARNING_CODES = {401, 403, 429, 503}  # Auth walls, bot-blocking, rate-limits, maintenance
_WARNING_ERROR_TYPES = {"timeout", "ssl_error"}  # Transient / not truly broken


def _classify_severity(status_code: int, error_type: str) -> str:
    """Return 'broken' or 'warning' for a failed link check."""
    if status_code in _BROKEN_CODES:
        return "broken"
    if status_code in _WARNING_CODES or error_type in _WARNING_ERROR_TYPES:
        return "warning"
    if 500 <= status_code < 600:
        return "warning"  # 5xx = server-side, often transient
    if error_type == "connection_error":
        return "broken"  # DNS fail / connection refused is real
    if error_type == "redirect_chain":
        return "warning"
    return "broken"


# ── 3. Check links ───────────────────────────────────────────

async def _check_links_with_progress(urls: list, all_links: list,
                                      scan_id: str, site_url: str = "") -> dict:
    """Check URLs concurrently with periodic progress flushes to the DB.

    Internal links (same domain as site_url) are rate-limited more aggressively
    to avoid overwhelming the hosting provider (the 508 problem).
    """
    site_domain = urlparse(site_url).netloc.replace("www.", "") if site_url else ""

    # Separate internal vs external URLs
    internal_urls = []
    external_urls = []
    for url in urls:
        domain = urlparse(url).netloc.replace("www.", "")
        if site_domain and domain == site_domain:
            internal_urls.append(url)
        else:
            external_urls.append(url)

    log.info("Checking %d internal + %d external URLs (site domain: %s)",
             len(internal_urls), len(external_urls), site_domain)

    results = {}
    checked_count = 0
    flush_lock = asyncio.Lock()
    total = len(urls)

    # External: normal concurrency.  Internal: max 2 concurrent to avoid 508s.
    ext_semaphore = asyncio.Semaphore(config.AGENT_LINK_CHECK_CONCURRENCY)
    int_semaphore = asyncio.Semaphore(2)

    async def check_one(url: str, sem: asyncio.Semaphore):
        nonlocal checked_count
        async with sem:
            results[url] = await _check_single_url(url)
            async with flush_lock:
                checked_count += 1
                if checked_count % 25 == 0:
                    await _flush_progress(scan_id, results, all_links, checked_count, total)

    tasks = []
    for url in external_urls:
        tasks.append(asyncio.create_task(check_one(url, ext_semaphore)))
    for url in internal_urls:
        tasks.append(asyncio.create_task(check_one(url, int_semaphore)))

    await asyncio.gather(*tasks, return_exceptions=True)

    # Final progress flush
    await _flush_progress(scan_id, results, all_links, total, total)
    return results


async def _flush_progress(scan_id: str, check_results: dict, all_links: list,
                          checked: int, total: int):
    """Flush current scan progress to the database."""
    broken = _build_broken_results(all_links, check_results)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_link_scans')}?id=eq.{scan_id}",
                headers=_sb_headers(),
                json={
                    "checked_links": checked,
                    "total_links": total,
                    "broken_links": len(broken),
                    "results": broken,
                },
            )
    except Exception as e:
        log.warning("Progress flush failed: %s", e)


async def _check_single_url(url: str) -> dict:
    """Check a single URL. Returns {status_code, error_type, severity, ok}.

    Uses browser-like headers to avoid bot-blocking false positives.
    Falls back from HEAD to GET on any error code (not just 405).
    Classifies results as 'broken' (real) vs 'warning' (likely false positive).
    """
    timeout = config.AGENT_LINK_CHECK_TIMEOUT

    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            max_redirects=5,
            verify=True,
            headers=_BROWSER_HEADERS,
        ) as client:
            try:
                # Try HEAD first (faster)
                resp = await client.head(url)
                # Fall back to GET if HEAD returns any error
                if resp.status_code >= 400:
                    resp = await client.get(url)
            except httpx.TooManyRedirects:
                return {"status_code": 0, "error_type": "redirect_chain",
                        "severity": "warning", "ok": False}

            code = resp.status_code

            if code < 400:
                return {"status_code": code, "error_type": None,
                        "severity": None, "ok": True}

            # Determine error type
            if code == 404:
                error_type = "broken_404"
            elif code == 410:
                error_type = "broken_410"
            elif code == 401:
                error_type = "auth_required"
            elif code == 403:
                error_type = "forbidden"
            elif code == 429:
                error_type = "rate_limited"
            elif 500 <= code < 600:
                error_type = f"server_error_{code}"
            else:
                error_type = f"http_{code}"

            severity = _classify_severity(code, error_type)
            return {"status_code": code, "error_type": error_type,
                    "severity": severity, "ok": False}

    except httpx.TimeoutException:
        return {"status_code": 0, "error_type": "timeout",
                "severity": "warning", "ok": False}
    except Exception as e:
        err_str = str(e).lower()
        if "ssl" in err_str or "certificate" in err_str:
            return {"status_code": 0, "error_type": "ssl_error",
                    "severity": "warning", "ok": False}
        return {"status_code": 0, "error_type": "connection_error",
                "severity": "broken", "ok": False}


# ── AI Fix — re-verify and repair broken links ──────────────

_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}


async def ai_fix_link(url: str) -> dict:
    """Re-verify a broken URL with browser-like headers, try variations.

    Returns {status, new_url, action, message}:
      status:  "valid" | "repaired" | "missing"
      new_url: the working URL (or None)
      action:  "none" | "replace" | "unlink"
      message: human-readable explanation
    """
    # Step 1 — Re-check with a real browser User-Agent
    try:
        async with httpx.AsyncClient(
            timeout=15, follow_redirects=True, max_redirects=5, verify=False,
            headers=_BROWSER_HEADERS,
        ) as client:
            resp = await client.get(url)
            final_url = str(resp.url)

            if resp.status_code < 400:
                if final_url != url:
                    return {
                        "status": "repaired",
                        "new_url": final_url,
                        "action": "replace",
                        "message": f"Redirected to working URL",
                    }
                return {
                    "status": "valid",
                    "new_url": url,
                    "action": "none",
                    "message": "False positive — link is valid",
                }
    except httpx.TooManyRedirects:
        pass
    except httpx.TimeoutException:
        pass
    except Exception:
        pass

    # Step 2 — Try URL variations
    parsed = urlparse(url)
    variations = []

    # http ↔ https
    if parsed.scheme == "http":
        variations.append(url.replace("http://", "https://", 1))
    elif parsed.scheme == "https":
        variations.append(url.replace("https://", "http://", 1))

    # www ↔ non-www
    if parsed.hostname and parsed.hostname.startswith("www."):
        variations.append(url.replace("://www.", "://", 1))
    elif parsed.hostname:
        variations.append(url.replace("://", "://www.", 1))

    # trailing slash toggle
    if url.endswith("/"):
        variations.append(url.rstrip("/"))
    else:
        variations.append(url + "/")

    for var_url in variations:
        try:
            async with httpx.AsyncClient(
                timeout=10, follow_redirects=True, max_redirects=5, verify=False,
                headers=_BROWSER_HEADERS,
            ) as client:
                resp = await client.get(var_url)
                if resp.status_code < 400:
                    return {
                        "status": "repaired",
                        "new_url": str(resp.url),
                        "action": "replace",
                        "message": f"Found working variation",
                    }
        except Exception:
            continue

    # Step 3 — Nothing worked
    return {
        "status": "missing",
        "new_url": None,
        "action": "unlink",
        "message": "No working URL found",
    }


# ── 4. Build broken results ──────────────────────────────────

def _build_broken_results(all_links: list, check_results: dict) -> list:
    """Build the broken link result objects with severity classification."""
    broken = []
    seen = set()

    for link in all_links:
        url = link["url"]
        result = check_results.get(url)
        if not result or result.get("ok"):
            continue

        # Deduplicate by (url, post_id)
        key = (url, link["post_id"])
        if key in seen:
            continue
        seen.add(key)

        error_type = result.get("error_type", "unknown")
        status_code = result.get("status_code", 0)
        severity = result.get("severity") or _classify_severity(status_code, error_type)

        broken.append({
            "url": url,
            "status_code": status_code,
            "error_type": error_type,
            "severity": severity,
            "post_id": link["post_id"],
            "post_title": link["post_title"],
            "post_url": link["post_url"],
            "post_type": link["post_type"],
        })

    # Sort: broken first, then warnings
    broken.sort(key=lambda x: (0 if x["severity"] == "broken" else 1, x["error_type"]))
    return broken


# ── 5. Flag posts in WordPress ───────────────────────────────

async def _flag_posts(site: dict, broken: list):
    """Add _opai_broken_links meta to affected posts."""
    headers = {
        "Authorization": _wp_auth(site),
        "Content-Type": "application/json",
    }

    # Group broken links by post_id
    by_post: dict[int, list] = {}
    for b in broken:
        pid = b["post_id"]
        if pid not in by_post:
            by_post[pid] = []
        by_post[pid].append({
            "url": b["url"],
            "status_code": b["status_code"],
            "checked_at": datetime.now(timezone.utc).isoformat(),
        })

    async with httpx.AsyncClient(timeout=15) as client:
        for post_id, links in by_post.items():
            # Determine endpoint based on post type from the broken link data
            post_type = "posts"
            for b in broken:
                if b["post_id"] == post_id and b.get("post_type") == "page":
                    post_type = "pages"
                    break

            url = _wp_api(site, f"/wp/v2/{post_type}/{post_id}")
            try:
                await client.post(url, headers=headers, json={
                    "meta": {"_opai_broken_links": links}
                })
            except Exception as e:
                log.warning("Failed to flag post %s: %s", post_id, e)


# ── 6. Email report ──────────────────────────────────────────

def _load_dotenv(path: Path) -> dict:
    """Load key=value pairs from a .env file."""
    env = {}
    if not path.is_file():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def _send_email_report(site: dict, broken: list, total_links: int, recipient: str) -> bool:
    """Send HTML email report of broken links."""
    vault_env_path = Path(f"/run/user/{os.getuid()}/opai-vault/opai-email-agent.env")
    dotenv_path = config.BASE_DIR / "tools" / "opai-email-agent" / ".env"
    smtp_creds = _load_dotenv(vault_env_path) or _load_dotenv(dotenv_path)

    smtp_host = smtp_creds.get("AGENT_SMTP_HOST") or os.environ.get("AGENT_SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(smtp_creds.get("AGENT_SMTP_PORT") or os.environ.get("AGENT_SMTP_PORT", "465"))
    smtp_user = smtp_creds.get("AGENT_SMTP_USER") or os.environ.get("AGENT_SMTP_USER", "")
    smtp_pass = smtp_creds.get("AGENT_SMTP_PASS") or os.environ.get("AGENT_SMTP_PASS", "")

    if not smtp_user or not smtp_pass:
        log.warning("SMTP credentials not configured — skipping email report")
        return False

    site_name = site.get("name", site.get("url", "Unknown"))

    # Group by error type for summary
    by_type: dict[str, int] = {}
    for b in broken:
        t = b.get("error_type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1

    summary_rows = "".join(
        f"<tr><td style='padding:4px 12px;border:1px solid #ddd'>{t}</td>"
        f"<td style='padding:4px 12px;border:1px solid #ddd;text-align:center'>{c}</td></tr>"
        for t, c in sorted(by_type.items(), key=lambda x: -x[1])
    )

    detail_rows = ""
    for b in broken[:100]:  # Cap at 100 in email
        detail_rows += (
            f"<tr>"
            f"<td style='padding:4px 8px;border:1px solid #ddd;word-break:break-all'>"
            f"<a href='{b['url']}'>{b['url'][:80]}</a></td>"
            f"<td style='padding:4px 8px;border:1px solid #ddd;text-align:center'>{b['status_code'] or '—'}</td>"
            f"<td style='padding:4px 8px;border:1px solid #ddd'>{b['error_type']}</td>"
            f"<td style='padding:4px 8px;border:1px solid #ddd'>"
            f"<a href='{b['post_url']}'>{b['post_title'][:50]}</a></td>"
            f"</tr>"
        )

    html = f"""
    <html><body style="font-family:sans-serif;color:#333;max-width:800px;margin:0 auto">
    <h2>Broken Link Report — {site_name}</h2>
    <p>Scanned <strong>{total_links}</strong> links, found <strong>{len(broken)}</strong> broken.</p>

    <h3>Summary</h3>
    <table style="border-collapse:collapse;margin-bottom:20px">
    <tr style="background:#f5f5f5"><th style="padding:6px 12px;border:1px solid #ddd">Error Type</th>
    <th style="padding:6px 12px;border:1px solid #ddd">Count</th></tr>
    {summary_rows}
    </table>

    <h3>Details{' (first 100)' if len(broken) > 100 else ''}</h3>
    <table style="border-collapse:collapse;width:100%">
    <tr style="background:#f5f5f5">
    <th style="padding:6px 8px;border:1px solid #ddd">URL</th>
    <th style="padding:6px 8px;border:1px solid #ddd">Status</th>
    <th style="padding:6px 8px;border:1px solid #ddd">Error</th>
    <th style="padding:6px 8px;border:1px solid #ddd">Found In</th></tr>
    {detail_rows}
    </table>

    <p style="margin-top:20px;font-size:12px;color:#999">
    Generated by OP WordPress — Broken Link Scanner
    </p>
    </body></html>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Broken Link Report — {site_name} ({len(broken)} issues)"
    msg["From"] = smtp_user
    msg["To"] = recipient
    msg.attach(MIMEText(html, "html"))

    try:
        if smtp_port == 465:
            with smtplib.SMTP_SSL(smtp_host, smtp_port) as server:
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)
        else:
            with smtplib.SMTP(smtp_host, smtp_port) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)
        log.info("Email report sent to %s for %s", recipient, site_name)
        return True
    except Exception as e:
        log.error("Failed to send email report: %s", e)
        return False
