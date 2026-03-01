"""OPAI Portal — Login + Role Router + Admin Dashboard.

The single entry point for all OPAI web access.
Routes:
    /auth/login   — Login page (Supabase JS client)
    /auth/callback — OAuth callback (future)
    /              — Role router: admin → /admin, user → /chat
    /admin         — Admin dashboard
"""

import json
import logging
import resource
import sys
import time
from collections import defaultdict
from pathlib import Path

_start_time = time.time()

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse

import config


# ── Suppress noisy health-check access logs ────────────────
class _HealthCheckFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if '"GET /health ' in msg or '"GET /api/rustdesk ' in msg:
            return False
        return True

logging.getLogger("uvicorn.access").addFilter(_HealthCheckFilter())

# Add shared auth to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

app = FastAPI(
    title="OPAI Portal",
    version="1.0.0",
    description="OPAI Auth Portal — Login, role routing, admin dashboard",
)


# ── Auth pages ─────────────────────────────────────────────

@app.get("/auth/login")
async def login_page():
    """Serve the login page."""
    return FileResponse(str(config.STATIC_DIR / "login.html"))


@app.get("/auth/callback")
async def auth_callback():
    """OAuth callback — redirect to root for role routing."""
    return RedirectResponse("/")


@app.get("/auth/verify")
async def auth_verify():
    """Serve the invite verification page.

    Handles token_hash from Supabase invite emails, verifies the OTP,
    creates a session, and redirects to the onboarding wizard.
    """
    return FileResponse(str(config.STATIC_DIR / "verify.html"))


