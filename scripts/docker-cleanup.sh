#!/bin/bash
#
# OPAI Docker Cleanup — Prune dangling images and exited containers.
#
# Runs daily via systemd timer. Safe to run anytime.
# Preserves: running containers, tagged images in use, Supabase stack, n8n.
#
# Usage:
#   ./scripts/docker-cleanup.sh           # Normal run
#   ./scripts/docker-cleanup.sh --dry-run # Preview only
#

set -euo pipefail

LOG_PREFIX="[docker-cleanup]"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "$LOG_PREFIX DRY RUN — no changes will be made"
fi

# ── Remove exited containers (except Supabase and n8n) ──
echo "$LOG_PREFIX Checking for exited containers..."
EXITED=$(docker ps -a --filter "status=exited" --format '{{.ID}} {{.Names}}')

if [[ -z "$EXITED" ]]; then
    echo "$LOG_PREFIX No exited containers found"
else
    while IFS= read -r line; do
        CID=$(echo "$line" | awk '{print $1}')
        CNAME=$(echo "$line" | awk '{print $2}')

        # Skip Supabase and n8n containers — they may restart on their own
        if [[ "$CNAME" == supabase_* ]] || [[ "$CNAME" == n8n* ]]; then
            echo "$LOG_PREFIX Skipping protected container: $CNAME"
            continue
        fi

        if $DRY_RUN; then
            echo "$LOG_PREFIX [DRY] Would remove container: $CNAME ($CID)"
        else
            echo "$LOG_PREFIX Removing container: $CNAME ($CID)"
            docker rm "$CID" 2>/dev/null || true
        fi
    done <<< "$EXITED"
fi

# ── Remove dangling images (<none> tags) ──
echo "$LOG_PREFIX Checking for dangling images..."
DANGLING=$(docker images -f "dangling=true" -q)

if [[ -z "$DANGLING" ]]; then
    echo "$LOG_PREFIX No dangling images found"
else
    COUNT=$(echo "$DANGLING" | wc -l)
    if $DRY_RUN; then
        echo "$LOG_PREFIX [DRY] Would remove $COUNT dangling image(s)"
        docker images -f "dangling=true" --format '  {{.ID}} {{.Size}} (created {{.CreatedSince}})'
    else
        echo "$LOG_PREFIX Removing $COUNT dangling image(s)..."
        docker image prune -f
    fi
fi

# ── Remove unused build cache ──
CACHE_SIZE=$(docker system df --format '{{.Size}}' 2>/dev/null | tail -1)
if $DRY_RUN; then
    echo "$LOG_PREFIX [DRY] Build cache size: $CACHE_SIZE"
else
    docker builder prune -f 2>/dev/null || true
fi

# ── Summary ──
echo "$LOG_PREFIX Cleanup complete. Current disk usage:"
docker system df
