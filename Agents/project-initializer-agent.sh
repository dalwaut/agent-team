#!/bin/bash

# Project Initializer Agent
# Creates a new project structure and moves relevant research/notes.

# --- Configuration ---
PROJECTS_ROOT="Projects"
TEMPLATES_DIR="Templates/templates-projects"
TEMP_DIR="${GEMINI_PROJECT_TEMP_DIR:-/tmp/gemini-project}"

# --- Usage ---
usage() {
    echo "Usage: $0 -n \"<project_name>\" [-r <research_file>] [-t <template_name>]"
    echo "  -n  : Name of the new project (e.g., 'SEO-GEO-Automator')"
    echo "  -r  : (Optional) Path to a research file to move into the project"
    echo "  -t  : (Optional) Template name (folder in Templates/templates-projects)"
}

# --- Parse Arguments ---
PROJECT_NAME=""
RESEARCH_FILE=""
TEMPLATE_NAME=""

while getopts "n:r:t:" opt; do
    case $opt in
        n) PROJECT_NAME="$OPTARG" ;;
        r) RESEARCH_FILE="$OPTARG" ;;
        t) TEMPLATE_NAME="$OPTARG" ;;
        *) usage; exit 1 ;;
    esac
done

if [ -z "$PROJECT_NAME" ]; then
    echo "❌ Error: Project name is required."
    usage
    exit 1
fi

PROJECT_PATH="$PROJECTS_ROOT/$PROJECT_NAME"

# --- Create Directory Structure ---
echo "🏗️  Creating project: $PROJECT_NAME at $PROJECT_PATH"
mkdir -p "$PROJECT_PATH"/{Ag-Build-Tasks,Agent-Tasks,Codebase,Debug-log,Dev-Plan,Notes,Research,Review-log}

# --- Copy Template Files (if specified or default) ---
# For now, we create standard placeholder files if no template is strictly defined,
# or we could copy from a 'Basic' template if it existed.
# Here we'll generate the essentials.

# GEMINI.md
if [ ! -f "$PROJECT_PATH/GEMINI.md" ]; then
    echo "# Project Context: $PROJECT_NAME" > "$PROJECT_PATH/GEMINI.md"
    echo "" >> "$PROJECT_PATH/GEMINI.md"
    echo "## Goal" >> "$PROJECT_PATH/GEMINI.md"
    echo "Describe the goal of $PROJECT_NAME here." >> "$PROJECT_PATH/GEMINI.md"
fi

# tasks.yaml
if [ ! -f "$PROJECT_PATH/Agent-Tasks/tasks.yaml" ]; then
    echo "tasks: []" > "$PROJECT_PATH/Agent-Tasks/tasks.yaml"
fi

# --- Move Research File ---
if [ -n "$RESEARCH_FILE" ]; then
    if [ -f "$RESEARCH_FILE" ]; then
        echo "📂 Moving research file: $RESEARCH_FILE"
        cp "$RESEARCH_FILE" "$PROJECT_PATH/Research/initial-research.md"
        # Optional: Remove original? For safety, we copy. 
        # mv "$RESEARCH_FILE" "$PROJECT_PATH/Research/initial-research.md" 
    else
        echo "⚠️  Warning: Research file '$RESEARCH_FILE' not found."
    fi
fi

# --- Finalize ---
echo "✅ Project '$PROJECT_NAME' initialized successfully!"
echo "   Location: $PROJECT_PATH"
