#!/usr/bin/env python3
"""Import credentials from notes/Access/ markdown files into the vault.

Usage:
    python3 scripts/import-access.py              # Import all
    python3 scripts/import-access.py --dry-run     # Preview only

Strategy: value-pattern matching. Instead of matching any key=value pair,
we only import values that LOOK like credentials (API keys, tokens, passwords,
JWTs, secrets). This avoids importing metadata like dates, descriptions, URLs
that aren't secrets.
"""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
import config
import store

ACCESS_DIR = config.OPAI_ROOT / "notes" / "Access"

# Regex patterns that identify a VALUE as a credential
# If a value matches any of these, it's imported. Otherwise it's skipped.
CREDENTIAL_VALUE_PATTERNS = [
    re.compile(r'^sk_live_\S{20,}'),                # Stripe live secret
    re.compile(r'^sk_test_\S{20,}'),                 # Stripe test secret
    re.compile(r'^pk_live_\S{20,}'),                 # Stripe live publishable
    re.compile(r'^pk_test_\S{20,}'),                 # Stripe test publishable
    re.compile(r'^whsec_\S{10,}'),                   # Stripe webhook secret
    re.compile(r'^sk-ant-api\S{20,}'),               # Anthropic API key
    re.compile(r'^sk-proj-\S{20,}'),                 # OpenAI project key
    re.compile(r'^sk-\S{40,}'),                      # Generic OpenAI key
    re.compile(r'^re_\w{6,}_\S{10,}'),               # Resend API key
    re.compile(r'^sbp_\S{10,}'),                     # Supabase PAT
    re.compile(r'^tskey-\S{10,}'),                   # Tailscale key
    re.compile(r'^eyJhbGci\S{50,}'),                 # JWT tokens (base64)
    re.compile(r'^GOCSPX-\S{10,}'),                  # Google OAuth client secret
    re.compile(r'^xai-\S{10,}'),                     # XAI API key
    re.compile(r'^ghp_\S{20,}'),                     # GitHub PAT
    re.compile(r'^gho_\S{20,}'),                     # GitHub OAuth token
    re.compile(r'^glpat-\S{10,}'),                   # GitLab PAT
    re.compile(r'^pk_\d{6,}_\S{10,}'),               # ClickUp API key
    re.compile(r'^MTQ\S{50,}'),                      # Discord bot token (base64-ish)
    re.compile(r'^[A-Za-z0-9+/=]{40,}$'),            # Long base64 (likely a key/secret)
    re.compile(r'^sb_publishab\S{10,}'),             # Supabase publishable key
    re.compile(r'^jcI\S{20,}'),                      # Hostinger API token pattern
    re.compile(r'^[A-Za-z0-9]{30,}$'),               # Long alphanumeric string (likely API key)
]

# Key names that strongly indicate a credential (case-insensitive)
CREDENTIAL_KEY_NAMES = {
    "TOKEN", "SECRET", "KEY", "API_KEY", "SECRET_KEY", "PUBLISHABLE_KEY",
    "PASSWORD", "PASS", "APP_PASSWORD", "APP_PW", "PAT",
    "SERVICE_ROLE", "SERVICE_ROLE_SECRET", "ANON_KEY", "PUBLIC_ANON",
    "JWT", "JWT_SECRET", "DATABASE_PASSWORD",
    "CLIENT_SECRET", "CLIENT_ID", "CONSUMER_SECRET", "CONSUMER_KEYS",
    "SECRET_KEYS", "BEARER_TOKEN", "WEBHOOK_SECRET",
    "IMAP_PASS", "SMTP_PASS", "BOT_TOKEN", "DISCORD_BOT_TOKEN",
    "VAULT_KEY", "ENCRYPTION_KEY",
}

# Key names that are definitely NOT credentials — skip these
SKIP_KEY_NAMES = {
    "NOTE", "NOTES", "ADDED", "USED_BY", "USED_FOR", "LOCATION", "PURPOSE",
    "PLAN", "TEMPLATE", "RENEWAL_DATE", "PROVIDER", "SERVER_NAME",
    "LAUNCHER", "DESKTOP_SHORTCUT", "SYSTEMD_SERVICE", "CONFIG",
    "TIMEOUT", "PATTERN", "PERMISSIONS", "DAILY_CREDITS",
    "DAILY_REDESIGN_CREDITS", "DOCUMENTATION", "ENDPOINT", "HEADER",
    "RUNNING", "WARNING", "CHANNEL_ID", "IP", "PORT", "HOST",
    "INVITE_URL", "GUILD_SERVER_ID", "ORG_NAME", "EMAIL",
    "TAILSCALE", "NAME", "DESCRIPTION", "STATUS", "GENERATED_FROM",
    "URL", "PROJECT_URL", "PROJECT_BASE", "PROJECT_ID", "PROJECTID",
    "HTTPS", "HTTP", "CURL", "WEBHOOK_URL", "LOGIN",
    "N8N_DISCORD_ORCHESTRATOR_AGENT_WORKFLOW", "DISCORD_CREDENTIAL_ON_N8N",
    "AI_MODEL_CREDENTIAL_ON_N8N", "LOCAL_WORKFLOW_FILE",
}


