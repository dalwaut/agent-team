.gemini (vault root)
├── Agent-Profiles/          # Definitions for each agent type
├── Agents/                  # Executable agent scripts/subfolders
├── config/                  # Global configs (e.g., master-agents.yaml)
├── gemini-scribe/           # Scribe for agent interactions
│   ├── Agent-Sessions/      # Session data for ongoing agent runs
│   └── Prompts/             # Prompt templates
│       └── example-expert/  # Example prompt for expert agents
├── logs/                    # System-wide logs
├── mcps/                    # Multi-context processing (if custom)
├── notes/                   # General notes
├── Obsidian/                # Core workspace for OPAI structure
│   └── Projects/            # Project-specific folders (A, B, C, etc.)
│       ├── Project-A/
│       │   ├── Codebase/    # Project code files
│       │   │   └── main.py
│       │   ├── Notes/       # Project notes
│       │   │   └── overview.md
│       │   ├── Review-log/  # Review entries
│       │   │   └── review.md
│       │   ├── Debug-log/   # Debug outputs
│       │   │   └── debug.log
│       │   ├── Research/    # Research materials
│       │   │   └── sources.md
│       │   ├── Dev-Plan/    # Development plans
│       │   │   └── plan.md
│       │   ├── Agent-Tasks/ # Tasks for agents
│       │   │   └── tasks.yaml
│       │   └── Ag-Build-Tasks/ # Build tasks for agents
│       │       └── build.yaml
│       ├── Project-B/       # (Same substructure as Project-A)
│       └── Project-C/       # (Same substructure as Project-A)
├── tasks/                   # Global tasks/queues
├── templates-obsidian/      # Obsidian templates
│   ├── ANTIGRAVITY_HANDOFF.md
│   ├── Project-Template-Structure.md
│   ├── TEMPLATE-Core-Idea-User-Story.md
│   └── YAML-Frontmatter.md
├── tools/                   # Helper tools/scripts
├── File-Structure.md        # This breakdown doc
└── Useful-Commands.md       # Command references