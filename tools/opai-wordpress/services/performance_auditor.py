"""Performance Auditor — diagnoses slow WordPress sites via PSI + server-side metrics."""

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
from xml.etree import ElementTree

import httpx

import config

log = logging.getLogger("opai-wordpress.perf-auditor")

PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"

# Browser-like headers for direct HTML fetches
_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

# Known page builder CSS class patterns
_PAGE_BUILDERS = {
    "elementor": re.compile(r"elementor-(?:section|widget|element)", re.I),
    "divi": re.compile(r"et_pb_(?:section|row|module)", re.I),
    "avada": re.compile(r"fusion-(?:builder|layout|column)", re.I),
    "wpbakery": re.compile(r"vc_(?:row|column|section)", re.I),
    "beaver-builder": re.compile(r"fl-(?:row|col|module)", re.I),
    "oxygen": re.compile(r"ct-(?:section|div|text)", re.I),
}

# Known heavy plugins (informational)
_HEAVY_PLUGINS = {
    "elementor/elementor.php", "elementor-pro/elementor-pro.php",
    "js_composer/js_composer.php", "revslider/revslider.php",
    "wordfence/wordfence.php", "jetpack/jetpack.php",
    "woocommerce/woocommerce.php", "wpml-sitepress-multilingual-cms/sitepress.php",
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


def _wp_auth(site: dict) -> str:
    cred = base64.b64encode(
        f"{site['username']}:{site['app_password']}".encode()
    ).decode()
    return f"Basic {cred}"


def _wp_api(site: dict, path: str) -> str:
    base_url = site["url"].rstrip("/")
    api_base = site.get("api_base", "/wp-json")
    return f"{base_url}{api_base}{path}"


# ── Main entry point ─────────────────────────────────────────

async def run_audit(site: dict, agent: dict, user_id: str) -> dict:
    """Run a full performance audit. Called from routes or scheduler."""
    agent_id = agent["id"]
    site_id = site["id"]
    agent_config = agent.get("config") or {}
    scope = agent_config.get("scope", "Thorough (up to 20 pages)")
    strategy = agent_config.get("strategy", "Mobile").lower()
    if strategy == "both":
        strategy = "mobile"  # primary; desktop run is secondary

    # Phase 1: Create audit record
    audit_row = {
        "site_id": site_id,
        "agent_id": agent_id,
        "user_id": user_id,
        "status": "running",
        "scope": scope,
        "report_email": agent_config.get("report_email", ""),
    }

    audit_id = None
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _sb_url("wp_performance_audits"), headers=_sb_headers(), json=audit_row
        )
        if resp.status_code in (200, 201) and resp.json():
            audit_id = resp.json()[0]["id"]

    if not audit_id:
        log.error("Failed to create audit record for agent %s", agent_id)
        await _update_agent_status(agent_id, "failed")
        return {}

    try:
        # Phase 2: Discover pages
        pages = await _discover_pages(site, scope)
        log.info("Discovered %d pages for audit on %s", len(pages), site.get("name"))

        # Update audit with page count
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_performance_audits')}?id=eq.{audit_id}",
                headers=_sb_headers(),
                json={"pages_audited": len(pages)},
            )

        # Phase 3: Audit each page (PSI + HTML analysis)
        page_results = await _audit_pages(pages, strategy, audit_id)

        # Phase 4: Server-side diagnostics via connector
        server_metrics = await _fetch_server_metrics(site)

        # Phase 5: Build findings + report
        site_base = site["url"].rstrip("/")
        builders = [p["page_builder"] for p in page_results if p.get("page_builder")]
        detected_builder = max(set(builders), key=builders.count) if builders else None
        findings = _build_findings(page_results, server_metrics, site_base, detected_builder)

        # Compute site-wide averages
        scores = [p["score"] for p in page_results if p.get("score") is not None]
        avg_score = round(sum(scores) / len(scores)) if scores else None

        def _avg(key):
            vals = [p[key] for p in page_results if p.get(key) is not None]
            return round(sum(vals) / len(vals), 2) if vals else None

        # Detect whether PSI returned any real CWV data
        psi_available = any(p.get("score") is not None for p in page_results)

        if not psi_available:
            findings.insert(0, _finding(
                "no-psi-data", "informational", "low",
                "Core Web Vitals data unavailable",
                "PageSpeed Insights API did not return CWV metrics for this audit. "
                "This typically means the API quota was exhausted or the API key is missing. "
                "Server-side and HTML-based findings are still accurate.",
                "low", "informational",
                "Add a Google PSI API key (free, 25k queries/day) to get full CWV scoring",
            ))

        critical_count = sum(1 for f in findings if f["severity"] == "critical")
        issues_count = len(findings)

        results_payload = {
            "pages": page_results,
            "server_metrics": server_metrics,
            "findings": findings,
            "psi_available": psi_available,
        }

        # Phase 5b: Final update
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_performance_audits')}?id=eq.{audit_id}",
                headers=_sb_headers(),
                json={
                    "status": "completed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "overall_score": avg_score,
                    "pages_audited": len(pages),
                    "pages_checked": len(page_results),
                    "issues_found": issues_count,
                    "critical_issues": critical_count,
                    "avg_lcp": _avg("lcp_ms"),
                    "avg_fcp": _avg("fcp_ms"),
                    "avg_cls": _avg("cls"),
                    "avg_ttfb": _avg("ttfb_ms"),
                    "avg_tbt": _avg("tbt_ms"),
                    "results": results_payload,
                },
            )

        # Phase 6: Optional email report
        report_mode = agent_config.get("report", "In-app report")
        if report_mode in ("Email report", "Both"):
            email = agent_config.get("report_email", "")
            if email:
                sent = _send_email_report(site, avg_score, page_results, findings, email)
                if sent:
                    async with httpx.AsyncClient(timeout=10) as client:
                        await client.patch(
                            f"{_sb_url('wp_performance_audits')}?id=eq.{audit_id}",
                            headers=_sb_headers(),
                            json={"report_sent": True},
                        )

        await _update_agent_status(agent_id, "idle")
        log.info(
            "Audit complete for %s: score=%s, pages=%d, issues=%d",
            site.get("name"), avg_score, len(page_results), issues_count,
        )

        return {
            "audit_id": audit_id,
            "overall_score": avg_score,
            "pages_audited": len(page_results),
            "issues_found": issues_count,
        }

    except Exception as e:
        log.error("Audit failed for agent %s: %s", agent_id, e, exc_info=True)
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_performance_audits')}?id=eq.{audit_id}",
                headers=_sb_headers(),
                json={
                    "status": "failed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        await _update_agent_status(agent_id, "failed")
        return {}


async def _update_agent_status(agent_id: str, status: str):
    async with httpx.AsyncClient(timeout=10) as client:
        await client.patch(
            f"{_sb_url('wp_agents')}?id=eq.{agent_id}",
            headers=_sb_headers(),
            json={"status": status, "last_run_at": "now()"},
        )


# ── Phase 2: Discover pages ──────────────────────────────────────

async def _discover_pages(site: dict, scope: str) -> list[dict]:
    """Discover pages to audit. Returns list of {url, label}."""
    base_url = site["url"].rstrip("/")
    max_pages = config.PERF_AUDIT_MAX_PAGES

    if "Homepage only" in scope:
        return [{"url": base_url + "/", "label": "Homepage"}]

    if "Complete" in scope:
        max_pages = 9999  # effectively unlimited

    pages = [{"url": base_url + "/", "label": "Homepage"}]

    # Try sitemaps first
    sitemap_urls = await _fetch_sitemap_urls(base_url)

    if sitemap_urls:
        for url in sitemap_urls:
            if len(pages) >= max_pages:
                break
            if url not in {p["url"] for p in pages}:
                # Derive label from URL path
                path = urlparse(url).path.strip("/")
                label = path.split("/")[-1].replace("-", " ").title() if path else "Page"
                pages.append({"url": url, "label": label})
    else:
        # Fallback: WP REST API
        wp_pages = await _fetch_wp_content_urls(site)
        for item in wp_pages:
            if len(pages) >= max_pages:
                break
            url = item.get("link", "")
            if url and url not in {p["url"] for p in pages}:
                title = item.get("title", {})
                label = (title.get("rendered", "") if isinstance(title, dict) else str(title)) or "Page"
                pages.append({"url": url, "label": label})

    # For "Essential" scope, limit to 6
    if "Essential" in scope:
        pages = pages[:6]

    return pages[:max_pages]


async def _fetch_sitemap_urls(base_url: str) -> list[str]:
    """Try common sitemap locations and extract page URLs."""
    sitemap_paths = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"]
    urls = []

    async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=_BROWSER_HEADERS) as client:
        for path in sitemap_paths:
            try:
                resp = await client.get(base_url + path)
                if resp.status_code != 200:
                    continue
                urls = _parse_sitemap_xml(resp.text, base_url)
                if urls:
                    break
            except Exception:
                continue

    return urls


