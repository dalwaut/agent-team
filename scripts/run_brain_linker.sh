#!/usr/bin/env bash
# run_brain_linker.sh — Run the brain_linker agent
# Usage: ./scripts/run_brain_linker.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(dirname "$SCRIPT_DIR")"
PROMPT_FILE="$SCRIPT_DIR/prompt_brainlinker.txt"
REPORT_DIR="$WORKSPACE/reports/latest"

mkdir -p "$REPORT_DIR"

echo "[brain_linker] Starting at $(date)"

# Load env for context
source "$WORKSPACE/tools/opai-brain/.env" 2>/dev/null || true

# Health check
if ! curl -sf http://localhost:8101/api/health > /dev/null; then
  echo "[brain_linker] ERROR: brain service not running on port 8101"
  exit 1
fi

# Run agent
claude -p "$(cat "$PROMPT_FILE")" \
  --output-format text \
  2>&1 | tee "$REPORT_DIR/brain-linker.md"

echo "[brain_linker] Done — report at $REPORT_DIR/brain-linker.md"
