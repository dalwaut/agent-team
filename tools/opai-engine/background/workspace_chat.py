"""Google Workspace — Chat message poller + command handler.

Runs on a dedicated 30-second fast loop (not the cron scheduler) for responsive
interactions. Polls Google Chat spaces that agent@paradisewebfl.com belongs to,
classifies intent, dispatches to skill handlers or Claude, and replies as the
agent user (NOT as a bot app).

Messages sent via user-authenticated Chat API appear FROM agent@paradisewebfl.com.

Behavior:
  - DMs: ALL messages from domain users trigger a response (no @agent prefix needed)
  - Spaces/Group chats: Only messages mentioning "agent" trigger a response
  - Intent router classifies: find_file, research, teamhub_query/create/update,
    quoting (stub), folder_template (stub), or falls back to Claude Q&A
  - Gap detection: unrecognized intents → log + Telegram notification

Trust model:
  - All verified domain users can use business commands freely
  - System/infra queries restricted to Dallas only
"""

import asyncio
import json
import logging
import random
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

logger = logging.getLogger("opai.workspace_chat")

# ── Constants ────────────────────────────────────────────

STATE_FILE = Path(__file__).resolve().parent.parent / "data" / "workspace-chat-state.json"
GAPS_FILE = Path(__file__).resolve().parent.parent / "data" / "chat-gaps.json"
DM_MAPPING_FILE = Path(__file__).resolve().parent.parent / "data" / "chat-dm-mapping.json"
MAX_TRACKED_IDS = 500
MAX_MESSAGES_PER_SPACE = 3  # Safety cap: never process more than 3 messages per space per poll
POLL_INTERVAL_SECONDS = 30  # Fast loop interval for responsive chat

# agent@paradisewebfl.com user resource name in Google Chat.
# Used to detect our own messages (Chat API with user auth doesn't return email/displayName).
AGENT_USER_RESOURCE_NAME = "users/104925845712532175991"

# In-memory conversation buffer: space_name → list of {"role": str, "name": str, "text": str}
_conversation_buffer: dict[str, list[dict]] = {}
_CONVERSATION_BUFFER_SIZE = 10  # Keep last N messages per space

# Track DM spaces where setup has been attempted (to avoid repeated API calls)
_dm_setup_cache: set[str] = set()

# Cache: user_resource_name → {"email": str, "displayName": str, "cached_at": float}
_member_cache: dict[str, dict] = {}
_MEMBER_CACHE_TTL = 3600  # 1 hour

# DM space → user info mapping (loaded from file, updated at runtime)
_dm_mapping: dict[str, dict] = {}

# Track message IDs we've sent — skip these in the poller to prevent feedback loops
_sent_message_ids: set[str] = set()
_MAX_SENT_IDS = 200


def _load_dm_mapping() -> dict:
    """Load DM space-to-user mapping from file."""
    try:
        if DM_MAPPING_FILE.is_file():
            data = json.loads(DM_MAPPING_FILE.read_text())
            return {k: v for k, v in data.items() if not k.startswith("_")}
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to load DM mapping: %s", e)
    return {}


def _save_dm_mapping():
    """Persist DM mapping to file (auto-discovered entries)."""
    try:
        data = {"_comment": "Maps DM space names to user info. Auto-populated by chat poller."}
        data.update(_dm_mapping)
        DM_MAPPING_FILE.parent.mkdir(parents=True, exist_ok=True)
        DM_MAPPING_FILE.write_text(json.dumps(data, indent=2))
    except OSError as e:
        logger.warning("Failed to save DM mapping: %s", e)

# Reuse trust model from workspace_mentions
from background.workspace_mentions import (
    DALLAS_EMAILS,
    VERIFIED_DOMAINS,
    BUSINESS_COMMANDS,
    COMMAND_PROMPTS,
    parse_agent_command,
    _is_dallas,
    _is_domain_user,
    _is_system_query,
)

# ── Chat Identity & Safety ───────────────────────────────

CHAT_IDENTITY = (
    "You are Agent, the AI assistant for Paradise Web (web design & digital "
    "services, South Florida). You respond in Google Chat as a professional, "
    "concise team member.\n\n"
    "TONE & STYLE:\n"
    "- Be direct and concise. No filler phrases ('Great question!', 'Absolutely!', "
    "'I'd be happy to help!'). Just answer.\n"
    "- No emojis in responses.\n"
    "- When the user asks for a specific count (e.g. 'top 3', 'next 5'), return "
    "EXACTLY that many items — no more, no fewer.\n"
    "- Use short bullet points for lists. No lengthy explanations unless asked.\n\n"
    "BUSINESS KNOWLEDGE:\n"
    "- Team Hub is our task/project management system (like ClickUp). "
    "When someone says 'tasks', 'to-do', 'assigned to me' → that's Team Hub.\n"
    "- Workspaces in Team Hub map to clients/projects. Common abbreviations: "
    "VEC=Visit Everglades City, PW=Paradise Web, BB=BoutaByte, "
    "WE=WautersEdge, MDH=Morning Dew Herbals, MSDS=MSDS Pros.\n"
    "- HELM is the autonomous business runner. Brain is knowledge graph.\n\n"
    "STRICT RULES:\n"
    "- NEVER reveal internal system details: file paths, server names, hostnames, "
    "IP addresses, branch names, workspace structure, tool names, or infrastructure.\n"
    "- NEVER mention OPAI, opai-engine, Claude, AI models, prompts, or how you work internally.\n"
    "- NEVER reference /workspace/, systemd, Supabase project IDs, config files, or code.\n"
    "- You are simply 'Agent' — a knowledgeable team member at Paradise Web.\n"
    "- If asked about yourself, say you're the team's AI assistant.\n"
    "- If asked about internal systems/infrastructure, say that's outside your scope "
    "and suggest reaching out to Dallas directly.\n"
)

