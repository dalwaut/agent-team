"""OPAI Users — Standalone User Management Dashboard."""

import resource
import sys
import time
from pathlib import Path

_start_time = time.time()

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Add shared modules (auth) to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from routes_users import router as users_router

app = FastAPI(
    title="OPAI Users",
    version="1.0.0",
    description="OPAI User Management Dashboard",
)

# Auth config endpoint (needed by auth.js)
import config

@app.get("/api/auth/config")
def auth_config():
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }

# App registry — dynamically built from tools/ directory + external services
# Metadata for known tools: label overrides and categories
_APP_META = {
    "chat":         {"label": "Chat",            "category": "user"},
    "monitor":      {"label": "Monitor",         "category": "admin"},
    "tasks":        {"label": "Tasks",           "category": "admin"},
    "terminal":     {"label": "Terminal",         "category": "admin"},
    "messenger":    {"label": "Messenger",        "category": "user"},
    "users":        {"label": "User Controls",    "category": "admin"},
    "dev":          {"label": "OP IDE",           "category": "admin"},
    "files":        {"label": "Files",            "category": "user"},
    "forum":        {"label": "Forum",            "category": "user"},
    "docs":         {"label": "Documentation",    "category": "user"},
    "agents":       {"label": "Agent Studio",     "category": "admin"},
    "marketplace":  {"label": "Marketplace",      "category": "user"},
    "team-hub":     {"label": "Team Hub",         "category": "user"},
    "email-agent":  {"label": "Email Agent",      "category": "admin"},
    "billing":      {"label": "Billing",          "category": "admin"},
    "discord":      {"label": "Discord Bot",      "category": "admin"},
    "claude":       {"label": "Claude Code",      "category": "admin"},
    "rustdesk":     {"label": "Remote Desktop",   "category": "admin"},
    "n8n":          {"label": "n8n Automations",  "category": "admin"},
}

# Tools that are internal system services, not user-assignable apps
_EXCLUDED_TOOLS = {"orchestrator", "portal", "api-server", "email-checker", "shared",
                   "work-companion", "wp-agent"}

# External services not in tools/ but assignable to users
_EXTERNAL_APPS = ["claude", "rustdesk", "n8n"]


def _build_app_registry():
    """Scan tools/ directory and merge with metadata to build app list."""
    tools_dir = Path("/workspace/synced/opai/tools")
    apps = []
    seen = set()

    # Scan tools/ for opai-* directories (strip "opai-" prefix for ID)
    if tools_dir.is_dir():
        for d in sorted(tools_dir.iterdir()):
            if not d.is_dir():
                continue
            name = d.name
            # opai-* tools use stripped prefix as ID
            app_id = name.replace("opai-", "") if name.startswith("opai-") else name
            # Map discord-bridge → discord
            app_id = app_id.replace("-bridge", "")

            if app_id in _EXCLUDED_TOOLS or app_id in seen:
                continue

            meta = _APP_META.get(app_id, {})
            # Auto-generate label from ID if not in metadata
            label = meta.get("label", app_id.replace("-", " ").title())
            category = meta.get("category", "admin")
            apps.append({"id": app_id, "label": label, "category": category})
            seen.add(app_id)

    # Add external services not in tools/
    for ext_id in _EXTERNAL_APPS:
        if ext_id not in seen:
            meta = _APP_META.get(ext_id, {})
            label = meta.get("label", ext_id.replace("_", " ").title())
            category = meta.get("category", "admin")
            apps.append({"id": ext_id, "label": label, "category": category})
            seen.add(ext_id)

    return apps


@app.get("/api/apps")
def list_apps():
    return {"apps": _build_app_registry()}

# Team endpoint (needed for agent list in edit modal)
@app.get("/api/team")
def team_info():
    import json
    try:
        team_json = Path("/workspace/synced/opai/team.json")
        if team_json.is_file():
            return json.loads(team_json.read_text())
        return {"agents": []}
    except Exception:
        return {"agents": []}

# Mount the user management API
app.include_router(users_router)

# Serve static files
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(static_dir / "index.html"))


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-users",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8084, reload=False)
