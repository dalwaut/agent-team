"""Google Workspace — @agent mention poller + command handler.

Scheduled every 2 minutes via orchestrator. Scans Google Docs shared with
agent@paradisewebfl.com for unresolved comments containing @agent, parses
the command, processes via Claude CLI, and posts the result as a reply.

Trust model:
  - All paradisewebfl.com users can use business commands freely
  - System/infra queries (server status, credentials, hardware) restricted to Dallas only

Commands:
  @agent review       — Full document review, post findings
  @agent summarize    — Add summary comment
  @agent fact-check   — Check claims, post results
  @agent format       — Suggest formatting/structure improvements
  @agent draft [x]    — Draft content for a section
  @agent rewrite [x]  — Propose rewrite of selected text
  @agent research [x] — Research a topic, post findings
  @agent join         — Activate co-edit mode on this document
  @agent leave        — Deactivate co-edit mode
  @agent edit [x]     — Make a direct edit (requires active co-edit)
"""

import asyncio
import json
import logging
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Add shared libs
_shared_dir = str(Path(__file__).resolve().parent.parent.parent / "shared")
if _shared_dir not in sys.path:
    sys.path.insert(0, _shared_dir)

from audit import log_audit

logger = logging.getLogger("opai.workspace_mentions")

# ── Constants ────────────────────────────────────────────

STATE_FILE = Path(__file__).resolve().parent.parent / "data" / "workspace-mentions-state.json"
MAX_TRACKED_IDS = 500
DALLAS_EMAILS = {"dallas@paradisewebfl.com", "dalwaut@gmail.com"}
VERIFIED_DOMAINS = {"paradisewebfl.com", "wautersedge.com", "boutabyte.com"}

# Commands that any domain user can run
BUSINESS_COMMANDS = {
    "review", "summarize", "fact-check", "format",
    "draft", "rewrite", "research",
    "join", "leave", "edit",
}

# Patterns that indicate a system/infra query (blocked for non-Dallas)
SYSTEM_PATTERNS = re.compile(
    r"\b(server|infra|hardware|credentials?|password|secret|api.?key|"
    r"device|cpu|ram|disk|ssh|systemd|systemctl|ip.?address|"
    r"internal.?file|file.?path|workspace.?path|config.?file)\b",
    re.IGNORECASE,
)

# Matches both literal "@agent" and Google Docs email mentions
# like "@agent@paradisewebfl.com" or "+agent@paradisewebfl.com"
COMMAND_PATTERN = re.compile(
    r"[+@]?agent(?:@paradisewebfl\.com)?\s+"
    r"(review|summarize|fact-check|format|draft|rewrite|research|join|leave|edit)"
    r"(?:\s+(.+))?",
    re.IGNORECASE | re.DOTALL,
)

# System prompts per command
COMMAND_PROMPTS = {
    "review": (
        "You are a thorough document reviewer for a business team. "
        "Review the following document and provide constructive feedback on: "
        "clarity, structure, completeness, tone, and any factual concerns. "
        "Be specific and actionable. Keep response under 500 words."
    ),
    "summarize": (
        "Summarize the following document concisely. "
        "Include key points, decisions, and action items. "
        "Keep under 300 words."
    ),
    "fact-check": (
        "Fact-check the following document. Identify any claims that may be "
        "inaccurate, outdated, or unsupported. For each flagged item, explain "
        "the concern and suggest a correction if possible. "
        "Keep under 400 words."
    ),
    "format": (
        "Review the following document for formatting and structure improvements. "
        "Suggest better organization, headings, bullet points, tables, or "
        "other formatting changes that would improve readability. "
        "Keep under 300 words."
    ),
    "draft": (
        "Based on the document context below, draft content for the requested section. "
        "Match the document's existing tone and style. "
        "Keep under 500 words."
    ),
    "rewrite": (
        "Rewrite the following text to improve clarity, conciseness, and impact. "
        "Maintain the original meaning and tone. "
        "Provide the rewritten version directly."
    ),
    "research": (
        "Research the following topic and provide a concise, well-organized summary "
        "with key findings, relevant data points, and actionable insights. "
        "Keep under 500 words."
    ),
}


# ── State Management ─────────────────────────────────────

def _load_state() -> dict:
    """Load processed comment IDs and last poll time."""
    try:
        if STATE_FILE.is_file():
            return json.loads(STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to load mention state: %s", e)
    return {"processed_ids": [], "last_poll": None}


def _save_state(state: dict):
    """Save state with rolling cap on processed IDs."""
    state["processed_ids"] = state["processed_ids"][-MAX_TRACKED_IDS:]
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, indent=2))
    except OSError as e:
        logger.error("Failed to save mention state: %s", e)


