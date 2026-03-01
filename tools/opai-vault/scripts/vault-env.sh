#!/bin/bash
# vault-env.sh — Decrypt vault secrets for a service and write to tmpfs
#
# Usage (in systemd ExecStartPre):
#   ExecStartPre=/workspace/synced/opai/tools/opai-vault/scripts/vault-env.sh %N
#
# Writes decrypted .env to $XDG_RUNTIME_DIR/opai-vault/<service>.env (tmpfs, RAM-only)
# The service then reads via EnvironmentFile

set -euo pipefail

SERVICE_NAME="${1:?Usage: vault-env.sh <service-name>}"
VAULT_DIR="/workspace/synced/opai/tools/opai-vault"
SOPS_BIN="$HOME/bin/sops"
SECRETS_FILE="$VAULT_DIR/data/secrets.enc.yaml"
AGE_KEY="$HOME/.opai-vault/vault.key"
# Use XDG_RUNTIME_DIR (set by systemd user session) or fallback
OUTPUT_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/opai-vault"
OUTPUT_FILE="$OUTPUT_DIR/${SERVICE_NAME}.env"

# Ensure output directory exists (tmpfs)
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

# Decrypt the full vault and pipe to Python for env extraction
export SOPS_AGE_KEY_FILE="$AGE_KEY"
"$SOPS_BIN" --decrypt "$SECRETS_FILE" | python3 -c "
import sys, yaml, os

service_name = '$SERVICE_NAME'
output_file = '$OUTPUT_FILE'
data = yaml.safe_load(sys.stdin.read())

env_lines = []

# Shared keys first
for key, value in sorted((data.get('shared') or {}).items()):
    escaped = str(value).replace('\"', '\\\\\"')
    env_lines.append(f'{key}=\"{escaped}\"')

# Service-specific keys (override shared)
svc_secrets = (data.get('services') or {}).get(service_name, {})
for key, value in sorted(svc_secrets.items()):
    escaped = str(value).replace('\"', '\\\\\"')
    env_lines.append(f'{key}=\"{escaped}\"')

with open(output_file, 'w') as f:
    f.write('\n'.join(env_lines) + '\n')

os.chmod(output_file, 0o600)
print(f'[vault-env] Wrote {output_file} for {service_name} ({len(env_lines)} vars)')
"