@app.get("/auth/config")
async def auth_config():
    """Return Supabase config for frontend auth.js initialization."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── Role router ───────────────────────────────────────────

@app.get("/")
async def landing():
    """Redirect to dashboard — public site lives at opai.boutabyte.com."""
    return RedirectResponse("/dashboard")


@app.get("/dashboard")
async def dashboard():
    """Serve the authenticated dashboard (auth checked client-side)."""
    return FileResponse(str(config.STATIC_DIR / "index.html"))


@app.get("/admin")
async def admin_dashboard():
    """Serve admin dashboard (auth checked client-side)."""
    return FileResponse(str(config.STATIC_DIR / "index.html"))


# ── Onboarding ──────────────────────────────────────────────

@app.get("/onboard/")
async def onboard_wizard():
    """Serve the multi-step onboarding wizard."""
    return FileResponse(str(config.STATIC_DIR / "onboard.html"))


@app.get("/onboard/status")
async def onboard_status(request: Request):
    """Check if current user has completed onboarding.

    Returns {"onboarded": bool}. Reads from Supabase profile.
    The JS client passes the auth token in the Authorization header.
    """
    import httpx

    auth_header = request.headers.get("authorization", "")
    if not auth_header:
        return {"onboarded": False}

    # Decode token to get user ID
    sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
    from auth import decode_token

    try:
        _, _, token = auth_header.partition(" ")
        user = await decode_token(token)
    except Exception:
        return {"onboarded": False}

    # Check profile
    supabase_url = config.SUPABASE_URL
    import os
    service_key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not supabase_url or not service_key:
        return {"onboarded": False}

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                f"{supabase_url}/rest/v1/profiles?id=eq.{user.id}&select=onboarding_completed",
                headers={
                    "apikey": service_key,
                    "Authorization": f"Bearer {service_key}",
                },
            )
            if resp.status_code == 200:
                rows = resp.json()
                if rows:
                    return {"onboarded": rows[0].get("onboarding_completed", False)}
    except Exception:
        pass

    return {"onboarded": False}


# ── User apps ────────────────────────────────────────────

@app.get("/api/me/apps")
async def my_apps(request: Request):
    """Return allowed_apps for the current user."""
    import httpx
    import os

    auth_header = request.headers.get("authorization", "")
    if not auth_header:
        return {"allowed_apps": []}

    from auth import decode_token

    try:
        _, _, token = auth_header.partition(" ")
        user = await decode_token(token)
    except Exception:
        return {"allowed_apps": []}

    service_key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not config.SUPABASE_URL or not service_key:
        return {"allowed_apps": []}

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                f"{config.SUPABASE_URL}/rest/v1/profiles?id=eq.{user.id}&select=allowed_apps",
                headers={
                    "apikey": service_key,
                    "Authorization": f"Bearer {service_key}",
                },
            )
            if resp.status_code == 200:
                rows = resp.json()
                if rows and rows[0].get("allowed_apps"):
                    return {"allowed_apps": rows[0]["allowed_apps"]}
    except Exception:
        pass

    return {"allowed_apps": []}


# ── Feedback ──────────────────────────────────────────────

FEEDBACK_QUEUE = Path(__file__).parent.parent.parent / "notes" / "Improvements" / "feedback-queue.json"
_feedback_rate: dict[str, list[float]] = defaultdict(list)
_FEEDBACK_RATE_LIMIT = 5   # max per window
_FEEDBACK_RATE_WINDOW = 60  # seconds


@app.post("/api/feedback")
async def submit_feedback(request: Request):
    """Accept user feedback and append to the feedback queue."""
    # Rate limit by IP
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    hits = _feedback_rate[client_ip]
    _feedback_rate[client_ip] = [t for t in hits if now - t < _FEEDBACK_RATE_WINDOW]
    if len(_feedback_rate[client_ip]) >= _FEEDBACK_RATE_LIMIT:
        return JSONResponse({"error": "Rate limit exceeded"}, status_code=429)
    _feedback_rate[client_ip].append(now)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    user_text = (body.get("user_text") or "").strip()
    if not user_text or len(user_text) > 2000:
        return JSONResponse({"error": "user_text required (max 2000 chars)"}, status_code=400)

    import secrets, base64
    fb_id = f"fb_{int(now * 1000)}_{secrets.token_hex(3)}"

    # Process image attachments (max 5, max 5MB each)
    saved_attachments = []
    raw_attachments = body.get("attachments") or []
    if isinstance(raw_attachments, list) and len(raw_attachments) <= 5:
        attach_dir = Path(__file__).parent.parent.parent / "notes" / "feedback" / "attachments"
        attach_dir.mkdir(parents=True, exist_ok=True)
        for i, att in enumerate(raw_attachments[:5]):
            try:
                data_b64 = att.get("data", "")
                img_bytes = base64.b64decode(data_b64)
                if len(img_bytes) > 5 * 1024 * 1024:
                    continue
                ext_map = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
                ext = ext_map.get(att.get("type", ""), ".png")
                filename = f"{fb_id}_{i}{ext}"
                (attach_dir / filename).write_bytes(img_bytes)
                saved_attachments.append({"filename": filename, "type": att.get("type", "image/png"), "size": len(img_bytes)})
            except Exception:
                continue

    item = {
        "id": fb_id,
        "tool": (body.get("tool") or "unknown")[:50],
        "page_path": (body.get("page_path") or "/")[:200],
        "user_text": user_text,
        "user_id": (body.get("user_id") or None),
        "user_email": (body.get("user_email") or None),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "severity": None,
        "category": None,
        "status": "new",
        "wiki_match": None,
        "processor_notes": None,
        "files_modified": [],
        "attachments": saved_attachments,
    }

    # Atomic-ish write: read → append → write
    try:
        queue = json.loads(FEEDBACK_QUEUE.read_text()) if FEEDBACK_QUEUE.exists() else {"version": 1, "items": []}
        queue["items"].append(item)
        FEEDBACK_QUEUE.write_text(json.dumps(queue, indent=2))
    except Exception as exc:
        logging.getLogger(__name__).error(f"Failed to write feedback: {exc}")
        return JSONResponse({"error": "Server error"}, status_code=500)

    # Write directly to Feedback-*.md so it appears in Task Control Panel immediately
    # (processor will refine classification later if it re-processes)
    try:
        _write_feedback_to_tool_file(item)
    except Exception as exc:
        logging.getLogger(__name__).warning(f"Failed to write instant feedback file: {exc}")

    return {"ok": True, "id": item["id"]}


def _write_feedback_to_tool_file(item: dict):
    """Write a feedback item directly to the per-tool Feedback-*.md file for instant visibility."""
    improvements_dir = Path(__file__).parent.parent.parent / "notes" / "Improvements"
    improvements_dir.mkdir(parents=True, exist_ok=True)

    tool_raw = item.get("tool", "unknown")
    # Capitalize tool name for filename (e.g., "chat" -> "Chat", "team-hub" -> "TeamHub")
    tool_name = "".join(w.capitalize() for w in tool_raw.replace("-", " ").replace("_", " ").split())
    file_path = improvements_dir / f"Feedback-{tool_name}.md"

    if file_path.exists():
        content = file_path.read_text(encoding="utf-8")
    else:
        content = f"# Feedback \u2014 {tool_name.upper()}\n\nUser feedback items organized by severity.\n\n## HIGH\n\n## MEDIUM\n\n## LOW\n\n"

    severity = item.get("severity") or "MEDIUM"
    category = item.get("category") or "uncategorized"
    attachments = item.get("attachments") or []
    attach_note = ""
    if attachments:
        fnames = ", ".join(a["filename"] for a in attachments)
        attach_note = f" **[{len(attachments)} image(s): {fnames}]**"
    entry = f"- **[{category}]** {item['user_text']}{attach_note} _({item['id']}, {item['timestamp']})_"

    section_header = f"## {severity}"
    section_idx = content.find(section_header)
    if section_idx != -1:
        insert_pos = section_idx + len(section_header)
        content = content[:insert_pos] + "\n" + entry + content[insert_pos:]
    else:
        content += f"\n{section_header}\n{entry}\n"

    file_path.write_text(content, encoding="utf-8")


# ── User Requests (App / Tool / Agent) ────────────────────

TASKS_REGISTRY = Path(__file__).parent.parent.parent / "tasks" / "registry.json"
IMPROVEMENTS_DIR = Path(__file__).parent.parent.parent / "notes" / "Improvements"
_request_rate: dict[str, list[float]] = defaultdict(list)


@app.post("/api/request")
async def submit_request(request: Request):
    """Accept an app/tool/agent request and create a system task + improvement note."""
    # Rate limit by IP
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    hits = _request_rate[client_ip]
    _request_rate[client_ip] = [t for t in hits if now - t < _FEEDBACK_RATE_WINDOW]
    if len(_request_rate[client_ip]) >= _FEEDBACK_RATE_LIMIT:
        return JSONResponse({"error": "Rate limit exceeded"}, status_code=429)
    _request_rate[client_ip].append(now)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    description = (body.get("description") or "").strip()
    request_type = (body.get("request_type") or "app")[:30]
    user_id = body.get("user_id")
    user_email = body.get("user_email")

    if not description or len(description) > 2000:
        return JSONResponse({"error": "description required (max 2000 chars)"}, status_code=400)

    type_labels = {
        "app": "App/Tool",
        "agent": "AI Agent",
        "integration": "Integration",
        "feature": "Feature Enhancement",
    }
    type_label = type_labels.get(request_type, request_type.title())

    # 1. Create task in registry
    task_id = None
    try:
        registry = json.loads(TASKS_REGISTRY.read_text()) if TASKS_REGISTRY.is_file() else {"tasks": {}}

        date_str = time.strftime("%Y%m%d")
        existing = [k for k in registry["tasks"] if k.startswith(f"t-{date_str}-")]
        next_num = len(existing) + 1
        while f"t-{date_str}-{next_num:03d}" in registry["tasks"]:
            next_num += 1
        task_id = f"t-{date_str}-{next_num:03d}"

        now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        task = {
            "id": task_id,
            "title": f"[{type_label} Request] {description[:80]}",
            "description": description,
            "source": "user-request",
            "sourceRef": {
                "requestType": request_type,
                "typeLabel": type_label,
                "userId": user_id,
                "userEmail": user_email,
            },
            "project": None,
            "client": None,
            "assignee": "agent",
            "status": "pending",
            "priority": "normal",
            "deadline": None,
            "routing": {
                "type": "user-request",
                "squads": [],
                "mode": "propose",
            },
            "queueId": None,
            "createdAt": now_iso,
            "updatedAt": None,
            "completedAt": None,
            "agentConfig": {
                "agentId": "problem-solver",
                "agentType": "agent",
                "agentName": "Problem Solver",
                "instructions": f"Review this {type_label} request from a user. Classify it as: (a) a valid system improvement — write a brief spec to notes/Improvements/, or (b) unnecessary/duplicate — explain why. Always create an actionable recommendation for the HITL reviewer.",
                "response": None,
                "reportFile": None,
                "completedAt": None,
            },
            "attachments": [],
            "notes": f"Submitted via portal by {user_email or 'anonymous'}",
        }

        registry["tasks"][task_id] = task
        registry["lastUpdated"] = now_iso
        TASKS_REGISTRY.write_text(json.dumps(registry, indent=2))
    except Exception as exc:
        logging.getLogger(__name__).error(f"Failed to create task for request: {exc}")
        return JSONResponse({"error": "Server error creating task"}, status_code=500)

    # 2. Also write to improvements folder for visibility
    try:
        IMPROVEMENTS_DIR.mkdir(parents=True, exist_ok=True)
        req_file = IMPROVEMENTS_DIR / "Feedback-Portal.md"
        if req_file.exists():
            content = req_file.read_text(encoding="utf-8")
        else:
            content = "# Feedback -- PORTAL\n\nUser feedback items organized by severity.\n\n## HIGH\n\n## MEDIUM\n\n## LOW\n\n"

        entry = f"- **[{request_type}-request]** {description} _({task_id}, {time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())}, {user_email or 'anonymous'})_"
        section_idx = content.find("## MEDIUM")
        if section_idx != -1:
            insert_pos = section_idx + len("## MEDIUM")
            content = content[:insert_pos] + "\n" + entry + content[insert_pos:]
        else:
            content += f"\n## MEDIUM\n{entry}\n"
        req_file.write_text(content, encoding="utf-8")
    except Exception as exc:
        logging.getLogger(__name__).warning(f"Failed to write request to improvements: {exc}")

    # 3. Also submit as feedback for the feedback pipeline to process
    try:
        import secrets
        fb_item = {
            "id": f"fb_{int(now * 1000)}_{secrets.token_hex(3)}",
            "tool": "portal",
            "page_path": "/dashboard",
            "user_text": f"[{type_label} Request] {description}",
            "user_id": user_id,
            "user_email": user_email,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "severity": None,
            "category": f"{request_type}-request",
            "status": "new",
            "wiki_match": None,
            "processor_notes": None,
            "files_modified": [],
            "task_id": task_id,
        }
        queue = json.loads(FEEDBACK_QUEUE.read_text()) if FEEDBACK_QUEUE.exists() else {"version": 1, "items": []}
        queue["items"].append(fb_item)
        FEEDBACK_QUEUE.write_text(json.dumps(queue, indent=2))
    except Exception as exc:
        logging.getLogger(__name__).warning(f"Failed to write request to feedback queue: {exc}")

    return {"ok": True, "task_id": task_id}


# ── RustDesk ──────────────────────────────────────────────

@app.get("/api/rustdesk")
def rustdesk_info():
    """Return RustDesk connection info and service status."""
    import subprocess

    # Get RustDesk ID
    rd_id = None
    try:
        result = subprocess.run(
            ["rustdesk", "--get-id"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.strip().splitlines():
            stripped = line.strip()
            if stripped.isdigit():
                rd_id = stripped
                break
    except Exception:
        pass

    # Check systemd service status
    active = False
    try:
        result = subprocess.run(
            ["systemctl", "is-active", "rustdesk"],
            capture_output=True, text=True, timeout=3,
        )
        active = result.stdout.strip() == "active"
    except Exception:
        pass

    return {
        "id": rd_id,
        "active": active,
        "web_client": "https://rustdesk.com/web",
    }


# ── Pages Manager ─────────────────────────────────────────
#
# Manages versioned snapshots of public site pages at opai.boutabyte.com.
# Pages are tracked in a registry (pages-registry.json) with routes, status,
# deploy methods, and archive history.
#
# Source files live in tools/opai-billing/public-site/.
# Archives are stored in static/archive/ with slug prefixes.

import re
import shutil

ARCHIVE_DIR = config.STATIC_DIR / "archive"
ARCHIVE_DIR.mkdir(exist_ok=True)

_PUBLIC_SITE_DIR = Path("/workspace/synced/opai/tools/opai-billing/public-site")
_REGISTRY_PATH = ARCHIVE_DIR / "pages-registry.json"

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$")
_ROUTE_RE = re.compile(r"^/[a-z0-9][a-z0-9/-]*$")
_RESERVED_ROUTES = frozenset([
    "/", "/auth", "/dashboard", "/admin", "/billing", "/api",
    "/onboard", "/health", "/static", "/archive",
])
_MAX_HTML_SIZE = 2 * 1024 * 1024  # 2 MB

_OPAI_SERVER_TAILSCALE = "100.72.206.23"

_SEED_PAGES = [
    {
        "slug": "landing",
        "name": "Landing Page",
        "source_file": "index.html",
        "route": "/about",
        "status": "active",
        "page_type": "marketing",
        "deploy_method": "static",
        "created_at": "2026-02-17T22:00:00Z",
        "updated_at": "2026-02-17T22:00:00Z",
        "notes": "",
    },
    {
        "slug": "welcome",
        "name": "Welcome Page",
        "source_file": "welcome.html",
        "route": "/welcome",
        "status": "active",
        "page_type": "onboarding",
        "deploy_method": "rewrite",
        "created_at": "2026-02-17T22:00:00Z",
        "updated_at": "2026-02-17T22:00:00Z",
        "notes": "",
    },
]


class _Registry:
    """Thread-safe pages registry backed by pages-registry.json."""

    def __init__(self, path: Path):
        self._path = path
        self._data: dict | None = None

    def _load(self) -> dict:
        if self._path.exists():
            return json.loads(self._path.read_text())
        # Seed with defaults
        data = {"version": 1, "pages": list(_SEED_PAGES)}
        self._save(data)
        return data

    def _save(self, data: dict):
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.rename(self._path)
        self._data = data

    def _ensure(self) -> dict:
        if self._data is None:
            self._data = self._load()
        return self._data

    def list(self) -> list[dict]:
        return list(self._ensure()["pages"])

    def get(self, slug: str) -> dict | None:
        for p in self._ensure()["pages"]:
            if p["slug"] == slug:
                return dict(p)
        return None

    def create(self, page: dict) -> dict:
        data = self._ensure()
        data["pages"].append(page)
        self._save(data)
        return page

    def update(self, slug: str, updates: dict) -> dict | None:
        data = self._ensure()
        for i, p in enumerate(data["pages"]):
            if p["slug"] == slug:
                p.update(updates)
                p["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                data["pages"][i] = p
                self._save(data)
                return dict(p)
        return None

    def delete(self, slug: str) -> bool:
        data = self._ensure()
        before = len(data["pages"])
        data["pages"] = [p for p in data["pages"] if p["slug"] != slug]
        if len(data["pages"]) < before:
            self._save(data)
            return True
        return False

    def slugs(self) -> set[str]:
        return {p["slug"] for p in self._ensure()["pages"]}

    def routes(self) -> dict[str, str]:
        """Return {route: slug} for all pages."""
        return {p["route"]: p["slug"] for p in self._ensure()["pages"]}


_registry = _Registry(_REGISTRY_PATH)


def _valid_archive_name(filename: str) -> bool:
    """Check that a filename matches an allowed archive pattern."""
    if not filename.endswith(".html"):
        return False
    slugs = _registry.slugs()
    for slug in slugs:
        if filename.startswith(slug + "_"):
            return True
    return False


def _page_info(slug: str) -> dict | None:
    """Get page info dict compatible with old _PAGE_MAP format."""
    page = _registry.get(slug)
    if not page:
        return None
    return {
        "file": page["source_file"],
        "dir": _PUBLIC_SITE_DIR,
        "prefix": page["slug"],
    }


def _generate_traefik_yaml() -> str:
    """Generate Traefik dynamic config YAML from active pages."""
    pages = [p for p in _registry.list() if p["status"] == "active"]
    lines = [
        "# Auto-generated by OPAI Pages Manager",
        "# DO NOT EDIT - regenerated on Deploy Routes",
        "http:",
        "  routers:",
    ]

    # HTTP → HTTPS redirect
    lines += [
        "    http-catchall:",
        "      rule: \"HostRegexp(`opai.boutabyte.com`)\"",
        "      entryPoints:",
        "        - http",
        "      middlewares:",
        "        - redirect-to-https",
        "      service: noop@internal",
        "",
    ]

    for p in pages:
        slug = p["slug"]
        route = p["route"]

        if p["deploy_method"] == "static":
            # Strip prefix, serve from static dir (like /about → index.html)
            lines += [
                f"    {slug}-router:",
                f"      rule: \"Host(`opai.boutabyte.com`) && PathPrefix(`{route}`)\"",
                "      entryPoints:",
                "        - https",
                "      priority: 100",
                f"      service: static-pages",
                "      middlewares:",
                f"        - {slug}-strip",
                "      tls:",
                "        certResolver: letsencrypt",
                "",
            ]
        else:
            # Rewrite path to specific file (like /welcome → welcome.html)
            lines += [
                f"    {slug}-router:",
                f"      rule: \"Host(`opai.boutabyte.com`) && Path(`{route}`)\"",
                "      entryPoints:",
                "        - https",
                "      priority: 100",
                f"      service: static-pages",
                "      middlewares:",
                f"        - {slug}-rewrite",
                "      tls:",
                "        certResolver: letsencrypt",
                "",
            ]

    # Catch-all → OPAI Server
    lines += [
        "    opai-catchall:",
        "      rule: \"Host(`opai.boutabyte.com`)\"",
        "      entryPoints:",
        "        - https",
        "      priority: 1",
        "      service: opai-server",
        "      tls:",
        "        certResolver: letsencrypt",
        "",
    ]

    # Middlewares
    lines += ["  middlewares:"]
    lines += [
        "    redirect-to-https:",
        "      redirectScheme:",
        "        scheme: https",
        "        permanent: true",
        "",
    ]

    for p in pages:
        slug = p["slug"]
        route = p["route"]
        if p["deploy_method"] == "static":
            lines += [
                f"    {slug}-strip:",
                "      stripPrefix:",
                f"        prefixes:",
                f"          - \"{route}\"",
                "",
            ]
        else:
            lines += [
                f"    {slug}-rewrite:",
                "      replacePath:",
                f"        path: \"/{p['source_file']}\"",
                "",
            ]

    # Services
    lines += [
        "  services:",
        "    static-pages:",
        "      loadBalancer:",
        "        servers:",
        "          - url: \"http://host.docker.internal:8095\"",
        "",
        "    opai-server:",
        "      loadBalancer:",
        "        servers:",
        f"          - url: \"https://{_OPAI_SERVER_TAILSCALE}:443\"",
        "        serversTransport: insecure-transport",
        "",
        "  serversTransports:",
        "    insecure-transport:",
        "      insecureSkipVerify: true",
    ]

    return "\n".join(lines) + "\n"


@app.get("/api/pages/source-files")
async def list_source_files():
    """List available HTML files in the public-site directory."""
    files = []
    for f in sorted(_PUBLIC_SITE_DIR.glob("*.html")):
        stat = f.stat()
        files.append({
            "name": f.name,
            "size_kb": round(stat.st_size / 1024, 1),
            "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(stat.st_mtime)),
        })
    return {"files": files, "dir": str(_PUBLIC_SITE_DIR)}


_BROWSE_ROOT = Path("/workspace/synced/opai")


@app.get("/api/pages/browse")
async def browse_files(dir: str = "tools/opai-billing/public-site"):
    """Browse files in the OPAI workspace for the file picker."""
    target = (_BROWSE_ROOT / dir).resolve()

    # Security: must stay within workspace
    if not str(target).startswith(str(_BROWSE_ROOT)):
        return JSONResponse({"error": "Access denied"}, status_code=403)
    if not target.is_dir():
        return JSONResponse({"error": "Not a directory"}, status_code=400)

    rel = str(target.relative_to(_BROWSE_ROOT))
    parent = str(target.parent.relative_to(_BROWSE_ROOT)) if target != _BROWSE_ROOT else None

    items = []
    try:
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.name.startswith("."):
                continue
            stat = entry.stat()
            items.append({
                "name": entry.name,
                "is_dir": entry.is_dir(),
                "size_kb": round(stat.st_size / 1024, 1) if entry.is_file() else None,
                "modified": time.strftime("%Y-%m-%d %H:%M", time.gmtime(stat.st_mtime)),
                "path": str(entry.relative_to(_BROWSE_ROOT)),
            })
    except PermissionError:
        return JSONResponse({"error": "Permission denied"}, status_code=403)

    return {"dir": rel, "parent": parent, "items": items}


@app.get("/api/pages/read-file")
async def read_source_file(path: str):
    """Read an HTML file's content for the code editor."""
    target = (_BROWSE_ROOT / path).resolve()
    if not str(target).startswith(str(_BROWSE_ROOT)):
        return JSONResponse({"error": "Access denied"}, status_code=403)
    if not target.is_file():
        return JSONResponse({"error": "Not a file"}, status_code=400)
    if target.stat().st_size > _MAX_HTML_SIZE:
        return JSONResponse({"error": "File too large"}, status_code=400)
    try:
        content = target.read_text(errors="replace")
    except Exception:
        return JSONResponse({"error": "Cannot read file"}, status_code=500)
    return {"path": path, "content": content, "size_kb": round(target.stat().st_size / 1024, 1)}


