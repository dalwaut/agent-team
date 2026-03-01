#!/bin/bash
# migrate-services.sh — Update systemd service templates to use vault-env.sh
#
# Strategy: Dual-source with graceful fallback
#   1. ExecStartPre (soft fail) runs vault-env.sh → writes /run/opai/<svc>.env
#   2. EnvironmentFile loads /run/opai/<svc>.env (if exists)
#   3. Original .env kept as fallback (loaded first, vault overrides)
#
# If vault is unavailable, services still start from their original .env files.

set -uo pipefail

TEMPLATE_DIR="/workspace/synced/opai/config/service-templates"
LIVE_DIR="$HOME/.config/systemd/user"
VAULT_ENV_SCRIPT="/workspace/synced/opai/tools/opai-vault/scripts/vault-env.sh"

# Map: systemd unit name → vault service name (only for mismatches)
declare -A NAME_MAP=(
    ["opai-discord-bot"]="discord-bridge"
    ["opai-email"]="email-checker"
)

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "[DRY RUN] Showing planned changes only"
    echo ""
fi

UPDATED=0
SKIPPED=0

for template in "$TEMPLATE_DIR"/opai-*.service; do
    unit_name=$(basename "$template" .service)

    # Skip vault itself and non-tool services
    if [[ "$unit_name" == "opai-vault" || "$unit_name" == "opai-caddy" || \
          "$unit_name" == "opai-docker-cleanup" || "$unit_name" == "opai-git-sync" ]]; then
        echo "SKIP  $unit_name (infrastructure service, not a secret consumer)"
        ((SKIPPED++))
        continue
    fi

    # Determine vault service name
    vault_name="${NAME_MAP[$unit_name]:-$unit_name}"

    # Check if vault has secrets for this service
    has_secrets=$(cd /workspace/synced/opai/tools/opai-vault && python3 -c "
import store
secrets = store.get_service_secrets('$vault_name')
print(len(secrets))
" 2>/dev/null || echo "0")

    if [[ "$has_secrets" == "0" ]]; then
        echo "SKIP  $unit_name (no secrets in vault for '$vault_name')"
        ((SKIPPED++))
        continue
    fi

    # Check if already migrated (has vault-env.sh in ExecStartPre)
    if grep -q "vault-env.sh" "$template" 2>/dev/null; then
        echo "SKIP  $unit_name (already migrated)"
        ((SKIPPED++))
        continue
    fi

    # Read current template
    content=$(cat "$template")

    # Build the vault lines to inject
    VAULT_PRE="ExecStartPre=-${VAULT_ENV_SCRIPT} ${vault_name}"
    VAULT_ENV="EnvironmentFile=-/run/opai/${vault_name}.env"

    if $DRY_RUN; then
        echo "PLAN  $unit_name → vault:'$vault_name' ($has_secrets secrets)"
        echo "      + $VAULT_PRE"
        echo "      + $VAULT_ENV"
    else
        # Strategy: Insert vault lines just before ExecStart
        # This ensures they come after any existing Environment= lines
        tmpfile=$(mktemp)

        while IFS= read -r line; do
            if [[ "$line" == ExecStart=* ]]; then
                # Insert vault lines before ExecStart
                echo "$VAULT_PRE" >> "$tmpfile"
                echo "$VAULT_ENV" >> "$tmpfile"
            fi
            echo "$line" >> "$tmpfile"
        done < "$template"

        cp "$tmpfile" "$template"
        rm "$tmpfile"

        # Also copy to live systemd directory
        cp "$template" "$LIVE_DIR/$unit_name.service"

        echo "OK    $unit_name → vault:'$vault_name' ($has_secrets secrets)"
    fi
    ((UPDATED++))
done

echo ""
echo "Updated: $UPDATED  Skipped: $SKIPPED"

if ! $DRY_RUN && [[ $UPDATED -gt 0 ]]; then
    echo ""
    echo "Reloading systemd daemon..."
    systemctl --user daemon-reload
    echo "Done. Services will use vault on next restart."
    echo ""
    echo "To restart all services:"
    echo "  ./scripts/opai-control.sh restart"
    echo ""
    echo "To restart one service:"
    echo "  systemctl --user restart <service-name>"
fi
