"""OPAI Vault — Encrypted secret store backed by SOPS + age.

Secrets are stored in a SOPS-encrypted YAML file. Structure:
    services:
        opai-billing:
            STRIPE_SECRET_KEY: sk_live_...
            STRIPE_WEBHOOK_SECRET: whsec_...
        opai-helm:
            HOSTINGER_API_KEY: ...
        discord-bridge:
            DISCORD_BOT_TOKEN: ...
    shared:
        SUPABASE_URL: https://...
        SUPABASE_SERVICE_KEY: ...
        SUPABASE_JWT_SECRET: ...
    credentials:
        stripe-boutabyte-live: sk_live_...
        hostinger-ssh-password: ...
"""

import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import yaml

import config


# ── In-memory cache (decrypted) ──────────────────────────
_secrets_cache: dict = {}
_cache_loaded: bool = False


def _run_sops(args: list[str], input_data: str = None) -> tuple[int, str, str]:
    """Run a SOPS command, returning (returncode, stdout, stderr)."""
    env = os.environ.copy()
    env["SOPS_AGE_KEY_FILE"] = str(config.VAULT_KEY_FILE)
    cmd = [config.SOPS_BIN] + args
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=env,
        input=input_data,
        timeout=30,
    )
    return result.returncode, result.stdout, result.stderr


def _ensure_secrets_file() -> Path:
    """Create the encrypted secrets file if it doesn't exist."""
    path = config.SECRETS_FILE
    if path.exists():
        return path

    # Bootstrap with empty structure
    initial = {
        "services": {},
        "shared": {},
        "credentials": {},
    }
    path.parent.mkdir(parents=True, exist_ok=True)

    # Write plaintext, then encrypt in place
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".yaml", dir=str(path.parent), delete=False
    ) as f:
        yaml.dump(initial, f, default_flow_style=False)
        tmp_path = f.name

    rc, out, err = _run_sops([
        "--encrypt",
        "--age", config.AGE_PUBLIC_KEY,
        "--input-type", "yaml",
        "--output-type", "yaml",
        "--output", str(path),
        tmp_path,
    ])
    os.unlink(tmp_path)

    if rc != 0:
        raise RuntimeError(f"SOPS encrypt failed: {err}")
    return path


def load_secrets(force: bool = False) -> dict:
    """Decrypt and load all secrets into memory. Cached until force=True."""
    global _secrets_cache, _cache_loaded

    if _cache_loaded and not force:
        return _secrets_cache

    path = _ensure_secrets_file()
    rc, out, err = _run_sops(["--decrypt", str(path)])
    if rc != 0:
        raise RuntimeError(f"SOPS decrypt failed: {err}")

    _secrets_cache = yaml.safe_load(out) or {}
    _cache_loaded = True
    return _secrets_cache


def _save_secrets(data: dict):
    """Encrypt and write secrets back to the store."""
    global _secrets_cache, _cache_loaded

    path = config.SECRETS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)

    # Write plaintext to temp, encrypt in place
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".yaml", dir=str(path.parent), delete=False
    ) as f:
        yaml.dump(data, f, default_flow_style=False)
        tmp_path = f.name

    rc, out, err = _run_sops([
        "--encrypt",
        "--age", config.AGE_PUBLIC_KEY,
        "--input-type", "yaml",
        "--output-type", "yaml",
        "--output", str(path),
        tmp_path,
    ])
    os.unlink(tmp_path)

    if rc != 0:
        raise RuntimeError(f"SOPS encrypt failed: {err}")

    _secrets_cache = data
    _cache_loaded = True


# ── Public API ────────────────────────────────────────────

def get_service_secrets(service_name: str) -> dict:
    """Get all secrets for a specific service (service-specific + shared)."""
    data = load_secrets()
    service_secrets = dict(data.get("shared", {}))
    service_secrets.update(data.get("services", {}).get(service_name, {}))
    return service_secrets


def get_secret(name: str, section: str = "credentials") -> Optional[str]:
    """Get a single named credential."""
    data = load_secrets()
    # Check the requested section first
    value = data.get(section, {}).get(name)
    if value is not None:
        return str(value)
    # Fall back: search all sections
    for sec in ("credentials", "shared", "services"):
        container = data.get(sec, {})
        if name in container:
            val = container[name]
            if isinstance(val, dict):
                return None  # Don't return sub-dicts as single values
            return str(val)
        # Search inside service sub-dicts
        if sec == "services":
            for svc, svc_secrets in container.items():
                if isinstance(svc_secrets, dict) and name in svc_secrets:
                    return str(svc_secrets[name])
    return None


def set_secret(name: str, value: str, section: str = "credentials", service: str = None):
    """Set a secret. If service is provided, stores under services.<service>.<name>."""
    data = load_secrets(force=True)

    if service:
        data.setdefault("services", {}).setdefault(service, {})[name] = value
    else:
        data.setdefault(section, {})[name] = value

    _save_secrets(data)


def delete_secret(name: str, section: str = "credentials", service: str = None) -> bool:
    """Delete a secret. Returns True if it existed."""
    data = load_secrets(force=True)

    if service:
        svc = data.get("services", {}).get(service, {})
        if name in svc:
            del svc[name]
            _save_secrets(data)
            return True
    else:
        sec = data.get(section, {})
        if name in sec:
            del sec[name]
            _save_secrets(data)
            return True

    return False


def list_secrets(include_values: bool = False) -> dict:
    """List all secret names, organized by section.

    If include_values is False (default), values are replaced with '***'.
    This is the AI-safe listing mode.
    """
    data = load_secrets()
    result = {}

    for section_name in ("shared", "services", "credentials"):
        section_data = data.get(section_name, {})
        if section_name == "services":
            result[section_name] = {}
            for svc_name, svc_secrets in section_data.items():
                if isinstance(svc_secrets, dict):
                    result[section_name][svc_name] = {
                        k: (str(v) if include_values else "***")
                        for k, v in svc_secrets.items()
                    }
        else:
            result[section_name] = {
                k: (str(v) if include_values else "***")
                for k, v in section_data.items()
            }

    return result


def generate_env_file(service_name: str) -> str:
    """Generate a .env-format string for a service (for systemd EnvironmentFile)."""
    secrets = get_service_secrets(service_name)
    lines = []
    for key, value in sorted(secrets.items()):
        # Escape any quotes in value
        escaped = str(value).replace('"', '\\"')
        lines.append(f'{key}="{escaped}"')
    return "\n".join(lines) + "\n"


def get_stats() -> dict:
    """Return vault statistics without exposing values."""
    data = load_secrets()
    shared_count = len(data.get("shared", {}))
    cred_count = len(data.get("credentials", {}))
    svc_count = 0
    svc_names = []
    for svc_name, svc_secrets in data.get("services", {}).items():
        if isinstance(svc_secrets, dict):
            svc_count += len(svc_secrets)
            svc_names.append(svc_name)

    return {
        "total_secrets": shared_count + cred_count + svc_count,
        "shared": shared_count,
        "credentials": cred_count,
        "service_secrets": svc_count,
        "services": sorted(svc_names),
        "encrypted_file": str(config.SECRETS_FILE),
        "file_exists": config.SECRETS_FILE.exists(),
    }
