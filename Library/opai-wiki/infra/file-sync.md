# File Sync & Storage Infrastructure

> Last updated: 2026-03-05 | Sources: `~/.SynologyDrive/`, `config/orchestrator.json`, NFS mounts, system filter investigation

## Overview

OPAI's workspace (`/workspace/synced/opai`) is synchronized to a Synology DS418 NAS via **Synology Drive Client**. A separate **NFS v4.1 mount** provides shared user storage for ClawBot workers. These are independent systems with no path overlap.

**TailSync** (a chokidar-based file watcher for VS Code sync) was previously installed but caused severe resource drain — it has been **archived and masked** as of 2026-03-05.

## Architecture

```
/workspace/synced/opai/     ← Synology Drive sync (session 3)
   ├── tools/               ← Source code, synced to NAS
   ├── Projects/             ← Client projects, synced to NAS
   ├── Library/              ← Wiki + knowledge, synced to NAS
   └── ...

/workspace/users/            ← NFS v4.1 mount (separate)
   ├── dallas/               ← User home dirs
   ├── denise/
   ├── _clawbots/            ← NFS dispatcher drop folders
   └── _admin/hitl/          ← HITL response files
```

| System | Path | Target | Purpose |
|--------|------|--------|---------|
| **Synology Drive** | `/workspace/synced/opai/` | DS418 NAS (192.168.1.200) | Workspace backup + cross-device sync |
| **NFS v4.1** | `/workspace/users/` | DS418 (`ds418.local:/volume2/opai-users`) | Shared user storage for ClawBot/workers |

**No overlap** — Synology syncs source code/config, NFS serves user home directories.

## Synology Drive Configuration

### Session 3 (Primary — OPAI Workspace)

- **Local path**: `/workspace/synced/opai/`
- **Remote**: DS418 NAS via Synology Drive protocol (port 6690)
- **Scope**: ~801,752 files, ~81,475 directories, ~17 GB
- **Config**: `~/.SynologyDrive/data/session/3/conf/blacklist.filter`

### Blacklist Filter

The blacklist controls which files/directories are **excluded from sync**. Entries use root-relative path prefixes (matching from the sync root, not nested paths).

**Current filter** (`~/.SynologyDrive/data/session/3/conf/blacklist.filter`):

```ini
[Common]
black_prefix = "."
black_dir_prefix = "/.git", "/.github", "/.obsidian", "/Agent-Profiles", "/Cursor",
"/Obsidian", "/config", "/gemini-scribe", "/logs", "/reports",
"/tasks", "/node_modules", "/__pycache__", "/venv", "/.venv",
"/.playwright-mcp", "/tools/opai-engine/data",
"/tools/opai-email-agent/data", "/tools/opai-brain/data"

[File]
black_suffix = ".lnk", ".pst", ".swp", ".temp", ".tmp", ".pyc"
```

| Entry | Why |
|-------|-----|
| `/node_modules` | Root-level node_modules (~25K dirs). **Note**: nested `Projects/*/node_modules/` not caught by prefix format |
| `/__pycache__`, `/venv`, `/.venv` | Python build artifacts |
| `/tools/opai-engine/data` | **Critical** — engine state files (`engine-state.json`, `workspace-chat-state.json`, etc.) write every 30s, causing ~40 events/min sync churn |
| `/tools/opai-email-agent/data`, `/tools/opai-brain/data` | Similar runtime state files |
| `/logs`, `/reports`, `/tasks` | High-churn operational files |
| `/config` | Contains secrets and runtime state |
| `black_prefix = "."` | All dotfiles/dotdirs (`.git`, `.claude`, `.env`, etc.) |
| `.pyc` suffix | Compiled Python bytecode |

### Blacklist Limitations

The `black_dir_prefix` format only matches **root-relative paths**. It cannot exclude nested directories by name pattern. For example:

- `"/node_modules"` blocks `/node_modules/` but NOT `/Projects/BoutaChat/node_modules/`
- `"/data"` blocks `/data/` but NOT `/tools/opai-engine/data/` (must use full path)

To exclude nested `node_modules` across all Projects, use the **system-level filter** (see below) — it matches directory **names** globally regardless of depth.

### System-Level Filter (Global Name-Based Exclusion)

The session blacklist only does root-relative path matching. For **name-based exclusion** (matching `node_modules` at any depth), use the **system-level filter**:

**File**: `~/.SynologyDrive/SynologyDrive.app/conf/filter`

```ini
[Directory]
black_name = "@tmp", "@eaDir", ".SynologyWorkingDirectory", "#recycle", "desktop.ini",
  ".ds_store", "Icon\r", "thumbs.db", "$Recycle.Bin", "@sharebin",
  "System Volume Information", "Program Files", "Program Files (x86)",
  "ProgramData", "#snapshot",
  "node_modules", ".git", "__pycache__", ".venv", ".cache"
```

