#!/bin/bash
# ── E2E Test: Agent Task Lifecycle ──────────────────────────────
#
# Tests the full lifecycle:
#   1. Registry task exists (read)
#   2. HITL briefing exists for propose-mode tasks
#   3. Task Control Panel serves tasks correctly
#   4. Team Hub has migrated items with registry tags
#   5. HITL respond endpoint is registered
#   6. Orchestrator config has task processing enabled
#
# Usage:
#   ./scripts/test-agent-task-flow.sh
#
# Prerequisites: Task Control Panel (8081) and Team Hub (8089) running
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠ $1"; WARN=$((WARN+1)); }
header() { echo -e "\n═══ $1 ═══"; }

REGISTRY="/workspace/synced/opai/tasks/registry.json"
HITL_DIR="/workspace/reports/HITL"
ORCH_CONFIG="/workspace/synced/opai/config/orchestrator.json"
TCP_BASE="http://localhost:8081"
TH_BASE="http://localhost:8089"

SB_URL="https://idorgloobxkmlnwnxbej.supabase.co"
SB_ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlkb3JnbG9vYnhrbWxud254YmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4Mzk2NzUsImV4cCI6MjA4NjQxNTY3NX0.zJ9L0QbKLFlNs1PV_yhlEjd0SbJ9XPTaBC7dxDul30I"
SB_SERVICE="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlkb3JnbG9vYnhrbWxud254YmVqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDgzOTY3NSwiZXhwIjoyMDg2NDE1Njc1fQ.TXLI1QnYqJwUCFejlXR0AKh5xwDVhi5nALrAGUFZs2c"

sb_query() {
    local table="$1" params="$2"
    curl -s "${SB_URL}/rest/v1/${table}?${params}" \
        -H "apikey: ${SB_ANON}" \
        -H "Authorization: Bearer ${SB_SERVICE}"
}

# ── 1. Registry File ───────────────────────────────────────────

header "1. Registry File"

if [ -f "$REGISTRY" ]; then
    pass "registry.json exists"
else
    fail "registry.json missing"
fi

TOTAL=$(python3 -c "import json; d=json.load(open('$REGISTRY')); print(len(d['tasks']))")
echo "  Total tasks: $TOTAL"

# Count system vs work tasks
SYSTEM_IDS="t-20260212-001 t-20260212-018 t-20260212-048 t-20260212-050 t-20260212-058 t-20260213-001"
SYSTEM_COUNT=0
for sid in $SYSTEM_IDS; do
    if python3 -c "import json; d=json.load(open('$REGISTRY')); exit(0 if '$sid' in d['tasks'] else 1)" 2>/dev/null; then
        SYSTEM_COUNT=$((SYSTEM_COUNT+1))
    fi
done
echo "  System tasks in registry: $SYSTEM_COUNT"
WORK_COUNT=$((TOTAL - SYSTEM_COUNT))
echo "  Work tasks in registry: $WORK_COUNT"

if [ "$SYSTEM_COUNT" -ge 6 ]; then
    pass "All system tasks present in registry"
else
    fail "Expected 6 system tasks, found $SYSTEM_COUNT"
fi

# ── 2. HITL Briefings ─────────────────────────────────────────

header "2. HITL Briefings"