def slugify(text: str) -> str:
    """Convert filename to a vault-friendly slug."""
    text = text.lower().replace(" ", "-").replace(",", "").replace("'", "")
    text = re.sub(r'[^a-z0-9\-]', '', text)
    text = re.sub(r'-+', '-', text).strip('-')
    return text


def _is_credential_value(value: str) -> bool:
    """Check if a value looks like a credential based on its content."""
    for pattern in CREDENTIAL_VALUE_PATTERNS:
        if pattern.search(value):
            return True
    return False


def _normalize_key(raw_key: str) -> str:
    """Clean up a key name for vault storage."""
    key = re.sub(r'[^a-zA-Z0-9]', '_', raw_key).upper().strip('_')
    # Remove common prefixes that got mangled
    for prefix in ("CURL__X_GET__", "DOCUMENTATION__", "RUNNING___COOLIFY__",
                    "SUPABASE_URL_", "WEBHOOK_URL_"):
        if key.startswith(prefix):
            key = key[len(prefix):]
    return key


def extract_credentials(content: str) -> list[tuple[str, str]]:
    """Extract credential key-value pairs from markdown content.

    Uses a two-pass strategy:
    1. If the key name is a known credential name, include it (unless value is too short)
    2. If the value matches a credential pattern, include it regardless of key name
    3. Skip if key name is in the skip list
    """
    pairs = []

    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue

        key = None
        value = None

        # Pattern 1: KEY=value or KEY: value (uppercase key)
        match = re.match(r'^[`*]*([A-Z][A-Z0-9_]{2,})[`*]*\s*[=:]\s*[`]*(.+?)[`]*$', line)
        if match:
            key, value = match.group(1).strip(), match.group(2).strip()

        # Pattern 2: - **Label**: value or - Label: `value`
        if not key:
            match = re.match(r'^[-*]\s*\**([^*:]+?)\**\s*:\s*[`]*(.+?)[`]*$', line)
            if match:
                label, value = match.group(1).strip(), match.group(2).strip()
                key = _normalize_key(label)

        if not key or not value:
            continue

        # Clean up value (remove trailing backticks, markdown artifacts)
        value = value.strip('`* ')

        # Skip empty/short values
        if len(value) < 8:
            continue

        # Skip known non-credential keys
        # Check both exact match and suffix match (e.g., CURL__X_GET__HTTPS -> HTTPS)
        base_key = key.split('__')[-1] if '__' in key else key
        if key in SKIP_KEY_NAMES or base_key in SKIP_KEY_NAMES:
            continue

        # Include if: key name is a known credential name OR value looks like a credential
        is_cred_key = key in CREDENTIAL_KEY_NAMES or base_key in CREDENTIAL_KEY_NAMES
        is_cred_value = _is_credential_value(value)

        if is_cred_key or is_cred_value:
            pairs.append((key, value))

    return pairs


def parse_access_file(filepath: Path) -> dict[str, str]:
    """Parse a notes/Access/ file and extract credentials."""
    content = filepath.read_text()
    file_slug = slugify(filepath.stem)

    results = {}
    pairs = extract_credentials(content)

    for key, value in pairs:
        vault_key = f"{file_slug}/{key}"
        results[vault_key] = value

    return results


def main():
    parser = argparse.ArgumentParser(description="Import notes/Access/ into vault")
    parser.add_argument("--dry-run", "-n", action="store_true")
    args = parser.parse_args()

    if not ACCESS_DIR.exists():
        print(f"Access directory not found: {ACCESS_DIR}")
        sys.exit(1)

    md_files = sorted(ACCESS_DIR.glob("*.md"))
    print(f"{'[DRY RUN] ' if args.dry_run else ''}Scanning {len(md_files)} files in notes/Access/\n")

    total = 0
    for filepath in md_files:
        creds = parse_access_file(filepath)
        if not creds:
            continue

        print(f"  {'PLAN' if args.dry_run else 'OK'}    {filepath.name}: {len(creds)} credentials")
        for key, value in sorted(creds.items()):
            # Show truncated value for verification
            preview = value[:16] + "..." if len(value) > 19 else value
            print(f"         {key} = {preview}")
            if not args.dry_run:
                store.set_secret(key, value, section="credentials")
            total += 1

    if total == 0:
        print("  No credentials matched the import filters.")

    print(f"\n{'Would import' if args.dry_run else 'Imported'} {total} credentials from notes/Access/.")

    if not args.dry_run and total > 0:
        stats = store.get_stats()
        print(f"Vault now holds {stats['total_secrets']} secrets total.")


if __name__ == "__main__":
    main()
