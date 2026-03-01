#!/usr/bin/env bash
# ============================================================
# Agent Team - Auto-Executor
# ============================================================
# Reads agent reports and automatically applies fixes.
#
# Mode 1 (safe):  Only non-breaking, trivially correct changes
# Mode 2 (full):  All safe changes + structural improvements
#
# Safety: creates a git branch, shows dry-run diff, asks to confirm.
#
# Usage:
#   ./scripts/run_auto.sh --mode safe
#   ./scripts/run_auto.sh --mode full
#   ./scripts/run_auto.sh --mode safe --dry-run
#   ./scripts/run_auto.sh --mode full --no-branch
#   ./scripts/run_auto.sh --mode safe --yes
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

# --- Defaults ---
MODE=""
DRY_RUN=false
NO_BRANCH=false
YES=false
SKIP_PREFLIGHT=false

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode|-m)        MODE="$2"; shift 2 ;;
        --dry-run)        DRY_RUN=true; shift ;;
        --no-branch)      NO_BRANCH=true; shift ;;
        --yes|-y)         YES=true; shift ;;
        --skip-preflight) SKIP_PREFLIGHT=true; shift ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

if [[ "$MODE" != "safe" && "$MODE" != "full" ]]; then
    echo -e "${RED}Usage: $0 --mode <safe|full>${NC}" >&2
    exit 1
fi

MODE_COLOR="$GREEN"
[[ "$MODE" == "full" ]] && MODE_COLOR="$YELLOW"

echo ""
echo -e "${MODE_COLOR}============================================${NC}"
echo -e "${MODE_COLOR}  Agent Team - Auto-Executor${NC}"
echo -e "${MODE_COLOR}  Mode: ${MODE^^}${NC}"
echo -e "${MODE_COLOR}============================================${NC}"
echo ""

if [[ "$MODE" == "safe" ]]; then
    echo -e "  ${GREEN}SAFE MODE: Only non-breaking, trivially correct changes${NC}"
    echo -e "  ${GRAY}- Remove unused imports, dead code, console.logs${NC}"
    echo -e "  ${GRAY}- Uninstall unused npm deps${NC}"
    echo -e "  ${GRAY}- Fix typos in comments${NC}"
    echo -e "  ${GRAY}- NO logic changes, NO refactors${NC}"
else
    echo -e "  ${YELLOW}FULL MODE: Safe changes + structural improvements${NC}"
    echo -e "  ${GRAY}- Everything in safe mode${NC}"
    echo -e "  ${GRAY}- Bug fixes from accuracy reports${NC}"
    echo -e "  ${GRAY}- Refactors from health/reviewer reports${NC}"
    echo -e "  ${GRAY}- Missing error handling and UX states${NC}"
    echo -e "  ${GRAY}- Query optimizations${NC}"
fi
echo ""

# --- Check for reports ---
LATEST_DIR="$AGENT_DIR/reports/latest"
if [[ ! -d "$LATEST_DIR" ]]; then
    echo -e "${RED}No reports found. Run a squad first: ./scripts/run_squad.sh -s audit${NC}" >&2
    exit 1
fi

report_count=$(find "$LATEST_DIR" -name "*.md" -type f | wc -l)
if [[ $report_count -eq 0 ]]; then
    echo -e "${RED}No reports in $LATEST_DIR. Run a squad first.${NC}" >&2
    exit 1
fi
echo -e "  ${GRAY}Found $report_count reports in $LATEST_DIR${NC}"

# --- Pre-flight ---
if [[ "$SKIP_PREFLIGHT" != true ]]; then
    bash "$SCRIPT_DIR/preflight.sh" || exit 1
fi

