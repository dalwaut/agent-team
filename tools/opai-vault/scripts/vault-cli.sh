#!/bin/bash
# vault-cli.sh — Quick CLI for vault operations
#
# Usage:
#   vault-cli.sh list                     List all secret names (masked)
#   vault-cli.sh get <name>               Get a secret value
#   vault-cli.sh set <name> <value>       Set a secret
#   vault-cli.sh env <service>            Print .env for a service
#   vault-cli.sh stats                    Show vault statistics
#   vault-cli.sh edit                     Open vault in SOPS editor
#   vault-cli.sh import [--dry-run]       Import all .env files
#   vault-cli.sh import-access            Import notes/Access/ credentials
#   vault-cli.sh export <service> <path>  Export .env file for a service
#   vault-cli.sh backup                   Create encrypted backup

set -euo pipefail

VAULT_DIR="/workspace/synced/opai/tools/opai-vault"
SOPS_BIN="$HOME/bin/sops"
SECRETS_FILE="$VAULT_DIR/data/secrets.enc.yaml"
AGE_KEY="$HOME/.opai-vault/vault.key"

export SOPS_AGE_KEY_FILE="$AGE_KEY"

CMD="${1:-help}"
shift 2>/dev/null || true

case "$CMD" in
    list)
        "$SOPS_BIN" --decrypt "$SECRETS_FILE" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin.read())
for section in ('shared', 'credentials', 'services'):
    items = data.get(section, {})
    if not items: continue
    print(f'\n=== {section.upper()} ===')
    if section == 'services':
        for svc, secrets in sorted(items.items()):
            if isinstance(secrets, dict):
                for k in sorted(secrets.keys()):
                    print(f'  {svc}/{k}: ***')
    else:
        for k in sorted(items.keys()):
            print(f'  {k}: ***')
"
        ;;

    get)
        NAME="${1:?Usage: vault-cli.sh get <secret-name>}"
        "$SOPS_BIN" --decrypt "$SECRETS_FILE" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin.read())
name = '$NAME'
# Search all sections
for sec in ('credentials', 'shared'):
    if name in (data.get(sec) or {}):
        print(data[sec][name])
        sys.exit(0)
for svc, secrets in (data.get('services') or {}).items():
    if isinstance(secrets, dict) and name in secrets:
        print(secrets[name])
        sys.exit(0)
print(f'Secret \"{name}\" not found', file=sys.stderr)
sys.exit(1)
"
        ;;

    set)
        NAME="${1:?Usage: vault-cli.sh set <name> <value>}"
        VALUE="${2:?Usage: vault-cli.sh set <name> <value>}"
        cd "$VAULT_DIR"
        python3 -c "
import store
store.set_secret('$NAME', '''$VALUE''')
print(f'Secret \"$NAME\" set successfully')
"
        ;;

    env)
        SERVICE="${1:?Usage: vault-cli.sh env <service-name>}"
        "$SOPS_BIN" --decrypt "$SECRETS_FILE" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin.read())
svc = '$SERVICE'
env = {}
env.update(data.get('shared') or {})
env.update((data.get('services') or {}).get(svc, {}))
for k, v in sorted(env.items()):
    escaped = str(v).replace('\"', '\\\\\"')
    print(f'{k}=\"{escaped}\"')
"
        ;;

    stats)
        cd "$VAULT_DIR"
        python3 -c "
import store
stats = store.get_stats()
print(f'Total secrets: {stats[\"total_secrets\"]}')
print(f'  Shared: {stats[\"shared\"]}')
print(f'  Credentials: {stats[\"credentials\"]}')
print(f'  Service-specific: {stats[\"service_secrets\"]}')
print(f'  Services: {\", \".join(stats[\"services\"])}')
print(f'  Encrypted file: {stats[\"encrypted_file\"]}')
print(f'  File exists: {stats[\"file_exists\"]}')
"
        ;;

    edit)
        "$SOPS_BIN" "$SECRETS_FILE"
        ;;

    import)
        cd "$VAULT_DIR"
        python3 scripts/import-env.py "$@"
        ;;

    import-access)
        cd "$VAULT_DIR"
        python3 scripts/import-access.py "$@"
        ;;

    export)
        SERVICE="${1:?Usage: vault-cli.sh export <service> <path>}"
        OUTPUT="${2:?Usage: vault-cli.sh export <service> <path>}"
        "$SOPS_BIN" --decrypt "$SECRETS_FILE" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin.read())
svc = '$SERVICE'
env = {}
env.update(data.get('shared') or {})
env.update((data.get('services') or {}).get(svc, {}))
lines = []
for k, v in sorted(env.items()):
    escaped = str(v).replace('\"', '\\\\\"')
    lines.append(f'{k}=\"{escaped}\"')
with open('$OUTPUT', 'w') as f:
    f.write('\n'.join(lines) + '\n')
import os
os.chmod('$OUTPUT', 0o600)
print(f'Exported {len(lines)} vars to $OUTPUT')
"
        ;;

    backup)
        BACKUP_DIR="$VAULT_DIR/data/backups"
        mkdir -p "$BACKUP_DIR"
        TIMESTAMP=$(date +%Y%m%d-%H%M%S)
        cp "$SECRETS_FILE" "$BACKUP_DIR/secrets.enc.yaml.${TIMESTAMP}"
        echo "Backup created: $BACKUP_DIR/secrets.enc.yaml.${TIMESTAMP}"
        # Keep only last 10 backups
        ls -t "$BACKUP_DIR"/secrets.enc.yaml.* 2>/dev/null | tail -n +11 | xargs -r rm
        echo "$(ls "$BACKUP_DIR"/secrets.enc.yaml.* 2>/dev/null | wc -l) backups retained"
        ;;

    help|*)
        echo "OPAI Vault CLI"
        echo ""
        echo "Usage: vault-cli.sh <command> [args]"
        echo ""
        echo "Commands:"
        echo "  list                     List all secret names (values masked)"
        echo "  get <name>               Get a secret value"
        echo "  set <name> <value>       Set a secret"
        echo "  env <service>            Print .env for a service"
        echo "  stats                    Show vault statistics"
        echo "  edit                     Open vault in SOPS editor (interactive)"
        echo "  import [--dry-run]       Import all .env files"
        echo "  import-access            Import notes/Access/ credentials"
        echo "  export <service> <path>  Export .env file for a service"
        echo "  backup                   Create timestamped backup"
        ;;
esac
