"""Google Chat Agent — Skill handlers for Phase 2.5 capabilities.

Each function is a self-contained skill that receives parsed entities
from the intent router and returns a plain string response for Chat.

Skills:
  - find_file: Search Drive, return clickable links
  - research_doc: Claude research → Google Doc in Agent Workspace
  - teamhub_query: Fetch user's tasks from Team Hub
  - teamhub_create: Create a task in Team Hub
  - teamhub_update: Update task status in Team Hub
  - quoting_stub: Placeholder for quoting capability
  - folder_template_stub: Placeholder for client folder setup
"""

import json
import logging
import re
import sys
from pathlib import Path

import httpx

# Add shared libs
_shared_dir = str(Path(__file__).resolve().parent.parent.parent / "shared")
if _shared_dir not in sys.path:
    sys.path.insert(0, _shared_dir)

import config

logger = logging.getLogger("opai.chat_skills")

# ── Data file for tracking TeamHub activity from Chat ────
CHAT_ACTIVITY_FILE = Path(__file__).resolve().parent.parent / "data" / "chat-activity.json"


def _log_chat_activity(action: str, details: dict):
    """Append an activity entry to chat-activity.json (rolling, last 200)."""
    from datetime import datetime, timezone
    try:
        entries = []
        if CHAT_ACTIVITY_FILE.is_file():
            entries = json.loads(CHAT_ACTIVITY_FILE.read_text())
        entries.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "action": action,
            **details,
        })
        entries = entries[-200:]
        CHAT_ACTIVITY_FILE.parent.mkdir(parents=True, exist_ok=True)
        CHAT_ACTIVITY_FILE.write_text(json.dumps(entries, indent=2))
    except Exception as e:
        logger.warning("Failed to log chat activity: %s", e)


# ── Supabase helpers (reuse Team Hub pattern) ────────────