@app.post("/api/pages/{slug}/save-content")
async def save_page_content(slug: str, request: Request):
    """Save HTML content to a page's source file."""
    page = _registry.get(slug)
    if not page:
        return JSONResponse({"error": "Page not found"}, status_code=404)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)
    html = (body.get("html") or "").strip()
    if not html:
        return JSONResponse({"error": "html is required"}, status_code=400)
    if len(html) > _MAX_HTML_SIZE:
        return JSONResponse({"error": f"Exceeds max size ({_MAX_HTML_SIZE // 1024}KB)"}, status_code=400)
    dest = _PUBLIC_SITE_DIR / page["source_file"]
    dest.write_text(html)
    return {"ok": True, "size_kb": round(len(html.encode()) / 1024, 1)}


@app.get("/api/pages/{slug}/preview-source")
async def preview_source(slug: str):
    """Serve the source file for a page (for preview in new window)."""
    page = _registry.get(slug)
    if not page:
        return JSONResponse({"error": "Page not found"}, status_code=404)
    source = _PUBLIC_SITE_DIR / page["source_file"]
    if not source.exists():
        return HTMLResponse("<h1>Source file not found</h1><p>" + str(source) + " does not exist yet.</p>", status_code=404)
    return FileResponse(str(source), media_type="text/html")


