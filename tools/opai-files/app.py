"""OPAI Files — Sandboxed file manager for user workspaces."""

import asyncio
import json
import mimetypes
import os
import resource
import shutil
import sys
import time
import uuid
from pathlib import Path

_start_time = time.time()

# Add shared modules to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from dotenv import load_dotenv

load_dotenv()

import config
import links
from auth import get_current_user, require_admin, AuthUser

import aiofiles
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(
    title="OPAI Files",
    version="1.0.0",
    description="Sandboxed file manager for user workspaces",
)


# ── Helpers ────────────────────────────────────────────────────


def _get_user_root(user: AuthUser) -> Path:
    """Get the filesystem root for a user.

    Admins get /workspace/synced/opai. Regular users get their sandbox_path.
    """
    if user.is_admin:
        return config.ADMIN_WORKSPACE_ROOT

    if not user.sandbox_path:
        raise HTTPException(
            status_code=403,
            detail="No sandbox configured for your account",
        )
    root = Path(user.sandbox_path)
    if not root.is_dir():
        raise HTTPException(
            status_code=503,
            detail="Sandbox directory not available",
        )
    return root


def _resolve_safe_path(user_root: Path, relative_path: str) -> Path:
    """Resolve a relative path safely within the user's root.

    Prevents path traversal via .., symlink escape, etc.
    """
    # Normalize: strip leading slashes, collapse dots
    clean = relative_path.lstrip("/").lstrip("\\")
    if not clean or clean == ".":
        return user_root

    target = (user_root / clean).resolve()
    root_resolved = user_root.resolve()

    if not (target == root_resolved or str(target).startswith(str(root_resolved) + os.sep)):
        raise HTTPException(status_code=403, detail="Access denied — path outside sandbox")

    return target


def _is_protected(relative_path: str) -> bool:
    """Check if a file is protected from editing/deletion."""
    clean = relative_path.lstrip("/").lstrip("\\")
    return clean in config.PROTECTED_FILES


def _is_binary(data: bytes) -> bool:
    """Check if data looks like binary content (has null bytes in first chunk)."""
    return b"\x00" in data[:config.BINARY_CHECK_BYTES]


def _file_info(path: Path, user_root: Path) -> dict:
    """Build file/directory metadata dict."""
    stat = path.stat()
    rel = str(path.relative_to(user_root))
    is_dir = path.is_dir()
    return {
        "name": path.name,
        "path": rel,
        "is_dir": is_dir,
        "size": 0 if is_dir else stat.st_size,
        "modified": stat.st_mtime,
        "mime": None if is_dir else (mimetypes.guess_type(path.name)[0] or "application/octet-stream"),
    }


# ── Health ─────────────────────────────────────────────────────


@app.get("/health")
def health():
    mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "status": "ok",
        "service": "opai-files",
        "version": "1.0.0",
        "uptime_seconds": int(time.time() - _start_time),
        "memory_mb": round(mem / 1024, 1),
    }


# ── File API ───────────────────────────────────────────────────


@app.get("/api/files/list")
async def list_dir(
    path: str = "",
    user: AuthUser = Depends(get_current_user),
):
    """List directory contents."""
    root = _get_user_root(user)
    target = _resolve_safe_path(root, path)

    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    items = []
    try:
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            # Skip hidden dot-directories at root level that aren't useful
            try:
                items.append(_file_info(entry, root))
            except (PermissionError, OSError):
                continue
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

    # Include current dir info
    return {
        "path": str(target.relative_to(root)) if target != root else "",
        "items": items,
        "total": len(items),
    }


