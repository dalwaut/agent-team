#!/bin/bash
#
# OpenClaw Control Script — CLI management for OpenClaw instances
#
# Usage:
#   ./oc-control.sh list                              - List all instances
#   ./oc-control.sh status <slug>                     - Get runtime status
#   ./oc-control.sh create <slug> [display_name]      - Register new instance
#   ./oc-control.sh provision <slug>                  - Full provision (port, dirs, compose, creds, start)
#   ./oc-control.sh start <slug>                      - Start stopped instance
#   ./oc-control.sh stop <slug>                       - Stop running instance
#   ./oc-control.sh restart <slug>                    - Restart instance
#   ./oc-control.sh destroy <slug>                    - Full destroy (with confirmation)
#   ./oc-control.sh kill-switch <slug>                - Emergency revoke all creds + stop
#   ./oc-control.sh grant <slug> <key> [section] [service] [reason] - Grant credential
#   ./oc-control.sh revoke <slug> <key>               - Revoke credential
#   ./oc-control.sh creds <slug>                      - List granted credentials
#   ./oc-control.sh logs <slug> [lines]               - Get container logs
#   ./oc-control.sh audit [slug]                      - View credential audit log
#   ./oc-control.sh overview                          - Runtime overview of all instances
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPAI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Broker API
BROKER_HOST="localhost"
BROKER_PORT="8106"
BROKER_BASE="http://${BROKER_HOST}:${BROKER_PORT}/oc/api"

# Vault env file for auth token
VAULT_ENV="/run/user/1000/opai-vault/open-claw.env"

# Colors (matching opai-control.sh)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ──────────────────────────────────────────────────────────
# Setup
# ──────────────────────────────────────────────────────────

load_auth() {
    if [ ! -f "$VAULT_ENV" ]; then
        log_error "Vault env not found: $VAULT_ENV"
        log_error "Is opai-vault running? Try: ./opai-control.sh restart-one vault"
        exit 1
    fi

    # Load SUPABASE_SERVICE_KEY from vault tmpfs
    export $(grep -v '^#' "$VAULT_ENV" | grep 'SUPABASE_SERVICE_KEY' | xargs)

    if [ -z "${SUPABASE_SERVICE_KEY:-}" ]; then
        log_error "SUPABASE_SERVICE_KEY not found in $VAULT_ENV"
        exit 1
    fi
}

# Check for jq availability
HAS_JQ=false
if command -v jq &>/dev/null; then
    HAS_JQ=true
fi

# Curl wrapper with auth headers
api_call() {
    local method="$1"
    local endpoint="$2"
    shift 2
    local data="${1:-}"

    local url="${BROKER_BASE}${endpoint}"
    local curl_args=(
        -s
        -w "\n%{http_code}"
        -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}"
        -H "Content-Type: application/json"
        -X "$method"
    )

    if [ -n "$data" ]; then
        curl_args+=(-d "$data")
    fi

    curl "${curl_args[@]}" "$url"
}

# Parse response: body on stdout, http code on fd 3
parse_response() {
    local response="$1"
    local http_code
    local body

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    echo "$http_code"
    echo "$body"
}

# Pretty-print JSON if jq is available, raw otherwise
pp_json() {
    if $HAS_JQ; then
        echo "$1" | jq '.' 2>/dev/null || echo "$1"
    else
        echo "$1"
    fi
}

# Extract field from JSON (requires jq)
json_field() {
    local json="$1"
    local field="$2"
    if $HAS_JQ; then
        echo "$json" | jq -r "$field" 2>/dev/null
    else
        echo "(install jq for parsed output)"
    fi
}

# ──────────────────────────────────────────────────────────
# Commands
# ──────────────────────────────────────────────────────────

