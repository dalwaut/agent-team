#!/usr/bin/env bash
# inject-credentials.sh — Fetch credentials from the OC broker and write to a Docker env file.
#
# Called by the container provisioning/start flow, NOT by the container itself.
# The broker enforces the access manifest: only granted credentials are returned.
#
# Usage:
#   ./inject-credentials.sh <instance-slug> [output-file]
#
# If output-file is omitted, writes to $XDG_RUNTIME_DIR/opai-oc/<slug>.env (tmpfs)
# Exit codes:
#   0 = success
#   1 = missing arguments
#   2 = broker unreachable
#   3 = instance not found
#   4 = write failed

set -euo pipefail

SLUG="${1:-}"
OUTPUT="${2:-}"
BROKER_URL="${OC_BROKER_URL:-http://127.0.0.1:8106}"
SERVICE_KEY="${SUPABASE_SERVICE_KEY:-}"

if [ -z "$SLUG" ]; then
    echo "[oc-inject] ERROR: Usage: inject-credentials.sh <instance-slug> [output-file]" >&2
    exit 1
fi

# Resolve output path (tmpfs by default — credentials never touch persistent disk)
if [ -z "$OUTPUT" ]; then
    RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    OC_ENV_DIR="$RUNTIME_DIR/opai-oc"
    mkdir -p "$OC_ENV_DIR"
    chmod 700 "$OC_ENV_DIR"
    OUTPUT="$OC_ENV_DIR/$SLUG.env"
fi

# Need service key for auth
if [ -z "$SERVICE_KEY" ]; then
    # Try to get it from the vault
    VAULT_ENV_SCRIPT="/workspace/synced/opai/tools/opai-vault/scripts/vault-env.sh"
    if [ -x "$VAULT_ENV_SCRIPT" ]; then
        # Source the vault env for open-claw broker credentials
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

if [ -z "$SERVICE_KEY" ]; then
    echo "[oc-inject] ERROR: SUPABASE_SERVICE_KEY not set and vault-env.sh unavailable" >&2
    exit 2
fi

# Fetch credentials from broker
echo "[oc-inject] Fetching credentials for instance '$SLUG'..."
HTTP_CODE=$(curl -s -o /tmp/oc-inject-$$.body -w "%{http_code}" \
    -H "Authorization: Bearer $SERVICE_KEY" \
    "$BROKER_URL/oc/api/instances/$SLUG/inject?format=env" \
    2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "000" ]; then
    echo "[oc-inject] ERROR: Broker unreachable at $BROKER_URL" >&2
    rm -f /tmp/oc-inject-$$.body
    exit 2
fi

if [ "$HTTP_CODE" = "404" ]; then
    echo "[oc-inject] ERROR: Instance '$SLUG' not found" >&2
    rm -f /tmp/oc-inject-$$.body
    exit 3
fi

if [ "$HTTP_CODE" != "200" ]; then
    echo "[oc-inject] ERROR: Broker returned HTTP $HTTP_CODE" >&2
    cat /tmp/oc-inject-$$.body >&2 2>/dev/null
    rm -f /tmp/oc-inject-$$.body
    exit 2
fi

# Write credentials to output file
mv /tmp/oc-inject-$$.body "$OUTPUT"
chmod 600 "$OUTPUT"

CRED_COUNT=$(wc -l < "$OUTPUT" | tr -d ' ')
echo "[oc-inject] Wrote $CRED_COUNT credentials to $OUTPUT (chmod 600)"