@app.get("/archive/")
async def archive_page():
    """Serve the pages archive manager UI."""
    return FileResponse(str(ARCHIVE_DIR / "index.html"))


# ── Registry API ─────────────────────────────────────────

@app.get("/api/pages/registry")
async def registry_list():
    """List all registered pages."""
    return {"pages": _registry.list()}


@app.post("/api/pages/registry")
async def registry_create(request: Request):
    """Create a new page entry."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    name = (body.get("name") or "").strip()
    slug = (body.get("slug") or "").strip()
    route = (body.get("route") or "").strip()
    page_type = (body.get("page_type") or "marketing").strip()
    deploy_method = (body.get("deploy_method") or "rewrite").strip()
    source_file = (body.get("source_file") or "").strip()
    notes = (body.get("notes") or "").strip()

    if not name:
        return JSONResponse({"error": "name is required"}, status_code=400)
    if not slug or not _SLUG_RE.match(slug):
        return JSONResponse({"error": "slug must be 2-30 chars, lowercase alphanumeric + hyphens"}, status_code=400)
    if _registry.get(slug):
        return JSONResponse({"error": f"Slug '{slug}' already exists"}, status_code=409)
    if not route or not _ROUTE_RE.match(route):
        return JSONResponse({"error": "route must start with / and contain only lowercase alphanumeric + hyphens"}, status_code=400)
    if route in _RESERVED_ROUTES:
        return JSONResponse({"error": f"Route '{route}' is reserved"}, status_code=400)
    existing_routes = _registry.routes()
    if route in existing_routes:
        return JSONResponse({"error": f"Route '{route}' already used by '{existing_routes[route]}'"}, status_code=409)
    if deploy_method not in ("static", "rewrite"):
        return JSONResponse({"error": "deploy_method must be 'static' or 'rewrite'"}, status_code=400)
    if not source_file:
        source_file = slug + ".html"
    if not source_file.endswith(".html") or "/" in source_file or "\\" in source_file:
        return JSONResponse({"error": "source_file must be a .html filename (no paths)"}, status_code=400)

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    page = {
        "slug": slug,
        "name": name,
        "source_file": source_file,
        "route": route,
        "status": "draft",
        "page_type": page_type,
        "deploy_method": deploy_method,
        "created_at": now,
        "updated_at": now,
        "notes": notes,
    }
    _registry.create(page)

    # If raw HTML was provided, save it as the source file
    html_content = (body.get("html_content") or "").strip()
    if html_content:
        if len(html_content) > _MAX_HTML_SIZE:
            return JSONResponse({"error": f"HTML exceeds max size ({_MAX_HTML_SIZE // 1024}KB)"}, status_code=400)
        (_PUBLIC_SITE_DIR / source_file).write_text(html_content)

    return {"ok": True, "page": page}


@app.put("/api/pages/{slug}")
async def registry_update(slug: str, request: Request):
    """Update page metadata (slug is immutable)."""
    page = _registry.get(slug)
    if not page:
        return JSONResponse({"error": "Page not found"}, status_code=404)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    updates = {}
    if "name" in body:
        updates["name"] = (body["name"] or "").strip()
    if "route" in body:
        new_route = (body["route"] or "").strip()
        if not _ROUTE_RE.match(new_route):
            return JSONResponse({"error": "Invalid route format"}, status_code=400)
        if new_route in _RESERVED_ROUTES:
            return JSONResponse({"error": f"Route '{new_route}' is reserved"}, status_code=400)
        existing = _registry.routes()
        if new_route in existing and existing[new_route] != slug:
            return JSONResponse({"error": f"Route '{new_route}' already used by '{existing[new_route]}'"}, status_code=409)
        updates["route"] = new_route
    if "page_type" in body:
        updates["page_type"] = body["page_type"]
    if "deploy_method" in body:
        if body["deploy_method"] not in ("static", "rewrite"):
            return JSONResponse({"error": "deploy_method must be 'static' or 'rewrite'"}, status_code=400)
        updates["deploy_method"] = body["deploy_method"]
    if "source_file" in body:
        sf = (body["source_file"] or "").strip()
        if not sf.endswith(".html") or "/" in sf or "\\" in sf:
            return JSONResponse({"error": "source_file must be a .html filename"}, status_code=400)
        updates["source_file"] = sf
    if "notes" in body:
        updates["notes"] = (body["notes"] or "").strip()

    result = _registry.update(slug, updates)
    return {"ok": True, "page": result}


@app.delete("/api/pages/{slug}")
async def registry_delete(slug: str):
    """Delete a page and all its archives."""
    page = _registry.get(slug)
    if not page:
        return JSONResponse({"error": "Page not found"}, status_code=404)

    # Delete all archive files for this slug
    deleted_archives = []
    for f in ARCHIVE_DIR.glob(f"{slug}_*.html"):
        f.unlink()
        deleted_archives.append(f.name)

    _registry.delete(slug)
    return {"ok": True, "deleted_slug": slug, "deleted_archives": deleted_archives}


@app.post("/api/pages/{slug}/create-from-html")
async def create_from_html(slug: str, request: Request):
    """Save pasted HTML as a new archive entry for a page."""
    page = _registry.get(slug)
    if not page:
        return JSONResponse({"error": "Page not found"}, status_code=404)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    html = body.get("html", "")
    label = (body.get("label") or "manual").strip()

    if not html or "<" not in html:
        return JSONResponse({"error": "html must contain valid HTML content"}, status_code=400)
    if len(html) > _MAX_HTML_SIZE:
        return JSONResponse({"error": f"HTML exceeds max size ({_MAX_HTML_SIZE // 1024}KB)"}, status_code=400)

    # Sanitize label for filename
    safe_label = re.sub(r"[^a-z0-9-]", "", label.lower().replace(" ", "-"))[:30] or "manual"
    ts = time.strftime("%Y-%m-%d_%H%M%S", time.localtime())
    filename = f"{slug}_{ts}_{safe_label}.html"
    (ARCHIVE_DIR / filename).write_text(html)

    return {"ok": True, "filename": filename, "preview": f"/api/archive/preview/{filename}"}


@app.post("/api/pages/{slug}/toggle-status")
async def toggle_status(slug: str):
    """Toggle page status between active and draft."""
    page = _registry.get(slug)
    if not page:
        return JSONResponse({"error": "Page not found"}, status_code=404)

    new_status = "draft" if page["status"] == "active" else "active"
    result = _registry.update(slug, {"status": new_status})

    # Auto-deploy when activating a page
    deploy_result = None
    if new_status == "active":
        deploy_resp = await deploy_all()
        if hasattr(deploy_resp, 'body'):
            import json as _json
            deploy_result = _json.loads(deploy_resp.body.decode())

    return {"ok": True, "page": result, "deployed": deploy_result}


@app.get("/api/pages/routes-preview")
async def routes_preview():
    """Preview the Traefik YAML that would be generated (dry run)."""
    yaml_content = _generate_traefik_yaml()
    active = [p for p in _registry.list() if p["status"] == "active"]
    return {
        "yaml": yaml_content,
        "active_count": len(active),
        "routes": [{"slug": p["slug"], "route": p["route"], "method": p["deploy_method"]} for p in active],
    }


@app.post("/api/pages/deploy-routes")
async def deploy_routes():
    """Regenerate Traefik YAML and SCP to BB VPS."""
    import subprocess
    import os

    yaml_content = _generate_traefik_yaml()

    # Write locally first
    local_yaml = Path("/workspace/synced/opai/tools/opai-billing/deploy/opai-boutabyte.yaml")
    local_yaml.parent.mkdir(parents=True, exist_ok=True)
    local_yaml.write_text(yaml_content)

    # SCP to BB VPS
    key = Path.home() / ".ssh" / "bb_vps"
    if not key.exists():
        return JSONResponse({"error": "SSH key not found at ~/.ssh/bb_vps"}, status_code=500)

    try:
        result = subprocess.run(
            ["scp", "-i", str(key), "-o", "StrictHostKeyChecking=accept-new",
             str(local_yaml), "root@bb-vps:/data/coolify/proxy/dynamic/opai-boutabyte.yaml"],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "HOME": str(Path.home())},
        )
    except subprocess.TimeoutExpired:
        return JSONResponse({"error": "Deploy timed out (30s)"}, status_code=500)

    if result.returncode != 0:
        return JSONResponse({"error": f"Deploy failed: {result.stderr.strip()}"}, status_code=500)

    return {"ok": True, "message": "Traefik routes deployed to BB VPS"}


@app.post("/api/pages/deploy-all")
async def deploy_all():
    """Deploy content + routes to BB VPS in one action."""
    import subprocess
    import os

    key = Path.home() / ".ssh" / "bb_vps"
    if not key.exists():
        return JSONResponse({"error": "SSH key not found at ~/.ssh/bb_vps"}, status_code=500)

    results = {"content": None, "routes": None}

    # 1. Deploy content (rsync public-site files)
    src = str(_PUBLIC_SITE_DIR) + "/"
    dest = "root@bb-vps:/var/www/opai-landing/"
    try:
        r = subprocess.run(
            ["rsync", "-az", "--no-perms", "--no-group", "--no-owner",
             "-e", f"ssh -i {key} -o StrictHostKeyChecking=accept-new",
             src, dest],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "HOME": str(Path.home())},
        )
        if r.returncode != 0:
            results["content"] = {"ok": False, "error": r.stderr.strip()}
        else:
            results["content"] = {"ok": True}
    except subprocess.TimeoutExpired:
        results["content"] = {"ok": False, "error": "Content deploy timed out (30s)"}

    # 2. Deploy routes (Traefik YAML)
    yaml_content = _generate_traefik_yaml()
    local_yaml = Path("/workspace/synced/opai/tools/opai-billing/deploy/opai-boutabyte.yaml")
    local_yaml.parent.mkdir(parents=True, exist_ok=True)
    local_yaml.write_text(yaml_content)

    try:
        r = subprocess.run(
            ["scp", "-i", str(key), "-o", "StrictHostKeyChecking=accept-new",
             str(local_yaml), "root@bb-vps:/data/coolify/proxy/dynamic/opai-boutabyte.yaml"],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "HOME": str(Path.home())},
        )
        if r.returncode != 0:
            results["routes"] = {"ok": False, "error": r.stderr.strip()}
        else:
            results["routes"] = {"ok": True}
    except subprocess.TimeoutExpired:
        results["routes"] = {"ok": False, "error": "Routes deploy timed out (30s)"}

    all_ok = results["content"]["ok"] and results["routes"]["ok"]
    status = 200 if all_ok else 207  # 207 Multi-Status if partial failure
    message = "All deployed successfully" if all_ok else "Partial deploy — check details"

    return JSONResponse({"ok": all_ok, "message": message, "details": results}, status_code=status)


# ── Archive API (refactored to use registry) ─────────────

@app.get("/api/archive/list")
async def archive_list(page: str = "landing"):
    """List archived versions for a given page type."""
    info = _page_info(page)
    if not info:
        return JSONResponse({"error": f"Unknown page slug: {page}"}, status_code=400)
    files = sorted(ARCHIVE_DIR.glob(f"{info['prefix']}_*.html"), reverse=True)
    items = []
    for f in files:
        stat = f.stat()
        items.append({
            "filename": f.name,
            "size_kb": round(stat.st_size / 1024, 1),
            "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(stat.st_mtime)),
        })
    return {"archives": items, "page": page}


@app.get("/api/archive/preview/{filename}")
async def archive_preview(filename: str):
    """Serve an archived page for preview (iframe)."""
    if not _valid_archive_name(filename):
        return JSONResponse({"error": "Invalid filename"}, status_code=400)
    filepath = ARCHIVE_DIR / filename
    if not filepath.exists() or not filepath.is_relative_to(ARCHIVE_DIR):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return FileResponse(str(filepath), media_type="text/html")


@app.post("/api/archive/save")
async def archive_save(request: Request):
    """Save the current live page as a new archive snapshot."""
    try:
        body = await request.json()
        page = body.get("page", "landing")
    except Exception:
        page = "landing"

    info = _page_info(page)
    if not info:
        return JSONResponse({"error": "Unknown page slug"}, status_code=400)

    src = info["dir"] / info["file"]
    if not src.exists():
        return JSONResponse({"error": f"No {info['file']} to archive"}, status_code=404)

    ts = time.strftime("%Y-%m-%d_%H%M%S", time.localtime())
    dest = ARCHIVE_DIR / f"{info['prefix']}_{ts}.html"
    shutil.copy2(str(src), str(dest))
    return {"ok": True, "filename": dest.name, "page": page}


@app.post("/api/archive/rollback")
async def archive_rollback(request: Request):
    """Restore an archived version as the live page."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    filename = body.get("filename", "")
    if not _valid_archive_name(filename):
        return JSONResponse({"error": "Invalid filename"}, status_code=400)

    src = ARCHIVE_DIR / filename
    if not src.exists() or not src.is_relative_to(ARCHIVE_DIR):
        return JSONResponse({"error": "Archive not found"}, status_code=404)

    # Determine which page this archive belongs to
    page_slug = None
    for slug in _registry.slugs():
        if filename.startswith(slug + "_"):
            page_slug = slug
            break
    if not page_slug:
        return JSONResponse({"error": "Cannot determine page type"}, status_code=400)

    info = _page_info(page_slug)
    dest = info["dir"] / info["file"]

    # Auto-backup current before rollback
    ts = time.strftime("%Y-%m-%d_%H%M%S", time.localtime())
    backup_name = f"{info['prefix']}_{ts}_pre-rollback.html"
    if dest.exists():
        shutil.copy2(str(dest), str(ARCHIVE_DIR / backup_name))
    shutil.copy2(str(src), str(dest))

    return {"ok": True, "restored": filename, "backup": backup_name, "page": page_slug}


