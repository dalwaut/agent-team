# Agentic Workflow File Structure Breakdown

This document outlines the file structure for the Obsidian Agentic Management system. It follows a 2-step workflow:
- **Step 1: Agent Hierarchy & Grounding** – Top-level folders handle agent definitions, sessions, and prompts for grounding/context (e.g., via gemini-scribe). Agents interact here to spawn, update, or query.
- **Step 2: Per-Project OPAI Structure** – Projects under Obsidian/Projects use a standardized diamond layout for isolated work. Agents must not break isolation—e.g., read from Research, write to Notes/Logs, execute via Tasks.

Use this as context when prompting agents: "Follow the file structure descriptions to interact safely. For example, update Dev-Plan only after Research phase."

## Root Level Folders/Files

- **Agent-Profiles/**  
  Description: Stores profiles for each agent type (e.g., Research Agent, Coding Agent). Each subfile/subfolder defines capabilities, tools, and behaviors.  
  Notes for Agents: Read-only for initialization. Agents reference their profile here before starting sessions. Example: JSON/YAML files like `research-agent.yaml`.

- **Agents/**  
  Description: Contains executable scripts or subfolders for agents (e.g., `research-agent/main.py`). This is where agents "live" and run.  
  Notes for Agents: Write new agent folders here when spawning. Execute from here, but log outputs to /logs.

- **config/**  
  Description: Global configuration files (e.g., `master-agents.yaml` listing all agents, paths, and priorities).  
  Notes for Agents: Read for system-wide settings. Update sparingly (e.g., add new agent paths). Use YAML for easy parsing.

- **gemini-scribe/**  
  Description: Handles agent scribing, including sessions and prompts for grounding/context.  
  Notes for Agents: Core for interaction—write session data here to maintain state. Subfolders ensure non-breaking updates.

  - **Agent-Sessions/**  
    Description: Stores ongoing or completed agent session data (e.g., JSON logs of inputs/outputs).  
    Notes for Agents: Append to sessions for continuity. Read to resume interrupted work.

  - **Prompts/**  
    Description: Template prompts for agents (e.g., expert-level instructions).  
    Notes for Agents: Pull prompts from here for tasks. Customize per session but don't overwrite originals.

    - **example-expert/**  
      Description: Sample expert prompt folder (expand for more).  
      Notes for Agents: Use as a base for complex queries.

- **logs/**  
  Description: System-wide log files (e.g., daily rotated like `2025-12-13.log`).  
  Notes for Agents: Write all outputs/errors here. Rotate automatically to avoid bloat.

- **mcps/**  
  Description: Module Context Protocol tools - How to access them, what they do, what to do, etc..  
  Notes for Agents: useful for accessing specific information via universal tools.

- **notes/**  
  Description: General system notes (not project-specific).  
  Notes for Agents: Quick captures or overviews. Link to projects if needed.

- **Obsidian/**  
  Description: Core workspace for OPAI file structure. Houses projects and ensures agent compatibility.  
  Notes for Agents: Interact via defined paths—e.g., read/write to subfolders without altering structure.

  - **Projects/**  
    Description: Contains individual project folders (A, B, C, etc.), each with isolated OPAI substructure.  
    Notes for Agents: Spawn new projects here. Treat each as self-contained—e.g., Project Manager Agent oversees all.

    - **Project-A/** (Repeat structure for B, C, etc.)  
      Description: Example project folder.  
      Notes for Agents: Focus work here. Use diamond flow: Start with Research → Dev-Plan → Tasks → Build → Logs/Notes.

      - **Codebase/**  
        Description: Project code files (e.g., `main.py`).  
        Notes for Agents: Read/write code here. Coding Agent builds/updates; others read-only.

      - **Notes/**  
        Description: Project-specific notes (e.g., `overview.md`).  
        Notes for Agents: Append updates/status. All agents can write for collaboration.

      - **Review-log/**  
        Description: Review entries (e.g., `review.md`).  
        Notes for Agents: Log reviews post-task. Review Agent writes here.

      - **Debug-log/**  
        Description: Debug outputs (e.g., `debug.log`).  
        Notes for Agents: Append errors/traces. Debugging Agent primary user.

      - **Research/**  
        Description: Research materials (e.g., `sources.md`).  
        Notes for Agents: Store findings. Research Agent populates; others reference.

      - **Dev-Plan/**  
        Description: Development plans (e.g., `plan.md`).  
        Notes for Agents: Outline steps. Project Manager Agent updates.

      - **Agent-Tasks/**  
        Description: Tasks for agents (e.g., `tasks.yaml`).  
        Notes for Agents: Queue/read tasks. Format as YAML for easy parsing.

      - **Ag-Build-Tasks/**  
        Description: Agent build tasks (e.g., `build.yaml`).  
        Notes for Agents: Specific build instructions. Antigravity Agent handles.

- **tasks/**  
  Description: Global task queues (not project-specific).  
  Notes for Agents: Queue cross-project tasks here. Link to project tasks.

- **templates-obsidian/**  
  Description: Reusable Obsidian templates.  
  Notes for Agents: Pull templates for new notes/files. Apply YAML frontmatter.

  - **ANTIGRAVITY_HANDOFF.md**  
    Description: Template for antigravity handoffs.  
    Notes for Agents: Use for transitions between agents.

  - **Project-Template-Structure.md**  
    Description: Template for project structures.  
    Notes for Agents: Instantiate new projects from this.

  - **TEMPLATE-Core-Idea-User-Story.md**  
    Description: Core idea and user story template.  
    Notes for Agents: Start projects with this.

  - **YAML-Frontmatter.md**  
    Description: YAML frontmatter examples.  
    Notes for Agents: Apply to all MD files for metadata.

- **tools/**  
  Description: Helper scripts/wrappers (e.g., Gemini CLI).  
  Notes for Agents: Execute tools from here. Add new ones as needed.

- **File-Structure.md**  
  Description: This document.  
  Notes for Agents: Reference for structure awareness.

- **Useful-Commands.md**  
  Description: List of useful commands.  
  Notes for Agents: Quick refs for CLI interactions.