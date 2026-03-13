#!/usr/bin/env bash
# pencil.sh — Launch Pencil.dev design tool
# MCP auto-starts when Pencil desktop app is running — Claude Code auto-detects it.

set -euo pipefail

PENCIL_BIN="/opt/pencil/Pencil.AppImage"

if [ ! -f "$PENCIL_BIN" ]; then
  echo "ERROR: Pencil AppImage not found at $PENCIL_BIN"
  echo "Install: sudo mkdir -p /opt/pencil && sudo wget -O $PENCIL_BIN https://www.pencil.dev/download/Pencil-linux-x86_64.AppImage && sudo chmod +x $PENCIL_BIN"
  exit 1
fi

# NVM setup for any npx operations
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

echo "Launching Pencil.dev..."
"$PENCIL_BIN" --no-sandbox &
PENCIL_PID=$!

echo ""
echo "Pencil.dev launched (PID: $PENCIL_PID)"
echo ""
echo "Usage:"
echo "  - MCP server auto-starts when the Pencil app is running"
echo "  - Claude Code auto-detects it — use batch_design, get_screenshot, etc."
echo "  - UI kits: Shadcn, Lunaris, Halo, Nitro"
echo "  - Files: .pen (pure JSON)"
echo ""
echo "CLI (experimental):"
echo "  File → Install pencil command into PATH"
echo "  pencil --agent-config config.json"
echo ""
echo "To stop: kill $PENCIL_PID"