@app.post("/api/archive/deploy")
async def archive_deploy():
    """Deploy the current public site files to BB VPS via SCP."""
    import subprocess
    import os

    key = Path.home() / ".ssh" / "bb_vps"
    if not key.exists():
        return JSONResponse({"error": "SSH key not found at ~/.ssh/bb_vps"}, status_code=500)

    src = str(_PUBLIC_SITE_DIR) + "/"
    dest = "root@bb-vps:/var/www/opai-landing/"

    try:
        result = subprocess.run(
            ["rsync", "-az", "--no-perms", "--no-group", "--no-owner",
             "-e", f"ssh -i {key} -o StrictHostKeyChecking=accept-new",
             src, dest],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "HOME": str(Path.home())},
        )
    except subprocess.TimeoutExpired:
        return JSONResponse({"error": "Deploy timed out (30s)"}, status_code=500)

    if result.returncode != 0:
        return JSONResponse({"error": f"Deploy failed: {result.stderr.strip()}"}, status_code=500)
    return {"ok": True, "message": "Deployed to opai.boutabyte.com"}


import uuid as _uuid

_gen_state = {"proc": None, "id": None}  # Track running generation


@app.post("/api/pages/generate/stop")
async def pages_generate_stop():
    """Kill any running AI generation process."""
    proc = _gen_state["proc"]
    if proc is not None:
        try:
            proc.kill()
            await proc.wait()
        except ProcessLookupError:
            pass
        _gen_state["proc"] = None
        _gen_state["id"] = None
        return {"ok": True, "message": "Generation stopped"}
    return {"ok": True, "message": "No generation running"}