# ── Trust Check ──────────────────────────────────────────

def _is_dallas(email: str) -> bool:
    """Check if the email belongs to Dallas."""
    return email.lower() in DALLAS_EMAILS


def _is_domain_user(email: str) -> bool:
    """Check if the email is from a verified business domain."""
    lower = email.lower()
    return any(lower.endswith(f"@{d}") for d in VERIFIED_DOMAINS)


def _is_system_query(text: str) -> bool:
    """Check if the text contains system/infra queries."""
    return bool(SYSTEM_PATTERNS.search(text))


# ── Command Parser ───────────────────────────────────────

def parse_agent_command(comment_text: str) -> dict | None:
    """Parse an @agent command from comment text.

    Returns:
        Dict with 'command' and 'args', or None if not a valid command.
    """
    match = COMMAND_PATTERN.search(comment_text)
    if not match:
        return None

    command = match.group(1).lower()
    args = (match.group(2) or "").strip()

    return {"command": command, "args": args}


# ── Claude Processing ────────────────────────────────────

async def _process_command(
    command: str,
    args: str,
    doc_content: str,
    doc_name: str,
    quoted_text: str | None = None,
) -> str:
    """Process a command via Claude CLI and return the response."""
    from claude_api import call_claude

    system_prompt = COMMAND_PROMPTS.get(command, COMMAND_PROMPTS["review"])

    # Build the prompt based on command type
    if command in ("draft", "rewrite", "research") and args:
        user_prompt = f"Document: {doc_name}\n\n"
        if quoted_text:
            user_prompt += f"Selected text: {quoted_text}\n\n"
        user_prompt += f"Request: {args}\n\n"
        if command != "research":
            user_prompt += f"Document content:\n{doc_content[:8000]}"
    else:
        user_prompt = f"Document: {doc_name}\n\nContent:\n{doc_content[:8000]}"
        if quoted_text:
            user_prompt += f"\n\nHighlighted text: {quoted_text}"

    try:
        result = await call_claude(
            user_prompt,
            system=system_prompt,
            model="claude-haiku-4-5",
            max_tokens=2048,
            timeout=120,
        )
        response = result.get("content", "").strip()
        if not response:
            return "I processed your request but couldn't generate a response. Please try again."
        return response
    except Exception as e:
        logger.error("Claude processing failed for %s: %s", command, e)
        return f"Sorry, I encountered an error processing your request: {str(e)[:100]}"


# ── Co-Edit Command Handler ──────────────────────────────

