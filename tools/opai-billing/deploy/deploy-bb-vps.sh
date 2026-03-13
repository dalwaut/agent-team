#!/bin/bash
#
# Deploy OPAI public site to BB VPS
#
# Prerequisites:
#   - SSH access to BB VPS (dallas@72.60.115.74 or dallas@bb-vps via Tailscale)
#   - DNS: opai.boutabyte.com → 72.60.115.74
#   - Caddy installed on BB VPS
#
# Usage:
#   ./deploy-bb-vps.sh [host]
#   ./deploy-bb-vps.sh bb-vps
#   ./deploy-bb-vps.sh 72.60.115.74

set -e

HOST="${1:-100.106.200.68}"
USER="root"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_DIR="$SCRIPT_DIR/../public-site"

echo "Deploying OPAI public site to $USER@$HOST..."

# 1. Create directory on VPS
ssh "$USER@$HOST" "sudo mkdir -p /var/www/opai-landing && sudo chown $USER:$USER /var/www/opai-landing"

# 2. Copy static files
scp -r "$SITE_DIR/"* "$USER@$HOST:/var/www/opai-landing/"

echo "Static files deployed."

# 3. Merge Caddyfile (show diff, don't auto-apply)
echo ""
echo "Caddy config is at: $SCRIPT_DIR/bb-vps-caddyfile"
echo ""
echo "To apply:"
echo "  1. SSH into BB VPS: ssh $USER@$HOST"
echo "  2. Edit Caddyfile:  sudo nano /etc/caddy/Caddyfile"
echo "  3. Add the opai.boutabyte.com block from bb-vps-caddyfile"
echo "  4. Test config:     sudo caddy validate --config /etc/caddy/Caddyfile"
echo "  5. Reload:          sudo systemctl reload caddy"
echo ""
echo "Or copy directly:"
echo "  scp $SCRIPT_DIR/bb-vps-caddyfile $USER@$HOST:/tmp/opai-caddy.conf"
echo "  ssh $USER@$HOST 'sudo cat /tmp/opai-caddy.conf >> /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy'"
echo ""
echo "Done!"
