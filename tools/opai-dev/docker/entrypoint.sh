#!/bin/bash
# OPAI Dev — Container entrypoint
# Starts the Claude bridge socket-to-TCP proxy, then launches Theia.

BRIDGE_SOCKET="/tmp/opai-claude-bridge.sock"
PROXY_PORT=4141

# Start socat proxy if the bridge socket is mounted
if [ -S "$BRIDGE_SOCKET" ]; then
  socat TCP-LISTEN:${PROXY_PORT},fork,reuseaddr,bind=127.0.0.1 UNIX-CONNECT:${BRIDGE_SOCKET} &
  echo "[opai] Claude bridge proxy: localhost:${PROXY_PORT} -> ${BRIDGE_SOCKET}"
fi

# Launch Theia
exec node /home/theia/src-gen/backend/main.js "$@"
