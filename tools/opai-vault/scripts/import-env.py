#!/usr/bin/env python3
"""Import existing .env files into the OPAI Vault encrypted store.

Usage:
    python3 scripts/import-env.py                    # Import all known services
    python3 scripts/import-env.py --service opai-billing  # Import one service
    python3 scripts/import-env.py --dry-run           # Show what would be imported

This reads each service's .env file and stores the key=value pairs
into the vault under services.<service-name>.<KEY>.

Common keys (SUPABASE_URL, SUPABASE_SERVICE_KEY, etc.) are detected
and stored under 'shared' to avoid duplication.
"""

import argparse
import os
import sys
from pathlib import Path

# Add parent to path for store/config imports
sys.path.insert(0, str(Path(__file__).parent.parent))
import config
import store


# Keys that should be stored in 'shared' (not per-service)
SHARED_KEYS = {
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_JWT_SECRET",
    "SUPABASE_JWKS_URL",
}

# Known service directories with .env files
KNOWN_SERVICES = [
    "opai-billing",
    "opai-bot-space",
    "opai-brain",
    "opai-bx4",
    "opai-chat",
    "opai-dam",
    "opai-dev",
    "opai-docs",
    "opai-email-agent",
    "opai-files",
    "opai-forum",
    "opai-forumbot",
    "opai-helm",
    "opai-marketplace",
    "opai-marq",
    "opai-messenger",
    "opai-monitor",
    "opai-orchestra",
    "opai-portal",
    "opai-prd",
    "opai-tasks",
    "opai-team-hub",
    "opai-terminal",
    "opai-users",
    "opai-wordpress",
    "discord-bridge",
    "email-checker",
]


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse a .env file into key=value dict."""
    result = {}
    if not path.exists():
        return result

    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # Remove surrounding quotes
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        if key and value:
            result[key] = value
    return result


def import_service(service_name: str, dry_run: bool = False) -> dict:
    """Import a single service's .env into the vault."""
    env_path = config.TOOLS_DIR / service_name / ".env"
    if not env_path.exists():
        return {"service": service_name, "status": "skipped", "reason": "no .env file"}

    pairs = parse_env_file(env_path)
    if not pairs:
        return {"service": service_name, "status": "skipped", "reason": "empty .env"}

    shared_imported = []
    service_imported = []

    for key, value in pairs.items():
        if key in SHARED_KEYS:
            if not dry_run:
                # Only store shared keys if not already set (first wins)
                existing = store.get_secret(key, section="shared")
                if existing is None:
                    store.set_secret(key, value, section="shared")
                    shared_imported.append(key)
                else:
                    shared_imported.append(f"{key} (already set)")
            else:
                shared_imported.append(key)
        else:
            if not dry_run:
                store.set_secret(key, value, service=service_name)
            service_imported.append(key)

    return {
        "service": service_name,
        "status": "dry-run" if dry_run else "imported",
        "shared_keys": shared_imported,
        "service_keys": service_imported,
        "total": len(pairs),
    }


def main():
    parser = argparse.ArgumentParser(description="Import .env files into OPAI Vault")
    parser.add_argument("--service", "-s", help="Import only this service")
    parser.add_argument("--dry-run", "-n", action="store_true", help="Show what would be imported")
    args = parser.parse_args()

    services = [args.service] if args.service else KNOWN_SERVICES

    print(f"{'[DRY RUN] ' if args.dry_run else ''}Importing .env files into vault...\n")

    total_secrets = 0
    for svc in services:
        result = import_service(svc, dry_run=args.dry_run)
        status = result["status"]
        if status == "skipped":
            print(f"  SKIP  {svc}: {result.get('reason', '')}")
        else:
            count = result.get("total", 0)
            total_secrets += count
            shared = result.get("shared_keys", [])
            service_keys = result.get("service_keys", [])
            print(f"  {'PLAN' if args.dry_run else 'OK'}    {svc}: {count} keys")
            if shared:
                print(f"         -> shared: {', '.join(shared)}")
            if service_keys:
                print(f"         -> service: {', '.join(service_keys)}")

    print(f"\n{'Would import' if args.dry_run else 'Imported'} {total_secrets} secrets total.")

    if not args.dry_run:
        stats = store.get_stats()
        print(f"Vault now holds {stats['total_secrets']} secrets across {len(stats['services'])} services.")


if __name__ == "__main__":
    main()
