#!/usr/bin/env python3
"""Build manifest.json from Library/opai-wiki/ markdown files.

Scans all subdirectories, extracts metadata from each .md file,
and writes tools/opai-docs/manifest.json for the static docs SPA.

Usage:
    python3 tools/opai-docs/build-manifest.py
"""

import json
import os
import re
from pathlib import Path

WIKI_ROOT = Path(__file__).resolve().parent.parent.parent / "Library" / "opai-wiki"
OUT_FILE = Path(__file__).resolve().parent / "manifest.json"

CATEGORIES = {
    "core": "Core",
    "tools": "Tools",
    "agents": "Agents",
    "integrations": "Integrations",
    "infra": "Infrastructure",
    "plans": "Plans",
}


def _strip_markdown(text: str) -> str:
    """Strip markdown formatting to produce plain searchable text."""
    # Remove code blocks
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"`[^`]+`", " ", text)
    # Remove images and links, keep text
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]+\)", r"\1", text)
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", " ", text)
    # Remove markdown emphasis
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"__(.+?)__", r"\1", text)
    text = re.sub(r"_(.+?)_", r"\1", text)
    # Remove headings markers, blockquotes, list markers, horizontal rules
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^>\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\d+\.\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^---+$", "", text, flags=re.MULTILINE)
    # Remove table formatting
    text = re.sub(r"\|", " ", text)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


def extract_metadata(filepath: Path, category: str) -> dict | None:
    """Extract title, description, sections, port, source, and search text from a markdown file."""
    text = filepath.read_text(encoding="utf-8", errors="replace")
    lines = text.split("\n")

    # H1 title
    title = None
    for line in lines:
        m = re.match(r"^#\s+(.+)", line)
        if m:
            title = m.group(1).strip()
            # Clean markdown formatting from title
            title = re.sub(r"\*\*(.+?)\*\*", r"\1", title)
            title = re.sub(r"`(.+?)`", r"\1", title)
            break

    if not title:
        # Fallback: derive from filename
        title = filepath.stem.replace("-", " ").replace("_", " ").title()

    # Description: first non-empty, non-heading, non-blockquote line
    description = ""
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#") or stripped.startswith(">"):
            continue
        if stripped.startswith("|") or stripped.startswith("---"):
            continue
        description = stripped[:200]
        break

    # H2 section headings
    sections = []
    for line in lines:
        m = re.match(r"^##\s+(.+)", line)
        if m:
            heading = m.group(1).strip()
            heading = re.sub(r"\*\*(.+?)\*\*", r"\1", heading)
            sections.append(heading)

    # Port number (e.g., "Port 8101" or "port: 8101")
    port = None
    port_match = re.search(r"[Pp]ort\s*:?\s*(\d{4,5})", text)
    if port_match:
        port = int(port_match.group(1))

    # Source tool (e.g., "tools/opai-brain")
    source = None
    source_match = re.search(r"tools/(opai-[\w-]+)", text)
    if source_match:
        source = source_match.group(1)

    # Last updated from blockquote metadata (e.g., "> Last updated: 2026-02-23")
    last_updated = None
    lu_match = re.search(r"[Ll]ast\s+[Uu]pdated?\s*:?\s*([\d-]+)", text)
    if lu_match:
        last_updated = lu_match.group(1)

    # Full-text search content (stripped markdown, capped at 2000 chars)
    search_text = _strip_markdown(text)[:2000]

    # Relative path from wiki root (e.g., "core/portal.md")
    rel_path = str(filepath.relative_to(WIKI_ROOT))

    return {
        "path": rel_path,
        "category": category,
        "title": title,
        "description": description,
        "sections": sections,
        "port": port,
        "source": source,
        "last_updated": last_updated,
        "search_text": search_text,
    }


def build_manifest():
    docs = []

    for dirname, cat_label in CATEGORIES.items():
        cat_dir = WIKI_ROOT / dirname
        if not cat_dir.is_dir():
            continue
        for md_file in sorted(cat_dir.glob("*.md")):
            meta = extract_metadata(md_file, dirname)
            if meta:
                docs.append(meta)

    # Also include root README if it exists
    readme = WIKI_ROOT / "README.md"
    if readme.exists():
        meta = extract_metadata(readme, "index")
        if meta:
            meta["title"] = "Wiki Index"
            docs.insert(0, meta)

    manifest = {
        "generated": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "wiki_root": "Library/opai-wiki",
        "count": len(docs),
        "categories": {k: v for k, v in CATEGORIES.items()},
        "docs": docs,
    }

    OUT_FILE.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(docs)} docs to {OUT_FILE}")


if __name__ == "__main__":
    build_manifest()