def _parse_sitemap_xml(xml_text: str, base_url: str) -> list[str]:
    """Parse sitemap XML and extract URLs. Handles sitemap indexes."""
    urls = []
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError:
        return urls

    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

    # Check for sitemap index
    sitemap_locs = root.findall(".//sm:sitemap/sm:loc", ns)
    if sitemap_locs:
        # Return empty — we only parse direct sitemaps for simplicity
        # The caller can try wp-sitemap-posts-post-1.xml etc.
        pass

    # Direct URL entries
    for loc in root.findall(".//sm:url/sm:loc", ns):
        if loc.text:
            urls.append(loc.text.strip())

    return urls


async def _fetch_wp_content_urls(site: dict) -> list:
    """Fetch recent posts and pages via WP REST API."""
    headers = {"Authorization": _wp_auth(site)}
    items = []

    async with httpx.AsyncClient(timeout=20) as client:
        for post_type in ("posts", "pages"):
            try:
                resp = await client.get(
                    _wp_api(site, f"/wp/v2/{post_type}?per_page=15&status=publish&_fields=id,title,link"),
                    headers=headers,
                )
                if resp.status_code == 200:
                    items.extend(resp.json())
            except Exception as e:
                log.warning("Failed to fetch %s from WP API: %s", post_type, e)

    return items


# ── Phase 3: Audit pages ─────────────────────────────────────────

async def _audit_pages(pages: list[dict], strategy: str, audit_id: str) -> list[dict]:
    """Audit each page via PSI + direct HTML analysis. Concurrent with semaphore."""
    semaphore = asyncio.Semaphore(config.PERF_AUDIT_CONCURRENCY)
    results = []
    checked = 0
    lock = asyncio.Lock()

    async def audit_one(page: dict):
        nonlocal checked
        async with semaphore:
            result = await _audit_single_page(page["url"], page["label"], strategy)
            async with lock:
                results.append(result)
                checked += 1
                # Flush progress every 3 pages
                if checked % 3 == 0 or checked == len(pages):
                    await _flush_progress(audit_id, checked, len(pages))

    tasks = [asyncio.create_task(audit_one(p)) for p in pages]
    await asyncio.gather(*tasks, return_exceptions=True)

    return results


