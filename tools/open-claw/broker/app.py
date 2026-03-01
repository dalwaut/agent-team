"""OpenClaw Vault Broker — Credential mediation service for OC containers.

Port 8106, path /oc/

This service sits between OC containers and the OPAI Vault. It enforces
the access manifest: containers only receive credentials that have been
explicitly granted by an admin.

Security:
- Localhost-only (same as vault)
- Admin auth required for all manifest management
- Service auth for credential injection (called by provisioning scripts)
- Full audit trail in oc_credential_log
"""

import sys
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel
from typing import Optional

# Shared auth
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import get_current_user, require_admin, AuthUser

import config
import manifest
from manifest import ManifestError
import vault_bridge
import runtime
from routes_llm import router as llm_router
import clawhub


# ── Models ────────────────────────────────────────────────────

class InstanceCreate(BaseModel):
    slug: str
    display_name: str = "ClawBot"
    owner_id: Optional[str] = None
    tier: str = "internal"
    autonomy_level: int = 3
    workspace_mode: str = "local"  # "local" or "nas"
    nas_model: str = "a"  # "a" (internal workforce) or "b" (user-attached)
    owner_username: Optional[str] = None  # Model B: NAS user directory name
    config: dict = {}


class CredentialGrant(BaseModel):
    vault_key: str
    vault_section: str = "credentials"
    vault_service: Optional[str] = None
    scope: str = "inject"
    reason: Optional[str] = None
    expires_at: Optional[str] = None


class CredentialRevoke(BaseModel):
    vault_key: str
    vault_service: Optional[str] = None
    reason: Optional[str] = None


# ── Lifespan ──────────────────────────────────────────────────

async def _clawhub_sync_loop():
    """Background task: sync ClawHub catalog daily."""
    import asyncio
    while True:
        try:
            result = await clawhub.sync_catalog()
            print(f"[oc-broker] ClawHub sync: {result}")
        except Exception as e:
            print(f"[oc-broker] ClawHub sync error: {e}")
        await asyncio.sleep(86400)  # 24 hours


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    # Verify vault connection on startup
    vault_status = await vault_bridge.verify_vault_connection()
    if vault_status["status"] == "ok":
        print(f"[oc-broker] Vault connection OK")
    else:
        print(f"[oc-broker] WARNING: Vault status: {vault_status}")

    # Start ClawHub catalog sync (non-blocking)
    sync_task = asyncio.create_task(_clawhub_sync_loop())

    yield

    sync_task.cancel()
    try:
        await sync_task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="OpenClaw Vault Broker",
    version="1.0.0",
    docs_url="/oc/docs",
    openapi_url="/oc/openapi.json",
    lifespan=lifespan,
)


# ── Middleware: localhost-only ─────────────────────────────────

@app.middleware("http")
async def localhost_guard(request: Request, call_next):
    client_ip = request.client.host if request.client else "unknown"
    allowed = ("127.0.0.1", "::1", "localhost")
    # Allow: localhost, Tailscale (100.*), Docker bridge (172.*)
    if client_ip not in allowed and not client_ip.startswith("100.") and not client_ip.startswith("172."):
        return JSONResponse(
            status_code=403,
            content={"detail": "Broker is localhost-only"},
        )
    return await call_next(request)


# ── Health ────────────────────────────────────────────────────

@app.get("/health")
@app.get("/oc/health")
@app.get("/api/health")
@app.get("/oc/api/health")
async def health():
    vault_status = await vault_bridge.verify_vault_connection()
    return {
        "status": "ok" if vault_status["status"] == "ok" else "degraded",
        "service": "oc-broker",
        "vault": vault_status["status"],
    }


# ── Instance Management ──────────────────────────────────────

@app.get("/oc/api/instances")
async def list_instances(
    status: str = None,
    user: AuthUser = Depends(require_admin),
):
    """List all OC instances."""
    instances = await manifest.list_instances(status=status)
    return {"instances": instances}


