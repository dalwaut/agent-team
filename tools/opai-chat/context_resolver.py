"""OPAI Chat - Context resolver with path safety."""

import fnmatch
import json
from pathlib import Path
from typing import List, Dict, Any, Optional
import config


class ContextResolver:
    """Resolves and validates file paths, provides OPAI context."""
    
    def __init__(self):
        self.allowed_roots = config.ALLOWED_ROOTS
        self.blocked_patterns = config.BLOCKED_PATTERNS
    
    def is_path_allowed(self, path: Path) -> bool:
        """Check if a path is allowed for access."""
        try:
            # Resolve to absolute path
            abs_path = path.resolve()
            
            # Check if within allowed roots
            in_allowed_root = any(
                abs_path.is_relative_to(root) 
                for root in self.allowed_roots
            )
            
            if not in_allowed_root:
                return False
            
            # Check against blocked patterns.
            for pattern in self.blocked_patterns:
                if self._matches_blocked_pattern(abs_path, pattern):
                    return False
            
            return True
        except Exception:
            return False
    
    def _matches_blocked_pattern(self, abs_path: Path, pattern: str) -> bool:
        """Return True if abs_path should be blocked by the given pattern.

        Handles three pattern forms:
          "dir/**"        — block a directory and all its contents (recursive).
                            If the dir_prefix contains "/" it is treated as a
                            specific path relative to each allowed root; otherwise
                            it is treated as a directory *name* that may appear
                            anywhere in the path (e.g. node_modules, .git).
          "**/filename*"  — block any file whose name matches the suffix glob.
          "*.ext" / "name" — block by filename match only.
        """
        if pattern.endswith("/**"):
            dir_prefix = pattern[:-3]  # strip trailing /**
            if "/" in dir_prefix:
                # Specific path (e.g. "notes/Access"): check relative to every
                # allowed root so we don't need to hard-code OPAI_ROOT here.
                for root in self.allowed_roots:
                    try:
                        blocked_dir = (root / dir_prefix).resolve()
                        if abs_path == blocked_dir or abs_path.is_relative_to(blocked_dir):
                            return True
                    except Exception:
                        pass
            else:
                # Simple directory name (e.g. "node_modules", ".git"):
                # block if the name appears as ANY component in the path.
                if dir_prefix in abs_path.parts:
                    return True
            return False

        if pattern.startswith("**/"):
            # Recursive file pattern — match against the filename only.
            return fnmatch.fnmatch(abs_path.name, pattern[3:])

        # Simple filename / glob pattern (e.g. "*.pyc", ".env", ".DS_Store").
        return fnmatch.fnmatch(abs_path.name, pattern)

    def read_file(self, path: str) -> Optional[str]:
        """Read a file if path is allowed."""
        file_path = Path(path)
        
        if not self.is_path_allowed(file_path):
            raise PermissionError(f"Access denied: {path}")
        
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        
        if not file_path.is_file():
            raise ValueError(f"Not a file: {path}")
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return f.read()
        except UnicodeDecodeError:
            raise ValueError(f"Cannot read binary file: {path}")
    
    def list_directory(self, path: str) -> List[Dict[str, Any]]:
        """List directory contents if path is allowed."""
        dir_path = Path(path)
        
        if not self.is_path_allowed(dir_path):
            raise PermissionError(f"Access denied: {path}")
        
        if not dir_path.exists():
            raise FileNotFoundError(f"Directory not found: {path}")
        
        if not dir_path.is_dir():
            raise ValueError(f"Not a directory: {path}")
        
        items = []
        for item in sorted(dir_path.iterdir()):
            # Skip blocked items
            if not self.is_path_allowed(item):
                continue
            
            items.append({
                "name": item.name,
                "path": str(item),
                "is_dir": item.is_dir(),
                "size": item.stat().st_size if item.is_file() else None,
            })
        
        return items
    
    def search_files(self, query: str, root: str = None) -> List[str]:
        """Search for files by name."""
        if root is None:
            root = str(config.OPAI_ROOT)
        
        root_path = Path(root)
        
        if not self.is_path_allowed(root_path):
            raise PermissionError(f"Access denied: {root}")
        
        matches = []
        try:
            for item in root_path.rglob(f"*{query}*"):
                if self.is_path_allowed(item) and item.is_file():
                    matches.append(str(item))
                    if len(matches) >= 50:  # Limit results
                        break
        except Exception as e:
            print(f"Search error: {e}")
        
        return matches
    
    def get_opai_context(self) -> Dict[str, Any]:
        """Get OPAI system context (team, tasks, etc.)."""
        context = {}
        
        # Load team.json
        if config.TEAM_JSON.exists():
            try:
                with open(config.TEAM_JSON, 'r') as f:
                    context["team"] = json.load(f)
            except Exception as e:
                print(f"Error loading team.json: {e}")
        
        # Load queue.json
        if config.QUEUE_JSON.exists():
            try:
                with open(config.QUEUE_JSON, 'r') as f:
                    context["queue"] = json.load(f)
            except Exception as e:
                print(f"Error loading queue.json: {e}")
        
        # Load registry.json
        if config.REGISTRY_JSON.exists():
            try:
                with open(config.REGISTRY_JSON, 'r') as f:
                    context["registry"] = json.load(f)
            except Exception as e:
                print(f"Error loading registry.json: {e}")
        
        return context


# Global instance
resolver = ContextResolver()
