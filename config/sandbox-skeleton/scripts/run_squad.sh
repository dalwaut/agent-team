#!/usr/bin/env bash
# Run a named squad from the user's team.json.
# Usage: ./scripts/run_squad.sh <squad_name>
#        ./scripts/run_squad.sh --list

set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEAM_FILE="${SANDBOX_DIR}/agents/team.json"
SANDBOX_CONFIG="${SANDBOX_DIR}/config/sandbox.json"

if [[ ! -f "$TEAM_FILE" ]]; then
    echo "ERROR: team.json not found" >&2
    exit 1
fi

# List mode
if [[ "${1:-}" == "--list" || "${1:-}" == "-l" ]]; then
    echo "Available squads:"
    python3 -c "
import json
team = json.load(open('${TEAM_FILE}'))
for name, squad in team.get('squads', {}).items():
    agents = ', '.join(squad.get('agents', []))
    desc = squad.get('description', '')
    print(f'  {name:12s}  [{agents}]  {desc}')
"
    exit 0
fi

SQUAD_NAME="${1:?Usage: run_squad.sh <squad_name> | --list}"

# Get max parallel from sandbox config
MAX_PARALLEL=$(python3 -c "import json; print(json.load(open('${SANDBOX_CONFIG}'))['limits']['max_parallel_agents'])" 2>/dev/null || echo 1)

# Get agents in this squad
AGENTS=$(python3 -c "
import json, sys
team = json.load(open('${TEAM_FILE}'))
squad = team.get('squads', {}).get('${SQUAD_NAME}')
if not squad:
    print(f'ERROR: Squad \"${SQUAD_NAME}\" not found', file=sys.stderr)
    sys.exit(1)
print(' '.join(squad['agents']))
")

if [[ $? -ne 0 ]]; then
    exit 1
fi

echo "=== Running squad: ${SQUAD_NAME} ==="
echo "Agents: ${AGENTS}"
echo "Max parallel: ${MAX_PARALLEL}"
echo ""

# Run agents (respecting parallel limit)
RUNNING=0
PIDS=()

for agent in $AGENTS; do
    if (( RUNNING >= MAX_PARALLEL )); then
        # Wait for one to finish
        wait -n "${PIDS[@]}" 2>/dev/null || true
        RUNNING=$((RUNNING - 1))
    fi

    echo "Starting agent: ${agent}"
    "${SANDBOX_DIR}/scripts/run_agent.sh" "$agent" &
    PIDS+=($!)
    RUNNING=$((RUNNING + 1))
done

# Wait for all remaining
FAILED=0
for pid in "${PIDS[@]}"; do
    if ! wait "$pid"; then
        FAILED=$((FAILED + 1))
    fi
done

echo ""
echo "=== Squad ${SQUAD_NAME} complete ==="
if (( FAILED > 0 )); then
    echo "${FAILED} agent(s) failed"
    exit 1
fi
