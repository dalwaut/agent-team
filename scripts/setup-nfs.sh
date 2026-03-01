#!/usr/bin/env bash
# OPAI NFS Setup — Mount Synology NAS user storage
#
# One-time setup: installs nfs-common, verifies NFS exports,
# creates mount point, mounts, and adds to /etc/fstab.
#
# Usage: sudo ./scripts/setup-nfs.sh
#
# Prerequisites (done in Synology DSM):
#   1. Shared folder "opai-users" on Volume 2 (Btrfs)
#   2. NFS enabled (Control Panel → File Services → NFS → NFSv4.1)
#   3. NFS Permissions on opai-users:
#      - Hostname/IP: 192.168.2.92 (OPAI server LAN IP)
#      - Privilege: Read/Write
#      - Squash: Map all users to admin
#      - Allow non-privileged ports: Yes
#      - Enable async: Yes

set -euo pipefail

# ── Configuration ────────────────────────────────────────────

NAS_IP="192.168.2.138"
NFS_EXPORT="/volume2/opai-users"
MOUNT_POINT="/workspace/users"
NFS_OPTIONS="rw,soft,timeo=50,retrans=3,nfsvers=4.1,_netdev"

# ── Colors ────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Preflight ─────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
    err "This script must be run as root (sudo)"
fi

echo "=== OPAI NFS Setup ==="
echo "NAS: ${NAS_IP}"
echo "Export: ${NFS_EXPORT}"
echo "Mount: ${MOUNT_POINT}"
echo ""

# ── Step 1: Install nfs-common ────────────────────────────────

if dpkg -l nfs-common &>/dev/null; then
    log "nfs-common already installed"
else
    echo "Installing nfs-common..."
    apt-get update -qq && apt-get install -y -qq nfs-common
    log "nfs-common installed"
fi

# ── Step 2: Verify NFS exports ───────────────────────────────

echo "Checking NFS exports on ${NAS_IP}..."
if showmount -e "${NAS_IP}" 2>/dev/null | grep -q "${NFS_EXPORT}"; then
    log "NFS export ${NFS_EXPORT} is available"
else
    warn "Cannot see NFS export. Possible causes:"
    echo "  - NFS not enabled in Synology DSM"
    echo "  - NFS permissions not set for this server's IP ($(hostname -I | awk '{print $1}'))"
    echo "  - Firewall blocking NFS ports (111, 2049)"
    echo ""
    echo "Available exports from ${NAS_IP}:"
    showmount -e "${NAS_IP}" 2>/dev/null || echo "  (none or unreachable)"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# ── Step 3: Create mount point ────────────────────────────────

if [[ -d "${MOUNT_POINT}" ]]; then
    log "Mount point ${MOUNT_POINT} exists"
else
    mkdir -p "${MOUNT_POINT}"
    log "Created mount point ${MOUNT_POINT}"
fi

# ── Step 4: Mount NFS ────────────────────────────────────────

if mountpoint -q "${MOUNT_POINT}" 2>/dev/null; then
    log "${MOUNT_POINT} is already mounted"
else
    echo "Mounting NFS..."
    mount -t nfs4 -o "${NFS_OPTIONS}" "${NAS_IP}:${NFS_EXPORT}" "${MOUNT_POINT}"
    log "Mounted ${NAS_IP}:${NFS_EXPORT} → ${MOUNT_POINT}"
fi

# ── Step 5: Verify mount ─────────────────────────────────────

echo "Testing write access..."
TEST_FILE="${MOUNT_POINT}/.nfs-test-$$"
if touch "${TEST_FILE}" 2>/dev/null; then
    rm -f "${TEST_FILE}"
    log "Write access confirmed"
else
    warn "Cannot write to ${MOUNT_POINT}. Check NFS permissions in DSM."
fi

# ── Step 6: Add to /etc/fstab ────────────────────────────────

FSTAB_ENTRY="${NAS_IP}:${NFS_EXPORT}  ${MOUNT_POINT}  nfs4  ${NFS_OPTIONS}  0  0"

if grep -qF "${NAS_IP}:${NFS_EXPORT}" /etc/fstab; then
    log "fstab entry already exists"
else
    echo "" >> /etc/fstab
    echo "# OPAI user sandboxes (Synology NAS)" >> /etc/fstab
    echo "${FSTAB_ENTRY}" >> /etc/fstab
    log "Added to /etc/fstab (persistent across reboots)"
fi

# ── Summary ───────────────────────────────────────────────────

echo ""
echo "=== NFS Setup Complete ==="
echo "Mount: ${MOUNT_POINT}"
echo "Source: ${NAS_IP}:${NFS_EXPORT}"
echo ""
echo "Verify with:"
echo "  df -h ${MOUNT_POINT}"
echo "  ls -la ${MOUNT_POINT}"
echo ""
echo "Next steps:"
echo "  1. Create user directories on NAS: /volume2/opai-users/denise/ etc."
echo "  2. Run provision-sandbox.sh for each user"
