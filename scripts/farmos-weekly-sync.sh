#!/bin/bash
#
# farmOS Weekly Sync — Backup, update check, merge, deploy & verify.
#
# Runs as a weekly systemd timer (Sunday 4 AM). Backs up the current
# farmOS state, checks for upstream updates, merges, deploys to BB VPS,
# and verifies. Stops on first failure, alerts via Telegram, creates
# TeamHub tasks for failures.
#
# Usage:
#   ./scripts/farmos-weekly-sync.sh                  # Full run
#   ./scripts/farmos-weekly-sync.sh --dry-run        # Read-only preview
#   ./scripts/farmos-weekly-sync.sh --from-phase 4   # Resume from phase N
#   ./scripts/farmos-weekly-sync.sh --test-fail 3    # Simulate failure at phase N
#

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────
OPAI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_NAME="farmos-weekly-sync"
LOG_FILE="$OPAI_ROOT/logs/farmos-sync.log"
SUMMARY_FILE="$OPAI_ROOT/logs/farmos-sync-latest.json"
VAULT_CLI="$OPAI_ROOT/tools/opai-vault/scripts/vault-cli.sh"
SETUP_SCRIPT="$OPAI_ROOT/scripts/farmos-setup.sh"

# Remote
VPS_SSH="ssh -i $HOME/.ssh/bb_vps -o ConnectTimeout=10 -o StrictHostKeyChecking=no root@bb-vps"
VPS_SCP="scp -i $HOME/.ssh/bb_vps -o ConnectTimeout=10 -o StrictHostKeyChecking=no"
FARMOS_COMPOSE_DIR="/opt/farmos"
FARMOS_MODULE_PATH="/opt/drupal/web/modules/custom/farm_map_free"
FARMOS_URL="https://farm.morningdewhomestead.com"

# Local paths
DEPLOY_DIR="$OPAI_ROOT/Projects/FarmOS/deploy"
BACKUP_DIR="$DEPLOY_DIR/backups"
MODULE_DIR="$DEPLOY_DIR/custom-modules/farm_map_free"
REPO_DIR="$OPAI_ROOT/Projects/FarmOS/repo"

# Telegram — Dallas personal DM (not group chat)
TG_CHAT_ID="1666403499"
TEAMHUB_URL="http://localhost:8089/api"

# ── Flags ──────────────────────────────────────────────────────────
DRY_RUN=false
FROM_PHASE=1
TEST_FAIL=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)     DRY_RUN=true; shift ;;
        --from-phase)  FROM_PHASE="$2"; shift 2 ;;
        --test-fail)   TEST_FAIL="$2"; shift 2 ;;
        *)             echo "Unknown flag: $1"; exit 1 ;;
    esac
done

# ── State tracking ─────────────────────────────────────────────────
RUN_START=$(date +%s)
CURRENT_PHASE=0
PHASE_RESULTS=()
TG_LINES=()
FAILED_PHASE=""
FAIL_ERROR=""
DB_SIZE=""
MODULE_COUNT=0
UPSTREAM_COMMITS=0
IMAGE_UPDATED=false
TEAMHUB_TASK_ID=""

# ── Logging ────────────────────────────────────────────────────────
mkdir -p "$(dirname "$LOG_FILE")" "$BACKUP_DIR"

# Rotate log: keep last 500 lines from previous runs
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -gt 500 ]]; then
    tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

log() {
    local level="$1"; shift
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*"
    echo "$msg" | tee -a "$LOG_FILE"
}

log_header() {
    echo "" >> "$LOG_FILE"
    echo "═══════════════════════════════════════════════════════════" >> "$LOG_FILE"
    echo "  farmOS Weekly Sync — $(date '+%Y-%m-%d %H:%M:%S %Z')" >> "$LOG_FILE"
    if $DRY_RUN; then echo "  MODE: DRY RUN" >> "$LOG_FILE"; fi
    if [[ $FROM_PHASE -gt 1 ]]; then echo "  RESUME FROM: Phase $FROM_PHASE" >> "$LOG_FILE"; fi
    echo "═══════════════════════════════════════════════════════════" >> "$LOG_FILE"
}

