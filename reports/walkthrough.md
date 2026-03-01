# WordPress MCP Server Walkthrough

## Overview
This MCP server allows AI agents to interact with your WordPress site at `visiteverbladecity.com` via the REST API.

## Prerequisites
- Node.js installed.
- A WordPress Application Password.

## Configuration
1.  **Navigate to the directory**:
    ```bash
    cd d:\SD\Home\OPAI\mcps\Wordpress-VEC
    ```
2.  **Edit the `.env` file**:
    Open the `.env` file and replace the placeholders with your actual credentials:
    ```env
    WORDPRESS_URL=https://visiteverbladecity.com
    WORDPRESS_USERNAME=your_actual_username
    WORDPRESS_APPLICATION_PASSWORD=your_generated_app_password
    ```

## Building
To build the server (compile TypeScript to JavaScript):
```bash
npm run build
```

## Usage
To use this server with Claude for Desktop or other MCP clients, add the following to your MCP configuration file (usually `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "wordpress-vec": {
      "command": "node",
      "args": [
        "d:/SD/Home/OPAI/mcps/Wordpress-VEC/dist/index.js"
      ]
    }
  }
}
```

## Available Tools
- `list_posts`: View recent posts.
- `get_post`: implementation details of a specific post.
- `create_post`: Draft a new post.
- `update_post`: Edit an existing post.
- `list_pages`: View pages.