async def _process_coedit_command(
    command: str,
    args: str,
    file_id: str,
    doc_name: str,
    author_email: str,
    ws,
) -> str:
    """Handle @agent join, leave, and edit commands for co-editing."""
    from background.workspace_coedit import (
        activate_session,
        deactivate_session,
        is_coedit_active,
        update_agent_activity,
    )

    if command == "join":
        # Get current revision baseline
        try:
            revisions = await ws.docs_get_revisions(file_id, page_size=1)
            rev_id = revisions[-1]["id"] if revisions else None
        except Exception:
            rev_id = None

        # Determine doc type from file metadata
        try:
            meta = await ws.drive_get_metadata(file_id)
            mime = meta.get("mimeType", "")
            doc_type = "spreadsheet" if "spreadsheet" in mime else "document"
        except Exception:
            doc_type = "document"

        activate_session(file_id, doc_name, doc_type, author_email, rev_id)
        return (
            "Co-edit active. I'll help edit this doc. "
            "Say @agent edit <instruction> to make changes, "
            "or @agent leave when done. "
            "I'll auto-deactivate after 10 minutes of no activity."
        )

    elif command == "leave":
        session = deactivate_session(file_id, reason="manual")
        if session:
            return "Co-edit deactivated. Say @agent join to resume anytime."
        return "Co-edit wasn't active on this document."

    elif command == "edit":
        if not args:
            return "Please specify what to edit. Example: @agent edit fix the typo in paragraph 2"

        if not is_coedit_active(file_id):
            return "Co-edit isn't active. Say @agent join first."

        # Get document structure
        try:
            structure = await ws.docs_get_content_structure(file_id)
        except Exception as e:
            logger.error("Failed to get doc structure for edit: %s", e)
            return f"I couldn't read the document structure: {str(e)[:100]}"

        # Use Claude to determine edit operations
        from claude_api import call_claude

        paragraphs_text = "\n".join(
            f"[index {p['startIndex']}-{p['endIndex']}] {p['text'].rstrip()}"
            for p in structure.get("paragraphs", [])
        )

        try:
            result = await call_claude(
                f"Document structure:\n{paragraphs_text[:6000]}\n\nInstruction: {args}",
                system=(
                    "You are editing a Google Doc. Given the document structure "
                    "(each paragraph shown with its startIndex-endIndex range) and "
                    "the user's instruction, determine the exact edit operations needed.\n\n"
                    "Return ONLY a JSON array of operations. Each operation is one of:\n"
                    '- {"action": "insert", "index": <startIndex>, "text": "<text to insert>"}\n'
                    '- {"action": "replace_all", "find": "<exact text to find>", "replace": "<replacement>"}\n'
                    '- {"action": "delete", "start_index": <start>, "end_index": <end>}\n\n'
                    "Prefer replace_all for typo fixes and text changes. "
                    "Use insert for adding new content. "
                    "Return raw JSON only, no markdown code fences."
                ),
                model="claude-haiku-4-5",
                max_tokens=2048,
                timeout=60,
            )

            edit_json = result.get("content", "").strip()
            # Strip markdown code fences if present
            if edit_json.startswith("```"):
                edit_json = "\n".join(edit_json.split("\n")[1:])
            if edit_json.endswith("```"):
                edit_json = edit_json.rsplit("```", 1)[0]
            edit_json = edit_json.strip()

            edits = json.loads(edit_json)
            if not isinstance(edits, list) or not edits:
                return "I understood the request but couldn't determine specific edits to make. Could you be more specific?"

        except (json.JSONDecodeError, KeyError) as e:
            logger.error("Failed to parse edit operations: %s", e)
            return "I had trouble figuring out the exact edits. Could you be more specific?"
        except Exception as e:
            logger.error("Claude edit planning failed: %s", e)
            return f"I encountered an error planning the edits: {str(e)[:100]}"

        # Apply the edits
        try:
            await ws.docs_edit_text(file_id, edits)
            update_agent_activity(file_id)
        except Exception as e:
            logger.error("Failed to apply edits to %s: %s", file_id, e)
            return f"I planned the edits but couldn't apply them: {str(e)[:100]}"

        # Summarize what was done
        op_summary = []
        for e in edits:
            if e.get("action") == "insert":
                op_summary.append(f"Inserted text at index {e.get('index')}")
            elif e.get("action") == "replace_all":
                op_summary.append(f"Replaced \"{e.get('find', '')[:40]}\" with \"{e.get('replace', '')[:40]}\"")
            elif e.get("action") == "delete":
                op_summary.append(f"Deleted content at index {e.get('start_index')}-{e.get('end_index')}")

        return "Done — " + "; ".join(op_summary) if op_summary else "Edits applied."

    return "Unknown co-edit command."


# ── Main Poll Function ───────────────────────────────────

