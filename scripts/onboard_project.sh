#!/usr/bin/env bash
# ============================================================
# Onboard an external project into Projects/ with
# diamond workflow scaffolding.
# ============================================================
# Moves or copies a project from an external location into the
# OPAI workspace. Creates diamond workflow structure, generates
# PROJECT.md, and queues follow-up tasks. Falls back to queue
# mode if the source is unavailable.
#
# Usage:
#   ./scripts/onboard_project.sh --source /path/to/project --name ProjectName
#   ./scripts/onboard_project.sh --process-queue
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPAI_ROOT="$(dirname "$SCRIPT_DIR")"
PROJECTS_DIR="$OPAI_ROOT/Projects"
QUEUE_FILE="$OPAI_ROOT/tasks/queue.json"
REPORTS_DIR="$OPAI_ROOT/reports"
LATEST_DIR="$REPORTS_DIR/latest"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# --- Defaults ---
SOURCE=""
NAME=""
MOVE=false
FORCE=false
PROCESS_QUEUE=false

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --source|-s)       SOURCE="$2"; shift 2 ;;
        --name|-n)         NAME="$2"; shift 2 ;;
        --move)            MOVE=true; shift ;;
        --force)           FORCE=true; shift ;;
        --process-queue)   PROCESS_QUEUE=true; shift ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

status() { echo -e "${CYAN}[onboard] $1${NC}"; }
ok()     { echo -e "${GREEN}[onboard] OK: $1${NC}"; }
warn()   { echo -e "${YELLOW}[onboard] WARN: $1${NC}"; }
fail()   { echo -e "${RED}[onboard] FAIL: $1${NC}"; }

# --- Helpers ---

get_next_queue_id() {
    local today
    today=$(date +%Y%m%d)
    if [[ ! -f "$QUEUE_FILE" ]]; then
        echo "q-${today}-001"
        return
    fi
    local max_num
    max_num=$(jq -r --arg today "$today" \
        '[(.queue[]?, .completed[]?) | select(.id | startswith("q-" + $today)) | .id | split("-")[2] | tonumber] | max // 0' \
        "$QUEUE_FILE")
    printf "q-%s-%03d" "$today" $((max_num + 1))
}

add_to_queue() {
    local type="$1" desc="$2" payload="$3" priority="${4:-normal}" blocked_reason="${5:-}"
    local now
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local queue_id
    queue_id=$(get_next_queue_id)
    local status_val="queued"
    [[ -n "$blocked_reason" ]] && status_val="blocked"

    jq --arg id "$queue_id" --arg type "$type" --arg status "$status_val" \
       --arg priority "$priority" --arg now "$now" --arg desc "$desc" \
       --argjson payload "$payload" --arg reason "$blocked_reason" \
       '.queue += [{
           id: $id, type: $type, status: $status, priority: $priority,
           created: $now, updated: $now, description: $desc,
           payload: $payload, blocked_reason: $reason,
           retry_count: 0, max_retries: 3
       }]' "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"

    ok "Queued: $queue_id — $desc"
    echo "$queue_id"
}

