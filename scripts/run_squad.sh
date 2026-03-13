#!/usr/bin/env bash
# ============================================================
# Agent Team - Squad Runner
# ============================================================
# Reads team.json to run a named squad of agents.
# Handles run_order (parallel first, then "last" agents sequentially).
#
# Usage:
#   ./scripts/run_squad.sh -s audit
#   ./scripts/run_squad.sh -s plan --force
#   ./scripts/run_squad.sh -s evolve
#   ./scripts/run_squad.sh --list
#   ./scripts/run_squad.sh -s audit --dynamic --context "Auth module changes"
#   ./scripts/run_squad.sh -s secure --dynamic --context "Post-deploy check" --target tools/opai-chat
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AGENT_DIR")"
TEAM_FILE="$AGENT_DIR/team.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# --- Defaults ---
SQUAD=""
FORCE=false
SKIP_PREFLIGHT=false
LIST=false
MAX_PARALLEL=4
USE_TMUX=false
DYNAMIC=false
DYN_CONTEXT=""
DYN_TARGET=""

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--squad)    SQUAD="$2"; shift 2 ;;
        --force)       FORCE=true; shift ;;
        --skip-preflight) SKIP_PREFLIGHT=true; shift ;;
        --list|-l)     LIST=true; shift ;;
        --max-parallel) MAX_PARALLEL="$2"; shift 2 ;;
        --tmux)        USE_TMUX=true; shift ;;
        --dynamic)     DYNAMIC=true; shift ;;
        --context)     DYN_CONTEXT="$2"; shift 2 ;;
        --target)      DYN_TARGET="$2"; shift 2 ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

# --- Load team config ---
if [[ ! -f "$TEAM_FILE" ]]; then
    echo -e "${RED}team.json not found at $TEAM_FILE${NC}" >&2
    exit 1
fi

# --- List squads ---
if [[ "$LIST" == true ]]; then
    echo ""
    echo -e "${CYAN}=== Available Squads ===${NC}"
    jq -r '.squads | to_entries[] | "\(.key)|\(.value.description)|\(.value.agents | join(", "))"' "$TEAM_FILE" | while IFS='|' read -r name desc agents; do
        echo -e "  ${YELLOW}$name${NC}: $desc"
        echo -e "    ${GRAY}Agents: $agents${NC}"
    done
    echo ""
    exit 0
fi

if [[ -z "$SQUAD" ]]; then
    echo -e "${RED}Specify a squad with -s <name>. Use --list to see options.${NC}" >&2
    exit 1
fi

# --- Resolve squad ---
SQUAD_EXISTS=$(jq -r --arg s "$SQUAD" '.squads[$s] // empty' "$TEAM_FILE")
if [[ -z "$SQUAD_EXISTS" ]]; then
    echo -e "${RED}Squad '$SQUAD' not found. Use --list to see options.${NC}" >&2
    exit 1
fi

SQUAD_DESC=$(jq -r --arg s "$SQUAD" '.squads[$s].description' "$TEAM_FILE")
SQUAD_AGENTS=$(jq -r --arg s "$SQUAD" '.squads[$s].agents[]' "$TEAM_FILE")

echo ""
echo -e "${CYAN}=== Squad: $SQUAD ===${NC}"
echo -e "${GRAY}Description: $SQUAD_DESC${NC}"
echo -e "${GRAY}Agents: $(echo "$SQUAD_AGENTS" | tr '\n' ', ' | sed 's/,$//')${NC}"
echo ""

# --- Pre-flight ---
if [[ "$SKIP_PREFLIGHT" != true ]]; then
    bash "$SCRIPT_DIR/preflight.sh" || exit 1
fi

# --- Report directory ---
DATE_STAMP=$(date +%Y-%m-%d)
REPORT_DIR="$AGENT_DIR/reports/$DATE_STAMP"
mkdir -p "$REPORT_DIR"
LATEST_DIR="$AGENT_DIR/reports/latest"

# --- Separate parallel vs sequential agents ---
declare -a PARALLEL_AGENTS=()
declare -a PARALLEL_PROMPTS=()
declare -a PARALLEL_OUTPUTS=()
declare -a LAST_AGENTS=()
declare -a LAST_PROMPTS=()
declare -a LAST_OUTPUTS=()

