# Headless Display — Virtual Desktop at 2560x1440

> Run the OPAI server's GNOME desktop at full resolution with no physical monitor, accessible via RustDesk.

**Status**: Live (2026-02-28)
**Hardware**: HP Z420, NVIDIA GTX 980, Ubuntu 24.04 LTS

---

## Overview

The OPAI server runs a full GUI desktop (GNOME on GDM3) for tools like RustDesk, SCC IDE, and browser automation. This headless display config lets you unplug the physical monitor and maintain a 2560x1440 virtual desktop, remotely accessible via RustDesk or any VNC-compatible client.

---

## Architecture

```
Physical Monitor (disconnected)
        ↓ (no signal)
NVIDIA GTX 980 (DVI-I-1 / DFP-0)
        ↓ (xorg.conf forces "connected" state)
ConnectedMonitor "DFP-0" + MetaModes "2560x1440"
        ↓
GDM3 / GNOME session @ 2560x1440
        ↓
RustDesk mirrors virtual display
        ↓
Remote access at full resolution
```

---

## Key Files

| File | Purpose |
|------|---------|
| `config/xorg-headless-2560x1440.conf` | Source-of-truth xorg.conf (copy to `/etc/X11/xorg.conf`) |
| `scripts/setup-headless-display.sh` | Dynamic generator script (any resolution) |
| `/etc/X11/xorg.conf` | Live system config (deployed from repo config) |

---

## How It Works

The NVIDIA driver needs three directives to create a virtual display without a physical monitor:

1. **`ConnectedMonitor "DFP-0"`** — Forces the GPU to treat DVI-I-1 as connected even with no EDID signal
2. **`MetaModes "DFP-0: 2560x1440 +0+0"`** — Sets the desired resolution
3. **`ModeValidation` bypasses** — Disables native resolution checks, pixel clock limits, and EDID validation that would otherwise reject the synthetic mode

The `Monitor` section provides fallback HorizSync/VertRefresh ranges so the driver can validate timing without a real EDID.

---

## Configuration

Current live config (`config/xorg-headless-2560x1440.conf`):

```conf
Section "Device"
    Identifier     "GPU0"
    Driver         "nvidia"
    BoardName      "GeForce GTX 980"
    Option         "ConnectedMonitor" "DFP-0"
    Option         "AllowEmptyInitialConfiguration" "true"
    Option         "ModeValidation" "NoDFPNativeResolutionCheck,NoVirtualSizeCheck,NoMaxPClkCheck,NoEdidMaxPClkCheck,AllowNon60HzDFPModes"
EndSection

Section "Screen"
    Identifier     "Screen0"
    Device         "GPU0"
    Monitor        "Monitor0"
    DefaultDepth    24
    Option         "MetaModes" "DFP-0: 2560x1440 +0+0"
    Option         "DPI" "96 x 96"
    SubSection     "Display"
        Depth       24
        Modes      "2560x1440"
    EndSubSection
EndSection

Section "Monitor"
    Identifier     "Monitor0"
    VendorName     "Virtual"
    ModelName      "Virtual Display"
    HorizSync       28.0-100.0
    VertRefresh     48.0-75.0
    Option         "DPMS" "false"
EndSection
```

---

## Remote Access Stack

All three remote access methods start on boot automatically:

| Service | Type | Port | Purpose |
|---------|------|------|---------|
| RustDesk | system (enabled) | default | GUI remote desktop — mirrors the virtual display |
| SSH | system (enabled) | 22 | Terminal access, emergency recovery |
| Tailscale | system (enabled) | — | VPN mesh (opai-server @ 100.72.206.23) |

**Linger enabled** for user `dallas` — all user-level OPAI services start at boot without login.

---

## Deploying / Changing Resolution

```bash
# Deploy the repo config
sudo cp /workspace/synced/opai/config/xorg-headless-2560x1440.conf /etc/X11/xorg.conf
sudo systemctl restart gdm

# Or use the dynamic generator for a different resolution
sudo ./scripts/setup-headless-display.sh 1920x1080
sudo systemctl restart gdm

# Runtime override (immediate, not persistent)
xrandr --output DVI-I-1 --mode 2560x1440
```

---

## Recovery

If the display breaks after config changes, SSH in and reset:

```bash
# Nuclear reset — removes xorg.conf, GDM uses defaults
sudo rm /etc/X11/xorg.conf && sudo systemctl restart gdm

# Then plug a physical monitor back in if needed
```

---

## Gotchas

- **Physical monitor overrides headless config**: When a real monitor is connected, the GPU reads its EDID and uses the monitor's native resolution instead of MetaModes. The headless config only takes effect with no monitor attached.
- **GDM restart required after config change**: Unplugging the monitor mid-session keeps the old resolution. Either restart GDM or use `xrandr --output DVI-I-1 --mode 2560x1440` to switch at runtime.
- **CustomEDID approach failed**: Generating a synthetic EDID binary (`/etc/X11/edid/*.bin`) caused `The EDID has a bad detailed timing descriptor` errors. The ConnectedMonitor + MetaModes approach is simpler and works reliably.
- **DFP-0 vs DVI-I-1**: The NVIDIA driver uses `DFP-0` internally for the DVI-I-1 output. xorg.conf uses `DFP-0`; xrandr shows `DVI-I-1`. They refer to the same port.
- **Max pixel clock**: GTX 980 supports 330 MHz. 2560x1440@60Hz needs ~241.5 MHz — well within limits. Higher resolutions (4K) may need pixel clock validation.

---

## Approaches Considered

| Approach | Result | Notes |
|----------|--------|-------|
| **ConnectedMonitor + MetaModes** | **Works** | Current approach — simple, no extra files |
| CustomEDID binary | Failed | Bad timing descriptor, driver rejects it |
| xrandr runtime | Works | Not persistent across reboots |
| HDMI dummy plug ($5) | Not tested | Hardware solution, zero config needed |

---

## Dependencies

- NVIDIA proprietary driver (535.x+)
- GDM3 (GNOME Display Manager)
- RustDesk (for remote GUI access)
- SSH + Tailscale (for recovery/backup access)
