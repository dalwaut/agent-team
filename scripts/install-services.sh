#!/bin/bash
#
# OPAI Services Installation Script
#
# This script installs and configures all OPAI systemd services for auto-start
# and persistent operation.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPAI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  OPAI System Services - Installation"
echo "═══════════════════════════════════════════════════════"
echo ""

# ──────────────────────────────────────────────────────────
# Prerequisites Check
# ──────────────────────────────────────────────────────────

log_info "Checking prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js is not installed. Please install Node.js 20 LTS first."
    exit 1
fi
log_success "Node.js found: $(node --version)"

# Check npm
if ! command -v npm &> /dev/null; then
    log_error "npm is not installed."
    exit 1
fi
log_success "npm found: $(npm --version)"

# Check systemctl
if ! command -v systemctl &> /dev/null; then
    log_error "systemd is not available on this system."
    exit 1
fi
log_success "systemd found"

# Check Claude CLI
if ! command -v claude &> /dev/null; then
    log_warn "Claude CLI not found. Please install it with: npm install -g @anthropic-ai/claude-code"
    log_warn "Services will fail to start without Claude CLI."
fi

# ──────────────────────────────────────────────────────────
# Install Dependencies
# ──────────────────────────────────────────────────────────

log_info "Installing Node.js dependencies..."

# Discord bot
if [ -d "$OPAI_ROOT/tools/discord-bridge" ]; then
    cd "$OPAI_ROOT/tools/discord-bridge"
    if [ -f "package.json" ]; then
        npm install --production
        log_success "Discord bot dependencies installed"
    fi
fi

# Email checker
if [ -d "$OPAI_ROOT/tools/email-checker" ]; then
    cd "$OPAI_ROOT/tools/email-checker"
    if [ -f "package.json" ]; then
        npm install --production
        log_success "Email checker dependencies installed"
    fi
fi

cd "$OPAI_ROOT"

# ──────────────────────────────────────────────────────────
# Credential Check
# ──────────────────────────────────────────────────────────

log_info "Checking credentials..."

MISSING_CREDS=false

# Discord bot .env
if [ ! -f "$OPAI_ROOT/tools/discord-bridge/.env" ]; then
    log_warn "Discord bot .env not found at tools/discord-bridge/.env"
    MISSING_CREDS=true
fi

# Email checker .env
if [ ! -f "$OPAI_ROOT/tools/email-checker/.env" ]; then
    log_warn "Email checker .env not found at tools/email-checker/.env"
    MISSING_CREDS=true
fi

if [ "$MISSING_CREDS" = true ]; then
    log_warn "Some .env files are missing. Services may not work correctly."
    log_info "See SETUP.md for credential configuration details."
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Installation cancelled."
        exit 0
    fi
fi

# ──────────────────────────────────────────────────────────
# Install Services
# ──────────────────────────────────────────────────────────

log_info "Installing systemd service files..."

# Use the control script to install
"$SCRIPT_DIR/opai-control.sh" install

# ──────────────────────────────────────────────────────────
# Completion
# ──────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Installation Complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
log_success "OPAI services are installed and ready to use."
echo ""
echo "Next steps:"
echo ""
echo "  1. Configure credentials (if not done already):"
echo "     - tools/discord-bridge/.env"
echo "     - tools/email-checker/.env"
echo ""
echo "  2. Enable auto-start on boot:"
echo "     ./scripts/opai-control.sh enable"
echo ""
echo "  3. Start services:"
echo "     ./scripts/opai-control.sh start"
echo ""
echo "  4. Check status:"
echo "     ./scripts/opai-control.sh status"
echo ""
echo "  5. View logs:"
echo "     ./scripts/opai-control.sh logs"
echo ""
echo "For more information, see:"
echo "  - SETUP.md for credential configuration"
echo "  - QUICKSTART.md for usage guide"
echo ""
