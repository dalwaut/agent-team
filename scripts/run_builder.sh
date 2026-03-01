#!/usr/bin/env bash
# ============================================================
# Agent Team - Builder
# ============================================================
# Takes a task spec and implements it using Claude Code.
# No git operations. No auditing. Just builds what you ask for.
#
# Usage:
#   ./scripts/run_builder.sh specs/my-feature.md          # from a spec file
#   ./scripts/run_builder.sh -t "Add delete button to X"  # inline task
#   ./scripts/run_builder.sh --task TASK-042               # from task registry
#   ./scripts/run_builder.sh -t "..." --dry-run            # plan only, don't apply
#   ./scripts/run_builder.sh -t "..." --yes                # skip confirmation
#   ./scripts/run_builder.sh -t "..." --context tools/opai-monitor  # scope hint
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
WHITE='\033[1;37m'
NC='\033[0m'

# --- Defaults ---
TASK_TEXT=""
SPEC_FILE=""
TASK_ID=""
DRY_RUN=false
YES=false
CONTEXT_PATH=""

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--text)      TASK_TEXT="$2"; shift 2 ;;
        --task)         TASK_ID="$2"; shift 2 ;;
        --dry-run)      DRY_RUN=true; shift ;;
        --yes|-y)       YES=true; shift ;;
        --context|-c)   CONTEXT_PATH="$2"; shift 2 ;;
        -h|--help)
            echo ""
            echo "Usage: ./scripts/run_builder.sh [OPTIONS] [SPEC_FILE]"
            echo ""
            echo "  SPEC_FILE              Path to a markdown spec/plan file"
            echo "  -t, --text \"...\"       Inline task description"
            echo "  --task TASK-ID         Load task from tasks/registry.json"
            echo "  --context PATH         Scope hint (e.g., tools/opai-monitor)"
            echo "  --dry-run              Generate plan only, don't implement"
            echo "  -y, --yes              Skip confirmation prompt"
            echo "  -h, --help             Show this help"
            echo ""
            echo "Examples:"
            echo "  ./scripts/run_builder.sh specs/add-attachments.md"
            echo "  ./scripts/run_builder.sh -t \"Add a delete button to HITL briefings\""
            echo "  ./scripts/run_builder.sh -t \"Add dark mode\" --context tools/opai-monitor"
            echo ""
            exit 0
            ;;
        -*)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            echo "Use --help for usage." >&2
            exit 1
            ;;
        *)
            # Positional arg = spec file
            SPEC_FILE="$1"; shift ;;
    esac
done

# --- Resolve task spec ---
TASK_SPEC=""

if [[ -n "$TASK_TEXT" ]]; then
    TASK_SPEC="$TASK_TEXT"
elif [[ -n "$SPEC_FILE" ]]; then
    if [[ ! -f "$SPEC_FILE" ]]; then
        echo -e "${RED}Spec file not found: $SPEC_FILE${NC}" >&2
        exit 1
    fi
    TASK_SPEC="$(cat "$SPEC_FILE")"
    echo -e "  ${GRAY}Loaded spec from: $SPEC_FILE${NC}"
