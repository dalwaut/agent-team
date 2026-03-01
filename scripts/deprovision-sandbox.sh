#!/usr/bin/env bash
# OPAI Sandbox Deprovisioner — Remove a user sandbox.
#
# Usage:
#   ./scripts/deprovision-sandbox.sh --user-id <uuid> --name <name> [--delete-data]
#
# Without --delete-data: removes symlink, deactivates in Supabase, but keeps NAS files.
# With --delete-data: also deletes all sandbox files from NAS.

set -euo pipefail

OPAI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USERS_ROOT="/workspace/users"

USER_ID=""
USER_NAME=""
DELETE_DATA=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --user-id)     USER_ID="$2"; shift 2 ;;
        --name)        USER_NAME="$2"; shift 2 ;;
        --delete-data) DELETE_DATA=true; shift ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$USER_ID" || -z "$USER_NAME" ]]; then
    echo "Usage: deprovision-sandbox.sh --user-id <uuid> --name <name> [--delete-data]"
    exit 1
fi

SAFE_NAME=$(echo "$USER_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-\|-$//g')
SANDBOX_DIR="${USERS_ROOT}/${SAFE_NAME}"
UUID_LINK="${USERS_ROOT}/${USER_ID}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo "=== OPAI Sandbox Deprovisioner ==="
echo "User: ${USER_NAME} (${USER_ID})"
echo "Sandbox: ${SANDBOX_DIR}"
echo "Delete data: ${DELETE_DATA}"
echo ""

# Remove UUID symlink
if [[ -L "$UUID_LINK" ]]; then
    rm -f "$UUID_LINK"
    log "Removed symlink: ${UUID_LINK}"
else
    warn "Symlink not found: ${UUID_LINK}"
fi

# Optionally delete sandbox data
if [[ "$DELETE_DATA" == true ]]; then
    if [[ -d "$SANDBOX_DIR" ]]; then
        echo "Deleting sandbox data: ${SANDBOX_DIR}"
        rm -rf "$SANDBOX_DIR"
        log "Sandbox data deleted"
    else
        warn "Sandbox directory not found: ${SANDBOX_DIR}"
    fi
else
    echo "Keeping sandbox data at: ${SANDBOX_DIR}"
    echo "  (Use --delete-data to remove)"
fi

# Update Supabase profile
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_SERVICE_KEY="${SUPABASE_SERVICE_KEY:-}"

if [[ -n "$SUPABASE_URL" && -n "$SUPABASE_SERVICE_KEY" ]]; then
    echo "Updating Supabase profile..."
    curl -s -o /dev/null \
        -X PATCH \
        "${SUPABASE_URL}/rest/v1/profiles?id=eq.${USER_ID}" \
        -H "apikey: ${SUPABASE_SERVICE_KEY}" \
        -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
        -H "Content-Type: application/json" \
        -H "Prefer: return=minimal" \
        -d "{
            \"sandbox_provisioned\": false,
            \"is_active\": false
        }"
    log "Supabase profile updated (deactivated)"
else
    warn "SUPABASE_URL or SUPABASE_SERVICE_KEY not set — skipping profile update"
fi

echo ""
echo "=== Deprovision Complete ==="
