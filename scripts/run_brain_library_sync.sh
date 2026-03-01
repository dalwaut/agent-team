#!/usr/bin/env bash
# Run the brain library_sync engine (direct Python, no Claude agent needed)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/.." && pwd)"
BRAIN_DIR="$WORKSPACE/tools/opai-brain"

# Load environment
if [[ -f "$BRAIN_DIR/.env" ]]; then
  set -a
  source "$BRAIN_DIR/.env"
  set +a
fi

echo "[library_sync] Starting library sync at $(date -Iseconds)"

cd "$BRAIN_DIR"
python3 -c "
import asyncio, sys, os
sys.path.insert(0, '.')
sys.path.insert(0, '../shared')
os.chdir('$BRAIN_DIR')

from dotenv import load_dotenv
load_dotenv()

from library_sync_engine import run_sync

async def main():
    result = await run_sync(dry_run=False)
    d = result.to_dict()
    print(f'[library_sync] Result: created={d[\"created\"]} updated={d[\"updated\"]} skipped={d[\"skipped\"]} failed={d[\"failed\"]} links={d[\"links\"]}')
    if d['errors']:
        for e in d['errors']:
            print(f'  ERROR: {e}')

asyncio.run(main())
"

echo "[library_sync] Finished at $(date -Iseconds)"