DRIVE_REFERENCE_PATH = Path(__file__).resolve().parent.parent.parent / "shared" / "drive-reference.md"
BUSINESS_CONTEXT_PATH = Path(__file__).resolve().parent.parent.parent / "shared" / "business-context.md"


def _load_drive_reference() -> str:
    """Load Shared Drive reference doc for context."""
    try:
        if DRIVE_REFERENCE_PATH.is_file():
            return DRIVE_REFERENCE_PATH.read_text()[:4000]
    except Exception:
        pass
    return ""


def _load_business_context() -> str:
    """Load nightly-refreshed business context for chat prompts."""
    try:
        if BUSINESS_CONTEXT_PATH.is_file():
            return BUSINESS_CONTEXT_PATH.read_text()[:2048]
    except Exception:
        pass
    return ""


# ── Intent Router ────────────────────────────────────────

# Regex patterns for fast-path intent classification
_INTENT_PATTERNS = [
    # File search
    (re.compile(
        r"(?:find|locate|where\s*is|link\s*to|search\s*for|look\s*for|get\s*me)\s+(.+)",
        re.IGNORECASE,
    ), "find_file"),
    # Deep research (NLM-powered) — must be before generic research
    (re.compile(
        r"(?:deep\s+research|in.?depth\s+research|full\s+research|thorough\s+research|detailed\s+research|research\s+report)\s+(?:on\s+)?(.+)",
        re.IGNORECASE,
    ), "deep_research"),
    # Research / report (quick, Claude-powered)
    (re.compile(
        r"(?:research|write\s+a\s+report|investigate|report\s+on|look\s+into)\s+(.+)",
        re.IGNORECASE,
    ), "research"),
    # TeamHub workspace-scoped query (must be before generic teamhub_query)
    # Matches: "tasks in VEC", "my tasks for BoutaByte", "tasks under Paradise Web",
    # "show me tasks in Leads", "what tasks in Morning Dew"
    # Negative lookahead prevents matching "tasks in progress" etc. as workspace names
    (re.compile(
        r"(?:(?:show|list|get|what(?:'s|\s+are)?)\s+)?(?:my\s+)?tasks?\s+(?:in|for|under|from)\s+(?!progress|review|backlog|queue\b)(.+)",
        re.IGNORECASE,
    ), "teamhub_query_ws"),
    # TeamHub list workspaces / spaces
    (re.compile(
        r"(?:my\s+(?:workspaces?|spaces?)|(?:which|what)\s+(?:workspaces?|spaces?)|list\s+(?:workspaces?|spaces?))",
        re.IGNORECASE,
    ), "teamhub_workspaces"),
    # TeamHub query (generic — "my tasks", "what am I working on", filtered queries, etc.)
    (re.compile(
        r"(?:"
        r"my\s+tasks?|assigned\s+to\s+me|task\s+list|"
        r"what.{0,10}(?:working\s+on|assigned|todo|to\s*do)|"
        r"(?:show|list|get|what(?:'s|\s+are)?)\s+(?:the\s+)?(?:my\s+)?(?:all\s+)?(?:(?:open|active|high|low|medium|critical|urgent)\s+(?:priority\s+)?)?(?:tasks?|items?|to.?dos?)|"
        r"(?:overdue|upcoming|due\s+(?:today|this\s+week|this\s+month|next\s+week|soon))\s*(?:tasks?|items?)?|"
        r"(?:tasks?|items?)\s+(?:that\s+are\s+)?(?:overdue|upcoming|due|blocked|stuck|in\s+progress|not\s+started|on\s+hold|paused|open|active)|"
        r"(?:all|open|active|blocked|stuck|overdue|upcoming|paused|completed|finished)\s+(?:tasks?|items?)|"
        r"what(?:'s|\s+is)\s+(?:overdue|due|upcoming|blocked)|"
        r"(?:my\s+)?(?:high|critical|urgent)\s+(?:priority\s+)?(?:tasks?|items?|work)|"
        r"(?:how\s+many|any)\s+(?:tasks?|items?)|"
        r"(?:tasks?|items?)\s+(?:assigned\s+to|for)\s+(?:me|denise|dallas)"
        r")",
        re.IGNORECASE,
    ), "teamhub_query"),
    # TeamHub create
    (re.compile(
        r"(?:create\s+(?:a\s+)?task|new\s+task|add\s+(?:a\s+)?task)[:\s]*(.+)",
        re.IGNORECASE,
    ), "teamhub_create"),
    # TeamHub update
    (re.compile(
        r"(?:update\s+task|mark\s+.+\s+(?:done|complete|closed)|change\s+status|close\s+task|complete\s+task)\s*(.+)?",
        re.IGNORECASE,
    ), "teamhub_update"),
    # Quoting (stub)
    (re.compile(
        r"(?:quote|estimate|pricing|how\s+much|cost\s+(?:for|of|to))",
        re.IGNORECASE,
    ), "quoting"),
    # Client folder (stub)
    (re.compile(
        r"(?:client\s+folder|setup\s+folder|new\s+client|onboard\s+client)\s*(.+)?",
        re.IGNORECASE,
    ), "folder_template"),
    # Co-edit activate
    (re.compile(
        r"(?:join|co-?edit|start\s+editing)\s+(.+)",
        re.IGNORECASE,
    ), "coedit_activate"),
    # Co-edit deactivate
    (re.compile(
        r"(?:leave|stop\s+editing|end\s+co-?edit)\s*(.+)?",
        re.IGNORECASE,
    ), "coedit_deactivate"),
    # Co-edit status
    (re.compile(
        r"(?:co-?edit\s+status|active\s+sessions?|editing\s+what)",
        re.IGNORECASE,
    ), "coedit_status"),
    # Newsletter send
    (re.compile(
        r"(?:send\s+(?:the\s+)?newsletter|newsletter\s+send|blast\s+newsletter)",
        re.IGNORECASE,
    ), "newsletter_send"),
    # Newsletter status
    (re.compile(
        r"(?:newsletter\s+(?:status|list|pending)|pending\s+newsletters?)",
        re.IGNORECASE,
    ), "newsletter_status"),
]