cmd_list() {
    log_info "Fetching OpenClaw instances..."

    local response
    response=$(api_call GET "/instances")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" != "200" ]; then
        log_error "API returned HTTP $http_code"
        pp_json "$body"
        return 1
    fi

    if ! $HAS_JQ; then
        log_warn "Install jq for formatted output"
        echo "$body"
        return 0
    fi

    local count
    count=$(echo "$body" | jq -r '.instances | length' 2>/dev/null || echo "0")

    echo ""
    echo -e "${BOLD}OpenClaw Instances ($count)${NC}"
    echo "════════════════════════════════════════════════════════════════════════"
    printf "%-20s %-12s %-8s %-12s %s\n" "SLUG" "STATUS" "PORT" "TIER" "DISPLAY NAME"
    echo "────────────────────────────────────────────────────────────────────────"

    echo "$body" | jq -r '.instances[] | [.slug, .status, (.port // "—"), .tier, (.display_name // "—")] | @tsv' 2>/dev/null | \
    while IFS=$'\t' read -r slug status port tier display_name; do
        local color
        case "$status" in
            running)      color="$GREEN" ;;
            stopped)      color="$YELLOW" ;;
            provisioning) color="$BLUE" ;;
            error|failed) color="$RED" ;;
            *)            color="$NC" ;;
        esac
        printf "%-20s ${color}%-12s${NC} %-8s %-12s %s\n" "$slug" "$status" "$port" "$tier" "$display_name"
    done

    echo ""
}

cmd_status() {
    local slug="$1"
    if [ -z "$slug" ]; then
        log_error "Usage: $0 status <slug>"
        exit 1
    fi

    log_info "Fetching runtime status for '$slug'..."

    local response
    response=$(api_call GET "/instances/${slug}/runtime")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" != "200" ]; then
        log_error "API returned HTTP $http_code"
        pp_json "$body"
        return 1
    fi

    echo ""
    echo -e "${BOLD}Instance: $slug${NC}"
    echo "════════════════════════════════════════════════════════"

    if $HAS_JQ; then
        echo "$body" | jq -r '
            to_entries[] |
            "  \(.key): \(.value // "—")"
        ' 2>/dev/null || pp_json "$body"
    else
        echo "$body"
    fi

    echo ""
}

cmd_create() {
    local slug="$1"
    local display_name="${2:-}"

    if [ -z "$slug" ]; then
        log_error "Usage: $0 create <slug> [display_name]"
        exit 1
    fi

    log_info "Registering new instance '$slug'..."

    local payload
    payload=$(cat <<EOF
{
    "slug": "$slug",
    "display_name": "${display_name:-$slug}",
    "tier": "internal",
    "autonomy_level": 3
}
EOF
)

    local response
    response=$(api_call POST "/instances" "$payload")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "201" ] || [ "$http_code" = "200" ]; then
        log_success "Instance '$slug' registered"
        pp_json "$body"
    else
        log_error "Failed to create instance (HTTP $http_code)"
        pp_json "$body"
        return 1
    fi
}

cmd_provision() {
    local slug="$1"
    if [ -z "$slug" ]; then
        log_error "Usage: $0 provision <slug>"
        exit 1
    fi

    log_info "Provisioning instance '$slug' (port, dirs, compose, creds, start)..."

    local response
    response=$(api_call POST "/instances/${slug}/provision")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ]; then
        log_success "Instance '$slug' provisioned"
        pp_json "$body"
    else
        log_error "Provisioning failed (HTTP $http_code)"
        pp_json "$body"
        return 1
    fi
}

cmd_start() {
    local slug="$1"
    if [ -z "$slug" ]; then
        log_error "Usage: $0 start <slug>"
        exit 1
    fi

    log_info "Starting instance '$slug'..."

    local response
    response=$(api_call POST "/instances/${slug}/start")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ]; then
        log_success "Instance '$slug' started"
    else
        log_error "Failed to start '$slug' (HTTP $http_code)"
        pp_json "$body"
        return 1
    fi
}

cmd_stop() {
    local slug="$1"
    if [ -z "$slug" ]; then
        log_error "Usage: $0 stop <slug>"
        exit 1
    fi

    log_info "Stopping instance '$slug'..."

    local response
    response=$(api_call POST "/instances/${slug}/stop")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ]; then
        log_success "Instance '$slug' stopped"
    else
        log_error "Failed to stop '$slug' (HTTP $http_code)"
        pp_json "$body"
        return 1
    fi
}

cmd_restart() {
    local slug="$1"
    if [ -z "$slug" ]; then
        log_error "Usage: $0 restart <slug>"
        exit 1
    fi

    log_info "Restarting instance '$slug'..."

    local response
    response=$(api_call POST "/instances/${slug}/restart")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ]; then
        log_success "Instance '$slug' restarted"
    else
        log_error "Failed to restart '$slug' (HTTP $http_code)"
        pp_json "$body"
        return 1
    fi
}

