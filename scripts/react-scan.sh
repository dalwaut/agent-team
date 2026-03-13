#!/usr/bin/env bash
# react-scan.sh — Runtime React performance profiler (CLI mode)
# Scans a running React app at the given URL for re-render performance issues.
#
# Usage:
#   ./scripts/react-scan.sh <url>
#   ./scripts/react-scan.sh http://localhost:5173
#   ./scripts/react-scan.sh https://react.dev

set -euo pipefail

export PATH="/home/dallas/.nvm/versions/node/v20.19.5/bin:$PATH"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <url>"
  echo ""
  echo "Scans a running React application for re-render performance issues."
  echo ""
  echo "Examples:"
  echo "  $0 http://localhost:5173    # Local dev server"
  echo "  $0 https://react.dev        # Any public React app"
  exit 1
fi

URL="$1"

echo "React Scan — Runtime Performance Profiler"
echo "Scanning: $URL"
echo "---"

npx -y react-scan@latest "$URL"
