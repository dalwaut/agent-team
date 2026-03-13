"""Google Workspace OAuth2 token management for OPAI.

Handles OAuth2 user-flow authentication for agent@paradisewebfl.com.
Credentials stored in opai-vault (SOPS+age encrypted).

Usage:
    # One-time auth (interactive — opens browser)
    python3 tools/shared/google_auth.py /path/to/client_secret.json

    # Programmatic (import in MCP server or background tasks)
    from google_auth import get_access_token
    token = await get_access_token()
    # Use token in Authorization: Bearer header
"""

import asyncio
import json
import logging
import sys
import time
import threading
from pathlib import Path

logger = logging.getLogger("opai.google_auth")

# ── Constants ────────────────────────────────────────────

SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.readonly",
    # Phase 2 — Google Chat as agent@paradisewebfl.com (user auth, not bot)
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.messages",  # full: read + create + update + delete
    # Phase 2.5 — DM setup + member resolution
    "https://www.googleapis.com/auth/chat.spaces.create",
    "https://www.googleapis.com/auth/chat.memberships.readonly",
]

TOKEN_EXPIRY_BUFFER = 300  # Refresh 5 min before expiry
VAULT_REFRESH_TOKEN_KEY = "google-workspace-refresh-token"
VAULT_CLIENT_SECRET_KEY = "google-workspace-client-secret"

# ── In-Memory Token Cache ────────────────────────────────

_token_lock = threading.Lock()
_cached_token: str | None = None
_token_expires_at: float = 0


def _load_vault():
    """Import vault store dynamically.

    Uses importlib to avoid sys.modules conflict when the calling process
    (e.g., opai-engine) already has a different 'config' module loaded.
    """
    import importlib
    vault_path = str(Path(__file__).resolve().parent.parent / "opai-vault")
    if vault_path not in sys.path:
        sys.path.insert(0, vault_path)

    # Temporarily swap out any existing 'config' module so vault's
    # store.py picks up opai-vault/config.py, not the caller's config.
    prev_config = sys.modules.pop("config", None)
    prev_store = sys.modules.pop("store", None)
    try:
        import store
        importlib.reload(store)
        return store.get_secret
    finally:
        # Restore the caller's config module
        sys.modules.pop("config", None)
        sys.modules.pop("store", None)
        if prev_config is not None:
            sys.modules["config"] = prev_config
        if prev_store is not None:
            sys.modules["store"] = prev_store


def _get_client_config() -> dict:
    """Load OAuth2 client configuration from vault."""
    get_secret = _load_vault()
    raw = get_secret(VAULT_CLIENT_SECRET_KEY)
    if not raw:
        raise RuntimeError(
            f"Client secret not found in vault (key: {VAULT_CLIENT_SECRET_KEY}). "
            "Run the one-time auth flow first."
        )
    if isinstance(raw, str):
        return json.loads(raw)
    return raw


def _get_refresh_token() -> str:
    """Load OAuth2 refresh token from vault."""
    get_secret = _load_vault()
    token = get_secret(VAULT_REFRESH_TOKEN_KEY)
    if not token:
        raise RuntimeError(
            f"Refresh token not found in vault (key: {VAULT_REFRESH_TOKEN_KEY}). "
            "Run: python3 tools/shared/google_auth.py"
        )
    return token.strip()


async def get_access_token() -> str:
    """Get a valid Google API access token.

    Returns cached token if still valid (>5 min remaining).
    Otherwise refreshes using the stored refresh token.
    Thread-safe.

    Returns:
        Valid access token string.

    Raises:
        RuntimeError: If refresh token or client secret not in vault.
    """
    global _cached_token, _token_expires_at

    with _token_lock:
        if _cached_token and time.time() < _token_expires_at:
            return _cached_token

    # Refresh token outside lock (network I/O)
    token, expires_at = await _refresh_token()

    with _token_lock:
        _cached_token = token
        _token_expires_at = expires_at

    return token


async def _refresh_token() -> tuple[str, float]:
    """Refresh the access token using the stored refresh token.

    Returns:
        Tuple of (access_token, expires_at_timestamp).
    """
    import httpx

    client_config = _get_client_config()

    # Handle both formats: {"installed": {...}} and {"web": {...}} and flat
    if "installed" in client_config:
        creds = client_config["installed"]
    elif "web" in client_config:
        creds = client_config["web"]
    else:
        creds = client_config

    refresh_token = _get_refresh_token()

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": creds["client_id"],
                "client_secret": creds["client_secret"],
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )

    if resp.status_code != 200:
        raise RuntimeError(
            f"Token refresh failed ({resp.status_code}): {resp.text}"
        )

    data = resp.json()
    access_token = data["access_token"]
    expires_in = data.get("expires_in", 3600)
    expires_at = time.time() + expires_in - TOKEN_EXPIRY_BUFFER

    logger.info("Access token refreshed, expires in %ds", expires_in)
    return access_token, expires_at


def invalidate_cache():
    """Force token refresh on next call."""
    global _cached_token, _token_expires_at
    with _token_lock:
        _cached_token = None
        _token_expires_at = 0


# ── Domain-Wide Delegation (Service Account) ─────────────

VAULT_SA_KEY = "google-workspace-sa-key"
ALLOWED_DELEGATION_DOMAIN = "paradisewebfl.com"
DELEGATED_TOKEN_TTL = 55 * 60  # 55 minutes (tokens last 60 min)

DEFAULT_DELEGATION_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
]

_delegated_lock = threading.Lock()
_delegated_cache: dict[str, tuple[str, float]] = {}  # email -> (token, expires_at)