def _sb_headers():
    return {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_url(table: str):
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


# ── Skill: Find File ────────────────────────────────────

async def skill_find_file(query: str, ws) -> str:
    """Search Google Drive for files matching a query.

    Args:
        query: The search terms from the user.
        ws: GoogleWorkspace instance.

    Returns:
        Formatted string with file names and links.
    """
    try:
        results = await ws.drive_search(query, page_size=5)
        files = results.get("files", [])

        if not files:
            return f'I couldn\'t find any files matching "{query}". Try different search terms or check the file name.'

        lines = [f'Found {len(files)} result{"s" if len(files) > 1 else ""}:\n']
        for f in files:
            name = f.get("name", "Untitled")
            link = f.get("webViewLink", "")
            if link:
                lines.append(f"- {name}\n  {link}")
            else:
                lines.append(f"- {name} (no link available)")

        return "\n".join(lines)

    except Exception as e:
        logger.error("skill_find_file failed: %s", e)
        return "I had trouble searching Drive right now. Please try again in a moment."


# ── Skill: Deep Research (NotebookLM-powered) ──────────

async def skill_deep_research(topic: str, ws) -> str:
    """In-depth research via NotebookLM web research + grounded Q&A.

    Uses NLM's web research to find real sources, then asks for a structured
    analysis grounded in those sources. Falls back to Claude if NLM unavailable.
    Saves result as a Google Doc when possible.

    Args:
        topic: The research topic from the user.
        ws: GoogleWorkspace instance.

    Returns:
        String with research findings + doc link (if saved).
    """
    import os
    import sys
    from datetime import datetime

    _shared = str(Path(__file__).resolve().parent.parent.parent / "shared")
    if _shared not in sys.path:
        sys.path.insert(0, _shared)

    content = None
    source_label = "claude"

    # Try NotebookLM first
    try:
        from nlm import (
            is_available, get_client, ensure_notebook,
            research_topic, ask_notebook,
        )

        if is_available():
            client = await get_client()
            async with client:
                nb_id = await ensure_notebook(client, "OPAI Research")

                # Run web research — discovers and imports real sources
                res = await research_topic(client, nb_id, topic)
                sources_added = res.get("sources_added", 0)
                logger.info("Deep research: NLM found %d sources for '%s'", sources_added, topic[:60])

                # Ask for structured analysis grounded in those sources
                structured_prompt = (
                    f"Research topic: {topic}. "
                    f"Provide a comprehensive research report with: "
                    f"1) Executive summary (2-3 sentences), "
                    f"2) Key findings (bulleted, cite your sources), "
                    f"3) Data points and statistics, "
                    f"4) Actionable recommendations, "
                    f"5) Sources used. "
                    f"Use Markdown with ## headings. Be thorough (600-1000 words)."
                )
                nlm_result = await ask_notebook(client, nb_id, structured_prompt)
                nlm_answer = nlm_result.get("answer", "")

                if len(nlm_answer) > 200:
                    content = nlm_answer
                    source_label = "notebooklm"
                    logger.info("Deep research: NLM analysis succeeded (%d chars)", len(content))

    except Exception as nlm_err:
        logger.warning("Deep research: NLM unavailable, falling back to Claude: %s", nlm_err)

    # Fallback to Claude if NLM didn't produce results
    if not content:
        from claude_api import call_claude

        research_prompt = (
            "You are a professional business researcher. "
            "Research the following topic and provide a comprehensive report with: "
            "1. Executive summary (2-3 sentences)\n"
            "2. Key findings (bulleted)\n"
            "3. Data points and statistics where relevant\n"
            "4. Actionable recommendations\n"
            "5. Sources or areas for further research\n\n"
            "Be thorough (600-1000 words). Use Markdown with ## headings."
        )
        try:
            result = await call_claude(
                f"Research topic: {topic}",
                system=research_prompt,
                model="claude-haiku-4-5",
                max_tokens=4096,
                timeout=120,
            )
            content = result.get("content", "").strip()
            source_label = "claude"
        except Exception as e:
            logger.error("Deep research Claude fallback failed: %s", e)
            return "I had trouble researching that topic. Please try again."

    if not content:
        return "I wasn't able to generate research on that topic. Could you rephrase?"

    # Try to save as Google Doc
    doc_link = ""
    if os.environ.get("GOOGLE_AGENT_WORKSPACE_FOLDER_ID"):
        title = f"Research: {topic[:80]} — {datetime.now().strftime('%Y-%m-%d')}"
        try:
            doc = await ws.drive_create_doc(title, content)
            doc_link = doc.get("webViewLink", "")
        except Exception as e:
            logger.warning("Deep research doc save failed: %s", e)

    # Build response
    source_tag = "NotebookLM (source-grounded)" if source_label == "notebooklm" else "Claude"
    header = f"Deep research on: {topic[:100]}\nPowered by: {source_tag}"
    if doc_link:
        header += f"\nFull doc: {doc_link}"

    # Trim for chat delivery (Google Chat has ~4096 char limit)
    max_chat = 3200
    body = content[:max_chat]
    if len(content) > max_chat:
        body += "\n\n...(truncated — see full doc above)"

    return f"{header}\n\n{body}"


# ── Skill: Quick Research (Claude-powered) ─────────────

async def skill_research_doc(topic: str, ws) -> str:
    """Research a topic via Claude and save as a Google Doc.

    Args:
        topic: The research topic from the user.
        ws: GoogleWorkspace instance.

    Returns:
        String with doc title and link.
    """
    from claude_api import call_claude

    research_prompt = (
        "You are a professional business researcher. "
        "Research the following topic and provide a well-organized report with: "
        "1. Executive summary (2-3 sentences)\n"
        "2. Key findings (bulleted)\n"
        "3. Data points and statistics where relevant\n"
        "4. Actionable recommendations\n"
        "5. Sources or areas for further research\n\n"
        "Keep the report concise but thorough (500-800 words)."
    )

    try:
        result = await call_claude(
            f"Research topic: {topic}",
            system=research_prompt,
            model="claude-haiku-4-5",
            max_tokens=4096,
            timeout=120,
        )
        content = result.get("content", "").strip()
        if not content:
            return "I wasn't able to generate research on that topic. Could you rephrase?"
    except Exception as e:
        logger.error("Research Claude call failed: %s", e)
        return "I had trouble researching that topic. Please try again."

    # Try to save as Google Doc in Agent Workspace (optional — works without it)
    from datetime import datetime
    import os

    if os.environ.get("GOOGLE_AGENT_WORKSPACE_FOLDER_ID"):
        title = f"Research: {topic[:80]} — {datetime.now().strftime('%Y-%m-%d')}"
        try:
            doc = await ws.drive_create_doc(title, content)
            link = doc.get("webViewLink", "")
            return f"Research doc created: {title}\n{link}" if link else f"Research doc created: {title} (link pending)"
        except Exception as e:
            logger.warning("Research doc creation failed (delivering in-chat): %s", e)

    # Deliver research directly in chat (no doc)
    return content[:3500]


# ── Status classification (must match TeamHub conventions) ────
# Statuses that count as "done/closed" — excluded from default views
_CLOSED_STATUSES = {"Complete", "Approved", "Postponed"}
# Active statuses — shown by default (everything EXCEPT closed)
_ACTIVE_STATUSES = {
    "Not Started", "Working on", "Manager Review", "Back to You",
    "Stuck", "Waiting on Client", "Client Review", "Quality Review",
}
# Workers workspace ID — system workspace, excluded from default queries
_WORKERS_WORKSPACE_ID = "d27944f3-8079-4e40-9e5d-c323d6cf7b0f"

# ── Query filter extraction from natural language ────────

_PRIORITY_KEYWORDS = {
    "critical": "critical", "urgent": "critical",
    "high": "high", "important": "high",
    "medium": "medium", "normal": "medium",
    "low": "low",
}

_STATUS_KEYWORDS = {
    "not started": "Not Started", "todo": "Not Started", "to do": "Not Started",
    "new": "Not Started", "pending": "Not Started", "backlog": "Not Started",
    "in progress": "Working on", "in-progress": "Working on", "working on": "Working on",
    "active": "Working on", "started": "Working on", "ongoing": "Working on",
    "blocked": "Stuck", "stuck": "Stuck",
    "waiting": "Waiting on Client", "waiting on client": "Waiting on Client",
    "client review": "Client Review",
    "in review": "Manager Review", "manager review": "Manager Review",
    "quality review": "Quality Review",
    "on hold": "Postponed", "paused": "Postponed", "postponed": "Postponed",
    "approved": "Approved",
    "done": "Complete", "completed": "Complete", "finished": "Complete",
    "closed": "Complete",
}

_TYPE_KEYWORDS = {
    "task": "task", "tasks": "task",
    "note": "note", "notes": "note",
    "idea": "idea", "ideas": "idea",
    "bug": "bug", "bugs": "bug",
    "issue": "issue", "issues": "issue",
}


def _extract_query_filters(query: str) -> dict:
    """Parse natural language query to extract Team Hub filters.

    Returns dict with optional keys: priority, status, type, due_scope,
    include_done, keyword_search.
    """
    q = query.lower().strip()
    filters = {}

    # Priority filter
    for kw, val in _PRIORITY_KEYWORDS.items():
        if kw in q:
            filters["priority"] = val
            break

    # Status filter
    for kw, val in _STATUS_KEYWORDS.items():
        if kw in q:
            filters["status"] = val
            break

    # Type filter
    for kw, val in _TYPE_KEYWORDS.items():
        # Match whole word to avoid "task" matching inside other words
        if re.search(rf"\b{re.escape(kw)}\b", q):
            filters["type"] = val
            break

    # Due date scope
    from datetime import datetime, timedelta, timezone
    today = datetime.now(timezone.utc).date()
    if any(w in q for w in ("overdue", "past due", "late")):
        filters["due_scope"] = "overdue"
        filters["due_before"] = today.isoformat()
    elif any(w in q for w in ("due today", "today's")):
        filters["due_scope"] = "today"
        filters["due_on"] = today.isoformat()
    elif any(w in q for w in ("this week", "due this week")):
        filters["due_scope"] = "this_week"
        # Monday of this week to Sunday
        monday = today - timedelta(days=today.weekday())
        sunday = monday + timedelta(days=6)
        filters["due_after"] = monday.isoformat()
        filters["due_before"] = sunday.isoformat()
    elif any(w in q for w in ("next week",)):
        filters["due_scope"] = "next_week"
        monday = today - timedelta(days=today.weekday()) + timedelta(weeks=1)
        sunday = monday + timedelta(days=6)
        filters["due_after"] = monday.isoformat()
        filters["due_before"] = sunday.isoformat()
    elif any(w in q for w in ("this month", "due this month")):
        filters["due_scope"] = "this_month"
        first = today.replace(day=1)
        if today.month == 12:
            last = today.replace(year=today.year + 1, month=1, day=1) - timedelta(days=1)
        else:
            last = today.replace(month=today.month + 1, day=1) - timedelta(days=1)
        filters["due_after"] = first.isoformat()
        filters["due_before"] = last.isoformat()
    elif "upcoming" in q or "soon" in q:
        filters["due_scope"] = "upcoming"
        filters["due_after"] = today.isoformat()
        filters["due_before"] = (today + timedelta(days=14)).isoformat()
    elif "no due date" in q or "unscheduled" in q:
        filters["due_scope"] = "no_due_date"

    # Include done/closed items?
    filters["include_done"] = any(w in q for w in ("all", "done", "completed", "finished", "closed", "archived"))

    # Count limit: "top 3 tasks", "first 5 items", "3 tasks", etc.
    m = re.search(r"\b(?:top|first|next|last)\s+(\d+)\b", q)
    if not m:
        m = re.search(r"\b(\d+)\s+(?:tasks?|items?)\b", q)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 50:
            filters["count_limit"] = n

    return filters


# ── Skill: TeamHub Query ────────────────────────────────

async def skill_teamhub_query(query: str, user_id: str, workspace_filter: str = "") -> str:
    """Fetch a user's tasks from Team Hub, filtered by natural language intent.

    Extracts filters from the query (priority, status, due date, type)
    and returns a scoped, relevant result set. Server-side limited to
    prevent overwhelming responses.

    Args:
        query: The user's natural language query.
        user_id: The resolved Supabase user ID.
        workspace_filter: Optional workspace name to scope results.

    Returns:
        Formatted string with filtered task list.
    """
    if not user_id:
        return "I couldn't find your user account. Please make sure you're set up in the system."

    # Extract filters from natural language
    filters = _extract_query_filters(query)
    logger.info("TeamHub query filters: %s (from: %s)", filters, query[:80])

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            # ── Resolve workspace scope ──────────────────────
            ws_id = None
            ws_name_resolved = ""
            user_workspace_ids = []

            # Always fetch the user's workspaces for scoping
            ws_resp = await client.get(
                _sb_url("team_membership"),
                headers=_sb_headers(),
                params={
                    "user_id": f"eq.{user_id}",
                    "select": "workspace_id,workspaces(id,name)",
                },
            )
            if ws_resp.status_code < 400:
                memberships = ws_resp.json()
                for m in memberships:
                    ws = m.get("workspaces")
                    if ws:
                        user_workspace_ids.append(ws["id"])

                if workspace_filter:
                    filter_lower = workspace_filter.lower()
                    for m in memberships:
                        ws = m.get("workspaces")
                        if ws and filter_lower in ws.get("name", "").lower():
                            ws_id = ws["id"]
                            ws_name_resolved = ws["name"]
                            break
                    if not ws_id:
                        return f'I couldn\'t find a workspace matching "{workspace_filter}" that you have access to.'

            # Exclude Workers workspace from default queries (system-generated items)
            exclude_workspace_ids = set()
            if not workspace_filter:
                exclude_workspace_ids.add(_WORKERS_WORKSPACE_ID)

            # ── Query assignments with server-side cap ────────
            select_fields = "item_id,team_items(id,title,status,priority,due_date,type,workspace_id)"
            query_params = {
                "assignee_id": f"eq.{user_id}",
                "select": select_fields,
                "limit": "300",  # Server-side cap to prevent fetching thousands
            }
            resp = await client.get(
                _sb_url("team_assignments"),
                headers=_sb_headers(),
                params=query_params,
            )

            if resp.status_code >= 400:
                logger.error("TeamHub query failed: %d %s", resp.status_code, resp.text[:200])
                return "I had trouble fetching your tasks. Please try again."

            assignments = resp.json()

            if not assignments:
                return "You don't have any tasks assigned to you right now."

            # ── Apply all filters ─────────────────────────────
            include_done = filters.get("include_done", False)
            filter_priority = filters.get("priority")
            filter_status = filters.get("status")
            filter_type = filters.get("type")
            due_scope = filters.get("due_scope")

            items = []
            for a in assignments:
                item = a.get("team_items")
                if not item:
                    continue

                # Workspace filter (explicit or exclusion)
                item_ws = item.get("workspace_id", "")
                if ws_id and item_ws != ws_id:
                    continue
                if not ws_id and item_ws in exclude_workspace_ids:
                    continue

                # Status filter: exclude closed unless asked or filtering for a done status
                item_status = item.get("status", "")
                if filter_status:
                    if item_status != filter_status:
                        continue
                elif not include_done and item_status in _CLOSED_STATUSES:
                    continue

                # Priority filter
                if filter_priority and item.get("priority", "none") != filter_priority:
                    continue

                # Type filter
                if filter_type and item.get("type", "") != filter_type:
                    continue

                # Due date filter
                item_due = item.get("due_date", "")
                if due_scope:
                    if due_scope == "no_due_date":
                        if item_due:
                            continue
                    elif due_scope == "overdue":
                        if not item_due or item_due[:10] >= filters["due_before"]:
                            continue
                    elif due_scope == "today":
                        if not item_due or item_due[:10] != filters["due_on"]:
                            continue
                    else:
                        if not item_due:
                            continue
                        d = item_due[:10]
                        if d < filters.get("due_after", "") or d > filters.get("due_before", "9999"):
                            continue

                items.append(item)

            # ── Format response ───────────────────────────────
            scope = f" in {ws_name_resolved}" if ws_name_resolved else ""

            filter_desc_parts = []
            if filter_priority:
                filter_desc_parts.append(f"{filter_priority} priority")
            if filter_status:
                filter_desc_parts.append(f"status: {filter_status}")
            if filter_type:
                filter_desc_parts.append(f"type: {filter_type}")
            if due_scope:
                scope_label = {
                    "overdue": "overdue",
                    "today": "due today",
                    "this_week": "due this week",
                    "next_week": "due next week",
                    "this_month": "due this month",
                    "upcoming": "upcoming (next 2 weeks)",
                    "no_due_date": "no due date",
                }.get(due_scope, due_scope)
                filter_desc_parts.append(scope_label)
            filter_desc = f" ({', '.join(filter_desc_parts)})" if filter_desc_parts else ""

            if not items:
                hint = ""
                if not filter_desc:
                    hint = " Try: 'my tasks in [workspace]', 'high priority tasks', or 'tasks due this week'."
                return f"No tasks found{scope}{filter_desc}.{hint}"

            # Sort by priority then due date
            priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "none": 4}
            items.sort(key=lambda x: (
                priority_order.get(x.get("priority", "none"), 4),
                x.get("due_date") or "9999",
            ))

            # Group summary for large result sets
            display_limit = filters.get("count_limit") or 15
            header_count = f"top {display_limit} of {len(items)}" if display_limit < len(items) else str(len(items))
            lines = [f"Your tasks{scope}{filter_desc} — {header_count} found:\n"]

            for item in items[:display_limit]:
                status = item.get("status", "Not Started")
                priority = item.get("priority", "")
                due = item.get("due_date", "")
                title = item.get("title", "Untitled")
                p_tag = f" [{priority.upper()}]" if priority and priority != "none" else ""
                d_tag = f" (due {due[:10]})" if due else ""
                lines.append(f"- {title}{p_tag}{d_tag} — {status}")

            if len(items) > display_limit:
                lines.append(
                    f"\n+{len(items) - display_limit} more. "
                    f"Narrow results: 'high priority tasks', 'tasks due this week', "
                    f"'tasks in [workspace name]', or 'overdue tasks'."
                )

            return "\n".join(lines)

    except Exception as e:
        logger.error("skill_teamhub_query error: %s", e)
        return "I had trouble fetching your tasks. Please try again."


