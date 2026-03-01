"""OPAI Docs — Generator: reads wiki .md files and produces docs.json.

Content is split into two tiers:
  - content_md: User-facing (all authenticated users) — features, how-to, usage
  - technical_md: Admin-only (shown in collapsed accordion) — architecture, config, internals

User-facing content is sanitized to remove infrastructure details (NAS, Docker,
internal paths, etc.). Some sections have custom user-friendly overrides.
"""

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import config


# ── Wiki file → section mapping ──────────────────────────────
# (filename, section_id, title, app_id, visibility, icon)
# visibility "all" = shown to all users (content_md only; technical_md still admin-only)
# visibility "admin" = entire section hidden from non-admins

WIKI_MAP = [
    ("chat.md",                     "chat",              "Chat",                  "chat",      "all",   "message-circle"),
    ("opai-files.md",               "files",             "Files",                 "files",     "all",   "folder"),
    ("messenger.md",                "messenger",         "Messenger",             "messenger", "all",   "send"),
    ("forum.md",                    "forum",             "Forum",                 "forum",     "all",   "users"),
    ("dev-ide.md",                  "dev",               "OP IDE",                "dev",       "all",   "code"),
    ("monitor.md",                  "monitor",           "System Monitor",        "monitor",   "admin", "activity"),
    ("task-control-panel.md",       "tasks",             "Task Control Panel",    "tasks",     "admin", "check-square"),
    ("terminal.md",                 "terminal",          "Terminal & Claude Code", "terminal", "admin", "terminal"),
    ("user-controls.md",            "users",             "User Controls",         "users",     "admin", "shield"),
    ("agent-studio.md",             "agents",            "Agent Studio",          "agents",    "admin", "zap"),
    ("discord-bridge.md",           "discord-bridge",    "Discord Bridge",        None,        "admin", "message-square"),
    ("auth-network.md",             "auth-network",      "Auth & Network",        None,        "admin", "lock"),
    ("orchestrator.md",             "orchestrator",      "Orchestrator",          None,        "admin", "cpu"),
    ("services-systemd.md",         "services-systemd",  "Services & systemd",    None,        "admin", "server"),
    ("agent-framework.md",          "agent-framework",   "Agent Framework",       None,        "admin", "zap"),
    ("navbar.md",                   "navbar",            "Shared Navbar",         None,        "admin", "menu"),
    ("email-checker.md",            "email-checker",     "Email Checker",         None,        "admin", "mail"),
    ("portal.md",                   "portal",            "Portal",                None,        "admin", "layout"),
    ("docs.md",                     "docs-system",       "Docs Portal",           None,        "admin", "book-open"),
    ("email-agent.md",              "email-agent",       "Email Agent",           None,        "admin", "mail"),
    ("feedback-system.md",          "feedback",          "Feedback System",       None,        "admin", "message-square"),
    ("invite-onboarding-flow.md",   "onboarding",        "Invite & Onboarding",   None,        "admin", "user-plus"),
    ("marketplace.md",              "marketplace",       "Marketplace",           "marketplace", "all", "shopping-bag"),
    ("sandbox-system.md",           "sandbox",           "Sandbox System",        None,        "admin", "box"),
    ("team-hub.md",                 "team-hub",          "Team Hub",              "team-hub",  "all",   "trello"),
]

# Categories — sections under "Your Tools" are visible to all users
CATEGORIES = [
    {
        "id": "getting-started",
        "title": "Getting Started",
        "visibility": "all",
        "sections": ["welcome", "logging-in", "your-workspace"],
    },
    {
        "id": "your-tools",
        "title": "Your Tools",
        "visibility": "all",
        "sections": ["chat", "files", "messenger", "forum", "dev", "marketplace", "team-hub"],
    },
    {
        "id": "admin-tools",
        "title": "Admin Tools",
        "visibility": "admin",
        "sections": ["monitor", "tasks", "terminal", "users", "agents", "discord-bridge", "email-agent"],
    },
    {
        "id": "system",
        "title": "System & Architecture",
        "visibility": "admin",
        "sections": ["auth-network", "orchestrator", "services-systemd", "agent-framework", "navbar", "email-checker", "portal", "docs-system", "feedback", "onboarding", "sandbox"],
    },
]

# Headings that go into user-facing content
USER_HEADINGS = {
    "Overview", "Features", "Providers", "How to Use", "Dashboard",
    "Login Flow", "Invite & Onboarding Flow",
    "Extension System", "Theia AI Packages", "BYOK (Bring Your Own Key)",
    "AI Integration",
}

