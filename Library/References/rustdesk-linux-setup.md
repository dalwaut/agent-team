# RustDesk on Linux — NinjaOne Deployment Guide

## Overview

NinjaOne's Ninja Remote and Splashtop do not support Linux GUI remote desktop. This guide deploys **RustDesk** (free, open-source) as the remote desktop solution for Linux endpoints, configured headlessly via NinjaOne's remote terminal.

**Stack:** NinjaOne (terminal) + RustDesk (GUI remote desktop)
**Time:** ~5 minutes per endpoint
**Cost:** Free (uses public relay servers)

---

## Step 1 — Install RustDesk

Run via **NinjaOne Remote Terminal** (or SSH):

```bash
# Download latest RustDesk .deb
wget -q https://github.com/rustdesk/rustdesk/releases/download/1.4.5/rustdesk-1.4.5-x86_64.deb -O /tmp/rustdesk.deb

# Install (auto-resolves dependencies)
sudo apt install -fy /tmp/rustdesk.deb

# Clean up installer
rm /tmp/rustdesk.deb
```

> The install auto-creates and enables a systemd service (`rustdesk.service`) so it starts on boot.

---

## Step 2 — Set a Permanent Password

```bash
# Set a permanent password (replace YOUR_PASSWORD with something strong)
sudo rustdesk --password YOUR_PASSWORD
```

This avoids needing someone at the physical machine to approve connections.

---

## Step 3 — Get the Device ID

```bash
# Get the RustDesk device ID (9-digit number)
rustdesk --get-id
```

Write this down — you'll enter it on the Windows client to connect.

---

## Step 4 — Verify the Service Is Running

```bash
# Check RustDesk service status
sudo systemctl status rustdesk

# If not running, start it
sudo systemctl start rustdesk

# Ensure it starts on boot
sudo systemctl enable rustdesk
```

You should see `active (running)` in the output.

---

## Step 5 — Connect from Windows

1. Download RustDesk for Windows: [https://rustdesk.com](https://rustdesk.com)
2. Install and open it
3. Enter the **9-digit ID** from Step 3
4. Enter the **password** from Step 2
5. You're in

---

## Wayland Fix (Ubuntu 24.04 LTS)

Ubuntu 24.04 defaults to Wayland, which can cause issues. If remote desktop is blank or glitchy:

```bash
# Switch from Wayland to Xorg (permanent)
sudo sed -i 's/#WaylandEnable=false/WaylandEnable=false/' /etc/gdm3/custom.conf

# Restart display manager (will log out the desktop user)
sudo systemctl restart gdm3
```

After restart, select **"Ubuntu on Xorg"** at the login screen (gear icon).

---

## All-in-One Script

Copy-paste this entire block into NinjaOne Remote Terminal to do everything at once:

```bash
#!/bin/bash
# === RustDesk Headless Install for Linux ===
# Run via NinjaOne Remote Terminal or SSH as root

set -e

RUSTDESK_VERSION="1.4.5"
RUSTDESK_PASSWORD="CHANGE_ME"  # <-- SET YOUR PASSWORD HERE

echo "=== Installing RustDesk ${RUSTDESK_VERSION} ==="

# Download
wget -q "https://github.com/rustdesk/rustdesk/releases/download/${RUSTDESK_VERSION}/rustdesk-${RUSTDESK_VERSION}-x86_64.deb" -O /tmp/rustdesk.deb

# Install
apt install -fy /tmp/rustdesk.deb

# Clean up
rm -f /tmp/rustdesk.deb

# Set permanent password
rustdesk --password "${RUSTDESK_PASSWORD}"

# Ensure service is running
systemctl enable rustdesk
systemctl restart rustdesk

# Fix Wayland (Ubuntu 24.04+)
if [ -f /etc/gdm3/custom.conf ]; then
    sed -i 's/#WaylandEnable=false/WaylandEnable=false/' /etc/gdm3/custom.conf
    echo "=== Wayland disabled. Restart gdm3 or reboot for Xorg. ==="
fi

# Get device ID
sleep 2
DEVICE_ID=$(rustdesk --get-id 2>/dev/null || echo "ID not available - check after reboot")

echo ""
echo "==============================="
echo "  RustDesk Install Complete"
echo "  Device ID: ${DEVICE_ID}"
echo "  Password:  ${RUSTDESK_PASSWORD}"
echo "==============================="
echo ""
echo "Connect from Windows RustDesk client using the ID and password above."
echo "If ID shows 'not available', reboot the machine and run: rustdesk --get-id"
```

> **Before running:** Change `CHANGE_ME` to your actual password.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `cannot open display` | Normal when running over SSH/NinjaOne terminal. The service runs in the background — you don't need the GUI window. |
| ID returns empty | Reboot the machine, then run `rustdesk --get-id` |
| Black screen on connect | Wayland issue. Run the Wayland fix above and reboot. |
| Connection times out | Check firewall: `sudo ufw status`. RustDesk uses outbound connections only, so no ports need to be opened. |
| Service won't start | `sudo journalctl -u rustdesk -n 50` to check logs |
| Slow performance | In RustDesk Windows client: Settings > Display > change codec to H264 or VP9 |
| Want to update later | Re-run Step 1 with the new version number |

---

## Managing Multiple Endpoints

For deploying across multiple Linux machines via NinjaOne:

1. Save the all-in-one script as a **NinjaOne script** (Bash/Shell type)
2. Set a unique password per machine (or use the same one for simplicity)
3. Deploy to all Linux endpoints
4. Collect the Device IDs from script output or run `rustdesk --get-id` via terminal on each
5. Store IDs in your NinjaOne device notes or a spreadsheet

---

## Reference

- RustDesk Docs: [https://rustdesk.com/docs/en/](https://rustdesk.com/docs/en/)
- RustDesk GitHub: [https://github.com/rustdesk/rustdesk](https://github.com/rustdesk/rustdesk)
- NinjaOne Linux Terminal: Available under device > Remote Terminal