@app.get("/api/files/read")
async def read_file(
    path: str,
    user: AuthUser = Depends(get_current_user),
):
    """Read text file content for editing."""
    root = _get_user_root(user)
    target = _resolve_safe_path(root, path)

    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    size = target.stat().st_size
    if size > config.MAX_EDIT_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"File too large for editor ({size} bytes). Use download instead.",
        )

    async with aiofiles.open(target, "rb") as f:
        raw = await f.read()

    if _is_binary(raw):
        raise HTTPException(
            status_code=415,
            detail="Binary file — use download instead",
        )

    # Try UTF-8, fall back to latin-1
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        content = raw.decode("latin-1")

    return {
        "path": str(target.relative_to(root)),
        "content": content,
        "size": size,
        "mime": mimetypes.guess_type(target.name)[0] or "text/plain",
        "protected": _is_protected(path),
    }


class WriteRequest(BaseModel):
    path: str
    content: str


@app.post("/api/files/write")
async def write_file(
    req: WriteRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Write/save text file content."""
    if _is_protected(req.path) and not user.is_admin:
        raise HTTPException(status_code=403, detail="This file is protected")

    root = _get_user_root(user)
    target = _resolve_safe_path(root, req.path)

    # Ensure parent directory exists
    target.parent.mkdir(parents=True, exist_ok=True)

    async with aiofiles.open(target, "w", encoding="utf-8") as f:
        await f.write(req.content)

    # Update link index if markdown file
    rel = str(target.relative_to(root))
    if rel.endswith('.md'):
        try:
            idx = links.get_index(root)
            idx.update_file(root, rel)
        except Exception:
            pass

    return {"ok": True, "path": rel, "size": len(req.content.encode("utf-8"))}


class MkdirRequest(BaseModel):
    path: str


@app.post("/api/files/mkdir")
async def mkdir(
    req: MkdirRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Create a directory."""
    root = _get_user_root(user)
    target = _resolve_safe_path(root, req.path)

    if target.exists():
        raise HTTPException(status_code=409, detail="Already exists")

    target.mkdir(parents=True, exist_ok=False)
    return {"ok": True, "path": str(target.relative_to(root))}


class DeleteRequest(BaseModel):
    path: str


@app.post("/api/files/delete")
async def delete_item(
    req: DeleteRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Delete a file or empty directory."""
    if _is_protected(req.path) and not user.is_admin:
        raise HTTPException(status_code=403, detail="This file is protected")

    root = _get_user_root(user)
    target = _resolve_safe_path(root, req.path)

    if not target.exists():
        raise HTTPException(status_code=404, detail="Not found")

    if target == root:
        raise HTTPException(status_code=403, detail="Cannot delete root directory")

    rel = str(target.relative_to(root))
    if target.is_dir():
        # Only delete empty directories for safety
        if any(target.iterdir()):
            raise HTTPException(status_code=409, detail="Directory not empty")
        target.rmdir()
    else:
        target.unlink()
        # Update link index
        if rel.endswith('.md'):
            try:
                idx = links.get_index(root)
                idx.remove_file(rel)
            except Exception:
                pass

    return {"ok": True, "path": rel}


class RenameRequest(BaseModel):
    path: str
    new_path: str


@app.post("/api/files/rename")
async def rename_item(
    req: RenameRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Rename/move a file or directory within sandbox."""
    if _is_protected(req.path) and not user.is_admin:
        raise HTTPException(status_code=403, detail="This file is protected")

    root = _get_user_root(user)
    source = _resolve_safe_path(root, req.path)
    dest = _resolve_safe_path(root, req.new_path)

    if not source.exists():
        raise HTTPException(status_code=404, detail="Source not found")
    if dest.exists():
        raise HTTPException(status_code=409, detail="Destination already exists")

    dest.parent.mkdir(parents=True, exist_ok=True)
    source.rename(dest)

    # Update link index for renames
    try:
        idx = links.get_index(root)
        old_rel = req.path
        new_rel = str(dest.relative_to(root))
        if old_rel.endswith('.md'):
            idx.remove_file(old_rel)
        if new_rel.endswith('.md'):
            idx.update_file(root, new_rel)
    except Exception:
        pass

    return {"ok": True, "old_path": req.path, "new_path": str(dest.relative_to(root))}


@app.post("/api/files/upload")
async def upload_files(
    path: str = "",
    files: list[UploadFile] = File(...),
    user: AuthUser = Depends(get_current_user),
):
    """Upload file(s) to a directory."""
    root = _get_user_root(user)
    target_dir = _resolve_safe_path(root, path)

    if not target_dir.is_dir():
        raise HTTPException(status_code=404, detail="Target directory not found")

    results = []
    for upload in files:
        dest = _resolve_safe_path(root, os.path.join(path, upload.filename))

        # Read with size limit
        data = await upload.read()
        if len(data) > config.MAX_UPLOAD_SIZE:
            results.append({"name": upload.filename, "ok": False, "error": "File too large"})
            continue

        async with aiofiles.open(dest, "wb") as f:
            await f.write(data)

        results.append({
            "name": upload.filename,
            "ok": True,
            "path": str(dest.relative_to(root)),
            "size": len(data),
        })

    return {"ok": True, "files": results}


@app.get("/api/files/download")
async def download_file(
    path: str,
    user: AuthUser = Depends(get_current_user),
):
    """Download a file (raw binary)."""
    root = _get_user_root(user)
    target = _resolve_safe_path(root, path)

    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(
        path=str(target),
        filename=target.name,
        media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream",
    )


@app.get("/api/files/info")
async def file_info(
    path: str = "",
    user: AuthUser = Depends(get_current_user),
):
    """Get file/directory metadata."""
    root = _get_user_root(user)
    target = _resolve_safe_path(root, path)

    if not target.exists():
        raise HTTPException(status_code=404, detail="Not found")

    info = _file_info(target, root)

    # Add extra info for directories
    if target.is_dir():
        try:
            children = list(target.iterdir())
            info["child_count"] = len(children)
            info["child_dirs"] = sum(1 for c in children if c.is_dir())
            info["child_files"] = sum(1 for c in children if c.is_file())
        except PermissionError:
            info["child_count"] = 0

    return info


@app.get("/api/files/search")
async def search_files(
    q: str = Query(..., min_length=1),
    path: str = "",
    user: AuthUser = Depends(get_current_user),
):
    """Search filenames within sandbox."""
    root = _get_user_root(user)
    search_root = _resolve_safe_path(root, path)

    if not search_root.is_dir():
        raise HTTPException(status_code=404, detail="Search root not found")

    query_lower = q.lower()
    results = []
    max_results = 100

    for item in search_root.rglob("*"):
        if query_lower in item.name.lower():
            try:
                results.append(_file_info(item, root))
            except (PermissionError, OSError):
                continue
            if len(results) >= max_results:
                break

    return {"query": q, "results": results, "total": len(results), "truncated": len(results) >= max_results}


# ── Copy ───────────────────────────────────────────────────────


class CopyRequest(BaseModel):
    source: str
    dest: str


@app.post("/api/files/copy")
async def copy_item(
    req: CopyRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Copy a file or directory within sandbox."""
    root = _get_user_root(user)
    src = _resolve_safe_path(root, req.source)
    dst = _resolve_safe_path(root, req.dest)

    if not src.exists():
        raise HTTPException(status_code=404, detail="Source not found")
    if dst.exists():
        raise HTTPException(status_code=409, detail="Destination already exists")

    dst.parent.mkdir(parents=True, exist_ok=True)

    if src.is_dir():
        shutil.copytree(str(src), str(dst))
    else:
        shutil.copy2(str(src), str(dst))

    return {"ok": True, "source": req.source, "dest": str(dst.relative_to(root))}


# ── AI Instruct ────────────────────────────────────────────────

# In-memory plan store (plan_id → {plan_text, abs_path, user_id, created})
_ai_plans: dict[str, dict] = {}


class AIInstructRequest(BaseModel):
    path: str
    instruction: str


class AIExecuteRequest(BaseModel):
    plan_id: str


async def _run_claude(prompt: str, cwd: str) -> str:
    """Run claude -p with a prompt, return output text.

    Pre-approves file operation tools so Claude can act without permission prompts.
    Safety is enforced by the prompt constraints + sandbox path isolation, not by
    tool permission gates.
    """
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)  # Strip to avoid nested session block

    proc = await asyncio.create_subprocess_exec(
        config.CLAUDE_CLI, "-p",
        "--output-format", "json",
        "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    stdout, stderr = await asyncio.wait_for(
        proc.communicate(input=prompt.encode("utf-8")),
        timeout=config.AI_TIMEOUT,
    )

    raw = stdout.decode("utf-8", errors="replace").strip()
    if not raw:
        err_text = stderr.decode("utf-8", errors="replace").strip()
        raise HTTPException(status_code=502, detail=f"Claude returned no output. stderr: {err_text[:500]}")

    # Parse JSON output — claude outputs JSON with a "result" field
    try:
        data = json.loads(raw)
        return data.get("result", raw)
    except json.JSONDecodeError:
        return raw


@app.post("/api/files/ai/plan")
async def ai_plan(
    req: AIInstructRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Generate an AI plan for a file/folder operation."""
    root = _get_user_root(user)
    target = _resolve_safe_path(root, req.path)

    if not target.exists():
        raise HTTPException(status_code=404, detail="Target not found")

    is_dir = target.is_dir()
    target_type = "directory" if is_dir else "file"
    abs_path = str(target)

    # Build context: for files, include content preview; for dirs, include listing
    context_lines = []
    if is_dir:
        try:
            entries = sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
            for entry in entries[:50]:
                prefix = "[DIR] " if entry.is_dir() else "      "
                context_lines.append(f"{prefix}{entry.name}")
            if len(list(target.iterdir())) > 50:
                context_lines.append(f"... and more items")
        except PermissionError:
            context_lines.append("(permission denied)")
    else:
        size = target.stat().st_size
        if size <= 100_000:
            try:
                content = target.read_text(encoding="utf-8", errors="replace")
                context_lines.append(f"--- File content ({size} bytes) ---")
                context_lines.append(content[:5000])
                if len(content) > 5000:
                    context_lines.append("... (truncated)")
            except Exception:
                context_lines.append("(could not read file)")
        else:
            context_lines.append(f"(large file: {size} bytes)")

    context_str = "\n".join(context_lines)

    prompt = f"""You are a file organization assistant. You are STRICTLY constrained to operating on the following {target_type}:

Path: {abs_path}

Your constraints:
- You may ONLY perform file/folder operations: rename, move, reorganize, rewrite content, create new files, delete files
- ALL operations MUST stay within: {str(root)}
- Do NOT access anything outside that root directory
- Do NOT run network commands, install packages, start servers, or execute arbitrary code
- Do NOT modify system files or configurations outside the target path

Current state of the target {target_type}:
{context_str}

User instruction: {req.instruction}

Create a detailed plan of exactly what changes you will make. For each step, specify:
1. The operation (create, rename, move, edit, delete)
2. The exact path(s) involved
3. For edits, a brief description of the content changes

Output ONLY the plan. Do NOT execute anything. Format as a numbered list."""

    try:
        plan_text = await _run_claude(prompt, str(root))
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="AI planning timed out")

    plan_id = str(uuid.uuid4())
    _ai_plans[plan_id] = {
        "plan_text": plan_text,
        "abs_path": abs_path,
        "root": str(root),
        "user_id": user.id,
        "instruction": req.instruction,
        "target_path": req.path,
        "created": time.time(),
    }

    # Clean up old plans (older than 30 min)
    cutoff = time.time() - 1800
    expired = [k for k, v in _ai_plans.items() if v["created"] < cutoff]
    for k in expired:
        del _ai_plans[k]

    return {"ok": True, "plan_id": plan_id, "plan": plan_text}


@app.post("/api/files/ai/execute")
async def ai_execute(
    req: AIExecuteRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Execute an approved AI plan."""
    plan = _ai_plans.get(req.plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found or expired")

    if plan["user_id"] != user.id:
        raise HTTPException(status_code=403, detail="Plan belongs to another user")

    prompt = f"""You are a file organization assistant. Execute the following plan.

Your constraints:
- ALL operations MUST stay within: {plan['root']}
- Do NOT access anything outside that root directory
- Do NOT run network commands, install packages, start servers, or execute arbitrary code
- Do NOT modify system files or configurations outside the scope of the plan
- Use only file operation tools (Read, Write, Edit, Bash with mv/cp/mkdir/rm only)

Target: {plan['abs_path']}
Original instruction: {plan['instruction']}

Plan to execute:
{plan['plan_text']}

Execute this plan now. Make all the changes. After completing, summarize what was done."""

    try:
        result = await _run_claude(prompt, plan["root"])
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="AI execution timed out")

    # Remove the used plan
    del _ai_plans[req.plan_id]

    return {"ok": True, "result": result}


# ── Link Index API ─────────────────────────────────────


@app.get("/api/links/backlinks")
async def get_backlinks(
    path: str,
    user: AuthUser = Depends(get_current_user),
):
    """Get files that link to the given file."""
    root = _get_user_root(user)
    _resolve_safe_path(root, path)  # Validate path
    idx = links.get_index(root)
    return {"path": path, "backlinks": idx.get_backlinks(path, root)}


@app.get("/api/links/forward")
async def get_forward_links(
    path: str,
    user: AuthUser = Depends(get_current_user),
):
    """Get wikilinks from the given file."""
    root = _get_user_root(user)
    _resolve_safe_path(root, path)
    idx = links.get_index(root)
    return {"path": path, "links": idx.get_forward_links(path)}


@app.get("/api/links/resolve")
async def resolve_wikilink(
    name: str,
    user: AuthUser = Depends(get_current_user),
):
    """Resolve a wikilink name to a file path."""
    root = _get_user_root(user)
    idx = links.get_index(root)
    resolved = idx.resolve_wikilink(name)
    return {"name": name, "path": resolved, "exists": resolved is not None}


@app.get("/api/links/graph")
async def get_graph_data(
    path: str = "",
    scope: str = "directory",
    depth: int = 2,
    user: AuthUser = Depends(get_current_user),
):
    """Get graph data (nodes + edges) for visualization."""
    root = _get_user_root(user)
    idx = links.get_index(root)
    data = idx.get_graph_data(root, scope, path, min(depth, 5))
    return data


@app.post("/api/links/rebuild")
async def rebuild_links(
    user: AuthUser = Depends(require_admin),
):
    """Force full rebuild of the link index (admin only)."""
    root = _get_user_root(user)
    idx = links.rebuild_index(root)
    return {"ok": True, "files_indexed": len(idx.files), "build_time": round(idx.build_time, 2)}


# ── Content Search & Names ─────────────────────────────


@app.get("/api/files/search-content")
async def search_content(
    q: str = Query(..., min_length=1),
    path: str = "",
    user: AuthUser = Depends(get_current_user),
):
    """Search file contents for a query string."""
    root = _get_user_root(user)
    idx = links.get_index(root)
    results = idx.search_content(root, q, path)
    return {"query": q, "results": results, "total": len(results)}


@app.get("/api/files/names")
async def get_all_filenames(
    user: AuthUser = Depends(get_current_user),
):
    """Get all indexed filenames for autocomplete/quick switcher."""
    root = _get_user_root(user)
    idx = links.get_index(root)
    return {"files": idx.get_all_filenames()}


# ── Static files & SPA ─────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(config.STATIC_DIR / "index.html"))


# ── Entry point ────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