def _classify_intent(text: str) -> dict:
    """Classify a chat message into an intent + extracted entities.

    Uses regex fast-path first, then falls back to Claude Haiku for
    ambiguous messages.

    Returns:
        {"intent": str, "entities": dict}
        Intent values: find_file, research, teamhub_query, teamhub_create,
        teamhub_update, quoting, folder_template, doc_command, free_form
    """
    # Strip @agent prefix for cleaner matching
    clean = re.sub(r"^@?agent\s*", "", text, flags=re.IGNORECASE).strip()

    if not clean:
        return {"intent": "free_form", "entities": {"text": text}}

    # Check regex patterns
    for pattern, intent in _INTENT_PATTERNS:
        match = pattern.search(clean)
        if match:
            extracted = match.group(1).strip() if match.lastindex else clean
            return {"intent": intent, "entities": {"query": extracted, "text": clean}}

    # Check if it's a legacy doc command (review, summarize, etc.)
    parsed = parse_agent_command(f"@agent {clean}")
    if parsed:
        return {
            "intent": "doc_command",
            "entities": {"command": parsed["command"], "args": parsed["args"], "text": clean},
        }

    # Free-form — no specific intent detected via regex
    return {"intent": "free_form", "entities": {"text": clean}}


# ── Email-to-User Resolution ────────────────────────────

# In-memory cache: email → {"user_id": str, "display_name": str, "cached_at": float}
_user_cache: dict[str, dict] = {}
_USER_CACHE_TTL = 600  # 10 minutes


async def _resolve_user(email: str) -> dict | None:
    """Resolve an email address to a Supabase user profile.

    Returns:
        Dict with 'id' and 'display_name', or None if not found.
    """
    import config

    if not email or not config.SUPABASE_URL:
        return None

    lower = email.lower()

    # Check cache
    cached = _user_cache.get(lower)
    if cached and (time.time() - cached.get("cached_at", 0)) < _USER_CACHE_TTL:
        return {"id": cached["user_id"], "display_name": cached["display_name"]}

    try:
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{config.SUPABASE_URL}/rest/v1/profiles",
                headers={
                    "apikey": config.SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
                },
                params={
                    "email": f"eq.{lower}",
                    "select": "id,display_name",
                    "limit": "1",
                },
            )

            if resp.status_code < 400 and resp.json():
                profile = resp.json()[0]
                _user_cache[lower] = {
                    "user_id": profile["id"],
                    "display_name": profile.get("display_name", ""),
                    "cached_at": time.time(),
                }
                return {"id": profile["id"], "display_name": profile.get("display_name", "")}
            else:
                logger.warning("User resolution query failed for %s: %d %s", email, resp.status_code, resp.text[:200])

    except Exception as e:
        logger.warning("User resolution failed for %s: %s", email, e)

    return None


# ── Gap Detection ────────────────────────────────────────

async def _handle_gap(message_text: str, sender_name: str, intent: str, reason: str = ""):
    """Log a gap (unrecognized request) and notify Dallas via Telegram.

    Args:
        message_text: The original message.
        sender_name: Who sent it.
        intent: The detected intent (or 'unknown').
        reason: Why it's a gap (e.g., 'unrecognized intent', 'skill unavailable').
    """
    # Log to gaps file
    try:
        entries = []
        if GAPS_FILE.is_file():
            entries = json.loads(GAPS_FILE.read_text())
        entries.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "sender": sender_name,
            "message": message_text[:500],
            "detected_intent": intent,
            "reason": reason or "unrecognized",
        })
        entries = entries[-100:]  # Rolling cap
        GAPS_FILE.parent.mkdir(parents=True, exist_ok=True)
        GAPS_FILE.write_text(json.dumps(entries, indent=2))
    except Exception as e:
        logger.warning("Failed to log chat gap: %s", e)

    # Telegram notification
    try:
        from background import notifier
        await notifier.send_telegram(
            f"\U0001F4AC *Chat Gap*: {sender_name} asked for _{message_text[:100]}_"
            f"\nIntent: `{intent}` | {reason or 'unrecognized'}",
            parse_mode="Markdown",
            thread_id=notifier._hitl_thread_id,
        )
    except Exception as e:
        logger.warning("Failed to send gap notification: %s", e)


# ── Claude Free-Form Processing ─────────────────────────

def _record_conversation(space_name: str, role: str, name: str, text: str):
    """Record a message in the conversation buffer for a space."""
    if space_name not in _conversation_buffer:
        _conversation_buffer[space_name] = []
    _conversation_buffer[space_name].append({
        "role": role,
        "name": name,
        "text": text[:500],
    })
    # Trim to max size
    _conversation_buffer[space_name] = _conversation_buffer[space_name][-_CONVERSATION_BUFFER_SIZE:]


