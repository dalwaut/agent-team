"""Marq — AI metadata generation from project docs.

Reads app doc_folder (README, PRD, CHANGELOG, package.json) and generates
store listing metadata using Claude CLI. Returns draft metadata dict.
"""

import json
import logging
import re
from pathlib import Path

from core.claude_cli import call_claude

log = logging.getLogger("marq.metadata_builder")

# Files to look for in the doc folder, ordered by priority
DOC_FILES = [
    "README.md",
    "PRD.md",
    "CHANGELOG.md",
    "package.json",
    "app.json",
    "pubspec.yaml",
    "build.gradle",
]

# Max chars per doc file to keep prompt size reasonable
MAX_DOC_CHARS = 4000


def _read_doc_files(doc_folder: str) -> dict[str, str]:
    """Read available doc files from folder. Returns {filename: content}."""
    folder = Path(doc_folder)
    if not folder.is_dir():
        return {}

    docs = {}
    for name in DOC_FILES:
        f = folder / name
        if f.is_file():
            try:
                content = f.read_text(encoding="utf-8", errors="replace")
                docs[name] = content[:MAX_DOC_CHARS]
            except Exception:
                log.warning("Failed to read %s", f)
    return docs


def _extract_json(raw: str) -> dict | None:
    """Best-effort JSON extraction from AI response.

    Handles: bare JSON, markdown fencing (```json ... ```), leading/trailing
    prose, and unescaped newlines inside string values.
    """
    text = raw.strip()

    # 1. Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2. Strip markdown fencing: ```json ... ``` or ``` ... ```
    fenced = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if fenced:
        try:
            return json.loads(fenced.group(1).strip())
        except json.JSONDecodeError:
            pass

    # 3. Find outermost { ... } and try to parse that
    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        candidate = text[first_brace : last_brace + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

        # 4. Fix unescaped newlines in JSON string values
        #    Replace literal newlines inside "..." with \\n
        fixed = _fix_newlines_in_json_strings(candidate)
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            pass

    return None


def _fix_newlines_in_json_strings(s: str) -> str:
    """Replace literal newlines inside JSON string values with \\n."""
    result = []
    in_string = False
    escape = False
    for ch in s:
        if escape:
            result.append(ch)
            escape = False
            continue
        if ch == "\\":
            escape = True
            result.append(ch)
            continue
        if ch == '"':
            in_string = not in_string
            result.append(ch)
            continue
        if in_string and ch == "\n":
            result.append("\\n")
            continue
        if in_string and ch == "\r":
            continue
        if in_string and ch == "\t":
            result.append("\\t")
            continue
        result.append(ch)
    return "".join(result)


def _build_prompt(app: dict, docs: dict[str, str], store: str, locale: str) -> str:
    """Build the Claude prompt for metadata generation."""
    platform = app.get("platform", "both")
    store_label = "Apple App Store" if store == "apple" else "Google Play Store"

    doc_sections = ""
    for name, content in docs.items():
        doc_sections += f"\n--- {name} ---\n{content}\n"

    no_docs_note = ""
    if not docs:
        no_docs_note = "\nNOTE: No project documentation was found. Generate plausible, professional metadata based ONLY on the app name and info above. Do NOT ask for more information — just generate the best metadata you can.\n"

    return f"""You are a professional app store listing writer. Generate store metadata for the {store_label}.

APP INFO:
- Name: {app.get('name', 'Unknown')}
- Platform: {platform}
- Bundle ID (iOS): {app.get('bundle_id_ios', 'N/A')}
- Package Name (Android): {app.get('package_name_android', 'N/A')}
- Current Version: {app.get('current_version', '1.0.0')}
{f"""
PROJECT DOCUMENTATION:
{doc_sections}""" if doc_sections.strip() else ""}
{no_docs_note}
RULES — you MUST follow ALL of these:
1. Respond with ONLY a JSON object. No markdown, no explanation, no questions.
2. Every string value must be on a single line (no literal newlines inside values).
3. Use \\n for line breaks within full_description.

JSON fields:
- app_name: Max 30 chars for Apple, 50 for Google. Catchy, clear.
- subtitle: Apple only, max 30 chars. For Google set to empty string.
- short_description: Google only, max 80 chars. For Apple set to empty string.
- full_description: 200-4000 chars. Feature-focused, no keyword stuffing. Use \\n for line breaks.
- keywords: Comma-separated, max 100 chars total. No spaces after commas. No brand names. Relevant search terms.
- whats_new: Release notes for this version, 50-500 chars. Specific changes, not generic.

Store: {store}
Locale: {locale}

Output ONLY this JSON (no other text):
{{"app_name":"...","subtitle":"...","short_description":"...","full_description":"...","keywords":"...","whats_new":"..."}}"""


async def generate_metadata(
    app: dict,
    store: str = "apple",
    locale: str = "en-US",
    doc_folder_override: str | None = None,
) -> dict:
    """Generate store metadata from app's doc_folder using Claude.

    Args:
        app: App dict from mrq_apps
        store: Target store (apple/google)
        locale: Target locale (e.g., en-US)
        doc_folder_override: Optional path override (defaults to app.doc_folder)

    Returns:
        Dict with generated metadata fields + ai_generated=True
    """
    doc_folder = doc_folder_override or app.get("doc_folder")
    app_name = app.get("name", "Unknown")

    if not doc_folder:
        log.warning("No doc_folder for app %s — generating from app name only", app.get("id"))
        docs = {}
    else:
        docs = _read_doc_files(doc_folder)
        if not docs:
            log.warning("No doc files found in %s for app %s", doc_folder, app.get("id"))

    prompt = _build_prompt(app, docs, store, locale)

    try:
        raw = await call_claude(prompt, model="claude-haiku-4-5-20251001", timeout=60)
        log.debug("Raw AI response (%d chars): %s", len(raw), raw[:500])

        result = _extract_json(raw)
        if result is None:
            log.error("Claude returned invalid JSON for metadata gen: %s", raw[:500])
            return {
                "app_name": app_name,
                "subtitle": "",
                "short_description": "",
                "full_description": "",
                "keywords": "",
                "whats_new": "",
                "ai_generated": True,
                "status": "draft",
                "_error": "AI returned invalid JSON — edit manually",
            }
    except Exception as e:
        log.error("Metadata generation failed for app %s: %s", app.get("id"), e)
        return {
            "app_name": app_name,
            "subtitle": "",
            "short_description": "",
            "full_description": "",
            "keywords": "",
            "whats_new": "",
            "ai_generated": True,
            "status": "draft",
            "_error": str(e),
        }

    # Ensure all expected fields
    metadata = {
        "app_name": result.get("app_name", app_name)[:50],
        "subtitle": result.get("subtitle", "")[:30],
        "short_description": result.get("short_description", "")[:80],
        "full_description": result.get("full_description", "")[:4000],
        "keywords": result.get("keywords", "")[:100],
        "whats_new": result.get("whats_new", ""),
        "ai_generated": True,
        "status": "draft",
        "store": store,
        "locale": locale,
        "version": app.get("current_version", "1.0.0"),
    }

    log.info("Generated metadata for app %s (%s/%s): name=%s",
             app.get("id"), store, locale, metadata["app_name"])
    return metadata