cmd_destroy() {
    local slug="$1"
    if [ -z "$slug" ]; then
        log_error "Usage: $0 destroy <slug>"
        exit 1
    fi

    echo -e "${RED}WARNING: This will permanently destroy instance '${slug}'.${NC}"
    echo -e "${RED}All data, containers, credentials, and configuration will be removed.${NC}"
    echo ""

    if [ ! -t 0 ]; then
        log_error "BLOCKED: 'destroy' requires an interactive terminal"
        exit 1
    fi

    read -p "Type the instance slug to confirm: " confirm
    if [ "$confirm" != "$slug" ]; then
        log_info "Aborted. Slug did not match."
        exit 0
    fi

    log_info "Destroying instance '$slug'..."

    local response
    response=$(api_call DELETE "/instances/${slug}")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ]; then
        log_success "Instance '$slug' destroyed"
    else
        log_error "Destroy failed (HTTP $http_code)"
        pp_json "$body"
        return 1
    fi
}

cmd_kill_switch() {
    local slug="$1"
    if [ -z "$slug" ]; then
        log_error "Usage: $0 kill-switch <slug>"
        exit 1
    fi

    echo -e "${RED}${BOLD}KILL SWITCH${NC} — Instance '${slug}'"
    echo -e "${RED}This will immediately revoke ALL credentials and stop the instance.${NC}"
    echo ""

    if [ ! -t 0 ]; then
        log_error "BLOCKED: 'kill-switch' requires an interactive terminal"
        exit 1
    fi

    read -p "Are you sure? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        log_info "Aborted."
        exit 0
    fi

    log_info "Activating kill switch for '$slug'..."

    local response
    response=$(api_call POST "/instances/${slug}/kill-switch")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ]; then
        log_success "Kill switch activated for '$slug' — all credentials revoked, instance stopped"
    else
        log_error "Kill switch failed (HTTP $http_code)"
        pp_json "$body"
        return 1
    fi
}

cmd_grant() {
    local slug="$1"
    local vault_key="${2:-}"
    local section="${3:-}"
    local service="${4:-}"
    local reason="${5:-}"

    if [ -z "$slug" ] || [ -z "$vault_key" ]; then
        log_error "Usage: $0 grant <slug> <vault_key> [section] [service] [reason]"
        exit 1
    fi

    log_info "Granting credential '$vault_key' to instance '$slug'..."

    local payload
    payload=$(cat <<EOF
{
    "vault_key": "$vault_key"$([ -n "$section" ] && echo ", \"section\": \"$section\"")$([ -n "$service" ] && echo ", \"service\": \"$service\"")$([ -n "$reason" ] && echo ", \"reason\": \"$reason\"")
}
EOF
)

    local response
    response=$(api_call POST "/instances/${slug}/credentials" "$payload")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        log_success "Credential '$vault_key' granted to '$slug'"
    else
        log_error "Grant failed (HTTP $http_code)"
        pp_json "$body"
        return 1
    fi
}

cmd_revoke() {
    local slug="$1"
    local vault_key="${2:-}"

    if [ -z "$slug" ] || [ -z "$vault_key" ]; then
        log_error "Usage: $0 revoke <slug> <vault_key>"
        exit 1
    fi

    log_info "Revoking credential '$vault_key' from instance '$slug'..."

    local response
    response=$(api_call DELETE "/instances/${slug}/credentials" "{\"vault_key\": \"$vault_key\"}")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ]; then
        log_success "Credential '$vault_key' revoked from '$slug'"
    else
        log_error "Revoke failed (HTTP $http_code)"
        pp_json "$body"
        return 1
    fi
}

cmd_creds() {
    local slug="$1"
    if [ -z "$slug" ]; then
        log_error "Usage: $0 creds <slug>"
        exit 1
    fi

    log_info "Fetching credentials for '$slug'..."

    local response
    response=$(api_call GET "/instances/${slug}/credentials")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" != "200" ]; then
        log_error "API returned HTTP $http_code"
        pp_json "$body"
        return 1
    fi

    if ! $HAS_JQ; then
        echo "$body"
        return 0
    fi

    local count
    count=$(echo "$body" | jq -r '.credentials | length' 2>/dev/null || echo "0")

    echo ""
    echo -e "${BOLD}Credentials for '$slug' ($count)${NC}"
    echo "════════════════════════════════════════════════════════════════"
    printf "%-30s %-15s %-15s %s\n" "VAULT KEY" "SECTION" "SERVICE" "GRANTED"
    echo "────────────────────────────────────────────────────────────────"

    echo "$body" | jq -r '.credentials[] | [.vault_key, (.section // "—"), (.service // "—"), (.granted_at // "—")] | @tsv' 2>/dev/null | \
    while IFS=$'\t' read -r key section service granted; do
        printf "%-30s %-15s %-15s %s\n" "$key" "$section" "$service" "$granted"
    done

    echo ""
}