while IFS= read -r agent_name; do
    [[ -z "$agent_name" ]] && continue

    RUN_ORDER=$(jq -r --arg a "$agent_name" '.roles[$a].run_order // "parallel"' "$TEAM_FILE")
    PROMPT_FILE_NAME=$(jq -r --arg a "$agent_name" '.roles[$a].prompt_file // empty' "$TEAM_FILE")

    if [[ -z "$PROMPT_FILE_NAME" ]]; then
        echo -e "  ${RED}[!!] Unknown agent: $agent_name (skipping)${NC}"
        continue
    fi

    PROMPT_FILE="$SCRIPT_DIR/$PROMPT_FILE_NAME"
    if [[ ! -f "$PROMPT_FILE" ]]; then
        echo -e "  ${RED}[!!] Missing prompt: $PROMPT_FILE_NAME (skipping $agent_name)${NC}"
        continue
    fi

    OUTPUT_FILE="$REPORT_DIR/$agent_name.md"

    if [[ "$RUN_ORDER" == "last" ]]; then
        LAST_AGENTS+=("$agent_name")
        LAST_PROMPTS+=("$PROMPT_FILE")
        LAST_OUTPUTS+=("$OUTPUT_FILE")
    else
        PARALLEL_AGENTS+=("$agent_name")
        PARALLEL_PROMPTS+=("$PROMPT_FILE")
        PARALLEL_OUTPUTS+=("$OUTPUT_FILE")
    fi
done <<< "$SQUAD_AGENTS"