# --- Safety: check for uncommitted changes ---
git_status=$(git -C "$PROJECT_ROOT" status --porcelain 2>&1 || true)
if [[ -n "$git_status" && "$NO_BRANCH" != true ]]; then
    echo ""
    echo -e "  ${YELLOW}WARNING: You have uncommitted changes.${NC}"
    echo -e "  ${YELLOW}The auto-executor will create a new branch from current state.${NC}"
    echo -e "  ${YELLOW}Uncommitted changes will be included.${NC}"
    echo ""
    if [[ "$YES" != true ]]; then
        read -rp "  Continue? (y/N) " confirm
        if [[ "${confirm,,}" != "y" ]]; then
            echo -e "  ${RED}Aborted.${NC}"
            exit 0
        fi
    fi
fi

# --- Safety: create a branch ---
BRANCH_NAME="agent/auto-${MODE}-$(date +%Y%m%d-%H%M%S)"
if [[ "$NO_BRANCH" != true && "$DRY_RUN" != true ]]; then
    echo ""
    echo -e "  ${CYAN}Creating safety branch: $BRANCH_NAME${NC}"
    git -C "$PROJECT_ROOT" checkout -b "$BRANCH_NAME" 2>&1 >/dev/null
    echo -e "  ${GRAY}Branch created. Original branch preserved.${NC}"
fi

# --- Phase 1: Generate the fix plan ---
PROMPT_FILE="$SCRIPT_DIR/prompt_executor_${MODE}.txt"
if [[ ! -f "$PROMPT_FILE" ]]; then
    echo -e "${RED}Executor prompt not found: $PROMPT_FILE${NC}" >&2
    exit 1
fi

DATE_STAMP=$(date +%Y-%m-%d)
REPORT_DIR="$AGENT_DIR/reports/$DATE_STAMP"
mkdir -p "$REPORT_DIR"
PLAN_FILE="$REPORT_DIR/evolve_${MODE}_plan.md"

temp_prompt=$(mktemp /tmp/claude_prompt_executor.XXXXXX)
{
    cat "$PROMPT_FILE"
    cat <<INSTRUCTIONS

IMPORTANT INSTRUCTIONS:
- Output the FULL fix plan to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification.
- Read the agent reports in $LATEST_DIR to find actionable fixes.
- Be precise with file paths, line numbers, and code content.
INSTRUCTIONS
} > "$temp_prompt"

echo ""
echo -e "  ${CYAN}Phase 1: Generating fix plan...${NC}"
echo -e "  ${GRAY}(Reading $report_count agent reports, this takes 1-3 min)${NC}"

START_TIME=$(date +%s)

if plan_output=$(cd "$PROJECT_ROOT" && cat "$temp_prompt" | claude -p --output-format text 2>&1); then
    printf '# Executor Plan (%s mode)\n\n%s' "$MODE" "$plan_output" > "$PLAN_FILE"
    plan_size=$(stat -c%s "$PLAN_FILE" 2>/dev/null || echo 0)
    elapsed=$(( $(date +%s) - START_TIME ))
    echo -e "  ${GREEN}Plan generated (${plan_size}B, ${elapsed}s)${NC}"
    echo -e "  ${GRAY}Saved to: $PLAN_FILE${NC}"
    # Mirror to latest/ so the TCP Evolve panel can always find the newest plan
    cp "$PLAN_FILE" "$LATEST_DIR/evolve_safe_plan.md" 2>/dev/null || true
else
    echo -e "  ${RED}Plan generation FAILED${NC}"
    rm -f "$temp_prompt"
    exit 1
fi
rm -f "$temp_prompt"

# --- If dry-run, stop here ---
if [[ "$DRY_RUN" == true ]]; then
    echo ""
    echo -e "${CYAN}============================================${NC}"
    echo -e "${CYAN}  DRY RUN - No changes applied${NC}"
    echo -e "${CYAN}============================================${NC}"
    echo -e "  ${GRAY}Review the plan: $PLAN_FILE${NC}"
    echo -e "  ${GRAY}To apply: ./scripts/run_auto.sh --mode $MODE${NC}"
    echo ""
    exit 0
fi

# --- Phase 2: Ask user to confirm ---
echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Fix plan ready. Review:${NC}"
echo -e "${WHITE}  $PLAN_FILE${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