cmd_logs() {
    local slug="$1"
    local lines="${2:-100}"

    if [ -z "$slug" ]; then
        log_error "Usage: $0 logs <slug> [lines]"
        exit 1
    fi

    log_info "Fetching logs for '$slug' (last $lines lines)..."

    local response
    response=$(api_call GET "/instances/${slug}/logs?lines=${lines}")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" != "200" ]; then
        log_error "API returned HTTP $http_code"
        pp_json "$body"
        return 1
    fi

    if $HAS_JQ; then
        echo "$body" | jq -r '.logs // .output // .' 2>/dev/null || echo "$body"
    else
        echo "$body"
    fi
}

cmd_audit() {
    local slug="${1:-}"

    local endpoint="/audit"
    if [ -n "$slug" ]; then
        endpoint="/audit?instance_slug=${slug}"
        log_info "Fetching audit log for '$slug'..."
    else
        log_info "Fetching full credential audit log..."
    fi

    local response
    response=$(api_call GET "$endpoint")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" != "200" ]; then
        log_error "API returned HTTP $http_code"
        pp_json "$body"
        return 1
    fi

    if ! $HAS_JQ; then
        echo "$body"
        return 0
    fi

    echo ""
    echo -e "${BOLD}Credential Audit Log${NC}$([ -n "$slug" ] && echo " — $slug")"
    echo "════════════════════════════════════════════════════════════════════════════════"
    printf "%-20s %-10s %-25s %-20s %s\n" "INSTANCE" "ACTION" "VAULT KEY" "TIMESTAMP" "ACTOR"
    echo "────────────────────────────────────────────────────────────────────────────────"

    echo "$body" | jq -r '.entries[] | [(.instance_slug // "—"), (.action // "—"), (.vault_key // "—"), (.timestamp // "—"), (.actor // "—")] | @tsv' 2>/dev/null | \
    while IFS=$'\t' read -r inst action key ts actor; do
        local color
        case "$action" in
            grant*)  color="$GREEN" ;;
            revoke*) color="$RED" ;;
            *)       color="$NC" ;;
        esac
        printf "%-20s ${color}%-10s${NC} %-25s %-20s %s\n" "$inst" "$action" "$key" "$ts" "$actor"
    done

    echo ""
}

cmd_overview() {
    log_info "Fetching runtime overview..."

    local response
    response=$(api_call GET "/runtime/overview")

    local http_code body
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" != "200" ]; then
        log_error "API returned HTTP $http_code"
        pp_json "$body"
        return 1
    fi

    echo ""
    echo -e "${BOLD}OpenClaw Runtime Overview${NC}"
    echo "════════════════════════════════════════════════════════════════════════════════"

    if $HAS_JQ; then
        # Summary stats
        local total running stopped
        total=$(echo "$body" | jq -r '.total // .instances_total // "?"' 2>/dev/null)
        running=$(echo "$body" | jq -r '.running // .instances_running // "?"' 2>/dev/null)
        stopped=$(echo "$body" | jq -r '.stopped // .instances_stopped // "?"' 2>/dev/null)

        echo -e "  Total: ${BOLD}$total${NC}  |  Running: ${GREEN}$running${NC}  |  Stopped: ${YELLOW}$stopped${NC}"
        echo ""

        # Per-instance details if available
        echo "$body" | jq -r '
            (.instances // [])[] |
            "  \(.slug)\t\(.status)\t\(.port // "—")\t\(.uptime // "—")\t\(.cpu // "—")\t\(.memory // "—")"
        ' 2>/dev/null | {
            local has_rows=false
            while IFS=$'\t' read -r slug status port uptime cpu mem; do
                if [ "$has_rows" = false ]; then
                    printf "  %-20s %-12s %-8s %-12s %-8s %s\n" "SLUG" "STATUS" "PORT" "UPTIME" "CPU" "MEMORY"
                    echo "  ────────────────────────────────────────────────────────────────────"
                    has_rows=true
                fi
                local color
                case "$status" in
                    running)      color="$GREEN" ;;
                    stopped)      color="$YELLOW" ;;
                    error|failed) color="$RED" ;;
                    *)            color="$NC" ;;
                esac
                printf "  %-20s ${color}%-12s${NC} %-8s %-12s %-8s %s\n" "$slug" "$status" "$port" "$uptime" "$cpu" "$mem"
            done
        }
    else
        echo "$body"
    fi

    echo ""
}