@app.get("/oc/api/instances/{slug}")
async def get_instance(
    slug: str,
    user: AuthUser = Depends(require_admin),
):
    """Get a specific OC instance."""
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")
    return {"instance": instance}


@app.post("/oc/api/instances")
async def create_instance(
    body: InstanceCreate,
    user: AuthUser = Depends(require_admin),
):
    """Register a new OC instance."""
    # Merge workspace config into instance config
    inst_config = {**body.config}
    inst_config["workspace_mode"] = body.workspace_mode
    if body.workspace_mode == "nas":
        inst_config["nas_model"] = body.nas_model
        if body.nas_model == "b" and body.owner_username:
            inst_config["owner_username"] = body.owner_username

    instance = await manifest.create_instance(
        slug=body.slug,
        display_name=body.display_name,
        owner_id=body.owner_id,
        tier=body.tier,
        autonomy_level=body.autonomy_level,
        instance_config=inst_config,
    )
    if not instance:
        raise HTTPException(status_code=409, detail=f"Instance '{body.slug}' already exists or creation failed")
    return {"instance": instance}


@app.patch("/oc/api/instances/{slug}/status")
async def update_status(
    slug: str,
    request: Request,
    user: AuthUser = Depends(require_admin),
):
    """Update instance status."""
    body = await request.json()
    new_status = body.get("status")
    if new_status not in ("provisioning", "running", "stopped", "error", "archived"):
        raise HTTPException(status_code=400, detail="Invalid status")

    success = await manifest.update_instance_status(slug, new_status)
    if not success:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")
    return {"status": "ok", "slug": slug, "new_status": new_status}


# ── Access Manifest (Grant / Revoke) ─────────────────────────

@app.get("/oc/api/instances/{slug}/credentials")
async def list_credentials(
    slug: str,
    include_revoked: bool = False,
    user: AuthUser = Depends(require_admin),
):
    """List credential grants for an instance."""
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    if include_revoked:
        grants = await manifest.get_all_grants(instance["id"])
    else:
        grants = await manifest.get_active_grants(instance["id"])

    return {
        "instance": slug,
        "grants": grants,
        "active_count": len([g for g in grants if not g.get("revoked_at")]),
        "max_allowed": config.MAX_CREDENTIALS_PER_INSTANCE,
    }


@app.post("/oc/api/instances/{slug}/credentials")
async def grant_credential(
    slug: str,
    body: CredentialGrant,
    user: AuthUser = Depends(require_admin),
):
    """Grant a credential to an OC instance.

    This is the core safety gate: only credentials explicitly granted here
    will ever be injected into the container.

    The vault key must exist — we validate before granting to prevent typos.
    """
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    # Validate the vault key actually exists
    key_exists = await vault_bridge.validate_vault_key_exists(
        body.vault_key, body.vault_section, body.vault_service
    )
    if not key_exists:
        raise HTTPException(
            status_code=400,
            detail=f"Vault key '{body.vault_key}' not found in section '{body.vault_section}'"
                   + (f" service '{body.vault_service}'" if body.vault_service else ""),
        )

    # Service-role auth has id="service-role" (not a UUID) — skip FK ref
    granted_by = user.id if user.id != "service-role" else None

    try:
        grant = await manifest.grant_credential(
            instance_id=instance["id"],
            vault_key=body.vault_key,
            vault_section=body.vault_section,
            vault_service=body.vault_service,
            scope=body.scope,
            granted_by=granted_by,
            reason=body.reason,
            expires_at=body.expires_at,
        )
    except ManifestError as e:
        raise HTTPException(status_code=500, detail=str(e))

    if not grant:
        raise HTTPException(
            status_code=429,
            detail=f"Instance has reached the maximum of {config.MAX_CREDENTIALS_PER_INSTANCE} credentials",
        )

    return {"status": "granted", "grant": grant}


