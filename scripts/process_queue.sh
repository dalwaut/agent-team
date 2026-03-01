#!/usr/bin/env bash
# ============================================================
# Process deferred operations from the task queue.
# ============================================================
# Reads tasks/queue.json and processes items by type.
# Supports: project-onboard, file-transfer, maintenance.
# Items that can't be completed are retried or marked failed.
#
# Usage:
#   ./scripts/process_queue.sh
#   ./scripts/process_queue.sh --type project-onboard
#   ./scripts/process_queue.sh --list
#   ./scripts/process_queue.sh --dry-run
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPAI_ROOT="$(dirname "$SCRIPT_DIR")"
QUEUE_FILE="$OPAI_ROOT/tasks/queue.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# --- Defaults ---
TYPE_FILTER=""
DRY_RUN=false
LIST=false

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --type|-t)  TYPE_FILTER="$2"; shift 2 ;;
        --dry-run)  DRY_RUN=true; shift ;;
        --list|-l)  LIST=true; shift ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

status() { echo -e "${CYAN}[queue] $1${NC}"; }
ok()     { echo -e "${GREEN}[queue] OK: $1${NC}"; }
warn()   { echo -e "${YELLOW}[queue] WARN: $1${NC}"; }
fail()   { echo -e "${RED}[queue] FAIL: $1${NC}"; }

if [[ ! -f "$QUEUE_FILE" ]]; then
    fail "Queue file not found: $QUEUE_FILE"
    exit 1
fi

# Get pending items (queued or blocked, optionally filtered by type)
get_pending() {
    local filter='select(.status == "queued" or .status == "blocked")'
    if [[ -n "$TYPE_FILTER" ]]; then
        filter="$filter | select(.type == \"$TYPE_FILTER\")"
    fi
    jq -r ".queue[] | $filter" "$QUEUE_FILE"
}

pending_count() {
    local filter='select(.status == "queued" or .status == "blocked")'
    if [[ -n "$TYPE_FILTER" ]]; then
        filter="$filter | select(.type == \"$TYPE_FILTER\")"
    fi
    jq "[.queue[] | $filter] | length" "$QUEUE_FILE"
}

# ── List Mode ──

if [[ "$LIST" == true ]]; then
    status "=== Task Queue ==="
    status ""

    count=$(pending_count)
    if [[ "$count" -eq 0 ]]; then
        ok "No pending items."
    else
        jq -r ".queue[] | select(.status == \"queued\" or .status == \"blocked\") | \"\(.status)|\(.id)|\(.type)|\(.description)|\(.blocked_reason // \"\")\"" "$QUEUE_FILE" | while IFS='|' read -r item_status item_id item_type item_desc item_reason; do
            case "$item_status" in
                queued)  color="$NC" ;;
                blocked) color="$YELLOW" ;;
                *)       color="$GRAY" ;;
            esac
            printf "  ${color}[%-7s]${NC} ${CYAN}%s${NC} ${GRAY}(%s)${NC} %s\n" "${item_status^^}" "$item_id" "$item_type" "$item_desc"
            if [[ -n "$item_reason" ]]; then
                echo -e "           ${YELLOW}Reason: $item_reason${NC}"
            fi
        done
    fi

    status ""
    completed_count=$(jq '.completed | length' "$QUEUE_FILE")
    status "Pending: $count  |  Completed: $completed_count"
    exit 0
fi

# ── Process Mode ──

count=$(pending_count)
if [[ "$count" -eq 0 ]]; then
    ok "No pending items to process."
    exit 0
fi

status "Processing $count queued item(s)..."
[[ "$DRY_RUN" == true ]] && warn "DRY RUN — no changes will be made"

# Process each pending item
jq -c ".queue[] | select(.status == \"queued\" or .status == \"blocked\")" "$QUEUE_FILE" | while IFS= read -r item; do
    item_id=$(echo "$item" | jq -r '.id')
    item_type=$(echo "$item" | jq -r '.type')
    item_desc=$(echo "$item" | jq -r '.description')

    status "─────────────────────────────────────────"
    status "Item: $item_id [$item_type]"
    status "  $item_desc"

    case "$item_type" in
        project-onboard)
            if [[ "$DRY_RUN" == true ]]; then
                status "  Would run: onboard_project.sh --process-queue"
                continue
            fi
            bash "$SCRIPT_DIR/onboard_project.sh" --process-queue
            ;;

        file-transfer)
            src=$(echo "$item" | jq -r '.payload.source')
            dst=$(echo "$item" | jq -r '.payload.destination')

            if [[ ! -e "$src" ]]; then
                retry_count=$(echo "$item" | jq -r '.retry_count // 0')
                max_retries=$(echo "$item" | jq -r '.max_retries // 3')
                retry_count=$((retry_count + 1))
                now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

                if [[ $retry_count -ge $max_retries ]]; then
                    # Mark failed
                    jq --arg id "$item_id" --arg now "$now" \
                        '(.queue[] | select(.id == $id)) |= (.status = "failed" | .retry_count += 1 | .updated = $now)' \
                        "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
                    fail "$item_id: source unavailable after max retries"
                else
                    # Mark blocked, increment retry
                    jq --arg id "$item_id" --arg now "$now" --argjson rc "$retry_count" \
                        '(.queue[] | select(.id == $id)) |= (.status = "blocked" | .retry_count = $rc | .updated = $now)' \
                        "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
                    warn "$item_id: source unavailable (retry $retry_count/$max_retries)"
                fi
                continue
            fi

            if [[ "$DRY_RUN" == true ]]; then
                status "  Would copy: $src -> $dst"
                continue
            fi

            if cp -r "$src" "$dst" 2>/dev/null; then
                now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
                # Move to completed
                jq --arg id "$item_id" --arg now "$now" \
                    '(.queue[] | select(.id == $id)) as $item |
                     .completed += [$item | .status = "completed" | .completed_at = $now | .updated = $now] |
                     .queue = [.queue[] | select(.id != $id)]' \
                    "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
                ok "$item_id completed"
            else
                fail "$item_id: copy failed"
            fi
            ;;

        *)
            warn "$item_id: Unknown type '$item_type' — skipping"
            ;;
    esac
done

status "Queue updated."
