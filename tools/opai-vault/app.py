"""OPAI Vault — Credential proxy service.

Port 8105, path /vault/

Three access tiers:
  1. Admin (Supabase JWT with admin role) — full system vault CRUD, audit viewing
  2. Service (service-key auth from localhost) — read-only, scoped to own service
  3. User (Supabase JWT, any role) — personal vault CRUD, isolated per-user

AI agents NEVER call this service directly. They use higher-level service
endpoints that internally fetch credentials from the vault.
"""

import sys
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles

# Import vault's own modules BEFORE adding shared/ to path (shared/audit.py would shadow vault's)
import config
import store
import audit
import routes_auth
import routes_user_vault
import routes_user_vault_auth

# Shared auth (inserts tools/shared/ into sys.path)
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from auth import get_current_user, require_admin, AuthUser


# ── Lifespan ──────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load secrets on startup
    try:
        store.load_secrets()
        stats = store.get_stats()
        print(f"[vault] Loaded {stats['total_secrets']} secrets from encrypted store")
    except Exception as e:
        print(f"[vault] WARNING: Could not load secrets: {e}")
        print(f"[vault] Run 'opai-vault import' to initialize the vault")
    yield


app = FastAPI(
    title="OPAI Vault",
    version="1.0.0",
    docs_url="/vault/docs",
    openapi_url="/vault/openapi.json",
    lifespan=lifespan,
)

# ── Web UI auth routes ────────────────────────────────────
app.include_router(routes_auth.router)

# ── Per-user vault routes ─────────────────────────────────
app.include_router(routes_user_vault_auth.router)
app.include_router(routes_user_vault.router)

# ── Static files ──────────────────────────────────────────
if config.STATIC_DIR.exists():
    app.mount("/vault/static", StaticFiles(directory=str(config.STATIC_DIR)), name="vault-static")


# ── Middleware: localhost-only guard ──────────────────────

@app.middleware("http")
async def localhost_guard(request: Request, call_next):
    """Only accept connections from localhost (Caddy reverse proxy)."""
    client_ip = request.client.host if request.client else "unknown"
    # Allow localhost and Tailscale local addresses
    allowed = ("127.0.0.1", "::1", "localhost")
    if client_ip not in allowed and not client_ip.startswith("100."):
        return JSONResponse(
            status_code=403,
            content={"detail": "Vault is localhost-only"},
        )
    return await call_next(request)


# ── Health ────────────────────────────────────────────────

@app.get("/health")
@app.get("/vault/health")
@app.get("/api/health")
@app.get("/vault/api/health")
async def health():
    try:
        stats = store.get_stats()
        return {
            "status": "ok",
            "service": "opai-vault",
            "secrets_loaded": stats["total_secrets"],
            "file_exists": stats["file_exists"],
        }
    except Exception as e:
        return {"status": "degraded", "service": "opai-vault", "error": str(e)}


# ── Service Endpoints (service-to-service) ────────────────
# These are the primary endpoints. Internal services call these
# to get their credentials at startup or runtime.