elif [[ -n "$TASK_ID" ]]; then
    # Load from task registry
    REGISTRY="$PROJECT_ROOT/tasks/registry.json"
    if [[ ! -f "$REGISTRY" ]]; then
        echo -e "${RED}Task registry not found: $REGISTRY${NC}" >&2
        exit 1
    fi
    # Extract task by ID using python (available on most systems)
    TASK_SPEC=$(python3 -c "
import json, sys
with open('$REGISTRY') as f:
    data = json.load(f)
tasks = data.get('tasks', data) if isinstance(data, dict) else data
for t in (tasks if isinstance(tasks, list) else tasks.values()):
    tid = t.get('id', t.get('task_id', ''))
    if str(tid) == '$TASK_ID':
        print(t.get('description', t.get('title', 'No description')))
        sys.exit(0)
print('TASK_NOT_FOUND')
" 2>/dev/null || echo "TASK_NOT_FOUND")

    if [[ "$TASK_SPEC" == "TASK_NOT_FOUND" ]]; then
        echo -e "${RED}Task '$TASK_ID' not found in registry${NC}" >&2
        exit 1
    fi
    echo -e "  ${GRAY}Loaded task: $TASK_ID${NC}"
else
    echo -e "${RED}No task specified. Use -t, --task, or pass a spec file.${NC}" >&2
    echo "Use --help for usage." >&2
    exit 1
fi

# --- Display ---
echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Agent Team - Builder${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# Truncate display if long
DISPLAY_SPEC="$TASK_SPEC"
if [[ ${#DISPLAY_SPEC} -gt 300 ]]; then
    DISPLAY_SPEC="${DISPLAY_SPEC:0:300}..."
fi
echo -e "  ${WHITE}Task:${NC}"
echo -e "  ${GRAY}$DISPLAY_SPEC${NC}"
echo ""

if [[ -n "$CONTEXT_PATH" ]]; then
    echo -e "  ${WHITE}Context scope:${NC} ${GRAY}$CONTEXT_PATH${NC}"
    echo ""
fi

# --- Confirm ---
if [[ "$YES" != true ]]; then
    if [[ "$DRY_RUN" == true ]]; then
        echo -e "  ${YELLOW}DRY RUN: Will generate a plan only (no file changes).${NC}"
    else
        echo -e "  ${YELLOW}The builder will read code and make changes to implement this task.${NC}"
    fi
    echo ""
    read -rp "  Proceed? (y/N) " confirm
    if [[ "${confirm,,}" != "y" ]]; then
        echo -e "  ${RED}Aborted.${NC}"
        exit 0
    fi
fi

# --- Report directory ---
DATE_STAMP=$(date +%Y-%m-%d)
REPORT_DIR="$PROJECT_ROOT/reports/$DATE_STAMP"
mkdir -p "$REPORT_DIR"

# --- Build the prompt ---
PROMPT_FILE="$SCRIPT_DIR/prompt_builder.txt"
if [[ ! -f "$PROMPT_FILE" ]]; then
    echo -e "${RED}Builder prompt not found: $PROMPT_FILE${NC}" >&2
    exit 1
fi

CONTEXT_HINT=""
if [[ -n "$CONTEXT_PATH" ]]; then
    CONTEXT_HINT="

CONTEXT SCOPE: Focus your exploration on '$CONTEXT_PATH' and related files. This is the primary area of the codebase affected by this task."
fi

DRY_RUN_INSTRUCTION=""
if [[ "$DRY_RUN" == true ]]; then
    DRY_RUN_INSTRUCTION="

IMPORTANT: This is a DRY RUN. Do NOT modify any files. Instead:
1. Explore the codebase as you normally would
2. Design the full implementation plan
3. Output the plan in detail (which files to change, what changes to make, code snippets)
4. Do NOT use Edit, Write, or any file-modification tools"
fi

temp_prompt=$(mktemp /tmp/claude_prompt_builder.XXXXXX)
{
    cat "$PROMPT_FILE"
    echo ""
    echo "=========================================="
    echo "TASK SPEC"
    echo "=========================================="
    echo ""
    echo "$TASK_SPEC"
    echo "$CONTEXT_HINT"
    echo "$DRY_RUN_INSTRUCTION"
} > "$temp_prompt"

# --- Run Claude ---
echo ""
if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${CYAN}Generating implementation plan...${NC}"
else
    echo -e "  ${CYAN}Building...${NC}"
fi
echo -e "  ${GRAY}(This may take a few minutes depending on scope)${NC}"

START_TIME=$(date +%s)

# Generate a slug from the task for the report filename
TASK_SLUG=$(echo "$TASK_SPEC" | head -c 60 | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
[[ -z "$TASK_SLUG" ]] && TASK_SLUG="build-task"

if [[ "$DRY_RUN" == true ]]; then
    RESULT_FILE="$REPORT_DIR/builder_plan_${TASK_SLUG}.md"
else
    RESULT_FILE="$REPORT_DIR/builder_result_${TASK_SLUG}.md"
fi

if result_output=$(cd "$PROJECT_ROOT" && cat "$temp_prompt" | claude -p --output-format text 2>&1); then
    if [[ "$DRY_RUN" == true ]]; then
        printf '# Builder Plan\n\n**Task:** %s\n\n---\n\n%s' "$DISPLAY_SPEC" "$result_output" > "$RESULT_FILE"
    else
        printf '# Builder Result\n\n**Task:** %s\n\n---\n\n%s' "$DISPLAY_SPEC" "$result_output" > "$RESULT_FILE"
    fi
    elapsed=$(( $(date +%s) - START_TIME ))
    result_size=$(stat -c%s "$RESULT_FILE" 2>/dev/null || echo 0)
    echo -e "  ${GREEN}Done (${result_size}B, ${elapsed}s)${NC}"
    echo -e "  ${GRAY}Report: $RESULT_FILE${NC}"
else
    echo -e "  ${RED}Build FAILED${NC}"
    rm -f "$temp_prompt"
    exit 1
fi
rm -f "$temp_prompt"

# --- Summary ---
echo ""
echo -e "${GREEN}============================================${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${GREEN}  Builder Plan Complete${NC}"
else
    echo -e "${GREEN}  Builder Complete${NC}"
fi
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  ${GRAY}Report: $RESULT_FILE${NC}"

if [[ "$DRY_RUN" == true ]]; then
    echo ""
    echo -e "  ${CYAN}To implement:${NC}"
    echo -e "    ${GRAY}./scripts/run_builder.sh ${SPEC_FILE:-\"-t '$TASK_TEXT'\"}${NC}"
else
    echo ""
    echo -e "  ${CYAN}Review changes:${NC}"
    echo -e "    ${GRAY}git diff${NC}"
    echo -e "    ${GRAY}git diff --stat${NC}"
fi
echo ""
