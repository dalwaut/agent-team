"""2nd Brain — Library Sync Engine.

Discovers files from configured workspace directories, generates AI summaries,
and syncs them into brain_nodes as "Library: <title>" entries.

No FastAPI dependency — can be called from routes or CLI.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

import config
from claude_cli import call_claude

log = logging.getLogger("brain.library_sync")

# ── Constants ────────────────────────────────────────────────────────────────

ALLOWED_EXTENSIONS = {".md", ".txt", ".json", ".docx", ".rtf"}
SKIP_DIRS = {"Archive", "__pycache__", ".git", "node_modules", "venv"}
SKIP_FILES = {"README.md"}
MAX_CONTENT_CHARS = 12_000
CLAUDE_DELAY_SECS = 2
PROMPT_FILE = config.WORKSPACE_ROOT / "scripts" / "prompt_library_sync.txt"


# ── Supabase helpers (same pattern as suggestions.py) ────────────────────────

def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers=_svc_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, body) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else rows


async def _sb_patch(path: str, params: str, body: dict) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.patch(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else {}


async def _sb_delete(path: str, params: str) -> None:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}?{params}"
    headers = {**_svc_headers(), "Prefer": "return=minimal"}
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.delete(url, headers=headers)
        r.raise_for_status()


# ── File reading helpers ─────────────────────────────────────────────────────

def _read_md_or_txt(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _read_json(path: Path) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        return json.dumps(data, indent=2)
    except Exception:
        return path.read_text(encoding="utf-8", errors="replace")


def _read_docx(path: Path) -> str:
    from docx import Document
    doc = Document(str(path))
    return "\n".join(p.text for p in doc.paragraphs if p.text.strip())


def _read_rtf(path: Path) -> str:
    from striprtf.striprtf import rtf_to_text
    raw = path.read_text(encoding="utf-8", errors="replace")
    return rtf_to_text(raw)


_READERS = {
    ".md": _read_md_or_txt,
    ".txt": _read_md_or_txt,
    ".json": _read_json,
    ".docx": _read_docx,
    ".rtf": _read_rtf,
}


def read_file_content(path: Path) -> Optional[str]:
    """Read file content using the appropriate reader. Returns None on failure."""
    reader = _READERS.get(path.suffix.lower())
    if not reader:
        return None
    try:
        content = reader(path)
        return content[:MAX_CONTENT_CHARS] if content else None
    except Exception as e:
        log.warning("Failed to read %s: %s", path, e)
        return None


# ── Discovery ────────────────────────────────────────────────────────────────

def _sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def discover_files() -> list[dict]:
    """Walk configured source directories and return file metadata."""
    files = []
    for rel_dir, base_tags in config.LIBRARY_SYNC_SOURCES.items():
        abs_dir = config.WORKSPACE_ROOT / rel_dir
        if not abs_dir.is_dir():
            log.warning("Source dir not found: %s", abs_dir)
            continue
        for path in sorted(abs_dir.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in ALLOWED_EXTENSIONS:
                continue
            if path.name in SKIP_FILES:
                continue
            if any(skip in path.parts for skip in SKIP_DIRS):
                continue
            # Build relative path from workspace root
            rel_path = str(path.relative_to(config.WORKSPACE_ROOT))
            content = read_file_content(path)
            if not content or len(content.strip()) < 50:
                continue  # Skip empty/stub files
            files.append({
                "path": rel_path,
                "abs_path": str(path),
                "name": path.stem,
                "extension": path.suffix.lower(),
                "dir": rel_dir,
                "base_tags": list(base_tags),
                "content": content,
                "hash": _sha256(content),
            })
    return files


# ── Summarization ────────────────────────────────────────────────────────────

def _load_prompt_template() -> str:
    if PROMPT_FILE.exists():
        return PROMPT_FILE.read_text(encoding="utf-8")
    # Fallback inline template
    return (
        "Summarize the following file into a structured brain node.\n\n"
        "FILE: {file_path}\n\nCONTENT:\n{content}\n\n"
        "Produce: Executive Summary, Key Concepts, Actionable Items, Related Topics.\n"
        "Last line: TAGS: tag1, tag2, tag3"
    )


async def summarize_file(file_path: str, content: str) -> tuple[str, list[str]]:
    """Call Claude to generate a summary. Returns (summary_text, extracted_tags)."""
    template = _load_prompt_template()
    prompt = template.replace("{file_path}", file_path).replace("{content}", content)

    raw = await call_claude(prompt, model=config.CLAUDE_MODEL, timeout=120)

    # Extract tags from TAGS: line
    tags = []
    for line in raw.split("\n"):
        if line.strip().upper().startswith("TAGS:"):
            tag_str = line.split(":", 1)[1].strip()
            tags = [t.strip().lower().replace(" ", "-") for t in tag_str.split(",") if t.strip()]
            break

    # Remove the TAGS line from summary
    summary_lines = [l for l in raw.split("\n") if not l.strip().upper().startswith("TAGS:")]
    summary = "\n".join(summary_lines).strip()

    return summary, tags


# ── Node CRUD ────────────────────────────────────────────────────────────────

async def _find_existing_node(sync_path: str) -> Optional[dict]:
    """Find an existing brain_node by sync_source_path in metadata."""
    rows = await _sb_get(
        "brain_nodes",
        f"user_id=eq.{config.ADMIN_USER_ID}"
        f"&metadata->>sync_source_path=eq.{sync_path}"
        f"&select=id,title,content,metadata",
    )
    return rows[0] if rows else None


async def _create_node(title: str, content: str, metadata: dict) -> dict:
    """Create a new brain_node."""
    now = datetime.now(timezone.utc).isoformat()
    return await _sb_post("brain_nodes", {
        "user_id": config.ADMIN_USER_ID,
        "title": title,
        "content": content,
        "type": "note",
        "metadata": metadata,
        "created_at": now,
        "updated_at": now,
    })


async def _update_node(node_id: str, content: str, metadata: dict) -> dict:
    """Update an existing brain_node."""
    now = datetime.now(timezone.utc).isoformat()
    return await _sb_patch(
        "brain_nodes",
        f"id=eq.{node_id}",
        {
            "content": content,
            "metadata": metadata,
            "updated_at": now,
        },
    )


# ── Tag Management ───────────────────────────────────────────────────────────

async def _sync_tags(node_id: str, tags: list[str]) -> None:
    """Replace tags for a node: delete existing, insert new."""
    # Delete existing tags for this node
    await _sb_delete("brain_tags", f"node_id=eq.{node_id}")
    if not tags:
        return
    # Insert new tags
    rows = [{"node_id": node_id, "tag": t} for t in tags]
    url = f"{config.SUPABASE_URL}/rest/v1/brain_tags"
    headers = {**_svc_headers(), "Prefer": "return=minimal"}
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url, headers=headers, json=rows)
        r.raise_for_status()


# ── Linking ──────────────────────────────────────────────────────────────────

async def _create_link(source_id: str, target_id: str, link_type: str, label: str) -> bool:
    """Create a brain_links row. Returns False if already exists."""
    try:
        await _sb_post("brain_links", {
            "user_id": config.ADMIN_USER_ID,
            "source_id": source_id,
            "target_id": target_id,
            "link_type": link_type,
            "strength": 0.6,
            "label": label,
            "created_by": "library_sync",
        })
        return True
    except Exception:
        return False  # Likely duplicate


async def _build_links(synced_nodes: list[dict]) -> int:
    """Build links between synced nodes. Returns count of links created."""
    if len(synced_nodes) < 2:
        return 0

    link_count = 0

    # Pass 1: Directory-sibling links (nodes from same source dir)
    by_dir: dict[str, list[dict]] = {}
    for node in synced_nodes:
        d = node.get("dir", "")
        by_dir.setdefault(d, []).append(node)

    for dir_name, nodes in by_dir.items():
        if len(nodes) < 2:
            continue
        # Star topology: link first node to all others in dir
        hub = nodes[0]
        for spoke in nodes[1:]:
            if await _create_link(hub["node_id"], spoke["node_id"], "sibling", f"Same dir: {dir_name}"):
                link_count += 1

    # Pass 2: Tag-overlap links (shared specific tags across directories)
    # Build tag → node map
    tag_nodes: dict[str, list[dict]] = {}
    for node in synced_nodes:
        for tag in node.get("tags", []):
            # Skip very generic base tags
            if tag in ("research", "plan", "idea", "personal"):
                continue
            tag_nodes.setdefault(tag, []).append(node)

    linked_pairs: set[tuple] = set()
    for tag, nodes in tag_nodes.items():
        if len(nodes) < 2:
            continue
        for i, a in enumerate(nodes):
            for b in nodes[i + 1:]:
                if a["dir"] == b["dir"]:
                    continue  # Already linked as siblings
                pair = tuple(sorted([a["node_id"], b["node_id"]]))
                if pair in linked_pairs:
                    continue
                linked_pairs.add(pair)
                if await _create_link(a["node_id"], b["node_id"], "tag_overlap", f"Shared tag: {tag}"):
                    link_count += 1

    return link_count


# ── Main Sync ────────────────────────────────────────────────────────────────

class SyncResult:
    def __init__(self):
        self.created = 0
        self.updated = 0
        self.skipped = 0
        self.failed = 0
        self.links = 0
        self.errors: list[str] = []
        self.files_found = 0

    def to_dict(self) -> dict:
        return {
            "files_found": self.files_found,
            "created": self.created,
            "updated": self.updated,
            "skipped": self.skipped,
            "failed": self.failed,
            "links": self.links,
            "errors": self.errors[:20],
        }


async def run_sync(dry_run: bool = False) -> SyncResult:
    """Execute the full library sync pipeline."""
    result = SyncResult()

    # 1. DISCOVER
    log.info("[library_sync] Discovering files...")
    files = discover_files()
    result.files_found = len(files)
    log.info("[library_sync] Found %d files to process", len(files))

    if dry_run:
        # In dry-run mode, check which would be created/updated/skipped
        for f in files:
            existing = await _find_existing_node(f["path"])
            if existing:
                old_hash = (existing.get("metadata") or {}).get("sync_hash", "")
                if old_hash == f["hash"]:
                    result.skipped += 1
                else:
                    result.updated += 1
            else:
                result.created += 1
        return result

    # 2. PROCESS — sequential with delay
    synced_nodes: list[dict] = []

    for i, f in enumerate(files):
        try:
            log.info("[library_sync] [%d/%d] Processing: %s", i + 1, len(files), f["path"])
            existing = await _find_existing_node(f["path"])

            if existing:
                old_hash = (existing.get("metadata") or {}).get("sync_hash", "")
                if old_hash == f["hash"]:
                    result.skipped += 1
                    # Still track for linking
                    synced_nodes.append({
                        "node_id": existing["id"],
                        "dir": f["dir"],
                        "tags": f["base_tags"],
                    })
                    continue

            # Summarize via Claude
            summary, ai_tags = await summarize_file(f["path"], f["content"])
            all_tags = list(set(f["base_tags"] + ai_tags))
            title = f"Library: {f['name'].replace('-', ' ').replace('_', ' ').title()}"

            metadata = {
                "sync_source_path": f["path"],
                "sync_hash": f["hash"],
                "sync_extension": f["extension"],
                "sync_dir": f["dir"],
                "synced_at": datetime.now(timezone.utc).isoformat(),
                "source": "library_sync",
            }

            if existing:
                # Update
                node = await _update_node(existing["id"], summary, metadata)
                node_id = existing["id"]
                await _sync_tags(node_id, all_tags)
                result.updated += 1
                log.info("[library_sync] Updated: %s", title)
            else:
                # Create
                node = await _create_node(title, summary, metadata)
                node_id = node.get("id", "")
                if node_id:
                    await _sync_tags(node_id, all_tags)
                result.created += 1
                log.info("[library_sync] Created: %s", title)

            synced_nodes.append({
                "node_id": node_id,
                "dir": f["dir"],
                "tags": all_tags,
            })

            # Rate-limit Claude calls
            if i < len(files) - 1:
                await asyncio.sleep(CLAUDE_DELAY_SECS)

        except Exception as e:
            result.failed += 1
            err_msg = f"{f['path']}: {e}"
            result.errors.append(err_msg)
            log.error("[library_sync] Failed: %s", err_msg)

    # 3. LINK
    log.info("[library_sync] Building links across %d nodes...", len(synced_nodes))
    result.links = await _build_links(synced_nodes)

    # 4. REPORT
    log.info(
        "[library_sync] Complete — created=%d updated=%d skipped=%d failed=%d links=%d",
        result.created, result.updated, result.skipped, result.failed, result.links,
    )
    return result
