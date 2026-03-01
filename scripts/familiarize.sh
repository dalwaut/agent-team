#!/usr/bin/env bash
# ============================================================
# Agent Team - Project Familiarizer
# ============================================================
# Run this ONCE after installing Agent Team into a new project.
# It scans the codebase, builds a project profile, and outputs
# customizations to make every agent hyper-relevant.
#
# Usage:
#   ./scripts/familiarize.sh
#   ./scripts/familiarize.sh --yes    # skip confirmation
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
WHITE='\033[1;37m'
NC='\033[0m'

YES=false
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && YES=true

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Agent Team - Project Familiarizer${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo -e "${WHITE}This agent will scan your project to understand:${NC}"
echo -e "  ${GRAY}- Tech stack, framework, and language${NC}"
echo -e "  ${GRAY}- Directory structure and key files${NC}"
echo -e "  ${GRAY}- Naming conventions and patterns${NC}"
echo -e "  ${GRAY}- Recent git history and active work${NC}"
echo -e "  ${GRAY}- Dependencies and configuration${NC}"
echo ""
echo -e "${WHITE}It will then produce:${NC}"
echo -e "  ${GRAY}- A project_context.md (shared context for all agents)${NC}"
echo -e "  ${GRAY}- Per-prompt customization recommendations${NC}"
echo -e "  ${GRAY}- Specialist agent recommendations${NC}"
echo -e "  ${GRAY}- Squad adjustments for your project${NC}"
echo ""
echo -e "${YELLOW}Project root: $PROJECT_ROOT${NC}"
echo ""

# --- Check if already familiarized ---
CONTEXT_FILE="$AGENT_DIR/project_context.md"
if [[ -f "$CONTEXT_FILE" ]]; then
    size=$(stat -c%s "$CONTEXT_FILE" 2>/dev/null || echo 0)
    echo -e "${YELLOW}NOTE: project_context.md already exists (${size}B).${NC}"
    echo -e "${YELLOW}Running again will regenerate it.${NC}"
    echo ""
fi

# --- Ask for confirmation ---
if [[ "$YES" != true ]]; then
    read -rp "Run the familiarizer now? (Y/n) " confirm
    if [[ "${confirm,,}" == "n" ]]; then
        echo -e "${GRAY}Aborted. Run later with: ./scripts/familiarize.sh${NC}"
        exit 0
    fi
fi

# --- Pre-flight ---
echo ""
bash "$SCRIPT_DIR/preflight.sh" || { echo -e "${RED}Pre-flight checks failed.${NC}" >&2; exit 1; }

# --- Run the familiarizer ---
PROMPT_FILE="$SCRIPT_DIR/prompt_familiarizer.txt"
if [[ ! -f "$PROMPT_FILE" ]]; then
    echo -e "${RED}prompt_familiarizer.txt not found in $SCRIPT_DIR${NC}" >&2
    exit 1
fi

DATE_STAMP=$(date +%Y-%m-%d)
REPORT_DIR="$AGENT_DIR/reports/$DATE_STAMP"
mkdir -p "$REPORT_DIR"
OUTPUT_FILE="$REPORT_DIR/familiarizer.md"

# Build full prompt
temp_prompt=$(mktemp /tmp/claude_prompt_familiarizer.XXXXXX)
{
    cat "$PROMPT_FILE"
    cat <<'INSTRUCTIONS'

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
INSTRUCTIONS
} > "$temp_prompt"

echo ""
echo -e "${CYAN}Scanning project...${NC}"
echo -e "${GRAY}(This may take 1-3 minutes)${NC}"
echo ""

START_TIME=$(date +%s)

if output=$(cd "$PROJECT_ROOT" && cat "$temp_prompt" | claude -p --output-format text 2>&1); then
    printf '# Report: familiarizer\n\n%s' "$output" > "$OUTPUT_FILE"

    # Extract project context if the agent produced one
    if echo "$output" | grep -q "PROJECT.SPECIFIC CONTEXT\|## Project Context"; then
        context=$(echo "$output" | sed -n '/## .*PROJECT.SPECIFIC CONTEXT/,$p')
        if [[ -n "$context" ]]; then
            printf '# Project Context\n\n%s' "$context" > "$CONTEXT_FILE"
            echo -e "  ${GREEN}project_context.md written.${NC}"
        fi
    fi

    ELAPSED=$(( $(date +%s) - START_TIME ))
    size=$(stat -c%s "$OUTPUT_FILE" 2>/dev/null || echo 0)

    echo ""
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}  Familiarization Complete${NC}"
    echo -e "${GREEN}============================================${NC}"
    echo ""
    echo -e "  ${WHITE}Report: $OUTPUT_FILE (${size}B, ${ELAPSED}s)${NC}"
    echo ""
    echo -e "${CYAN}Next steps:${NC}"
    echo -e "  ${GRAY}1. Read the report: $OUTPUT_FILE${NC}"
    echo -e "  ${GRAY}2. Review the project_context.md${NC}"
    echo -e "  ${GRAY}3. Apply the prompt customizations it recommends${NC}"
    echo -e "  ${GRAY}4. Activate any specialist templates it suggests${NC}"
    echo -e "  ${GRAY}5. Run your first squad: ./scripts/run_squad.sh -s audit${NC}"
    echo ""

    # Copy to latest
    LATEST_DIR="$AGENT_DIR/reports/latest"
    mkdir -p "$LATEST_DIR"
    cp "$OUTPUT_FILE" "$LATEST_DIR/familiarizer.md"
else
    echo -e "  ${RED}FAILED${NC}"
    rm -f "$temp_prompt"
    exit 1
fi

rm -f "$temp_prompt"
