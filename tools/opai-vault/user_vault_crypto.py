"""OPAI Vault — Per-user AES-256-GCM encryption.

Each user gets a derived key from:
    HKDF(master_key, salt=user_id, info="opai-user-vault")

Encrypted values are stored as: base64(nonce || ciphertext || tag)
- nonce: 12 bytes (GCM standard)
- tag: 16 bytes (GCM standard)
- ciphertext: variable length
"""

import base64
import os
from functools import lru_cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

import store

_MASTER_KEY_CACHE: bytes | None = None


def _get_master_key() -> bytes:
    """Load the master key from system vault (cached)."""
    global _MASTER_KEY_CACHE
    if _MASTER_KEY_CACHE is not None:
        return _MASTER_KEY_CACHE

    hex_key = store.get_secret("USER_VAULT_MASTER_KEY", section="shared")
    if not hex_key:
        raise RuntimeError("USER_VAULT_MASTER_KEY not found in system vault")

    _MASTER_KEY_CACHE = bytes.fromhex(hex_key)
    return _MASTER_KEY_CACHE


def _derive_key(user_id: str) -> bytes:
    """Derive a per-user 256-bit key using HKDF."""
    master = _get_master_key()
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=user_id.encode("utf-8"),
        info=b"opai-user-vault",
    )
    return hkdf.derive(master)


def encrypt(user_id: str, plaintext: str) -> str:
    """Encrypt a secret value for a specific user.

    Returns base64-encoded string: nonce(12) + ciphertext + tag(16).
    """
    key = _derive_key(user_id)
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ct = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
    # ct includes the 16-byte tag appended by AESGCM
    return base64.b64encode(nonce + ct).decode("ascii")


def decrypt(user_id: str, encrypted_b64: str) -> str:
    """Decrypt a secret value for a specific user.

    Expects base64-encoded string: nonce(12) + ciphertext + tag(16).
    """
    key = _derive_key(user_id)
    raw = base64.b64decode(encrypted_b64)
    if len(raw) < 28:  # 12 nonce + 16 tag minimum
        raise ValueError("Invalid encrypted data (too short)")
    nonce = raw[:12]
    ct = raw[12:]
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(nonce, ct, None)
    return plaintext.decode("utf-8")