async def poll_workspace_mentions() -> dict:
    """Scan Google Docs for @agent mentions in comments.

    Called by scheduler every 2 minutes.

    Returns:
        Dict with processing stats.
    """
    from google_workspace import GoogleWorkspace

    state = _load_state()
    processed_ids = set(state.get("processed_ids", []))
    last_poll = state.get("last_poll")

    stats = {
        "docs_scanned": 0,
        "comments_found": 0,
        "commands_processed": 0,
        "commands_blocked": 0,
        "errors": 0,
    }

    ws = GoogleWorkspace()

    try:
        # Search for all non-folder files (comments work on any file type)
        # Use drive_list with no folder_id to get all files across all drives
        search_result = await ws.drive_list(page_size=100)
        all_files = search_result.get("files", [])
        # Filter out folders client-side
        docs = [f for f in all_files if f.get("mimeType") != "application/vnd.google-apps.folder"]
        stats["docs_scanned"] = len(docs)
        logger.debug("Mention scan: found %d files to check", len(docs))

        if not docs:
            logger.debug("No docs found for mention scanning")
            return stats

        for doc in docs:
            file_id = doc["id"]
            doc_name = doc.get("name", "Untitled")

            try:
                # Fetch unresolved comments, optionally filtered by time
                comments = await ws.docs_list_comments(
                    file_id,
                    include_resolved=False,
                    modified_after=last_poll,
                )

                for comment in comments:
                    comment_id = comment.get("id")
                    if not comment_id or comment_id in processed_ids:
                        continue

                    content = comment.get("content", "")
                    # Match both "@agent" and "agent@paradisewebfl.com"
                    content_lower = content.lower()
                    if "agent" not in content_lower:
                        continue
                    if not ("@agent" in content_lower or "agent@paradisewebfl.com" in content_lower):
                        continue

                    stats["comments_found"] += 1

                    # Parse the command
                    parsed = parse_agent_command(content)
                    if not parsed:
                        # @agent mentioned but no valid command
                        try:
                            await ws.docs_reply_comment(
                                file_id, comment_id,
                                "Hi! I didn't recognize that command. "
                                "Try: @agent review | summarize | fact-check | format | draft [x] | rewrite [x] | research [x]"
                            )
                        except Exception as e:
                            logger.warning("Failed to post help reply: %s", e)
                        processed_ids.add(comment_id)
                        continue

                    # Check trust
                    author = comment.get("author", {})
                    author_email = author.get("emailAddress", "")
                    is_self = author.get("me", False)

                    # Skip comments from the agent itself (don't talk to yourself)
                    if is_self:
                        processed_ids.add(comment_id)
                        continue

                    command = parsed["command"]
                    args = parsed["args"]

                    # If email missing but user has access to the doc on our
                    # Shared Drive, they're implicitly a domain user — allow.
                    # Only block if we have a confirmed non-domain email.
                    has_email = bool(author_email)

                    # System query check
                    full_text = f"{command} {args} {content}"
                    if _is_system_query(full_text) and not _is_dallas(author_email):
                        try:
                            await ws.docs_reply_comment(
                                file_id, comment_id,
                                "I can only help with business topics. "
                                "System and infrastructure queries are restricted."
                            )
                        except Exception as e:
                            logger.warning("Failed to post trust-block reply: %s", e)
                        stats["commands_blocked"] += 1
                        processed_ids.add(comment_id)
                        continue

                    # Domain check — only block if we have a confirmed non-domain email
                    if has_email and not _is_domain_user(author_email) and not _is_dallas(author_email):
                        try:
                            await ws.docs_reply_comment(
                                file_id, comment_id,
                                "Sorry, I can only respond to team members."
                            )
                        except Exception as e:
                            logger.warning("Failed to post domain-block reply: %s", e)
                        stats["commands_blocked"] += 1
                        processed_ids.add(comment_id)
                        continue

                    # ── Co-edit commands (join/leave/edit) ──
                    if command in ("join", "leave", "edit"):
                        response = await _process_coedit_command(
                            command, args, file_id, doc_name, author_email, ws,
                        )
                        try:
                            await ws.docs_reply_comment(file_id, comment_id, response)
                            stats["commands_processed"] += 1
                        except Exception as e:
                            logger.error("Failed to post co-edit reply on %s: %s", doc_name, e)
                            stats["errors"] += 1

                        processed_ids.add(comment_id)
                        await asyncio.sleep(2)
                        continue

                    # Get document content for context
                    quoted_text = comment.get("quotedFileContent", {}).get("value")
                    try:
                        doc_data = await ws.drive_read(file_id)
                        doc_content = doc_data.get("content", "")
                    except Exception:
                        doc_content = "(Could not read document content)"

                    # Process via Claude
                    logger.info(
                        "Processing @agent %s from %s on %s",
                        command, author_email, doc_name,
                    )

                    response = await _process_command(
                        command, args, doc_content, doc_name, quoted_text,
                    )

                    # Post reply
                    try:
                        await ws.docs_reply_comment(file_id, comment_id, response)
                        stats["commands_processed"] += 1
                    except Exception as e:
                        logger.error("Failed to post reply on %s: %s", doc_name, e)
                        stats["errors"] += 1

                    processed_ids.add(comment_id)

                    # Small delay between commands to respect rate limits
                    await asyncio.sleep(2)

            except Exception as e:
                logger.error("Error scanning doc %s (%s): %s", doc_name, file_id, e)
                stats["errors"] += 1

        # Update state
        state["processed_ids"] = list(processed_ids)
        state["last_poll"] = datetime.now(timezone.utc).isoformat()
        state["last_stats"] = stats
        _save_state(state)

        log_audit(
            tier="system",
            service="workspace-mentions",
            event="mention:poll",
            status="completed",
            summary=(
                f"Mention poll: {stats['docs_scanned']} docs, "
                f"{stats['comments_found']} mentions, "
                f"{stats['commands_processed']} processed"
            ),
            details=stats,
        )

    except Exception as e:
        logger.error("Mention poll failed: %s", e)
        stats["errors"] += 1
    finally:
        await ws.close()

    return stats