async def skill_teamhub_workspaces(user_id: str) -> str:
    """List workspaces the user has access to.

    Args:
        user_id: The resolved Supabase user ID.

    Returns:
        Formatted string with workspace list.
    """
    if not user_id:
        return "I couldn't find your user account."

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                _sb_url("team_membership"),
                headers=_sb_headers(),
                params={
                    "user_id": f"eq.{user_id}",
                    "select": "role,workspaces(id,name)",
                },
            )
            if resp.status_code >= 400:
                return "I had trouble fetching your workspaces. Please try again."

            memberships = resp.json()
            if not memberships:
                return "You're not a member of any workspaces yet."

            lines = [f"Your workspaces ({len(memberships)}):\n"]
            for m in memberships:
                ws = m.get("workspaces")
                if not ws:
                    continue
                role = m.get("role", "member")
                lines.append(f"- {ws['name']} ({role})")

            lines.append('\nTip: Ask "my tasks in [workspace name]" to see tasks for a specific workspace.')
            return "\n".join(lines)

    except Exception as e:
        logger.error("skill_teamhub_workspaces error: %s", e)
        return "I had trouble fetching your workspaces. Please try again."


# ── Skill: TeamHub Create ───────────────────────────────

async def skill_teamhub_create(title: str, details: str, user_id: str) -> str:
    """Create a task in Team Hub.

    Args:
        title: Task title.
        details: Additional details/description.
        user_id: The creator's Supabase user ID.

    Returns:
        Confirmation string.
    """
    if not user_id:
        return "I couldn't find your user account. Please make sure you're set up in the system."

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            # Get user's default workspace
            ws_resp = await client.get(
                _sb_url("team_membership"),
                headers=_sb_headers(),
                params={
                    "user_id": f"eq.{user_id}",
                    "select": "workspace_id",
                    "limit": "1",
                },
            )

            workspace_id = None
            if ws_resp.status_code < 400 and ws_resp.json():
                workspace_id = ws_resp.json()[0].get("workspace_id")

            if not workspace_id:
                return "I couldn't find your workspace. Please make sure you're a member of a Team Hub workspace."

            # Create the item
            payload = {
                "workspace_id": workspace_id,
                "type": "task",
                "title": title,
                "description": details or "",
                "status": "open",
                "priority": "normal",
                "created_by": user_id,
                "source": "google_chat",
            }

            resp = await client.post(
                _sb_url("team_items"),
                headers=_sb_headers(),
                json=payload,
            )

            if resp.status_code >= 400:
                logger.error("TeamHub create failed: %d %s", resp.status_code, resp.text[:200])
                return "I couldn't create that task. Please try again or create it directly in Team Hub."

            created = resp.json()
            item_id = created[0]["id"] if isinstance(created, list) else created.get("id", "?")

            # Auto-assign to the creator
            await client.post(
                _sb_url("team_assignments"),
                headers=_sb_headers(),
                json={"item_id": item_id, "assignee_id": user_id},
            )

            _log_chat_activity("task_created", {
                "item_id": item_id,
                "title": title,
                "user_id": user_id,
            })

            return f'Task created: "{title}" (assigned to you)'

    except Exception as e:
        logger.error("skill_teamhub_create error: %s", e)
        return "I had trouble creating that task. Please try again."