The last 5 entries were added 2026-03-05 to solve a rescan regression. The `[Directory] black_name` list matches directory **names** globally — unlike the session blacklist's `black_dir_prefix` which only matches root-relative paths. This catches `Projects/*/node_modules/`, `tools/*/node_modules/`, etc.

**Other sections in the system filter:**

| Section | Key | Purpose |
|---------|-----|---------|
| `[Common]` | `black_char` | Illegal characters in filenames |
| `[Common]` | `black_name` | Names excluded from all sync operations |
| `[Common]` | `max_length`, `max_path` | Path length limits (255 / 2048) |
| `[File]` | `black_name` | File names excluded from sync |
| `[File]` | `black_prefix` | File prefix exclusion (`~` temp files) |
| `[Directory]` | `black_name` | **Directory names excluded globally** (the fix) |

> **Important**: This file is inside the Synology Drive app bundle (`SynologyDrive.app/conf/`). It may be overwritten on app updates — re-check after updating Synology Drive Client.

### .SynologyDriveIgnore

A `.SynologyDriveIgnore` file (`.gitignore` syntax) was also placed at the sync root (`/workspace/synced/opai/.SynologyDriveIgnore`). Support for this file varies by Synology Drive Client version — the system-level filter is the confirmed fix.

### Rescan Percentage Regression (2026-03-05)

**Symptom**: Rescan progress went **backwards** (5.0% → 4.0%) between two status checks one hour apart. Both the scanned count (4,054 → 3,282) and percentage dropped.

**Root cause** (two compounding factors):

1. **Denominator inflation** — As the scanner crawled into deeply nested `node_modules` trees, it discovered far more subdirectories than initially estimated, inflating the total directory count.
2. **Scanner restart** — The daemon (pegged at 100% CPU) restarted or re-indexed a portion when hitting resource pressure, resetting the scanned count.

The ETA jumping from 21h to 2d 2h confirmed the scanner was struggling with `node_modules` (tens of thousands of nested directories with zero sync value).

**Fix**: Added `node_modules`, `.git`, `__pycache__`, `.venv`, `.cache` to the system-level filter's `[Directory] black_name` (see above). After restarting Synology Drive Client, the daemon CPU dropped from **91% → 0.1%** within seconds as it skipped all excluded directories.

**Lesson**: The per-session blacklist (`black_dir_prefix`) only catches root-level `node_modules/`. Nested instances (inside `Projects/`, `tools/`, `mcps/`) were still being scanned — tens of thousands of directories. The system-level filter's name-based matching is the correct solution for this class of problem.

### Session 4 (Secondary)

A smaller sync task with default filters only. Likely syncs `/workspace/synced/shared/` or another secondary folder.

## NFS Mount

```
ds418.local:/volume2/opai-users → /workspace/users (NFS v4.1, soft mount)
```

| Setting | Value |
|---------|-------|
| Protocol | NFS v4.1 over TCP |
| Read/Write size | 131072 bytes |
| Timeout | 50 (5 seconds) |
| Retrans | 3 |
| Security | sys (standard Unix) |
| Mount option | `_netdev` (waits for network) |

Used by the [NFS Dispatcher](nfs-dispatcher.md) for external worker communication via drop-folder pattern (`/workspace/users/_clawbots/`).

## Performance Tuning (2026-03-05)

### Problem

RustDesk remote connection became slow (buffering, pixelated) despite 1Gbps full-duplex link with zero packet errors. Root cause: CPU starvation from three compounding issues.

### Diagnosis

| Process | CPU | RAM | Issue |
|---------|-----|-----|-------|
| **TailSync** (PID 8403) | 18% | 3.36 GB | Orphan process, 883K inotify watches, zero clients connected |
| **Synology Drive** | 27.6% | ~100 MB | 81K inotify watches, ~40 events/min from engine state files, no node_modules exclusion |
| **opai-engine** | 52% | 180 MB | 14 background loops (expected, not a bug) |

Combined: **~98% CPU** consumed, starving RustDesk of encoding cycles.

### Fixes Applied

**1. TailSync — Killed and Archived**

TailSync was a chokidar-based file watcher (`/opt/tailsync-server/`) for a VS Code sync extension. It watched the entire `/workspace/synced` tree, consuming 883K inotify watches (84% of all system watches) and 3.36 GB RAM — with zero connected clients.

```bash
# What was done:
kill 8403                                          # Killed orphan process
mv ~/.tailsync ~/.tailsync.disabled                # Disabled config
sudo rm /etc/systemd/system/tailsync-server.service  # Removed unit file
sudo systemctl daemon-reload && sudo systemctl mask tailsync-server  # Masked
sudo tar czf /opt/tailsync-server.archived.tar.gz -C /opt tailsync-server
sudo rm -rf /opt/tailsync-server                   # Archived + removed
```

**Impact**: Freed 3.36 GB RAM + 18% CPU + 883K inotify watches immediately.

