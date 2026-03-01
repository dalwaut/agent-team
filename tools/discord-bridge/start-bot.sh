#!/bin/bash
# OPAI Discord Bot — clean launcher
# Ensures single instance, loads nvm, strips Claude session vars

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$BOT_DIR/data/bot.pid"

# Kill ALL existing bot instances (PID file + pattern match)
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  kill "$OLD_PID" 2>/dev/null
  rm -f "$PIDFILE"
fi

# Pattern-based kill as fallback for orphaned instances
pgrep -f "node.*discord-bridge/index.js" | while read pid; do
  [ "$pid" != "$$" ] && kill "$pid" 2>/dev/null
done
sleep 1
# Force kill any survivors
pgrep -f "node.*discord-bridge/index.js" | while read pid; do
  [ "$pid" != "$$" ] && kill -9 "$pid" 2>/dev/null
done

# Load nvm if available (needed for claude CLI)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Strip Claude nested-session detection vars
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT

cd "$BOT_DIR"

# exec replaces this shell — node inherits our PID
echo $$ > "$PIDFILE"
exec node index.js