def _get_conversation_context(space_name: str) -> str:
    """Build recent conversation context string for Claude."""
    messages = _conversation_buffer.get(space_name, [])
    if not messages:
        return ""
    lines = ["Recent conversation:"]
    for msg in messages:
        prefix = msg["name"] if msg["role"] == "user" else "You"
        lines.append(f"  {prefix}: {msg['text']}")
    return "\n".join(lines)


async def _process_chat_message(
    command: str,
    args: str,
    doc_content: str,
    doc_name: str,
    sender_name: str = "",
    space_name: str = "",
) -> str:
    """Process a chat message via Claude with locked-down business identity."""
    from claude_api import call_claude

    # Build system prompt with identity + drive knowledge
    system = CHAT_IDENTITY

    # Add sender context so Claude knows who it's talking to
    if sender_name:
        system += (
            f"\nYou are currently chatting with {sender_name}, "
            f"a team member at Paradise Web. Address them by name. "
            f"Be friendly, helpful, and conversational.\n"
        )

    # Add conversation history for continuity
    conv_context = _get_conversation_context(space_name)
    if conv_context:
        system += f"\n{conv_context}\n"

    drive_ref = _load_drive_reference()
    if drive_ref:
        system += (
            "\nYou have access to the team's Google Shared Drive. "
            "Here is the current structure for reference:\n\n"
            f"{drive_ref}\n"
        )

    biz_ctx = _load_business_context()
    if biz_ctx:
        system += (
            "\nBusiness reference (team, clients, workspaces, sites):\n\n"
            f"{biz_ctx}\n"
        )

    # Add command-specific instructions if applicable
    cmd_prompt = COMMAND_PROMPTS.get(command, "")
    if cmd_prompt:
        system += f"\nTask: {cmd_prompt}\n"

    # Build user prompt
    if command in ("draft", "rewrite", "research") and args:
        user_prompt = f"Request: {args}"
        if doc_content and doc_content != args:
            user_prompt += f"\n\nContext:\n{doc_content[:6000]}"
    elif doc_content:
        user_prompt = f"Document: {doc_name}\n\n{doc_content[:6000]}"
    else:
        user_prompt = args or doc_content or "Hello"

    try:
        result = await call_claude(
            user_prompt,
            system=system,
            model="claude-haiku-4-5",
            max_tokens=2048,
            timeout=120,
        )
        response = result.get("content", "").strip()
        if not response:
            return "Let me look into that — could you rephrase your question?"
        return response
    except Exception as e:
        logger.error("Chat processing failed for %s: %s", command, e)
        return "I'm having trouble processing that right now. Please try again in a moment."


# ── Skill Dispatch ───────────────────────────────────────

async def _dispatch_skill(intent: dict, sender_email: str, sender_name: str, ws) -> str:
    """Route an intent to the appropriate skill handler.

    Args:
        intent: Dict from _classify_intent() with 'intent' and 'entities'.
        sender_email: Sender's email for user resolution.
        sender_name: Display name for logging.
        ws: GoogleWorkspace instance.

    Returns:
        Response string to send in Chat.
    """
    from background.chat_skills import (
        skill_find_file,
        skill_research_doc,
        skill_deep_research,
        skill_teamhub_query,
        skill_teamhub_create,
        skill_teamhub_update,
        skill_teamhub_workspaces,
        skill_quoting_stub,
        skill_folder_template_stub,
        skill_coedit_activate,
        skill_coedit_deactivate,
        skill_coedit_status,
        skill_newsletter_send,
        skill_newsletter_status,
    )

    intent_type = intent["intent"]
    entities = intent["entities"]
    query = entities.get("query", entities.get("text", ""))

    if intent_type == "find_file":
        return await skill_find_file(query, ws)

    elif intent_type == "deep_research":
        return await skill_deep_research(query, ws)

    elif intent_type == "research":
        return await skill_research_doc(query, ws)

    elif intent_type == "teamhub_query":
        user = await _resolve_user(sender_email)
        user_id = user["id"] if user else ""
        return await skill_teamhub_query(query, user_id)

    elif intent_type == "teamhub_query_ws":
        user = await _resolve_user(sender_email)
        user_id = user["id"] if user else ""
        # Extract workspace name from the matched groups
        ws_name = entities.get("query", "").strip()
        return await skill_teamhub_query(query, user_id, workspace_filter=ws_name)

    elif intent_type == "teamhub_workspaces":
        user = await _resolve_user(sender_email)
        user_id = user["id"] if user else ""
        return await skill_teamhub_workspaces(user_id)

    elif intent_type == "teamhub_create":
        user = await _resolve_user(sender_email)
        user_id = user["id"] if user else ""
        # Parse title from query — first sentence or up to a period/dash
        title = query.split(".")[0].split(" - ")[0].strip()[:200]
        details = query[len(title):].strip().lstrip(".-: ")
        return await skill_teamhub_create(title, details, user_id)

    elif intent_type == "teamhub_update":
        user = await _resolve_user(sender_email)
        user_id = user["id"] if user else ""
        # Parse: "mark [ref] done" or "update task [ref] status [status]"
        changes = {}
        q_lower = query.lower()
        if any(w in q_lower for w in ("done", "complete", "finished", "closed")):
            changes["status"] = "Complete"
        elif "in progress" in q_lower or "in-progress" in q_lower or "started" in q_lower or "working" in q_lower:
            changes["status"] = "Working on"
        elif "open" in q_lower or "reopen" in q_lower or "not started" in q_lower:
            changes["status"] = "Not Started"
        # Extract the task reference (remove status words)
        ref = re.sub(
            r"\b(done|complete|finished|closed|in.?progress|started|open|reopen|working|not\s+started|mark|as|to|set|status)\b",
            "", q_lower, flags=re.IGNORECASE,
        ).strip().strip("#").strip()
        return await skill_teamhub_update(ref or query, changes, user_id)

    elif intent_type == "quoting":
        return await skill_quoting_stub(query)

    elif intent_type == "folder_template":
        return await skill_folder_template_stub(query)

    elif intent_type == "coedit_activate":
        return await skill_coedit_activate(query, sender_email, ws)

    elif intent_type == "coedit_deactivate":
        return await skill_coedit_deactivate(query, sender_email)

    elif intent_type == "coedit_status":
        return await skill_coedit_status(sender_email)

    elif intent_type == "newsletter_send":
        if not _is_dallas(sender_email):
            return "Newsletter send is restricted to admins."
        return await skill_newsletter_send(sender_email)

    elif intent_type == "newsletter_status":
        return await skill_newsletter_status(sender_email)

    # Should not reach here — caller handles doc_command and free_form
    return ""


