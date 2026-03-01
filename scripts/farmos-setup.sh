#!/bin/bash
#
# farmOS Setup — Repeatable permission fix, module install & user verification.
#
# Can be run standalone or called by farmos-weekly-sync.sh.
# Operates on the BB VPS farmOS containers via SSH.
#
# Usage:
#   ./scripts/farmos-setup.sh               # Full setup
#   ./scripts/farmos-setup.sh --perms-only   # Just fix permissions
#   ./scripts/farmos-setup.sh --module-only  # Just install farm_map_free
#

set -euo pipefail

OPAI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VPS_SSH="ssh -i $HOME/.ssh/bb_vps -o ConnectTimeout=10 -o StrictHostKeyChecking=no root@bb-vps"
VPS_SCP="scp -i $HOME/.ssh/bb_vps -o ConnectTimeout=10 -o StrictHostKeyChecking=no"
MODULE_DIR="$OPAI_ROOT/Projects/FarmOS/deploy/custom-modules/farm_map_free"
FARMOS_MODULE_PATH="/opt/drupal/web/modules/custom/farm_map_free"
LOG_PREFIX="[farmos-setup]"

MODE="full"
if [[ "${1:-}" == "--perms-only" ]]; then MODE="perms"; fi
if [[ "${1:-}" == "--module-only" ]]; then MODE="module"; fi

log() { echo "$LOG_PREFIX $*"; }

# ── Test SSH ───────────────────────────────────────────────────────
log "Testing SSH connection to BB VPS..."
if ! $VPS_SSH "echo ok" > /dev/null 2>&1; then
    log "ERROR: Cannot SSH to BB VPS"
    exit 1
fi
log "SSH OK"

# ── Module Install ─────────────────────────────────────────────────
install_module() {
    log "Installing farm_map_free module..."

    # Check if module exists in container
    local exists
    exists=$($VPS_SSH "docker exec farmos-www test -d $FARMOS_MODULE_PATH && echo yes || echo no" 2>/dev/null)

    if [[ "$exists" != "yes" ]]; then
        if [[ ! -d "$MODULE_DIR" ]] || [[ -z "$(ls -A "$MODULE_DIR" 2>/dev/null)" ]]; then
            log "ERROR: Module not in container and no local backup at $MODULE_DIR"
            exit 1
        fi

        log "Module not found in container — injecting from backup..."
        tar czf /tmp/farm_map_free_setup.tar.gz -C "$OPAI_ROOT/Projects/FarmOS/deploy/custom-modules" farm_map_free
        $VPS_SCP /tmp/farm_map_free_setup.tar.gz "root@bb-vps:/tmp/"
        $VPS_SSH "cd /tmp && tar xzf farm_map_free_setup.tar.gz && \
            docker cp farm_map_free farmos-www:${FARMOS_MODULE_PATH%/*}/ && \
            rm -rf /tmp/farm_map_free /tmp/farm_map_free_setup.tar.gz"
        rm -f /tmp/farm_map_free_setup.tar.gz
        log "Module files injected"
    else
        log "Module already present in container"
    fi

    # Enable module
    log "Enabling farm_map_free..."
    $VPS_SSH "docker exec farmos-www drush en farm_map_free -y 2>/dev/null" || true
    $VPS_SSH "docker exec farmos-www drush cr"
    log "Module enabled, cache rebuilt"

    # Verify
    local enabled
    enabled=$($VPS_SSH "docker exec farmos-www drush pm:list --status=enabled 2>/dev/null" | grep -c "farm_map_free" || echo "0")
    if [[ "$enabled" -gt 0 ]]; then
        log "farm_map_free: ENABLED"
    else
        log "WARNING: farm_map_free may not be enabled — check manually"
    fi
}

# ── Permission Fix ─────────────────────────────────────────────────
fix_permissions() {
    log "Granting all permissions to farm_manager role..."

    local output
    output=$($VPS_SSH "docker exec farmos-www drush php:eval '
\$all = array_keys(\\Drupal::service(\"user.permissions\")->getPermissions());
\$role = \\Drupal\\user\\Entity\\Role::load(\"farm_manager\");
foreach (\$all as \$perm) {
  \$role->grantPermission(\$perm);
}
\$role->save();
echo \"Granted \" . count(\$role->getPermissions()) . \"/\" . count(\$all) . \" permissions\";
' 2>/dev/null")
    log "$output"

    # Cache rebuild after permission changes
    $VPS_SSH "docker exec farmos-www drush cr" 2>/dev/null
    log "Cache rebuilt"
}

# ── User Verification ──────────────────────────────────────────────
verify_users() {
    log "Verifying user roles..."

    # Check Denise has farm_manager + farm_account_admin
    local denise_roles
    denise_roles=$($VPS_SSH "docker exec farmos-www drush php:eval '
\$users = \\Drupal::entityTypeManager()->getStorage(\"user\")->loadByProperties([\"name\" => \"denise\"]);
if (\$user = reset(\$users)) {
  echo implode(\", \", \$user->getRoles());
} else {
  echo \"USER NOT FOUND\";
}
' 2>/dev/null" || echo "error")

    log "Denise roles: $denise_roles"

    if echo "$denise_roles" | grep -q "farm_manager"; then
        log "Denise: farm_manager OK"
    else
        log "WARNING: Denise missing farm_manager role"
    fi

    if echo "$denise_roles" | grep -q "farm_account_admin"; then
        log "Denise: farm_account_admin OK"
    else
        log "WARNING: Denise missing farm_account_admin role"
    fi
}

# ── Run ────────────────────────────────────────────────────────────
case "$MODE" in
    perms)
        fix_permissions
        ;;
    module)
        install_module
        ;;
    full)
        install_module
        fix_permissions
        verify_users
        ;;
esac

log "Setup complete"
