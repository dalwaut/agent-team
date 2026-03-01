#!/usr/bin/env bash
# SCC IDE — Launcher
# Tries built binary first, falls back to dev mode, then shows status.

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPIMAGE="$TOOL_DIR/dist/SCC-IDE.AppImage"
BUILT_MAIN="$TOOL_DIR/out/main/index.js"
DEV_DIR="$TOOL_DIR"

# ── 1. Packaged AppImage (production) ──────────────────────────────────────
if [[ -f "$APPIMAGE" ]]; then
  exec "$APPIMAGE" "$@"
fi

# ── 2. Pre-built output (npm run build already ran) ────────────────────────
if [[ -f "$BUILT_MAIN" ]]; then
  cd "$DEV_DIR"
  # Load nvm so electron binary resolves correctly
  export NVM_DIR="$HOME/.nvm"
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
  exec npx electron --no-sandbox . "$@"
fi

# ── 3. Dev mode (source, hot-reload) ───────────────────────────────────────
if [[ -f "$DEV_DIR/package.json" ]] && [[ -d "$DEV_DIR/node_modules" ]]; then
  cd "$DEV_DIR"
  export NVM_DIR="$HOME/.nvm"
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
  exec npm run dev -- --no-sandbox
fi

# ── 3. Not yet built — open a terminal with setup instructions ─────────────
cat <<'EOF'

  ╔══════════════════════════════════════════════════════╗
  ║               SCC IDE — Not Yet Built                ║
  ╠══════════════════════════════════════════════════════╣
  ║                                                      ║
  ║  The SCC IDE hasn't been built yet.                  ║
  ║                                                      ║
  ║  To set it up:                                       ║
  ║    cd /workspace/synced/opai/tools/scc-ide           ║
  ║    git clone https://github.com/op7418/CodePilot .   ║
  ║    npm install                                       ║
  ║    npm run dev                                       ║
  ║                                                      ║
  ║  See: memory/wip/scc-ide-plan.md for full plan       ║
  ╚══════════════════════════════════════════════════════╝

EOF

# If running in a terminal, drop to shell in the scc-ide dir so dev can start work
if [[ -t 1 ]]; then
  echo "Dropping into scc-ide directory. Type 'exit' when done."
  exec bash --rcfile <(echo "cd '$DEV_DIR'; PS1='(scc-ide) \$ '")
fi
