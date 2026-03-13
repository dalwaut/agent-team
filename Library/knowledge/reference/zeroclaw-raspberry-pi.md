# ZeroClaw on Raspberry Pi Zero 2 W — Install Guide

**Source:** [PJ Bell — YouTube](https://www.youtube.com/watch?v=jqs_8NXdfkU)
**Date saved:** 2026-02-28
**Hardware:** Raspberry Pi Zero 2 W (512MB RAM, ARM64)
**Software:** ZeroClaw (Rust rewrite of OpenClaw) — single 3.4MB static binary

---

## What Is ZeroClaw

ZeroClaw is a Rust rewrite of OpenClaw. Unlike OpenClaw (Node.js, npm, dynamic dependencies), ZeroClaw compiles to a **single static binary** — no runtime, 3.4MB, ~2MB RAM usage. It uses the Anthropic API (not Claude Code CLI).

- Repo: `https://github.com/zeroclaw-labs/zeroclaw`
- Comparison vs OpenClaw: startup faster, binary smaller, memory lower

---

## Parts List

| Item | Notes |
|------|-------|
| Raspberry Pi Zero 2 W | ~$15, ARM64, 512MB RAM |
| MicroSD card | 64GB minimum |
| Power supply | USB micro |
| Case + heat sink kit | ~$10 kit recommended (includes OTG cable, HDMI adapter) |
| USB Ethernet adapter | **Important** — Pi Zero Wi-Fi is weak, hardline for updates |
| Cat5/Cat6 cable | For ethernet adapter |

---

## Phase 1: Flash Raspberry Pi OS

1. Download Raspberry Pi Imager from `raspberrypi.com/software`
2. Select device: **Raspberry Pi Zero 2 W**
3. Select OS: **Raspberry Pi OS (64-bit)** — must be 64-bit for ZeroClaw ARM64 binary
4. Configure:
   - Hostname: `claw` (or whatever you want)
   - Username/password: set during imaging
   - Wi-Fi: enter SSID + password
   - **SSH: enable with public key authentication** (not password)
5. Generate SSH key if needed:
   ```bash
   ssh-keygen -t ed25519 -C "zeroclaw-to-mac"
   # Enter passphrase when prompted
   cat ~/.ssh/id_ed25519.pub
   # Copy the public key into the imager
   ```
6. Enable Raspberry Pi Connect (optional — `connect.raspberrypi.com/devices`)
7. Write to SD card, insert into Pi, power on
8. Wait ~5 minutes for first boot

---

## Phase 2: Base Preparation

SSH into the Pi:
```bash
ssh zero@<pi-ip-address>
# Enter passphrase
```

Update system:
```bash
sudo apt update
sudo apt upgrade -y
# This takes ~10 minutes on Pi Zero
```

Install minimal tools:
```bash
sudo apt install -y curl rsync
```

---

## Phase 3: Tailscale Setup

Install Tailscale for secure remote access:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Copy the login URL, open in browser, connect device
```

Get the Tailscale IP from the admin console, then SSH via Tailscale:
```bash
ssh zero@<tailscale-ip>
```

This IP is static and works from anywhere on the Tailscale mesh network.

---

## Phase 4: Build ZeroClaw (on Mac, NOT on Pi)

**Do NOT build on the Pi** — 512MB RAM is not enough. Cross-compile on your main machine.

### Prerequisites (Mac)

```bash
# Install Homebrew if needed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Choose standard installation, then:
source $HOME/.cargo/env

# Verify
rustc --version
cargo --version
```

### Add ARM64 target + cross-compiler

```bash
# Add Pi ARM64 target
rustup target add aarch64-unknown-linux-musl

# Verify
rustup target list --installed
# Should include: aarch64-unknown-linux-musl

# Install musl cross-compiler (Mac only)
brew install filosottile/musl-cross/musl-cross
which aarch64-linux-musl-gcc
# Should show a valid path
```

### Clone and build

```bash
git clone https://github.com/zeroclaw-labs/zeroclaw.git
cd zeroclaw
```

Edit `Cargo.toml` — add at the bottom:
```toml
[target.aarch64-unknown-linux-musl]
linker = "aarch64-linux-musl-gcc"
```

Build:
```bash
cargo clean
cargo build --release --target aarch64-unknown-linux-musl
```

Verify:
```bash
ls target/aarch64-unknown-linux-musl/release/zeroclaw
file target/aarch64-unknown-linux-musl/release/zeroclaw
# Should say: ELF 64-bit LSB executable, ARM aarch64
```

---

## Phase 5: Transfer Binary to Pi

```bash
scp target/aarch64-unknown-linux-musl/release/zeroclaw zero@<tailscale-ip>:/home/zero/
```

On the Pi:
```bash
chmod +x zeroclaw
./zeroclaw --version
```

---

## Phase 6: Service Identity & Isolation

Create a dedicated system user (no login shell, no interactive access):
```bash
# Create system user
sudo useradd --home /var/lib/zeroclaw --create-home --shell /usr/sbin/nologin zeroclaw

# Move binary to canonical location
sudo mkdir -p /opt/zeroclaw
sudo mv ~/zeroclaw /opt/zeroclaw/

# Lock down ownership
sudo chown -R zeroclaw:zeroclaw /opt/zeroclaw
sudo chmod 755 /opt/zeroclaw/zeroclaw

# Create symlink for PATH access
sudo ln -sf /opt/zeroclaw/zeroclaw /usr/local/bin/zeroclaw

# Verify system user can run it
sudo -u zeroclaw /usr/local/bin/zeroclaw --version
```

---

## Phase 7: systemd Service

Create `/etc/systemd/system/zeroclaw.service`:
```ini
[Unit]
Description=ZeroClaw AI Agent
After=network-online.target
Wants=network-online.target

[Service]
User=zeroclaw
Group=zeroclaw
ExecStart=/opt/zeroclaw/zeroclaw
WorkingDirectory=/var/lib/zeroclaw
Restart=on-failure
RestartSec=5

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=zeroclaw

# Security hardening
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/zeroclaw
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable zeroclaw
sudo systemctl start zeroclaw
```

Verify:
```bash
systemctl is-active zeroclaw
# Should say: active
```

---

## Phase 8: Configure API Key

```bash
sudo -u zeroclaw nano /var/lib/zeroclaw/.zeroclaw/config.toml
```

Set:
- `api_key` = your Anthropic API key
- `provider` = `anthropic`
- `default_model` = `claude-3-haiku-20240307` (recommended for cost)

Lock down config permissions:
```bash
chmod 600 /var/lib/zeroclaw/.zeroclaw/config.toml
```

Test:
```bash
sudo -u zeroclaw zeroclaw agent -m "Hello"
```

---

## Verify Survives Reboot

```bash
sudo reboot
# Wait 2-3 minutes, SSH back in
systemctl is-active zeroclaw
# Should say: active
```

---

## Security Notes

| Practice | Implementation |
|----------|---------------|
| No root execution | Dedicated `zeroclaw` system user |
| No login shell | `--shell /usr/sbin/nologin` |
| Binary tampering protection | Only root can modify, user can only execute |
| Config secrets | `chmod 600` on config.toml |
| Blast radius containment | `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths` scoped |
| SSH key auth only | No password-based SSH |
| Tailscale mesh | Encrypted tunnel, no port forwarding needed |

---

## OPAI Context

- OPAI Server already uses Tailscale (`bb-vps` at `100.106.200.68`)
- If deploying on OPAI's Pi, the Tailscale network is already configured
- ZeroClaw uses Anthropic **API** (requires API key + costs) — different from OPAI's CLI approach
- The systemd hardening patterns (ProtectSystem, dedicated users) could be applied to OPAI services for stricter isolation
- This is a reference guide, not an active OPAI integration