# ── State Management ─────────────────────────────────────

def _load_state() -> dict:
    """Load processed message IDs and last poll time."""
    try:
        if STATE_FILE.is_file():
            return json.loads(STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to load chat state: %s", e)
    return {"processed_ids": [], "last_poll": None, "spaces": {}}


def _save_state(state: dict):
    """Save state with rolling cap on processed IDs."""
    state["processed_ids"] = state["processed_ids"][-MAX_TRACKED_IDS:]
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, indent=2))
    except OSError as e:
        logger.error("Failed to save chat state: %s", e)


# ── Message Detection ────────────────────────────────────

def _should_respond(message: dict, space_type: str) -> bool:
    """Determine if we should respond to this message.

    In DMs: respond to all messages (no @agent prefix needed).
    In spaces/groups: only respond if "agent" is mentioned.
    Never respond to our own messages.
    """
    sender = message.get("sender", {})

    # Skip our own messages — agent sends as user, not bot
    if sender.get("type") == "BOT":
        return False
    sender_email = sender.get("email", "").lower()
    if sender_email == "agent@paradisewebfl.com":
        return False
    # Skip by user resource name — Chat API with user auth often doesn't return
    # email/displayName, but always returns sender.name (user resource ID).
    # This is the primary way we detect our own messages.
    sender_name = sender.get("name", "")
    if sender_name == AGENT_USER_RESOURCE_NAME:
        return False

    text = message.get("text", "").lower()

    # In DMs, respond to everything
    if space_type == "DIRECT_MESSAGE":
        return bool(text.strip())

    # In spaces/groups, only respond if agent is mentioned
    return "agent" in text


def _extract_message_text(message: dict, space_type: str) -> str:
    """Extract clean text from the message for intent classification.

    In DMs, the raw text is used directly (no @agent prefix needed).
    In spaces, strip the @agent prefix for cleaner processing.
    """
    text = message.get("text", "").strip()

    if space_type == "DIRECT_MESSAGE":
        return text

    # In spaces, text may start with @agent — leave it for the router to strip
    return text


# ── Smart Reply (DM setup + fallback) ────────────────────

async def _send_reply(
    ws,
    space_name: str,
    space_type: str,
    text: str,
    sender_email: str = "",
) -> bool:
    """Send a reply directly in Chat. No threads — always top-level message.

    For DM spaces: if send fails with 403, attempt DM setup then fallback
    to Agent Work space or Gmail.

    Args:
        ws: GoogleWorkspace instance.
        space_name: Space resource name.
        space_type: DIRECT_MESSAGE, SPACE, or GROUP_CHAT.
        text: Response text.
        sender_email: Sender's email (for DM setup and Gmail fallback).

    Returns:
        True if message was sent successfully (via any channel).
    """
    try:
        result = await ws.chat_send_message(space_name, text)
        # Track sent message ID to prevent feedback loops
        sent_name = result.get("name", "") if isinstance(result, dict) else ""
        if sent_name:
            _sent_message_ids.add(sent_name)
            # Trim to cap
            if len(_sent_message_ids) > _MAX_SENT_IDS:
                _sent_message_ids.clear()  # Nuclear trim — simpler than LRU
        return True
    except RuntimeError as e:
        error_str = str(e)
        # If 403 on a DM space, try setting up the DM first
        if "403" in error_str and space_type == "DIRECT_MESSAGE" and sender_email:
            if space_name not in _dm_setup_cache:
                logger.info("Got 403 on DM %s — attempting DM setup with %s", space_name, sender_email)
                try:
                    await ws.chat_setup_dm(sender_email)
                    _dm_setup_cache.add(space_name)
                    await ws.chat_send_message(space_name, text)
                    logger.info("DM setup + retry succeeded for %s", sender_email)
                    return True
                except Exception as setup_err:
                    logger.warning("DM setup failed for %s: %s", sender_email, setup_err)

            # DM setup didn't work — fallback chain:
            # 1. Try Agent Work shared space
            # 2. Try Gmail
            # 3. Telegram notification
            logger.info("Chat DM send failed for %s — trying fallbacks", sender_email)
            fallback_sent = False
            fallback_channel = ""

            # 1. Try the Agent Work space (shared space team members are in)
            try:
                fb_result = await ws.chat_send_message(
                    "spaces/AAQAmgTjdC8",  # Agent Work space
                    f"@{sender_email.split('@')[0]} — {text}",
                )
                fb_name = fb_result.get("name", "") if isinstance(fb_result, dict) else ""
                if fb_name:
                    _sent_message_ids.add(fb_name)
                logger.info("Fallback to Agent Work space succeeded for %s", sender_email)
                fallback_sent = True
                fallback_channel = "Agent Work space"
            except Exception as space_err:
                logger.warning("Agent Work space fallback failed: %s", space_err)

            # 2. Try Gmail if Agent Work space also failed
            if not fallback_sent and sender_email:
                try:
                    await ws.gmail_send(
                        to=sender_email,
                        subject="Re: Your message to Agent",
                        body=(
                            f"Hi {sender_email.split('@')[0].title()}! "
                            f"I got your message in Google Chat. Here's my response:\n\n"
                            f"{text}\n\n"
                            f"Feel free to reply here or message me in the Agent Work space in Chat!"
                        ),
                    )
                    logger.info("Gmail fallback sent to %s", sender_email)
                    fallback_sent = True
                    fallback_channel = "Gmail"
                except Exception as gmail_err:
                    logger.warning("Gmail fallback failed for %s: %s", sender_email, gmail_err)

            # 3. Always notify Dallas about the DM permission issue
            try:
                from background import notifier
                await notifier.send_telegram(
                    f"\u26a0\ufe0f *Chat DM Permission Issue*\n"
                    f"Could not reply to *{sender_email}* in their DM.\n"
                    f"{'Sent via ' + fallback_channel + '.' if fallback_sent else 'Response LOST!'}\n\n"
                    f"*Fix:* Open Google Chat as agent@ and message {sender_email} "
                    f"to join their DM. OR re-run OAuth with `chat.spaces.create` scope.\n\n"
                    f"*Response:* {text[:300]}",
                    parse_mode="Markdown",
                )
            except Exception:
                pass

            return fallback_sent
        else:
            raise


