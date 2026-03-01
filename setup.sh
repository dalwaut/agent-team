#!/usr/bin/env bash
# ============================================================
# Agent Team - Quick Setup
# ============================================================
# Installs the agent team framework into a target project.
# Asks if you want to run the familiarizer to customize agents.
#
# Usage:
#   ./setup.sh --target /path/to/your/project
#   ./setup.sh --target . --with-specialists
# ============================================================

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
WHITE='\033[1;37m'
NC='\033[0m'

# --- Defaults ---
TARGET="."
WITH_SPECIALISTS=false

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target|-t)          TARGET="$2"; shift 2 ;;
        --with-specialists)   WITH_SPECIALISTS=true; shift ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

AGENT_DIR="$TARGET/.agent"

if [[ -d "$AGENT_DIR" ]]; then
    echo -e "${YELLOW}.agent/ already exists in $TARGET${NC}"
    read -rp "Overwrite? (y/N) " confirm
    if [[ "${confirm,,}" != "y" ]]; then
        echo -e "${RED}Aborted.${NC}"
        exit 0
    fi
fi

echo -e "\n${CYAN}Installing Agent Team...${NC}"

for d in scripts workflows templates reports; do
    mkdir -p "$AGENT_DIR/$d"
done

cp "$SOURCE_DIR/team.json" "$AGENT_DIR/"
cp "$SOURCE_DIR"/scripts/* "$AGENT_DIR/scripts/" 2>/dev/null || true
cp "$SOURCE_DIR"/workflows/* "$AGENT_DIR/workflows/" 2>/dev/null || true

# Copy templates if they exist
if [[ -d "$SOURCE_DIR/Templates" ]]; then
    cp "$SOURCE_DIR"/Templates/* "$AGENT_DIR/templates/" 2>/dev/null || true
fi

if [[ "$WITH_SPECIALISTS" == true ]]; then
    echo -e "${GRAY}Activating specialist templates...${NC}"
    for tpl in "$AGENT_DIR"/templates/prompt_*.txt; do
        [[ ! -f "$tpl" ]] && continue
        dest="$AGENT_DIR/scripts/$(basename "$tpl")"
        if [[ ! -f "$dest" ]]; then
            cp "$tpl" "$dest"
            echo -e "  ${GRAY}Activated: $(basename "$tpl")${NC}"
        fi
    done
fi

touch "$AGENT_DIR/reports/.gitkeep"

echo -e "\n${GREEN}Installed to: $AGENT_DIR${NC}"
echo ""

# --- Ask to run familiarizer ---
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  The Familiarizer agent can scan this${NC}"
echo -e "${CYAN}  project and customize all agents to be${NC}"
echo -e "${CYAN}  hyper-relevant to YOUR codebase.${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo -e "${WHITE}It will:${NC}"
echo -e "  ${GRAY}- Detect your tech stack and conventions${NC}"
echo -e "  ${GRAY}- Build a project_context.md shared by all agents${NC}"
echo -e "  ${GRAY}- Recommend which specialist agents to activate${NC}"
echo -e "  ${GRAY}- Output per-prompt customizations${NC}"
echo ""

read -rp "Run the familiarizer now? (Y/n) " run_fam

if [[ "${run_fam,,}" != "n" ]]; then
    echo ""
    bash "$AGENT_DIR/scripts/familiarize.sh" --yes
else
    echo ""
    echo -e "${GRAY}Skipped. You can run it later:${NC}"
    echo -e "${YELLOW}  ./.agent/scripts/familiarize.sh${NC}"
    echo ""
    echo -e "${CYAN}Other commands:${NC}"
    echo "  List squads:    ./.agent/scripts/run_squad.sh --list"
    echo "  First audit:    ./.agent/scripts/run_squad.sh -s audit"
    echo "  Self-assess:    ./.agent/scripts/run_squad.sh -s evolve"
    echo ""
fi
