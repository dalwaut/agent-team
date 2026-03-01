#!/usr/bin/env bash
# kill-switch.sh — Emergency stop for an OC instance.
#
# Revokes all credentials, stops the container, and cleans up the tmpfs env file.
# This is the "big red button" — use it when an OC instance is misbehaving.
#
# Usage:
#   ./kill-switch.sh <instance-slug>

set -euo pipefail

SLUG="${1:-}"
BROKER_URL="${OC_BROKER_URL:-http://127.0.0.1:8106}"
SERVICE_KEY="${SUPABASE_SERVICE_KEY:-}"

if [ -z "$SLUG" ]; then
    echo "[oc-kill] ERROR: Usage: kill-switch.sh <instance-slug>" >&2
    exit 1
fi

# Try to source service key from vault if not set
if [ -z "$SERVICE_KEY" ]; then
    VAULT_ENV_SCRIPT="/workspace/synced/opai/tools/opai-vault/scripts/vault-env.sh"
    if [ -x "$VAULT_ENV_SCRIPT" ]; then
        TMPENV=$(mktemp)
        "$VAULT_ENV_SCRIPT" "open-claw" > "$TMPENV" 2>/dev/null || true
        if [ -f "$TMPENV" ] && [ -s "$TMPENV" ]; then
            set -a
            source "$TMPENV"
            set +a
            SERVICE_KEY="${SUPABASE_SERVICE_KEY:-}"
        fi
        rm -f "$TMPENV"
    fi
fi

echo "========================================="
echo "  KILL SWITCH — Instance: $SLUG"
echo "========================================="

# Step 1: Revoke all credentials via broker
echo "[oc-kill] Step 1: Revoking all credentials..."
REVOKE_RESULT=$(curl -s -X POST \
    -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    "$BROKER_URL/oc/api/instances/$SLUG/kill-switch" \
    2>/dev/null || echo '{"error": "broker unreachable"}')
echo "[oc-kill] Broker response: $REVOKE_RESULT"

# Step 2: Stop the Docker container
CONTAINER_NAME="clawbot-$SLUG"
echo "[oc-kill] Step 2: Stopping container '$CONTAINER_NAME'..."
if docker ps -q -f "name=$CONTAINER_NAME" | grep -q .; then
    docker stop "$CONTAINER_NAME" --time 5 2>/dev/null && \
        echo "[oc-kill] Container stopped" || \
        echo "[oc-kill] WARNING: docker stop failed — trying kill"
    # Force kill if stop didn't work
    if docker ps -q -f "name=$CONTAINER_NAME" | grep -q .; then
        docker kill "$CONTAINER_NAME" 2>/dev/null && \
            echo "[oc-kill] Container killed" || \
            echo "[oc-kill] WARNING: Container may still be running"
    fi
else
    echo "[oc-kill] Container not running"
fi

# Step 3: Clean up tmpfs credential file
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
ENV_FILE="$RUNTIME_DIR/opai-oc/$SLUG.env"
if [ -f "$ENV_FILE" ]; then
    rm -f "$ENV_FILE"
    echo "[oc-kill] Step 3: Cleaned up tmpfs env file"
else
    echo "[oc-kill] Step 3: No tmpfs env file to clean"
fi

echo "========================================="
echo "  KILL SWITCH COMPLETE"
echo "  Instance: $SLUG"
echo "  Status: credentials revoked, container stopped"
echo "========================================="
