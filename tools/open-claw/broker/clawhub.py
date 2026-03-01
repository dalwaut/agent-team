"""ClawHub Marketplace — Skill catalog sync, dual-target install, compatibility assessment.

Syncs skill catalog from ClawHub (API, GitHub, or local seed), stores in Supabase (ch_skills).
Installs skills to OC instances (file copy) or Claude Code (skill migration).
"""

import json
import shutil
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

import httpx

import config

# ── Paths ─────────────────────────────────────────────────

OPAI_ROOT = Path("/workspace/synced/opai")
CLAUDE_COMMANDS_DIR = OPAI_ROOT / ".claude" / "commands"
KNOWLEDGE_DIR = OPAI_ROOT / "Library" / "knowledge" / "clawhub"
INSTANCES_DIR = config.INSTANCES_DIR

# ClawHub catalog source — swap between options as needed
# Option A: REST API (when available)
# CATALOG_URL = "https://api.clawhub.io/v1/skills"
# Option B: GitHub raw JSON
# CATALOG_URL = "https://raw.githubusercontent.com/OpenClaw/clawhub-catalog/main/catalog.json"
# Option C: Local seed file (current default — no public API confirmed yet)
CATALOG_URL = None
LOCAL_SEED_FILE = config.BROKER_DIR / "data" / "clawhub-seed.json"


def _headers() -> dict:
    """Supabase REST headers with service key."""
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _rest_url(table: str) -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Compatibility Assessment ──────────────────────────────

def assess_compatibility(files: list[dict]) -> str:
    """Determine Claude Code compatibility for a skill.

    Returns: 'full', 'partial', or 'oc_only'

    Rules:
    - prompt + knowledge only → full
    - has config but no complex tool defs → full
    - has simple tool definitions (HTTP wrappers) → partial
    - has complex tool definitions or runtime dependencies → oc_only
    """
    file_types = set(f.get("type", "unknown") for f in files)

    # Pure prompt/knowledge skills migrate cleanly
    if file_types <= {"prompt", "knowledge", "config"}:
        return "full"

    # Has tool definitions — check complexity
    if "tool" in file_types:
        for f in files:
            if f.get("type") != "tool":
                continue
            content = f.get("content", "")
            # Complex tools: require runtime, have imports, use APIs directly
            if any(kw in content.lower() for kw in [
                "import ", "require(", "class ", "async def ",
                "openclaw_runtime", "claw.execute",
            ]):
                return "oc_only"
        return "partial"

    return "oc_only"


# ── Catalog Operations ────────────────────────────────────

async def sync_catalog() -> dict:
    """Sync skill catalog from source into ch_skills table.

    Returns: {synced: int, errors: int, source: str}
    """
    skills = await _fetch_catalog()
    if not skills:
        return {"synced": 0, "errors": 0, "source": "none"}

    synced = 0
    errors = 0
    now = datetime.now(timezone.utc).isoformat()

    async with httpx.AsyncClient(timeout=15) as client:
        for skill in skills:
            # Assess compatibility
            files = skill.get("files", [])
            compat = assess_compatibility(files)

            row = {
                "slug": skill["slug"],
                "name": skill["name"],
                "description": skill.get("description", ""),
                "category": skill.get("category", "general"),
                "tags": skill.get("tags", []),
                "author": skill.get("author", "unknown"),
                "version": skill.get("version", "1.0.0"),
                "install_count": skill.get("install_count", 0),
                "rating": skill.get("rating"),
                "files": json.dumps(files),
                "required_vault_keys": skill.get("required_vault_keys", []),
                "opai_verified": skill.get("opai_verified", False),
                "claude_compat": compat,
                "source_url": skill.get("source_url", ""),
                "remote_id": skill.get("id", ""),
                "synced_at": now,
            }

            # Upsert by slug
            resp = await client.post(
                _rest_url("ch_skills"),
                headers={**_headers(), "Prefer": "return=representation,resolution=merge-duplicates"},
                json=row,
                params={"on_conflict": "slug"},
            )
            if resp.status_code in (200, 201):
                synced += 1
            else:
                errors += 1
                print(f"[clawhub] sync error for {skill['slug']}: {resp.status_code} {resp.text[:200]}")

    source = "api" if CATALOG_URL else "local_seed"
    return {"synced": synced, "errors": errors, "source": source}


async def _fetch_catalog() -> list[dict]:
    """Fetch catalog from configured source."""
    if CATALOG_URL:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(CATALOG_URL)
                if resp.status_code == 200:
                    data = resp.json()
                    # Handle both { "skills": [...] } and plain [...]
                    return data.get("skills", data) if isinstance(data, dict) else data
        except Exception as e:
            print(f"[clawhub] Failed to fetch catalog from {CATALOG_URL}: {e}")
            return []

    # Fallback: local seed file
    if LOCAL_SEED_FILE.is_file():
        try:
            data = json.loads(LOCAL_SEED_FILE.read_text())
            return data.get("skills", data) if isinstance(data, dict) else data
        except Exception as e:
            print(f"[clawhub] Failed to load seed file: {e}")

    return []