if [[ "$YES" != true ]]; then
    echo -e "  ${WHITE}The executor will now apply fixes using Claude Code.${NC}"
    echo -e "  ${GRAY}Changes are on branch: $BRANCH_NAME${NC}"
    echo -e "  ${GRAY}You can always revert with: git checkout - && git branch -D $BRANCH_NAME${NC}"
    echo ""
    read -rp "  Apply fixes now? (y/N) " confirm
    if [[ "${confirm,,}" != "y" ]]; then
        echo -e "  ${YELLOW}Aborted. Plan saved at: $PLAN_FILE${NC}"
        if [[ "$NO_BRANCH" != true ]]; then
            git -C "$PROJECT_ROOT" checkout - 2>&1 >/dev/null
            git -C "$PROJECT_ROOT" branch -D "$BRANCH_NAME" 2>&1 >/dev/null
            echo -e "  ${GRAY}Branch removed.${NC}"
        fi
        exit 0
    fi
fi

# --- Phase 3: Apply fixes via Claude ---
echo ""
echo -e "  ${CYAN}Phase 2: Applying fixes...${NC}"

temp_apply=$(mktemp /tmp/claude_prompt_apply.XXXXXX)
cat > "$temp_apply" <<APPLYPROMPT
You are applying the fix plan below to this codebase. Execute each fix block precisely.

For each fix block with ACTION: delete_line, replace_line, replace_block, insert_after:
- Read the target file
- Find the exact BEFORE content
- Apply the change
- Verify the edit was applied

For ACTION: run_command:
- Execute the command

For ACTION: create_file:
- Write the file with the specified content

SKIP any fix where:
- The BEFORE content doesn't match what's in the file (file was already changed)
- The file doesn't exist
- The change looks risky in context

After all fixes, output a summary of what was applied vs skipped.

THE PLAN:
$(cat "$PLAN_FILE")
APPLYPROMPT

RESULT_FILE="$REPORT_DIR/executor_${MODE}_result.md"

if apply_output=$(cd "$PROJECT_ROOT" && cat "$temp_apply" | claude -p --output-format text 2>&1); then
    printf '# Executor Result (%s mode)\n\n%s' "$MODE" "$apply_output" > "$RESULT_FILE"
    echo -e "  ${GREEN}Fixes applied.${NC}"
    echo -e "  ${GRAY}Result: $RESULT_FILE${NC}"
else
    echo -e "  ${RED}Apply FAILED${NC}"
fi
rm -f "$temp_apply"

# --- Phase 4: Show diff ---
echo ""
echo -e "  ${CYAN}Phase 3: Reviewing changes...${NC}"

diff_stat=$(git -C "$PROJECT_ROOT" diff --stat 2>&1 || true)
if [[ -n "$diff_stat" ]]; then
    echo ""
    echo "$diff_stat"
    echo ""
    echo -e "  ${CYAN}Files changed:${NC}"
    git -C "$PROJECT_ROOT" diff --name-only 2>&1 | while read -r f; do
        echo -e "    ${GRAY}$f${NC}"
    done
else
    echo -e "  ${YELLOW}No file changes detected.${NC}"
fi

# --- Summary ---
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Auto-Executor Complete${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  ${WHITE}Mode:    ${MODE^^}${NC}"
echo -e "  ${WHITE}Branch:  $BRANCH_NAME${NC}"
echo -e "  ${GRAY}Plan:    $PLAN_FILE${NC}"
echo -e "  ${GRAY}Result:  $RESULT_FILE${NC}"
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
echo -e "    ${GRAY}Review changes:    git diff${NC}"
echo -e "    ${GRAY}Accept & merge:    git checkout main && git merge $BRANCH_NAME${NC}"
echo -e "    ${GRAY}Reject & revert:   git checkout main && git branch -D $BRANCH_NAME${NC}"
echo -e "    ${GRAY}Cherry-pick:       git checkout main && git cherry-pick <commit>${NC}"
echo ""
