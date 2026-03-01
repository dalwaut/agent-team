"""OPAI Forum Bot — AI content generation via Claude CLI."""

import asyncio
import json
import os
import re
import subprocess
import uuid

import config

# Post type templates with tone/length guidelines
POST_TYPE_TEMPLATES = {
    "dev-note": {
        "label": "Dev Note",
        "guidelines": (
            "Write a developer-facing update note. Tone: professional but approachable. "
            "Length: 150-400 words. Use markdown formatting with headers, bullet points, "
            "and code snippets where relevant. Focus on what changed and why it matters."
        ),
    },
    "poll": {
        "label": "Community Poll",
        "guidelines": (
            "Write a community poll post. Include a brief intro paragraph (2-3 sentences) "
            "explaining the context, then provide the poll question and 3-5 clear options. "
            "Output poll data as a JSON object in the 'poll' field."
        ),
    },
    "feature": {
        "label": "Feature Announcement",
        "guidelines": (
            "Write a feature announcement. Tone: enthusiastic but not hype-y. "
            "Length: 200-500 words. Structure: brief intro, what's new, how to use it, "
            "what's next. Use markdown headers and formatting."
        ),
    },
    "announcement": {
        "label": "Announcement",
        "guidelines": (
            "Write a general announcement. Tone: clear and direct. "
            "Length: 100-300 words. Get to the point quickly, include any action items."
        ),
    },
    "general": {
        "label": "General Post",
        "guidelines": (
            "Write a community forum post. Tone: conversational and engaging. "
            "Length: 100-400 words. Use markdown formatting as appropriate."
        ),
    },
}

# Security system prompt
SECURITY_PROMPT = """You are writing public-facing community forum content. STRICT RULES:
- NEVER mention file paths, port numbers, IP addresses, or API keys
- NEVER reference internal tool names like "opai-monitor", "opai-chat", etc.
- Use public-facing names: "System Monitor", "AI Chat", "Dev IDE", "Forum", "Agent Studio"
- NEVER reveal architecture details, database schemas, or internal implementation
- NEVER mention Supabase, Caddy, systemd, or other infrastructure
- Write as if you're a community manager, not a developer
- Content should be useful and engaging for end users"""


def _get_recent_changes() -> str:
    """Get recent git commit messages for context (subjects only, filtered)."""
    try:
        result = subprocess.run(
            ["git", "log", "--oneline", "-20", "--format=%s"],
            capture_output=True, text=True, timeout=5,
            cwd=str(config.OPAI_ROOT),
        )
        if result.returncode != 0:
            return ""

        # Filter out sensitive commit messages
        sensitive_patterns = re.compile(
            r"(password|secret|key|token|credential|\.env|migration|sql|schema)",
            re.IGNORECASE,
        )
        lines = [
            line.strip() for line in result.stdout.strip().split("\n")
            if line.strip() and not sensitive_patterns.search(line)
        ]
        if not lines:
            return ""
        return "Recent project activity:\n" + "\n".join(f"- {l}" for l in lines[:10])
    except Exception:
        return ""


async def generate_posts(
    prompt: str,
    post_type: str = "general",
    count: int = 1,
    extra_context: str = "",
) -> list[dict]:
    """Generate forum posts using Claude CLI.

    Returns list of {title, content, tags, poll?} dicts.
    """
    template = POST_TYPE_TEMPLATES.get(post_type, POST_TYPE_TEMPLATES["general"])
    recent_changes = _get_recent_changes()

    system_msg = SECURITY_PROMPT
    user_msg = f"""Generate exactly {count} forum post(s) of type "{template['label']}".

{template['guidelines']}

Admin's prompt: {prompt}

{recent_changes}

{extra_context}

Respond with a JSON array of objects. Each object must have:
- "title": string (compelling, concise title)
- "content": string (markdown-formatted post body)
- "tags": array of strings (2-5 relevant tags, lowercase)
{"- \"poll\": object with \"question\" (string), \"options\" (array of 3-5 strings), \"allow_multiple\" (boolean) — REQUIRED for poll type" if post_type == "poll" else ""}

Output ONLY the JSON array, no other text."""

    # Build Claude CLI command
    cmd = [
        config.CLAUDE_CMD,
        "-p", user_msg,
        "--output-format", "json",
    ]

    # Strip CLAUDECODE env var to avoid nested session errors
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=config.CLAUDE_TIMEOUT,
        )

        if proc.returncode != 0:
            raise RuntimeError(f"Claude CLI failed: {stderr.decode()[:500]}")

        raw = stdout.decode().strip()

        # Parse Claude's JSON output format
        try:
            claude_resp = json.loads(raw)
        except json.JSONDecodeError:
            raise RuntimeError(f"Failed to parse Claude output as JSON")

        # Claude --output-format json wraps in {"type":"result","result":"..."}
        if isinstance(claude_resp, dict) and "result" in claude_resp:
            inner = claude_resp["result"]
        else:
            inner = raw

        # Parse the inner content as JSON array
        if isinstance(inner, str):
            # Try to find JSON array in the response
            match = re.search(r'\[[\s\S]*\]', inner)
            if match:
                posts = json.loads(match.group())
            else:
                raise RuntimeError("No JSON array found in Claude response")
        elif isinstance(inner, list):
            posts = inner
        else:
            raise RuntimeError(f"Unexpected Claude response format")

        # Validate and normalize
        validated = []
        for p in posts[:count]:
            if not isinstance(p, dict) or "title" not in p or "content" not in p:
                continue
            entry = {
                "title": str(p["title"]).strip(),
                "content": str(p["content"]).strip(),
                "tags": [str(t).lower().strip() for t in p.get("tags", [])],
            }
            if post_type == "poll" and "poll" in p:
                entry["poll"] = p["poll"]
            validated.append(entry)

        if not validated:
            raise RuntimeError("Claude generated no valid posts")

        return validated

    except asyncio.TimeoutError:
        raise RuntimeError(f"Claude CLI timed out after {config.CLAUDE_TIMEOUT}s")