# ── Skill: TeamHub Update ───────────────────────────────

async def skill_teamhub_update(item_ref: str, changes: dict, user_id: str) -> str:
    """Update a task in Team Hub.

    Args:
        item_ref: Task reference — could be an ID or a title fragment.
        changes: Dict of changes (e.g., {"status": "done"}).
        user_id: The user's Supabase user ID.

    Returns:
        Confirmation string.
    """
    if not user_id:
        return "I couldn't find your user account."

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            # Try to find the item — by ID if it looks like a UUID, otherwise search by title
            item_id = None

            if len(item_ref) > 30 and "-" in item_ref:
                # Looks like a UUID
                item_id = item_ref
            else:
                # Search by title fragment among user's assigned items
                resp = await client.get(
                    _sb_url("team_assignments"),
                    headers=_sb_headers(),
                    params={
                        "assignee_id": f"eq.{user_id}",
                        "select": "item_id,team_items(id,title,status)",
                    },
                )

                if resp.status_code < 400:
                    ref_lower = item_ref.lower().strip("#")
                    for a in resp.json():
                        item = a.get("team_items")
                        if not item:
                            continue
                        if ref_lower in item.get("title", "").lower():
                            item_id = item["id"]
                            break

            if not item_id:
                return f'I couldn\'t find a task matching "{item_ref}". Try using the full task title.'

            # Apply the update
            update_payload = {}
            if "status" in changes:
                update_payload["status"] = changes["status"]
            if "priority" in changes:
                update_payload["priority"] = changes["priority"]

            if not update_payload:
                return "I'm not sure what to change. Try: 'mark [task] done' or 'set [task] to high priority'."

            resp = await client.patch(
                _sb_url("team_items") + f"?id=eq.{item_id}",
                headers=_sb_headers(),
                json=update_payload,
            )

            if resp.status_code >= 400:
                logger.error("TeamHub update failed: %d %s", resp.status_code, resp.text[:200])
                return "I couldn't update that task. Please try again."

            change_desc = ", ".join(f"{k}={v}" for k, v in update_payload.items())
            _log_chat_activity("task_updated", {
                "item_id": item_id,
                "changes": update_payload,
                "user_id": user_id,
            })

            return f"Task updated: {change_desc}"

    except Exception as e:
        logger.error("skill_teamhub_update error: %s", e)
        return "I had trouble updating that task. Please try again."


