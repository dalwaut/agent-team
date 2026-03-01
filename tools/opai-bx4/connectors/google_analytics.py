"""Bx4 — Google Analytics 4 connector.

Uses the GA4 Data API via httpx + service account JWT auth.
Service account JSON is stored as credentials_ref in bx4_social_accounts.

Setup: create a GA4 service account, download JSON key, paste into Bx4 settings.
The service account must be granted Viewer access to the GA4 property.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, date, timedelta

import httpx

log = logging.getLogger("bx4.connectors.ga")

GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
GA_TOKEN_URL = "https://oauth2.googleapis.com/token"
GA_DATA_API = "https://analyticsdata.googleapis.com/v1beta"

# Simple in-memory token cache: {service_account_email: (token, expires_at)}
_token_cache: dict[str, tuple[str, float]] = {}


# ── Auth ──────────────────────────────────────────────────────────────────────

def _load_service_account(credentials_json: str) -> dict:
    """Parse service account JSON string."""
    try:
        return json.loads(credentials_json)
    except Exception as exc:
        raise ValueError(f"Invalid service account JSON: {exc}")


async def _get_access_token(sa: dict) -> str:
    """Get a cached or fresh access token for the service account."""
    email = sa.get("client_email", "")
    cached = _token_cache.get(email)
    if cached:
        token, expires_at = cached
        if time.time() < expires_at - 60:
            return token

    # Build JWT assertion
    try:
        from jose import jwt as jose_jwt
    except ImportError:
        raise RuntimeError("python-jose required for GA4 auth — install it via requirements.txt")

    now = int(time.time())
    payload = {
        "iss": email,
        "scope": GA_SCOPE,
        "aud": GA_TOKEN_URL,
        "iat": now,
        "exp": now + 3600,
    }
    private_key = sa.get("private_key", "")
    assertion = jose_jwt.encode(payload, private_key, algorithm="RS256")

    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            GA_TOKEN_URL,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
        )
        r.raise_for_status()
        data = r.json()

    token = data["access_token"]
    expires_in = data.get("expires_in", 3600)
    _token_cache[email] = (token, time.time() + expires_in)
    return token


# ── Validation ────────────────────────────────────────────────────────────────

async def validate_ga_credentials(credentials_json: str, property_id: str) -> dict:
    """Validate GA4 service account JSON and property ID.

    Returns {valid, property_name, error}.
    """
    try:
        sa = _load_service_account(credentials_json)
        token = await _get_access_token(sa)

        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(
                f"{GA_DATA_API}/properties/{property_id}:runReport",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "dateRanges": [{"startDate": "7daysAgo", "endDate": "today"}],
                    "metrics": [{"name": "sessions"}],
                },
            )
            if r.status_code == 403:
                return {"valid": False, "error": "Service account lacks Viewer access to this GA4 property"}
            if r.status_code == 404:
                return {"valid": False, "error": f"Property ID {property_id} not found"}
            r.raise_for_status()
            return {"valid": True, "property_name": f"GA4 Property {property_id}", "error": None}

    except ValueError as exc:
        return {"valid": False, "error": str(exc)}
    except Exception as exc:
        return {"valid": False, "error": f"Connection error: {exc}"}


# ── Data Fetch ────────────────────────────────────────────────────────────────

async def fetch_ga_snapshot(
    credentials_json: str,
    property_id: str,
    days: int = 30,
) -> dict:
    """Fetch key GA4 metrics for the last `days` days.

    Returns a metrics dict suitable for bx4_social_snapshots.
    """
    sa = _load_service_account(credentials_json)
    token = await _get_access_token(sa)

    start = (date.today() - timedelta(days=days)).strftime("%Y-%m-%d")
    end   = date.today().strftime("%Y-%m-%d")

    report_body = {
        "dateRanges": [{"startDate": start, "endDate": end}],
        "metrics": [
            {"name": "sessions"},
            {"name": "totalUsers"},
            {"name": "newUsers"},
            {"name": "screenPageViews"},
            {"name": "averageSessionDuration"},
            {"name": "bounceRate"},
            {"name": "engagementRate"},
            {"name": "eventCount"},
        ],
        "dimensions": [],
    }

    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(
            f"{GA_DATA_API}/properties/{property_id}:runReport",
            headers={"Authorization": f"Bearer {token}"},
            json=report_body,
        )
        r.raise_for_status()
        data = r.json()

    rows = data.get("rows", [])
    if not rows:
        return _empty_snapshot()

    values = rows[0].get("metricValues", [])
    names = [m["name"] for m in report_body["metrics"]]

    def _val(name: str, default=0) -> float:
        try:
            idx = names.index(name)
            return float(values[idx].get("value", default))
        except (ValueError, IndexError):
            return float(default)

    sessions      = _val("sessions")
    total_users   = _val("totalUsers")
    new_users     = _val("newUsers")
    page_views    = _val("screenPageViews")
    engagement    = _val("engagementRate") * 100   # convert to %
    bounce_rate   = _val("bounceRate") * 100
    avg_session   = _val("averageSessionDuration")

    # Compute a simple health score: high sessions + engagement + low bounce = good
    health = min(100, int(
        (min(sessions / 1000, 1) * 40)        # up to 40 pts for volume
        + (engagement / 100 * 35)              # up to 35 pts for engagement
        + ((100 - bounce_rate) / 100 * 25)     # up to 25 pts for retention
    ))

    return {
        "followers": int(total_users),         # "followers" = total users for GA
        "follower_delta": int(new_users),
        "reach": int(page_views),
        "impressions": int(sessions),
        "engagement_rate": round(engagement, 2),
        "posts_count": 0,                      # not applicable for GA
        "frequency_score": 0,
        "frequency_grade": "N/A",
        "platform_health_score": health,
        "metrics_json": {
            "sessions": sessions,
            "total_users": total_users,
            "new_users": new_users,
            "page_views": page_views,
            "engagement_rate_pct": round(engagement, 2),
            "bounce_rate_pct": round(bounce_rate, 2),
            "avg_session_seconds": round(avg_session, 1),
            "period_days": days,
            "period_start": start,
            "period_end": end,
        },
    }


def _empty_snapshot() -> dict:
    return {
        "followers": 0, "follower_delta": 0, "reach": 0, "impressions": 0,
        "engagement_rate": 0, "posts_count": 0, "frequency_score": 0,
        "frequency_grade": "N/A", "platform_health_score": 0, "metrics_json": {},
    }
