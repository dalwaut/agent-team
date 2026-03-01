#!/usr/bin/env bash
# ============================================================
# Agent Team - Sequential Runner
# ============================================================
# Runs Claude agents one at a time for maximum reliability.
# Each agent reads its prompt from scripts/prompt_*.txt
# and writes its report to reports/<date>/<name>.md
#
# Usage:
#   ./scripts/run_agents_seq.sh                              # run all
#   ./scripts/run_agents_seq.sh --filter "accuracy,health"   # run specific
#   ./scripts/run_agents_seq.sh --force                      # re-run even if report exists
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

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --filter|-f)      FILTER="$2"; shift 2 ;;
        --force)          FORCE=true; shift ;;
        --skip-preflight) SKIP_PREFLIGHT=true; shift ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

echo -e "\n${CYAN}=== Agent Team (Sequential) ===${NC}"
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

# --- Filter list ---
IFS=',' read -ra FILTER_LIST <<< "${FILTER,,}"

# --- Run agents ---
declare -a RESULT_NAMES=()
declare -a RESULT_STATUSES=()
declare -a RESULT_SIZES=()
START_TIME=$(date +%s)

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
        if [[ "$match" != true ]]; then
            echo -e "  ${GRAY}Skipping $agent_name (not in filter)${NC}"
            continue
        fi
    fi

    output_file="$REPORT_DIR/$agent_name.md"

    # Skip if report exists and is substantial (>1KB), unless --force
    if [[ "$FORCE" != true && -f "$output_file" ]]; then
        size=$(stat -c%s "$output_file" 2>/dev/null || echo 0)
        if [[ $size -gt 1000 ]]; then
            echo -e "  ${GRAY}Skipping $agent_name (report exists, ${size}B)${NC}"
            RESULT_NAMES+=("$agent_name")
            RESULT_STATUSES+=("skipped")
            RESULT_SIZES+=("$size")
            continue
        fi
    fi

    echo -e "\n${YELLOW}--- Agent: $agent_name ---${NC}"

    # Build full prompt
    temp_prompt=$(mktemp /tmp/claude_prompt_${agent_name}.XXXXXX)
    {
        cat "$prompt_file"
        cat <<'INSTRUCTIONS'

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
INSTRUCTIONS
    } > "$temp_prompt"

    agent_start=$(date +%s)
    echo -e "  ${GRAY}Running claude...${NC}"

    if output=$(cd "$PROJECT_ROOT" && cat "$temp_prompt" | claude -p --output-format text 2>&1); then
        printf '# Report: %s\n\n%s' "$agent_name" "$output" > "$output_file"
        size=$(stat -c%s "$output_file" 2>/dev/null || echo 0)
        elapsed=$(( $(date +%s) - agent_start ))
        echo -e "  ${GREEN}Done (${size}B, ${elapsed}s)${NC}"
        RESULT_NAMES+=("$agent_name")
        RESULT_STATUSES+=("success")
        RESULT_SIZES+=("$size")
    else
        echo -e "  ${RED}FAILED${NC}"
        RESULT_NAMES+=("$agent_name")
        RESULT_STATUSES+=("failed")
        RESULT_SIZES+=("0")
    fi

    rm -f "$temp_prompt"

    # Brief pause between agents to avoid rate limiting
    sleep 3
done

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
            'squad': 'sequential',
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

echo -e "\n${CYAN}=== Summary ===${NC}"
echo "Reports: $REPORT_DIR"
echo "Total time: ${TOTAL_TIME}s"
echo ""

for i in "${!RESULT_NAMES[@]}"; do
    name="${RESULT_NAMES[$i]}"
    status="${RESULT_STATUSES[$i]}"
    size="${RESULT_SIZES[$i]}"
    case "$status" in
        success) echo -e "  ${GREEN}[OK] $name: success ${size}B${NC}" ;;
        skipped) echo -e "  ${GRAY}[--] $name: skipped ${size}B${NC}" ;;
        failed)  echo -e "  ${RED}[!!] $name: failed${NC}" ;;
    esac
done

echo -e "\n${CYAN}Done.${NC}"
