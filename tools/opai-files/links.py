"""OPAI Files — Wikilink index engine.

Scans markdown files for [[wikilinks]], builds an in-memory index for
O(1) resolution, backlink lookup, and graph data generation.
"""

import re
import time
from pathlib import Path
from typing import Optional

# Regex for [[target]] or [[target|alias]]
WIKILINK_RE = re.compile(r'\[\[([^\]|]+)(?:\|([^\]]+))?\]\]')


class LinkIndex:
    """In-memory wikilink index for a single user root."""

    def __init__(self):
        # rel_path (str) -> set of wikilink target names (lowercase)
        self.forward: dict[str, set[str]] = {}
        # rel_path -> list of raw wikilink names (original case, with aliases)
        self.forward_raw: dict[str, list[dict]] = {}
        # lowercase filename stem -> set of rel_paths that have that stem
        self.name_to_paths: dict[str, set[str]] = {}
        # All indexed file paths
        self.files: set[str] = set()
        self.built = False
        self.build_time = 0.0

    def build(self, root: Path):
        """Full scan of all .md files under root."""
        start = time.time()
        self.forward.clear()
        self.forward_raw.clear()
        self.name_to_paths.clear()
        self.files.clear()

        for md_file in root.rglob('*.md'):
            try:
                rel = str(md_file.relative_to(root))
                self._index_file(root, rel, md_file)
            except (PermissionError, OSError):
                continue

        self.built = True
        self.build_time = time.time() - start

    def _index_file(self, root: Path, rel_path: str, abs_path: Path):
        """Index a single file."""
        self.files.add(rel_path)

        # Register filename stem for resolution
        stem = abs_path.stem.lower()
        if stem not in self.name_to_paths:
            self.name_to_paths[stem] = set()
        self.name_to_paths[stem].add(rel_path)

        # Extract wikilinks
        try:
            content = abs_path.read_text(encoding='utf-8', errors='replace')
        except (PermissionError, OSError):
            return

        targets = set()
        raw_links = []
        for m in WIKILINK_RE.finditer(content):
            target_name = m.group(1).strip()
            alias = m.group(2)
            targets.add(target_name.lower())
            raw_links.append({
                'target': target_name,
                'alias': alias.strip() if alias else None,
            })

        self.forward[rel_path] = targets
        self.forward_raw[rel_path] = raw_links

    def update_file(self, root: Path, rel_path: str):
        """Re-index a single file after write."""
        abs_path = root / rel_path
        if not abs_path.exists() or not rel_path.endswith('.md'):
            return

        # Remove old data
        self.remove_file(rel_path)
        # Re-index
        self._index_file(root, rel_path, abs_path)

    def remove_file(self, rel_path: str):
        """Remove a file from the index."""
        self.files.discard(rel_path)
        self.forward.pop(rel_path, None)
        self.forward_raw.pop(rel_path, None)

        # Remove from name_to_paths
        stem = Path(rel_path).stem.lower()
        if stem in self.name_to_paths:
            self.name_to_paths[stem].discard(rel_path)
            if not self.name_to_paths[stem]:
                del self.name_to_paths[stem]

    def resolve_wikilink(self, name: str) -> Optional[str]:
        """Resolve a wikilink name to a file path.

        Tries exact stem match first, then substring.
        Returns the rel_path or None.
        """
        key = name.lower().strip()

        # Try exact stem match
        if key in self.name_to_paths:
            paths = self.name_to_paths[key]
            if paths:
                # Prefer shortest path (least nested)
                return min(paths, key=lambda p: p.count('/'))

        # Try with .md extension stripped if given
        if key.endswith('.md'):
            key = key[:-3]
            if key in self.name_to_paths:
                paths = self.name_to_paths[key]
                if paths:
                    return min(paths, key=lambda p: p.count('/'))

        # Try path-based resolution (e.g., "folder/file")
        for f in self.files:
            if f.lower() == key or f.lower() == key + '.md':
                return f

        return None

    def get_backlinks(self, rel_path: str, root: Optional[Path] = None) -> list[dict]:
        """Get files that link TO this file, with context snippets."""
        stem = Path(rel_path).stem.lower()
        results = []

        for src_path, targets in self.forward.items():
            if src_path == rel_path:
                continue
            if stem in targets:
                entry = {
                    'path': src_path,
                    'name': Path(src_path).name,
                    'context': None,
                }
                # Get context snippet
                if root:
                    try:
                        content = (root / src_path).read_text(encoding='utf-8', errors='replace')
                        for line in content.split('\n'):
                            if WIKILINK_RE.search(line):
                                # Check if this line references our file
                                for m in WIKILINK_RE.finditer(line):
                                    if m.group(1).strip().lower() == stem:
                                        entry['context'] = line.strip()[:200]
                                        break
                            if entry['context']:
                                break
                    except (PermissionError, OSError):
                        pass
                results.append(entry)

        return sorted(results, key=lambda r: r['name'].lower())

    def get_forward_links(self, rel_path: str) -> list[dict]:
        """Get files this file links TO."""
        raw = self.forward_raw.get(rel_path, [])
        results = []
        seen = set()

        for link in raw:
            target = link['target']
            if target.lower() in seen:
                continue
            seen.add(target.lower())

            resolved = self.resolve_wikilink(target)
            results.append({
                'target': target,
                'alias': link['alias'],
                'resolved_path': resolved,
                'exists': resolved is not None,
            })

        return results

    def get_graph_data(self, root: Path, scope: str = 'all',
                       center_path: str = '', depth: int = 2) -> dict:
        """Generate graph data with directory structure + wikilink edges.

        Scopes:
          'directory' — files in center_path dir + 1 level of subdirs
          'local'     — BFS from center_path file via wikilinks + siblings
          'all'       — everything (capped at 500 nodes)

        Returns nodes (files + folders) and edges (contains + links).
        """
        node_map: dict[str, dict] = {}   # id -> node dict
        edges: list[dict] = []
        edge_set: set[tuple] = set()     # dedup

        def add_node(node_id: str, label: str, group: str,
                     is_dir: bool = False, is_center: bool = False):
            if node_id in node_map:
                if is_center:
                    node_map[node_id]['is_center'] = True
                return
            node_map[node_id] = {
                'id': node_id,
                'label': label,
                'group': group,
                'is_dir': is_dir,
                'is_center': is_center,
                'link_count': 0,
            }

        def add_edge(src: str, tgt: str, edge_type: str):
            key = (src, tgt, edge_type)
            if key in edge_set or src == tgt:
                return
            if src not in node_map or tgt not in node_map:
                return
            edge_set.add(key)
            edges.append({'source': src, 'target': tgt, 'type': edge_type})

        def top_group(path: str) -> str:
            return path.split('/')[0] if '/' in path else ''

        def add_dir_node(dir_path: str):
            label = Path(dir_path).name if dir_path else '(root)'
            add_node('dir:' + dir_path, label, top_group(dir_path), is_dir=True)

        def add_file_with_parent(f: str, is_center: bool = False):
            """Add a file node and its parent folder node + containment edge."""
            add_node(f, Path(f).stem, top_group(f), is_center=is_center)
            parent = str(Path(f).parent) if '/' in f else ''
            add_dir_node(parent)
            add_edge('dir:' + parent, f, 'contains')

        def add_wikilink_edges_for(f: str):
            """Add wikilink edges from file f to resolved targets."""
            for target_name in self.forward.get(f, set()):
                resolved = self.resolve_wikilink(target_name)
                if resolved and resolved != f:
                    add_file_with_parent(resolved)
                    add_edge(f, resolved, 'link')
                    node_map[f]['link_count'] = node_map[f].get('link_count', 0) + 1
                    node_map[resolved]['link_count'] = node_map[resolved].get('link_count', 0) + 1

        def add_backlink_edges_for(f: str):
            """Add edges from files that link TO f."""
            stem = Path(f).stem.lower()
            for src, targets in self.forward.items():
                if stem in targets and src != f:
                    add_file_with_parent(src)
                    add_edge(src, f, 'link')

        # ── Scope: directory ──────────────────────────────
        if scope == 'directory':
            dir_path = center_path or ''
            add_dir_node(dir_path)
            node_map['dir:' + dir_path]['is_center'] = True

            # Collect files up to the requested depth
            prefix = (dir_path + '/') if dir_path else ''
            dirs_seen = set()  # track all directory nodes we've added

            for f in self.files:
                if not f.startswith(prefix) and prefix:
                    continue
                rel_to_dir = f[len(prefix):]
                parts = rel_to_dir.split('/')
                file_depth = len(parts)  # 1 = direct child, 2 = one subdir deep, etc.

                if file_depth <= depth:
                    # Add the file and all intermediate directories
                    add_file_with_parent(f)
                    add_wikilink_edges_for(f)

                    # Build the directory chain from center down to file's parent
                    for level in range(1, file_depth):
                        subdir = prefix + '/'.join(parts[:level])
                        if subdir not in dirs_seen:
                            dirs_seen.add(subdir)
                            add_dir_node(subdir)
                            # Connect to its parent directory
                            if level == 1:
                                add_edge('dir:' + dir_path, 'dir:' + subdir, 'contains')
                            else:
                                parent_dir = prefix + '/'.join(parts[:level - 1])
                                add_edge('dir:' + parent_dir, 'dir:' + subdir, 'contains')
                else:
                    # Beyond depth — add collapsed directory at depth boundary
                    if depth >= 1 and len(parts) > 0:
                        subdir = prefix + parts[0]
                        if subdir not in dirs_seen:
                            dirs_seen.add(subdir)
                            add_dir_node(subdir)
                            add_edge('dir:' + dir_path, 'dir:' + subdir, 'contains')

                if len(node_map) >= 500:
                    break

        # ── Scope: local (BFS from a file) ────────────────
        elif scope == 'local' and center_path and center_path in self.files:
            # Start from the file, expand via wikilinks + siblings
            add_file_with_parent(center_path, is_center=True)

            # Add siblings (files in same directory)
            parent = str(Path(center_path).parent) if '/' in center_path else ''
            prefix = (parent + '/') if parent else ''
            for f in self.files:
                if f == center_path:
                    continue
                if not prefix and '/' not in f:
                    add_file_with_parent(f)
                elif prefix and f.startswith(prefix) and '/' not in f[len(prefix):]:
                    add_file_with_parent(f)

            # BFS via wikilinks
            visited = {center_path}
            queue = [(center_path, 0)]
            while queue:
                current, d = queue.pop(0)
                add_wikilink_edges_for(current)
                if d < depth:
                    add_backlink_edges_for(current)
                if d >= depth:
                    continue
                # Expand forward links
                for target_name in self.forward.get(current, set()):
                    resolved = self.resolve_wikilink(target_name)
                    if resolved and resolved not in visited:
                        visited.add(resolved)
                        queue.append((resolved, d + 1))
                # Expand backlinks
                stem = Path(current).stem.lower()
                for src, targets in self.forward.items():
                    if stem in targets and src not in visited:
                        visited.add(src)
                        queue.append((src, d + 1))
                if len(node_map) >= 500:
                    break

        # ── Scope: all ────────────────────────────────────
        else:
            # Build from directory tree: top-level dirs + their children
            top_dirs = set()
            for f in self.files:
                top = f.split('/')[0] if '/' in f else ''
                top_dirs.add(top)

            # Add root
            add_dir_node('')
            if center_path:
                if center_path in self.files:
                    node_map.get(center_path, {})
                    add_file_with_parent(center_path, is_center=True)

            for td in sorted(top_dirs):
                if td:
                    add_dir_node(td)
                    add_edge('dir:', 'dir:' + td, 'contains')

            for f in sorted(self.files):
                add_file_with_parent(f)
                if len(node_map) >= 500:
                    break

            # Add wikilink edges for all included files
            for f in list(node_map.keys()):
                if not f.startswith('dir:'):
                    add_wikilink_edges_for(f)

        nodes = list(node_map.values())
        return {'nodes': nodes, 'edges': edges}

    def get_all_filenames(self) -> list[dict]:
        """Return all indexed filenames for autocomplete."""
        return [
            {'name': Path(f).name, 'stem': Path(f).stem, 'path': f}
            for f in sorted(self.files)
        ]

    def search_content(self, root: Path, query: str, search_path: str = '') -> list[dict]:
        """Search file contents for a query string."""
        query_lower = query.lower()
        results = []

        search_root = root / search_path if search_path else root

        for f in sorted(self.files):
            abs_path = root / f
            if not str(abs_path).startswith(str(search_root)):
                continue

            try:
                content = abs_path.read_text(encoding='utf-8', errors='replace')
            except (PermissionError, OSError):
                continue

            if query_lower not in content.lower():
                continue

            # Find matching lines with context
            lines = content.split('\n')
            matches = []
            for i, line in enumerate(lines):
                if query_lower in line.lower():
                    matches.append({
                        'line': i + 1,
                        'text': line.strip()[:200],
                    })
                    if len(matches) >= 3:
                        break

            results.append({
                'path': f,
                'name': Path(f).name,
                'matches': matches,
            })

            if len(results) >= 100:
                break

        return results


# Per-root index cache
_indexes: dict[str, LinkIndex] = {}


def get_index(root: Path) -> LinkIndex:
    """Get or create a link index for a user root. Builds lazily on first access."""
    key = str(root)
    if key not in _indexes:
        _indexes[key] = LinkIndex()
    idx = _indexes[key]
    if not idx.built:
        idx.build(root)
    return idx


def rebuild_index(root: Path) -> LinkIndex:
    """Force full rebuild of the index for a root."""
    key = str(root)
    _indexes[key] = LinkIndex()
    _indexes[key].build(root)
    return _indexes[key]