async def _audit_single_page(url: str, label: str, strategy: str) -> dict:
    """Audit a single page: PSI call + HTML analysis."""
    result = {
        "url": url,
        "label": label,
        "score": None,
        "lcp_ms": None,
        "fcp_ms": None,
        "cls": None,
        "tbt_ms": None,
        "ttfb_ms": None,
        "speed_index_ms": None,
        "dom_elements": None,
        "page_builder": None,
        "total_images": 0,
        "unoptimized_images": 0,
        "render_blocking": 0,
        "third_party_scripts": 0,
        "iframes": 0,
        "page_weight_kb": None,
        "cache_status": None,
        "opportunities": [],
    }

    # Run PSI and HTML analysis concurrently
    psi_task = asyncio.create_task(_call_pagespeed(url, strategy))
    html_task = asyncio.create_task(_fetch_and_analyze_html(url))

    psi_data, html_data = await asyncio.gather(psi_task, html_task, return_exceptions=True)

    # Merge PSI results
    if isinstance(psi_data, dict) and not psi_data.get("error"):
        result["score"] = psi_data.get("score")
        result["lcp_ms"] = psi_data.get("lcp")
        result["fcp_ms"] = psi_data.get("fcp")
        result["cls"] = psi_data.get("cls")
        result["tbt_ms"] = psi_data.get("tbt")
        result["ttfb_ms"] = psi_data.get("ttfb")
        result["speed_index_ms"] = psi_data.get("speed_index")
        result["opportunities"] = psi_data.get("opportunities", [])
        if psi_data.get("dom_size"):
            result["dom_elements"] = psi_data["dom_size"]

    # Merge HTML analysis
    if isinstance(html_data, dict):
        result["page_builder"] = html_data.get("page_builder")
        result["total_images"] = html_data.get("total_images", 0)
        result["unoptimized_images"] = html_data.get("unoptimized_images", 0)
        result["render_blocking"] = html_data.get("render_blocking", 0)
        result["third_party_scripts"] = html_data.get("third_party_scripts", 0)
        result["iframes"] = html_data.get("iframes", 0)
        result["cache_status"] = html_data.get("cache_status")
        result["page_weight_kb"] = html_data.get("page_weight_kb")
        if html_data.get("dom_elements") and not result["dom_elements"]:
            result["dom_elements"] = html_data["dom_elements"]

    return result


async def _call_pagespeed(url: str, strategy: str = "mobile") -> dict:
    """Call PageSpeed Insights API and return parsed metrics."""
    params = {
        "url": url,
        "strategy": strategy,
        "category": "performance",
    }
    if config.PAGESPEED_API_KEY:
        params["key"] = config.PAGESPEED_API_KEY

    try:
        async with httpx.AsyncClient(timeout=config.PERF_AUDIT_TIMEOUT) as client:
            resp = await client.get(PSI_URL, params=params)
            if resp.status_code == 429:
                log.warning("PSI quota exhausted (429) for %s — skipping CWV", url)
                return {"error": "quota_exhausted"}
            if resp.status_code != 200:
                log.warning("PSI API error for %s: %s", url, resp.status_code)
                return {"error": f"HTTP {resp.status_code}"}

            data = resp.json()
            lhr = data.get("lighthouseResult", {})
            audits = lhr.get("audits", {})

            return {
                "score": round(
                    (lhr.get("categories", {}).get("performance", {}).get("score", 0)) * 100
                ),
                "lcp": audits.get("largest-contentful-paint", {}).get("numericValue"),
                "fcp": audits.get("first-contentful-paint", {}).get("numericValue"),
                "cls": audits.get("cumulative-layout-shift", {}).get("numericValue"),
                "tbt": audits.get("total-blocking-time", {}).get("numericValue"),
                "ttfb": audits.get("server-response-time", {}).get("numericValue"),
                "speed_index": audits.get("speed-index", {}).get("numericValue"),
                "dom_size": audits.get("dom-size", {}).get("numericValue"),
                "opportunities": _extract_opportunities(audits),
                "diagnostics": _extract_diagnostics(audits),
                "field_data": _extract_field_data(data.get("loadingExperience", {})),
            }
    except httpx.TimeoutException:
        log.warning("PSI timeout for %s", url)
        return {"error": "timeout"}
    except Exception as e:
        log.warning("PSI error for %s: %s", url, e)
        return {"error": str(e)}


def _extract_opportunities(audits: dict) -> list:
    """Extract optimization opportunities from Lighthouse audits."""
    opportunity_ids = [
        "unused-css-rules", "unused-javascript", "offscreen-images",
        "render-blocking-resources", "unminified-css", "unminified-javascript",
        "modern-image-formats", "uses-optimized-images", "uses-text-compression",
        "uses-responsive-images", "efficient-animated-content",
    ]
    results = []
    for oid in opportunity_ids:
        audit = audits.get(oid, {})
        if audit.get("score") is not None and audit["score"] < 1:
            details = audit.get("details", {})
            savings_ms = details.get("overallSavingsMs", 0)
            savings_bytes = details.get("overallSavingsBytes", 0)
            if savings_ms > 0 or savings_bytes > 0:
                results.append({
                    "id": oid,
                    "savings_ms": round(savings_ms),
                    "savings_bytes": round(savings_bytes),
                })
    return results