create_diamond_scaffold() {
    local dest_path="$1" project_name="$2"
    local dirs=("Research" "Dev-Plan" "Agent-Tasks" "Codebase" "Notes" "Review-log" "Debug-log")
    for dir in "${dirs[@]}"; do
        mkdir -p "$dest_path/$dir"
    done

    cat > "$dest_path/PROJECT.md" <<PROJECTMD
# $project_name

## Status
- **Onboarded:** $(date +%Y-%m-%d)
- **Origin:** External project brought into OPAI workspace
- **Workflow:** Diamond (Research -> Dev-Plan -> Tasks -> Build -> Logs/Notes)

## Quick Links
- Codebase: \`Codebase/\`
- Dev Plan: \`Dev-Plan/\`
- Agent Tasks: \`Agent-Tasks/\`

## Notes
Onboarded via \`scripts/onboard_project.sh\`. See status report in \`reports/\` for full analysis.
PROJECTMD

    ok "Diamond scaffold created at $dest_path"
}

# ── Process Queue Mode ──

if [[ "$PROCESS_QUEUE" == true ]]; then
    status "Processing queued onboarding tasks..."

    if [[ ! -f "$QUEUE_FILE" ]]; then
        ok "Queue file not found. Nothing to process."
        exit 0
    fi

    count=$(jq '[.queue[] | select(.type == "project-onboard" and (.status == "queued" or .status == "blocked"))] | length' "$QUEUE_FILE")
    if [[ "$count" -eq 0 ]]; then
        ok "No pending onboarding tasks in queue."
        exit 0
    fi

    jq -c '.queue[] | select(.type == "project-onboard" and (.status == "queued" or .status == "blocked"))' "$QUEUE_FILE" | while IFS= read -r item; do
        item_id=$(echo "$item" | jq -r '.id')
        item_desc=$(echo "$item" | jq -r '.description')
        src=$(echo "$item" | jq -r '.payload.source')
        dest=$(echo "$item" | jq -r '.payload.destination')
        project_name=$(echo "$item" | jq -r '.payload.project_name')

        status "Processing $item_id: $item_desc"

        if [[ ! -d "$src" ]]; then
            retry_count=$(echo "$item" | jq -r '.retry_count // 0')
            max_retries=$(echo "$item" | jq -r '.max_retries // 3')
            retry_count=$((retry_count + 1))
            now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

            if [[ $retry_count -ge $max_retries ]]; then
                jq --arg id "$item_id" --arg now "$now" --arg reason "Source path unavailable after max retries: $src" \
                    '(.queue[] | select(.id == $id)) |= (.status = "failed" | .blocked_reason = $reason | .retry_count += 1 | .updated = $now)' \
                    "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
                fail "$item_id failed: source still unavailable after max attempts"
            else
                jq --arg id "$item_id" --arg now "$now" --argjson rc "$retry_count" \
                    --arg reason "Source path unavailable (retry $rc): $src" \
                    '(.queue[] | select(.id == $id)) |= (.status = "blocked" | .blocked_reason = $reason | .retry_count = $rc | .updated = $now)' \
                    "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
                warn "$item_id blocked: source unavailable (retry $retry_count)"
            fi
            continue
        fi

        # Source is available — proceed
        now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        jq --arg id "$item_id" --arg now "$now" \
            '(.queue[] | select(.id == $id)) |= (.status = "in_progress" | .updated = $now)' \
            "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"

        if create_diamond_scaffold "$dest" "$project_name" && \
           cp -r "$src"/* "$dest/Codebase/" 2>/dev/null; then
            now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
            jq --arg id "$item_id" --arg now "$now" \
                '(.queue[] | select(.id == $id)) as $item |
                 .completed += [$item | .status = "completed" | .completed_at = $now | .updated = $now] |
                 .queue = [.queue[] | select(.id != $id)]' \
                "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
            ok "$item_id completed: $project_name onboarded"
        else
            now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
            jq --arg id "$item_id" --arg now "$now" \
                '(.queue[] | select(.id == $id)) |= (.status = "failed" | .blocked_reason = "Error during onboarding" | .updated = $now)' \
                "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
            fail "$item_id error during onboarding"
        fi
    done

    status "Queue processing complete."
    exit 0
fi

# ── Direct Onboard Mode ──

if [[ -z "$SOURCE" || -z "$NAME" ]]; then
    fail "Usage: $0 --source <path> --name <ProjectName>"
    fail "   or: $0 --process-queue"
    exit 1
fi

DESTINATION="$PROJECTS_DIR/$NAME"

status "Onboarding: $NAME"
status "  Source:      $SOURCE"
status "  Destination: $DESTINATION"

# Check if destination already exists
if [[ -d "$DESTINATION" ]]; then
    warn "Destination already exists: $DESTINATION"
    if [[ "$FORCE" != true ]]; then
        read -rp "Overwrite? (y/N) " confirm
        [[ "${confirm,,}" != "y" ]] && { status "Aborted."; exit 0; }
    fi
fi

# Check if source is accessible
if [[ ! -d "$SOURCE" ]]; then
    warn "Source path is not accessible: $SOURCE"
    status "Queueing for later processing..."

    payload=$(jq -nc --arg name "$NAME" --arg src "$SOURCE" --arg dest "$DESTINATION" '{
        project_name: $name, source: $src, destination: $dest,
        steps: [
            "Verify source path is accessible",
            "Create destination folder with diamond scaffold",
            "Copy source files into Codebase/",
            "Generate PROJECT.md from status report",
            "Generate CLAUDE.md with tech stack and conventions",
            "Save onboarding report to reports/"
        ]
    }')

    queue_id=$(add_to_queue "project-onboard" \
        "Move $NAME from external location into Projects/$NAME" \
        "$payload" "normal" "Source path not accessible: $SOURCE")

    status "Queued as $queue_id. Run with --process-queue later to retry."
    exit 0
fi

# Source is available — proceed
if [[ "$FORCE" != true ]]; then
    status "Ready to onboard. This will:"
    status "  1. Create diamond scaffold at $DESTINATION"
    if [[ "$MOVE" == true ]]; then
        status "  2. MOVE source files into Codebase/ (source will be removed)"
    else
        status "  2. Copy source files into Codebase/"
    fi
    status "  3. Generate PROJECT.md"
    read -rp "Proceed? (Y/n) " confirm
    [[ "${confirm,,}" == "n" ]] && { status "Aborted."; exit 0; }
fi

# Create diamond scaffold
create_diamond_scaffold "$DESTINATION" "$NAME"

# Copy or move source into Codebase/
CODEBASE_DEST="$DESTINATION/Codebase"
if [[ "$MOVE" == true ]]; then
    status "Moving from $SOURCE to $CODEBASE_DEST..."
    mv "$SOURCE"/* "$CODEBASE_DEST/"
    ok "Source files moved (original location cleared)"
else
    status "Copying from $SOURCE to $CODEBASE_DEST..."
    cp -r "$SOURCE"/* "$CODEBASE_DEST/"
    ok "Source files copied"
fi

# Save report
today=$(date +%Y-%m-%d)
report_dir="$REPORTS_DIR/$today"
mkdir -p "$report_dir" "$LATEST_DIR"

method="Copy"
[[ "$MOVE" == true ]] && method="Move"

report_file="$report_dir/onboard-$(echo "$NAME" | tr '[:upper:]' '[:lower:]').md"
cat > "$report_file" <<REPORT
# $NAME — Onboarding Report

**Date:** $today
**Source:** $SOURCE
**Destination:** $DESTINATION
**Method:** $method
**Diamond Scaffold:** Created
**PROJECT.md:** Generated

## Next Steps
- Run familiarize squad: \`./scripts/run_squad.sh -s familiarize --skip-preflight\`
- Generate CLAUDE.md for the project
- Initialize git if not present
- Connect to Supabase if applicable
REPORT

cp "$report_file" "$LATEST_DIR/onboard-$(echo "$NAME" | tr '[:upper:]' '[:lower:]').md"

ok "$NAME onboarded successfully at $DESTINATION"
status "Report saved to $report_file"
