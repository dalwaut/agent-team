#!/bin/bash
# fix-inotify-limits.sh
# Run with sudo: sudo bash scripts/fix-inotify-limits.sh
# Fixes system inotify limits and tailsync watch scope

set -e
echo "=== Fixing inotify limits and tailsync config ==="

# ── 1. Raise kernel inotify limits ────────────────────────────────────────────
echo "[1/4] Raising inotify kernel limits..."

# Remove old entries first
sed -i '/fs.inotify.max_user_watches/d' /etc/sysctl.conf
sed -i '/fs.inotify.max_user_instances/d' /etc/sysctl.conf
sed -i '/fs.inotify.max_queued_events/d' /etc/sysctl.conf

# Write a dedicated override file (preferred over editing sysctl.conf)
cat > /etc/sysctl.d/99-opai-inotify.conf << 'EOF'
# OPAI Server — inotify limits
# Raised to support many projects, multi-user sessions, IDE watchers,
# Synology Drive, and tailsync all running concurrently.
fs.inotify.max_user_watches   = 2097152
fs.inotify.max_user_instances = 1024
fs.inotify.max_queued_events  = 65536
EOF

# Apply immediately (runtime)
sysctl -w fs.inotify.max_user_watches=2097152
sysctl -w fs.inotify.max_user_instances=1024
sysctl -w fs.inotify.max_queued_events=65536
echo "   → Limits applied: max_user_watches=2097152, max_user_instances=1024"

# ── 2. Fix tailsync config (wider exclusions) ─────────────────────────────────
echo "[2/4] Updating tailsync config..."
cat > /home/dallas/.tailsync/config.json << 'EOF'
{
  "port": 9718,
  "authToken": "ts_3e927c4f6283bce68b647c494ffec969e115aea47f392505ab7116a648f96c3030e130b99bb0dd1bb049ca9e39f8e121",
  "watchedPaths": ["/workspace/synced"],
  "excludePatterns": [
    "node_modules",
    ".git",
    "__pycache__",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "out",
    ".output",
    ".cache",
    ".turbo",
    ".venv",
    "venv",
    ".tox",
    "*.tmp",
    "*.swp",
    "*.pyc",
    "snap",
    ".SynologyWorkingDirectory",
    ".SynologyDrive",
    ".expo",
    ".metro-cache",
    "android",
    "ios",
    ".gradle",
    ".idea",
    "target",
    "vendor",
    ".pnpm-store",
    ".yarn"
  ]
}
EOF
chown dallas:dallas /home/dallas/.tailsync/config.json
echo "   → tailsync config updated"

# ── 3. Fix tailsync watcher.js ignore pattern ─────────────────────────────────
# The bug: `**/name/**` excludes contents but NOT the directory itself.
# Fix: emit both `**/name` and `**/name/**` so chokidar skips the dir too.
echo "[3/4] Patching tailsync watcher.js..."
cat > /opt/tailsync-server/dist/watcher.js << 'EOF'
import { watch } from 'chokidar';
export class ServerWatcher {
    excludePatterns;
    watchers = [];
    onEvent = () => { };
    constructor(excludePatterns) {
        this.excludePatterns = excludePatterns;
    }
    setEventHandler(handler) {
        this.onEvent = handler;
    }
    watchPaths(paths) {
        for (const path of paths) {
            console.log(`[watcher] Watching: ${path}`);
            const watcher = watch(path, {
                ignoreInitial: true,
                persistent: true,
                followSymlinks: false,
                ignored: this.excludePatterns.flatMap((p) => {
                    const name = p.replace(/\/$/, '');
                    // Match both the directory itself and everything inside it
                    return [`**/${name}`, `**/${name}/**`];
                }),
            });
            watcher.on('add', (filePath) => {
                this.onEvent({ type: 'file.changed', path: filePath, changeType: 'add' });
            });
            watcher.on('change', (filePath) => {
                this.onEvent({ type: 'file.changed', path: filePath, changeType: 'change' });
            });
            watcher.on('unlink', (filePath) => {
                this.onEvent({ type: 'file.changed', path: filePath, changeType: 'unlink' });
            });
            watcher.on('error', (err) => {
                console.error(`[watcher] Error on ${path}:`, err);
            });
            this.watchers.push(watcher);
        }
    }
    getCount() {
        return this.watchers.length;
    }
    async closeAll() {
        await Promise.all(this.watchers.map((w) => w.close()));
        this.watchers = [];
    }
}
//# sourceMappingURL=watcher.js.map
EOF
echo "   → watcher.js patched"

# ── 4. Restart tailsync-server ────────────────────────────────────────────────
echo "[4/4] Restarting tailsync-server..."
systemctl restart tailsync-server
sleep 3
systemctl is-active tailsync-server && echo "   → tailsync-server running" || echo "   ✗ tailsync-server failed to start"

echo ""
echo "=== Done ==="
echo "Current inotify limits:"
echo "  max_user_watches   = $(cat /proc/sys/fs/inotify/max_user_watches)"
echo "  max_user_instances = $(cat /proc/sys/fs/inotify/max_user_instances)"
echo "  max_queued_events  = $(cat /proc/sys/fs/inotify/max_queued_events)"
echo ""
echo "Tailsync will take ~60s to re-scan. Watch count will drop significantly."
echo "Run after 60s to verify: grep -c 'inotify wd:' /proc/\$(systemctl show tailsync-server --property=MainPID --value)/fdinfo/22"
