#!/usr/bin/env bash
# ============================================================
# tg-notify.sh — Reusable Telegram notification helper
# ============================================================
# Send a message to Dallas's Telegram via the bot API.
# Token sourced from Vault (preferred) or .env fallback.
#
# Usage:
#   ./scripts/tg-notify.sh "Your message here"
#   ./scripts/tg-notify.sh --html "<b>Bold</b> message"
#   echo "Piped message" | ./scripts/tg-notify.sh --stdin
#   ./scripts/tg-notify.sh --chat-id 12345 "Message to specific chat"
#
# Exit codes:
#   0 = sent (or dry run)
#   1 = no token available
#   2 = send failed
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPAI_ROOT="$(dirname "$SCRIPT_DIR")"
VAULT_CLI="$OPAI_ROOT/tools/opai-vault/scripts/vault-cli.sh"

# Dallas personal DM (default)
DEFAULT_CHAT_ID="1666403499"
# OPAI Admin group
ADMIN_GROUP_CHAT_ID="-1003761890007"

# ── Parse args ──────────────────────────────────────────────
CHAT_ID="$DEFAULT_CHAT_ID"
PARSE_MODE="HTML"
USE_STDIN=false
DRY_RUN=false
MESSAGE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --chat-id)     CHAT_ID="$2"; shift 2 ;;
        --group)       CHAT_ID="$ADMIN_GROUP_CHAT_ID"; shift ;;
        --html)        PARSE_MODE="HTML"; shift ;;
        --markdown)    PARSE_MODE="MarkdownV2"; shift ;;
        --stdin)       USE_STDIN=true; shift ;;
        --dry-run)     DRY_RUN=true; shift ;;
        -*)            echo "Unknown flag: $1" >&2; exit 1 ;;
        *)             MESSAGE="$1"; shift ;;
    esac
done

# Read from stdin if flagged
if $USE_STDIN; then
    MESSAGE=$(cat)
fi

if [[ -z "$MESSAGE" ]]; then
    echo "Usage: tg-notify.sh [--html|--group|--chat-id ID] \"message\"" >&2
    exit 1
fi

# ── Get token ───────────────────────────────────────────────
get_tg_token() {
    local token=""
    # Try vault first
    if [[ -x "$VAULT_CLI" ]]; then
        token=$("$VAULT_CLI" get TELEGRAM_BOT_TOKEN 2>/dev/null || echo "")
    fi
    # Fallback to .env
    if [[ -z "$token" ]]; then
        token=$(grep '^TELEGRAM_BOT_TOKEN=' "$OPAI_ROOT/tools/opai-telegram/.env" 2>/dev/null | cut -d= -f2 || echo "")
    fi
    echo "$token"
}

TOKEN=$(get_tg_token)
if [[ -z "$TOKEN" ]]; then
    echo "[tg-notify] No Telegram token available" >&2
    exit 1
fi

# ── Send ────────────────────────────────────────────────────
if $DRY_RUN; then
    echo "[tg-notify] DRY RUN — would send to $CHAT_ID:"
    echo "$MESSAGE"
    exit 0
fi

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${MESSAGE}" \
    -d "parse_mode=${PARSE_MODE}" \
    --max-time 15 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" == "200" ]]; then
    exit 0
else
    echo "[tg-notify] Send failed (HTTP $HTTP_CODE)" >&2
    exit 2
fi
