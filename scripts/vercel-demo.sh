#!/usr/bin/env bash
# ============================================================
# vercel-demo.sh — Deploy ephemeral demos to Vercel
# ============================================================
# Disposable staging ground for quick demos during customer
# conversations. Max 3 active demos, 48h auto-review.
#
# Usage:
#   ./scripts/vercel-demo.sh deploy <dir> <slug> [notes]
#   ./scripts/vercel-demo.sh list
#   ./scripts/vercel-demo.sh teardown <slug>
#   ./scripts/vercel-demo.sh teardown-all
#   ./scripts/vercel-demo.sh sweep
#
# Exit codes: 0=success, 1=error, 2=limit reached
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPAI_ROOT="$(dirname "$SCRIPT_DIR")"
VAULT_CLI="$OPAI_ROOT/tools/opai-vault/scripts/vault-cli.sh"
TG_NOTIFY="$OPAI_ROOT/scripts/tg-notify.sh"
STATE_FILE="$OPAI_ROOT/tools/opai-engine/data/vercel-demos.json"

MAX_ACTIVE_DEMOS=3
DEFAULT_MAX_AGE_HOURS=48

# ── Helpers ────────────────────────────────────────────────

get_vercel_token() {
    local token=""
    if [[ -x "$VAULT_CLI" ]]; then
        token=$("$VAULT_CLI" get VERCEL_TOKEN 2>/dev/null || echo "")
    fi
    if [[ -z "$token" ]]; then
        echo "[vercel-demo] No VERCEL_TOKEN in vault" >&2
        exit 1
    fi
    echo "$token"
}

ensure_state_file() {
    if [[ ! -f "$STATE_FILE" ]]; then
        mkdir -p "$(dirname "$STATE_FILE")"
        cat > "$STATE_FILE" <<'INIT'
{
  "demos": {},
  "config": {
    "max_active_demos": 3,
    "default_max_age_hours": 48
  }
}
INIT
    fi
}

# Generate a short hash for unique naming
short_hash() {
    echo "$1" | md5sum | head -c 4
}

# Get current ISO timestamp
now_iso() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Hours since a given ISO timestamp
hours_since() {
    local then_epoch
    then_epoch=$(date -d "$1" +%s 2>/dev/null || echo 0)
    local now_epoch
    now_epoch=$(date +%s)
    echo $(( (now_epoch - then_epoch) / 3600 ))
}

# Count active demos
count_active() {
    python3 -c "
import json, sys
data = json.load(open('$STATE_FILE'))
count = sum(1 for d in data.get('demos', {}).values() if d.get('status') == 'active')
print(count)
"
}

# Send Telegram notification (best-effort)
notify() {
    if [[ -x "$TG_NOTIFY" ]]; then
        "$TG_NOTIFY" --html "$1" 2>/dev/null || true
    fi
}

# ── Commands ───────────────────────────────────────────────

cmd_deploy() {
    local dir="$1"
    local slug="$2"
    local notes="${3:-}"

    if [[ ! -d "$dir" ]]; then
        echo "[vercel-demo] Directory not found: $dir" >&2
        exit 1
    fi

    # Auto-sweep stale demos before deploying
    cmd_sweep 2>/dev/null || true

    # Check limit
    local active
    active=$(count_active)
    if [[ "$active" -ge "$MAX_ACTIVE_DEMOS" ]]; then
        echo "[vercel-demo] Limit reached: $active/$MAX_ACTIVE_DEMOS active demos" >&2
        echo "Run: ./scripts/vercel-demo.sh teardown <slug>" >&2
        exit 2
    fi

    local TOKEN
    TOKEN=$(get_vercel_token)

    local hash
    hash=$(short_hash "${slug}-$(date +%s)")
    local project_name="demo-${slug}-${hash}"

    echo "[vercel-demo] Deploying $dir as $project_name ..."

    # Deploy to Vercel (headless, no prompts)
    local deploy_output
    deploy_output=$(cd "$dir" && vercel --token "$TOKEN" --yes --prod --name "$project_name" 2>&1) || {
        echo "[vercel-demo] Deploy failed:" >&2
        echo "$deploy_output" >&2
        exit 1
    }

    # Extract the URL from output (last line that looks like a URL)
    local url
    url=$(echo "$deploy_output" | grep -oP 'https://[^\s]+' | tail -1)
    if [[ -z "$url" ]]; then
        url="https://${project_name}.vercel.app"
    fi

    # Write to state file
    local abs_dir
    abs_dir=$(cd "$dir" && pwd)
    python3 -c "
import json
data = json.load(open('$STATE_FILE'))
data['demos']['$slug'] = {
    'vercel_project': '$project_name',
    'url': '$url',
    'source_dir': '$abs_dir',
    'deployed_at': '$(now_iso)',
    'max_age_hours': $DEFAULT_MAX_AGE_HOURS,
    'status': 'active',
    'notes': '''$notes'''
}
json.dump(data, open('$STATE_FILE', 'w'), indent=2)
"

    echo "[vercel-demo] Deployed: $url"
    echo "[vercel-demo] Slug: $slug | Project: $project_name"
    notify "🚀 <b>Demo deployed</b>
<b>Slug:</b> $slug
<b>URL:</b> $url
<b>TTL:</b> ${DEFAULT_MAX_AGE_HOURS}h"

    # Return JSON for API callers
    echo "{\"success\":true,\"slug\":\"$slug\",\"url\":\"$url\",\"project\":\"$project_name\"}"
}

