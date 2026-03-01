#!/usr/bin/env bash
# ============================================================
# Agent Team - Parallel Runner
# ============================================================
# Runs Claude agents in parallel using background processes.
# Faster but uses more resources.
#
# Usage:
#   ./scripts/run_agents.sh                          # run all in parallel
#   ./scripts/run_agents.sh --filter "accuracy,health"
#   ./scripts/run_agents.sh --force                  # re-run all
#   ./scripts/run_agents.sh --max-parallel 2         # limit concurrency
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AGENT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# --- Defaults ---
FILTER=""
FORCE=false
SKIP_PREFLIGHT=false
MAX_PARALLEL=4

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --filter|-f)      FILTER="$2"; shift 2 ;;
        --force)          FORCE=true; shift ;;
        --skip-preflight) SKIP_PREFLIGHT=true; shift ;;
        --max-parallel)   MAX_PARALLEL="$2"; shift 2 ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

echo -e "\n${GREEN}=== Agent Team (Parallel, max $MAX_PARALLEL) ===${NC}"
echo -e "${GRAY}Project: $PROJECT_ROOT${NC}"

# --- Pre-flight ---
if [[ "$SKIP_PREFLIGHT" != true ]]; then
    bash "$SCRIPT_DIR/preflight.sh" || { echo -e "${RED}Pre-flight checks failed. Use --skip-preflight to bypass.${NC}" >&2; exit 1; }
fi

# --- Timestamped report directory ---
DATE_STAMP=$(date +%Y-%m-%d)
REPORT_DIR="$AGENT_DIR/reports/$DATE_STAMP"
mkdir -p "$REPORT_DIR"
LATEST_DIR="$AGENT_DIR/reports/latest"

# --- Discover prompt files ---
IFS=',' read -ra FILTER_LIST <<< "${FILTER,,}"

# --- Build full prompt ---
build_prompt() {
    local prompt_file="$1"
    cat "$prompt_file"
    cat <<'INSTRUCTIONS'

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
INSTRUCTIONS
}

# --- Launch parallel jobs ---
declare -A PIDS=()
START_TIME=$(date +%s)
launched=0

for prompt_file in "$SCRIPT_DIR"/prompt_*.txt; do
    [[ ! -f "$prompt_file" ]] && continue

    agent_name=$(basename "$prompt_file" .txt)
    agent_name="${agent_name#prompt_}"

    # Apply filter
    if [[ -n "$FILTER" ]]; then
        match=false
        for f in "${FILTER_LIST[@]}"; do
            [[ "${agent_name,,}" == "${f// /}" ]] && match=true
        done
        [[ "$match" != true ]] && continue
    fi

    output_file="$REPORT_DIR/$agent_name.md"

    # Skip if report exists and is substantial
    if [[ "$FORCE" != true && -f "$output_file" ]] && [[ $(stat -c%s "$output_file" 2>/dev/null || echo 0) -gt 1000 ]]; then
        echo -e "  ${GRAY}Skipping $agent_name (report exists)${NC}"
        continue
    fi

    # Throttle
    while [[ $(jobs -rp | wc -l) -ge $MAX_PARALLEL ]]; do
        sleep 0.5
    done

    echo -e "  ${YELLOW}Launching: $agent_name${NC}"

    (
        temp_prompt=$(mktemp /tmp/claude_prompt_${agent_name}.XXXXXX)
        build_prompt "$prompt_file" > "$temp_prompt"
        cd "$PROJECT_ROOT"
        if agent_output=$(cat "$temp_prompt" | claude -p --output-format text 2>&1); then
            printf '# Report: %s\n\n%s' "$agent_name" "$agent_output" > "$output_file"
            rm -f "$temp_prompt"
            exit 0
        else
            rm -f "$temp_prompt"
            exit 1
        fi
    ) &
    PIDS["$agent_name"]=$!
    launched=$((launched + 1))
done

if [[ $launched -eq 0 ]]; then
    echo -e "\n${GRAY}No agents to run.${NC}"
    exit 0
fi

# --- Wait and collect results ---
echo -e "\n${GRAY}Waiting for $launched agents...${NC}"

declare -A RESULTS=()
for name in "${!PIDS[@]}"; do
    pid=${PIDS[$name]}
    output_file="$REPORT_DIR/$name.md"
    if wait "$pid" 2>/dev/null; then
        size=$(stat -c%s "$output_file" 2>/dev/null || echo 0)
        echo -e "  ${GREEN}[OK] $name (${size}B)${NC}"
        RESULTS["$name"]="success"
    else
        echo -e "  ${RED}[!!] $name FAILED${NC}"
        RESULTS["$name"]="failed"
    fi
done

# --- Cleanup temp files ---
rm -f /tmp/claude_prompt_*.??????

# --- Merge into latest ---
if [[ -d "$REPORT_DIR" ]]; then
    mkdir -p "$LATEST_DIR"
    cp "$REPORT_DIR"/*.md "$LATEST_DIR/" 2>/dev/null || true

    # Update staleness manifest
    python3 -c "
import json, os, sys
from datetime import datetime, timezone

manifest_path = os.path.join('$LATEST_DIR', '.manifest.json')
try:
    with open(manifest_path) as f:
        manifest = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    manifest = {'files': {}}

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
for fname in os.listdir('$REPORT_DIR'):
    if fname.endswith('.md'):
        manifest['files'][fname] = {
            'squad': 'parallel',
            'date': '$DATE_STAMP',
            'updated': now,
        }

with open(manifest_path, 'w') as f:
    json.dump(manifest, f, indent=2)
"
fi

# --- Summary ---
END_TIME=$(date +%s)
TOTAL_TIME=$((END_TIME - START_TIME))

echo -e "\n${GREEN}=== Summary (${TOTAL_TIME}s) ===${NC}"
for name in "${!RESULTS[@]}"; do
    status="${RESULTS[$name]}"
    case "$status" in
        success) echo -e "  ${GREEN}[OK] $name${NC}" ;;
        failed)  echo -e "  ${RED}[!!] $name${NC}" ;;
    esac
done
echo -e "\n${CYAN}Reports: $REPORT_DIR${NC}"