@app.delete("/oc/api/instances/{slug}/credentials")
async def revoke_credential(
    slug: str,
    body: CredentialRevoke,
    user: AuthUser = Depends(require_admin),
):
    """Revoke a credential from an OC instance."""
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    actor_id = user.id if user.id != "service-role" else None
    success = await manifest.revoke_credential(
        instance_id=instance["id"],
        vault_key=body.vault_key,
        vault_service=body.vault_service,
        revoked_by=actor_id,
        reason=body.reason,
    )

    if not success:
        raise HTTPException(status_code=404, detail=f"No active grant for '{body.vault_key}'")
    return {"status": "revoked", "vault_key": body.vault_key}


@app.post("/oc/api/instances/{slug}/kill-switch")
async def kill_switch(
    slug: str,
    user: AuthUser = Depends(require_admin),
):
    """Emergency kill switch: revoke ALL credentials for an instance.

    This immediately prevents the container from receiving any new credentials.
    A container restart is needed to actually remove already-injected env vars.
    """
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    actor_id = user.id if user.id != "service-role" else None
    revoked_count = await manifest.revoke_all_credentials(
        instance_id=instance["id"],
        revoked_by=actor_id,
        reason="Kill switch activated",
    )

    # Also set instance status to stopped
    await manifest.update_instance_status(slug, "stopped")

    return {
        "status": "killed",
        "slug": slug,
        "credentials_revoked": revoked_count,
        "instance_status": "stopped",
        "note": "Restart the container to clear already-injected env vars",
    }


# ── Credential Injection (used by provisioning scripts) ──────

@app.get("/oc/api/instances/{slug}/inject")
async def inject_credentials(
    slug: str,
    format: str = "env",
    user: AuthUser = Depends(require_admin),
):
    """Fetch all granted credentials for injection into a container.

    Returns credentials in the requested format:
    - env: KEY="value" pairs (for Docker --env-file or shell export)
    - json: {"KEY": "value"} dict

    This is called by the container startup script, NOT by the container itself.
    The container never calls this endpoint.
    """
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    if instance["status"] == "archived":
        raise HTTPException(status_code=403, detail="Instance is archived — cannot inject credentials")

    actor_id = user.id if user.id != "service-role" else None
    credentials = await vault_bridge.fetch_instance_credentials(
        instance_id=instance["id"],
        instance_slug=slug,
        actor_id=actor_id,
    )

    if format == "json":
        return {"credentials": credentials, "count": len(credentials)}

    # Default: env format
    lines = []
    for key, value in sorted(credentials.items()):
        escaped = str(value).replace('"', '\\"')
        lines.append(f'{key}="{escaped}"')

    return PlainTextResponse(
        content="\n".join(lines) + "\n",
        media_type="text/plain",
    )


# ── Audit Log ─────────────────────────────────────────────────

@app.get("/oc/api/audit")
async def get_audit_log(
    instance_slug: str = None,
    action: str = None,
    limit: int = 50,
    user: AuthUser = Depends(require_admin),
):
    """View credential access audit log."""
    instance_id = None
    if instance_slug:
        instance = await manifest.get_instance(instance_slug)
        if instance:
            instance_id = instance["id"]

    entries = await manifest.get_credential_log(
        instance_id=instance_id,
        action=action,
        limit=limit,
    )
    return {"entries": entries}


# ── Vault Status ──────────────────────────────────────────────

@app.get("/oc/api/vault-status")
async def vault_status(user: AuthUser = Depends(require_admin)):
    """Check vault connection status from the broker's perspective."""
    return await vault_bridge.verify_vault_connection()


# ── Container Runtime (Lifecycle) ────────────────────────────

@app.post("/oc/api/instances/{slug}/provision")
async def provision_instance(
    slug: str,
    user: AuthUser = Depends(require_admin),
):
    """Provision and start an OC container.

    Full flow: allocate port → create dirs → generate compose → inject creds → start → health check.
    The instance must already exist in the DB (created via POST /oc/api/instances).
    """
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    if instance["status"] == "running":
        raise HTTPException(status_code=409, detail=f"Instance '{slug}' is already running")

    if instance["status"] == "archived":
        raise HTTPException(status_code=410, detail=f"Instance '{slug}' is archived")

    try:
        result = await runtime.provision(
            slug=slug,
            display_name=instance["display_name"],
            instance_config=instance.get("config", {}),
        )
        return result
    except RuntimeError as e:
        await manifest.update_instance_status(slug, "error")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/oc/api/instances/{slug}/start")