# ── Telegram ───────────────────────────────────────────────────────
get_tg_token() {
    if [[ -z "${TG_TOKEN:-}" ]]; then
        TG_TOKEN=$("$VAULT_CLI" get TELEGRAM_BOT_TOKEN 2>/dev/null || echo "")
        if [[ -z "$TG_TOKEN" ]]; then
            # Fallback: read from .env
            TG_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$OPAI_ROOT/tools/opai-telegram/.env" 2>/dev/null | cut -d= -f2 || echo "")
        fi
    fi
    echo "$TG_TOKEN"
}

tg_send() {
    local msg="$1"
    local token
    token=$(get_tg_token)
    if [[ -z "$token" ]]; then
        log "WARN" "No Telegram token — skipping notification"
        return 0
    fi
    if $DRY_RUN; then
        msg="[DRY RUN] $msg"
    fi
    curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
        -d "chat_id=${TG_CHAT_ID}" \
        -d "text=${msg}" \
        -d "parse_mode=HTML" \
        --max-time 15 > /dev/null 2>&1 || log "WARN" "Telegram send failed (non-fatal)"
}

# ── TeamHub task creation ──────────────────────────────────────────
get_dallas_uuid() {
    # Use supabase-sql to look up Dallas's UUID
    local uuid
    uuid=$("$OPAI_ROOT/scripts/supabase-sql.sh" \
        "SELECT id FROM profiles WHERE email LIKE 'dal%' AND role = 'admin' LIMIT 1" 2>/dev/null \
        | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
        | head -1 || echo "")
    if [[ -z "$uuid" ]]; then
        uuid="1c93c5fe-d304-40f2-9169-765d0d2b7638"  # Known fallback
    fi
    echo "$uuid"
}

