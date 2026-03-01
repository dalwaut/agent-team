#!/bin/bash
#
# OPAI Control Script v2 — Unified management for OPAI services
#
# Usage:
#   ./opai-control.sh start       - Start all v2 services
#   ./opai-control.sh stop        - Stop all services
#   ./opai-control.sh restart     - Restart all services
#   ./opai-control.sh status      - Show status of all services
#   ./opai-control.sh logs [svc]  - View logs (all or specific service)
#   ./opai-control.sh enable      - Enable auto-start on boot
#   ./opai-control.sh disable     - Disable auto-start
#   ./opai-control.sh restart-one <svc> - Restart a single service (agent-safe)
#
# v2 restructure (2026-02-25): Engine replaces Orchestrator + Monitor + TCP.
# 10 active services down from 28.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPAI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

# v2 services (in start order)
SERVICES=(
    "opai-vault"          # Foundation — creds (must start first)
    "opai-caddy"          # Gateway — reverse proxy
    "opai-portal"         # Auth + dashboard
    "opai-engine"         # Core — scheduler, tasks, workers, monitor
    "opai-brain"          # 2nd Brain — cognitive layer (Library, Inbox, graph)
    "opai-files"          # File management
    "opai-team-hub"       # Project/task management
    "opai-users"          # User management
    "opai-wordpress"      # Client site management
    "opai-oc-broker"      # OpenClaw container broker (vault credential bridge)
    "opai-browser"        # Browser automation (headless Playwright via Claude CLI)
    "opai-discord-bot"    # Discord bridge
    # opai-email-agent removed — now engine-managed (spawned by WorkerManager)
)

TIMERS=("opai-docker-cleanup" "opai-journal-cleanup" "opai-farmos-sync")

# Core services — agents can't restart these
CORE_SERVICES=("opai-caddy" "opai-portal" "opai-engine" "opai-vault")

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ──────────────────────────────────────────────────────────
# Service Control
# ──────────────────────────────────────────────────────────

start_services() {
    log_info "Starting OPAI v2 services..."

    for service in "${SERVICES[@]}"; do
        if systemctl --user start "$service" 2>/dev/null; then
            log_success "Started $service"
        else
            log_warn "$service not installed or failed to start"
        fi
        # Give vault a moment to initialize before other services
        [ "$service" = "opai-vault" ] && sleep 1
    done

    # Start timers
    for timer in "${TIMERS[@]}"; do
        systemctl --user start "${timer}.timer" 2>/dev/null && log_success "Started ${timer}.timer" || true
    done

    log_success "All services started!"
}

