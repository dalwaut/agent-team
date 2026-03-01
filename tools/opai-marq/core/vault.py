"""Marq — Credential Vault (Fernet encryption for per-app store secrets)."""

from cryptography.fernet import Fernet
import json
import config
from pathlib import Path


def _fernet():
    return Fernet(config.VAULT_KEY.encode() if isinstance(config.VAULT_KEY, str) else config.VAULT_KEY)


def store_credential(app_id: str, service: str, data: dict) -> str:
    """Encrypt and store credentials. Returns vault_key string."""
    path = config.VAULT_DIR / app_id / f"{service}.json.enc"
    path.parent.mkdir(parents=True, exist_ok=True)
    encrypted = _fernet().encrypt(json.dumps(data).encode())
    path.write_bytes(encrypted)
    return f"mrq/{app_id}/{service}"


def load_credential(vault_key: str) -> dict:
    """Decrypt and return credentials from vault."""
    parts = vault_key.split("/")  # ['mrq', app_id, service]
    if len(parts) != 3:
        raise ValueError(f"Invalid vault_key format: {vault_key}")
    path = config.VAULT_DIR / parts[1] / f"{parts[2]}.json.enc"
    if not path.exists():
        raise FileNotFoundError(f"Vault key not found: {vault_key}")
    return json.loads(_fernet().decrypt(path.read_bytes()).decode())


def delete_credential(vault_key: str) -> None:
    """Delete encrypted credential file."""
    parts = vault_key.split("/")
    if len(parts) != 3:
        return
    path = config.VAULT_DIR / parts[1] / f"{parts[2]}.json.enc"
    path.unlink(missing_ok=True)


def list_credentials(app_id: str) -> list[str]:
    """List all vault keys for an app."""
    dir_path = config.VAULT_DIR / app_id
    if not dir_path.exists():
        return []
    return [
        f"mrq/{app_id}/{p.stem.replace('.json', '')}"
        for p in dir_path.glob("*.json.enc")
    ]
