#!/usr/bin/env bash
# Run the brain_curator agent (Claude Code in print mode)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/.." && pwd)"
PROMPT_FILE="$SCRIPT_DIR/prompt_braincurator.txt"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "[brain_curator] ERROR: prompt file not found at $PROMPT_FILE" >&2
  exit 1
fi

echo "[brain_curator] Starting brain_curator agent at $(date -Iseconds)"

# Run claude in print mode (read-only, stdout only)
# Unset CLAUDECODE so nested invocations are allowed
unset CLAUDECODE

claude \
  --print \
  --output-format text \
  --max-turns 20 \
  --allowedTools "Bash,Read,Glob,Grep,Write" \
  "$(cat "$PROMPT_FILE")" 2>&1

echo "[brain_curator] Finished at $(date -Iseconds)"
