Basics:       
Add context: Use @ to specify files for context (e.g., @src/myFile.ts) to target specific files or folders.  
Shell mode: Execute shell commands via ! (e.g., !npm run start) or use natural language (e.g. start server).   

- /terminal-setup - Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf)
- /setup-github - Set up GitHub Actions (MUST be ran from a git repository)
- /theme - Change the theme 
- /tools - List available Gemini CLI tools. Usage: /tools [desc]
- /settings - View and edit Gemini CLI settings 
- /model - Opens a dialog to configure the model  
- /mcp - Manage configured Model Context Protocol (MCP) servers
	- list - List configured MCP servers and tools
	- desc - List configured MCP servers and tools with descriptions  
	- schema - List configured MCP servers and tools with descriptions and schemas 
	- auth - Authenticate with an OAuth-enabled MCP server
	- refresh - Restarts MCP servers
- /help - For help on gemini-cli 
- /ide - Manage IDE integration (must be ran in side IDE terminal)
- /init - Analyzes the project and creates a tailored GEMINI.md file
- /clear - Clear the screen and conversation history 
- /compress - Compresses the context by replacing it with a summary 
- /copy - Copy the last result or code snippet to clipboard   
- /docs - Open full Gemini CLI documentation in your browser 
- /directory - Manage workspace directories   
	- add - Add directories to the workspace. Use comma to separate multiple paths  
	- show - Show all directories in the workspace 
- /editor - Set external editor preference 
- /extensions - Manage extensions  
	- list - List active extensions
	- explore - Open extensions page in your browser   
	- restart - Restart all extensions
	- update - Update extensions. Usage: "update <extension-names>|--all "