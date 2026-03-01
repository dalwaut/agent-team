"""AI assistant for WordPress management — Claude CLI integration."""

import asyncio
import json
import logging
import subprocess
from typing import Optional

log = logging.getLogger("opai-wordpress.ai-assistant")

# AI task templates
TEMPLATES = {
    "write-post": {
        "name": "Write a Blog Post",
        "description": "Generate a blog post with proper formatting for your site's builder",
        "prompt_prefix": "Write a WordPress blog post",
        "requires": ["site_info"],
    },
    "seo-audit": {
        "name": "SEO Audit",
        "description": "Check meta tags, headings, image alt text, and content structure",
        "prompt_prefix": "Perform an SEO audit on this WordPress site",
        "requires": ["site_info", "pages", "posts"],
    },
    "woo-cleanup": {
        "name": "WooCommerce Product Cleanup",
        "description": "Find duplicates, missing images, and bad descriptions in products",
        "prompt_prefix": "Audit WooCommerce products for quality issues",
        "requires": ["site_info", "woo_products"],
    },
    "fusion-cleanup": {
        "name": "Fusion Builder Cleanup",
        "description": "Strip unnecessary Fusion Builder wrapper divs and inline styles",
        "prompt_prefix": "Clean up Fusion Builder markup in page content",
        "requires": ["site_info", "pages"],
    },
    "security-scan": {
        "name": "Security Scan",
        "description": "Check plugins for known vulnerabilities, audit users, review settings",
        "prompt_prefix": "Perform a security audit on this WordPress site",
        "requires": ["site_info", "plugins", "users"],
    },
    "plugin-audit": {
        "name": "Plugin Audit",
        "description": "Review installed plugins for redundancy, performance, and security",
        "prompt_prefix": "Audit all installed plugins on this WordPress site",
        "requires": ["site_info", "plugins"],
    },
}


def _build_context(site_info: dict, task_data: dict = None) -> str:
    """Build context string for AI prompts."""
    parts = [f"WordPress Site: {site_info.get('name', 'Unknown')}"]
    parts.append(f"URL: {site_info.get('url', 'Unknown')}")

    if site_info.get("wp_version"):
        parts.append(f"WordPress Version: {site_info['wp_version']}")
    if site_info.get("theme"):
        parts.append(f"Active Theme: {site_info['theme']}")
    if site_info.get("plugins_total"):
        parts.append(f"Plugins: {site_info['plugins_total']} installed")

    if task_data:
        parts.append(f"\nTask Data:\n{json.dumps(task_data, indent=2, default=str)[:4000]}")

    return "\n".join(parts)


async def generate_plan(prompt: str, site_info: dict,
                        template_id: str = None,
                        task_data: dict = None) -> dict:
    """Generate an action plan from natural language using Claude CLI.

    Returns a plan dict with steps the user can approve before execution.
    """
    context = _build_context(site_info, task_data)

    system_prompt = """You are an AI WordPress management assistant for OPAI.
You help manage WordPress sites through the wp-agent library.

Available agents and actions:
- posts: list, get, create, update, delete, bulk-update-status
- pages: list, get, create, update, delete, get-hierarchy
- media: list, get, upload, update, delete
- taxonomy: list-categories, create-category, list-tags, create-tag
- users: list, get, me, create, update, delete
- comments: list, get, create, update, delete, approve, spam, bulk-moderate
- settings: get, update, get-site-info
- menus: list, get, create, update, delete, list-items, add-item
- plugins: list, get, activate, deactivate, delete, list-themes, get-active-theme
- search: search, search-posts, search-pages, search-media

When generating a plan, output a JSON object with:
{
  "summary": "Brief description of what will be done",
  "steps": [
    {
      "description": "What this step does",
      "agent": "agent_name",
      "action": "action_name",
      "params": { ... },
      "destructive": false
    }
  ],
  "warnings": ["Any risks or considerations"]
}

Only use agents/actions from the list above. Be conservative — flag destructive operations."""

    full_prompt = f"{system_prompt}\n\nSite Context:\n{context}\n\nUser Request: {prompt}"

    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", "--output-format", "json",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(full_prompt.encode()),
            timeout=120,
        )

        if proc.returncode != 0:
            return {"error": f"Claude CLI failed: {stderr.decode()[:500]}"}

        response = json.loads(stdout.decode())
        text = response.get("result", "")

        # Try to extract JSON plan from response
        try:
            # Look for JSON block in the response
            if "```json" in text:
                json_str = text.split("```json")[1].split("```")[0].strip()
            elif "{" in text:
                start = text.index("{")
                end = text.rindex("}") + 1
                json_str = text[start:end]
            else:
                return {"summary": text, "steps": [], "warnings": ["Could not parse structured plan"]}

            plan = json.loads(json_str)
            return plan
        except (json.JSONDecodeError, ValueError):
            return {"summary": text, "steps": [], "warnings": ["Response was not structured"]}

    except asyncio.TimeoutError:
        return {"error": "AI request timed out (120s)"}
    except FileNotFoundError:
        return {"error": "Claude CLI not found — ensure it's installed"}
    except Exception as e:
        return {"error": f"AI request failed: {str(e)}"}


async def execute_plan(plan: dict, site_info: dict, creds) -> dict:
    """Execute an approved plan step by step using wp-agent."""
    from services.site_manager import SiteCredentials, execute

    results = []
    for i, step in enumerate(plan.get("steps", [])):
        agent = step.get("agent")
        action = step.get("action")
        params = step.get("params", {})

        if not agent or not action:
            results.append({
                "step": i + 1,
                "description": step.get("description", ""),
                "status": "skipped",
                "error": "Missing agent or action",
            })
            continue

        result = execute(creds, agent, action, **params)
        results.append({
            "step": i + 1,
            "description": step.get("description", ""),
            "agent": agent,
            "action": action,
            "status": result.get("status", "unknown"),
            "data": result.get("data"),
            "error": result.get("error"),
        })

        # Stop on failure for destructive operations
        if result.get("status") == "failed" and step.get("destructive"):
            results.append({
                "step": i + 2,
                "status": "aborted",
                "error": "Halted after destructive step failure",
            })
            break

    return {
        "plan_summary": plan.get("summary", ""),
        "steps_total": len(plan.get("steps", [])),
        "steps_completed": len(results),
        "results": results,
    }


async def chat(message: str, site_info: dict, history: list = None) -> str:
    """Conversational mode — analyze site and answer questions."""
    context = _build_context(site_info)

    history_text = ""
    if history:
        for msg in history[-10:]:
            role = msg.get("role", "user")
            history_text += f"\n{role}: {msg.get('content', '')}"

    full_prompt = f"""You are an AI WordPress assistant for OPAI. Help the user manage their WordPress site.

Site Context:
{context}

{f"Conversation history:{history_text}" if history_text else ""}

User: {message}

Respond helpfully. If the user wants to take action, suggest using the plan/execute workflow for safety."""

    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", "--output-format", "json",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(full_prompt.encode()),
            timeout=60,
        )

        if proc.returncode != 0:
            return f"AI error: {stderr.decode()[:200]}"

        response = json.loads(stdout.decode())
        return response.get("result", "No response generated")

    except asyncio.TimeoutError:
        return "AI request timed out"
    except Exception as e:
        return f"AI error: {str(e)}"


def list_templates() -> list[dict]:
    """Return available AI task templates."""
    return [
        {"id": tid, **{k: v for k, v in t.items() if k != "prompt_prefix"}}
        for tid, t in TEMPLATES.items()
    ]
