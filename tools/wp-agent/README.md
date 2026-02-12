# WP-Agent

Generic WordPress management toolkit for the OPAI Agent Team framework. Manages any WordPress site via REST API.

**Part of the OPAI WordPress Agent System** — works alongside:
- `Templates/prompt_fusion_builder.txt` — Avada Fusion Builder page generation
- `Templates/prompt_page_designer.txt` — Page layout and visual design
- `Templates/prompt_design_reviewer.txt` — Quality scoring and feedback loop
- `mcps/Wordpress-VEC/` — MCP server for Claude Code integration
- `Library/Stack/WordPress/` — Knowledge base (elements, patterns, examples)

## Features

- **10 Specialized Agents**: Posts, Pages, Media, Taxonomy, Users, Comments, Settings, Menus, Plugins, Search
- **70+ Actions**: Complete WordPress management capabilities
- **CLI Interface**: Full command-line control
- **API Server**: FastAPI-based REST API for webapp integration
- **Portable**: Swap `config.yaml` to manage different WordPress sites

## Quick Start

### 1. Install

```bash
cd wp-agent
pip install -r requirements.txt
```

### 2. Configure

Edit `config.yaml` with your WordPress site details:

```yaml
site:
  name: "My WordPress Site"
  url: "https://example.com"

auth:
  username: "admin"
  # Set password via environment variable (recommended)
```

Set your password:
```bash
export WP_PASSWORD="your-password"
```

### 3. Use

**Command Line:**
```bash
# Test connection
python -m src.cli test

# List posts
python -m src.cli exec posts.list

# Interactive mode
python -m src.cli -i
```

**Python:**
```python
from src.orchestrator import get_orchestrator

wp = get_orchestrator("config.yaml")

# List posts
result = wp.execute("posts", "list", per_page=5)
print(result.data)

# Create a page
result = wp.execute("pages", "create",
    title="About Us",
    content="<p>Welcome to our site!</p>",
    status="publish"
)
```

## Architecture

```
wp-agent/
├── config.yaml          # Site configuration (swap for different sites)
├── endpoints.yaml       # WordPress REST API reference
├── ACTIONS.md           # Complete action reference
│
├── src/
│   ├── core/
│   │   └── client.py    # WordPress REST API client
│   │
│   ├── agents/          # Specialized agents
│   │   ├── base.py      # Base agent class
│   │   ├── posts.py
│   │   ├── pages.py
│   │   ├── media.py
│   │   ├── taxonomy.py
│   │   ├── users.py
│   │   ├── comments.py
│   │   ├── settings.py
│   │   ├── menus.py
│   │   ├── plugins.py
│   │   └── search.py
│   │
│   ├── orchestrator.py  # Central coordinator
│   └── cli.py           # Command-line interface
│
└── api/
    └── server.py        # FastAPI web server
```

## Agents & Actions

| Agent | Description | Key Actions |
|-------|-------------|-------------|
| `posts` | Blog posts | list, get, create, update, delete, bulk-update-status |
| `pages` | Static pages | list, get, create, update, delete, get-hierarchy |
| `media` | Media library | list, upload, upload-from-url, bulk-upload, delete |
| `taxonomy` | Categories/tags | list-categories, create-category, list-tags, bulk-create |
| `users` | User management | list, create, update, delete, list-roles |
| `comments` | Comments | list, approve, spam, bulk-moderate |
| `settings` | Site settings | get, update |
| `menus` | Navigation | list, create, add-item, assign-location |
| `plugins` | Plugins/themes | list, activate, deactivate |
| `search` | Search content | search, search-posts, search-pages |

See [ACTIONS.md](ACTIONS.md) for complete reference.

## CLI Commands

```bash
# List agents
wp-agent agents

# List all capabilities
wp-agent caps

# List capabilities for specific agent
wp-agent caps -a posts

# Execute commands
wp-agent exec posts.list
wp-agent exec posts.create title="Hello" status=draft
wp-agent exec media.upload file_path="/path/to/image.jpg"

# Test connection
wp-agent test

# Site info
wp-agent info

# Interactive mode
wp-agent -i
```

## Web API

Start the FastAPI server:

```bash
pip install fastapi uvicorn
python -m api.server
```

Endpoints:
- `GET /` - System info
- `GET /agents` - List agents
- `GET /capabilities` - List all capabilities
- `POST /execute` - Execute action
- `POST /execute/{agent.action}` - Execute by path
- `GET /posts`, `/pages`, `/media` - Convenience endpoints

## Using with Different Sites

Simply swap the `config.yaml`:

```bash
# Copy template
cp config.yaml config-site2.yaml

# Edit for new site
# Then use:
wp-agent -c config-site2.yaml exec posts.list
```

Or in Python:
```python
from src.orchestrator import AgentOrchestrator

# Site 1
wp1 = AgentOrchestrator()
wp1.initialize("config-site1.yaml")

# Site 2
wp2 = AgentOrchestrator()
wp2.initialize("config-site2.yaml")
```

## Setup

```bash
cp config.example.yaml config.yaml
# Edit config.yaml with your site URL and username
# Set password: export WP_PASSWORD="your-app-password"
```

## Security Notes

- Store passwords in environment variables, not config files
- Use WordPress Application Passwords for API access
- Copy `config.example.yaml` to `config.yaml` and fill in your details
- Never commit `config.yaml` — it contains credentials

## Requirements

- Python 3.9+
- WordPress site with REST API enabled
- Admin credentials or Application Password

## License

MIT
