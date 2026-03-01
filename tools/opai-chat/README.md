# OPAI Chat

A comprehensive AI chat interface for the OPAI agentic hub, featuring Claude integration with streaming responses, tool execution with permissions, canvas editor, and live preview.

## Features

- **Streaming Chat**: Real-time streaming responses from Claude (Haiku, Sonnet, Opus)
- **Tool Execution**: Safe tools auto-execute, dangerous tools require approval
- **Canvas Editor**: Edit code with syntax highlighting, save to files
- **Live Preview**: Sandboxed HTML/CSS/JS preview
- **Conversation Management**: Persistent conversations with search and organization
- **OPAI Integration**: Access to team.json, tasks, and project context
- **Obsidian Purple Theme**: Beautiful dark theme with glassmorphism effects

## Setup

1. **Install Dependencies**:
   ```bash
   cd /workspace/synced/opai/tools/opai-chat
   pip install -r requirements.txt
   ```

2. **Configure Environment**:
   ```bash
   cp .env.example .env
   # Edit .env and add your ANTHROPIC_API_KEY
   ```

3. **Run Manually** (for testing):
   ```bash
   python3 -m uvicorn app:app --host 0.0.0.0 --port 8888
   ```

4. **Install as Service**:
   ```bash
   cd /workspace/synced/opai/scripts
   ./opai-control.sh install
   ./opai-control.sh enable
   ./opai-control.sh start
   ```

## Access

Open http://localhost:8888 in your browser.

## Architecture

### Backend (Python/FastAPI)
- `app.py` - Main FastAPI application
- `config.py` - Configuration and constants
- `models.py` - Pydantic data models
- `conversation_store.py` - JSON-based conversation persistence
- `context_resolver.py` - File access with path safety
- `tools.py` - Tool implementations (read/write files, execute commands)
- `ai_client.py` - Anthropic SDK integration with streaming
- `routes_api.py` - REST API endpoints
- `routes_chat.py` - SSE streaming chat endpoint

### Frontend (Vanilla JS)
- `index.html` - SPA structure
- `style.css` - Obsidian Purple theme
- `js/app.js` - State management and initialization
- `js/sidebar.js` - Conversation list
- `js/chat.js` - Message rendering and streaming
- `js/markdown.js` - Markdown + syntax highlighting
- `js/tools.js` - Tool call UI and approval
- `js/canvas.js` - Code editor panel
- `js/preview.js` - Live HTML preview

## File Access Security

- **Allowed Roots**: `/workspace/synced/opai`, `/workspace/reports`, `/workspace/logs`
- **Blocked Patterns**: `.env`, `credentials*`, `secrets*`, `.git`, `node_modules`, etc.
- **Safe Tools**: read_file, list_directory, search_files (auto-execute)
- **Dangerous Tools**: write_file, execute_command (require approval)

## Model Selection

- **Haiku**: Fast, cheap - quick questions
- **Sonnet**: Balanced - default for most tasks
- **Opus**: Max capability - complex code and analysis

Model selection persists in localStorage and can be changed mid-conversation.