# ── Co-Edit Skills ──────────────────────────────────────

async def skill_coedit_activate(doc_query: str, user_email: str, ws) -> str:
    """Activate co-edit on a document found by name search.

    Args:
        doc_query: Document name or search query.
        user_email: Email of the user activating co-edit.
        ws: GoogleWorkspace instance.

    Returns:
        Confirmation string or disambiguation prompt.
    """
    from background.workspace_coedit import activate_session, is_coedit_active

    try:
        # Search Drive for the document
        results = await ws.drive_search(
            f"name contains '{doc_query}' and trashed = false",
            page_size=5,
        )
        files = results.get("files", [])

        # Filter to only Google Docs and Sheets
        doc_types = {
            "application/vnd.google-apps.document",
            "application/vnd.google-apps.spreadsheet",
        }
        docs = [f for f in files if f.get("mimeType") in doc_types]

        if not docs:
            return f'I couldn\'t find a Google Doc or Sheet matching "{doc_query}". Check the name and try again.'

        if len(docs) > 1:
            lines = ["I found multiple documents. Which one?\n"]
            for i, d in enumerate(docs[:5], 1):
                lines.append(f"{i}. {d.get('name', 'Untitled')}")
            lines.append('\nSay "join <exact name>" to pick one.')
            return "\n".join(lines)

        doc = docs[0]
        doc_id = doc["id"]
        doc_name = doc.get("name", "Untitled")
        mime = doc.get("mimeType", "")
        doc_type = "spreadsheet" if "spreadsheet" in mime else "document"

        # Check if already active
        if is_coedit_active(doc_id):
            return f'Co-edit is already active on "{doc_name}".'

        # Get current revision baseline
        rev_id = None
        try:
            revisions = await ws.docs_get_revisions(doc_id, page_size=1)
            if revisions:
                rev_id = revisions[-1]["id"]
        except Exception:
            pass

        activate_session(doc_id, doc_name, doc_type, user_email, rev_id)
        link = doc.get("webViewLink", "")
        response = f'Co-edit activated on "{doc_name}". I\'ll help edit alongside you.'
        if link:
            response += f"\n{link}"
        response += "\nSay \"leave\" or \"stop editing\" when done. Auto-deactivates after 10 min of no activity."
        return response

    except Exception as e:
        logger.error("skill_coedit_activate error: %s", e)
        return "I had trouble activating co-edit. Please try again."