cmd_list() {
    ensure_state_file
    python3 -c "
import json, sys
from datetime import datetime, timezone

data = json.load(open('$STATE_FILE'))
demos = data.get('demos', {})
active = {k: v for k, v in demos.items() if v.get('status') == 'active'}

if not active:
    print('No active demos.')
    sys.exit(0)

print(f'{len(active)} active demo(s):')
print()
for slug, d in active.items():
    deployed = d.get('deployed_at', '?')
    try:
        dt = datetime.fromisoformat(deployed.replace('Z', '+00:00'))
        age_h = int((datetime.now(timezone.utc) - dt).total_seconds() / 3600)
        age_str = f'{age_h}h'
    except:
        age_str = '?'
    max_age = d.get('max_age_hours', $DEFAULT_MAX_AGE_HOURS)
    print(f'  {slug}')
    print(f'    URL:  {d.get(\"url\", \"?\")}')
    print(f'    Age:  {age_str} / {max_age}h max')
    if d.get('notes'):
        print(f'    Note: {d[\"notes\"]}')
    print()
"
}

cmd_teardown() {
    local slug="$1"

    ensure_state_file

    # Get project name from state
    local project_name
    project_name=$(python3 -c "
import json
data = json.load(open('$STATE_FILE'))
demo = data.get('demos', {}).get('$slug')
if demo:
    print(demo.get('vercel_project', ''))
else:
    print('')
")

    if [[ -z "$project_name" ]]; then
        echo "[vercel-demo] No demo found with slug: $slug" >&2
        exit 1
    fi

    local TOKEN
    TOKEN=$(get_vercel_token)

    echo "[vercel-demo] Tearing down $slug ($project_name) ..."

    # Remove from Vercel
    vercel remove "$project_name" --token "$TOKEN" --yes 2>/dev/null || true

    # Update state
    python3 -c "
import json
data = json.load(open('$STATE_FILE'))
if '$slug' in data.get('demos', {}):
    data['demos']['$slug']['status'] = 'removed'
json.dump(data, open('$STATE_FILE', 'w'), indent=2)
"

    echo "[vercel-demo] Removed: $slug"
    notify "🗑️ <b>Demo removed:</b> $slug ($project_name)"
}

cmd_teardown_all() {
    ensure_state_file
    local slugs
    slugs=$(python3 -c "
import json
data = json.load(open('$STATE_FILE'))
for slug, d in data.get('demos', {}).items():
    if d.get('status') == 'active':
        print(slug)
")

    if [[ -z "$slugs" ]]; then
        echo "[vercel-demo] No active demos to remove."
        return 0
    fi

    while IFS= read -r slug; do
        cmd_teardown "$slug"
    done <<< "$slugs"

    echo "[vercel-demo] All demos removed."
}

cmd_sweep() {
    ensure_state_file
    local stale_slugs
    stale_slugs=$(python3 -c "
import json
from datetime import datetime, timezone

data = json.load(open('$STATE_FILE'))
for slug, d in data.get('demos', {}).items():
    if d.get('status') != 'active':
        continue
    try:
        dt = datetime.fromisoformat(d['deployed_at'].replace('Z', '+00:00'))
        age_h = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
        if age_h > d.get('max_age_hours', $DEFAULT_MAX_AGE_HOURS):
            print(slug)
    except:
        pass
")

    if [[ -z "$stale_slugs" ]]; then
        echo "[vercel-demo] No stale demos."
        return 0
    fi

    echo "[vercel-demo] Sweeping stale demos ..."
    while IFS= read -r slug; do
        echo "[vercel-demo] Stale: $slug"
        cmd_teardown "$slug"
    done <<< "$stale_slugs"
}

# ── Main ───────────────────────────────────────────────────

ensure_state_file

CMD="${1:-help}"
shift || true

case "$CMD" in
    deploy)
        if [[ $# -lt 2 ]]; then
            echo "Usage: vercel-demo.sh deploy <directory> <slug> [notes]" >&2
            exit 1
        fi
        cmd_deploy "$1" "$2" "${3:-}"
        ;;
    list)
        cmd_list
        ;;
    teardown)
        if [[ $# -lt 1 ]]; then
            echo "Usage: vercel-demo.sh teardown <slug>" >&2
            exit 1
        fi
        cmd_teardown "$1"
        ;;
    teardown-all)
        cmd_teardown_all
        ;;
    sweep)
        cmd_sweep
        ;;
    *)
        echo "vercel-demo.sh — Ephemeral Vercel demo deployments"
        echo ""
        echo "Commands:"
        echo "  deploy <dir> <slug> [notes]  Deploy directory as demo"
        echo "  list                          Show active demos"
        echo "  teardown <slug>              Remove a specific demo"
        echo "  teardown-all                 Remove all demos"
        echo "  sweep                        Auto-remove stale demos"
        exit 0
        ;;
esac