stop_services() {
    # SAFETY: Require interactive TTY or --force flag
    if [ "${OPAI_FORCE:-}" != "1" ] && [ ! -t 0 ]; then
        log_error "BLOCKED: 'stop' requires an interactive terminal or OPAI_FORCE=1"
        log_error "Agents should use: restart-one <service>"
        exit 1
    fi

    if [ -t 0 ] && [ "${OPAI_FORCE:-}" != "1" ]; then
        echo -e "${RED}WARNING: This will stop ALL OPAI services.${NC}"
        read -p "Are you sure? (yes/no): " confirm
        if [ "$confirm" != "yes" ]; then
            log_info "Aborted."
            exit 0
        fi
    fi

    log_info "Stopping OPAI services..."

    # Stop timers first
    for timer in "${TIMERS[@]}"; do
        systemctl --user stop "${timer}.timer" 2>/dev/null || true
    done

    # Stop in reverse order (workers first, then core, then gateway, then vault)
    for (( i=${#SERVICES[@]}-1 ; i>=0 ; i-- )); do
        systemctl --user stop "${SERVICES[$i]}" 2>/dev/null || true
        log_success "Stopped ${SERVICES[$i]}"
    done

    log_success "All services stopped"
}

restart_services() {
    if [ "${OPAI_FORCE:-}" != "1" ] && [ ! -t 0 ]; then
        log_error "BLOCKED: 'restart' requires an interactive terminal or OPAI_FORCE=1"
        exit 1
    fi

    log_info "Restarting OPAI services..."
    stop_services
    sleep 2
    start_services
}

restart_one_service() {
    local service="$1"
    if [ -z "$service" ]; then
        log_error "Usage: $0 restart-one <service-name>"
        log_error "Example: $0 restart-one engine"
        exit 1
    fi

    # Normalize: allow "engine", "opai-engine", etc.
    [[ "$service" != opai-* ]] && service="opai-$service"

    # Block core services from non-interactive shells
    for core in "${CORE_SERVICES[@]}"; do
        if [ "$service" = "$core" ] && [ ! -t 0 ] && [ "${OPAI_FORCE:-}" != "1" ]; then
            log_error "BLOCKED: Cannot restart core service '$service' from non-interactive shell"
            exit 1
        fi
    done

    log_info "Restarting $service..."
    systemctl --user restart "$service" 2>/dev/null && log_success "Restarted $service" || log_error "Failed to restart $service"
}

enable_services() {
    log_info "Enabling OPAI v2 services (auto-start on boot)..."
    for service in "${SERVICES[@]}"; do
        systemctl --user enable "${service}.service" 2>/dev/null && log_success "Enabled $service" || log_warn "Could not enable $service"
    done
    for timer in "${TIMERS[@]}"; do
        systemctl --user enable "${timer}.timer" 2>/dev/null || true
    done
    loginctl enable-linger "$USER" 2>/dev/null || true
    log_success "Services will auto-start on boot"
}

disable_services() {
    log_info "Disabling OPAI services (no auto-start)..."
    for service in "${SERVICES[@]}"; do
        systemctl --user disable "${service}.service" 2>/dev/null || true
    done
    for timer in "${TIMERS[@]}"; do
        systemctl --user disable "${timer}.timer" 2>/dev/null || true
    done
    log_success "Auto-start disabled"
}

show_status() {
    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "  OPAI v2 System Status"
    echo "═══════════════════════════════════════════════════════"
    echo ""

    printf "%-28s %-10s %-10s %s\n" "SERVICE" "STATE" "MEMORY" "UPTIME"
    echo "─────────────────────────────────────────────────────────────────"

    for service in "${SERVICES[@]}"; do
        state=$(systemctl --user is-active "$service" 2>/dev/null || echo "unknown")
        pid=$(systemctl --user show "$service" --property=MainPID --value 2>/dev/null)
        mem=""
        if [ "$pid" -gt 0 ] 2>/dev/null; then
            rss=$(ps -p "$pid" -o rss= 2>/dev/null | tr -d ' ')
            [ -n "$rss" ] && mem="$((rss / 1024))MB"
        fi
        uptime=""
        if [ "$state" = "active" ]; then
            uptime=$(systemctl --user show "$service" --property=ActiveEnterTimestamp --value 2>/dev/null | xargs -I{} date -d {} +%s 2>/dev/null)
            if [ -n "$uptime" ]; then
                now=$(date +%s)
                secs=$((now - uptime))
                if [ "$secs" -lt 3600 ]; then
                    uptime="${secs}s"
                elif [ "$secs" -lt 86400 ]; then
                    uptime="$((secs / 3600))h"
                else
                    uptime="$((secs / 86400))d"
                fi
            fi
        fi

        # Color based on state
        case "$state" in
            active)   color="$GREEN" ;;
            inactive) color="$YELLOW" ;;
            failed)   color="$RED" ;;
            *)        color="$NC" ;;
        esac

        printf "%-28s ${color}%-10s${NC} %-10s %s\n" "$service" "$state" "${mem:-—}" "${uptime:-—}"
    done

    echo ""
    echo "Timers:"
    for timer in "${TIMERS[@]}"; do
        state=$(systemctl --user is-active "${timer}.timer" 2>/dev/null || echo "unknown")
        printf "  %-28s %s\n" "${timer}.timer" "$state"
    done
    echo ""
}

show_logs() {
    local service="$1"

    if [ -z "$service" ]; then
        log_info "Showing logs for all OPAI services (Ctrl+C to exit)..."
        journalctl --user -u 'opai-*' -f --no-hostname
    else
        [[ "$service" != opai-* ]] && service="opai-$service"
        log_info "Showing logs for $service (Ctrl+C to exit)..."
        journalctl --user -u "$service" -f --no-hostname
    fi
}

# ──────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────

case "${1:-}" in
    start)       start_services ;;
    stop)        stop_services ;;
    restart)     restart_services ;;
    restart-one) restart_one_service "$2" ;;
    enable)      enable_services ;;
    disable)     disable_services ;;
    status)      show_status ;;
    logs)        show_logs "$2" ;;
    *)
        echo "OPAI Control Script v2"
        echo ""
        echo "Usage: $0 {start|stop|restart|restart-one <svc>|enable|disable|status|logs [svc]}"
        echo ""
        echo "Commands:"
        echo "  start              Start all v2 services"
        echo "  stop               Stop all services (INTERACTIVE ONLY)"
        echo "  restart            Restart all services (INTERACTIVE ONLY)"
        echo "  restart-one <svc>  Restart a single service (agent-safe)"
        echo "  enable             Enable auto-start on boot"
        echo "  disable            Disable auto-start"
        echo "  status             Show status of all services"
        echo "  logs [service]     View logs (all or specific)"
        echo ""
        echo "Active services (${#SERVICES[@]}):"
        for s in "${SERVICES[@]}"; do echo "  $s"; done
        echo ""
        echo "Safety:"
        echo "  stop/restart blocked in non-interactive shells."
        echo "  Override with: OPAI_FORCE=1 ./opai-control.sh stop"
        exit 1
        ;;
esac
