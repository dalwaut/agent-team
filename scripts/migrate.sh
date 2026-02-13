#!/usr/bin/env bash
#
# OPAI Mid-Flight Migration Script (Linux/Mac)
# Merge a newer OPAI version into an existing installation.
#
# Usage:
#   ./scripts/migrate.sh              # Run migration
#   ./scripts/migrate.sh --dry-run    # Preview changes only
#   ./scripts/migrate.sh --force      # Skip confirmation prompts
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPAI_ROOT="$(dirname "$SCRIPT_DIR")"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
DRY_RUN=false
FORCE=false
BACKUP_DIR=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --force) FORCE=true; shift ;;
        --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

[[ -z "$BACKUP_DIR" ]] && BACKUP_DIR="$OPAI_ROOT/_backup_$TIMESTAMP"

echo ""
echo "========================================"
echo "  OPAI Mid-Flight Migration v1.3.0"
echo "========================================"
echo ""

$DRY_RUN && echo "[DRY RUN] No changes will be made." && echo ""

# ── Step 1: Detect Existing Installation ──

echo "[1/8] Detecting existing installation..."

declare -A existing
existing[TeamJson]=$([[ -f "$OPAI_ROOT/team.json" ]] && echo 1 || echo 0)
existing[Scripts]=$([[ -d "$OPAI_ROOT/scripts" ]] && echo 1 || echo 0)
existing[Tasks]=$([[ -f "$OPAI_ROOT/tasks/registry.json" ]] && echo 1 || echo 0)
existing[Queue]=$([[ -f "$OPAI_ROOT/tasks/queue.json" ]] && echo 1 || echo 0)
existing[Reports]=$([[ -d "$OPAI_ROOT/reports" ]] && echo 1 || echo 0)
existing[EmailEnv]=$([[ -f "$OPAI_ROOT/tools/email-checker/.env" ]] && echo 1 || echo 0)
existing[DiscordEnv]=$([[ -f "$OPAI_ROOT/tools/discord-bridge/.env" ]] && echo 1 || echo 0)
existing[WpMcpEnv]=$([[ -f "$OPAI_ROOT/mcps/Wordpress-VEC/.env" ]] && echo 1 || echo 0)
existing[BbMcpEnv]=$([[ -f "$OPAI_ROOT/mcps/boutabyte-mcp/.env" ]] && echo 1 || echo 0)

count=0
for key in "${!existing[@]}"; do
    [[ "${existing[$key]}" == "1" ]] && ((count++)) || true
done

echo "  Found $count existing components:"
for key in $(echo "${!existing[@]}" | tr ' ' '\n' | sort); do
    if [[ "${existing[$key]}" == "1" ]]; then
        echo "    [EXISTS]  $key"
    else
        echo "    [MISSING] $key"
    fi
done

if [[ $count -eq 0 ]]; then
    echo ""
    echo "  Fresh installation detected. No migration needed — just run preflight."
    echo "  ./scripts/preflight.ps1"
    echo ""
    exit 0
fi

# ── Step 2: Backup Instance Data ──

echo ""
echo "[2/8] Backing up instance data to $BACKUP_DIR..."

backup_file() {
    local src="$1"
    local rel="$2"
    local dest="$BACKUP_DIR/$rel"

    if [[ -e "$src" ]]; then
        echo "    $rel"
        if ! $DRY_RUN; then
            mkdir -p "$(dirname "$dest")"
            if [[ -d "$src" ]]; then
                cp -r "$src" "$dest"
            else
                cp "$src" "$dest"
            fi
        fi
    fi
}

ENV_FILES=(
    "tools/email-checker/.env"
    "tools/discord-bridge/.env"
    "mcps/Wordpress-VEC/.env"
    "mcps/boutabyte-mcp/.env"
)

for f in "${ENV_FILES[@]}"; do
    backup_file "$OPAI_ROOT/$f" "$f"
done

backup_file "$OPAI_ROOT/tasks/registry.json" "tasks/registry.json"
backup_file "$OPAI_ROOT/tasks/queue.json" "tasks/queue.json"
backup_file "$OPAI_ROOT/team.json" "team.json"

[[ -d "$OPAI_ROOT/reports" ]] && backup_file "$OPAI_ROOT/reports" "reports"

# ── Step 3: Merge team.json ──

echo ""
echo "[3/8] Merging team.json (preserving custom agents)..."

if [[ -f "$BACKUP_DIR/team.json" && -f "$OPAI_ROOT/team.json" ]]; then
    # Use python/node to do JSON merge if available
    if command -v python3 &>/dev/null; then
        python3 -c "
import json, sys

with open('$BACKUP_DIR/team.json') as f:
    old = json.load(f)
with open('$OPAI_ROOT/team.json') as f:
    new = json.load(f)

