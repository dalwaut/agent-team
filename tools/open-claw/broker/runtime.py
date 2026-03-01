"""OpenClaw Container Runtime — Provisions, starts, stops, and manages OC containers.

This module handles the full container lifecycle:
  provision → inject credentials → start → monitor → stop → destroy

It uses Docker directly (subprocess calls) rather than the Docker SDK to keep
dependencies minimal and debugging transparent.
"""

import asyncio
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import config
import manifest
from container_auth import generate_callback_token, hash_token


# ── NAS Workspace Helpers ────────────────────────────────────

def _resolve_nas_paths(slug: str, instance_config: dict) -> dict:
    """Resolve NAS storage paths based on workspace mode and model.

    Returns a dict with resolved paths for config, knowledge, workspace, logs,
    and any shared mounts. Paths are host-side (NFS mount points).
    """
    mode = instance_config.get("workspace_mode", "local")
    if mode != "nas":
        return {}

    nas_model = instance_config.get("nas_model", "a")

    if nas_model == "a":
        # Model A: Internal workforce — bot gets own home in _clawbots/
        bot_home = config.NAS_CLAWBOTS_DIR / slug
        return {
            "bot_home": str(bot_home),
            "config_dir": str(bot_home / "config"),
            "knowledge_dir": str(bot_home / "knowledge"),
            "workspace_dir": str(bot_home / "workspace"),
            "logs_dir": str(bot_home / "logs"),
            "shared_knowledge": str(config.NAS_SHARED_DIR / "knowledge"),
            "shared_inbox": str(config.NAS_SHARED_DIR / "inbox" / slug),
            "shared_delegation": str(config.NAS_SHARED_DIR / "delegation" / slug),
            "shared_reports": str(config.NAS_SHARED_DIR / "reports"),
        }

    elif nas_model == "b":
        # Model B: User-attached — bot works in user's sandbox
        owner = instance_config.get("owner_username", "")
        if not owner:
            raise RuntimeError("NAS Model B requires owner_username in instance config")

        user_dir = config.NAS_USERS_ROOT / owner
        if not user_dir.is_dir():
            raise RuntimeError(f"User directory not found: {user_dir}")

        # Bot's private state lives in user's bots/ subdirectory
        bot_state = user_dir / "bots" / slug
        return {
            "bot_home": str(bot_state),
            "config_dir": str(bot_state / "config"),
            "knowledge_dir": str(user_dir / "wiki"),        # user's wiki = bot's knowledge
            "workspace_dir": str(user_dir / "files"),       # user's files = bot's workspace
            "logs_dir": str(bot_state / "logs"),
            "memory_dir": str(bot_state / "memory"),        # separate from workspace
            "ralph_dir": str(bot_state / "ralph"),           # separate from workspace
        }

    return {}