@app.get("/vault/api/service/{service_name}/env")
async def get_service_env(
    service_name: str,
    request: Request,
    user: AuthUser = Depends(require_admin),
):
    """Generate .env content for a service. Used by systemd ExecStartPre."""
    try:
        env_content = store.generate_env_file(service_name)
        caller = f"{user.email}" if user else "unknown"
        audit.log_access(
            action="generate_env",
            target=service_name,
            caller=caller,
            caller_ip=request.client.host if request.client else "",
        )
        return JSONResponse(
            content={"env": env_content, "service": service_name},
        )
    except Exception as e:
        audit.log_access(
            action="generate_env",
            target=service_name,
            caller="error",
            success=False,
            detail=str(e),
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/vault/api/service/{service_name}/secrets")
async def get_service_secrets(
    service_name: str,
    request: Request,
    user: AuthUser = Depends(require_admin),
):
    """Get all secrets for a service (merged shared + service-specific).

    Returns actual values — admin only.
    """
    try:
        secrets = store.get_service_secrets(service_name)
        audit.log_access(
            action="get",
            target=f"service:{service_name}",
            caller=user.email,
            caller_ip=request.client.host if request.client else "",
        )
        return {"service": service_name, "secrets": secrets}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Secret CRUD (admin only) ─────────────────────────────

@app.get("/vault/api/secrets")
async def list_all_secrets(
    request: Request,
    user: AuthUser = Depends(require_admin),
):
    """List all secret names (values masked). Safe for display."""
    audit.log_access(
        action="list",
        target="all",
        caller=user.email,
        caller_ip=request.client.host if request.client else "",
    )
    return store.list_secrets(include_values=False)


@app.get("/vault/api/secrets/{name}")
async def get_secret(
    name: str,
    request: Request,
    section: str = "credentials",
    user: AuthUser = Depends(require_admin),
):
    """Get a single secret by name. Admin only."""
    value = store.get_secret(name, section=section)
    if value is None:
        raise HTTPException(status_code=404, detail=f"Secret '{name}' not found")

    audit.log_access(
        action="get",
        target=name,
        caller=user.email,
        caller_ip=request.client.host if request.client else "",
    )
    return {"name": name, "value": value}


@app.put("/vault/api/secrets/{name}")
async def set_secret(
    name: str,
    request: Request,
    user: AuthUser = Depends(require_admin),
):
    """Create or update a secret. Admin only."""
    body = await request.json()
    value = body.get("value")
    section = body.get("section", "credentials")
    service = body.get("service")

    if value is None:
        raise HTTPException(status_code=400, detail="'value' is required")

    store.set_secret(name, str(value), section=section, service=service)
    audit.log_access(
        action="set",
        target=name,
        caller=user.email,
        caller_ip=request.client.host if request.client else "",
        detail=f"section={section}" + (f", service={service}" if service else ""),
    )
    return {"status": "ok", "name": name}


@app.delete("/vault/api/secrets/{name}")
async def delete_secret(
    name: str,
    request: Request,
    section: str = "credentials",
    service: str = None,
    user: AuthUser = Depends(require_admin),
):
    """Delete a secret. Admin only."""
    existed = store.delete_secret(name, section=section, service=service)
    if not existed:
        raise HTTPException(status_code=404, detail=f"Secret '{name}' not found")

    audit.log_access(
        action="delete",
        target=name,
        caller=user.email,
        caller_ip=request.client.host if request.client else "",
    )
    return {"status": "deleted", "name": name}


# ── Reload ────────────────────────────────────────────────

@app.post("/vault/api/reload")
async def reload_secrets(
    request: Request,
    user: AuthUser = Depends(require_admin),
):
    """Force reload secrets from encrypted file."""
    store.load_secrets(force=True)
    stats = store.get_stats()
    audit.log_access(
        action="reload",
        target="all",
        caller=user.email,
        caller_ip=request.client.host if request.client else "",
    )
    return {"status": "reloaded", "stats": stats}


# ── Stats ─────────────────────────────────────────────────

@app.get("/vault/api/stats")
async def vault_stats(user: AuthUser = Depends(require_admin)):
    """Vault statistics (no secret values)."""
    return {
        "vault": store.get_stats(),
        "audit": audit.get_stats(),
    }


# ── Audit Log ────────────────────────────────────────────

@app.get("/vault/api/audit")
async def get_audit_log(
    limit: int = 50,
    action: str = None,
    user: AuthUser = Depends(require_admin),
):
    """View recent audit log entries."""
    return {"entries": audit.get_recent(limit=limit, action_filter=action)}


# ── User Vault Auth Config ────────────────────────────────

@app.get("/vault/api/user/auth/config")
async def user_auth_config():
    """Return Supabase URL and anon key for user vault SPA."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── User Vault SPA ───────────────────────────────────────

@app.get("/vault/my/")
@app.get("/vault/my")
async def user_vault_spa():
    """Serve the standalone user vault SPA."""
    index = config.STATIC_DIR / "user-vault.html"
    if index.exists():
        return FileResponse(str(index), media_type="text/html")
    return HTMLResponse("<h1>User Vault UI not found</h1>", status_code=404)


# ── SPA Catch-all (Web UI) ────────────────────────────────

@app.get("/vault/")
@app.get("/vault")
async def vault_spa():
    """Serve the vault web UI SPA."""
    index = config.STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index), media_type="text/html")
    return HTMLResponse("<h1>Vault UI not found</h1><p>Static files missing.</p>", status_code=404)


# ── Run ───────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=True)