# ──────────────────────────────────────────────────────────
# Usage
# ──────────────────────────────────────────────────────────

show_usage() {
    echo "OpenClaw Control Script — CLI management for OpenClaw instances"
    echo ""
    echo "Usage: $0 <command> [args...]"
    echo ""
    echo "Instance Management:"
    echo "  list                              List all instances"
    echo "  status <slug>                     Get runtime status of an instance"
    echo "  create <slug> [display_name]      Register a new instance (tier=internal, autonomy=3)"
    echo "  provision <slug>                  Full provision (port, dirs, compose, creds, start)"
    echo "  start <slug>                      Start a stopped instance"
    echo "  stop <slug>                       Stop a running instance"
    echo "  restart <slug>                    Restart an instance"
    echo "  destroy <slug>                    Full destroy with confirmation"
    echo "  overview                          Runtime overview of all instances"
    echo ""
    echo "Credentials:"
    echo "  grant <slug> <key> [section] [service] [reason]"
    echo "                                    Grant a vault credential to an instance"
    echo "  revoke <slug> <key>               Revoke a credential from an instance"
    echo "  creds <slug>                      List granted credentials for an instance"
    echo ""
    echo "Emergency:"
    echo "  kill-switch <slug>                Revoke ALL credentials + stop (with confirmation)"
    echo ""
    echo "Diagnostics:"
    echo "  logs <slug> [lines]               Get container logs (default: 100 lines)"
    echo "  audit [slug]                      View credential audit log (all or per-instance)"
    echo ""
    echo "Examples:"
    echo "  $0 list"
    echo "  $0 create mybot \"My Chat Bot\""
    echo "  $0 provision mybot"
    echo "  $0 grant mybot OPENAI_API_KEY credentials openai \"Needed for chat\""
    echo "  $0 creds mybot"
    echo "  $0 logs mybot 50"
    echo "  $0 status mybot"
    echo "  $0 audit mybot"
    echo "  $0 stop mybot"
    echo "  $0 kill-switch mybot"
    echo "  $0 destroy mybot"
    echo ""
    echo "Broker API: ${BROKER_BASE}"
    echo "Auth: Supabase service key from ${VAULT_ENV}"
    echo ""
    if ! $HAS_JQ; then
        echo -e "${YELLOW}Note: Install jq for formatted table output (apt install jq)${NC}"
        echo ""
    fi
}

# ──────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────

COMMAND="${1:-}"

# Show usage without auth for help/no-args
if [ -z "$COMMAND" ] || [ "$COMMAND" = "help" ] || [ "$COMMAND" = "--help" ] || [ "$COMMAND" = "-h" ]; then
    show_usage
    exit 0
fi

# Load auth for all other commands
load_auth

case "$COMMAND" in
    list)         cmd_list ;;
    status)       cmd_status "${2:-}" ;;
    create)       cmd_create "${2:-}" "${3:-}" ;;
    provision)    cmd_provision "${2:-}" ;;
    start)        cmd_start "${2:-}" ;;
    stop)         cmd_stop "${2:-}" ;;
    restart)      cmd_restart "${2:-}" ;;
    destroy)      cmd_destroy "${2:-}" ;;
    kill-switch)  cmd_kill_switch "${2:-}" ;;
    grant)        cmd_grant "${2:-}" "${3:-}" "${4:-}" "${5:-}" "${6:-}" ;;
    revoke)       cmd_revoke "${2:-}" "${3:-}" ;;
    creds)        cmd_creds "${2:-}" ;;
    logs)         cmd_logs "${2:-}" "${3:-}" ;;
    audit)        cmd_audit "${2:-}" ;;
    overview)     cmd_overview ;;
    *)
        log_error "Unknown command: $COMMAND"
        echo ""
        show_usage
        exit 1
        ;;
esac
