"""Multi-site orchestrator pool — wraps wp-agent for per-site management."""

import sys
import time
import logging
from pathlib import Path
from typing import Optional

import config

# Add wp-agent to path
sys.path.insert(0, str(config.WP_AGENT_DIR))

from src.orchestrator import AgentOrchestrator, OrchestratorConfig
from src.core.client import WordPressClient
from src.agents.base import ActionResult, ActionStatus

log = logging.getLogger("opai-wordpress.site-manager")

# Pool of active orchestrator instances keyed by site UUID
_pool: dict[str, dict] = {}
IDLE_TIMEOUT = 300  # 5 minutes


class SiteCredentials:
    """Credentials extracted from Supabase wp_sites row."""

    def __init__(self, row: dict):
        self.id = row["id"]
        self.name = row.get("name", "")
        self.url = row["url"].rstrip("/")
        self.api_base = row.get("api_base", "/wp-json")
        self.username = row["username"]
        self.app_password = row["app_password"]
        self.is_woocommerce = row.get("is_woocommerce", False)
        self.woo_key = row.get("woo_key")
        self.woo_secret = row.get("woo_secret")


def _build_client(creds: SiteCredentials) -> WordPressClient:
    """Build a WordPressClient from credentials without a config file."""
    client = object.__new__(WordPressClient)
    client.config = {
        "site": {"name": creds.name, "url": creds.url},
        "auth": {"username": creds.username},
        "api": {"base_path": creds.api_base, "timeout": 30, "retry_attempts": 3},
    }
    client.base_url = creds.url
    client.api_base = f"{creds.url}{creds.api_base}"
    client.timeout = 30

    import requests
    import base64

    client.session = requests.Session()
    credentials = base64.b64encode(
        f"{creds.username}:{creds.app_password}".encode()
    ).decode()
    client.session.headers.update({
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    })

    return client


def _build_orchestrator(creds: SiteCredentials) -> AgentOrchestrator:
    """Build an AgentOrchestrator from credentials (no config.yaml needed)."""
    orc = object.__new__(AgentOrchestrator)
    orc.config = OrchestratorConfig()
    orc._client = _build_client(creds)
    orc._initialized = True
    orc._agents = {}

    # Register all agents
    for name, agent_cls in AgentOrchestrator.AGENT_REGISTRY.items():
        orc._agents[name] = agent_cls(orc._client)

    return orc


def get_orchestrator(creds: SiteCredentials) -> AgentOrchestrator:
    """Get or create an orchestrator for a site. Manages connection pool."""
    site_id = creds.id

    # Return cached if still alive
    if site_id in _pool:
        entry = _pool[site_id]
        entry["last_used"] = time.time()
        return entry["orchestrator"]

    # Create new
    orc = _build_orchestrator(creds)
    _pool[site_id] = {
        "orchestrator": orc,
        "last_used": time.time(),
        "creds": creds,
    }
    log.info("Created orchestrator for site %s (%s)", creds.name, site_id)
    return orc


def remove_site(site_id: str):
    """Remove a site from the pool."""
    _pool.pop(site_id, None)


def cleanup_idle():
    """Remove orchestrators idle longer than IDLE_TIMEOUT."""
    now = time.time()
    expired = [
        sid for sid, entry in _pool.items()
        if now - entry["last_used"] > IDLE_TIMEOUT
    ]
    for sid in expired:
        _pool.pop(sid, None)
        log.info("Evicted idle orchestrator: %s", sid)


def execute(creds: SiteCredentials, agent: str, action: str, **kwargs) -> dict:
    """Execute a wp-agent action on a site. Returns serializable dict."""
    orc = get_orchestrator(creds)
    try:
        result: ActionResult = orc.execute(agent, action, **kwargs)
        return {
            "action": result.action,
            "status": result.status.value if hasattr(result.status, "value") else str(result.status),
            "data": result.data,
            "error": result.error,
            "duration_ms": result.duration_ms,
        }
    except Exception as e:
        return {
            "action": f"{agent}.{action}",
            "status": "failed",
            "data": None,
            "error": str(e),
            "duration_ms": None,
        }


def test_connection(creds: SiteCredentials) -> dict:
    """Test connection to a WordPress site."""
    orc = get_orchestrator(creds)
    try:
        result = orc.test_connection()
        return {
            "success": result.status.value == "success" if hasattr(result.status, "value") else False,
            "data": result.data,
            "error": result.error,
        }
    except Exception as e:
        return {"success": False, "data": None, "error": str(e)}


def get_site_info(creds: SiteCredentials) -> dict:
    """Get detailed site info (plugins, themes, version, etc.)."""
    orc = get_orchestrator(creds)
    info = {}

    # Get settings for WP version
    try:
        settings_result = orc.execute("settings", "get-site-info")
        if hasattr(settings_result.status, "value") and settings_result.status.value == "success":
            info["site_info"] = settings_result.data
    except Exception:
        pass

    # Get active theme
    try:
        theme_result = orc.execute("plugins", "get-active-theme")
        if hasattr(theme_result.status, "value") and theme_result.status.value == "success":
            info["active_theme"] = theme_result.data
    except Exception:
        pass

    # Get plugin count
    try:
        plugins_result = orc.execute("plugins", "list")
        if hasattr(plugins_result.status, "value") and plugins_result.status.value == "success":
            plugins = plugins_result.data if isinstance(plugins_result.data, list) else []
            info["plugins_total"] = len(plugins)
            info["plugins"] = plugins
    except Exception:
        pass

    # Get themes
    try:
        themes_result = orc.execute("plugins", "list-themes")
        if hasattr(themes_result.status, "value") and themes_result.status.value == "success":
            info["themes"] = themes_result.data if isinstance(themes_result.data, list) else []
    except Exception:
        pass

    return info
