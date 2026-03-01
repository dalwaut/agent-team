# Navigate to vault root
cd ~/path/to/your/.gemini
cd ~/path/to/your/.gemini

# Ensure top-level folders for Step 1: Agent Hierarchy & Grounding
mkdir -p Agent-Profiles
mkdir -p Agents
mkdir -p config
mkdir -p gemini-scribe/Agent-Sessions
mkdir -p gemini-scribe/Prompts/example-expert  # Expand if needed
mkdir -p logs
mkdir -p mcps
mkdir -p notes
mkdir -p tasks
mkdir -p tools

# Step 2: Per-Project Structure under Projects/ (OPAI style)
mkdir -p Projects/Project-A/{Codebase,Notes,Review-log,Debug-log,Research,Dev-Plan,Agent-Tasks,Ag-Build-Tasks}
mkdir -p Projects/Project-B/{Codebase,Notes,Review-log,Debug-log,Research,Dev-Plan,Agent-Tasks,Ag-Build-Tasks}
mkdir -p Projects/Project-C/{Codebase,Notes,Review-log,Debug-log,Research,Dev-Plan,Agent-Tasks,Ag-Build-Tasks}

# Add starter files/templates where relevant (e.g., in templates-obsidian)
touch templates-obsidian/ANTIGRAVITY_HANDOFF.md  # If not already there
touch templates-obsidian/Project-Template-Structure.md
touch templates-obsidian/TEMPLATE-Core-Idea-User-Story.md
touch templates-obsidian/YAML-Frontmatter.md

# Example files for projects (customize as needed)
touch Projects/Project-A/Codebase/main.py
touch Projects/Project-A/Notes/overview.md
touch Projects/Project-A/Review-log/review.md
touch Projects/Project-A/Debug-log/debug.log
touch Projects/Project-A/Research/sources.md
touch Projects/Project-A/Dev-Plan/plan.md
touch Projects/Project-A/Agent-Tasks/tasks.yaml
touch Projects/Project-A/Ag-Build-Tasks/build.yaml

# Similarly for Project-B and Project-C (duplicate the above touches if desired)

# Quick dashboard and utils
touch File-Structure.md
touch Useful-Commands.md