#!/bin/bash
# migrate-tailsync-to-user-service.sh
# Run ONCE with sudo: sudo bash scripts/migrate-tailsync-to-user-service.sh
# Moves tailsync-server from system service to user service so it can be
# started/stopped without sudo (enabling the desktop toggle icon)

echo "=== Migrating tailsync-server to user service ==="

# Stop and disable the system-level service
systemctl stop tailsync-server
systemctl disable tailsync-server
echo "[1/2] System service stopped and disabled"

# Fix ownership of config/dist so user service can write/read
chown -R dallas:dallas /home/dallas/.tailsync/
echo "[2/2] Config ownership fixed"

echo ""
echo "Done. Now run as dallas (no sudo):"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable tailsync-server"
echo "  systemctl --user start tailsync-server"
