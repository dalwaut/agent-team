"""Marq — Rejection-to-task AI translator.

Takes raw rejection data and produces:
1. Human-readable summary
2. Classification (fix_app/fix_website/fix_metadata/fix_policy)
3. Step-by-step fix instructions (with file paths where possible)
4. Apple/Google guideline links
5. Priority (blocker vs warning)

Creates TeamHub tasks via teamhub.py.
"""

import json
import logging

from core.claude_cli import call_claude
from core.teamhub import create_task, add_comment
from core.supabase import _sb_post

log = logging.getLogger("marq.translator")

# Common rejection reason → guideline mapping
GUIDELINE_MAP = {
    "privacy": {
        "apple": "https://developer.apple.com/app-store/review/guidelines/#privacy",
        "google": "https://support.google.com/googleplay/android-developer/answer/9859455",
    },
    "performance": {
        "apple": "https://developer.apple.com/app-store/review/guidelines/#performance",
        "google": "https://developer.android.com/docs/quality-guidelines/core-app-quality",
    },
    "design": {
        "apple": "https://developer.apple.com/app-store/review/guidelines/#design",
        "google": "https://developer.android.com/design",
    },
    "legal": {
        "apple": "https://developer.apple.com/app-store/review/guidelines/#legal",
        "google": "https://support.google.com/googleplay/android-developer/answer/9876821",
    },
    "iap": {
        "apple": "https://developer.apple.com/app-store/review/guidelines/#in-app-purchase",
        "google": "https://support.google.com/googleplay/android-developer/answer/9858738",
    },
    "metadata": {
        "apple": "https://developer.apple.com/app-store/review/guidelines/#metadata",
        "google": "https://support.google.com/googleplay/android-developer/answer/9898842",
    },
}


def _build_translation_prompt(rejection_data: dict, app: dict) -> str:
    """Build the AI prompt for rejection translation."""
    return f"""You are an expert app store consultant. Translate this rejection into actionable tasks.

APP INFO:
- Name: {app.get('name', 'Unknown')}
- Platform: {app.get('platform', 'both')}
- Store: {rejection_data.get('store', 'unknown')}
- Version: {rejection_data.get('version', 'unknown')}
- Privacy Policy: {app.get('privacy_policy_url', 'N/A')}
- Support URL: {app.get('support_url', 'N/A')}

REJECTION DATA:
- Reason: {rejection_data.get('rejection_reason', 'No reason provided')}
- Details: {json.dumps(rejection_data.get('rejection_details', {}), indent=2)}
- Raw message: {rejection_data.get('raw_message', '')}

Analyze the rejection and respond with ONLY a valid JSON object (no markdown fencing):
{{
  "summary": "1-2 sentence human-readable summary of what went wrong",
  "tasks": [
    {{
      "title": "Short task title (e.g. 'Add data retention section to privacy policy')",
      "task_type": "fix_app|fix_website|fix_metadata|fix_policy|resubmit",
      "priority": "urgent|high|medium|low",
      "description": "Detailed markdown description with:\\n- What's wrong\\n- How to fix it (step by step)\\n- File paths if applicable\\n- Links to relevant guidelines",
      "guideline_category": "privacy|performance|design|legal|iap|metadata"
    }}
  ]
}}

Rules:
- Create 1-3 focused tasks (one per distinct fix needed)
- task_type must be one of: fix_app, fix_website, fix_metadata, fix_policy, resubmit
- Priority should reflect actual rejection severity
- Include specific, actionable fix steps
- Reference Apple/Google guideline numbers where possible"""