def _create_nas_dirs(slug: str, nas_paths: dict, instance_config: dict):
    """Create the NAS directory structure for an instance."""
    nas_model = instance_config.get("nas_model", "a")

    if nas_model == "a":
        # Create bot home directories
        for key in ("config_dir", "knowledge_dir", "workspace_dir", "logs_dir"):
            Path(nas_paths[key]).mkdir(parents=True, exist_ok=True)

        # Create workspace subdirectories
        ws = Path(nas_paths["workspace_dir"])
        (ws / "memory").mkdir(exist_ok=True)
        (ws / "ralph").mkdir(exist_ok=True)
        (ws / "output").mkdir(exist_ok=True)

        # Create shared directories for this bot
        for key in ("shared_inbox", "shared_delegation"):
            if key in nas_paths:
                Path(nas_paths[key]).mkdir(parents=True, exist_ok=True)

        # Write bot identity file
        identity = {
            "slug": slug,
            "role": "manager" if "manager" in slug else "worker",
            "model": nas_model,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        identity_path = Path(nas_paths["bot_home"]) / ".opai-bot.json"
        identity_path.write_text(json.dumps(identity, indent=2) + "\n")

    elif nas_model == "b":
        # Create bot state directories (don't touch user's existing files/wiki)
        for key in ("config_dir", "logs_dir", "memory_dir", "ralph_dir"):
            if key in nas_paths:
                Path(nas_paths[key]).mkdir(parents=True, exist_ok=True)

        # Write bot identity in bot state dir
        identity = {
            "slug": slug,
            "role": "user-attached",
            "model": nas_model,
            "owner": instance_config.get("owner_username", ""),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        identity_path = Path(nas_paths["bot_home"]) / ".opai-bot.json"
        identity_path.write_text(json.dumps(identity, indent=2) + "\n")


def _generate_nas_compose(
    slug: str,
    port: int,
    display_name: str,
    callback_token: str,
    env_path: str,
    nas_paths: dict,
    instance_config: dict,
) -> str:
    """Generate a docker-compose.yml for NAS-backed instances.

    Instead of using the template (which mounts local dirs), this builds
    the compose YAML with NAS volume mounts.
    """
    nas_model = instance_config.get("nas_model", "a")

    # Build volume mounts based on model
    volumes = []

    if nas_model == "a":
        volumes = [
            f"      - {nas_paths['config_dir']}:/app/config:ro",
            f"      - {nas_paths['knowledge_dir']}:/app/knowledge:ro",
            f"      - {nas_paths['workspace_dir']}:/app/workspace",
            f"      - {nas_paths['logs_dir']}:/app/logs",
        ]
        # Mount shared knowledge as secondary read-only source
        if "shared_knowledge" in nas_paths:
            volumes.append(f"      - {nas_paths['shared_knowledge']}:/app/shared-knowledge:ro")
        # Mount shared inbox/delegation for cross-bot messaging
        if "shared_inbox" in nas_paths:
            volumes.append(f"      - {nas_paths['shared_inbox']}:/app/inbox")
        if "shared_delegation" in nas_paths:
            volumes.append(f"      - {nas_paths['shared_delegation']}:/app/delegation")
        if "shared_reports" in nas_paths:
            volumes.append(f"      - {nas_paths['shared_reports']}:/app/reports")

    elif nas_model == "b":
        volumes = [
            f"      - {nas_paths['config_dir']}:/app/config:ro",
            f"      - {nas_paths['knowledge_dir']}:/app/knowledge:ro",
            f"      - {nas_paths['workspace_dir']}:/app/workspace",
            f"      - {nas_paths['logs_dir']}:/app/logs",
        ]
        # Override memory and ralph to bot-private locations
        if "memory_dir" in nas_paths:
            volumes.append(f"      - {nas_paths['memory_dir']}:/app/workspace/memory")
        if "ralph_dir" in nas_paths:
            volumes.append(f"      - {nas_paths['ralph_dir']}:/app/workspace/ralph")

    volumes_block = "\n".join(volumes)

    return f"""version: "3.8"
services:
  clawbot:
    image: opai/clawbot:latest
    container_name: clawbot-{slug}
    restart: unless-stopped
    env_file:
      - {env_path}
    environment:
      - BOT_NAME={display_name}
      - INSTANCE_SLUG={slug}
      - LOG_LEVEL=info
      - OC_BROKER_URL=http://host.docker.internal:8106
      - OC_CALLBACK_TOKEN={callback_token}
      - OC_WORKSPACE_MODE=nas
      - OC_NAS_MODEL={nas_model}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "127.0.0.1:{port}:3000"
    volumes:
{volumes_block}
    read_only: true
    tmpfs:
      - /tmp:size=100M
      - /app/tmp:size=50M
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 512m
    memswap_limit: 512m
    cpus: 0.5
    pids_limit: 100
    networks:
      - opai-claw
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    labels:
      - "opai.service=clawbot"
      - "opai.instance={slug}"
      - "opai.managed=true"
      - "opai.workspace=nas"
      - "opai.nas_model={nas_model}"
    dns:
      - 1.1.1.1
      - 8.8.8.8

networks:
  opai-claw:
    external: true
"""


def ensure_nas_shared_dirs():
    """Create the shared directory structure on the NAS (idempotent)."""
    shared = config.NAS_SHARED_DIR
    for subdir in ("reports", "inbox", "delegation", "knowledge"):
        (shared / subdir).mkdir(parents=True, exist_ok=True)

    # Ensure _clawbots root exists
    config.NAS_CLAWBOTS_DIR.mkdir(parents=True, exist_ok=True)


# ── Port Allocation ──────────────────────────────────────────

PORTS_FILE = config.INSTANCES_DIR / ".ports.json"


def _load_port_map() -> dict[str, int]:
    """Load the slug→port allocation map."""
    if PORTS_FILE.exists():
        try:
            return json.loads(PORTS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_port_map(port_map: dict[str, int]):
    """Persist the port allocation map."""
    PORTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    PORTS_FILE.write_text(json.dumps(port_map, indent=2) + "\n")


def allocate_port(slug: str) -> int:
    """Allocate a port from the 9001-9099 range for an instance.

    Returns the assigned port. Raises RuntimeError if range exhausted.
    """
    port_map = _load_port_map()

    # If already allocated, return existing
    if slug in port_map:
        return port_map[slug]

    used_ports = set(port_map.values())
    low, high = config.CONTAINER_PORT_RANGE

    for port in range(low, high + 1):
        if port not in used_ports:
            port_map[slug] = port
            _save_port_map(port_map)
            return port

    raise RuntimeError(
        f"Port range {low}-{high} exhausted ({len(used_ports)} instances allocated)"
    )


def release_port(slug: str):
    """Release a port allocation when an instance is destroyed."""
    port_map = _load_port_map()
    if slug in port_map:
        del port_map[slug]
        _save_port_map(port_map)


def get_port(slug: str) -> Optional[int]:
    """Get the allocated port for an instance, or None."""
    return _load_port_map().get(slug)


def list_port_allocations() -> dict[str, int]:
    """Return all current port allocations."""
    return _load_port_map()


# ── Docker Helpers ───────────────────────────────────────────

def _run_docker(args: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    """Run a docker command and return the result."""
    cmd = ["docker"] + args
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _run_compose(compose_file: str, project: str, args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    """Run a docker-compose command (v1 standalone binary)."""
    cmd = ["docker-compose", "-f", compose_file, "-p", project] + args
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _container_name(slug: str) -> str:
    return f"clawbot-{slug}"


def container_exists(slug: str) -> bool:
    """Check if a container exists (running or stopped)."""
    result = _run_docker(["ps", "-a", "--filter", f"name=^{_container_name(slug)}$", "--format", "{{.Names}}"])
    return _container_name(slug) in result.stdout


def container_running(slug: str) -> bool:
    """Check if a container is currently running."""
    result = _run_docker(["ps", "--filter", f"name=^{_container_name(slug)}$", "--format", "{{.Names}}"])
    return _container_name(slug) in result.stdout


def get_container_stats(slug: str) -> Optional[dict]:
    """Get resource usage stats for a running container."""
    name = _container_name(slug)
    result = _run_docker([
        "stats", name, "--no-stream",
        "--format", '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","pids":"{{.PIDs}}","net":"{{.NetIO}}"}',
    ])
    if result.returncode == 0 and result.stdout.strip():
        try:
            return json.loads(result.stdout.strip())
        except json.JSONDecodeError:
            pass
    return None


def get_container_health(slug: str) -> Optional[str]:
    """Get the health status of a container (healthy/unhealthy/starting/none)."""
    result = _run_docker([
        "inspect", _container_name(slug),
        "--format", "{{.State.Health.Status}}",
    ])
    if result.returncode == 0:
        status = result.stdout.strip()
        return status if status else None
    return None


def get_container_logs(slug: str, lines: int = 50) -> str:
    """Get recent container logs."""
    result = _run_docker(["logs", _container_name(slug), "--tail", str(lines)], timeout=10)
    return result.stdout + result.stderr


# ── Network Helpers ──────────────────────────────────────────

def ensure_network():
    """Ensure the opai-claw Docker network exists."""
    result = _run_docker(["network", "inspect", config.DOCKER_NETWORK])
    if result.returncode != 0:
        result = _run_docker(["network", "create", config.DOCKER_NETWORK, "--driver", "bridge"])
        if result.returncode != 0:
            raise RuntimeError(f"Failed to create network {config.DOCKER_NETWORK}: {result.stderr}")


# ── Instance Directory ───────────────────────────────────────

def _instance_dir(slug: str) -> Path:
    return config.INSTANCES_DIR / slug


def create_instance_dirs(slug: str, instance_config: dict = None):
    """Create the instance directory structure with initial config."""
    base = _instance_dir(slug)
    for subdir in ("config", "knowledge", "logs", "workspace"):
        (base / subdir).mkdir(parents=True, exist_ok=True)

    # Write instance config
    conf = {
        "slug": slug,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "autonomy_level": 3,
        "personality": "default",
        "model": "haiku",
    }
    if instance_config:
        conf.update(instance_config)

    (base / "config" / "instance.json").write_text(json.dumps(conf, indent=2) + "\n")


def destroy_instance_dirs(slug: str):
    """Remove the instance directory entirely."""
    base = _instance_dir(slug)
    if base.exists():
        shutil.rmtree(base)


# ── Credential Injection ────────────────────────────────────

def _env_file_path(slug: str) -> Path:
    """Path to the tmpfs env file for a container."""
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    return Path(runtime_dir) / "opai-oc" / f"{slug}.env"


async def inject_credentials(slug: str) -> bool:
    """Run the inject-credentials.sh script for an instance.

    Returns True on success. The script fetches credentials from the broker
    and writes them to tmpfs.
    """
    script = config.TOOLS_DIR / "open-claw" / "scripts" / "inject-credentials.sh"
    env_path = _env_file_path(slug)

    # Ensure the env dir exists
    env_path.parent.mkdir(parents=True, exist_ok=True)

    # Build env for the script (needs SUPABASE_SERVICE_KEY)
    env = os.environ.copy()
    env["SUPABASE_SERVICE_KEY"] = config.SUPABASE_SERVICE_KEY

    proc = await asyncio.create_subprocess_exec(
        str(script), slug, str(env_path),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(
            f"Credential injection failed (exit {proc.returncode}): "
            f"{stderr.decode().strip() or stdout.decode().strip()}"
        )
    return True


def clean_credentials(slug: str):
    """Remove the tmpfs env file for an instance."""
    env_path = _env_file_path(slug)
    if env_path.exists():
        env_path.unlink()


# ── Container Lifecycle ──────────────────────────────────────

async def provision(
    slug: str,
    display_name: str = "ClawBot",
    instance_config: dict = None,
) -> dict:
    """Provision a new OC container instance.

    Full flow:
    1. Allocate port
    2. Resolve workspace paths (local or NAS)
    3. Create instance directories
    4. Generate docker-compose.yml
    5. Inject credentials (via broker → vault)
    6. Start the container
    7. Wait for health check
    8. Update DB status to running

    Returns a status dict with port, container name, etc.
    """
    inst_config = instance_config or {}
    workspace_mode = inst_config.get("workspace_mode", "local")

    # Ensure network exists
    ensure_network()

    # Allocate port
    port = allocate_port(slug)

    # Generate callback token for container→broker auth
    callback_token = generate_callback_token(slug)
    token_hash = hash_token(callback_token)
    inst_config["callback_token_hash"] = token_hash

    instance_dir = _instance_dir(slug)
    env_path = _env_file_path(slug)

    if workspace_mode == "nas":
        # NAS-backed workspace
        nas_paths = _resolve_nas_paths(slug, inst_config)
        if not nas_paths:
            raise RuntimeError("Failed to resolve NAS paths — check workspace_mode and nas_model config")

        # Create NAS directory structure
        ensure_nas_shared_dirs()
        _create_nas_dirs(slug, nas_paths, inst_config)

        # Write instance config to NAS config dir
        conf = {
            "slug": slug,
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "autonomy_level": inst_config.get("autonomy_level", 3),
            "personality": inst_config.get("personality", "default"),
            "model": inst_config.get("model", "haiku"),
            "workspace_mode": "nas",
            "nas_model": inst_config.get("nas_model", "a"),
        }
        config_path = Path(nas_paths["config_dir"]) / "instance.json"
        config_path.write_text(json.dumps(conf, indent=2) + "\n")

        # Still need a local instance dir for docker-compose.yml
        instance_dir.mkdir(parents=True, exist_ok=True)

        # Generate NAS-specific compose file
        compose_content = _generate_nas_compose(
            slug=slug,
            port=port,
            display_name=display_name,
            callback_token=callback_token,
            env_path=str(env_path),
            nas_paths=nas_paths,
            instance_config=inst_config,
        )

        # Store NAS path in DB config for later reference
        inst_config["nas_path"] = nas_paths.get("bot_home", "")

    else:
        # Local workspace (original behavior)
        create_instance_dirs(slug, inst_config)

        # Generate docker-compose.yml from template
        template_path = config.TOOLS_DIR / "open-claw" / "templates" / "docker-compose.instance.yml"
        template = template_path.read_text()

        # Replace env_file path FIRST (before ${SLUG} gets substituted inside it)
        compose_content = template.replace(
            "${OC_ENV_FILE:-/run/user/1000/opai-oc/${SLUG}.env}", str(env_path)
        )
        compose_content = (
            compose_content
            .replace("${SLUG}", slug)
            .replace("${HOST_PORT}", str(port))
            .replace("${BOT_NAME}", display_name)
            .replace("${OC_CALLBACK_TOKEN}", callback_token)
        )

    # Store config in Supabase
    await manifest.update_instance_config(slug, inst_config)

    # Write docker-compose.yml
    compose_path = instance_dir / "docker-compose.yml"
    compose_path.write_text(compose_content)

    # Inject credentials (broker fetches from vault, writes to tmpfs)
    try:
        await inject_credentials(slug)
    except RuntimeError:
        # If injection fails, still start — some instances may have 0 credentials
        pass

    # Ensure env file exists (even if empty — Docker needs it)
    if not env_path.exists():
        env_path.parent.mkdir(parents=True, exist_ok=True)
        env_path.write_text("# No credentials granted yet\n")
        env_path.chmod(0o600)

    # Start the container
    result = _run_compose(str(compose_path), f"oc-{slug}", ["up", "-d"])

    if result.returncode != 0:
        # Clean up on failure
        raise RuntimeError(f"Container start failed: {result.stderr.strip()}")

    # Wait for health (up to 30 seconds)
    healthy = await _wait_for_health(slug, timeout=30)

    # Update DB status
    new_status = "running" if healthy else "error"
    await manifest.update_instance_status(slug, new_status)

    result_dict = {
        "slug": slug,
        "container": _container_name(slug),
        "port": port,
        "status": new_status,
        "healthy": healthy,
        "env_file": str(env_path),
        "instance_dir": str(instance_dir),
        "workspace_mode": workspace_mode,
    }

    if workspace_mode == "nas":
        result_dict["nas_path"] = inst_config.get("nas_path", "")

    return result_dict


async def _wait_for_health(slug: str, timeout: int = 30) -> bool:
    """Poll container health until healthy or timeout."""
    import httpx

    port = get_port(slug)
    if not port:
        return False

    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                resp = await client.get(f"http://127.0.0.1:{port}/health")
                if resp.status_code == 200:
                    return True
        except Exception:
            pass
        await asyncio.sleep(2)
    return False


async def start(slug: str) -> dict:
    """Start an existing (stopped) container. Re-injects credentials."""
    instance_dir = _instance_dir(slug)
    compose_path = instance_dir / "docker-compose.yml"

    if not compose_path.exists():
        raise RuntimeError(f"Instance '{slug}' not provisioned (no docker-compose.yml)")

    # Re-inject credentials (they may have changed since last start)
    try:
        await inject_credentials(slug)
    except RuntimeError:
        pass

    # Ensure env file exists
    env_path = _env_file_path(slug)
    if not env_path.exists():
        env_path.parent.mkdir(parents=True, exist_ok=True)
        env_path.write_text("# No credentials granted yet\n")
        env_path.chmod(0o600)

    result = _run_compose(str(compose_path), f"oc-{slug}", ["up", "-d"])

    if result.returncode != 0:
        raise RuntimeError(f"Container start failed: {result.stderr.strip()}")

    healthy = await _wait_for_health(slug, timeout=30)
    new_status = "running" if healthy else "error"
    await manifest.update_instance_status(slug, new_status)

    return {"slug": slug, "status": new_status, "healthy": healthy}


async def stop(slug: str) -> dict:
    """Stop a running container gracefully."""
    instance_dir = _instance_dir(slug)
    compose_path = instance_dir / "docker-compose.yml"

    if compose_path.exists():
        result = _run_compose(str(compose_path), f"oc-{slug}", ["down"], timeout=30)
    else:
        # Fallback: stop by container name
        result = _run_docker(["stop", _container_name(slug), "--time", "10"], timeout=20)

    await manifest.update_instance_status(slug, "stopped")
    return {"slug": slug, "status": "stopped"}


async def restart(slug: str) -> dict:
    """Restart a container (stop + start with fresh credential injection)."""
    await stop(slug)
    return await start(slug)


async def destroy(slug: str, purge_nas: bool = False) -> dict:
    """Fully destroy an instance: stop container, clean up dirs, release port, archive in DB.

    Args:
        purge_nas: If True, also delete NAS workspace data. Default False to
                   preserve memory/reports on the NAS (can be re-attached later).
    """
    # Check workspace mode before destroying local dirs
    instance = await manifest.get_instance(slug)
    workspace_mode = "local"
    nas_path = None
    if instance and instance.get("config"):
        ic = instance["config"] if isinstance(instance["config"], dict) else {}
        workspace_mode = ic.get("workspace_mode", "local")
        nas_path = ic.get("nas_path")

    # Stop container if running
    try:
        await stop(slug)
    except Exception:
        pass

    # Remove container entirely
    _run_docker(["rm", "-f", _container_name(slug)])

    # Clean credentials from tmpfs
    clean_credentials(slug)

    # Remove local instance directory (always — just has docker-compose.yml)
    destroy_instance_dirs(slug)

    # Optionally purge NAS data
    nas_purged = False
    if purge_nas and workspace_mode == "nas" and nas_path:
        nas_dir = Path(nas_path)
        if nas_dir.is_dir():
            shutil.rmtree(nas_dir)
            nas_purged = True

    # Release port
    release_port(slug)

    # Mark archived in DB
    await manifest.update_instance_status(slug, "archived")

    return {
        "slug": slug,
        "status": "archived",
        "destroyed": True,
        "workspace_mode": workspace_mode,
        "nas_data_preserved": workspace_mode == "nas" and not nas_purged,
    }


# ── Status & Monitoring ──────────────────────────────────────

async def get_instance_status(slug: str) -> dict:
    """Get comprehensive status for an instance."""
    instance = await manifest.get_instance(slug)
    if not instance:
        return {"error": f"Instance '{slug}' not found"}

    port = get_port(slug)
    running = container_running(slug)
    exists = container_exists(slug)

    result = {
        "slug": slug,
        "db_status": instance["status"],
        "container_exists": exists,
        "container_running": running,
        "port": port,
        "display_name": instance["display_name"],
        "tier": instance["tier"],
        "autonomy_level": instance["autonomy_level"],
    }

    # Workspace info
    ic = instance.get("config", {})
    if isinstance(ic, dict):
        result["workspace_mode"] = ic.get("workspace_mode", "local")
        if ic.get("workspace_mode") == "nas":
            result["nas_model"] = ic.get("nas_model", "a")
            result["nas_path"] = ic.get("nas_path", "")

    if running:
        result["health"] = get_container_health(slug)
        stats = get_container_stats(slug)
        if stats:
            result["resources"] = stats

    credentials = await manifest.get_active_grants(instance["id"])
    result["active_credentials"] = len(credentials)

    return result


async def list_all_status() -> list[dict]:
    """Get status for all instances."""
    instances = await manifest.list_instances()
    statuses = []
    for inst in instances:
        if inst["status"] != "archived":
            status = await get_instance_status(inst["slug"])
            statuses.append(status)
    return statuses