old_roles = set(old.get('roles', {}).keys())
new_roles = set(new.get('roles', {}).keys())
old_squads = set(old.get('squads', {}).keys())
new_squads = set(new.get('squads', {}).keys())

custom_roles = old_roles - new_roles
custom_squads = old_squads - new_squads
added_roles = new_roles - old_roles
added_squads = new_squads - old_squads

print(f'  Incoming roles: {len(new_roles)}, squads: {len(new_squads)}')

if custom_roles:
    print(f'  Custom roles to preserve: {', '.join(sorted(custom_roles))}')
    for r in custom_roles:
        new['roles'][r] = old['roles'][r]

if custom_squads:
    print(f'  Custom squads to preserve: {', '.join(sorted(custom_squads))}')
    for s in custom_squads:
        new['squads'][s] = old['squads'][s]

if added_roles:
    print(f'  New roles added: {', '.join(sorted(added_roles))}')
if added_squads:
    print(f'  New squads added: {', '.join(sorted(added_squads))}')

if custom_roles or custom_squads:
    if not $DRY_RUN:
        with open('$OPAI_ROOT/team.json', 'w') as f:
            json.dump(new, f, indent=2)
        print('  team.json merged successfully.')
    else:
        print('  [DRY RUN] Would merge team.json')
elif not added_roles and not added_squads:
    print('  No changes to team.json.')
" 2>/dev/null || echo "  Python not available — manual merge may be needed."
    else
        echo "  Python3 not found. Please manually check team.json for custom agents."
    fi
else
    echo "  No existing team.json to compare — using incoming version."
fi

# ── Step 4: Preserve Custom Prompts ──

echo ""
echo "[4/8] Checking for custom prompt files..."

if [[ -d "$BACKUP_DIR/scripts" ]]; then
    custom_count=0
    for old_prompt in "$BACKUP_DIR"/scripts/prompt_*.txt; do
        [[ ! -f "$old_prompt" ]] && continue
        name=$(basename "$old_prompt")
        if [[ ! -f "$OPAI_ROOT/scripts/$name" ]]; then
            echo "    + $name (preserved)"
            ((custom_count++)) || true
            if ! $DRY_RUN; then
                cp "$old_prompt" "$OPAI_ROOT/scripts/$name"
            fi
        fi
    done
    [[ $custom_count -eq 0 ]] && echo "  No custom prompts found."
else
    echo "  No backup scripts to compare — skipping."
fi

# ── Step 5: Runner Scripts ──

echo ""
echo "[5/8] Runner scripts updated via git pull (latest versions in place)."

runners=("run_squad.ps1" "run_agents.ps1" "run_agents_seq.ps1" "run_auto.ps1" "preflight.ps1" "familiarize.ps1" "process_queue.ps1" "onboard_project.ps1")
for runner in "${runners[@]}"; do
    if [[ -f "$OPAI_ROOT/scripts/$runner" ]]; then
        echo "    [OK]      $runner"
    else
        echo "    [MISSING] $runner"
    fi
done

# ── Step 6: Restore Instance Data ──

echo ""
echo "[6/8] Restoring instance data from backup..."

RESTORE_FILES=(
    "tools/email-checker/.env"
    "tools/discord-bridge/.env"
    "mcps/Wordpress-VEC/.env"
    "mcps/boutabyte-mcp/.env"
    "tasks/registry.json"
    "tasks/queue.json"
)

for item in "${RESTORE_FILES[@]}"; do
    backup_path="$BACKUP_DIR/$item"
    target_path="$OPAI_ROOT/$item"

    if [[ -f "$backup_path" ]]; then
        echo "    Restored: $item"
        if ! $DRY_RUN; then
            mkdir -p "$(dirname "$target_path")"
            cp "$backup_path" "$target_path"
        fi
    fi
done

# ── Step 7: Preflight ──

echo ""
echo "[7/8] Running preflight validation..."

if ! $DRY_RUN; then
    if [[ -f "$OPAI_ROOT/scripts/preflight.ps1" ]]; then
        if command -v pwsh &>/dev/null; then
            pwsh "$OPAI_ROOT/scripts/preflight.ps1" || echo "  Preflight had warnings."
        else
            echo "  PowerShell (pwsh) not found — skipping preflight."
            echo "  Install: https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-linux"
        fi
    else
        echo "  preflight.ps1 not found — skipping."
    fi
else
    echo "  [DRY RUN] Would run preflight.ps1"
fi

# ── Step 8: Summary ──

echo ""
echo "[8/8] Migration Summary"
echo "========================================"
echo "  Backup location: $BACKUP_DIR"
echo "  Components found: $count"

if $DRY_RUN; then
    echo ""
    echo "  [DRY RUN] No changes were made. Run without --dry-run to apply."
else
    echo ""
    echo "  Migration complete. Backup saved to:"
    echo "  $BACKUP_DIR"
fi

echo ""
echo "========================================"
echo ""