# ── Progressive Message Updates ─────────────────────────

# Varied acknowledgment messages — pick one at random per request
_ACK_TEMPLATES = [
    "On it, {name}.",
    "Looking into that, {name}...",
    "Let me check, {name}.",
    "One sec, {name} — pulling that up.",
    "Working on it, {name}.",
    "Give me a moment, {name}...",
    "Checking now, {name}.",
    "Right on it, {name}.",
]

# Mid-processing status updates (used if skill takes a while)
_PROGRESS_MESSAGES = [
    "Still working on this...",
    "Almost there...",
    "Crunching the details...",
    "Pulling everything together...",
    "Just a bit longer...",
]


async def _send_ack(
    ws,
    space_name: str,
    space_type: str,
    sender_name: str,
    sender_email: str = "",
) -> str | None:
    """Send a varied acknowledgment and return the message resource name.

    Returns the message name so it can be updated later, or None on failure.
    """
    ack_text = random.choice(_ACK_TEMPLATES).format(name=sender_name)
    try:
        result = await ws.chat_send_message(space_name, ack_text)
        sent_name = result.get("name", "") if isinstance(result, dict) else ""
        if sent_name:
            _sent_message_ids.add(sent_name)
            if len(_sent_message_ids) > _MAX_SENT_IDS:
                _sent_message_ids.clear()
        return sent_name or None
    except Exception:
        return None


async def _update_reply(
    ws,
    message_name: str | None,
    text: str,
    space_name: str,
    space_type: str,
    sender_email: str = "",
) -> bool:
    """Update an existing ack message with new text, or send a fresh message.

    If message_name is available, edits in-place. Falls back to sending a new
    message if the update fails (e.g., scope not yet upgraded).

    Args:
        ws: GoogleWorkspace instance.
        message_name: Resource name from _send_ack (or None to send fresh).
        text: New message text.
        space_name: Space to fall back to if update fails.
        space_type: Space type for _send_reply fallback.
        sender_email: For fallback chain.

    Returns:
        True if update/send succeeded.
    """
    if message_name:
        try:
            await ws.chat_update_message(message_name, text)
            return True
        except Exception as e:
            logger.warning("Message update failed (%s), sending new message: %s", message_name, e)
            # Fall through to send a new message

    return await _send_reply(ws, space_name, space_type, text, sender_email=sender_email)


async def _progress_watchdog(
    ws,
    message_name: str | None,
    delay: float = 8.0,
) -> None:
    """After `delay` seconds, update the ack message with a progress hint.

    Launched as a background task — gets cancelled when the skill finishes.
    """
    if not message_name:
        return
    await asyncio.sleep(delay)
    try:
        progress_text = random.choice(_PROGRESS_MESSAGES)
        await ws.chat_update_message(message_name, progress_text)
    except Exception:
        pass  # Best-effort