# Headings that go into admin-only technical content
TECH_HEADINGS = {
    "Architecture", "Key Files", "Configuration", "API", "API Endpoints",
    "WebSocket Protocol", "Security", "Dependencies", "Database",
    "Docker Image", "Caddy Routes", "Container Mounts",
    "Troubleshooting", "Gotchas & Lessons Learned",
}


# ── Content sanitization ─────────────────────────────────────
# Replace infrastructure-specific terms with user-friendly alternatives
# in user-facing content. Admin technical_md is NOT sanitized.

SANITIZE_RULES = [
    # NAS / Synology references
    (r'\bSynology\b', 'storage server'),
    (r'\bNAS\b', 'storage'),
    (r'\bDS418\b', 'storage server'),
    (r'\bNFS mount\b', 'storage mount'),
    (r'\bNFS\b', 'network storage'),
    (r'\bNFSv4\.1\b', 'network storage'),
    (r'\bnetwork drive\b', 'cloud storage'),
    (r'\bnetwork-attached storage\b', 'cloud storage'),
    # Internal paths
    (r'/workspace/users/[^ ]*', 'your workspace'),
    (r'/workspace/synced/opai[^ ]*', 'the server'),
    (r'/workspace/shared/[^ ]*', 'shared storage'),
    # Docker internals
    (r'\bDocker container[s]?\b', 'workspace environment'),
    (r'\bcontainer[s]?\b(?!\s+path)', 'workspace'),
    (r'\bDocker\b', 'server'),
    (r'\bdockerd?\b', 'server'),
    # Server internals
    (r'\bsystemd\b', 'service manager'),
    (r'\buvicorn\b', 'server'),
    (r'\bFastAPI\b', 'server'),
    (r'\bExpress\b', 'server'),
    (r'\bCaddy\b', 'proxy'),
    (r'\bUnix socket[s]?\b', 'internal connection'),
    (r'port \d{4,5}', 'internal port'),
    (r'localhost:\d+', 'internal service'),
    # IP addresses
    (r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b', '[internal]'),
    (r'\b100\.\d+\.\d+\.\d+\b', '[internal]'),
]


def _sanitize_user_content(text: str) -> str:
    """Remove infrastructure details from user-facing content."""
    for pattern, replacement in SANITIZE_RULES:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return text


# ── Custom user-facing content overrides ──────────────────────
# For sections where the wiki content is too technical for users,
# provide curated user-friendly descriptions instead.

CUSTOM_USER_CONTENT = {
    "dev": (
        "## Overview\n\n"
        "OP IDE is a full-featured browser-based code editor. Open any project in your workspace "
        "and start coding — no installation required. The IDE includes built-in AI assistance, "
        "syntax highlighting, Git integration, and a curated library of extensions.\n\n"
        "## Getting Started\n\n"
        "1. Click **OP IDE** on your dashboard to open the project picker\n"
        "2. Select a project from your workspace (or create a new one)\n"
        "3. The IDE opens in your browser with your project files loaded\n"
        "4. When you're done, your workspace automatically saves and shuts down after 30 minutes of inactivity\n\n"
        "## AI Assistant\n\n"
        "The IDE comes with a built-in AI chat panel powered by Claude. Use it to:\n\n"
        "- Ask questions about your code\n"
        "- Get help writing new features\n"
        "- Debug issues with AI-powered explanations\n"
        "- Refactor and improve existing code\n\n"
        "The AI Chat panel opens automatically when you launch the IDE. "
        "You can also access it from the sidebar at any time.\n\n"
        "No API keys needed — AI is included with your OPAI account. "
        "If you prefer to use your own API keys (Anthropic, OpenAI, or Ollama), "
        "you can configure them in the IDE settings (Ctrl+,).\n\n"
        "### Terminal CLI\n\n"
        "You can also use the `opai-claude` command in the IDE's built-in terminal:\n\n"
        "```bash\n"
        "# Ask a question\n"
        "opai-claude \"explain this code\"\n\n"
        "# Include a file for context\n"
        "opai-claude -f src/index.ts \"review this file\"\n"
        "```\n\n"
        "## Built-in Extensions\n\n"
        "The IDE comes with 17 pre-installed extensions for web development:\n\n"
        "| Category | Extensions |\n"
        "|----------|------------|\n"
        "| Language Support | TypeScript, JavaScript, JSON, CSS, HTML, Markdown, Emmet, npm |\n"
        "| Git Integration | Git, GitLens, Git Graph |\n"
        "| Formatting | Prettier, ESLint |\n"
        "| Editor | Error Lens, Material Icon Theme, Catppuccin Theme |\n"
        "| Framework | Tailwind CSS IntelliSense |\n\n"
        "## Extension Library\n\n"
        "Beyond the built-in extensions, there's a shared library of additional extensions "
        "curated by your administrator. You can browse and enable them from the landing page:\n\n"
        "1. On the project picker page, expand the **Extensions** panel\n"
        "2. Toggle extensions on/off as needed\n"
        "3. If you change extensions while the IDE is running, you'll see a \"restart required\" banner\n"
        "4. Stop and restart your workspace to apply extension changes\n\n"
        "## Managing Projects\n\n"
        "From the project picker landing page you can:\n\n"
        "- **Browse** your project folders and files\n"
        "- **Create** new project folders\n"
        "- **Rename** or **delete** existing projects\n"
        "- **Switch** between projects (your current workspace will be stopped automatically)\n\n"
        "Your files are stored in your personal cloud storage and persist across sessions."
    ),
}

CUSTOM_USER_DESCRIPTION = {
    "dev": "A full-featured browser-based code editor with built-in AI assistance, Git integration, and curated extensions.",
}


# ── Parsing ───────────────────────────────────────────────────

def _hash_file(path: Path) -> str:
    """SHA256 hash of a file."""
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _split_sections(md_text: str) -> list[tuple[str, str]]:
    """Split markdown by ## headings. Returns [(heading, content), ...]."""
    parts = re.split(r'^## (.+)$', md_text, flags=re.MULTILINE)
    result = []
    if parts[0].strip():
        result.append(("_preamble", parts[0].strip()))
    for i in range(1, len(parts), 2):
        heading = parts[i].strip()
        content = parts[i + 1].strip() if i + 1 < len(parts) else ""
        result.append((heading, content))
    return result


def _parse_wiki_file(path: Path, section_id: str = "") -> dict:
    """Parse a wiki .md file into user-facing and technical content."""
    text = path.read_text(encoding="utf-8")
    sections = _split_sections(text)

    # Extract title from first line (# Title)
    title_match = re.match(r'^# (.+)$', text, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else path.stem

    # Extract description from Overview
    description = ""
    for heading, content in sections:
        if heading == "Overview":
            lines = content.split("\n\n")
            description = lines[0].strip() if lines else content[:200]
            break
        elif heading == "_preamble":
            clean = "\n".join(
                line for line in content.split("\n")
                if not line.startswith(">") and not line.startswith("#")
            ).strip()
            if clean:
                description = clean.split("\n\n")[0]

    # Check for custom user content override
    if section_id in CUSTOM_USER_CONTENT:
        user_content = CUSTOM_USER_CONTENT[section_id]
    else:
        user_parts = []
        for heading, content in sections:
            if heading == "_preamble":
                continue
            if heading in USER_HEADINGS:
                user_parts.append(f"## {heading}\n\n{content}")
            elif heading not in TECH_HEADINGS:
                # Unknown heading — include in user-facing
                user_parts.append(f"## {heading}\n\n{content}")
        user_content = "\n\n".join(user_parts)

    # Technical content (always from wiki, never overridden)
    tech_parts = []
    for heading, content in sections:
        if heading == "_preamble":
            continue
        if heading in TECH_HEADINGS:
            tech_parts.append(f"## {heading}\n\n{content}")
        # For sections with custom user content, also put the original
        # user headings into technical (so admins see the raw wiki)
        elif section_id in CUSTOM_USER_CONTENT and heading in USER_HEADINGS:
            tech_parts.append(f"## {heading}\n\n{content}")

    # Use custom description if available
    if section_id in CUSTOM_USER_DESCRIPTION:
        description = CUSTOM_USER_DESCRIPTION[section_id]

    # Sanitize user-facing content (strip infrastructure details)
    user_content = _sanitize_user_content(user_content)
    description = _sanitize_user_content(description)

    return {
        "title": title,
        "description": description,
        "content_md": user_content,
        "technical_md": "\n\n".join(tech_parts) if tech_parts else "",
    }


def _build_static_sections() -> list[dict]:
    """Build the 'Getting Started' static sections."""
    sections = []

    # Welcome
    sections.append({
        "id": "welcome",
        "title": "Welcome to OPAI",
        "app_id": None,
        "icon": "home",
        "visibility": "all",
        "description": "An introduction to the OPAI platform and what it offers.",
        "content_md": (
            "## Welcome to OPAI\n\n"
            "OPAI (Orchestrated Projects + Agent Intelligence) is a private, self-hosted platform "
            "that gives you access to AI-powered tools for chat, file management, messaging, and more.\n\n"
            "### What You Can Do\n\n"
            "- **Chat** with AI models (Claude and Gemini) with voice input support\n"
            "- **Manage files** in your personal workspace with markdown editing and knowledge features\n"
            "- **Message** other team members in real-time\n"
            "- **Discuss** topics in the community forum\n"
            "- **Code** in a full-featured browser IDE with AI assistance\n\n"
            "Use the sidebar to browse documentation for each tool.\n\n"
            "---\n\n"
            "### Living Documentation\n\n"
            "This documentation is **agentically generated** — it's created and maintained by AI agents "
            "that monitor the OPAI system for changes. When new features are added, tools are updated, "
            "or configurations change, the docs automatically regenerate to reflect the latest state.\n\n"
            "**Check back daily** as the platform is actively evolving. New tools, features, and "
            "improvements are being shipped regularly, and this documentation updates on the fly to "
            "keep you informed.\n\n"
            "> The documentation you're reading right now was written by the same AI that powers "
            "your chat, code editor, and agent workflows."
        ),
        "technical_md": "",
        "subsections": [],
    })

    # Logging In
    sections.append({
        "id": "logging-in",
        "title": "Logging In",
        "app_id": None,
        "icon": "log-in",
        "visibility": "all",
        "description": "How to log in and get started with OPAI.",
        "content_md": (
            "## Logging In\n\n"
            "1. Navigate to the OPAI server URL in your browser\n"
            "2. Enter your email and password on the login page\n"
            "3. After logging in, you'll see your dashboard with available tools\n\n"
            "If you're a new user, you'll be guided through a quick onboarding wizard "
            "to set your password and configure your workspace.\n\n"
            "### Password Reset\n\n"
            "Contact your administrator if you need to reset your password."
        ),
        "technical_md": "",
        "subsections": [],
    })

    # Your Workspace
    sandbox_path = config.WIKI_DIR / "sandbox-system.md"
    workspace_tech = ""
    if sandbox_path.exists():
        parsed = _parse_wiki_file(sandbox_path)
        workspace_tech = parsed.get("technical_md", "")

    sections.append({
        "id": "your-workspace",
        "title": "Your Workspace",
        "app_id": None,
        "icon": "hard-drive",
        "visibility": "all",
        "description": "Your personal workspace for files, projects, and configuration.",
        "content_md": (
            "## Your Workspace\n\n"
            "Each user gets a personal workspace — a private directory where your files, "
            "projects, and AI agent configurations are stored.\n\n"
            "### What's in Your Workspace\n\n"
            "- **Projects/** — Your project folders (used by OP IDE)\n"
            "- **Documents/** — Personal documents and notes\n"
            "- **CLAUDE.md** — Instructions for your AI assistant\n"
            "- **config/** — Personal configuration files\n\n"
            "Your workspace is only accessible to you and system administrators. "
            "Files are stored in secure cloud storage and persist across sessions."
        ),
        "technical_md": workspace_tech,
        "subsections": [],
    })

    return sections


def generate() -> dict:
    """Generate the full docs.json from wiki sources."""
    sections = _build_static_sections()
    file_hashes = {}

    for filename, section_id, title, app_id, visibility, icon in WIKI_MAP:
        wiki_path = config.WIKI_DIR / filename
        if not wiki_path.exists():
            continue

        file_hashes[filename] = _hash_file(wiki_path)
        parsed = _parse_wiki_file(wiki_path, section_id)

        # Use the configured title (e.g., "OP IDE") not the wiki title
        sections.append({
            "id": section_id,
            "title": title,
            "app_id": app_id,
            "icon": icon,
            "visibility": visibility,
            "source_file": filename,
            "description": parsed["description"],
            "content_md": parsed["content_md"],
            "technical_md": parsed["technical_md"],
            "subsections": [],
        })

    docs = {
        "version": "1.0.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "categories": CATEGORIES,
        "sections": sections,
    }

    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.DOCS_JSON.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")

    meta = {
        "generated_at": docs["generated_at"],
        "file_hashes": file_hashes,
    }
    config.DOCS_META_JSON.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return docs


def check_for_changes() -> bool:
    """Check if any wiki source files have changed since last generation."""
    if not config.DOCS_META_JSON.exists():
        return True

    try:
        meta = json.loads(config.DOCS_META_JSON.read_text(encoding="utf-8"))
        old_hashes = meta.get("file_hashes", {})
    except (json.JSONDecodeError, OSError):
        return True

    for filename, *_ in WIKI_MAP:
        wiki_path = config.WIKI_DIR / filename
        if not wiki_path.exists():
            if filename in old_hashes:
                return True
            continue

        current_hash = _hash_file(wiki_path)
        if old_hashes.get(filename) != current_hash:
            return True

    return False


if __name__ == "__main__":
    docs = generate()
    print(f"Generated docs.json with {len(docs['sections'])} sections")