async def start_instance(
    slug: str,
    user: AuthUser = Depends(require_admin),
):
    """Start a stopped OC container (re-injects fresh credentials)."""
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    if instance["status"] == "archived":
        raise HTTPException(status_code=410, detail=f"Instance '{slug}' is archived")

    try:
        result = await runtime.start(slug)
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/oc/api/instances/{slug}/stop")
async def stop_instance(
    slug: str,
    user: AuthUser = Depends(require_admin),
):
    """Stop a running OC container gracefully."""
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    try:
        result = await runtime.stop(slug)
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/oc/api/instances/{slug}/restart")
async def restart_instance(
    slug: str,
    user: AuthUser = Depends(require_admin),
):
    """Restart an OC container (stop + fresh credential injection + start)."""
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    try:
        result = await runtime.restart(slug)
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/oc/api/instances/{slug}")
async def destroy_instance(
    slug: str,
    purge_nas: bool = False,
    user: AuthUser = Depends(require_admin),
):
    """Fully destroy an OC instance: stop container, clean dirs, release port, archive in DB.

    Set purge_nas=true to also delete NAS workspace data (memory, reports, etc.).
    Default preserves NAS data so it can be re-attached to a new instance.
    """
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    try:
        result = await runtime.destroy(slug, purge_nas=purge_nas)
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Container Status & Monitoring ────────────────────────────

@app.get("/oc/api/instances/{slug}/runtime")
async def instance_runtime_status(
    slug: str,
    user: AuthUser = Depends(require_admin),
):
    """Get detailed runtime status for an instance (container, port, health, resources)."""
    status = await runtime.get_instance_status(slug)
    if "error" in status:
        raise HTTPException(status_code=404, detail=status["error"])
    return status


@app.get("/oc/api/instances/{slug}/logs")
async def instance_logs(
    slug: str,
    lines: int = 50,
    user: AuthUser = Depends(require_admin),
):
    """Get recent container logs."""
    instance = await manifest.get_instance(slug)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Instance '{slug}' not found")

    logs = runtime.get_container_logs(slug, lines=lines)
    return PlainTextResponse(content=logs, media_type="text/plain")


@app.get("/oc/api/runtime/overview")
async def runtime_overview(user: AuthUser = Depends(require_admin)):
    """Get status overview for all non-archived instances."""
    statuses = await runtime.list_all_status()
    ports = runtime.list_port_allocations()
    return {
        "instances": statuses,
        "total": len(statuses),
        "running": len([s for s in statuses if s.get("container_running")]),
        "port_allocations": ports,
        "port_range": list(config.CONTAINER_PORT_RANGE),
    }


# ── NAS Workspace Info ────────────────────────────────────────

