"""HELM — Netlify Admin connector (OPAI's own PAT).

Used exclusively to provision NEW sites on behalf of HELM users.
Not to be confused with user-supplied PATs stored in the vault.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

log = logging.getLogger("helm.connectors.netlify_admin")

_NETLIFY_API = "https://api.netlify.com/api/v1"

# Minimal HTML starter template deployed to new Netlify sites
_STARTER_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Coming Soon</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         display:flex;align-items:center;justify-content:center;
         min-height:100vh;background:#0f0f0f;color:#fff}
    .hero{text-align:center;padding:40px}
    h1{font-size:2.5rem;font-weight:700;margin-bottom:12px}
    p{color:#888;font-size:1.1rem}
    .badge{display:inline-block;margin-top:24px;padding:6px 16px;
           border:1px solid #333;border-radius:20px;font-size:12px;color:#555}
  </style>
</head>
<body>
  <div class="hero">
    <h1>Coming Soon</h1>
    <p>Something great is on its way.</p>
    <div class="badge">Powered by HELM</div>
  </div>
</body>
</html>"""


class NetlifyAdminClient:
    """Netlify API client using OPAI's own admin PAT."""

    def __init__(self, pat: str):
        self.pat = pat
        self._headers = {
            "Authorization": f"Bearer {pat}",
            "Content-Type": "application/json",
        }

    # ── Public methods ────────────────────────────────────────────────────────

    async def create_site(self, name: str, custom_domain: Optional[str] = None) -> dict:
        """Create a new Netlify site.

        Args:
            name:          Site name slug (e.g. "boutacare" → boutacare.netlify.app)
            custom_domain: Optional custom domain to set immediately.

        Returns:
            {
                "id":        "<netlify site id>",
                "url":       "https://boutacare.netlify.app",
                "admin_url": "https://app.netlify.com/sites/boutacare",
                "name":      "boutacare",
            }
        """
        payload: dict = {"name": name}
        if custom_domain:
            payload["custom_domain"] = custom_domain.lstrip("https://").lstrip("http://")

        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                f"{_NETLIFY_API}/sites",
                headers=self._headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        site_id = data.get("id", "")
        site_name = data.get("name", name)
        ssl_url = data.get("ssl_url") or data.get("url", f"https://{site_name}.netlify.app")
        admin_url = data.get("admin_url", f"https://app.netlify.com/sites/{site_name}")

        log.info("Netlify site created: %s (%s)", site_name, site_id)
        return {
            "id": site_id,
            "url": ssl_url,
            "admin_url": admin_url,
            "name": site_name,
        }

    async def deploy_template(self, site_id: str, template: str = "starter") -> dict:
        """Deploy a starter template to a Netlify site via zip deploy.

        Args:
            site_id:  Netlify site ID
            template: Template name (currently only "starter" is supported)

        Returns:
            {"deploy_id": "...", "state": "ready", "url": "..."}
        """
        # Build a minimal zip in memory containing index.html
        import io
        import zipfile

        html = _STARTER_HTML
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("index.html", html)
        zip_bytes = buf.getvalue()

        deploy_headers = {
            "Authorization": f"Bearer {self.pat}",
            "Content-Type": "application/zip",
        }

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{_NETLIFY_API}/sites/{site_id}/deploys",
                headers=deploy_headers,
                content=zip_bytes,
            )
            resp.raise_for_status()
            data = resp.json()

        deploy_id = data.get("id", "")
        state = data.get("state", "processing")
        ssl_url = data.get("ssl_url") or data.get("deploy_ssl_url", "")

        log.info("Netlify deploy submitted: %s (state=%s)", deploy_id, state)
        return {
            "deploy_id": deploy_id,
            "state": state,
            "url": ssl_url,
        }


def get_client() -> Optional[NetlifyAdminClient]:
    """Return a configured NetlifyAdminClient, or None if PAT is missing."""
    pat = os.getenv("NETLIFY_ADMIN_PAT", "")
    if not pat:
        return None
    return NetlifyAdminClient(pat)
