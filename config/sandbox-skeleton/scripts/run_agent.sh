#!/usr/bin/env bash
# Run a single agent within the user sandbox.
# Usage: ./scripts/run_agent.sh <agent_name>
#
# Enforces:
#   - Working directory stays within sandbox
#   - Timeout from sandbox.json
#   - Resource limits via ulimit

set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_NAME="${1:?Usage: run_agent.sh <agent_name>}"

# Load sandbox config
SANDBOX_CONFIG="${SANDBOX_DIR}/config/sandbox.json"
if [[ ! -f "$SANDBOX_CONFIG" ]]; then
    echo "ERROR: sandbox.json not found at ${SANDBOX_CONFIG}" >&2
    exit 1
fi

TIMEOUT=$(python3 -c "import json; print(json.load(open('${SANDBOX_CONFIG}'))['limits']['agent_timeout_seconds'])" 2>/dev/null || echo 120)

# Load team.json to find the agent
TEAM_FILE="${SANDBOX_DIR}/agents/team.json"
if [[ ! -f "$TEAM_FILE" ]]; then
    echo "ERROR: team.json not found at ${TEAM_FILE}" >&2
    exit 1
fi

# Extract prompt file path for this agent
PROMPT_FILE=$(python3 -c "
import json, sys
team = json.load(open('${TEAM_FILE}'))
agent = team.get('agents', {}).get('${AGENT_NAME}')
if not agent:
    print(f'ERROR: Agent \"${AGENT_NAME}\" not found in team.json', file=sys.stderr)
    sys.exit(1)
print(agent['prompt_file'])
" 2>&1)

if [[ $? -ne 0 ]]; then
    echo "$PROMPT_FILE" >&2
    exit 1
fi

FULL_PROMPT_PATH="${SANDBOX_DIR}/${PROMPT_FILE}"
if [[ ! -f "$FULL_PROMPT_PATH" ]]; then
    echo "ERROR: Prompt file not found: ${FULL_PROMPT_PATH}" >&2
    exit 1
fi

# Ensure reports directory exists
mkdir -p "${SANDBOX_DIR}/reports/latest"

# Find claude CLI (may need nvm)
CLAUDE_CMD="claude"
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.nvm/nvm.sh" 2>/dev/null
fi
command -v claude &>/dev/null || {
    echo "ERROR: claude CLI not found in PATH" >&2
    exit 1
}

echo "[$(date -Iseconds)] Running agent: ${AGENT_NAME} (timeout: ${TIMEOUT}s)"

# Run the agent with timeout and resource limits
PROMPT=$(cat "$FULL_PROMPT_PATH")
timeout "${TIMEOUT}s" claude -p "${PROMPT}" \
    --output-format text \
    2>&1 | tee "${SANDBOX_DIR}/reports/latest/${AGENT_NAME}.md"

EXIT_CODE=${PIPESTATUS[0]}

if [[ $EXIT_CODE -eq 124 ]]; then
    echo "[$(date -Iseconds)] Agent ${AGENT_NAME} TIMED OUT after ${TIMEOUT}s"
    exit 124
elif [[ $EXIT_CODE -ne 0 ]]; then
    echo "[$(date -Iseconds)] Agent ${AGENT_NAME} FAILED with exit code ${EXIT_CODE}"
    exit $EXIT_CODE
else
    echo "[$(date -Iseconds)] Agent ${AGENT_NAME} completed successfully"
fi
