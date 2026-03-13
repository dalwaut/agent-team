"""OPAI Engine — NotebookLM wiki sync background job.

Daily sync of Library/opai-wiki/ docs to a "OPAI System Knowledge" notebook.
Triggered by heartbeat (daily check). Compares file timestamps to sync state
and uploads new/changed .md files as text sources.
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("engine.bg.notebooklm_sync")

_SYNC_STATE_FILE = Path(__file__).parent.parent / "data" / "notebooklm-sync-state.json"
_WIKI_DIR = Path("/workspace/synced/opai/Library/opai-wiki")
_NOTEBOOK_TITLE = "OPAI System Knowledge"
_SYNC_INTERVAL = 86400  # 24 hours


def _load_sync_state() -> dict:
    """Load sync state tracking which files were uploaded and when."""
    try:
        if _SYNC_STATE_FILE.exists():
            return json.loads(_SYNC_STATE_FILE.read_text())
    except Exception:
        pass
    return {"notebook_id": None, "files": {}, "last_sync": None}


def _save_sync_state(state: dict):
    """Persist sync state."""
    try:
        _SYNC_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _SYNC_STATE_FILE.write_text(json.dumps(state, indent=2))
    except Exception as e:
        log.warning("[NLM-Sync] Failed to save state: %s", e)


def _get_wiki_files() -> list[Path]:
    """Walk wiki directory and return all .md files."""
    if not _WIKI_DIR.exists():
        return []
    return sorted(_WIKI_DIR.rglob("*.md"))


async def sync_wiki():
    """Sync wiki docs to NotebookLM. Returns stats dict."""
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
        from nlm import (
            is_available, get_client, ensure_notebook,
            add_source_text, NotebookLMError,
        )
    except ImportError:
        log.debug("[NLM-Sync] notebooklm module not available")
        return {"status": "skipped", "reason": "module not available"}

    if not is_available():
        log.debug("[NLM-Sync] NotebookLM not configured")
        return {"status": "skipped", "reason": "not configured"}

    state = _load_sync_state()
    wiki_files = _get_wiki_files()

    if not wiki_files:
        return {"status": "skipped", "reason": "no wiki files found"}

    # Determine which files need syncing
    files_to_sync = []
    for fp in wiki_files:
        rel_path = str(fp.relative_to(_WIKI_DIR))
        mtime = fp.stat().st_mtime
        prev_mtime = state["files"].get(rel_path, {}).get("mtime", 0)

        if mtime > prev_mtime:
            files_to_sync.append((fp, rel_path, mtime))

    if not files_to_sync:
        log.info("[NLM-Sync] All %d wiki files up to date", len(wiki_files))
        return {"status": "up_to_date", "total_files": len(wiki_files)}

    log.info("[NLM-Sync] %d/%d wiki files need syncing", len(files_to_sync), len(wiki_files))

    stats = {"synced": 0, "failed": 0, "total": len(files_to_sync)}

    try:
        client = await get_client()
        async with client:
            # Ensure notebook exists
            nb_id = state.get("notebook_id")
            nb_id = await ensure_notebook(client, _NOTEBOOK_TITLE, nb_id)
            state["notebook_id"] = nb_id

            # Upload changed files (rate-limit friendly: 2s between uploads)
            for fp, rel_path, mtime in files_to_sync:
                try:
                    content = fp.read_text(encoding="utf-8")
                    if not content.strip():
                        continue

                    # Use relative path as title for easy identification
                    title = rel_path.replace("/", " > ").replace(".md", "")
                    await add_source_text(client, nb_id, title, content)

                    state["files"][rel_path] = {
                        "mtime": mtime,
                        "synced_at": datetime.now(timezone.utc).isoformat(),
                        "size": len(content),
                    }
                    stats["synced"] += 1
                    log.debug("[NLM-Sync] Synced: %s", rel_path)

                    # Brief pause to avoid rate limits
                    await asyncio.sleep(2)

                except Exception as e:
                    stats["failed"] += 1
                    log.warning("[NLM-Sync] Failed to sync %s: %s", rel_path, e)

            state["last_sync"] = datetime.now(timezone.utc).isoformat()
            _save_sync_state(state)

    except NotebookLMError as e:
        log.error("[NLM-Sync] Client error: %s", e)
        stats["error"] = str(e)
    except Exception as e:
        log.error("[NLM-Sync] Unexpected error: %s", e)
        stats["error"] = str(e)

    log.info("[NLM-Sync] Done — synced %d, failed %d", stats["synced"], stats["failed"])
    return stats


async def sync_loop():
    """Background loop: check wiki sync daily."""
    await asyncio.sleep(300)  # 5 min startup delay
    while True:
        try:
            state = _load_sync_state()
            last = state.get("last_sync")

            # Check if sync is due
            should_sync = True
            if last:
                try:
                    last_dt = datetime.fromisoformat(last)
                    elapsed = (datetime.now(timezone.utc) - last_dt).total_seconds()
                    should_sync = elapsed >= _SYNC_INTERVAL
                except Exception:
                    pass

            if should_sync:
                await sync_wiki()

        except Exception as e:
            log.error("[NLM-Sync] Loop error: %s", e)

        await asyncio.sleep(3600)  # Check every hour