@app.get("/oc/api/nas/status")
async def nas_status(user: AuthUser = Depends(require_admin)):
    """Get NAS workspace status: directory structure, bot homes, shared drive."""
    import os

    nas_root = config.NAS_USERS_ROOT
    result = {
        "nas_mounted": nas_root.is_dir(),
        "nas_path": str(nas_root),
    }

    if not nas_root.is_dir():
        result["error"] = "NAS not mounted"
        return result

    # Check free space
    try:
        stat = os.statvfs(str(nas_root))
        result["total_gb"] = round((stat.f_blocks * stat.f_frsize) / (1024**3), 1)
        result["free_gb"] = round((stat.f_bavail * stat.f_frsize) / (1024**3), 1)
        result["used_pct"] = round(100 - (stat.f_bavail / stat.f_blocks * 100), 1)
    except OSError:
        pass

    # List bot homes
    bots_dir = config.NAS_CLAWBOTS_DIR
    bot_homes = []
    if bots_dir.is_dir():
        for d in sorted(bots_dir.iterdir()):
            if d.is_dir() and not d.name.startswith("."):
                identity_file = d / ".opai-bot.json"
                identity = {}
                if identity_file.is_file():
                    try:
                        import json
                        identity = json.loads(identity_file.read_text())
                    except Exception:
                        pass
                bot_homes.append({
                    "slug": d.name,
                    "path": str(d),
                    "role": identity.get("role", "unknown"),
                    "created_at": identity.get("created_at"),
                })
    result["bot_homes"] = bot_homes

    # List shared drive contents
    shared_dir = config.NAS_SHARED_DIR
    if shared_dir.is_dir():
        shared = {}
        for subdir in ("reports", "inbox", "delegation", "knowledge"):
            sd = shared_dir / subdir
            if sd.is_dir():
                shared[subdir] = len(list(sd.iterdir()))
        result["shared_drive"] = shared

    # List user sandboxes (Model B targets)
    users = []
    for d in sorted(nas_root.iterdir()):
        if d.is_dir() and not d.name.startswith(("_", ".", "#")):
            users.append(d.name)
    result["user_sandboxes"] = users

    return result


# ── ClawHub Marketplace ──────────────────────────────────────

class HubInstall(BaseModel):
    slug: str
    target_type: str  # 'oc_instance' or 'claude_code'
    instance_slug: Optional[str] = None


class HubUninstall(BaseModel):
    slug: str
    target_type: str
    instance_slug: Optional[str] = None


@app.get("/oc/api/hub/catalog")
async def hub_catalog(
    category: str = None,
    search: str = None,
    claude_compat: str = None,
    limit: int = 50,
    user: AuthUser = Depends(require_admin),
):
    """List skills from the cached ClawHub catalog."""
    skills = await clawhub.list_skills(
        category=category, search=search,
        claude_compat=claude_compat, limit=limit,
    )
    return {"skills": skills, "count": len(skills)}


@app.post("/oc/api/hub/sync")
async def hub_sync(user: AuthUser = Depends(require_admin)):
    """Trigger a manual catalog refresh from ClawHub."""
    result = await clawhub.sync_catalog()
    return result


@app.get("/oc/api/hub/skills/{slug}")
async def hub_skill_detail(slug: str, user: AuthUser = Depends(require_admin)):
    """Get full details for a single skill."""
    skill = await clawhub.get_skill(slug)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{slug}' not found")
    # Also fetch installations for this skill
    installations = await clawhub.list_installations(target_type=None)
    skill_installs = [i for i in installations if i.get("skill_slug") == slug]
    return {"skill": skill, "installations": skill_installs}


@app.post("/oc/api/hub/install")
async def hub_install(body: HubInstall, user: AuthUser = Depends(require_admin)):
    """Install a skill to an OC instance or Claude Code."""
    actor_id = user.id if user.id != "service-role" else None
    result = await clawhub.install_skill(
        slug=body.slug,
        target_type=body.target_type,
        instance_slug=body.instance_slug,
        installed_by=actor_id,
    )
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.delete("/oc/api/hub/install")
async def hub_uninstall(body: HubUninstall, user: AuthUser = Depends(require_admin)):
    """Uninstall a skill from an OC instance or Claude Code."""
    result = await clawhub.uninstall_skill(
        slug=body.slug,
        target_type=body.target_type,
        instance_slug=body.instance_slug,
    )
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.get("/oc/api/hub/installations")
async def hub_installations(
    instance_slug: str = None,
    target_type: str = None,
    limit: int = 100,
    user: AuthUser = Depends(require_admin),
):
    """List skill installations, optionally filtered."""
    installs = await clawhub.list_installations(
        instance_slug=instance_slug,
        target_type=target_type,
        limit=limit,
    )
    return {"installations": installs, "count": len(installs)}


# ── LLM Proxy Router ──────────────────────────────────────────

app.include_router(llm_router)


# ── Run ───────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=True)
