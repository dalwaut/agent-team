#!/usr/bin/env bash
# ============================================================
# Pre-flight Checks for Agent Team
# ============================================================
# Validates environment before running agents.
# Exit code 0 = all good, 1 = something is wrong.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
GRAY='\033[0;90m'
NC='\033[0m'

errors=()

echo ""
echo -e "  ${GRAY}Pre-flight checks...${NC}"

# 1. Claude CLI available
if command -v claude &>/dev/null; then
    echo -e "    ${GRAY}[OK] claude CLI found${NC}"
else
    errors+=("claude CLI not found in PATH")
    echo -e "    ${RED}[!!] claude CLI not found${NC}"
fi

# 2. jq available (needed for team.json parsing)
if command -v jq &>/dev/null; then
    echo -e "    ${GRAY}[OK] jq found${NC}"
else
    errors+=("jq not found in PATH (needed for JSON parsing)")
    echo -e "    ${RED}[!!] jq not found (apt install jq)${NC}"
fi

# 3. Prompt files exist and are non-empty
prompts=("$SCRIPT_DIR"/prompt_*.txt)
if [[ ! -e "${prompts[0]}" ]]; then
    errors+=("No prompt_*.txt files found in $SCRIPT_DIR")
    echo -e "    ${RED}[!!] No prompt files found${NC}"
else
    empty_count=0
    empty_names=()
    for p in "${prompts[@]}"; do
        if [[ $(stat -c%s "$p" 2>/dev/null || echo 0) -lt 10 ]]; then
            empty_count=$((empty_count + 1))
            empty_names+=("$(basename "$p")")
        fi
    done
    if [[ $empty_count -gt 0 ]]; then
        errors+=("Empty prompt files: ${empty_names[*]}")
        echo -e "    ${RED}[!!] Empty prompts: ${empty_names[*]}${NC}"
    else
        echo -e "    ${GRAY}[OK] ${#prompts[@]} prompt files found${NC}"
    fi
fi

# 4. Reports directory writable
REPORT_DIR="$AGENT_DIR/reports"
if [[ ! -d "$REPORT_DIR" ]]; then
    if mkdir -p "$REPORT_DIR" 2>/dev/null; then
        echo -e "    ${GRAY}[OK] Created reports directory${NC}"
    else
        errors+=("Cannot create reports directory: $REPORT_DIR")
        echo -e "    ${RED}[!!] Cannot create reports dir${NC}"
    fi
else
    echo -e "    ${GRAY}[OK] Reports directory exists${NC}"
fi

# 5. Project root has expected structure
# Framework-mode: if team.json exists one level up, this IS the framework root
if [[ -f "$AGENT_DIR/team.json" ]]; then
    PROJECT_ROOT="$AGENT_DIR"
    expected_files=("CLAUDE.md" "team.json")
    echo -e "    ${GRAY}[OK] Framework-mode detected (root: $PROJECT_ROOT)${NC}"
else
    PROJECT_ROOT="$(dirname "$AGENT_DIR")"
    expected_files=("app.json" "package.json" "CLAUDE.md")
fi

structure_errors=0
for f in "${expected_files[@]}"; do
    if [[ ! -f "$PROJECT_ROOT/$f" ]]; then
        errors+=("Expected project file missing: $f")
        echo -e "    ${RED}[!!] Missing: $f${NC}"
        structure_errors=$((structure_errors + 1))
    fi
done
if [[ $structure_errors -eq 0 ]]; then
    echo -e "    ${GRAY}[OK] Project structure valid${NC}"
fi

# --- Result ---
if [[ ${#errors[@]} -gt 0 ]]; then
    echo ""
    echo -e "  ${RED}Pre-flight FAILED (${#errors[@]} issues)${NC}"
    exit 1
else
    echo -e "    ${GRAY}All checks passed.${NC}"
    echo ""
    exit 0
fi