async def skill_coedit_deactivate(doc_query: str, user_email: str) -> str:
    """Deactivate co-edit on a document.

    Args:
        doc_query: Document name (used to find matching active session).
        user_email: Email of the requesting user.

    Returns:
        Confirmation string.
    """
    from background.workspace_coedit import get_active_sessions, deactivate_session

    sessions = get_active_sessions()

    if not sessions:
        return "There are no active co-edit sessions."

    # If no query, and only one session, deactivate it
    if not doc_query and len(sessions) == 1:
        s = sessions[0]
        deactivate_session(s["doc_id"], reason="manual")
        return f'Co-edit deactivated on "{s["doc_title"]}".'

    # Find matching session by name
    if doc_query:
        query_lower = doc_query.lower().strip()
        for s in sessions:
            if query_lower in s.get("doc_title", "").lower():
                deactivate_session(s["doc_id"], reason="manual")
                return f'Co-edit deactivated on "{s["doc_title"]}".'

        # No match
        names = ", ".join(f'"{s["doc_title"]}"' for s in sessions)
        return f'No active co-edit session matches "{doc_query}". Active sessions: {names}'

    # Multiple sessions, no query
    names = ", ".join(f'"{s["doc_title"]}"' for s in sessions)
    return f"Multiple co-edit sessions active: {names}. Specify which one to leave."