def _extract_diagnostics(audits: dict) -> list:
    """Extract diagnostic info from Lighthouse audits."""
    diag_ids = [
        "dom-size", "mainthread-work-breakdown", "bootup-time",
        "critical-request-chains", "font-display", "third-party-summary",
    ]
    results = []
    for did in diag_ids:
        audit = audits.get(did, {})
        if audit.get("score") is not None and audit["score"] < 1:
            results.append({
                "id": did,
                "value": audit.get("numericValue") or audit.get("displayValue", ""),
            })
    return results


def _extract_field_data(loading_exp: dict) -> dict | None:
    """Extract CrUX field data if available."""
    if not loading_exp or not loading_exp.get("metrics"):
        return None
    metrics = loading_exp["metrics"]
    return {
        "lcp_category": metrics.get("LARGEST_CONTENTFUL_PAINT_MS", {}).get("category"),
        "fid_category": metrics.get("FIRST_INPUT_DELAY_MS", {}).get("category"),
        "cls_category": metrics.get("CUMULATIVE_LAYOUT_SHIFT_SCORE", {}).get("category"),
        "overall_category": loading_exp.get("overall_category"),
    }


async def _fetch_and_analyze_html(url: str) -> dict:
    """Fetch page HTML directly and analyze for images, scripts, builders, etc."""
    result = {
        "page_builder": None,
        "total_images": 0,
        "unoptimized_images": 0,
        "render_blocking": 0,
        "third_party_scripts": 0,
        "iframes": 0,
        "dom_elements": None,
        "cache_status": None,
        "page_weight_kb": None,
    }

    try:
        async with httpx.AsyncClient(
            timeout=20, follow_redirects=True, headers=_BROWSER_HEADERS
        ) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                return result

            html = resp.text
            headers = resp.headers

            # Cache status from response headers
            cache_header = headers.get("x-cache", headers.get("cf-cache-status", ""))
            result["cache_status"] = cache_header or None

            # Page weight
            content_length = headers.get("content-length")
            if content_length:
                result["page_weight_kb"] = round(int(content_length) / 1024)
            else:
                result["page_weight_kb"] = round(len(html.encode("utf-8")) / 1024)

            result.update(_analyze_html(html, url))

    except Exception as e:
        log.warning("HTML fetch failed for %s: %s", url, e)

    return result


def _analyze_html(html: str, page_url: str) -> dict:
    """Parse HTML and extract performance-relevant metrics."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    page_domain = urlparse(page_url).netloc.replace("www.", "")

    result = {
        "dom_elements": len(soup.find_all()),
        "page_builder": None,
        "total_images": 0,
        "unoptimized_images": 0,
        "render_blocking": 0,
        "third_party_scripts": 0,
        "iframes": 0,
    }

    # Detect page builder
    body_classes = ""
    body = soup.find("body")
    if body:
        body_classes = " ".join(body.get("class", []))

    full_check = body_classes + " " + html[:50000]
    for builder, pattern in _PAGE_BUILDERS.items():
        if pattern.search(full_check):
            result["page_builder"] = builder
            break

    # Images
    images = soup.find_all("img")
    result["total_images"] = len(images)
    unoptimized = 0
    for img in images:
        src = img.get("src", "") or img.get("data-src", "")
        # Check for non-WebP/AVIF
        if src and not any(src.lower().endswith(ext) for ext in (".webp", ".avif", ".svg")):
            unoptimized += 1
    result["unoptimized_images"] = unoptimized

    # Render-blocking resources in <head>
    head = soup.find("head")
    if head:
        # CSS without media=print or async
        for link in head.find_all("link", rel="stylesheet"):
            media = link.get("media", "")
            if media not in ("print",):
                result["render_blocking"] += 1

        # JS without async/defer
        for script in head.find_all("script", src=True):
            if not script.get("async") and not script.get("defer"):
                result["render_blocking"] += 1

    # Third-party scripts
    for script in soup.find_all("script", src=True):
        src = script.get("src", "")
        if src:
            script_domain = urlparse(src).netloc.replace("www.", "")
            if script_domain and script_domain != page_domain:
                result["third_party_scripts"] += 1

    # Iframes
    result["iframes"] = len(soup.find_all("iframe"))

    return result


# ── Phase 4: Server metrics ──────────────────────────────────────

async def _fetch_server_metrics(site: dict) -> dict:
    """Call the connector's /performance/audit endpoint."""
    base_url = site["url"].rstrip("/")
    connector_key = site.get("connector_key", "")

    if not connector_key:
        log.warning("No connector key for site %s, skipping server metrics", site.get("name"))
        return {}

    headers = {"X-OPAI-Key": connector_key}

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(
                f"{base_url}/wp-json/opai/v1/performance/audit",
                headers=headers,
            )
            if resp.status_code == 200:
                return resp.json()
            else:
                log.warning("Connector perf endpoint returned %s for %s", resp.status_code, site.get("name"))
                return {}
    except Exception as e:
        log.warning("Failed to fetch server metrics from %s: %s", site.get("name"), e)
        return {}


# ── Phase 5: Build findings ──────────────────────────────────────

