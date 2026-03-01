#!/bin/bash

# A general-purpose research agent

# --- Configuration ---
RESEARCH_DIR="Research"
NOTES_DIR="notes"
# Get the temp directory from the environment variable
TEMP_DIR="${GEMINI_PROJECT_TEMP_DIR:-/tmp/gemini-project}"
LAST_RESEARCH_FILE="$TEMP_DIR/last_research.md"

# --- Helper Functions ---

# Function to display usage
usage() {
    echo "Usage: $0 \"<query>\" [--web] [--store <topic>]"
    echo "  <query>          : The research query."
    echo "  --web            : Force a web search, bypassing the local vault."
    echo "  --store <topic>  : Store the last research result under a specific topic."
    echo "  --help           : Display this help message."
}

# Function to search the local research vault
search_vault() {
    local query="$1"
    echo "🔍 Searching the vault for: \"$query\""
    # Using ripgrep (rg) for fast searching. You can replace with grep if rg is not available.
    if command -v rg &> /dev/null; then
        rg --ignore-case --max-count 5 --context 2 "$query" "$RESEARCH_DIR"
    else
        grep -r -i -m 5 "$query" "$RESEARCH_DIR"
    fi
}

# Function to perform a web search
perform_web_search() {
    local query="$1"
    echo "🌐 Performing web search for: \"$query\""
    # This is a placeholder for the actual tool call.
    # In a real scenario, this would be replaced with a call to the google_web_search tool.
    # Signal to the LLM that a web search is requested.
    # The LLM will intercept this and perform the actual google_web_search.
    echo "__GEMINI_WEB_SEARCH_QUERY__:$query"
    mkdir -p "$TEMP_DIR" # Ensure the temporary directory exists
    # The LLM will write the search results summary to $LAST_RESEARCH_FILE after intercepting.
    echo "Summary of web search for '$query' (results to be provided by Gemini CLI)" > "$LAST_RESEARCH_FILE"
    cat "$LAST_RESEARCH_FILE"
}

# Function to store research
store_research() {
    local topic="$1"
    local topic_path="$RESEARCH_DIR/$topic"
    local research_file="$topic_path/research.md"

    if [ ! -f "$LAST_RESEARCH_FILE" ]; then
        echo "❌ No research to store. Please perform a search first."
        exit 1
    fi

    echo "💾 Storing research under topic: $topic"
    mkdir -p "$topic_path"
    cat "$LAST_RESEARCH_FILE" >> "$research_file"
    echo "✅ Research stored in $research_file"
}


# --- Main Logic ---

QUERY=""
FORCE_WEB_SEARCH=false
STORE_TOPIC=""

while [[ "$#" -gt 0 ]]; do
    case "$1" in
        --web)
            FORCE_WEB_SEARCH=true
            ;;
        --store)
            if [ -z "$2" ]; then
                echo "❌ No topic specified for storing research."
                usage
                exit 1
            fi
            STORE_TOPIC="$2"
            shift # consume the topic argument
            ;;
        --help)
            usage
            exit 0
            ;;
        -*)
            echo "❌ Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            QUERY="$1"
            ;;
    esac
    shift # consume the current argument
done

# Handle --store command (if a topic was provided)
if [ -n "$STORE_TOPIC" ]; then
    store_research "$STORE_TOPIC"
    exit 0
fi

# Handle query
if [ -z "$QUERY" ]; then
    usage
    exit 1
fi

# 1. Search the vault first
if [ "$FORCE_WEB_SEARCH" = false ]; then
    VAULT_RESULTS=$(search_vault "$QUERY")
    if [ -n "$VAULT_RESULTS" ]; then
        echo "--- 📚 Vault Results ---"
        echo "$VAULT_RESULTS"
        echo "-----------------------"
        read -p "Do you want to search the web instead? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 0
        fi
    else
        echo "No relevant information found in the vault."
    fi
fi

# 2. Perform web search
perform_web_search "$QUERY"