async def skill_coedit_status(user_email: str) -> str:
    """List all active co-edit sessions.

    Returns:
        Formatted list of active sessions.
    """
    from background.workspace_coedit import get_active_sessions
    from datetime import datetime, timezone

    sessions = get_active_sessions()

    if not sessions:
        return "No active co-edit sessions."

    now = datetime.now(timezone.utc)
    lines = [f"Active co-edit sessions ({len(sessions)}):\n"]

    for s in sessions:
        title = s.get("doc_title", "Untitled")
        activated_by = s.get("activated_by", "unknown")

        # Calculate duration
        try:
            activated_at = datetime.fromisoformat(s["activated_at"])
            duration_min = int((now - activated_at).total_seconds() / 60)
            duration_str = f"{duration_min}m"
        except (ValueError, KeyError):
            duration_str = "?"

        # Calculate time since last human edit
        try:
            last_edit = datetime.fromisoformat(s["last_human_edit"])
            idle_min = int((now - last_edit).total_seconds() / 60)
            idle_str = f"{idle_min}m ago"
        except (ValueError, KeyError):
            idle_str = "?"

        lines.append(f"- {title}")
        lines.append(f"  By: {activated_by} | Active: {duration_str} | Last edit: {idle_str}")

    return "\n".join(lines)