async def list_skills(
    category: str = None,
    search: str = None,
    claude_compat: str = None,
    limit: int = 50,
) -> list[dict]:
    """List skills from the cached catalog."""
    params = {"select": "*", "order": "install_count.desc", "limit": str(limit)}

    if category:
        params["category"] = f"eq.{category}"
    if claude_compat:
        params["claude_compat"] = f"eq.{claude_compat}"
    if search:
        params["or"] = f"(name.ilike.%{search}%,description.ilike.%{search}%,slug.ilike.%{search}%)"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(_rest_url("ch_skills"), params=params, headers=_headers())
        if resp.status_code == 200:
            skills = resp.json()
            # Parse files JSON string back to list
            for s in skills:
                if isinstance(s.get("files"), str):
                    try:
                        s["files"] = json.loads(s["files"])
                    except (json.JSONDecodeError, TypeError):
                        s["files"] = []
            return skills
    return []


async def get_skill(slug: str) -> Optional[dict]:
    """Get a single skill by slug."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _rest_url("ch_skills"),
            params={"slug": f"eq.{slug}", "select": "*"},
            headers=_headers(),
        )
        if resp.status_code == 200:
            rows = resp.json()
            if rows:
                s = rows[0]
                if isinstance(s.get("files"), str):
                    try:
                        s["files"] = json.loads(s["files"])
                    except (json.JSONDecodeError, TypeError):
                        s["files"] = []
                return s
    return None


# ── Installation ──────────────────────────────────────────

async def install_skill(
    slug: str,
    target_type: str,
    instance_slug: str = None,
    installed_by: str = None,
) -> dict:
    """Install a skill to an OC instance or Claude Code.

    target_type: 'oc_instance' or 'claude_code'
    instance_slug: required if target_type is 'oc_instance'
    """
    skill = await get_skill(slug)
    if not skill:
        return {"error": f"Skill '{slug}' not found"}

    if target_type == "oc_instance":
        if not instance_slug:
            return {"error": "instance_slug required for oc_instance target"}
        result = await _install_to_instance(skill, instance_slug)
    elif target_type == "claude_code":
        if skill["claude_compat"] == "oc_only":
            return {"error": f"Skill '{slug}' is OC-only and cannot be installed to Claude Code"}
        result = await _install_to_claude(skill)
    else:
        return {"error": f"Invalid target_type: {target_type}"}

    if "error" in result:
        return result

    # Record installation in DB
    instance_id = None
    if target_type == "oc_instance" and instance_slug:
        # Look up instance UUID
        from manifest import get_instance
        inst = await get_instance(instance_slug)
        if inst:
            instance_id = inst["id"]

    row = {
        "skill_slug": slug,
        "target_type": target_type,
        "instance_id": instance_id,
        "installed_by": installed_by,
        "status": "installed",
    }

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _rest_url("ch_installations"),
            headers={**_headers(), "Prefer": "return=representation,resolution=merge-duplicates"},
            json=row,
            params={"on_conflict": "skill_slug,target_type,instance_id"},
        )
        if resp.status_code not in (200, 201):
            print(f"[clawhub] install record error: {resp.status_code} {resp.text[:200]}")

    return {**result, "skill": slug, "target": target_type}


async def _install_to_instance(skill: dict, instance_slug: str) -> dict:
    """Install skill files to an OC instance directory."""
    inst_dir = INSTANCES_DIR / instance_slug
    if not inst_dir.is_dir():
        return {"error": f"Instance directory not found: {instance_slug}"}

    files_written = []
    for f in skill.get("files", []):
        ftype = f.get("type", "knowledge")
        fname = f.get("name", f"skill-{skill['slug']}.txt")
        content = f.get("content", "")

        if ftype == "prompt":
            target_dir = inst_dir / "prompts"
        elif ftype == "knowledge":
            target_dir = inst_dir / "knowledge"
        elif ftype == "config":
            target_dir = inst_dir / "config"
        else:
            target_dir = inst_dir / "skills"

        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / fname
        target_path.write_text(content)
        files_written.append(str(target_path.relative_to(INSTANCES_DIR)))

    warnings = []
    if skill.get("required_vault_keys"):
        warnings.append(f"Skill requires vault keys: {', '.join(skill['required_vault_keys'])}. Grant them via the Instances tab.")
    warnings.append("Changes take effect on next container restart.")

    return {
        "status": "installed",
        "files_written": files_written,
        "warnings": warnings,
    }


async def _install_to_claude(skill: dict) -> dict:
    """Migrate skill files to Claude Code locations."""
    files_written = []
    warnings = []

    for f in skill.get("files", []):
        ftype = f.get("type", "knowledge")
        fname = f.get("name", f"{skill['slug']}.md")
        content = f.get("content", "")

        if ftype == "prompt":
            # Write as Claude Code custom command
            CLAUDE_COMMANDS_DIR.mkdir(parents=True, exist_ok=True)
            target = CLAUDE_COMMANDS_DIR / f"{skill['slug']}.md"
            target.write_text(content)
            files_written.append(str(target.relative_to(OPAI_ROOT)))

        elif ftype == "knowledge":
            # Write to knowledge library
            skill_dir = KNOWLEDGE_DIR / skill["slug"]
            skill_dir.mkdir(parents=True, exist_ok=True)
            target = skill_dir / fname
            target.write_text(content)
            files_written.append(str(target.relative_to(OPAI_ROOT)))

        elif ftype == "tool":
            # Tools need manual review for Claude Code
            warnings.append(f"Tool file '{fname}' written to knowledge dir — may need manual adaptation for Claude Code")
            skill_dir = KNOWLEDGE_DIR / skill["slug"]
            skill_dir.mkdir(parents=True, exist_ok=True)
            target = skill_dir / fname
            target.write_text(content)
            files_written.append(str(target.relative_to(OPAI_ROOT)))

        elif ftype == "config":
            # Config files go to knowledge for reference
            skill_dir = KNOWLEDGE_DIR / skill["slug"]
            skill_dir.mkdir(parents=True, exist_ok=True)
            target = skill_dir / fname
            target.write_text(content)
            files_written.append(str(target.relative_to(OPAI_ROOT)))

    if skill.get("required_vault_keys"):
        warnings.append(f"Skill requires credentials: {', '.join(skill['required_vault_keys'])}")

    if skill["claude_compat"] == "partial":
        warnings.append("Partial compatibility — tool definitions may need manual review")

    return {
        "status": "installed",
        "files_written": files_written,
        "warnings": warnings,
    }


async def uninstall_skill(
    slug: str,
    target_type: str,
    instance_slug: str = None,
) -> dict:
    """Uninstall a skill from an OC instance or Claude Code."""
    skill = await get_skill(slug)

    if target_type == "oc_instance":
        if not instance_slug:
            return {"error": "instance_slug required for oc_instance target"}
        _uninstall_from_instance(slug, instance_slug, skill)
    elif target_type == "claude_code":
        _uninstall_from_claude(slug)
    else:
        return {"error": f"Invalid target_type: {target_type}"}

    # Remove installation record
    instance_id_filter = ""
    if target_type == "oc_instance" and instance_slug:
        from manifest import get_instance
        inst = await get_instance(instance_slug)
        if inst:
            instance_id_filter = f"&instance_id=eq.{inst['id']}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.delete(
            _rest_url("ch_installations"),
            params={"skill_slug": f"eq.{slug}", "target_type": f"eq.{target_type}"},
            headers=_headers(),
        )

    return {"status": "uninstalled", "skill": slug, "target": target_type}


def _uninstall_from_instance(slug: str, instance_slug: str, skill: dict = None):
    """Remove skill files from an OC instance."""
    inst_dir = INSTANCES_DIR / instance_slug
    if not inst_dir.is_dir():
        return

    # Remove files that were written by this skill
    for subdir in ("prompts", "knowledge", "config", "skills"):
        d = inst_dir / subdir
        if d.is_dir():
            for f in d.iterdir():
                if slug in f.stem:
                    f.unlink(missing_ok=True)


def _uninstall_from_claude(slug: str):
    """Remove skill files from Claude Code locations."""
    # Remove command
    cmd_file = CLAUDE_COMMANDS_DIR / f"{slug}.md"
    cmd_file.unlink(missing_ok=True)

    # Remove knowledge directory
    knowledge_dir = KNOWLEDGE_DIR / slug
    if knowledge_dir.is_dir():
        shutil.rmtree(knowledge_dir)


async def list_installations(
    instance_slug: str = None,
    target_type: str = None,
    limit: int = 100,
) -> list[dict]:
    """List skill installations."""
    params = {"select": "*", "order": "installed_at.desc", "limit": str(limit)}

    if target_type:
        params["target_type"] = f"eq.{target_type}"

    if instance_slug:
        # Need to resolve slug → id
        from manifest import get_instance
        inst = await get_instance(instance_slug)
        if inst:
            params["instance_id"] = f"eq.{inst['id']}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(_rest_url("ch_installations"), params=params, headers=_headers())
        if resp.status_code == 200:
            return resp.json()
    return []