@app.post("/api/pages/generate")
async def pages_generate(request: Request):
    """Stream-generate a page using Claude CLI (SSE)."""
    import os
    import asyncio

    # Reject if already generating (don't auto-kill)
    if _gen_state["proc"] is not None:
        try:
            rc = _gen_state["proc"].returncode
            if rc is None:  # still running
                return JSONResponse(
                    {"error": "A generation is already in progress. Stop it first."},
                    status_code=409,
                )
        except Exception:
            pass
        # Process already finished — clear stale state
        _gen_state["proc"] = None
        _gen_state["id"] = None

    body = await request.json()
    prompt = body.get("prompt", "").strip()
    page_type = body.get("page", "landing")

    if not prompt:
        return JSONResponse({"error": "prompt is required"}, status_code=400)

    info = _page_info(page_type)
    if not info:
        return JSONResponse({"error": f"Unknown page slug: {page_type}"}, status_code=400)

    current_file = info["dir"] / info["file"]
    current_raw = current_file.read_text() if current_file.exists() else ""

    # Truncate large pages to avoid overwhelming the model.
    # Keep first 300 lines (head/styles/structure) + last 50 lines (closing tags/scripts).
    MAX_LINES = 350
    lines = current_raw.splitlines(True)
    if len(lines) > MAX_LINES:
        head = lines[:300]
        tail = lines[-50:]
        current = (
            "".join(head)
            + f"\n<!-- ... {len(lines) - 350} lines omitted for brevity ... -->\n"
            + "".join(tail)
        )
    else:
        current = current_raw

    system_prompt = (
        "You are a pure HTML generator. You output ONLY raw HTML — no markdown, "
        "no code fences, no explanations, no questions, no conversation. "
        "Never ask for permissions or clarification. Never use tool calls. "
        "Your entire response must be a valid, complete, self-contained HTML document "
        "starting with <!DOCTYPE html> and ending with </html>. "
        "Nothing else — not even a single character outside the HTML."
    )

    full_prompt = (
        "Here is the current page HTML for reference (may be truncated). "
        "Preserve its overall structure, Stripe checkout integration, and styles "
        "unless the instructions say otherwise:\n\n"
        + current + "\n\n"
        "---\n\n"
        "Instructions: " + prompt + "\n\n"
        "Output the complete updated HTML page now. Start with <!DOCTYPE html>."
    )

    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    nvm_bin = "/home/dallas/.nvm/versions/node/v20.19.5/bin"
    if nvm_bin not in env.get("PATH", ""):
        env["PATH"] = nvm_bin + ":" + env.get("PATH", "")

    from starlette.responses import StreamingResponse

    gen_id = str(_uuid.uuid4())[:8]

    async def event_stream():
        """SSE generator: stream Claude output chunks + save file at end."""
        def _sse(event: str, data: str) -> str:
            return f"event: {event}\ndata: {json.dumps(data)}\n\n"

        try:
            proc = await asyncio.create_subprocess_exec(
                "claude", "-p",
                "--output-format", "text",
                "--model", "sonnet",
                "--system-prompt", system_prompt,
                "--no-session-persistence",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
        except FileNotFoundError:
            yield _sse("error", "Claude CLI not found in PATH")
            return

        _gen_state["proc"] = proc
        _gen_state["id"] = gen_id

        yield _sse("status", "Claude is thinking...")

        # Feed prompt and close stdin
        proc.stdin.write(full_prompt.encode())
        await proc.stdin.drain()
        proc.stdin.close()

        collected = []
        chars = 0
        total_timeout = 300  # 5 minutes total
        elapsed = 0
        thinking = True
        heartbeat_interval = 5  # seconds between heartbeats while thinking

        try:
            while elapsed < total_timeout:
                try:
                    read_timeout = heartbeat_interval if thinking else total_timeout - elapsed
                    chunk = await asyncio.wait_for(
                        proc.stdout.read(512), timeout=read_timeout
                    )
                except asyncio.TimeoutError:
                    elapsed += heartbeat_interval
                    if thinking and elapsed < total_timeout:
                        yield _sse("heartbeat", f"Still thinking... ({elapsed}s)")
                        continue
                    # Real timeout
                    yield _sse("error", "Generation timed out (5 min)")
                    proc.kill()
                    _gen_state["proc"] = None
                    _gen_state["id"] = None
                    return

                if not chunk:
                    break

                if thinking:
                    thinking = False
                    yield _sse("status", "Generating HTML...")

                text = chunk.decode("utf-8", errors="replace")
                collected.append(text)
                chars += len(text)
                yield _sse("chunk", text)

        except Exception as exc:
            yield _sse("error", f"Stream error: {exc}")
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            _gen_state["proc"] = None
            _gen_state["id"] = None
            return

        await proc.wait()
        _gen_state["proc"] = None
        _gen_state["id"] = None

        if proc.returncode != 0:
            stderr = (await proc.stderr.read()).decode(errors="replace").strip()
            if proc.returncode in (-9, -15):
                yield _sse("error", "Generation stopped by user")
            else:
                err_detail = stderr or "".join(collected) or "no output"
                yield _sse("error", f"Claude CLI exit {proc.returncode}: {err_detail[:500]}")
            return

        # Save to archive
        full_html = "".join(collected)
        ts = time.strftime("%Y-%m-%d_%H%M%S")
        filename = f"{info['prefix']}_{ts}_ai-generated.html"
        (ARCHIVE_DIR / filename).write_text(full_html)

        yield _sse("done", json.dumps({"filename": filename, "chars": chars}))

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.delete("/api/archive/{filename}")
async def archive_delete(filename: str):
    """Delete an archived version."""
    if not _valid_archive_name(filename):
        return JSONResponse({"error": "Invalid filename"}, status_code=400)
    filepath = ARCHIVE_DIR / filename
    if not filepath.exists() or not filepath.is_relative_to(ARCHIVE_DIR):
        return JSONResponse({"error": "Not found"}, status_code=404)
    filepath.unlink()
    return {"ok": True, "deleted": filename}


# ── Health ─────────────────────────────────────────────────

@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-portal",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


# ── Static files ──────────────────────────────────────────

# Serve static files at both /static and /auth/static (Caddy sends /auth/* requests unmodified)
app.mount("/auth/static", StaticFiles(directory=str(config.STATIC_DIR)), name="auth-static")
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