# ── Stub Skills ─────────────────────────────────────────

async def skill_quoting_stub(query: str) -> str:
    """Stub for quoting capability — coming soon."""
    return (
        "Quoting templates are being set up with Denise. "
        "For now, reach out to Dallas directly for estimates."
    )


async def skill_folder_template_stub(client_name: str) -> str:
    """Stub for client folder setup — coming soon."""
    return (
        "Client folder templates are being finalized with Denise. "
        "I'll notify you when this is ready."
    )


# ── Newsletter Skills ──────────────────────────────────────


async def skill_newsletter_send(user_email: str) -> str:
    """Send pending newsletter announcements immediately.

    Returns:
        Confirmation or error string.
    """
    announcements_file = Path(__file__).resolve().parent.parent / "data" / "feature-announcements.json"

    try:
        if not announcements_file.is_file():
            return "No announcements file found. Create one first."

        entries = json.loads(announcements_file.read_text())
        pending = [e for e in entries if not e.get("announced")]

        if not pending:
            return "No pending announcements to send."

        # Call the engine API
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post("http://127.0.0.1:8080/api/newsletter/send")

            if resp.status_code == 200:
                data = resp.json()
                headlines = ", ".join(data.get("headlines", []))
                return f"Newsletter sent! {data.get('announcement_count', 0)} announcements: {headlines}"
            else:
                detail = resp.json().get("detail", resp.text[:200])
                return f"Newsletter send failed: {detail}"

    except Exception as e:
        logger.error("skill_newsletter_send error: %s", e)
        return f"Failed to send newsletter: {e}"


async def skill_newsletter_status(user_email: str) -> str:
    """Show newsletter status — pending and sent announcements.

    Returns:
        Formatted status string.
    """
    announcements_file = Path(__file__).resolve().parent.parent / "data" / "feature-announcements.json"

    try:
        if not announcements_file.is_file():
            return "No announcements configured yet."

        entries = json.loads(announcements_file.read_text())
        pending = [e for e in entries if not e.get("announced")]
        sent = [e for e in entries if e.get("announced")]

        lines = [f"Newsletter status: {len(pending)} pending, {len(sent)} sent\n"]

        if pending:
            lines.append("Pending:")
            for e in pending:
                lines.append(f"  - {e.get('headline', 'Untitled')} ({e.get('date', '?')})")

        if sent:
            lines.append("\nRecently sent:")
            for e in sent[-5:]:
                lines.append(f"  - {e.get('headline', 'Untitled')} ({e.get('announced_at', e.get('date', '?'))[:10]})")

        return "\n".join(lines)

    except Exception as e:
        logger.error("skill_newsletter_status error: %s", e)
        return f"Error checking newsletter status: {e}"