def _build_findings(page_results: list[dict], server_metrics: dict,
                    site_base: str = "", page_builder: str | None = None) -> list[dict]:
    """Generate prioritized findings from page results and server metrics."""
    findings = []
    admin = f"{site_base}/wp-admin" if site_base else ""

    # Avada deep-links use field IDs: #lazy_load scrolls to the specific option
    # Section-level tab: #tab-heading_performance opens the Performance section
    _avada_opts = f"{admin}/themes.php?page=avada_options" if admin else ""

    def _avada(field_id):
        """Deep link to a specific Avada option field (scrolls to it)."""
        return f"{_avada_opts}#{field_id}" if _avada_opts else ""

    def _avada_section(section_css_id):
        """Deep link to an Avada options section tab."""
        return f"{_avada_opts}#tab-{section_css_id}" if _avada_opts else ""

    # Builder-aware helpers
    def _perf_url():
        if page_builder == "avada":
            return _avada_section("heading_performance")
        if page_builder == "elementor":
            return f"{admin}/admin.php?page=elementor#tab-performance"
        return ""

    def _lazy_url():
        if page_builder == "avada":
            return _avada("lazy_load")
        if page_builder == "elementor":
            return f"{admin}/admin.php?page=elementor#tab-performance"
        return ""

    def _critical_css_url():
        if page_builder == "avada":
            return _avada("critical_css")
        return ""

    def _js_compiler_url():
        if page_builder == "avada":
            return _avada("js_compiler")
        return ""

    def _defer_js_url():
        if page_builder == "avada":
            return _avada("defer_jquery")
        return ""

    def _css_compiler_url():
        if page_builder == "avada":
            return _avada("css_cache_method")
        return ""

    def _font_url():
        if page_builder == "avada":
            return _avada("font_face_display")
        return ""

    def _plugin_search(query):
        return f"{admin}/plugin-install.php?s={query}&tab=search" if admin else ""

    # ── Server-side findings ──────────────────────────────────
    if server_metrics:
        # Page cache
        cache = server_metrics.get("page_cache_detected", "none")
        if cache == "none":
            findings.append(_finding(
                "no-page-cache", "caching", "critical",
                "No page cache detected",
                "Full PHP execution on every request. Page caching typically reduces TTFB by 5-10x.",
                "high", "plugin_install",
                "Install a page cache plugin (LiteSpeed Cache, WP Super Cache, or WP Fastest Cache)",
                _plugin_search("litespeed+cache"), "Install Cache Plugin",
            ))

        # Object cache
        if not server_metrics.get("object_cache"):
            findings.append(_finding(
                "no-object-cache", "caching", "high",
                "No persistent object cache",
                "Database queries are not cached between requests. Object cache (Redis/Memcached) can reduce PHP execution by ~50%.",
                "high", "server_config",
                "Enable Redis or Memcached object caching if hosting supports it",
                _plugin_search("redis+object+cache"), "Install Redis Plugin",
            ))

        # WP-Cron
        if not server_metrics.get("wp_cron_disabled"):
            findings.append(_finding(
                "wp-cron-not-disabled", "caching", "medium",
                "WP-Cron runs on page load",
                "WP-Cron fires on visitor requests, adding latency. Use a real cron job instead.",
                "low", "server_config",
                "Set DISABLE_WP_CRON to true in wp-config.php and add a system cron: */5 * * * * wget -q -O /dev/null https://yoursite.com/wp-cron.php",
            ))

        # Autoload size
        autoload_kb = server_metrics.get("autoload_size_bytes", 0) / 1024
        if autoload_kb > 1024:
            findings.append(_finding(
                "large-autoload", "database", "high",
                f"Autoloaded options: {round(autoload_kb)}KB",
                f"WordPress loads {round(autoload_kb)}KB of options on every request. Anything over 1MB degrades TTFB.",
                "high", "manual",
                "Audit wp_options — disable autoload on large/unused entries. Top offenders are in the server metrics detail.",
                _plugin_search("wp-optimize"), "Install WP-Optimize",
            ))
        elif autoload_kb > 500:
            findings.append(_finding(
                "large-autoload", "database", "medium",
                f"Autoloaded options: {round(autoload_kb)}KB",
                f"Autoload data is {round(autoload_kb)}KB. Not critical yet but worth monitoring.",
                "medium", "manual",
                "Review autoloaded options for unnecessary data",
                _plugin_search("wp-optimize"), "Install WP-Optimize",
            ))

        # Expired transients
        expired = server_metrics.get("expired_transients", 0)
        if expired > 500:
            findings.append(_finding(
                "expired-transients", "database", "high",
                f"{expired} expired transients",
                f"Expired transients bloat the options table and slow queries.",
                "medium", "plugin_install",
                "Use a transient cleaner plugin or run: DELETE FROM wp_options WHERE option_name LIKE '_transient_timeout_%' AND option_value < UNIX_TIMESTAMP()",
                _plugin_search("transient+cleaner"), "Install Transient Cleaner",
            ))

        # Revisions
        revisions = server_metrics.get("revision_count", 0)
        if revisions > 5000:
            findings.append(_finding(
                "excessive-revisions", "database", "medium",
                f"{revisions} post revisions",
                "Post revisions bloat the posts table. Consider limiting or cleaning them.",
                "low", "manual",
                "Add define('WP_POST_REVISIONS', 5) to wp-config.php and clean old revisions",
                _plugin_search("wp-optimize"), "Install WP-Optimize",
            ))

        # Active plugins
        plugin_count = server_metrics.get("active_plugin_count", 0)
        if plugin_count >= 25:
            findings.append(_finding(
                "too-many-plugins", "plugins", "medium",
                f"{plugin_count} active plugins",
                "Each plugin adds PHP overhead. Review and deactivate unused plugins.",
                "medium", "manual",
                "Audit installed plugins — deactivate and delete any that are unused or redundant",
                f"{admin}/plugins.php" if admin else "", "Manage Plugins",
            ))

        # Heavy plugins
        active = server_metrics.get("active_plugins", [])
        heavy_found = [p["file"] for p in active if p.get("file") in _HEAVY_PLUGINS]
        if heavy_found:
            names = ", ".join(p.split("/")[0] for p in heavy_found)
            findings.append(_finding(
                "heavy-plugins", "plugins", "low",
                f"Resource-heavy plugins active: {names}",
                "These plugins are known for high resource usage. Not necessarily bad, but worth noting.",
                "low", "informational",
                "Consider lighter alternatives if performance is a priority",
                f"{admin}/plugins.php" if admin else "", "View Plugins",
            ))

        # PHP version
        php_ver = server_metrics.get("php_version", "")
        if php_ver and php_ver < "8.0":
            findings.append(_finding(
                "old-php", "server", "medium",
                f"PHP {php_ver} (upgrade recommended)",
                "PHP 8.x offers significant performance improvements over 7.x.",
                "medium", "server_config",
                "Upgrade to PHP 8.1+ via hosting control panel",
            ))

        # Memory limit
        mem = server_metrics.get("memory_limit", "")
        if mem:
            mem_mb = _parse_memory(mem)
            if mem_mb and mem_mb < 128:
                findings.append(_finding(
                    "low-memory", "server", "medium",
                    f"Memory limit: {mem}",
                    "Low memory limit can cause errors under load.",
                    "low", "server_config",
                    "Increase memory_limit to at least 256M in php.ini or wp-config.php",
                ))

        # Table sizes
        tables = server_metrics.get("table_sizes", [])
        for t in tables[:3]:
            size = float(t.get("size_mb", 0))
            if size > 50 and "options" in t.get("table", ""):
                findings.append(_finding(
                    "large-options-table", "database", "medium",
                    f"{t['table']}: {size}MB",
                    f"The {t['table']} table is {size}MB. Large options tables slow down autoload queries.",
                    "medium", "manual",
                    "Clean up unused options, transients, and orphaned data",
                    _plugin_search("wp-optimize"), "Install WP-Optimize",
                ))

    # ── Page-level findings ───────────────────────────────────
    if page_results:
        # TTFB averages
        ttfbs = [p["ttfb_ms"] for p in page_results if p.get("ttfb_ms")]
        if ttfbs:
            avg_ttfb = sum(ttfbs) / len(ttfbs)
            if avg_ttfb > 1800:
                findings.append(_finding(
                    "high-ttfb", "server", "critical",
                    f"Average TTFB: {round(avg_ttfb)}ms",
                    f"Server takes {round(avg_ttfb)}ms on average to start sending a response. Anything over 800ms is slow.",
                    "high", "server_config",
                    "Check hosting performance, enable page caching, and optimize PHP execution",
                    _plugin_search("litespeed+cache"), "Install Cache Plugin",
                ))
            elif avg_ttfb > 800:
                findings.append(_finding(
                    "high-ttfb", "server", "high",
                    f"Average TTFB: {round(avg_ttfb)}ms",
                    f"Server response time is {round(avg_ttfb)}ms. Target is under 200ms with caching.",
                    "high", "server_config",
                    "Enable page caching and consider upgrading hosting",
                    _plugin_search("litespeed+cache"), "Install Cache Plugin",
                ))

        # CWV: LCP
        lcps = [p["lcp_ms"] for p in page_results if p.get("lcp_ms")]
        if lcps:
            avg_lcp = sum(lcps) / len(lcps)
            if avg_lcp > 4000:
                findings.append(_finding(
                    "poor-lcp", "cwv", "critical",
                    f"LCP: {round(avg_lcp)}ms (poor)",
                    "Largest Contentful Paint over 4s is rated 'poor' by Google. Affects search ranking.",
                    "high", "manual",
                    "Optimize LCP element (preload hero image, reduce server time, defer non-critical JS/CSS)",
                    _lazy_url(), "Avada: Lazy Loading" if page_builder == "avada" else "Lazy Load Settings",
                ))
            elif avg_lcp > 2500:
                findings.append(_finding(
                    "needs-improvement-lcp", "cwv", "high",
                    f"LCP: {round(avg_lcp)}ms (needs improvement)",
                    "LCP between 2.5-4s is rated 'needs improvement'. Target under 2.5s.",
                    "medium", "manual",
                    "Preload the LCP image, reduce render-blocking resources, enable caching",
                    _lazy_url(), "Avada: Lazy Loading" if page_builder == "avada" else "Lazy Load Settings",
                ))

        # CWV: CLS
        cls_vals = [p["cls"] for p in page_results if p.get("cls") is not None]
        if cls_vals:
            avg_cls = sum(cls_vals) / len(cls_vals)
            if avg_cls > 0.25:
                findings.append(_finding(
                    "poor-cls", "cwv", "critical",
                    f"CLS: {round(avg_cls, 3)} (poor)",
                    "Cumulative Layout Shift over 0.25 indicates major visual instability.",
                    "high", "manual",
                    "Add width/height to images, avoid dynamic content injection above the fold",
                    _lazy_url(), "Avada: Lazy Loading" if page_builder == "avada" else "Performance Settings",
                ))
            elif avg_cls > 0.1:
                findings.append(_finding(
                    "needs-improvement-cls", "cwv", "high",
                    f"CLS: {round(avg_cls, 3)} (needs improvement)",
                    "CLS between 0.1-0.25 causes noticeable layout shifts for visitors.",
                    "medium", "manual",
                    "Set explicit dimensions on images/ads/embeds, use CSS aspect-ratio",
                    _lazy_url(), "Avada: Lazy Loading" if page_builder == "avada" else "Performance Settings",
                ))

        # CWV: TBT (proxy for INP)
        tbts = [p["tbt_ms"] for p in page_results if p.get("tbt_ms")]
        if tbts:
            avg_tbt = sum(tbts) / len(tbts)
            if avg_tbt > 600:
                findings.append(_finding(
                    "poor-tbt", "cwv", "critical",
                    f"TBT: {round(avg_tbt)}ms (poor)",
                    "Total Blocking Time over 600ms means the main thread is heavily blocked.",
                    "high", "manual",
                    "Reduce JavaScript execution, split long tasks, defer non-critical scripts",
                    _defer_js_url() or _js_compiler_url(),
                    "Avada: Defer jQuery" if page_builder == "avada" else "Performance Settings",
                ))
            elif avg_tbt > 200:
                findings.append(_finding(
                    "needs-improvement-tbt", "cwv", "high",
                    f"TBT: {round(avg_tbt)}ms (needs improvement)",
                    "TBT between 200-600ms indicates significant main-thread blocking.",
                    "medium", "manual",
                    "Audit JavaScript execution, remove unused scripts, use code splitting",
                    _js_compiler_url() or _defer_js_url(),
                    "Avada: JS Compiler" if page_builder == "avada" else "Performance Settings",
                ))

        # DOM size
        doms = [p["dom_elements"] for p in page_results if p.get("dom_elements")]
        if doms:
            avg_dom = sum(doms) / len(doms)
            if avg_dom > 1400:
                findings.append(_finding(
                    "large-dom", "frontend", "high",
                    f"Average DOM size: {round(avg_dom)} elements",
                    "Large DOMs increase memory usage and slow style calculations.",
                    "medium", "manual",
                    "Reduce DOM complexity — use lazy loading for below-fold sections, simplify page structure",
                    _lazy_url(), "Avada: Lazy Loading" if page_builder == "avada" else "Lazy Load Settings",
                ))
            elif avg_dom > 800:
                findings.append(_finding(
                    "moderate-dom", "frontend", "medium",
                    f"Average DOM size: {round(avg_dom)} elements",
                    "DOM is moderately large. Watch for growth over time.",
                    "low", "manual",
                    "Consider simplifying page structure",
                ))

        # Images without WebP/AVIF
        total_imgs = sum(p.get("total_images", 0) for p in page_results)
        unopt_imgs = sum(p.get("unoptimized_images", 0) for p in page_results)
        if unopt_imgs > 0 and total_imgs > 0:
            pct = round(unopt_imgs / total_imgs * 100)
            severity = "high" if pct > 50 else "medium"
            # Avada has built-in image quality settings, but WebP conversion needs a plugin
            findings.append(_finding(
                "unoptimized-images", "images", severity,
                f"{unopt_imgs}/{total_imgs} images not in WebP/AVIF format ({pct}%)",
                "Modern formats (WebP, AVIF) are 25-50% smaller than JPEG/PNG.",
                "medium" if severity == "high" else "low", "plugin_install",
                "Use an image optimization plugin (ShortPixel, Imagify, or EWWW) to auto-convert to WebP",
                _plugin_search("shortpixel+image+optimizer"), "Install ShortPixel",
            ))

        # Render-blocking resources
        avg_blocking = sum(p.get("render_blocking", 0) for p in page_results) / max(len(page_results), 1)
        if avg_blocking > 5:
            findings.append(_finding(
                "render-blocking", "scripts", "high",
                f"Average {round(avg_blocking)} render-blocking resources",
                "Scripts and styles in <head> without async/defer block page rendering.",
                "medium", "manual",
                "Defer non-critical JS, async-load CSS, combine/minify resources",
                _critical_css_url() or _css_compiler_url() or _plugin_search("autoptimize"),
                "Avada: Critical CSS" if page_builder == "avada" else "Install Autoptimize",
            ))
        elif avg_blocking > 3:
            findings.append(_finding(
                "render-blocking", "scripts", "medium",
                f"Average {round(avg_blocking)} render-blocking resources",
                "Some render-blocking resources detected in the page head.",
                "low", "manual",
                "Add async or defer attributes to non-critical scripts",
                _css_compiler_url() or _plugin_search("autoptimize"),
                "Avada: CSS Compiler" if page_builder == "avada" else "Install Autoptimize",
            ))

        # Third-party scripts
        avg_3p = sum(p.get("third_party_scripts", 0) for p in page_results) / max(len(page_results), 1)
        if avg_3p >= 5:
            findings.append(_finding(
                "third-party-scripts", "scripts", "medium",
                f"Average {round(avg_3p)} third-party scripts per page",
                "Third-party scripts add network overhead and can block the main thread.",
                "medium", "manual",
                "Audit third-party scripts — remove unused trackers, defer non-essential scripts",
            ))

        # Iframes
        avg_iframes = sum(p.get("iframes", 0) for p in page_results) / max(len(page_results), 1)
        if avg_iframes >= 3:
            findings.append(_finding(
                "excessive-iframes", "frontend", "medium",
                f"Average {round(avg_iframes)} iframes per page",
                "Each iframe loads a separate document, adding significant overhead.",
                "low", "manual",
                "Replace iframes with lazy-loaded embeds or static alternatives where possible",
            ))

        # Page builder
        builders = [p["page_builder"] for p in page_results if p.get("page_builder")]
        if builders:
            builder = max(set(builders), key=builders.count)
            findings.append(_finding(
                "page-builder", "frontend", "low",
                f"Page builder detected: {builder}",
                "Page builders add DOM complexity and CSS/JS overhead. Not necessarily a problem, but contributes to page weight.",
                "low", "informational",
                "Consider using the builder's performance settings (lazy loading, asset optimization)",
                _perf_url(), f"Avada: Performance" if page_builder == "avada" else "Performance Settings",
            ))

    # Sort by severity priority
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    findings.sort(key=lambda f: severity_order.get(f["severity"], 4))

    return findings