# --- Dynamic composition: select relevant agents via composer ---
DYNAMIC_MODE="static"
DYNAMIC_SELECTED=""
DYNAMIC_PRUNED=""
if [[ "$DYNAMIC" == true ]] && [[ ${#PARALLEL_AGENTS[@]} -gt 0 ]]; then
    echo -e "${CYAN}Dynamic mode: invoking composer...${NC}"
    SELECTED=$(compose_agents "$SQUAD" "$DYN_CONTEXT" "$DYN_TARGET")

    if [[ -n "$SELECTED" ]]; then
        DYNAMIC_MODE="dynamic"
        # Rebuild parallel arrays with only selected agents
        declare -a NEW_PARALLEL_AGENTS=()
        declare -a NEW_PARALLEL_PROMPTS=()
        declare -a NEW_PARALLEL_OUTPUTS=()
        local_selected_list=""
        local_pruned_list=""

        for i in "${!PARALLEL_AGENTS[@]}"; do
            name="${PARALLEL_AGENTS[$i]}"
            if echo "$SELECTED" | grep -qx "$name"; then
                NEW_PARALLEL_AGENTS+=("$name")
                NEW_PARALLEL_PROMPTS+=("${PARALLEL_PROMPTS[$i]}")
                NEW_PARALLEL_OUTPUTS+=("${PARALLEL_OUTPUTS[$i]}")
                local_selected_list+="$name "
            else
                local_pruned_list+="$name "
            fi
        done

        # Also add any dynamically-selected agents not in the original squad
        while IFS= read -r sel_agent; do
            [[ -z "$sel_agent" ]] && continue
            already_added=false
            for existing in "${NEW_PARALLEL_AGENTS[@]}"; do
                if [[ "$existing" == "$sel_agent" ]]; then
                    already_added=true
                    break
                fi
            done
            if [[ "$already_added" == false ]]; then
                # Agent from dynamic_pool but not in original squad — resolve its prompt
                SEL_PROMPT_NAME=$(jq -r --arg a "$sel_agent" '.roles[$a].prompt_file // empty' "$TEAM_FILE")
                if [[ -n "$SEL_PROMPT_NAME" ]] && [[ -f "$SCRIPT_DIR/$SEL_PROMPT_NAME" ]]; then
                    NEW_PARALLEL_AGENTS+=("$sel_agent")
                    NEW_PARALLEL_PROMPTS+=("$SCRIPT_DIR/$SEL_PROMPT_NAME")
                    NEW_PARALLEL_OUTPUTS+=("$REPORT_DIR/$sel_agent.md")
                    local_selected_list+="$sel_agent "
                fi
            fi
        done <<< "$SELECTED"

        PARALLEL_AGENTS=("${NEW_PARALLEL_AGENTS[@]}")
        PARALLEL_PROMPTS=("${NEW_PARALLEL_PROMPTS[@]}")
        PARALLEL_OUTPUTS=("${NEW_PARALLEL_OUTPUTS[@]}")
        DYNAMIC_SELECTED="${local_selected_list% }"
        DYNAMIC_PRUNED="${local_pruned_list% }"

        echo -e "${GREEN}Composer selected (${#PARALLEL_AGENTS[@]}): ${DYNAMIC_SELECTED}${NC}"
        if [[ -n "$DYNAMIC_PRUNED" ]]; then
            echo -e "${GRAY}Pruned: ${DYNAMIC_PRUNED}${NC}"
        fi
    else
        echo -e "${YELLOW}Composer failed — running full squad${NC}"
    fi
    echo ""
fi

# --- Helper: build full prompt ---
build_prompt() {
    local prompt_file="$1"
    local agent_name="${2:-}"

    # Inject learned hints from previous runs (if Engine is available)
    if [[ -n "$agent_name" ]]; then
        local hints=""
        hints=$(curl -sf "http://localhost:8080/api/agent-feedback?role=${agent_name}&active=true&limit=10" 2>/dev/null || echo "")

        if [[ -n "$hints" ]] && [[ "$hints" != '{"items":[]'* ]] && [[ "$hints" != *'"error"'* ]]; then
            local hint_lines
            hint_lines=$(echo "$hints" | jq -r '.items[]? | "- " + .content + " (confidence: " + (.confidence|tostring) + ")"' 2>/dev/null || echo "")
            if [[ -n "$hint_lines" ]]; then
                echo "## Previous Run Insights"
                echo "(Learned from past runs — use as starting context, not gospel)"
                echo ""
                echo "$hint_lines"
                echo ""
                echo "---"
                echo ""
            fi
        fi
    fi

    cat "$prompt_file"
    cat <<'INSTRUCTIONS'

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
INSTRUCTIONS
}

# --- Helper: compose dynamic agent selection ---
compose_agents() {
    local squad_name="$1"
    local context="$2"
    local target="$3"

    # Read dynamic_pool (fall back to agents if no pool defined)
    local pool
    pool=$(jq -r --arg s "$squad_name" '
        (.squads[$s].dynamic_pool // .squads[$s].agents) | .[]
    ' "$TEAM_FILE")

    if [[ -z "$pool" ]]; then
        echo ""
        return
    fi

    # Filter out "last" agents — they're never candidates for removal
    local candidates=""
    while IFS= read -r agent; do
        [[ -z "$agent" ]] && continue
        local order
        order=$(jq -r --arg a "$agent" '.roles[$a].run_order // "parallel"' "$TEAM_FILE")
        if [[ "$order" != "last" ]]; then
            candidates+="$agent"$'\n'
        fi
    done <<< "$pool"
    candidates=$(echo "$candidates" | sed '/^$/d')

    if [[ -z "$candidates" ]]; then
        echo ""
        return
    fi

    # Build candidate descriptions for the composer
    local candidate_list=""
    while IFS= read -r agent; do
        [[ -z "$agent" ]] && continue
        local desc
        desc=$(jq -r --arg a "$agent" '.roles[$a].description // "No description"' "$TEAM_FILE")
        candidate_list+="- $agent: $desc"$'\n'
    done <<< "$candidates"

    # Gather recent report history from manifest
    local history="No recent history available."
    local manifest_file="$AGENT_DIR/reports/latest/.manifest.json"
    if [[ -f "$manifest_file" ]]; then
        history=$(jq -r '.files | to_entries[] | "\(.key): squad=\(.value.squad) date=\(.value.date)"' "$manifest_file" 2>/dev/null || echo "No recent history available.")
    fi

    # Use provided context or a generic fallback
    local effective_context="${context:-General run, no specific context}"
    local effective_target="${target:-No specific target — analyze entire project}"

    # Build the composer prompt from template
    local composer_template="$SCRIPT_DIR/prompt_composer.txt"
    if [[ ! -f "$composer_template" ]]; then
        echo -e "  ${RED}[!!] Composer prompt not found: $composer_template${NC}" >&2
        echo ""
        return
    fi

    local composer_prompt
    composer_prompt=$(cat "$composer_template")
    composer_prompt="${composer_prompt//\{\{CANDIDATES\}\}/$candidate_list}"
    composer_prompt="${composer_prompt//\{\{CONTEXT\}\}/$effective_context}"
    composer_prompt="${composer_prompt//\{\{TARGET\}\}/$effective_target}"
    composer_prompt="${composer_prompt//\{\{HISTORY\}\}/$history}"

    # Call haiku for cheap, fast selection
    local temp_file
    temp_file=$(mktemp /tmp/composer_prompt.XXXXXX)
    echo "$composer_prompt" > "$temp_file"

    local composer_out
    unset CLAUDECODE
    if composer_out=$(cd "$PROJECT_ROOT" && cat "$temp_file" | claude -p --model haiku --output-format text 2>&1); then
        rm -f "$temp_file"
    else
        echo -e "  ${YELLOW}[!!] Composer call failed, falling back to full squad${NC}" >&2
        rm -f "$temp_file"
        echo ""
        return
    fi

    # Extract JSON array from output (handle possible surrounding text)
    local json_array
    json_array=$(echo "$composer_out" | grep -oE '\[("[a-z_]+"(,\s*"[a-z_]+")*)\]' | head -1)

    if [[ -z "$json_array" ]]; then
        echo -e "  ${YELLOW}[!!] Composer returned invalid format, falling back to full squad${NC}" >&2
        echo ""
        return
    fi

    # Validate: parse with jq, check count, verify each agent exists in pool
    local count
    count=$(echo "$json_array" | jq -r 'length' 2>/dev/null)
    if [[ -z "$count" ]] || [[ "$count" -lt 3 ]] || [[ "$count" -gt 7 ]]; then
        echo -e "  ${YELLOW}[!!] Composer selected $count agents (need 3-7), falling back to full squad${NC}" >&2
        echo ""
        return
    fi

    # Validate each agent name exists in the candidate pool
    local validated=""
    local valid_count=0
    while IFS= read -r selected; do
        [[ -z "$selected" ]] && continue
        if echo "$candidates" | grep -qx "$selected"; then
            validated+="$selected"$'\n'
            valid_count=$(( valid_count + 1 ))
        else
            echo -e "  ${YELLOW}[!!] Composer suggested unknown agent '$selected', skipping${NC}" >&2
        fi
    done <<< "$(echo "$json_array" | jq -r '.[]' 2>/dev/null)"

    if [[ "$valid_count" -lt 3 ]]; then
        echo -e "  ${YELLOW}[!!] Only $valid_count valid agents after filtering, falling back to full squad${NC}" >&2
        echo ""
        return
    fi

    echo "$validated" | sed '/^$/d'
}

# --- Helper: run a single agent ---
run_agent() {
    local name="$1"
    local prompt_file="$2"
    local output_file="$3"

    # Skip if already done
    if [[ "$FORCE" != true && -f "$output_file" ]] && [[ $(stat -c%s "$output_file" 2>/dev/null || echo 0) -gt 1000 ]]; then
        echo -e "  ${GRAY}[--] $name (exists, skipping)${NC}"
        echo "skipped"
        return
    fi

    echo -e "  ${YELLOW}[>>] $name${NC}" >&2

    local temp_prompt
    temp_prompt=$(mktemp /tmp/claude_prompt_${name}.XXXXXX)
    build_prompt "$prompt_file" "$name" > "$temp_prompt"

    unset CLAUDECODE  # prevent nested-spawn block when run inside a Claude Code session
    if agent_out=$(cd "$PROJECT_ROOT" && cat "$temp_prompt" | claude -p --output-format text 2>&1); then
        printf '# Report: %s\n\n%s' "$name" "$agent_out" > "$output_file"
        local size
        size=$(stat -c%s "$output_file" 2>/dev/null || echo 0)
        echo -e "  ${GREEN}[OK] $name (${size}B)${NC}" >&2
        rm -f "$temp_prompt"
        echo "success"
    else
        # Preserve error output so summary can include it
        printf '# Report: %s (FAILED)\n\n**Agent failed to produce output.**\n\nError output:\n```\n%s\n```\n' \
            "$name" "$agent_out" > "$output_file"
        echo -e "  ${RED}[!!] $name FAILED${NC}" >&2
        rm -f "$temp_prompt"
        echo "failed"
    fi
}

# --- Helper: tmux agent runner script (written to temp file per agent) ---
write_tmux_agent_script() {
    local name="$1" prompt_file="$2" output_file="$3" status_dir="$4"
    local script_file="$status_dir/${name}.sh"

    cat > "$script_file" <<TMUXSCRIPT
#!/usr/bin/env bash
set -euo pipefail
echo -e "\033[0;36m=== Agent: $name ===\033[0m"
echo "Output: $output_file"
echo ""

temp_prompt=\$(mktemp /tmp/claude_prompt_${name}.XXXXXX)

# Inject learned hints from previous runs
hints=\$(curl -sf "http://localhost:8080/api/agent-feedback?role=${name}&active=true&limit=10" 2>/dev/null || echo "")
if [[ -n "\$hints" ]] && [[ "\$hints" != '{"items":[]'* ]] && [[ "\$hints" != *'"error"'* ]]; then
    hint_lines=\$(echo "\$hints" | jq -r '.items[]? | "- " + .content + " (confidence: " + (.confidence|tostring) + ")"' 2>/dev/null || echo "")
    if [[ -n "\$hint_lines" ]]; then
        {
            echo "## Previous Run Insights"
            echo "(Learned from past runs — use as starting context, not gospel)"
            echo ""
            echo "\$hint_lines"
            echo ""
            echo "---"
            echo ""
        } > "\$temp_prompt"
    fi
fi

cat "$prompt_file" >> "\$temp_prompt"
cat <<'INST' >> "\$temp_prompt"

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
INST

cd "$PROJECT_ROOT"
unset CLAUDECODE

if agent_output=\$(cat "\$temp_prompt" | claude -p --output-format text 2>&1); then
    printf '# Report: %s\n\n%s' "$name" "\$agent_output" > "$output_file"
    echo "success" > "$status_dir/${name}.status"
    size=\$(stat -c%s "$output_file" 2>/dev/null || echo 0)
    echo ""
    echo -e "\033[0;32m[OK] $name complete (\${size}B)\033[0m"
else
    printf '# Report: %s (FAILED)\n\n**Agent failed to produce output.**\n\nError output:\n\\\`\\\`\\\`\n%s\n\\\`\\\`\\\`\n' "$name" "\$agent_output" > "$output_file"
    echo "failed" > "$status_dir/${name}.status"
    echo ""
    echo -e "\033[0;31m[!!] $name FAILED\033[0m"
fi
rm -f "\$temp_prompt"
echo ""
echo "Press Enter to close this window..."
read -r
TMUXSCRIPT
    chmod +x "$script_file"
    echo "$script_file"
}

# --- Phase 1: Run parallel agents ---
START_TIME=$(date +%s)
declare -A RESULTS=()

if [[ ${#PARALLEL_AGENTS[@]} -gt 0 ]]; then
    echo -e "${CYAN}Phase 1: Parallel agents (${#PARALLEL_AGENTS[@]})${NC}"

    if [[ "$USE_TMUX" == true ]] && command -v tmux &>/dev/null; then
        # --- TMUX MODE: visual parallel execution ---
        TMUX_SESSION="squad-${SQUAD}-$$"
        STATUS_DIR=$(mktemp -d /tmp/squad_tmux_${SQUAD}.XXXXXX)

        echo -e "${YELLOW}Starting tmux session: $TMUX_SESSION${NC}"
        echo -e "${GRAY}Attach with: tmux attach -t $TMUX_SESSION${NC}"

        # Create session with a status monitor window
        tmux new-session -d -s "$TMUX_SESSION" -n "monitor" \
            "watch -n2 'echo \"Squad: $SQUAD\"; echo \"\"; for f in $STATUS_DIR/*.status; do [ -f \"\$f\" ] && basename \"\$f\" .status | tr \"\\n\" \" \" && echo \": \$(cat \"\$f\")\"; done; echo \"\"; echo \"Waiting: \$(ls $STATUS_DIR/*.sh 2>/dev/null | wc -l) agents\"; echo \"Done: \$(ls $STATUS_DIR/*.status 2>/dev/null | wc -l)\"'"

        # Launch each agent in its own tmux window
        local_launched=0
        for i in "${!PARALLEL_AGENTS[@]}"; do
            name="${PARALLEL_AGENTS[$i]}"
            prompt="${PARALLEL_PROMPTS[$i]}"
            output="${PARALLEL_OUTPUTS[$i]}"

            # Skip if already done
            if [[ "$FORCE" != true && -f "$output" ]] && [[ $(stat -c%s "$output" 2>/dev/null || echo 0) -gt 1000 ]]; then
                echo -e "  ${GRAY}[--] $name (exists, skipping)${NC}"
                RESULTS["$name"]="skipped"
                echo "skipped" > "$STATUS_DIR/${name}.status"
                continue
            fi

            script=$(write_tmux_agent_script "$name" "$prompt" "$output" "$STATUS_DIR")
            tmux new-window -t "$TMUX_SESSION" -n "$name" "$script"
            echo -e "  ${YELLOW}[>>] $name (tmux window)${NC}"
            local_launched=$(( local_launched + 1 ))

            # Throttle: respect max parallel (stagger launches)
            if (( local_launched % MAX_PARALLEL == 0 )); then
                sleep 2
            fi
        done

        echo ""
        echo -e "${CYAN}All agents launched in tmux session: $TMUX_SESSION${NC}"
        echo -e "${YELLOW}Waiting for completion...${NC}"

        # Wait for all agents to finish (poll status files)
        expected=${#PARALLEL_AGENTS[@]}
        while true; do
            completed=$(ls "$STATUS_DIR"/*.status 2>/dev/null | wc -l)
            if [[ "$completed" -ge "$expected" ]]; then
                break
            fi
            sleep 3
        done

        # Collect results
        for i in "${!PARALLEL_AGENTS[@]}"; do
            name="${PARALLEL_AGENTS[$i]}"
            if [[ -f "$STATUS_DIR/${name}.status" ]]; then
                status=$(cat "$STATUS_DIR/${name}.status")
                RESULTS["$name"]="$status"
                if [[ "$status" == "success" ]]; then
                    size=$(stat -c%s "$REPORT_DIR/$name.md" 2>/dev/null || echo 0)
                    echo -e "  ${GREEN}[OK] $name (${size}B)${NC}"
                elif [[ "$status" == "skipped" ]]; then
                    echo -e "  ${GRAY}[--] $name${NC}"
                else
                    echo -e "  ${RED}[!!] $name FAILED${NC}"
                fi
            fi
        done

        # Kill the monitor window and cleanup
        tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
        rm -rf "$STATUS_DIR"
    else
        # --- STANDARD MODE: background jobs ---
        declare -A PIDS=()
        declare -A TEMP_RESULTS=()

        for i in "${!PARALLEL_AGENTS[@]}"; do
            name="${PARALLEL_AGENTS[$i]}"
            prompt="${PARALLEL_PROMPTS[$i]}"
            output="${PARALLEL_OUTPUTS[$i]}"

            # Throttle: wait if at max parallel
            while [[ $(jobs -rp | wc -l) -ge $MAX_PARALLEL ]]; do
                sleep 0.5
            done

            # Skip if already done
            if [[ "$FORCE" != true && -f "$output" ]] && [[ $(stat -c%s "$output" 2>/dev/null || echo 0) -gt 1000 ]]; then
                echo -e "  ${GRAY}[--] $name (exists, skipping)${NC}"
                RESULTS["$name"]="skipped"
                continue
            fi

            echo -e "  ${YELLOW}[>>] $name${NC}"

            # Launch in background
            (
                temp_prompt=$(mktemp /tmp/claude_prompt_${name}.XXXXXX)
                build_prompt "$prompt" > "$temp_prompt"
                cd "$PROJECT_ROOT"
                unset CLAUDECODE  # prevent nested-spawn block when run inside a Claude Code session
                if agent_output=$(cat "$temp_prompt" | claude -p --output-format text 2>&1); then
                    printf '# Report: %s\n\n%s' "$name" "$agent_output" > "$output"
                    rm -f "$temp_prompt"
                    exit 0
                else
                    # Preserve error output so summary can include it
                    printf '# Report: %s (FAILED)\n\n**Agent failed to produce output.**\n\nError output:\n```\n%s\n```\n' \
                        "$name" "$agent_output" > "$output"
                    rm -f "$temp_prompt"
                    exit 1
                fi
            ) &
            PIDS["$name"]=$!
        done

        # Wait for all background jobs
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

        # Cleanup temp files
        rm -f /tmp/claude_prompt_*.??????
    fi
fi

# --- Phase 2: Run "last" agents sequentially ---
if [[ ${#LAST_AGENTS[@]} -gt 0 ]]; then
    echo ""
    echo -e "${CYAN}Phase 2: Sequential agents (${#LAST_AGENTS[@]})${NC}"

    for i in "${!LAST_AGENTS[@]}"; do
        result=$(run_agent "${LAST_AGENTS[$i]}" "${LAST_PROMPTS[$i]}" "${LAST_OUTPUTS[$i]}")
        RESULTS["${LAST_AGENTS[$i]}"]="$result"
        sleep 3
    done
fi

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
            'squad': '$SQUAD',
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

echo ""
echo -e "${CYAN}=== Squad '$SQUAD' Complete (${TOTAL_TIME}s) ===${NC}"
for name in "${!RESULTS[@]}"; do
    status="${RESULTS[$name]}"
    case "$status" in
        success) echo -e "  ${GREEN}[OK] $name${NC}" ;;
        skipped) echo -e "  ${GRAY}[--] $name${NC}" ;;
        failed)  echo -e "  ${RED}[!!] $name${NC}" ;;
        *)       echo -e "  ${YELLOW}[??] $name${NC}" ;;
    esac
done
echo -e "${CYAN}Reports: $REPORT_DIR${NC}"

# --- Always write a run summary report ---
SUMMARY_FILE="$REPORT_DIR/_run_summary.md"
{
    echo "# Squad Run Summary: $SQUAD"
    echo ""
    echo "| Field | Value |"
    echo "|-------|-------|"
    echo "| Squad | \`$SQUAD\` |"
    echo "| Description | $SQUAD_DESC |"
    echo "| Date | $DATE_STAMP |"
    echo "| Duration | ${TOTAL_TIME}s |"
    echo "| Run at | $(date -u '+%Y-%m-%dT%H:%M:%SZ') |"
    echo ""
    echo "## Agent Results"
    echo ""
    echo "| Agent | Status |"
    echo "|-------|--------|"
    for name in "${!RESULTS[@]}"; do
        status="${RESULTS[$name]}"
        case "$status" in
            success) echo "| \`$name\` | ✅ success |" ;;
            skipped) echo "| \`$name\` | ⏭ skipped (cached) |" ;;
            failed)  echo "| \`$name\` | ❌ failed |" ;;
            *)       echo "| \`$name\` | ⚠️ $status |" ;;
        esac
    done
    echo ""
    # Count outcomes (avoid (( n++ )) under set -e when value is 0)
    local_success=0; local_failed=0; local_skipped=0
    for s in "${RESULTS[@]}"; do
        case "$s" in
            success) local_success=$(( local_success + 1 )) ;;
            failed)  local_failed=$(( local_failed + 1 )) ;;
            skipped) local_skipped=$(( local_skipped + 1 )) ;;
        esac
    done
    echo "**Total:** ${#RESULTS[@]} agents — $local_success succeeded, $local_failed failed, $local_skipped skipped"
    echo ""
    echo "## Dynamic Composition"
    echo ""
    echo "| Field | Value |"
    echo "|-------|-------|"
    echo "| Mode | $DYNAMIC_MODE |"
    if [[ "$DYNAMIC_MODE" == "dynamic" ]]; then
        echo "| Context | ${DYN_CONTEXT:-none} |"
        echo "| Target | ${DYN_TARGET:-none} |"
        echo "| Selected | ${DYNAMIC_SELECTED:-n/a} |"
        echo "| Pruned | ${DYNAMIC_PRUNED:-none} |"
    fi
    echo ""
    echo "## Report Files"
    echo ""
    for f in "$REPORT_DIR"/*.md; do
        [[ -f "$f" ]] || continue
        fname=$(basename "$f")
        [[ "$fname" == "_run_summary.md" ]] && continue
        sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
        echo "- \`$fname\` (${sz}B)"
    done
} > "$SUMMARY_FILE"
cp "$SUMMARY_FILE" "$LATEST_DIR/_run_summary.md" 2>/dev/null || true
echo -e "${GRAY}Summary: $SUMMARY_FILE${NC}"

# --- Post-squad hook: create tasks + send email ---
HOOK_SCRIPT="$SCRIPT_DIR/post_squad_hook.py"
if [[ -f "$HOOK_SCRIPT" ]]; then
    python3 "$HOOK_SCRIPT" \
        --squad "$SQUAD" \
        --report-dir "$REPORT_DIR" \
        --date "$DATE_STAMP" \
        --duration "$TOTAL_TIME" 2>&1 || true
fi