async def poll_workspace_chat() -> dict:
    """Poll Google Chat spaces for messages to respond to.

    Called by scheduler every 2 minutes.

    Returns:
        Dict with processing stats.
    """
    from google_workspace import GoogleWorkspace

    global _dm_mapping
    if not _dm_mapping:
        _dm_mapping = _load_dm_mapping()

    state = _load_state()
    processed_ids = set(state.get("processed_ids", []))
    last_poll = state.get("last_poll")

    stats = {
        "spaces_scanned": 0,
        "messages_found": 0,
        "commands_processed": 0,
        "skills_dispatched": 0,
        "gaps_detected": 0,
        "commands_blocked": 0,
        "errors": 0,
    }

    ws = GoogleWorkspace()

    try:
        # List all spaces agent@ belongs to
        try:
            spaces = await ws.chat_list_spaces()
        except RuntimeError as e:
            error_msg = str(e)
            if "403" in error_msg or "401" in error_msg or "PERMISSION_DENIED" in error_msg:
                logger.info(
                    "Chat API not authorized yet — skipping. "
                    "Re-run OAuth flow with chat scopes to enable."
                )
                return stats
            raise

        stats["spaces_scanned"] = len(spaces)

        if not spaces:
            logger.debug("No Chat spaces found for mention scanning")
            return stats

        for space in spaces:
            space_name = space.get("name", "")
            space_display = space.get("displayName", space_name)
            space_type = space.get("spaceType", space.get("type", ""))

            try:
                # Fetch messages since last poll
                messages = await ws.chat_list_messages(
                    space_name,
                    filter_time=last_poll,
                    page_size=10,  # Keep fetch small
                )

                # Safety cap: only process the N most recent unprocessed messages
                space_processed = 0
                for message in messages:
                    # Safety cap — never process more than MAX_MESSAGES_PER_SPACE per poll
                    if space_processed >= MAX_MESSAGES_PER_SPACE:
                        logger.info(
                            "Safety cap reached for %s (%d msgs) — deferring rest to next poll",
                            space_display, space_processed,
                        )
                        break

                    msg_name = message.get("name", "")
                    if not msg_name or msg_name in processed_ids:
                        continue

                    # Skip messages the agent itself sent (prevents feedback loops)
                    if msg_name in _sent_message_ids:
                        processed_ids.add(msg_name)
                        continue

                    # Check if we should respond
                    if not _should_respond(message, space_type):
                        processed_ids.add(msg_name)
                        continue

                    stats["messages_found"] += 1

                    # Extract sender info
                    sender = message.get("sender", {})
                    sender_email = sender.get("email", "")
                    sender_name = sender.get("displayName", "")
                    sender_user_name = sender.get("name", "")  # e.g., "users/12345"

                    # Chat API with user auth often doesn't return email/displayName.
                    # Resolution chain: API cache → membership lookup → DM mapping → fallback

                    if (not sender_email or not sender_name) and sender_user_name:
                        # 1. Check in-memory cache
                        cached = _member_cache.get(sender_user_name)
                        if cached and (time.time() - cached.get("cached_at", 0)) < _MEMBER_CACHE_TTL:
                            sender_email = sender_email or cached.get("email", "")
                            sender_name = sender_name or cached.get("displayName", "")
                        else:
                            # 2. Try Chat API membership lookup
                            member_info = await ws.chat_get_member(space_name, sender_user_name)
                            if member_info and (member_info.get("email") or member_info.get("displayName")):
                                sender_email = sender_email or member_info.get("email", "")
                                sender_name = sender_name or member_info.get("displayName", "")
                                _member_cache[sender_user_name] = {
                                    **member_info,
                                    "cached_at": time.time(),
                                }

                    # 3. For DM spaces, use the DM-to-user mapping file
                    if (not sender_email or not sender_name) and space_type == "DIRECT_MESSAGE":
                        dm_user = _dm_mapping.get(space_name, {})
                        if dm_user:
                            sender_email = sender_email or dm_user.get("email", "")
                            sender_name = sender_name or dm_user.get("displayName", "")
                        elif sender_email:
                            # Auto-populate the mapping for future use
                            _dm_mapping[space_name] = {
                                "email": sender_email,
                                "displayName": sender_name or sender_email.split("@")[0],
                            }
                            _save_dm_mapping()

                    if not sender_name:
                        sender_name = sender_email.split("@")[0] if sender_email else "someone"

                    # Trust check — only respond to domain users
                    if sender_email and not _is_domain_user(sender_email) and not _is_dallas(sender_email):
                        try:
                            await _send_reply(
                                ws, space_name, space_type,
                                "Sorry, I can only respond to team members.",
                                sender_email=sender_email,
                            )
                        except Exception as e:
                            logger.warning("Failed to send trust-block reply: %s", e)
                        stats["commands_blocked"] += 1
                        processed_ids.add(msg_name)
                        continue

                    # System query check (early gate)
                    raw_text = message.get("text", "")
                    if _is_system_query(raw_text) and not _is_dallas(sender_email):
                        try:
                            await _send_reply(
                                ws, space_name, space_type,
                                "I can only help with business topics. "
                                "System and infrastructure queries are restricted.",
                                sender_email=sender_email,
                            )
                        except Exception as e:
                            logger.warning("Failed to send system-block reply: %s", e)
                        stats["commands_blocked"] += 1
                        processed_ids.add(msg_name)
                        continue

                    # ── Intent Classification ──
                    message_text = _extract_message_text(message, space_type)
                    intent = _classify_intent(message_text)
                    intent_type = intent["intent"]

                    logger.info(
                        "Chat intent: %s from %s in %s — '%s'",
                        intent_type, sender_email or sender_name, space_display,
                        message_text[:80],
                    )

                    # Record incoming message in conversation buffer
                    _record_conversation(space_name, "user", sender_name, message_text)

                    # ── Immediate acknowledgment (progressive) ──
                    # Send a varied ack, then update it with progress/result.
                    _ACK_INTENTS = {
                        "research", "deep_research", "find_file", "teamhub_query",
                        "teamhub_query_ws", "teamhub_workspaces",
                        "teamhub_create", "teamhub_update",
                        "doc_command", "free_form",
                    }
                    ack_msg_name = None
                    if intent_type in _ACK_INTENTS:
                        ack_msg_name = await _send_ack(
                            ws, space_name, space_type,
                            sender_name, sender_email=sender_email,
                        )

                    # Start a progress watchdog — if skill takes >8s, update ack
                    watchdog = None
                    if ack_msg_name:
                        watchdog = asyncio.create_task(
                            _progress_watchdog(ws, ack_msg_name, delay=8.0)
                        )

                    response = ""

                    # ── Skill-based intents ──
                    if intent_type in (
                        "find_file", "research", "deep_research",
                        "teamhub_query", "teamhub_query_ws", "teamhub_workspaces",
                        "teamhub_create", "teamhub_update",
                        "quoting", "folder_template",
                        "coedit_activate", "coedit_deactivate", "coedit_status",
                        "newsletter_send", "newsletter_status",
                    ):
                        response = await _dispatch_skill(intent, sender_email, sender_name, ws)
                        stats["skills_dispatched"] += 1

                    # ── Legacy doc commands (review, summarize, etc.) ──
                    elif intent_type == "doc_command":
                        command = intent["entities"]["command"]
                        args = intent["entities"]["args"]

                        # Check if a doc link was shared
                        doc_content = ""
                        doc_name = "Chat message"
                        annotations = message.get("annotations", [])
                        for ann in annotations:
                            if ann.get("type") == "DRIVE_LINK":
                                drive_ref = ann.get("driveDataRef", {})
                                file_id = drive_ref.get("driveFileId")
                                if file_id:
                                    try:
                                        doc_data = await ws.drive_read(file_id)
                                        doc_content = doc_data.get("content", "")
                                        doc_name = doc_data.get("metadata", {}).get("name", "Linked document")
                                    except Exception as e:
                                        logger.warning("Failed to read linked doc: %s", e)

                        if not doc_content and args:
                            doc_content = args

                        if not doc_content and command in ("review", "summarize", "fact-check", "format"):
                            response = (
                                f"To {command} a document, share a Google Doc link "
                                f"or paste the text you'd like me to {command}."
                            )
                        else:
                            response = await _process_chat_message(
                                command, args, doc_content, doc_name,
                                sender_name=sender_name,
                                space_name=space_name,
                            )

                    # ── Free-form (Claude Q&A fallback) ──
                    elif intent_type == "free_form":
                        response = await _process_chat_message(
                            "research", message_text, message_text, "Chat message",
                            sender_name=sender_name,
                            space_name=space_name,
                        )

                    # Cancel the progress watchdog now that we have the result
                    if watchdog and not watchdog.done():
                        watchdog.cancel()

                    # ── Deliver result ──
                    # If we have an ack message, update it in-place with the result.
                    # Otherwise send a fresh message.
                    send_ok = True
                    if response:
                        try:
                            sent = await _update_reply(
                                ws,
                                ack_msg_name,
                                response,
                                space_name,
                                space_type,
                                sender_email=sender_email,
                            )
                            if sent:
                                stats["commands_processed"] += 1
                                _record_conversation(space_name, "assistant", "Agent", response)
                            else:
                                stats["errors"] += 1
                        except RuntimeError as e:
                            if "Rate limit" in str(e):
                                logger.warning("Rate limited on %s — dropping (already acked)", space_display)
                            else:
                                logger.error("Failed to send reply in %s: %s", space_display, e)
                            stats["errors"] += 1
                        except Exception as e:
                            logger.error("Failed to send reply in %s: %s", space_display, e)
                            stats["errors"] += 1

                    # ALWAYS mark as processed — retrying causes ack spam (feedback loop).
                    # An ack was already sent, so the user knows we saw it. Better to
                    # drop one response than spam the chat 10+ times.
                    processed_ids.add(msg_name)
                    space_processed += 1

                    # Delay between messages to respect rate limits
                    await asyncio.sleep(3)

            except Exception as e:
                logger.error("Error scanning space %s: %s", space_display, e)
                stats["errors"] += 1

        # Update state
        state["processed_ids"] = list(processed_ids)
        state["last_poll"] = datetime.now(timezone.utc).isoformat()
        state["last_stats"] = stats
        _save_state(state)

        log_audit(
            tier="system",
            service="workspace-chat",
            event="chat:poll",
            status="completed",
            summary=(
                f"Chat poll: {stats['spaces_scanned']} spaces, "
                f"{stats['messages_found']} messages, "
                f"{stats['commands_processed']} processed, "
                f"{stats['skills_dispatched']} skills"
            ),
            details=stats,
        )

    except Exception as e:
        logger.error("Chat poll failed: %s", e)
        stats["errors"] += 1
    finally:
        await ws.close()

    return stats


# ── Fast Poll Loop ──────────────────────────────────────

_loop_running = False


async def chat_fast_loop():
    """Dedicated fast loop for Google Chat polling.

    Runs every POLL_INTERVAL_SECONDS (30s) as its own asyncio task,
    bypassing the cron scheduler's 60-second minimum. This gives users
    a much more responsive experience (~30s worst case vs ~2 min).
    """
    global _loop_running
    if _loop_running:
        logger.warning("Chat fast loop already running — skipping duplicate")
        return
    _loop_running = True

    logger.info("Chat fast loop started (interval: %ds)", POLL_INTERVAL_SECONDS)
    await asyncio.sleep(15)  # Let other services initialize

    while True:
        try:
            stats = await poll_workspace_chat()
            found = stats.get("messages_found", 0)
            if found > 0:
                logger.info(
                    "Chat fast loop: %d found, %d processed, %d errors",
                    found,
                    stats.get("commands_processed", 0),
                    stats.get("errors", 0),
                )
        except Exception as e:
            logger.error("Chat fast loop error: %s", e)

        await asyncio.sleep(POLL_INTERVAL_SECONDS)