def _finding(fid, category, severity, title, detail, impact, fix_type, recommendation,
             action_url="", action_label="") -> dict:
    f = {
        "id": fid,
        "category": category,
        "severity": severity,
        "title": title,
        "detail": detail,
        "impact_estimate": impact,
        "fix_type": fix_type,
        "recommendation": recommendation,
    }
    if action_url:
        f["action_url"] = action_url
        f["action_label"] = action_label or "Fix This"
    return f


def _parse_memory(mem_str: str) -> int | None:
    """Parse PHP memory_limit string to MB."""
    mem_str = mem_str.strip().upper()
    if mem_str == "-1":
        return 9999  # unlimited
    try:
        if mem_str.endswith("G"):
            return int(float(mem_str[:-1]) * 1024)
        elif mem_str.endswith("M"):
            return int(float(mem_str[:-1]))
        elif mem_str.endswith("K"):
            return int(float(mem_str[:-1]) / 1024)
        return int(mem_str) // (1024 * 1024)
    except (ValueError, TypeError):
        return None


# ── Progress flushing ─────────────────────────────────────────────

async def _flush_progress(audit_id: str, pages_checked: int, total: int):
    """Flush audit progress to database."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{_sb_url('wp_performance_audits')}?id=eq.{audit_id}",
                headers=_sb_headers(),
                json={"pages_checked": pages_checked, "pages_audited": total},
            )
    except Exception as e:
        log.warning("Progress flush failed: %s", e)


# ── Email report ──────────────────────────────────────────────────

def _load_dotenv(path: Path) -> dict:
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


def _send_email_report(site: dict, score: int | None, page_results: list,
                       findings: list, recipient: str) -> bool:
    """Send HTML email report with score + top findings."""
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
    score_color = "#00b894" if (score or 0) >= 90 else "#fdcb6e" if (score or 0) >= 50 else "#e17055"
    critical_count = sum(1 for f in findings if f["severity"] == "critical")
    high_count = sum(1 for f in findings if f["severity"] == "high")

    # Findings rows (top 15)
    findings_rows = ""
    severity_colors = {"critical": "#e17055", "high": "#d63031", "medium": "#fdcb6e", "low": "#636e72"}
    for f in findings[:15]:
        sc = severity_colors.get(f["severity"], "#636e72")
        findings_rows += (
            f"<tr>"
            f"<td style='padding:6px 8px;border:1px solid #ddd'>"
            f"<span style='display:inline-block;background:{sc}22;color:{sc};padding:1px 6px;"
            f"border-radius:3px;font-size:11px;font-weight:600'>{f['severity']}</span></td>"
            f"<td style='padding:6px 8px;border:1px solid #ddd'><strong>{f['title']}</strong>"
            f"<div style='font-size:12px;color:#666;margin-top:2px'>{f['detail']}</div></td>"
            f"<td style='padding:6px 8px;border:1px solid #ddd;font-size:12px'>{f['recommendation']}</td>"
            f"</tr>"
        )

    html = f"""
    <html><body style="font-family:sans-serif;color:#333;max-width:800px;margin:0 auto">
    <h2>Performance Audit — {site_name}</h2>

    <div style="text-align:center;margin:20px 0">
        <div style="display:inline-block;width:100px;height:100px;border-radius:50%;
            border:6px solid {score_color};line-height:100px;font-size:36px;font-weight:700;
            color:{score_color}">{score or '?'}</div>
        <p style="margin:8px 0 0;color:#666">Overall Performance Score</p>
    </div>

    <p>Audited <strong>{len(page_results)}</strong> pages. Found <strong>{len(findings)}</strong> issues
    ({critical_count} critical, {high_count} high priority).</p>

    <h3>Top Findings</h3>
    <table style="border-collapse:collapse;width:100%">
    <tr style="background:#f5f5f5">
        <th style="padding:6px 8px;border:1px solid #ddd;width:80px">Severity</th>
        <th style="padding:6px 8px;border:1px solid #ddd">Finding</th>
        <th style="padding:6px 8px;border:1px solid #ddd;width:200px">Fix</th>
    </tr>
    {findings_rows}
    </table>

    <p style="margin-top:20px;font-size:12px;color:#999">
    Generated by OP WordPress — Performance Auditor
    </p>
    </body></html>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Performance Audit — {site_name} (Score: {score or '?'})"
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
        log.info("Performance audit email sent to %s for %s", recipient, site_name)
        return True
    except Exception as e:
        log.error("Failed to send performance audit email: %s", e)
        return False