**2. Synology Drive Blacklist — State Files + Build Artifacts**

Added to blacklist filter:
- `/node_modules`, `/__pycache__`, `/venv`, `/.venv` — build artifacts (~25K+ directories)
- `/tools/opai-engine/data` — eliminates ~40 events/min from state file writes
- `/tools/opai-email-agent/data`, `/tools/opai-brain/data` — similar runtime state
- `.pyc` file suffix

**Impact**: Eliminates continuous sync churn. Expected steady-state CPU drop from 27% to ~5-10% (after initial rescan completes).

**3. Engine Intervals — No Change**

Engine's 30s polling loops (chat, auto-executor, resource monitor, NFS dispatcher) were tested at 60s but only saved ~6% CPU. Reverted to preserve near-live responsiveness — the engine CPU is dominated by actual work, not polling overhead.

### Results

| Metric | Before | After |
|--------|--------|-------|
| RAM free | 2.4 GB | 5.2 GB |
| RAM available | 12 GB | 16 GB |
| Load average | 3.31 | 1.86 |
| Swap used | 1.7 GB | 1.5 GB |
| inotify watches (system) | 1,046,517 | ~163K |

## Synology Rescan Monitor

After changing the blacklist filter, Synology Drive performs a full rescan of all directories. This is a one-time operation that takes ~24 hours for the 81K directory tree.

A **temporary notification** was added to the heartbeat system to track rescan progress. It sends to the same Telegram Server Status topic on the same cadence as the activity digest (every `digest_interval_cycles` heartbeat cycles).

**Notification format:**
```
📂 Synology Rescan

🟢 Progress  3.0%  ▰▱▱▱▱▱▱▱▱▱
       2,438 / ~81,500 dirs
💻 Daemon CPU: 95%
⏱️ ETA: 21h 15m
📁 Current: /Projects/WE Tools/node_modules/micro...
```

**Auto-stop**: The notification returns `None` (no-op) when:
- The daemon is not running
- No rescan activity detected in the last 5 minutes (= rescan complete)

**Key files:**
- `tools/opai-engine/background/notifier.py` → `notify_synology_rescan()`
- `tools/opai-engine/background/heartbeat.py` → `_check_synology_rescan()`

This monitor can be removed once the rescan completes. It has no persistent state and no configuration — it reads the daemon log and process info directly.

## Key Files

| File | Purpose |
|------|---------|
| `~/.SynologyDrive/data/session/3/conf/blacklist.filter` | Sync exclusion rules (root-relative prefixes) |
| `~/.SynologyDrive/SynologyDrive.app/conf/filter` | **System-level filter** — global name-based exclusions (catches nested dirs) |
| `~/.SynologyDrive/data/config/client.conf` | Daemon runtime config (paths, ports, logging) |
| `~/.SynologyDrive/log/daemon.log` | Daemon activity log (rotated, ~5MB per rotation) |
| `~/.SynologyDrive/data/db/file-status.sqlite` | File tracking database |
| `/workspace/synced/opai/.SynologyDriveIgnore` | Gitignore-style exclusions (version-dependent support) |
| `/etc/fstab` (NFS entry) | NFS mount configuration |
| `config/orchestrator.json` → `nfs_dispatcher` | NFS dispatcher polling config |
| `/opt/tailsync-server.archived.tar.gz` | Archived TailSync (do not restore) |
| `~/.tailsync.disabled/` | Disabled TailSync config |

## Operational Notes

- **After editing filters**: Restart Synology Drive Client via system tray (Quit → Relaunch). Do NOT start the daemon binary directly — it requires library paths set by the UI launcher.
- **Two filter levels**: Session blacklist (`~/.SynologyDrive/data/session/3/conf/blacklist.filter`) for root-relative path exclusions. System filter (`~/.SynologyDrive/SynologyDrive.app/conf/filter`) for **global name-based** exclusions (catches nested dirs at any depth).
- **System filter survives restarts** but may be **overwritten on app updates** — re-check `[Directory] black_name` after updating the Synology Drive Client.
- **NFS mount recovery**: If NFS mount drops, `sudo mount -a` to remount. The `_netdev` option means it waits for network on boot.
- **inotify watch limits**: System limit is 2,097,152 (`/proc/sys/fs/inotify/max_user_watches`). Synology uses ~81K. Monitor with `cat /proc/{pid}/fdinfo/16 | grep -c inotify`.
- **TailSync is archived**: Systemd unit is masked. Do not restore unless the chokidar memory issue is resolved (it consumed 1KB per inotify watch in heap, scaling to 3.4GB for the workspace).

## Dependencies

- [NFS Dispatcher](nfs-dispatcher.md) — uses the NFS mount for external worker communication
- [Heartbeat](heartbeat.md) — rescan monitor piggybacks on heartbeat digest cycle
- [Engine](../core/orchestrator.md) — state files in `data/` are excluded from sync to prevent churn
