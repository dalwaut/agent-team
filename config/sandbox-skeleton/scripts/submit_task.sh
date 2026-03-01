#!/usr/bin/env bash
# Submit a task to the central OPAI queue.
# Usage: ./scripts/submit_task.sh "Task title" ["Task description"]
#
# Tasks are written to the user's local tasks/queue.json.
# The central orchestrator picks them up on its scan cycle.

set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUEUE_FILE="${SANDBOX_DIR}/tasks/queue.json"
USER_FILE="${SANDBOX_DIR}/.opai-user.json"

TITLE="${1:?Usage: submit_task.sh \"Task title\" [\"Description\"]}"
DESCRIPTION="${2:-}"

# Get user info
USER_ID=$(python3 -c "import json; print(json.load(open('${USER_FILE}'))['user_id'])" 2>/dev/null || echo "unknown")
USER_NAME=$(python3 -c "import json; print(json.load(open('${USER_FILE}'))['name'])" 2>/dev/null || echo "unknown")

# Generate task ID
TASK_ID="usr-$(date +%s)-$$"
TIMESTAMP=$(date -Iseconds)

# Read existing queue or create empty
if [[ -f "$QUEUE_FILE" ]]; then
    QUEUE=$(cat "$QUEUE_FILE")
else
    QUEUE='{"tasks":[]}'
fi

# Append task
python3 -c "
import json, sys

queue = json.loads('''${QUEUE}''')
queue.setdefault('tasks', []).append({
    'id': '${TASK_ID}',
    'title': sys.argv[1],
    'description': sys.argv[2],
    'status': 'pending',
    'source': 'user-sandbox',
    'source_user': '${USER_ID}',
    'source_name': '${USER_NAME}',
    'created_at': '${TIMESTAMP}',
    'updated_at': '${TIMESTAMP}'
})
queue['last_updated'] = '${TIMESTAMP}'

with open('${QUEUE_FILE}', 'w') as f:
    json.dump(queue, f, indent=2)
" "$TITLE" "$DESCRIPTION"

echo "Task submitted: ${TASK_ID}"
echo "  Title: ${TITLE}"
echo "  Queue: ${QUEUE_FILE}"
echo ""
echo "The central orchestrator will pick this up on its next scan cycle."
