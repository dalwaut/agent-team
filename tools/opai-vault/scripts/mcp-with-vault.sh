#!/bin/bash
# mcp-with-vault.sh — Launch an MCP server with vault-injected credentials
#
# Usage (in .mcp.json):
#   "command": "/path/to/mcp-with-vault.sh",
#   "args": ["<vault-service-name>", "<actual-command>", "<arg1>", ...]
#
# Decrypts vault, exports the service's env vars, then exec's the real command.

VAULT_SERVICE="${1:?Usage: mcp-with-vault.sh <service-name> <command> [args...]}"
shift

SOPS_BIN="$HOME/bin/sops"
SECRETS_FILE="/workspace/synced/opai/tools/opai-vault/data/secrets.enc.yaml"
AGE_KEY="$HOME/.opai-vault/vault.key"

export SOPS_AGE_KEY_FILE="$AGE_KEY"

# Decrypt and extract env vars for this service + credentials section
eval "$("$SOPS_BIN" --decrypt "$SECRETS_FILE" 2>/dev/null | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin.read()) or {}
svc = '$VAULT_SERVICE'

# Merge shared + service-specific + credentials matching the service name
env = {}
env.update(data.get('shared') or {})
env.update((data.get('services') or {}).get(svc, {}))

# Also check credentials section for keys matching the service name pattern
for key, val in (data.get('credentials') or {}).items():
    # e.g. clickup-api/KEY → export KEY
    if key.startswith(svc) or key.startswith(svc.replace('-', '_')):
        bare_key = key.split('/')[-1] if '/' in key else key
        env[bare_key] = val

for k, v in env.items():
    escaped = str(v).replace(\"'\", \"'\\\\''\")
    print(f\"export {k}='{escaped}'\")
" 2>/dev/null)"

# Execute the actual MCP server command
exec "$@"