create_teamhub_task() {
    local title="$1"
    local description="$2"
    local priority="${3:-high}"
    local due_date
    due_date=$(date -d "+1 day" '+%Y-%m-%d' 2>/dev/null || date '+%Y-%m-%d')
    local user_id
    user_id=$(get_dallas_uuid)

    if $DRY_RUN; then
        log "INFO" "[DRY] Would create TeamHub task: $title"
        echo "dry-run-task-id"
        return 0
    fi

    # URL-encode the description
    local encoded_desc
    encoded_desc=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$description'''))" 2>/dev/null || echo "")

    local response
    response=$(curl -s -X POST "${TEAMHUB_URL}/internal/create-item" \
        -G \
        --data-urlencode "user_id=${user_id}" \
        --data-urlencode "title=${title}" \
        --data-urlencode "type=task" \
        --data-urlencode "description=${description}" \
        --data-urlencode "priority=${priority}" \
        --data-urlencode "source=farmos-sync" \
        --data-urlencode "assignee_id=${user_id}" \
        --data-urlencode "due_date=${due_date}" \
        --max-time 15 2>/dev/null || echo "")

    local task_id
    task_id=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
    echo "$task_id"
}

# ── Duration formatting ───────────────────────────────────────────
fmt_duration() {
    local secs=$1
    printf "%dm %ds" $((secs / 60)) $((secs % 60))
}

# ── Summary JSON ───────────────────────────────────────────────────
write_summary() {
    local status="${1:-success}"
    local total_dur=$(( $(date +%s) - RUN_START ))
    local ts
    ts=$(date '+%Y-%m-%dT%H:%M:%S%z')

    cat > "$SUMMARY_FILE" <<ENDJSON
{
  "timestamp": "$ts",
  "status": "$status",
  "dry_run": $DRY_RUN,
  "failed_phase": ${FAILED_PHASE:+\"$FAILED_PHASE\"},
  "error": ${FAIL_ERROR:+\"$(echo "$FAIL_ERROR" | head -1 | sed 's/"/\\"/g')\"},
  "phases": {$(IFS=,; echo "${PHASE_RESULTS[*]}")
  },
  "total_duration_s": $total_dur,
  "teamhub_task_id": ${TEAMHUB_TASK_ID:+\"$TEAMHUB_TASK_ID\"},
  "log_file": "$LOG_FILE"
}
ENDJSON
    # Fix null values
    sed -i 's/: ,/: null,/g; s/: $/: null/g; s/: }$/: null}/g' "$SUMMARY_FILE"
}

# ── Error handler ──────────────────────────────────────────────────
on_failure() {
    local phase_name="$1"
    local error_msg="$2"
    local extra_context="${3:-}"

    FAILED_PHASE="$phase_name"
    FAIL_ERROR="$error_msg"

    log "ERROR" "Phase $phase_name FAILED: $error_msg"

    # Build description for TeamHub
    local completed_phases=""
    for line in "${TG_LINES[@]}"; do
        completed_phases+="$line\n"
    done

    local task_desc="farmOS Weekly Sync failed at $phase_name.

Error: $error_msg

Completed before failure:
$completed_phases

$extra_context

Log file: $LOG_FILE"

    local priority="high"
    if [[ "$phase_name" == "deploy" ]] || [[ "$phase_name" == "verify" ]]; then
        priority="critical"
    fi

    TEAMHUB_TASK_ID=$(create_teamhub_task \
        "farmOS Sync Failed: $phase_name — $(echo "$error_msg" | head -c 80)" \
        "$task_desc" \
        "$priority")

    log "INFO" "TeamHub task created: $TEAMHUB_TASK_ID"

    # Build failure Telegram message
    local dur
    dur=$(fmt_duration $(( $(date +%s) - RUN_START )))
    local tg_msg
    tg_msg="farmOS Weekly Sync — FAILED
━━━━━━━━━━━━━━━━━━

$(printf '%s\n' "${TG_LINES[@]}")
Phase: $phase_name FAILED

Error: $(echo "$error_msg" | head -c 200)
${extra_context:+
$extra_context}

${TEAMHUB_TASK_ID:+Task created: $TEAMHUB_TASK_ID
}
Log: logs/farmos-sync.log
Duration: $dur"

    tg_send "$tg_msg"
    write_summary "failed"
    exit 1
}

# ── Phase 1: Backup ───────────────────────────────────────────────
phase_backup() {
    CURRENT_PHASE=1
    local phase_start=$(date +%s)
    log "PHASE 1" "Backup — starting"

    # Test SSH connectivity
    if ! $VPS_SSH "echo ok" > /dev/null 2>&1; then
        on_failure "backup" "Cannot SSH to BB VPS"
    fi

    # 1a. Dump database
    log "PHASE 1" "Dumping PostgreSQL database..."
    if $DRY_RUN; then
        log "PHASE 1" "[DRY] Would dump database"
        DB_SIZE="(dry run)"
    else
        $VPS_SSH "docker exec farmos-db pg_dump -U farm farm" > "$BACKUP_DIR/farmos-latest.sql" 2>> "$LOG_FILE"
        DB_SIZE=$(du -h "$BACKUP_DIR/farmos-latest.sql" | cut -f1)
        log "PHASE 1" "Database dump: $DB_SIZE"
    fi

    # 1b. Copy custom module files
    log "PHASE 1" "Backing up farm_map_free module..."
    mkdir -p "$MODULE_DIR"
    if $DRY_RUN; then
        log "PHASE 1" "[DRY] Would copy module files"
        MODULE_COUNT=6
    else
        # Copy module files from container via VPS
        local tmp_tar="/tmp/farm_map_free_backup.tar.gz"
        $VPS_SSH "docker exec farmos-www tar czf /tmp/farm_map_free.tar.gz -C /opt/drupal/web/modules/custom farm_map_free && docker cp farmos-www:/tmp/farm_map_free.tar.gz /tmp/" 2>> "$LOG_FILE"
        $VPS_SCP "root@bb-vps:/tmp/farm_map_free.tar.gz" "$tmp_tar" 2>> "$LOG_FILE"
        tar xzf "$tmp_tar" -C "$DEPLOY_DIR/custom-modules/" 2>> "$LOG_FILE"
        rm -f "$tmp_tar"
        MODULE_COUNT=$(find "$MODULE_DIR" -type f | wc -l)
        log "PHASE 1" "Module files backed up: $MODULE_COUNT files"
    fi

    # 1c. Copy docker-compose.yml
    log "PHASE 1" "Backing up docker-compose.yml..."
    if $DRY_RUN; then
        log "PHASE 1" "[DRY] Would copy docker-compose.yml"
    else
        $VPS_SCP "root@bb-vps:$FARMOS_COMPOSE_DIR/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml" 2>> "$LOG_FILE"
        log "PHASE 1" "docker-compose.yml backed up"
    fi

    # 1d. Export Drupal config
    log "PHASE 1" "Exporting Drupal config..."
    if $DRY_RUN; then
        log "PHASE 1" "[DRY] Would export Drupal config"
    else
        $VPS_SSH "docker exec farmos-www drush config:export --destination=/tmp/farmos-config -y 2>/dev/null && \
            cd /tmp && tar czf farmos-config.tar.gz farmos-config/ && rm -rf farmos-config/" 2>> "$LOG_FILE" || true
        mkdir -p "$DEPLOY_DIR/config-export"
        $VPS_SCP "root@bb-vps:/tmp/farmos-config.tar.gz" "/tmp/farmos-config.tar.gz" 2>> "$LOG_FILE" || true
        if [[ -f /tmp/farmos-config.tar.gz ]]; then
            tar xzf /tmp/farmos-config.tar.gz -C "$DEPLOY_DIR/config-export/" 2>> "$LOG_FILE" || true
            rm -f /tmp/farmos-config.tar.gz
            log "PHASE 1" "Drupal config exported"
        else
            log "WARN" "Drupal config export skipped (non-fatal)"
        fi
    fi

    local dur=$(( $(date +%s) - phase_start ))
    PHASE_RESULTS+=("
    \"backup\": {\"status\": \"ok\", \"db_size\": \"$DB_SIZE\", \"module_files\": $MODULE_COUNT, \"duration_s\": $dur}")
    TG_LINES+=("Phase 1/5: Backup ✅
  DB: $DB_SIZE | Module: $MODULE_COUNT files | Config: exported")
    log "PHASE 1" "Backup complete ($dur s)"
}

# ── Phase 2: Check for Upstream Updates ────────────────────────────
phase_update_check() {
    CURRENT_PHASE=2
    local phase_start=$(date +%s)
    log "PHASE 2" "Checking for upstream updates..."

    if [[ ! -d "$REPO_DIR/.git" ]]; then
        on_failure "update_check" "farmOS repo not found at $REPO_DIR"
    fi

    cd "$REPO_DIR"

    # Ensure upstream remote exists
    if ! git remote | grep -q upstream; then
        log "PHASE 2" "Adding upstream remote..."
        if ! $DRY_RUN; then
            git remote add upstream https://github.com/farmOS/farmOS.git 2>> "$LOG_FILE"
        fi
    fi

    # Fetch upstream
    log "PHASE 2" "Fetching upstream..."
    git fetch upstream 2>> "$LOG_FILE" || on_failure "update_check" "Failed to fetch upstream"

    # Compare
    local counts
    counts=$(git rev-list --left-right --count origin/4.x...upstream/4.x 2>/dev/null || echo "0 0")
    local behind
    behind=$(echo "$counts" | awk '{print $2}')
    UPSTREAM_COMMITS=$behind

    local dur=$(( $(date +%s) - phase_start ))

    if [[ "$behind" == "0" ]]; then
        log "PHASE 2" "No upstream updates found"
        PHASE_RESULTS+=("
    \"update_check\": {\"status\": \"ok\", \"upstream_commits\": 0, \"duration_s\": $dur}")
        TG_LINES+=("Phase 2/5: Update Check ✅
  No upstream updates. All done.")

        # Send success-no-updates telegram
        local total_dur
        total_dur=$(fmt_duration $(( $(date +%s) - RUN_START )))
        tg_send "farmOS Weekly Sync
━━━━━━━━━━━━━━━━━━

$(printf '%s\n' "${TG_LINES[@]}")

Duration: $total_dur"

        write_summary "success"
        cd "$OPAI_ROOT"
        log "INFO" "No updates — exiting cleanly"
        exit 0
    fi

    log "PHASE 2" "Found $behind new upstream commit(s)"
    # Log commit summaries
    git log --oneline "origin/4.x..upstream/4.x" 2>/dev/null | head -20 >> "$LOG_FILE"

    PHASE_RESULTS+=("
    \"update_check\": {\"status\": \"ok\", \"upstream_commits\": $behind, \"duration_s\": $dur}")
    TG_LINES+=("Phase 2/5: Update Check ✅
  $behind new upstream commit(s) found")
    log "PHASE 2" "Update check complete ($dur s)"
    cd "$OPAI_ROOT"
}

# ── Phase 3: Merge Upstream ────────────────────────────────────────
phase_merge() {
    CURRENT_PHASE=3
    local phase_start=$(date +%s)
    log "PHASE 3" "Merging upstream into fork..."

    cd "$REPO_DIR"
    git checkout 4.x 2>> "$LOG_FILE" || on_failure "merge" "Failed to checkout 4.x branch"

    if $DRY_RUN; then
        log "PHASE 3" "[DRY] Would merge upstream/4.x"
        # Test if merge would succeed
        if git merge --no-commit --no-ff upstream/4.x > /dev/null 2>&1; then
            log "PHASE 3" "[DRY] Merge would succeed (no conflicts)"
            git merge --abort 2>/dev/null || true
        else
            local conflicts
            conflicts=$(git diff --name-only --diff-filter=U 2>/dev/null || echo "unknown")
            git merge --abort 2>/dev/null || true
            log "PHASE 3" "[DRY] Merge would have conflicts: $conflicts"
        fi
    else
        # Actual merge
        local merge_output
        if merge_output=$(git merge upstream/4.x 2>&1); then
            log "PHASE 3" "Merge successful"
            echo "$merge_output" >> "$LOG_FILE"

            # Push to origin
            git push origin 4.x 2>> "$LOG_FILE" || on_failure "merge" "Merge succeeded but push to origin failed"
            log "PHASE 3" "Pushed to origin/4.x"
        else
            # Merge conflict
            local conflicts
            conflicts=$(git diff --name-only --diff-filter=U 2>/dev/null | head -20)
            git merge --abort 2>/dev/null || true

            local extra="Conflicting files:
$conflicts

Next steps:
  1. cd Projects/FarmOS/repo/
  2. git merge upstream/4.x
  3. Resolve conflicts manually
  4. git add . && git commit && git push origin 4.x
  5. Run: ./scripts/farmos-weekly-sync.sh --from-phase 4"

            on_failure "merge" "Merge conflict" "$extra"
        fi
    fi

    local dur=$(( $(date +%s) - phase_start ))
    PHASE_RESULTS+=("
    \"merge\": {\"status\": \"ok\", \"commits_merged\": $UPSTREAM_COMMITS, \"duration_s\": $dur}")
    TG_LINES+=("Phase 3/5: Merge ✅
  Merged $UPSTREAM_COMMITS commit(s) (no conflicts)")
    log "PHASE 3" "Merge complete ($dur s)"
    cd "$OPAI_ROOT"
}

# ── Phase 4: Deploy to VPS ─────────────────────────────────────────
phase_deploy() {
    CURRENT_PHASE=4
    local phase_start=$(date +%s)
    log "PHASE 4" "Deploying to VPS..."

    if $DRY_RUN; then
        log "PHASE 4" "[DRY] Would pull images, recreate containers, inject module"
        local dur=$(( $(date +%s) - phase_start ))
        PHASE_RESULTS+=("
    \"deploy\": {\"status\": \"ok\", \"image_updated\": false, \"duration_s\": $dur}")
        TG_LINES+=("Phase 4/5: Deploy ✅ (dry run)")
        return
    fi

    # Get current image digest
    local old_digest
    old_digest=$($VPS_SSH "docker inspect farmos-www --format='{{.Image}}'" 2>/dev/null || echo "unknown")

    # Pull latest images
    log "PHASE 4" "Pulling Docker images..."
    $VPS_SSH "cd $FARMOS_COMPOSE_DIR && docker compose pull" 2>> "$LOG_FILE" \
        || on_failure "deploy" "docker compose pull failed"

    # Check if image changed
    local new_digest
    new_digest=$($VPS_SSH "docker inspect farmos-www --format='{{.Image}}'" 2>/dev/null || echo "changed")

    if [[ "$old_digest" != "$new_digest" ]] || [[ "$old_digest" == "unknown" ]]; then
        IMAGE_UPDATED=true
        log "PHASE 4" "New image detected, recreating containers..."
        $VPS_SSH "cd $FARMOS_COMPOSE_DIR && docker compose up -d" 2>> "$LOG_FILE" \
            || on_failure "deploy" "docker compose up -d failed"

        # Wait for healthy
        log "PHASE 4" "Waiting for container to be healthy..."
        local wait=0
        while [[ $wait -lt 120 ]]; do
            local status
            status=$($VPS_SSH "docker inspect farmos-www --format='{{.State.Health.Status}}'" 2>/dev/null || echo "none")
            if [[ "$status" == "healthy" ]]; then
                log "PHASE 4" "Container healthy after ${wait}s"
                break
            fi
            # Also accept running with no healthcheck
            local running
            running=$($VPS_SSH "docker inspect farmos-www --format='{{.State.Running}}'" 2>/dev/null || echo "false")
            if [[ "$running" == "true" ]] && [[ "$status" == "none" ]] && [[ $wait -ge 30 ]]; then
                log "PHASE 4" "Container running (no healthcheck) after ${wait}s"
                break
            fi
            sleep 5
            wait=$((wait + 5))
        done
        if [[ $wait -ge 120 ]]; then
            local container_logs
            container_logs=$($VPS_SSH "docker logs farmos-www --tail 30" 2>/dev/null || echo "")
            on_failure "deploy" "Container failed to become healthy within 120s" "Last container logs:
$container_logs"
        fi
    else
        IMAGE_UPDATED=false
        log "PHASE 4" "Image unchanged, skipping container recreation"
    fi

    # Re-inject custom module
    log "PHASE 4" "Injecting farm_map_free module..."
    if [[ -d "$MODULE_DIR" ]] && [[ -n "$(ls -A "$MODULE_DIR" 2>/dev/null)" ]]; then
        # Tar locally, scp to VPS, docker cp into container
        tar czf /tmp/farm_map_free_deploy.tar.gz -C "$DEPLOY_DIR/custom-modules" farm_map_free 2>> "$LOG_FILE"
        $VPS_SCP /tmp/farm_map_free_deploy.tar.gz "root@bb-vps:/tmp/" 2>> "$LOG_FILE"
        $VPS_SSH "cd /tmp && tar xzf farm_map_free_deploy.tar.gz && \
            docker cp farm_map_free farmos-www:$FARMOS_MODULE_PATH/../ && \
            rm -rf /tmp/farm_map_free /tmp/farm_map_free_deploy.tar.gz" 2>> "$LOG_FILE" \
            || on_failure "deploy" "Failed to inject farm_map_free module"
        rm -f /tmp/farm_map_free_deploy.tar.gz
        log "PHASE 4" "Module injected"
    else
        log "WARN" "No module files found in $MODULE_DIR — skipping injection"
    fi

    # Enable module + cache rebuild
    log "PHASE 4" "Enabling module and rebuilding cache..."
    $VPS_SSH "docker exec farmos-www drush en farm_map_free -y 2>/dev/null; docker exec farmos-www drush cr" 2>> "$LOG_FILE" \
        || log "WARN" "Module enable/cache rebuild had warnings (may be non-fatal)"

    # Re-grant permissions
    log "PHASE 4" "Re-granting permissions to farm_manager..."
    "$SETUP_SCRIPT" --perms-only 2>> "$LOG_FILE" \
        || on_failure "deploy" "Permission grant failed"

    local dur=$(( $(date +%s) - phase_start ))
    PHASE_RESULTS+=("
    \"deploy\": {\"status\": \"ok\", \"image_updated\": $IMAGE_UPDATED, \"duration_s\": $dur}")
    TG_LINES+=("Phase 4/5: Deploy ✅
  Image updated: $IMAGE_UPDATED, module restored, permissions set")
    log "PHASE 4" "Deploy complete ($dur s)"
}

# ── Phase 5: Verify ────────────────────────────────────────────────
phase_verify() {
    CURRENT_PHASE=5
    local phase_start=$(date +%s)
    log "PHASE 5" "Verifying farmOS..."

    local checks_passed=0
    local checks_total=5
    local check_results=""

    # 5a. HTTP health check
    log "PHASE 5" "HTTP health check..."
    local http_code
    http_code=$(curl -sL -o /dev/null -w '%{http_code}' "$FARMOS_URL" --max-time 30 2>/dev/null || echo "000")
    if [[ "$http_code" == "200" ]] || [[ "$http_code" == "302" ]] || [[ "$http_code" == "301" ]] || [[ "$http_code" == "403" ]]; then
        checks_passed=$((checks_passed + 1))
        log "PHASE 5" "HTTP: $http_code OK"
    else
        log "ERROR" "HTTP check failed: got $http_code"
        check_results+="HTTP: FAIL ($http_code)\n"
    fi

    # 5b. API check
    log "PHASE 5" "API check..."
    local api_response
    api_response=$(curl -s "$FARMOS_URL/api" --max-time 15 2>/dev/null || echo "")
    if echo "$api_response" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        checks_passed=$((checks_passed + 1))
        log "PHASE 5" "API: returns valid JSON"
    else
        log "ERROR" "API check failed: no valid JSON response"
        check_results+="API: FAIL\n"
    fi

    # 5c. Drush status
    log "PHASE 5" "Drush status check..."
    local drush_status
    drush_status=$($VPS_SSH "docker exec farmos-www drush status --fields=bootstrap 2>/dev/null" || echo "")
    if echo "$drush_status" | grep -qi "successful"; then
        checks_passed=$((checks_passed + 1))
        log "PHASE 5" "Drush: Successful bootstrap"
    else
        log "ERROR" "Drush status check failed: $drush_status"
        check_results+="Drush: FAIL\n"
    fi

    # 5d. Module check
    log "PHASE 5" "Module check..."
    local module_status
    module_status=$($VPS_SSH "docker exec farmos-www drush pm:list --status=enabled 2>/dev/null" || echo "")
    if echo "$module_status" | grep -q "farm_map_free"; then
        checks_passed=$((checks_passed + 1))
        log "PHASE 5" "farm_map_free: enabled"
    else
        log "ERROR" "farm_map_free not found in enabled modules"
        check_results+="Module: FAIL\n"
    fi

    # 5e. Permission check
    log "PHASE 5" "Permission check..."
    local perm_output
    perm_output=$($VPS_SSH "docker exec farmos-www drush php:eval '
\$role = \\Drupal\\user\\Entity\\Role::load(\"farm_manager\");
\$all = array_keys(\\Drupal::service(\"user.permissions\")->getPermissions());
echo count(\$role->getPermissions()) . \"/\" . count(\$all);
' 2>/dev/null" || echo "0/0")
    local perm_granted
    perm_granted=$(echo "$perm_output" | grep -oP '^\d+' || echo "0")
    if [[ "$perm_granted" -ge 370 ]]; then
        checks_passed=$((checks_passed + 1))
        log "PHASE 5" "Permissions: $perm_output"
    else
        log "ERROR" "Permission check failed: only $perm_output"
        check_results+="Permissions: FAIL ($perm_output)\n"
    fi

    local dur=$(( $(date +%s) - phase_start ))

    if [[ $checks_passed -lt $checks_total ]]; then
        local failed_count=$((checks_total - checks_passed))
        on_failure "verify" "$failed_count of $checks_total checks failed" "Failed checks:
$check_results

Passed: $checks_passed/$checks_total"
    fi

    PHASE_RESULTS+=("
    \"verify\": {\"status\": \"ok\", \"http\": $http_code, \"api\": true, \"drush\": true, \"module\": true, \"perms\": \"$perm_output\", \"duration_s\": $dur}")
    TG_LINES+=("Phase 5/5: Verify ✅
  HTTP: $http_code | API: OK | Drush: Successful
  farm_map_free: enabled | Perms: $perm_output")
    log "PHASE 5" "All checks passed ($dur s)"
}

# ══════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════

log_header

# Test-fail simulation
if [[ $TEST_FAIL -gt 0 ]]; then
    log "INFO" "Test failure mode: will simulate failure at phase $TEST_FAIL"
fi

# Phase execution with --from-phase support
run_phase() {
    local phase_num=$1
    local phase_fn=$2

    if [[ $phase_num -lt $FROM_PHASE ]]; then
        log "INFO" "Skipping phase $phase_num (resuming from $FROM_PHASE)"
        TG_LINES+=("Phase $phase_num/5: SKIPPED (resumed from $FROM_PHASE)")
        PHASE_RESULTS+=("
    \"$(echo "$phase_fn" | sed 's/phase_//')\": {\"status\": \"skipped\"}")
        return
    fi

    if [[ $TEST_FAIL -eq $phase_num ]]; then
        on_failure "test_phase_$phase_num" "Simulated failure at phase $phase_num (--test-fail)"
    fi

    $phase_fn
}

run_phase 1 phase_backup
run_phase 2 phase_update_check
run_phase 3 phase_merge
run_phase 4 phase_deploy
run_phase 5 phase_verify

# ── Success ────────────────────────────────────────────────────────
total_dur=$(fmt_duration $(( $(date +%s) - RUN_START )))

tg_send "farmOS Weekly Sync
━━━━━━━━━━━━━━━━━━

$(printf '%s\n' "${TG_LINES[@]}")

Duration: $total_dur"

write_summary "success"
log "INFO" "farmOS Weekly Sync complete ($total_dur)"