def _get_sa_key() -> dict:
    """Load service account JSON key from vault."""
    get_secret = _load_vault()
    raw = get_secret(VAULT_SA_KEY)
    if not raw:
        raise RuntimeError(
            f"Service account key not found in vault (key: {VAULT_SA_KEY}). "
            "Create a SA with domain-wide delegation and store its JSON key."
        )
    if isinstance(raw, str):
        return json.loads(raw)
    return raw


async def get_delegated_token(
    user_email: str,
    scopes: list[str] | None = None,
) -> str:
    """Get an access token impersonating a domain user via service account delegation.

    Uses a GCP service account with domain-wide delegation to mint tokens
    on behalf of any @paradisewebfl.com user. No per-user OAuth flow needed.

    Args:
        user_email: The user to impersonate (must be @paradisewebfl.com).
        scopes: OAuth scopes to request. Defaults to DEFAULT_DELEGATION_SCOPES.

    Returns:
        Valid access token string for the impersonated user.

    Raises:
        ValueError: If user_email is not @paradisewebfl.com.
        RuntimeError: If SA key not in vault or token mint fails.
    """
    # Domain safety check
    if not user_email.endswith(f"@{ALLOWED_DELEGATION_DOMAIN}"):
        raise ValueError(
            f"Delegation only allowed for @{ALLOWED_DELEGATION_DOMAIN} users, "
            f"got: {user_email}"
        )

    scopes = scopes or DEFAULT_DELEGATION_SCOPES

    # Check cache (thread-safe)
    cache_key = f"{user_email}|{'|'.join(sorted(scopes))}"
    with _delegated_lock:
        if cache_key in _delegated_cache:
            token, expires_at = _delegated_cache[cache_key]
            if time.time() < expires_at:
                return token

    # Mint new token outside lock (I/O)
    token, expires_at = await _mint_delegated_token(user_email, scopes)

    with _delegated_lock:
        _delegated_cache[cache_key] = (token, expires_at)

    logger.info("Delegated token minted for %s (expires in ~55min)", user_email)
    return token


async def _mint_delegated_token(
    user_email: str,
    scopes: list[str],
) -> tuple[str, float]:
    """Mint a delegated access token using the service account."""
    from google.oauth2 import service_account

    sa_info = _get_sa_key()

    creds = service_account.Credentials.from_service_account_info(
        sa_info,
        scopes=scopes,
        subject=user_email,
    )

    # creds.refresh() is synchronous — run in executor to stay async-compatible
    loop = asyncio.get_event_loop()
    import google.auth.transport.requests
    request = google.auth.transport.requests.Request()
    await loop.run_in_executor(None, creds.refresh, request)

    expires_at = time.time() + DELEGATED_TOKEN_TTL
    return creds.token, expires_at


def invalidate_delegated_cache(user_email: str | None = None):
    """Clear delegated token cache.

    Args:
        user_email: Clear cache for a specific user, or all if None.
    """
    with _delegated_lock:
        if user_email is None:
            _delegated_cache.clear()
        else:
            keys_to_remove = [k for k in _delegated_cache if k.startswith(f"{user_email}|")]
            for k in keys_to_remove:
                del _delegated_cache[k]


# ── One-Time Auth Flow (CLI) ─────────────────────────────

def run_auth_flow(client_secret_path: str | None = None):
    """Interactive one-time OAuth2 consent flow.

    Opens a browser for the user to sign in as agent@paradisewebfl.com
    and grant the requested scopes. Prints the refresh token for vault storage.

    Args:
        client_secret_path: Path to client_secret.json from Google Cloud Console.
                           If None, tries to load from vault.
    """
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("ERROR: google-auth-oauthlib not installed.")
        print("Run: pip install google-auth-oauthlib")
        sys.exit(1)

    if client_secret_path:
        flow = InstalledAppFlow.from_client_secrets_file(
            client_secret_path, scopes=SCOPES
        )
    else:
        # Try loading from vault
        try:
            config = _get_client_config()
            flow = InstalledAppFlow.from_client_config(config, scopes=SCOPES)
        except RuntimeError:
            print("ERROR: No client_secret.json provided and none in vault.")
            print("Usage: python3 tools/shared/google_auth.py /path/to/client_secret.json")
            sys.exit(1)

    print("\n=== OPAI Google Workspace — Scope Authorization ===")
    print(f"Requesting {len(SCOPES)} scopes (incremental — only new ones shown)")
    print("A browser window will open. Sign in as agent@paradisewebfl.com")
    print("and approve any new permissions.\n")

    # include_granted_scopes=true tells Google to merge new scopes with
    # previously granted ones into a single refresh token
    creds = flow.run_local_server(
        port=8888,
        open_browser=True,
        include_granted_scopes="true",
    )

    print("\n=== Auth Successful ===")
    print(f"Access token: {creds.token[:20]}...")
    print(f"Refresh token: {creds.refresh_token}")
    print(f"\nStore in vault with:")
    print(f"  python3 tools/opai-vault/scripts/import-env.py \\")
    print(f"    --credential {VAULT_REFRESH_TOKEN_KEY} --value '{creds.refresh_token}'")

    if client_secret_path:
        print(f"\n  # Also store the client secret:")
        print(f"  python3 tools/opai-vault/scripts/import-env.py \\")
        print(f"    --credential {VAULT_CLIENT_SECRET_KEY} --value \"$(cat {client_secret_path})\"")

    return creds


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    path = sys.argv[1] if len(sys.argv) > 1 else None
    run_auth_flow(path)