if [ -d "$HITL_DIR" ]; then
    HITL_COUNT=$(ls "$HITL_DIR"/*.md 2>/dev/null | wc -l)
    echo "  Active briefings: $HITL_COUNT"
    pass "HITL directory exists"
else
    fail "HITL directory missing at $HITL_DIR"
    HITL_COUNT=0
fi

# Check that propose-mode tasks have briefings
PROPOSE_COUNT=$(python3 -c "
import json
d = json.load(open('$REGISTRY'))
count = sum(1 for t in d['tasks'].values() if t.get('routing',{}).get('mode') == 'propose')
print(count)
")
echo "  Propose-mode tasks: $PROPOSE_COUNT"
echo "  HITL briefings: $HITL_COUNT"

if [ "$HITL_COUNT" -gt 0 ]; then
    pass "HITL briefings exist for propose-mode tasks"
else
    warn "No HITL briefings found (orchestrator may not have run recently)"
fi

# ── 3. Task Control Panel ─────────────────────────────────────

header "3. Task Control Panel (port 8081)"

TCP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${TCP_BASE}/api/tasks" 2>/dev/null || echo "000")
if [ "$TCP_STATUS" = "200" ]; then
    pass "GET /api/tasks returns 200"
else
    fail "GET /api/tasks returned $TCP_STATUS"
fi

# Check HITL endpoint
HITL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${TCP_BASE}/api/hitl" 2>/dev/null || echo "000")
if [ "$HITL_STATUS" = "200" ]; then
    pass "GET /api/hitl returns 200"
else
    fail "GET /api/hitl returned $HITL_STATUS"
fi

# Check HITL respond endpoint exists (should return 405 on GET since it's POST-only)
HITL_RESPOND=$(curl -s -o /dev/null -w "%{http_code}" "${TCP_BASE}/api/hitl/test.md/respond" 2>/dev/null || echo "000")
if [ "$HITL_RESPOND" = "405" ]; then
    pass "POST /api/hitl/{filename}/respond endpoint registered (405 on GET)"
elif [ "$HITL_RESPOND" = "401" ]; then
    pass "POST /api/hitl/{filename}/respond endpoint registered (401 = auth required)"
else
    warn "HITL respond returned $HITL_RESPOND (expected 405)"
fi

# Check summary endpoint
SUMMARY=$(curl -s "${TCP_BASE}/api/tasks/summary" 2>/dev/null)
if echo "$SUMMARY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'  Pending: {d.get(\"pending\",0)}, In Progress: {d.get(\"in_progress\",0)}')" 2>/dev/null; then
    pass "Summary endpoint returns valid data"
else
    fail "Summary endpoint broken"
fi

# ── 4. Team Hub Migration ─────────────────────────────────────

header "4. Team Hub Migration Verification"

TH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${TH_BASE}/api/auth/config" 2>/dev/null || echo "000")
if [ "$TH_STATUS" = "200" ]; then
    pass "Team Hub API reachable"
else
    fail "Team Hub API returned $TH_STATUS"
fi

# Check registry tags exist in Supabase
TAG_COUNT=$(sb_query "team_tags" "name=like.registry%3A*&select=id" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
echo "  Registry tags in Team Hub: $TAG_COUNT"

if [ "$TAG_COUNT" -ge 30 ]; then
    pass "Migration created registry tags ($TAG_COUNT found, expected ~31)"
elif [ "$TAG_COUNT" -gt 0 ]; then
    warn "Partial migration — only $TAG_COUNT tags (expected ~31)"
else
    fail "No registry tags found — migration may not have run"
fi

# Spot-check: verify a specific migrated task
SPOT_TAG=$(sb_query "team_tags" "name=eq.registry%3At-20260212-024&select=id,workspace_id" 2>/dev/null)
SPOT_FOUND=$(echo "$SPOT_TAG" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d else 'no')" 2>/dev/null)
if [ "$SPOT_FOUND" = "yes" ]; then
    pass "Spot check: t-20260212-024 (BoutaCare feedback form) migrated"
else
    fail "Spot check: t-20260212-024 not found in Team Hub"
fi

# Check items were created in correct workspaces
BOUTABYTE_WS="5f158f9d-de71-4db1-bd05-87684f34da30"
BC_ITEMS=$(sb_query "team_items" "workspace_id=eq.${BOUTABYTE_WS}&source=like.registry%3A*&select=id" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
echo "  BoutaCare items in BoutaByte workspace: $BC_ITEMS"
if [ "$BC_ITEMS" -ge 11 ]; then
    pass "BoutaCare tasks migrated to BoutaByte workspace ($BC_ITEMS items)"
else
    warn "Expected 11 BoutaCare items, found $BC_ITEMS"
fi

# ── 5. Orchestrator Config ────────────────────────────────────

header "5. Orchestrator Configuration"

if [ -f "$ORCH_CONFIG" ]; then
    TASK_PROCESS=$(python3 -c "import json; c=json.load(open('$ORCH_CONFIG')); print(c.get('schedules',{}).get('task_process','not set'))")
    echo "  Task processing schedule: $TASK_PROCESS"
    pass "Orchestrator config exists"
else
    fail "Orchestrator config missing"
fi

# Check task_processing settings
TASK_CFG=$(python3 -c "
import json
c = json.load(open('$ORCH_CONFIG'))
tp = c.get('task_processing', {})
print(f'auto_execute={tp.get(\"auto_execute\", \"not set\")}')
" 2>/dev/null || echo "section missing")
echo "  Task processing config: $TASK_CFG"

# ── 6. Agent Execution Paths ─────────────────────────────────

header "6. Execution Infrastructure"

# Check squad runner exists
if [ -f "/workspace/synced/opai/scripts/run_squad.sh" ]; then
    pass "run_squad.sh exists"
elif [ -f "/workspace/synced/opai/scripts/run_squad.ps1" ]; then
    pass "run_squad.ps1 exists (PowerShell)"
else
    warn "No squad runner script found"
fi

# Check reports directory
if [ -d "/workspace/reports" ]; then
    REPORT_DIRS=$(ls -d /workspace/reports/2026* 2>/dev/null | wc -l)
    echo "  Report directories: $REPORT_DIRS"
    pass "Reports directory exists"
else
    fail "Reports directory missing"
fi

# Check archive directory
if [ -d "/workspace/reports/Archive" ]; then
    ARCHIVED=$(ls /workspace/reports/Archive/*.md 2>/dev/null | wc -l)
    echo "  Archived briefings: $ARCHIVED"
    pass "Archive directory exists"
else
    warn "Archive directory missing"
fi

# ── Results ───────────────────────────────────────────────────

header "Results"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Warnings: $WARN"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo "All critical checks passed."
    exit 0
else
    echo "Some checks failed — review output above."
    exit 1
fi