async def translate_rejection(rejection_data: dict, app: dict) -> dict:
    """Translate store rejection into actionable task data using AI.

    Args:
        rejection_data: Dict with rejection_reason, rejection_details, store, version
        app: App dict from mrq_apps

    Returns:
        {
            "summary": str,
            "tasks": [
                {
                    "title": str,
                    "task_type": str,
                    "priority": str,
                    "description": str,
                    "guideline_urls": list[str],
                }
            ],
        }
    """
    prompt = _build_translation_prompt(rejection_data, app)

    try:
        raw = await call_claude(prompt, model="claude-haiku-4-5-20251001", timeout=60)

        # Strip markdown fencing if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

        result = json.loads(raw)
    except json.JSONDecodeError:
        log.error("Claude returned invalid JSON for rejection translation: %s", raw[:300])
        return _fallback_translation(rejection_data, app)
    except Exception as e:
        log.error("Rejection translation failed: %s", e)
        return _fallback_translation(rejection_data, app)

    # Enrich tasks with guideline URLs
    store = rejection_data.get("store", "apple")
    for task in result.get("tasks", []):
        cat = task.get("guideline_category", "")
        urls = []
        if cat in GUIDELINE_MAP:
            url = GUIDELINE_MAP[cat].get(store)
            if url:
                urls.append(url)
        task["guideline_urls"] = urls

    log.info("Translated rejection for app %s: %d task(s)", app.get("id"), len(result.get("tasks", [])))
    return result


def _fallback_translation(rejection_data: dict, app: dict) -> dict:
    """Fallback when AI translation fails — create a basic task."""
    reason = rejection_data.get("rejection_reason", "Unknown rejection reason")
    store = rejection_data.get("store", "unknown")
    version = rejection_data.get("version", "?")

    return {
        "summary": f"App rejected by {store} for version {version}: {reason}",
        "tasks": [
            {
                "title": f"[{store.title()}] Fix rejection — {reason[:60]}",
                "task_type": "general",
                "priority": "high",
                "description": (
                    f"## Rejection\n\n"
                    f"**Store**: {store}\n"
                    f"**Version**: {version}\n"
                    f"**Reason**: {reason}\n\n"
                    f"## Next Steps\n\n"
                    f"1. Review the rejection details in the store console\n"
                    f"2. Fix the identified issues\n"
                    f"3. Mark this task complete when fixed\n"
                    f"4. Marq will re-run checks and notify when ready to resubmit\n"
                ),
                "guideline_urls": [],
            }
        ],
    }


async def create_rejection_tasks(
    app: dict,
    submission: dict,
    issues_list_id: str,
) -> list[dict]:
    """Full rejection-to-task pipeline: translate + create TeamHub tasks + store relay.

    Args:
        app: App dict
        submission: Submission dict (with rejection_reason, rejection_details)
        issues_list_id: TeamHub list ID for "Store Issues"

    Returns:
        List of created relay records (mrq_tasks_relay rows)
    """
    rejection_data = {
        "store": submission.get("store", "unknown"),
        "version": submission.get("version", "?"),
        "rejection_reason": submission.get("rejection_reason", ""),
        "rejection_details": submission.get("rejection_details", {}),
    }

    # Step 1: AI translation
    translation = await translate_rejection(rejection_data, app)
    summary = translation.get("summary", "Rejection processed")

    relays = []
    for task_data in translation.get("tasks", []):
        # Step 2: Create TeamHub task
        # Build rich description
        desc = task_data.get("description", "")
        if task_data.get("guideline_urls"):
            desc += "\n\n## References\n"
            for url in task_data["guideline_urls"]:
                desc += f"- {url}\n"
        desc += f"\n\n---\n*After fixing, mark this task complete. Marq will re-run checks and notify when ready to resubmit.*"

        item = await create_task(
            app=app,
            list_id=issues_list_id,
            title=task_data.get("title", "Fix store rejection"),
            description=desc,
            priority=task_data.get("priority", "high"),
            source="marq",
        )

        if not item or not item.get("id"):
            log.warning("Failed to create TeamHub task for rejection")
            continue

        # Step 3: Store relay record
        relay = await _sb_post("mrq_tasks_relay", {
            "app_id": app["id"],
            "submission_id": submission.get("id"),
            "teamhub_item_id": item["id"],
            "task_type": task_data.get("task_type", "general"),
            "status": "open",
        })
        relay_record = relay[0] if isinstance(relay, list) else relay
        relays.append(relay_record)

        # Add context comment to the TeamHub task
        await add_comment(
            item["id"],
            f"Created by Marq — {summary}\n\nSubmission: {submission.get('store', '?')} v{submission.get('version', '?')} (build {submission.get('build_number', '?')})",
            author_id=app.get("owner_id"),
        )

    log.info("Created %d rejection tasks for app %s submission %s",
             len(relays), app.get("id"), submission.get("id"))
    return relays
